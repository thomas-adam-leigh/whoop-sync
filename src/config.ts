import "dotenv/config";

export const config = {
  loginEmail: requireEnv("LOGIN_EMAIL"),
  loginPassword: requireEnv("LOGIN_PASSWORD"),
  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || "5", 10),
  supabaseUrl: requireEnv("SUPABASE_URL"),
  supabaseAnonKey: requireEnv("SUPABASE_ANON_KEY"),
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
