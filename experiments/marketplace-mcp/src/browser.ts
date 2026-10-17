import { chromium, type Browser, type BrowserContext } from "playwright";

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Safari/537.36";
let browser: Browser | null = null;
let ctx: BrowserContext | null = null;

/** One headless Chromium per process, shared by every adapter that needs a real browser. */
export async function context(): Promise<BrowserContext> {
  if (ctx) return ctx;
  browser = await chromium.launch({ headless: true });
  ctx = await browser.newContext({ userAgent: UA, viewport: { width: 1280, height: 900 }, locale: "en-US" });
  return ctx;
}

export async function closeBrowser() {
  await ctx?.close().catch(() => {});
  await browser?.close().catch(() => {});
  ctx = null; browser = null;
}
