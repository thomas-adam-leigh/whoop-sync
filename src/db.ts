import { Pool } from "pg";
import { config } from "./config";

const pool = new Pool(config.db);

export async function initDb(): Promise<void> {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS heart_rate (
      time       TIMESTAMPTZ NOT NULL,
      bpm        INTEGER NOT NULL,
      user_id    INTEGER NOT NULL,
      synced_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, time)
    );
  `);
  await pool.query(`
    CREATE INDEX IF NOT EXISTS idx_heart_rate_time ON heart_rate (time DESC);
  `);
  console.log("[db] Schema initialized");
}

export async function getHighWaterMark(): Promise<Date | null> {
  const result = await pool.query<{ max: Date | null }>(
    "SELECT MAX(time) as max FROM heart_rate"
  );
  return result.rows[0]?.max || null;
}

export async function insertHeartRatePoints(
  points: Array<{ bpm: number; time: number }>,
  userId: number
): Promise<number> {
  if (points.length === 0) return 0;

  // Build a single INSERT with multiple VALUES rows
  const values: any[] = [];
  const placeholders: string[] = [];

  for (let i = 0; i < points.length; i++) {
    const offset = i * 3;
    placeholders.push(`($${offset + 1}, $${offset + 2}, $${offset + 3})`);
    values.push(new Date(points[i].time), points[i].bpm, userId);
  }

  const result = await pool.query(
    `INSERT INTO heart_rate (time, bpm, user_id)
     VALUES ${placeholders.join(", ")}
     ON CONFLICT (user_id, time) DO NOTHING`,
    values
  );

  return result.rowCount ?? 0;
}

export async function close(): Promise<void> {
  await pool.end();
}
