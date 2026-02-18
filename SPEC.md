# Whoop Heart Rate Sync - Specification

## Overview

A Dockerized service that runs on a Linux server and continuously syncs heart rate data from the Whoop dashboard into a Supabase PostgreSQL database. Whoop does not expose live heart rate via their public API, but the internal dashboard at `https://app.whoop.com` fetches it from an internal API. This service automates that process.

## How It Works (Research Findings)

### Authentication

Whoop uses **AWS Cognito** for authentication. The Cognito client has a server-side secret, which means **direct API authentication is not possible** - you cannot call the Cognito `InitiateAuth` endpoint directly. Authentication must go through the browser-based login flow.

**Login flow:**
1. Navigate to `https://app.whoop.com` - redirects to `https://id.whoop.com/za/en/sign-in/?for=https%3A%2F%2Fapp.whoop.com`
2. Fill the `Email` text field and `Password` text field
3. Click the `Sign In` button
4. Page redirects to `https://app.whoop.com/athlete/{userId}/1d/today`
5. Auth tokens are now stored in browser cookies

**Cloudflare Turnstile:** The login page uses Cloudflare Turnstile anti-bot protection. To bypass it, Playwright must launch with `--disable-blink-features=AutomationControlled`, set a realistic user agent, and hide the `navigator.webdriver` flag via `addInitScript`.

**Token details:**
- Cookie name: `whoop-auth-token` - a JWT Bearer token
- Cookie name: `whoop-auth-refresh-token` - for token refresh
- Cookie name: `whoop-auth-expiry` - human-readable expiry timestamp
- Token validity: **24 hours** from login
- The JWT payload contains `custom:user_id` which is the numeric user ID needed for API calls

**Using the token for API calls:**
```
Authorization: Bearer {value of whoop-auth-token cookie}
```

### Heart Rate API

**Endpoint:**
```
GET https://api.prod.whoop.com/metrics-service/v1/metrics/user/{userId}
```

**Query parameters:**
| Parameter | Value | Notes |
|-----------|-------|-------|
| `apiVersion` | `7` | Required |
| `name` | `heart_rate` | The only supported metric on this endpoint |
| `start` | ISO 8601 datetime | e.g. `2026-02-18T12:00:00.000Z` |
| `end` | ISO 8601 datetime | e.g. `2026-02-18T21:59:59.999Z` |
| `step` | `60` | Seconds between data points. Use 60 for 1-minute resolution. 600 also works for 10-min resolution. |
| `order` | `t` | Order by time |

**Response format:**
```json
{
  "name": "heart_rate",
  "start": 1771416000000,
  "values": [
    {"data": 68, "time": 1771416000950},
    {"data": 74, "time": 1771416060950},
    {"data": 72, "time": 1771416120950}
  ]
}
```

- `data`: heart rate in BPM (integer)
- `time`: epoch milliseconds
- Points are spaced exactly `step` seconds apart
- Empty `values` array if no data exists for the time range

### Data Latency

Heart rate data appears in the API approximately **10 minutes behind real-time**. When queried at 16:07 UTC, the most recent data point was from 15:57 UTC. This is consistent - the Whoop device syncs data to the cloud in batches, not in real-time.

### Bonus Endpoint: Cycle/Recovery Data

The following endpoint returns daily recovery, sleep, strain, and workout data:

```
GET https://api.prod.whoop.com/core-details-bff/v0/cycles/details
  ?apiVersion=7
  &id={userId}
  &startTime={ISO8601}
  &endTime={ISO8601}
```

This returns per-cycle records containing:
- **Recovery**: score (0-100%), resting heart rate, HRV (RMSSD), SpO2, skin temp
- **Sleep**: duration, stages (light/SWS/REM), efficiency, disturbances, respiratory rate, sleep need, sleep debt
- **Strain**: daily strain score (0-21), kilojoules, avg/max heart rate
- **Workouts**: activity type, duration, strain

Same Bearer token auth. This is a secondary goal - heart rate sync is the primary objective.

## Environment Variables

The `.env` file in the project root must contain:

```
LOGIN_EMAIL=<whoop account email>
LOGIN_PASSWORD=<whoop account password>
SUPABASE_URL=<supabase project URL, e.g. https://xxx.supabase.co>
SUPABASE_ANON_KEY=<supabase anon/public key>
```

Optional (with defaults):

```
SYNC_INTERVAL_MINUTES=5
```

## Architecture

### Sync Loop (High-Water Mark Pattern)

The service avoids fetching duplicate data by tracking a **high-water mark** - the timestamp of the most recent data point successfully stored. Each run only queries for data *after* that point.

```
Every 5 minutes:
  1. Do we have a valid (non-expired) auth token?
     - NO:  Launch Playwright headless, log in, extract token from cookies, store it
     - YES: Continue
  2. Determine the time window to fetch:
     - start = high-water mark timestamp (or 24h ago on first run)
     - end   = now
  3. GET /metrics-service/v1/metrics/user/{userId}?...&step=60
     with Authorization: Bearer {token}
  4. If response.values is empty: done (no new data yet, this is normal)
  5. If response.values has data:
     - Call insert_heart_rate RPC with the batch of points
     - The RPC handles ON CONFLICT (user_id, time) DO NOTHING internally
     - High-water mark advances to max(time) from returned values
```

