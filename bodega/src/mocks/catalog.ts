import type { Catalog, Category, Listing, ListingId, VendorId } from "../contracts/index.js";
import { LISTINGS } from "./seed.js";

export class MockCatalog implements Catalog {
  private listings = new Map<ListingId, Listing>(LISTINGS.map((l) => [l.id, structuredClone(l)]));

  async search(query: string, opts: { category?: Category; limit?: number } = {}): Promise<Listing[]> {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    const scored = [...this.listings.values()]
      .filter((l) => !opts.category || l.category === opts.category)
      .map((l) => {
        const hay = [l.name, l.category, l.one_line, ...l.keywords].join(" ").toLowerCase();
        return { l, score: words.filter((w) => hay.includes(w)).length };
      })
      .filter((s) => s.score > 0)
      // Best match first; among equals, listings with a trial first.
      .sort((a, b) => b.score - a.score || Number(!!b.l.trial) - Number(!!a.l.trial));
    return scored.slice(0, opts.limit ?? 5).map((s) => s.l);
  }

  async get(id: ListingId): Promise<Listing | null> {
    return this.listings.get(id) ?? null;
  }

  async listByVendor(vendor_id: VendorId): Promise<Listing[]> {
    return [...this.listings.values()].filter((l) => l.vendor_id === vendor_id);
  }

  async upsert(listing: Listing): Promise<void> {
    this.listings.set(listing.id, structuredClone(listing));
  }
}
