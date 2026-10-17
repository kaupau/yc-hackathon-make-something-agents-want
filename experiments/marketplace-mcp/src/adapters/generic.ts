import { tinyfishFetch } from "../tinyfish.js";
import type { Adapter, Listing, SearchOptions } from "../types.js";

/**
 * Generic marketplace adapter: no site-specific code. A search URL template is
 * fetched through TinyFish as markdown + links, listings are recovered from the
 * text structure (a title line followed by a price line), and listing URLs are
 * the page's repeated item-link prefix, aligned by order.
 * Verified on Poshmark, Mercari and Vinted (2026-10-17).
 */
export interface GenericConfig { name: string; template: string; item_prefix: string; origin: string; added_at: string; sample_count: number }

const PRICE_LINE = /^\$\s?\d[\d,]*(?:\.\d\d)?(?:\s*\$\s?\d[\d,]*(?:\.\d\d)?)?$/;
const SIZE_LINE = /^(?:(?:XXS|XS|S|M|L|XL|XXL|XXXL|\d{1,2}(?:\.\d)?|One Size|Various sizes|OS)(?:\s*\/\s*US\s*[\d\-]+)?(?:\s*·\s*.+)?|US \d+)$/i;
const BADGE_LINE = /^(?:SOLD|Bumped|NEW|Sponsored|Ad|Free shipping|\d{1,2}%|\d+ (?:likes?|watchers?))$/i;
const CONDITION_WORDS = /(new with tags|new without tags|nwt|nwot|like new|very good|good|fair|satisfactory|pre-owned|used|gently used|brand new|new)/i;

export function parseListings(text: string, links: string[], itemPrefix: string, marketplace: string): Listing[] {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const itemLinks = [...new Set(links.filter((l) => l.includes(itemPrefix)))];
  const out: Listing[] = [];
  let block: string[] = [];
  for (const line of lines) {
    if (PRICE_LINE.test(line.replace(/\s+/g, ""))) {
      const prices = [...line.matchAll(/\$\s?([\d,]+(?:\.\d\d)?)/g)].map((m) => Number(m[1].replace(/,/g, "")));
      let title: string | null = null, size: string | null = null, condition: string | null = null;
      for (let i = block.length - 1; i >= 0; i--) {
        const b = block[i];
        if (BADGE_LINE.test(b)) continue;
        if (SIZE_LINE.test(b)) { size ??= b.split("·")[0].trim(); const c = b.match(CONDITION_WORDS); if (c) condition ??= c[1].toLowerCase(); continue; }
        if (b.length < 3) continue;
        title = b; break;
      }
      if (title) {
        const idx = out.length; const url = itemLinks[idx] ?? "";
        out.push({ marketplace, id: url ? url.split("?")[0].split("/").filter(Boolean).pop() ?? String(idx) : String(idx), title, price_usd: prices[0] ?? null, condition: condition ?? (title.match(CONDITION_WORDS)?.[1].toLowerCase() ?? null), url, image: null, size });
      }
      block = [];
    } else block.push(line);
    // size/condition can trail the price (Poshmark); attach to the previous listing
    if (out.length && block.length === 1 && SIZE_LINE.test(block[0]) && !out[out.length - 1].size) { out[out.length - 1].size = block[0].split("·")[0].trim(); block = []; }
  }
  return out.filter((l) => l.price_usd !== null);
}

/** The item-link prefix is the repeated path prefix whose count is closest to the number of price lines. */
export function guessItemPrefix(links: string[], origin: string, blocks: number): string | null {
  const counts = new Map<string, number>();
  for (const l of links) {
    let u: URL; try { u = new URL(l); } catch { continue; }
    if (u.origin !== origin) continue;
    const segs = u.pathname.split("/").filter(Boolean); if (segs.length < 2) continue;
    for (const n of [1, 2]) { if (segs.length > n) { const p = "/" + segs.slice(0, n).join("/") + "/"; counts.set(p, (counts.get(p) ?? 0) + 1); } }
  }
  const cands = [...counts.entries()].filter(([, c]) => c >= 5).sort((a, b) => Math.abs(a[1] - blocks) - Math.abs(b[1] - blocks));
  return cands[0]?.[0] ?? null;
}

