import { chromium, type BrowserContext } from "playwright";
import { config } from "./config";

export interface AuthToken {
  accessToken: string;
  refreshToken: string;
  userId: number;
  expiresAt: number; // epoch ms
}

let cachedToken: AuthToken | null = null;

export function getToken(): AuthToken | null {
  if (!cachedToken) return null;
  // Treat as expired 5 minutes early to avoid mid-request expiry
  if (Date.now() > cachedToken.expiresAt - 5 * 60 * 1000) return null;
  return cachedToken;
}

export async function login(): Promise<AuthToken> {
  console.log("[auth] Launching headless browser for login...");

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--disable-blink-features=AutomationControlled",
    ],
  });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 720 },
  });
  const page = await context.newPage();

  // Hide webdriver flag
  await page.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  try {
    await page.goto("https://app.whoop.com", { timeout: 60000 });
    console.log(`[auth] Redirected to: ${page.url()}`);

    // Wait for any input field to appear - the login page is a React SPA
    await page.waitForSelector('input', { state: "visible", timeout: 30000 });
    console.log("[auth] Login form visible, filling credentials...");

    // Use placeholder-based selectors which are more resilient
    const emailField =
      page.getByPlaceholder("Email address") ||
      page.locator('input[type="email"]');
    await emailField.fill(config.loginEmail);

    const passwordField =
      page.getByPlaceholder("Password") ||
      page.locator('input[type="password"]');
    await passwordField.fill(config.loginPassword);

    // Click the sign-in button
    await page.getByRole("button", { name: /sign in/i }).click();

    // Wait for redirect to the dashboard
    await page.waitForURL(/app\.whoop\.com\/athlete\//, { timeout: 30000 });
    console.log("[auth] Login successful, extracting tokens...");

    const token = await extractToken(context);
    cachedToken = token;

    console.log(`[auth] Authenticated as user ${token.userId}, token expires at ${new Date(token.expiresAt).toISOString()}`);
    return token;
  } finally {
    await browser.close();
  }
}

export function clearToken(): void {
  cachedToken = null;
}

async function extractToken(context: BrowserContext): Promise<AuthToken> {
  const cookies = await context.cookies("https://app.whoop.com");

  const authCookie = cookies.find((c) => c.name === "whoop-auth-token");
  const refreshCookie = cookies.find((c) => c.name === "whoop-auth-refresh-token");

  if (!authCookie) {
    throw new Error("whoop-auth-token cookie not found after login");
  }

  const payload = parseJwtPayload(authCookie.value);
  const userId = parseInt(payload["custom:user_id"], 10);
  const expiresAt = payload.exp * 1000;

  return {
    accessToken: authCookie.value,
    refreshToken: refreshCookie?.value || "",
    userId,
    expiresAt,
  };
}

function parseJwtPayload(jwt: string): Record<string, any> {
  const parts = jwt.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT format");
  const payload = Buffer.from(parts[1], "base64url").toString("utf-8");
  return JSON.parse(payload);
}
