import { browserVia, context } from "../browser.js";
import { tinyfishFetch } from "../tinyfish.js";
import type { Adapter, Listing, Review, SearchOptions } from "../types.js";
import { money } from "../types.js";

/**
 * Amazon serves search results to a plain headless Chromium (verified 2026-10-17).
 * Review text is behind sign-in on amazon.com now; dp pages expose only rating + count.
 * Browser-side code is kept as strings: tsx/esbuild injects a `__name` helper into
 * transpiled callbacks, which does not exist inside the page.
 */
const SEARCH_SCRIPT = `(() => {
  const out = [];
  for (const d of document.querySelectorAll("div[data-asin][data-component-type='s-search-result']")) {
    const asin = d.getAttribute("data-asin"); if (!asin) continue;
    const q = (s) => { const el = d.querySelector(s); return el && el.textContent ? el.textContent.trim() : null; };
    const titles = Array.from(d.querySelectorAll("h2 span, a[class*='s-line-clamp']")).map((el) => (el.textContent || "").trim()).filter(Boolean);
    const ratingEl = d.querySelector("[aria-label*='out of 5']");
    const countEl = d.querySelector("[aria-label$='ratings'], [aria-label$='rating']");
    const img = d.querySelector("img.s-image");
    out.push({
      asin,
      title: titles.sort((a, b) => b.length - a.length)[0] || null,
      brand: q("[data-cy='title-recipe'] .a-size-base-plus.a-color-base"),
      price: q(".a-price .a-offscreen"),
      rating: ratingEl ? ratingEl.getAttribute("aria-label") : q("i[class*='a-icon-star'] span"),
      reviews: countEl ? countEl.getAttribute("aria-label") : q("span.s-underline-text"),
      img: img ? img.src : null,
      sponsored: !!d.querySelector("[aria-label='Sponsored'], .puis-sponsored-label-text"),
    });
  }
  return out;
})()`;

const ITEM_SCRIPT = `(() => {
  const q = (s) => { const el = document.querySelector(s); return el && el.textContent ? el.textContent.trim() : null; };
  const reviews = Array.from(document.querySelectorAll("[data-hook='review']")).slice(0, 8).map((r) => {
    const g = (s) => { const el = r.querySelector(s); return el && el.textContent ? el.textContent.trim() : null; };
    return { rating: g("[data-hook='review-star-rating'] span, [data-hook='cmps-review-star-rating'] span"), title: g("[data-hook='review-title'] span:last-child"), body: g("[data-hook='review-body']") || "", date: g("[data-hook='review-date']") };
  });
  const img = document.querySelector("#landingImage");
  const bullets = Array.from(document.querySelectorAll("#feature-bullets li span")).map((x) => (x.textContent || "").trim()).filter(Boolean).slice(0, 6).join(" | ");
  return { title: q("#productTitle"), price: Array.from(document.querySelectorAll("#corePriceDisplay_desktop_feature_div .a-price .a-offscreen, #corePrice_feature_div .a-offscreen, .a-price .a-offscreen")).map((e) => (e.textContent || "").trim()).find((t) => /\$\s?\d/.test(t)) || null, rating: q("#acrPopover .a-icon-alt, span[data-hook='rating-out-of-text']"), count: q("#acrCustomerReviewText"), img: img ? img.src : null, bullets, reviews };
})()`;

/**
 * Amazon search results through TinyFish markdown (no browser), scoped to the result containers:
 * "## <brand>" / "## <title>" / "3.5*3.5 out of 5 stars* (35)" / "Price, product page$650.00$650.00",
 * preceded by "Sponsored" for ads. Product links cannot be aligned to results (each result also links
 * to other colours: 60 results, 101 ids on one page), so hosted rows carry a search-by-title URL and
 * no ASIN. The local browser path returns exact ASINs.
 */
