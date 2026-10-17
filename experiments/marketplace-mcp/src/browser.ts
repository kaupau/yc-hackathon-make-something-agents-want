import { chromium, type Browser, type BrowserContext } from "playwright";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
let browser: Browser | null = null;
let ctx: BrowserContext | null = null;

/**
 * One browser per process, shared by every adapter that needs a real browser.
 * Local headless Chromium by default. With BROWSERBASE_API_KEY (+ BROWSERBASE_PROJECT_ID) set,
 * a Browserbase cloud session is created (stealth fingerprint, optional residential proxies via
 * BROWSERBASE_PROXIES=1) and attached over CDP; that is the path for hosting on Manufact, where
 * shipping Chromium in the container is the open question, and the first thing to try against eBay.
 */
export async function context(): Promise<BrowserContext> {
  if (ctx) return ctx;
  const key = process.env.BROWSERBASE_API_KEY;
  if (key) {
    const r = await fetch("https://api.browserbase.com/v1/sessions", {
      method: "POST", headers: { "x-bb-api-key": key, "content-type": "application/json" },
      body: JSON.stringify({ projectId: process.env.BROWSERBASE_PROJECT_ID, proxies: process.env.BROWSERBASE_PROXIES === "1", browserSettings: { advancedStealth: true, viewport: { width: 1280, height: 900 } } }),
    });
    if (!r.ok) throw new Error(`browserbase session: ${r.status} ${(await r.text()).slice(0, 200)}`);
    const s = (await r.json()) as { connectUrl: string; id: string };
    browser = await chromium.connectOverCDP(s.connectUrl);
    ctx = browser.contexts()[0] ?? (await browser.newContext());
    (ctx as any).browserbaseSessionId = s.id;
    return ctx;
  }
  browser = await chromium.launch({ headless: true });
  ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US" });
  return ctx;
}

export const browserVia = () => (process.env.BROWSERBASE_API_KEY ? "browserbase cloud session" : "local headless chromium");

export async function closeBrowser() {
  await ctx?.close().catch(() => {});
  await browser?.close().catch(() => {});
  ctx = null; browser = null;
}
