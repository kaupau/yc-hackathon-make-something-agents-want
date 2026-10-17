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
  item?(id: string): Promise<{ listing: Listing; description?: string | null; reviews?: Review[] }>;
}

export const money = (s: string | null | undefined): number | null => {
  if (!s) return null;
  const m = s.replace(/,/g, "").match(/(\d+(?:\.\d{1,2})?)/);
  return m ? Number(m[1]) : null;
};
