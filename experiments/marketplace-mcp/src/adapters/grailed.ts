import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { context } from "../browser.js";
import type { Adapter, Listing, Review, SearchOptions } from "../types.js";

/**
 * Grailed is a Next.js app over Algolia. The search index is public but the
 * search-only key is "secured" (expires hourly) and minted by
 * POST /api/algolia/keys behind Cloudflare, so a real browser refreshes it.
 * Indices seen in the bundle: Listing_production, Listing_sold_production,
 * Listing_by_low_price_production, Listing_by_date_added_production, ...
 */
const APP_ID = "MNRWEFSS2Q";
const KEY_FILE = ".cache/grailed-key.json";
type Key = { search_key: string; expires_at: string };
let cached: Key | null = null;

async function key(): Promise<string> {
  const fresh = (k: Key | null) => k && Date.parse(k.expires_at) - Date.now() > 60_000;
  if (!cached) { try { cached = JSON.parse(readFileSync(KEY_FILE, "utf8")); } catch {} }
  if (fresh(cached)) return cached!.search_key;
  const page = await (await context()).newPage();
  try {
    const resP = page.waitForResponse((r) => r.url().includes("/api/algolia/keys") && r.status() === 200, { timeout: 30_000 });
    await page.goto("https://www.grailed.com/shop?query=jacket", { waitUntil: "domcontentloaded", timeout: 30_000 });
    const body = await (await resP).json();
    cached = { search_key: body.data.search_key, expires_at: body.data.expires_at };
    mkdirSync(".cache", { recursive: true }); writeFileSync(KEY_FILE, JSON.stringify(cached));
    return cached.search_key;
  } finally { await page.close(); }
}

const CONDITION: Record<string, string> = { is_new: "new", is_gently_used: "gently used", is_used: "used", is_worn: "worn", is_not_specified: "unspecified" };

function toListing(h: any): Listing {
  return {
    marketplace: "grailed", id: String(h.id), title: h.title,
    price_usd: h.sold ? (h.sold_price ?? h.price ?? null) : (h.price ?? null),
    condition: CONDITION[h.condition] ?? h.condition ?? null,
    url: `https://www.grailed.com/listings/${h.id}`,
    image: h.cover_photo?.image_url ?? null,
    location: h.location ?? null, size: h.size ?? null,
    brand: h.designers?.[0]?.name ?? h.designer_names ?? null,
    sold: !!h.sold, sold_price_usd: h.sold ? h.sold_price ?? null : null,
    posted_at: h.created_at ?? null,
  };
}

export async function grailedQuery(index: string, query: string, hitsPerPage: number, extra = "") {
  const r = await fetch(`https://${APP_ID.toLowerCase()}-dsn.algolia.net/1/indexes/${index}/query`, {
    method: "POST",
    headers: { "x-algolia-application-id": APP_ID, "x-algolia-api-key": await key(), "content-type": "application/json" },
    body: JSON.stringify({ params: `query=${encodeURIComponent(query)}&hitsPerPage=${hitsPerPage}${extra}` }),
  });
  if (!r.ok) throw new Error(`grailed algolia ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return (await r.json()) as { hits: any[]; nbHits: number };
}

// Browser-side: find the listing object inside Next.js page data (kept as a string, see amazon.ts for why)
const ITEM_SCRIPT = (id: string) => `(() => {
  const el = document.getElementById("__NEXT_DATA__"); if (!el) return null;
  const root = JSON.parse(el.textContent || "{}");
  let hit = null;
  const walk = (o, depth) => { if (hit || !o || typeof o !== "object" || depth > 10) return; if (String(o.id) === "${id}" && o.title && ("price" in o)) { hit = o; return; } for (const k of Object.keys(o)) walk(o[k], depth + 1); };
  walk(root, 0);
  if (!hit) return null;
  const u = hit.seller || hit.user || {};
  return { title: hit.title, price: hit.price, description: hit.description, condition: hit.condition, size: hit.size, sold: hit.sold, sold_price: hit.sold_price, location: hit.location, shipping: hit.shipping, photos: (hit.photos || []).slice(0, 4).map((p) => p.image_url || p.url), created_at: hit.created_at, seller: { id: u.id, username: u.username, seller_score: u.seller_score, total_bought_and_sold: u.total_bought_and_sold, location: u.location }, designers: (hit.designers || []).map((d) => d.name) };
})()`;

export const grailed: Adapter = {
  name: "grailed",
  via: "algolia index (live), key refreshed hourly via headless browser; item() reads the listing page data + seller ratings",
  async item(id: string) {
    const page = await (await context()).newPage();
    let ratings: any = null;
    page.on("response", async (r) => { if (/\/api\/users\/\d+\/seller_ratings/.test(r.url()) && r.status() === 200) { try { ratings = await r.json(); } catch {} } });
    try {
      await page.goto(`https://www.grailed.com/listings/${id}`, { waitUntil: "domcontentloaded", timeout: 45_000 });
      await page.waitForSelector("#__NEXT_DATA__", { state: "attached", timeout: 15_000 });
      await page.waitForResponse((r) => /seller_ratings/.test(r.url()), { timeout: 10_000 }).catch(() => {});
      const d: any = await page.evaluate(ITEM_SCRIPT(id));
      if (!d) throw new Error(`grailed listing ${id}: page data not found (removed or blocked)`);
      const listing: Listing = { marketplace: "grailed", id, title: d.title, price_usd: d.sold ? d.sold_price ?? d.price : d.price, condition: CONDITION[d.condition] ?? d.condition ?? null, url: `https://www.grailed.com/listings/${id}`, image: d.photos?.[0] ?? null, size: d.size ?? null, brand: d.designers?.[0] ?? null, sold: !!d.sold, location: d.location ?? null, seller: d.seller?.username ?? null, posted_at: d.created_at ?? null, rating: d.seller?.seller_score?.rating_average ?? null, review_count: d.seller?.seller_score?.rating_count ?? null };
      const list: any[] = ratings?.data ?? ratings?.seller_ratings ?? (Array.isArray(ratings) ? ratings : []);
      const reviews: Review[] = list.slice(0, 8).map((r: any) => ({ rating: r.rating ?? r.score ?? null, body: r.body ?? r.comment ?? r.text ?? "", author: r.rater?.username ?? r.user?.username ?? null, date: r.created_at ?? null }));
      return { listing, description: d.description ?? null, reviews, photos: (d.photos ?? []).filter(Boolean) };
    } finally { await page.close(); }
  },
  async search(query: string, opts: SearchOptions = {}) {
    const limit = opts.limit ?? 20;
    const index = opts.sold ? "Listing_sold_production" : "Listing_production";
    const { hits } = await grailedQuery(index, query, limit);
    return hits.map(toListing);
  },
};