export function makeGenericAdapter(cfg: GenericConfig): Adapter {
  return {
    name: cfg.name,
    via: `generic adapter (TinyFish render of ${cfg.template}); URLs aligned by order`,
    async search(query: string, opts: SearchOptions = {}) {
      const url = cfg.template.replace("{q}", encodeURIComponent(query));
      const r = await tinyfishFetch([url], { format: "markdown", links: true, purpose: "read product listings for price comparison" });
      if (r.errors.length) throw new Error(`${cfg.name}: ${r.errors[0].error}`);
      return parseListings(r.results[0].text, r.results[0].links ?? [], cfg.item_prefix, cfg.name).slice(0, opts.limit ?? 20);
    },
  };
}

const TEMPLATES = ["/search?q={q}", "/search?query={q}", "/search/?q={q}", "/search/?keyword={q}", "/search?keyword={q}", "/catalog?search_text={q}", "/s?k={q}", "/shop?query={q}", "/search?s={q}", "/search?keywords={q}"];

/** Try the common search URL shapes on a site, keep the one that yields the most parseable listings. */
export async function discover(input: string, probeQuery = "nike hoodie"): Promise<{ cfg: GenericConfig; sample: Listing[]; tried: { url: string; listings: number; relevance?: number; error?: string }[] }> {
  const u = new URL(input.startsWith("http") ? input : `https://${input}`);
  const origin = u.origin; const host = u.hostname.replace(/^www\./, "");
  const name = host.split(".")[0];
  const candidates = u.search && /\w/.test(u.search) ? [input.replace(/=([^&]+)/, "={q}")] : TEMPLATES.map((t) => origin + t);
  const urls = candidates.slice(0, 10).map((t) => t.replace("{q}", encodeURIComponent(probeQuery)));
  const r = await tinyfishFetch(urls, { format: "markdown", links: true, purpose: "find the search results page of a marketplace" });
  const tried: { url: string; listings: number; relevance?: number; error?: string }[] = [];
  let best: { cfg: GenericConfig; sample: Listing[]; n: number } | null = null;
  for (let i = 0; i < urls.length; i++) {
    const res = r.results.find((x) => x.url === urls[i]); const err = r.errors.find((x) => x.url === urls[i]);
    if (!res) { tried.push({ url: urls[i], listings: 0, error: err?.error ?? "no result" }); continue; }
    const priceLines = res.text.split("\n").filter((l) => PRICE_LINE.test(l.trim().replace(/\s+/g, ""))).length;
    const prefix = guessItemPrefix(res.links ?? [], origin, priceLines);
    const rows = prefix ? parseListings(res.text, res.links ?? [], prefix, name) : [];
    // relevance: share of titles containing a probe word; a shape that returns many unrelated items (Mercari ?keywords=) must lose to one that returns fewer relevant ones
    const toks = probeQuery.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const rel = rows.length ? rows.filter((r) => toks.some((t) => r.title.toLowerCase().includes(t))).length / rows.length : 0;
    const score = rows.length * (0.2 + rel);
    tried.push({ url: urls[i], listings: rows.length, relevance: Math.round(rel * 100) / 100 });
    if (rows.length >= 5 && rel >= 0.3 && (!best || score > best.n)) best = { n: score, sample: rows.slice(0, 5), cfg: { name, template: candidates[i], item_prefix: prefix!, origin, added_at: new Date().toISOString(), sample_count: rows.length } };
  }
  if (!best) throw new Error(`no search URL on ${host} yielded listings; tried ${tried.length} shapes: ${tried.map((t) => `${new URL(t.url).pathname}${new URL(t.url).search.split("=")[0]} (${t.error ?? t.listings})`).join(", ")}`);
  return { cfg: best.cfg, sample: best.sample, tried };
}
