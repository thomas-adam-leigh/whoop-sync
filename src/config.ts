import "dotenv/config";

export const config = {
  loginEmail: requireEnv("LOGIN_EMAIL"),
  loginPassword: requireEnv("LOGIN_PASSWORD"),
  syncIntervalMinutes: parseInt(process.env.SYNC_INTERVAL_MINUTES || "5", 10),
  db: {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    database: process.env.DB_NAME || "whoop",
    user: process.env.DB_USER || "whoop",
    password: process.env.DB_PASSWORD || "whoop",
  },
};

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}
