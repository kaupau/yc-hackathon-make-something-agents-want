export type Marketplace = "ebay" | "grailed" | "amazon" | (string & {});

/** One normalized listing, the shape every adapter returns and every tool emits. Kept small on purpose: agents pay per token. */
export interface Listing {
  marketplace: Marketplace;
  id: string;
  title: string;
  price_usd: number | null;
  condition: string | null;
  url: string;
  image: string | null;
  seller?: string | null;
  location?: string | null;
  shipping_usd?: number | null;
  rating?: number | null;
  review_count?: number | null;
  sold?: boolean;
  sold_price_usd?: number | null;
  posted_at?: string | null;
  size?: string | null;
  brand?: string | null;
  sponsored?: boolean;
}

export interface SearchOptions {
  limit?: number;
  /** include sold/completed listings when the marketplace exposes them (price comps) */
  sold?: boolean;
}

export interface Review {
  rating: number | null;
  title?: string | null;
  body: string;
  author?: string | null;
  date?: string | null;
}

export interface Adapter {
  name: Marketplace;
  /** how this adapter reaches the site; surfaced to the agent so it knows the freshness/trust of the data */
  via: string;
  search(query: string, opts?: SearchOptions): Promise<Listing[]>;
  item?(id: string): Promise<{ listing: Listing; description?: string | null; reviews?: Review[]; photos?: string[] }>;
}

export const money = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
};

export type Tier = "new" | "like_new" | "used" | "poor";
/** Normalize marketplace condition wording into four tiers so comps compare like with like. */
export const tier = (cond: string | null | undefined, title = ""): Tier => {
  const t = `${cond ?? ""} ${title}`.toLowerCase();
  if (/parts|as.?is|for repair|damaged|worn|heavy wear|satisfactory|fair\b|poor|read desc/.test(t)) return "poor";
  if (/brand new|new with tags|nwt|new without tags|nwot|\bnew\b|unworn|deadstock|\bds\b|sealed/.test(t)) return "new";
  if (/like new|gently used|excellent|very good|mint|barely/.test(t)) return "like_new";
  return "used";
};
/** Seller-side fee share when reselling on a venue (platform + payment), 2026 public rates, approximate. */
export const FEES: Record<string, number> = { poshmark: 0.2, mercari: 0.13, ebay: 0.136, grailed: 0.12, vinted: 0.0, amazon: 0.15, depop: 0.13 };
