import type {
  Catalog,
  ComparisonReport,
  Ledger,
  ListingFunnel,
  ListingId,
  Purchase,
  Review,
  SessionId,
  Trial,
  VendorFunnel,
  VendorId,
} from "../contracts/index.js";

export class MockLedger implements Ledger {
  private trials = new Map<string, Trial>();
  private purchases = new Map<string, Purchase>();
  private comparisons: ComparisonReport[] = [];
  private reviews: Review[] = [];
  private poolUsed = new Map<ListingId, number>();

  constructor(private catalog: Catalog) {}

  async createTrial(trial: Trial): Promise<void> {
    this.trials.set(trial.id, { ...trial });
  }

  async getTrial(id: string): Promise<Trial | null> {
    return this.trials.get(id) ?? null;
  }

  async getTrialByToken(token: string): Promise<Trial | null> {
    return [...this.trials.values()].find((t) => t.token === token) ?? null;
  }

  async updateTrial(id: string, patch: Partial<Trial>): Promise<Trial> {
    const t = this.trials.get(id);
    if (!t) throw new Error(`no trial ${id}`);
    Object.assign(t, patch);
    return { ...t };
  }

  async listTrials(session_id: SessionId): Promise<Trial[]> {
    return [...this.trials.values()].filter((t) => t.session_id === session_id);
  }

  async recordUsage(trial_id: string, amount: number) {
    const t = this.trials.get(trial_id);
    if (!t) throw new Error(`no trial ${trial_id}`);
    const pool = (await this.catalog.get(t.listing_id))?.trial;
    const poolUsed = (this.poolUsed.get(t.listing_id) ?? 0) + amount;
    this.poolUsed.set(t.listing_id, poolUsed);
    t.used += amount;
    const exhausted = t.used >= t.limit || (!!pool && poolUsed >= pool.pool_total);
    if (exhausted) t.status = "exhausted";
    return { used: t.used, limit: t.limit, exhausted };
  }

  async recordComparison(report: ComparisonReport): Promise<void> {
    this.comparisons.push(report);
  }

  async recordReview(review: Review): Promise<void> {
    this.reviews.push(review);
  }

  async recordPurchase(purchase: Purchase): Promise<void> {
    this.purchases.set(purchase.id, { ...purchase });
  }

  async updatePurchase(id: string, patch: Partial<Purchase>): Promise<Purchase> {
    const p = this.purchases.get(id);
    if (!p) throw new Error(`no purchase ${id}`);
    Object.assign(p, patch);
    return { ...p };
  }

  async listPurchases(session_id: SessionId): Promise<Purchase[]> {
    return [...this.purchases.values()].filter((p) => p.session_id === session_id);
  }

  async funnel(vendor_id: VendorId): Promise<VendorFunnel> {
    const listings: ListingFunnel[] = (await this.catalog.listByVendor(vendor_id)).map((l) => {
      const results = this.comparisons.flatMap((c) => c.results).filter((r) => r.listing_id === l.id);
      const reviews = this.reviews.filter((r) => r.listing_id === l.id);
      const paid = [...this.purchases.values()].filter((p) => p.listing_id === l.id && p.status === "paid");
      return {
        listing_id: l.id,
        trials: [...this.trials.values()].filter((t) => t.listing_id === l.id).length,
        checks_run: results.length,
        checks_passed: results.filter((r) => r.ok).length,
        chosen: reviews.filter((r) => r.verdict === "chosen").length,
        rejected: reviews.filter((r) => r.verdict === "rejected").length,
        purchases: paid.length,
        revenue_usd: paid.reduce((sum, p) => sum + p.amount_usd, 0),
        top_reasons: [...new Set(reviews.map((r) => r.reason))].slice(-3),
      };
    });
    return { vendor_id, listings };
  }
}
