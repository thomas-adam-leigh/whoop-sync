import { type AuthToken } from "./auth";

interface HeartRatePoint {
  bpm: number;
  time: number; // epoch ms
}

interface MetricsResponse {
  name: string;
  start: number;
  values: Array<{ data: number; time: number }>;
}

export async function fetchHeartRate(
  token: AuthToken,
  start: Date,
  end: Date
): Promise<HeartRatePoint[]> {
  const params = new URLSearchParams({
    apiVersion: "7",
    name: "heart_rate",
    start: start.toISOString(),
    end: end.toISOString(),
    step: "60",
    order: "t",
  });

  const url = `https://api.prod.whoop.com/metrics-service/v1/metrics/user/${token.userId}?${params}`;

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${token.accessToken}` },
  });

  if (response.status === 401 || response.status === 403) {
    throw new AuthExpiredError("Token expired or invalid");
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Heart rate API returned ${response.status}: ${text}`);
  }

  const data = (await response.json()) as MetricsResponse;
  return data.values.map((v) => ({ bpm: v.data, time: v.time }));
}

export class AuthExpiredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthExpiredError";
  }
}
