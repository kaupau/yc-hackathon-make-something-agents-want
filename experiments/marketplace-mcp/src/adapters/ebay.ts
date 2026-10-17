import * as cheerio from "cheerio";
import { tinyfishFetch } from "../tinyfish.js";
import type { Adapter, Listing, SearchOptions } from "../types.js";
import { money } from "../types.js";

/**
 * eBay blocks plain curl and a local headless Chromium ("Error Page"), but TinyFish's
 * server-side render passes when a cached entry is allowed (ttl omitted). Prefer HTML +
 * cheerio when the classes survive, else parse the markdown bullets.
 * Upgrade path: the official Browse API (EBAY_CLIENT_ID/EBAY_CLIENT_SECRET) when a dev account exists.
 */
function searchUrl(q: string, sold: boolean) {
  const base = `https://www.ebay.com/sch/i.html?_nkw=${encodeURIComponent(q)}&_sop=15`;
  return sold ? `${base}&LH_Sold=1&LH_Complete=1` : base;
}

function fromHtml(html: string, sold: boolean): Listing[] {
  const $ = cheerio.load(html);
  const out: Listing[] = [];
  $("li.s-item, li.s-card").each((_, li) => {
    const a = $(li).find("a[href*='/itm/']").first();
    const id = a.attr("href")?.match(/\/itm\/(\d+)/)?.[1]; if (!id) return;
    const t = (s: string) => $(li).find(s).first().text().trim() || null;
    out.push({ marketplace: "ebay", id, title: t(".s-item__title, .s-card__title") ?? "", price_usd: money(t(".s-item__price, .s-card__price")), condition: t(".SECONDARY_INFO, .s-card__subtitle"), url: `https://www.ebay.com/itm/${id}`, image: $(li).find("img").first().attr("src") ?? null, shipping_usd: money(t(".s-item__shipping, .s-card__shipping, [class*='shipping']")), sold });
  });
  return out;
}

function fromMarkdown(md: string, links: string[], sold: boolean): Listing[] {
  const ids = [...new Set(links.map((l) => l.match(/\/itm\/(\d+)/)?.[1]).filter(Boolean))] as string[];
  const bullets = md.split("\n").filter((l) => l.startsWith("* ") && /\$\s?\d/.test(l));
  return bullets.map((b, i): Listing => {
    const text = b.slice(2);
    const title = text.split(/Opens in a new window or tab/)[0].replace(/New Listing/i, "").trim();
    const cond = text.match(/(Pre-Owned|Brand New|New with tags|New without tags|Open box|Parts Only|Certified - Refurbished|Excellent - Refurbished|Very Good - Refurbished|Good - Refurbished)/i)?.[1] ?? null;
    const prices = [...text.matchAll(/\$\s?([\d,]+(?:\.\d\d)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
    const ship = text.match(/\+\$\s?([\d,]+(?:\.\d\d)?)/)?.[1];
    const id = ids[i] ?? `md-${i}`;
    return { marketplace: "ebay", id, title, price_usd: prices[0] ?? null, condition: cond, url: `https://www.ebay.com/itm/${id}`, image: null, shipping_usd: ship ? Number(ship.replace(/,/g, "")) : /Free (shipping|delivery)/i.test(text) ? 0 : null, sold };
  });
}

export const ebay: Adapter = {
  name: "ebay",
  via: "TinyFish server-side render of ebay.com/sch (cached up to a few minutes); Browse API when creds are set",
  async search(query: string, opts: SearchOptions = {}) {
    const limit = opts.limit ?? 20; const sold = !!opts.sold;
    const url = searchUrl(query, sold);
    const html = await tinyfishFetch([url], { format: "html", purpose: "read product listings for price comparison" });
    let rows = html.results[0] ? fromHtml(html.results[0].text, sold) : [];
    if (rows.length === 0) {
      const md = await tinyfishFetch([url], { format: "markdown", links: true, purpose: "read product listings for price comparison" });
      if (md.errors.length) throw new Error(`ebay via tinyfish: ${md.errors.map((e) => e.error).join(",")}`);
      rows = fromMarkdown(md.results[0].text, md.results[0].links ?? [], sold);
      (ebay as any).lastPath = "markdown";
    } else (ebay as any).lastPath = "html";
    return rows.filter((r) => r.title && !/Shop on eBay/i.test(r.title)).slice(0, limit);
  },
};
