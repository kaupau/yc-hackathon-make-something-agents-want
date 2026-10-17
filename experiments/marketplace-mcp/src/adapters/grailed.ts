import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { context } from "../browser.js";
import type { Adapter, Listing, SearchOptions } from "../types.js";

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

export const grailed: Adapter = {
  name: "grailed",
  via: "algolia index (live), key refreshed hourly via headless browser",
  async search(query: string, opts: SearchOptions = {}) {
    const limit = opts.limit ?? 20;
    const index = opts.sold ? "Listing_sold_production" : "Listing_production";
    const { hits } = await grailedQuery(index, query, limit);
    return hits.map(toListing);
  },
};