export const AMAZON_RESULT_SELECTOR = "div[data-component-type='s-search-result']";
export function amazonFromMarkdown(text: string): Listing[] {
  const out: Listing[] = []; let heads: string[] = []; let sponsored = false; let rating: number | null = null; let reviews: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim(); if (!line) continue;
    if (/^Sponsored/i.test(line)) { sponsored = true; continue; }
    const h = line.match(/^##\s+(.+)/); if (h) { heads.push(h[1].trim()); continue; }
    const rt = line.match(/^([\d.]+)\*?[\d.]* out of 5 stars\*?\s*\(?([\d,]*)\)?/); if (rt) { rating = Number(rt[1]); reviews = rt[2] ? Number(rt[2].replace(/,/g, "")) : null; continue; }
    const pr = line.match(/^(?:Price, product page)?\$([\d,]+(?:\.\d\d)?)/);
    if (pr && heads.length) {
      const brand = heads.length >= 2 ? heads[heads.length - 2] : null; const title = heads.slice(-2).join(" ");
      out.push({ marketplace: "amazon", id: `md-${out.length}`, title, price_usd: Number(pr[1].replace(/,/g, "")), condition: "new", url: `https://www.amazon.com/s?k=${encodeURIComponent(title)}`, image: null, brand, rating, review_count: reviews, sponsored });
      heads = []; sponsored = false; rating = null; reviews = null;
    }
  }
  return out;
}

const num = (s: unknown) => (s ? Number(String(s).replace(/,/g, "").match(/[\d.]+/)?.[0]) : null);

export const amazon: Adapter & { lastError?: string; lastPath?: string } = {
  name: "amazon",
  via: "local headless browser on amazon.com/s when available, else TinyFish server-side render (hosted)",
  async search(query: string, opts: SearchOptions = {}) {
    const limit = opts.limit ?? 20;
    if (browserVia() !== "local headless chromium") {
      // hosted: Amazon blocks datacenter browsers (Browserbase incl.), TinyFish's render gets through
      const { results, errors } = await tinyfishFetch([`https://www.amazon.com/s?k=${encodeURIComponent(query)}`], { selectors: [AMAZON_RESULT_SELECTOR], purpose: "read product listings for price comparison" });
      if (!results[0]) throw new Error(`amazon via tinyfish: ${errors[0]?.error ?? "no result"}`);
      amazon.lastPath = "tinyfish markdown (search-by-title URLs)";
      return amazonFromMarkdown(results[0].text).slice(0, limit);
    }
    amazon.lastPath = "local browser";
    const page = await (await context()).newPage();
    try {
      await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForSelector("div[data-asin][data-component-type='s-search-result']", { timeout: 20_000 });
      const rows: any[] = await page.evaluate(SEARCH_SCRIPT);
      amazon.lastError = undefined;
      return rows.slice(0, limit).map((r): Listing => ({
        marketplace: "amazon", id: r.asin, title: [r.brand, r.title].filter(Boolean).join(" ") || "(untitled)", price_usd: money(r.price), condition: "new",
        url: `https://www.amazon.com/dp/${r.asin}`, image: r.img, brand: r.brand,
        rating: num(r.rating), review_count: num(r.reviews), sponsored: r.sponsored,
      }));
    } catch (e: any) {
      amazon.lastError = e.message.split("\n")[0];
      const { results } = await tinyfishFetch([`https://www.amazon.com/s?k=${encodeURIComponent(query)}`], { links: true });
      const asins = [...new Set((results[0]?.links ?? []).map((l) => l.match(/\/dp\/([A-Z0-9]{10})/)?.[1]).filter(Boolean))] as string[];
      return asins.slice(0, limit).map((asin) => ({ marketplace: "amazon", id: asin, title: "(see url)", price_usd: null, condition: "new", url: `https://www.amazon.com/dp/${asin}`, image: null }));
    } finally { await page.close(); }
  },
  async item(asin: string) {
    const page = await (await context()).newPage();
    try {
      await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForSelector("#productTitle, #title", { timeout: 20_000 });
      await page.evaluate("window.scrollTo(0, document.body.scrollHeight)");
      await page.waitForSelector("[data-hook='review']", { timeout: 8_000 }).catch(() => {});
      const d: any = await page.evaluate(ITEM_SCRIPT);
      const listing: Listing = { marketplace: "amazon", id: asin, title: d.title ?? "", price_usd: money(d.price), condition: "new", url: `https://www.amazon.com/dp/${asin}`, image: d.img, rating: num(d.rating), review_count: num(d.count) };
      const reviews: Review[] = d.reviews.map((r: any) => ({ rating: num(r.rating), title: r.title, body: r.body, date: r.date }));
      return { listing, description: d.bullets, reviews };
    } finally { await page.close(); }
  },
};
