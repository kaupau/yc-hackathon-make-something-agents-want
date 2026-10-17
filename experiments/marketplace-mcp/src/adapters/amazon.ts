import { context } from "../browser.js";
import { tinyfishFetch } from "../tinyfish.js";
import type { Adapter, Listing, Review, SearchOptions } from "../types.js";
import { money } from "../types.js";

/** Amazon serves search results to a plain headless Chromium (verified 2026-10-17). Falls back to TinyFish markdown when it does not. */
export const amazon: Adapter = {
  name: "amazon",
  via: "headless browser on amazon.com/s (live); TinyFish fallback",
  async search(query: string, opts: SearchOptions = {}) {
    const limit = opts.limit ?? 20;
    const page = await (await context()).newPage();
    try {
      await page.goto(`https://www.amazon.com/s?k=${encodeURIComponent(query)}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForSelector("div[data-asin][data-component-type='s-search-result']", { timeout: 20_000 });
      const rows = await page.evaluate(() => {
        const out: any[] = [];
        for (const d of document.querySelectorAll("div[data-asin][data-component-type='s-search-result']")) {
          const asin = d.getAttribute("data-asin"); if (!asin) continue;
          const q = (s: string) => (d.querySelector(s) as HTMLElement | null)?.textContent?.trim() || null;
          const titles = ["[data-cy='title-recipe'] h2 span", "h2 a span", "h2 span", "h2"].map(q).filter(Boolean) as string[];
          out.push({
            asin, title: titles.sort((a, b) => b.length - a.length)[0] ?? null,
            brand: q("[data-cy='title-recipe'] .a-size-base-plus.a-color-base, h2 + div .a-size-base"),
            price: q(".a-price .a-offscreen"),
            rating: q("[aria-label*='out of 5']") ?? (d.querySelector("i[class*='a-icon-star'] span") as HTMLElement | null)?.textContent ?? null,
            reviews: (d.querySelector("[aria-label$='ratings'], [aria-label$='rating']") as HTMLElement | null)?.getAttribute("aria-label") ?? q("span.s-underline-text"),
            img: (d.querySelector("img.s-image") as HTMLImageElement | null)?.src ?? null,
            sponsored: !!d.querySelector("[aria-label='Sponsored'], .puis-sponsored-label-text"),
          });
        }
        return out;
      });
      return rows.slice(0, limit).map((r): Listing => ({
        marketplace: "amazon", id: r.asin, title: r.title ?? "(untitled)", price_usd: money(r.price), condition: "new",
        url: `https://www.amazon.com/dp/${r.asin}`, image: r.img, brand: r.brand,
        rating: r.rating ? Number(String(r.rating).match(/[\d.]+/)?.[0]) : null,
        review_count: r.reviews ? Number(String(r.reviews).replace(/,/g, "").match(/\d+/)?.[0]) : null,
        sponsored: r.sponsored,
      }));
    } catch (e) {
      // fallback: TinyFish markdown has /dp/ links but little structure; return URLs + titles only
      const { results } = await tinyfishFetch([`https://www.amazon.com/s?k=${encodeURIComponent(query)}`], { links: true });
      const links = [...new Set((results[0]?.links ?? []).map((l) => l.match(/\/dp\/([A-Z0-9]{10})/)?.[1]).filter(Boolean))] as string[];
      return links.slice(0, limit).map((asin) => ({ marketplace: "amazon", id: asin, title: "(see url)", price_usd: null, condition: "new", url: `https://www.amazon.com/dp/${asin}`, image: null }));
    } finally { await page.close(); }
  },
  async item(asin: string) {
    const page = await (await context()).newPage();
    try {
      await page.goto(`https://www.amazon.com/dp/${asin}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForSelector("#productTitle, #title", { timeout: 20_000 });
      const d = await page.evaluate(() => {
        const q = (s: string) => (document.querySelector(s) as HTMLElement | null)?.textContent?.trim() || null;
        const reviews = [...document.querySelectorAll("[data-hook='review']")].slice(0, 8).map((r) => ({
          rating: (r.querySelector("[data-hook='review-star-rating'] span, [data-hook='cmps-review-star-rating'] span") as HTMLElement | null)?.textContent ?? null,
          title: (r.querySelector("[data-hook='review-title'] span:last-child") as HTMLElement | null)?.textContent?.trim() ?? null,
          body: (r.querySelector("[data-hook='review-body']") as HTMLElement | null)?.textContent?.trim() ?? "",
          date: (r.querySelector("[data-hook='review-date']") as HTMLElement | null)?.textContent ?? null,
        }));
        return { title: q("#productTitle"), price: q("#corePrice_feature_div .a-offscreen, .a-price .a-offscreen"), rating: q("#acrPopover .a-icon-alt, span[data-hook='rating-out-of-text']"), count: q("#acrCustomerReviewText"), img: (document.querySelector("#landingImage") as HTMLImageElement | null)?.src ?? null, bullets: [...document.querySelectorAll("#feature-bullets li span")].map((x) => x.textContent?.trim()).filter(Boolean).slice(0, 6).join(" | "), reviews };
      });
      const listing: Listing = { marketplace: "amazon", id: asin, title: d.title ?? "", price_usd: money(d.price), condition: "new", url: `https://www.amazon.com/dp/${asin}`, image: d.img, rating: d.rating ? Number(d.rating.match(/[\d.]+/)?.[0]) : null, review_count: d.count ? Number(d.count.replace(/,/g, "").match(/\d+/)?.[0]) : null };
      const reviews: Review[] = d.reviews.map((r) => ({ rating: r.rating ? Number(r.rating.match(/[\d.]+/)?.[0]) : null, title: r.title, body: r.body, date: r.date }));
      return { listing, description: d.bullets, reviews };
    } finally { await page.close(); }
  },
};
