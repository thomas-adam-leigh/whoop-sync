# Whoop Heart Rate Sync - Specification

## Overview

A Dockerized service that runs on a Linux server and continuously syncs heart rate data from the Whoop dashboard into a local PostgreSQL database. Whoop does not expose live heart rate via their public API, but the internal dashboard at `https://app.whoop.com` fetches it from an internal API. This service automates that process.

## How It Works (Research Findings)

### Authentication

Whoop uses **AWS Cognito** for authentication. The Cognito client has a server-side secret, which means **direct API authentication is not possible** - you cannot call the Cognito `InitiateAuth` endpoint directly. Authentication must go through the browser-based login flow.

**Login flow:**
1. Navigate to `https://app.whoop.com` - redirects to `https://id.whoop.com/za/en/sign-in/?for=https%3A%2F%2Fapp.whoop.com`
2. Fill the `Email` text field and `Password` text field
3. Click the `Sign In` button
4. Page redirects to `https://app.whoop.com/athlete/{userId}/1d/today`
5. Auth tokens are now stored in browser cookies

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

The `.env` file in the project root contains:

```
LOGIN_EMAIL=<whoop account email>
LOGIN_PASSWORD=<whoop account password>
```

The implementation should also support these variables (with sensible defaults):

```
SYNC_INTERVAL_MINUTES=5
DB_HOST=localhost
DB_PORT=5432
DB_NAME=whoop
DB_USER=whoop
DB_PASSWORD=whoop
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
     - INSERT INTO heart_rate (time, bpm, user_id) VALUES (...)
       ON CONFLICT (time, user_id) DO NOTHING
     - Set high-water mark = max(time) from the returned values
```

**Why 5 minutes:** Heart rate data appears in the API with ~10 minutes of latency, arriving in batches. A 5-minute interval means each request will typically return 5-10 new data points. This matches the data availability well without wasted requests.

**The `ON CONFLICT DO NOTHING` is a safety net**, not the primary dedup mechanism. It protects against edge cases like process restarts where the watermark might not have been persisted. Under normal operation, the watermark ensures you never request data you already have.

**High-water mark storage:** On startup, query `SELECT MAX(time) FROM heart_rate` to recover the watermark. No separate state file needed - the database is the source of truth. During runtime, keep it in memory and update after each successful insert batch.

### Token Management

- After Playwright login, extract all three cookies: `whoop-auth-token`, `whoop-auth-refresh-token`, `whoop-auth-expiry`
- Parse the JWT to extract `custom:user_id` (so the user ID doesn't need to be hardcoded)
- Parse `exp` from the JWT to know when it expires
- Store the token in memory or on disk (a simple JSON file is fine)
- Re-login via Playwright when the token is expired or an API call returns 401

### Database

**PostgreSQL** running locally (or in a sibling Docker container).

```sql
CREATE TABLE IF NOT EXISTS heart_rate (
    time       TIMESTAMPTZ NOT NULL,
    bpm        INTEGER NOT NULL,
    user_id    INTEGER NOT NULL,
    synced_at  TIMESTAMPTZ DEFAULT NOW(),
    PRIMARY KEY (user_id, time)
);

CREATE INDEX IF NOT EXISTS idx_heart_rate_time ON heart_rate (time DESC);
```

The composite primary key `(user_id, time)` ensures idempotent inserts via `ON CONFLICT DO NOTHING`.

### Docker

The project should produce a `docker-compose.yml` with two services:

1. **postgres** - standard postgres image, with a volume for persistence
2. **whoop-sync** - the Node.js application with Playwright

The sync service Dockerfile needs:
- Node.js runtime
- Playwright with Chromium dependencies installed (use `npx playwright install --with-deps chromium`)
- The application code

## Tech Stack

- **Runtime**: Node.js (TypeScript preferred)
- **Browser automation**: Playwright (headless Chromium)
- **Scheduling**: node-cron or a simple setInterval loop
- **Database client**: pg (node-postgres)
- **Environment**: dotenv

## Important Implementation Notes

1. **Playwright on Linux needs system dependencies.** The Dockerfile must install them. The `npx playwright install --with-deps chromium` command handles this on Debian/Ubuntu-based images.

2. **The login page structure**: The sign-in page has a text input with label "Email", a text input with label "Password", and a button with text "Sign In". After successful login, the URL changes to `https://app.whoop.com/athlete/{userId}/...`.

3. **Cookie extraction after login**: After the page navigates post-login, read all cookies from the browser context. The three relevant cookies are on the `.whoop.com` domain: `whoop-auth-token`, `whoop-auth-refresh-token`, `whoop-auth-expiry`.

4. **The `step` parameter**: Use `step=60` for 1-minute resolution. The API also accepts `step=600` for 10-minute resolution. Stick with 60.

5. **Time zones**: All API timestamps are in UTC (epoch milliseconds). Store as `TIMESTAMPTZ` in PostgreSQL.

6. **The metrics endpoint only supports `heart_rate`**. Attempting other metric names (skin_temp, spo2, hrv, etc.) returns HTTP 400 with `"query param name must be one of [heart_rate]"`.

7. **Graceful handling of empty responses**: If the Whoop is not being worn or has no data for a time window, the API returns `{"name":"heart_rate","start":...,"values":[]}`. This is normal, not an error.

8. **Rate limiting**: No rate limiting was observed during testing. A 5-minute polling interval with a single GET request per cycle is very light.

9. **401 handling**: If an API call returns "Authorization was not valid", the token has expired. Trigger a fresh Playwright login.
