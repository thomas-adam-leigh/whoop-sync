import { config } from "./config";
import { getToken, login, clearToken } from "./auth";
import { fetchHeartRate, AuthExpiredError } from "./api";
import { getHighWaterMark, insertHeartRatePoints } from "./db";

async function sync(): Promise<void> {
  // 1. Ensure we have a valid token
  let token = getToken();
  if (!token) {
    token = await login();
  }

  // 2. Determine time window
  const highWaterMark = await getHighWaterMark();
  const start = highWaterMark || new Date(Date.now() - 24 * 60 * 60 * 1000);
  const end = new Date();

  console.log(
    `[sync] Fetching heart rate from ${start.toISOString()} to ${end.toISOString()}`
  );

  // 3. Fetch data
  let points;
  try {
    points = await fetchHeartRate(token, start, end);
  } catch (err) {
    if (err instanceof AuthExpiredError) {
      console.log("[sync] Token expired, re-authenticating...");
      clearToken();
      token = await login();
      points = await fetchHeartRate(token, start, end);
    } else {
      throw err;
    }
  }

  // 4. Insert
  if (points.length === 0) {
    console.log("[sync] No new data points");
    return;
  }

  const inserted = await insertHeartRatePoints(points, token.userId);
  console.log(
    `[sync] ${inserted} new rows inserted (${points.length} points fetched)`
  );
}

async function main(): Promise<void> {
  console.log(
    `[main] Whoop Sync starting (interval: ${config.syncIntervalMinutes}m)`
  );

  // Run immediately on startup
  await runSync();

  // Then on interval
  const intervalMs = config.syncIntervalMinutes * 60 * 1000;
  setInterval(runSync, intervalMs);
}

async function runSync(): Promise<void> {
  try {
    await sync();
  } catch (err) {
    console.error("[sync] Error:", err instanceof Error ? err.message : err);
  }
}

// Graceful shutdown
process.on("SIGINT", () => {
  console.log("[main] Shutting down...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.log("[main] Shutting down...");
  process.exit(0);
});

main();
