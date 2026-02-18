import { createClient } from "@supabase/supabase-js";
import { config } from "./config";

const supabase = createClient(config.supabaseUrl, config.supabaseAnonKey);

export async function getHighWaterMark(): Promise<Date | null> {
  const { data, error } = await supabase.rpc("get_heart_rate_watermark");
  if (error) throw new Error(`Failed to get watermark: ${error.message}`);
  return data ? new Date(data) : null;
}

export async function insertHeartRatePoints(
  points: Array<{ bpm: number; time: number }>,
  userId: number
): Promise<number> {
  if (points.length === 0) return 0;

  const payload = points.map((p) => ({
    time: p.time,
    bpm: p.bpm,
    user_id: userId,
  }));

  const { data, error } = await supabase.rpc("insert_heart_rate", {
    points: payload,
  });

  if (error) throw new Error(`Failed to insert heart rate: ${error.message}`);
  return data ?? 0;
}