**Why 5 minutes:** Heart rate data appears in the API with ~10 minutes of latency, arriving in batches. A 5-minute interval means each request will typically return 5-10 new data points. This matches the data availability well without wasted requests.

**The `ON CONFLICT DO NOTHING` inside the RPC is a safety net**, not the primary dedup mechanism. It protects against edge cases like process restarts where the watermark might not have been persisted. Under normal operation, the watermark ensures you never request data you already have.

**High-water mark storage:** Retrieved via the `get_heart_rate_watermark` RPC function which runs `SELECT MAX(time) FROM whoop.heart_rate`. No separate state file needed - the database is the source of truth.

### Token Management

- After Playwright login, extract all three cookies: `whoop-auth-token`, `whoop-auth-refresh-token`, `whoop-auth-expiry`
- Parse the JWT to extract `custom:user_id` (so the user ID doesn't need to be hardcoded)
- Parse `exp` from the JWT to know when it expires
- Store the token in memory (token is refreshed by re-login when expired)
- Re-login via Playwright when the token is expired or an API call returns 401

### Database (Supabase)

Data is stored in a **Supabase** PostgreSQL instance in the `whoop` schema. The service communicates with Supabase via `@supabase/supabase-js` calling RPC functions, so the `whoop` schema does **not** need to be exposed in Supabase's API settings.

**Schema setup (run once in Supabase SQL Editor):**

```sql
-- Create the whoop schema
CREATE SCHEMA IF NOT EXISTS whoop;

-- Create the heart_rate table
CREATE TABLE whoop.heart_rate (
    time       TIMESTAMPTZ NOT NULL,
    bpm        INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    synced_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, time)
);

CREATE INDEX idx_heart_rate_time ON whoop.heart_rate (time DESC);

-- Permissions
GRANT USAGE ON SCHEMA whoop TO anon, authenticated;
GRANT ALL ON ALL TABLES IN SCHEMA whoop TO anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA whoop GRANT ALL ON TABLES TO anon, authenticated;
```

**RPC functions (run once in Supabase SQL Editor):**

```sql
-- Batch insert heart rate data with deduplication
CREATE OR REPLACE FUNCTION insert_heart_rate(points JSONB)
RETURNS INTEGER
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  inserted INTEGER;
BEGIN
  WITH ins AS (
    INSERT INTO whoop.heart_rate (time, bpm, user_id)
    SELECT
      to_timestamp((p->>'time')::bigint / 1000.0) AT TIME ZONE 'UTC',
      (p->>'bpm')::integer,
      (p->>'user_id')::integer
    FROM jsonb_array_elements(points) AS p
    ON CONFLICT (user_id, time) DO NOTHING
    RETURNING 1
  )
  SELECT COUNT(*) INTO inserted FROM ins;
  RETURN inserted;
END;
$$;

-- Get the most recent synced timestamp
CREATE OR REPLACE FUNCTION get_heart_rate_watermark()
RETURNS TIMESTAMPTZ
LANGUAGE sql
SECURITY DEFINER
AS $$
  SELECT MAX(time) FROM whoop.heart_rate;
$$;
```

### Docker

The project produces a `docker-compose.yml` with a single service:

1. **whoop-sync** - the Node.js application with Playwright

No database container is needed since Supabase is used as the remote database.

The sync service Dockerfile needs:
- Node.js runtime
- Playwright with Chromium dependencies installed (use `npx playwright install --with-deps chromium`)
- The application code

## Tech Stack

- **Runtime**: Node.js (TypeScript)
- **Browser automation**: Playwright (headless Chromium)
- **Scheduling**: setInterval loop
- **Database**: Supabase (@supabase/supabase-js)
- **Environment**: dotenv

## Important Implementation Notes

1. **Playwright on Linux needs system dependencies.** The Dockerfile must install them. The `npx playwright install --with-deps chromium` command handles this on Debian/Ubuntu-based images.

2. **The login page structure**: The sign-in page has input fields identifiable by placeholder text "Email address" and "Password", and a button matching `/sign in/i`. After successful login, the URL changes to `https://app.whoop.com/athlete/{userId}/...`.

3. **Cloudflare Turnstile bypass**: The login page has anti-bot protection. Playwright must be configured with `--disable-blink-features=AutomationControlled`, a realistic user agent string, and `navigator.webdriver` set to `false` via `addInitScript`.

4. **Cookie extraction after login**: After the page navigates post-login, read all cookies from the browser context. The three relevant cookies are on the `.whoop.com` domain: `whoop-auth-token`, `whoop-auth-refresh-token`, `whoop-auth-expiry`.

5. **The `step` parameter**: Use `step=60` for 1-minute resolution. The API also accepts `step=600` for 10-minute resolution. Stick with 60.

6. **Time zones**: All API timestamps are in UTC (epoch milliseconds). Store as `TIMESTAMPTZ` in PostgreSQL.

7. **The metrics endpoint only supports `heart_rate`**. Attempting other metric names (skin_temp, spo2, hrv, etc.) returns HTTP 400 with `"query param name must be one of [heart_rate]"`.

8. **Graceful handling of empty responses**: If the Whoop is not being worn or has no data for a time window, the API returns `{"name":"heart_rate","start":...,"values":[]}`. This is normal, not an error.

9. **Rate limiting**: No rate limiting was observed during testing. A 5-minute polling interval with a single GET request per cycle is very light.

10. **401 handling**: If an API call returns "Authorization was not valid", the token has expired. Trigger a fresh Playwright login.
