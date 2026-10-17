import type { Catalog, Category, ComparisonReport, Ledger, Listing, ListingFunnel, Purchase, Review, Trial, VendorFunnel } from "../contracts/index.js";
import { LISTINGS } from "../mocks/seed.js";
import { DemoDatabase } from "./persistence.js";

const nonnegative = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
/** Explicit public-field projection keeps credential-shaped unknown input out of the catalog. */
export function publicListing(value: Listing): Listing {
  if (!value || !/^[a-z0-9][a-z0-9_-]{0,100}$/i.test(value.id) || !/^[a-z0-9][a-z0-9_-]{0,100}$/i.test(value.vendor_id)) throw new Error("Invalid listing identifiers");
  for (const name of ["name", "category", "one_line", "docs_url", "quickstart"] as const) if (typeof value[name] !== "string" || value[name].length > 16000) throw new Error(`Invalid listing ${name}`);
  for (const name of ["keywords", "checks", "adds_tools"] as const) if (!Array.isArray(value[name]) || !value[name].every(v => typeof v === "string")) throw new Error(`Invalid listing ${name}`);
  if (!nonnegative(value.price?.buy_usd) || typeof value.price.unit_label !== "string") throw new Error("Invalid listing price");
  if (value.trial && (![value.trial.per_agent, value.trial.pool_total, value.trial.pool_used, value.trial.max_concurrent].every(n => nonnegative(n) && Number.isSafeInteger(n)) || !nonnegative(value.trial.expires_after_min) || value.trial.expires_after_min <= 0 || value.trial.pool_used > value.trial.pool_total || !["api_calls", "sandbox_minutes", "runs"].includes(value.trial.unit))) throw new Error("Invalid trial policy");
  if (value.sandbox && (typeof value.sandbox.image !== "string" || !Array.isArray(value.sandbox.install) || !value.sandbox.install.every(x => typeof x === "string") || !value.sandbox.env_hint || !Object.values(value.sandbox.env_hint).every(x => typeof x === "string"))) throw new Error("Invalid sandbox setup");
  return structuredClone({ id: value.id, vendor_id: value.vendor_id, name: value.name, category: value.category, one_line: value.one_line, docs_url: value.docs_url, quickstart: value.quickstart, keywords: value.keywords, checks: value.checks, adds_tools: value.adds_tools, price: { buy_usd: value.price.buy_usd, unit_label: value.price.unit_label }, real: value.real === true, trial: value.trial ? { unit: value.trial.unit, per_agent: value.trial.per_agent, pool_total: value.trial.pool_total, pool_used: value.trial.pool_used, expires_after_min: value.trial.expires_after_min, max_concurrent: value.trial.max_concurrent } : null, sandbox: value.sandbox ? { image: value.sandbox.image, install: value.sandbox.install, env_hint: value.sandbox.env_hint } : null });
}

export class DurableCatalog implements Catalog {
  constructor(private db: DemoDatabase, publicUrl?: string) { for (const listing of LISTINGS) if (!db.get("listing", listing.id)) db.insert("listing", listing.id, publicListing(listing.id === "postpigeon-email" && publicUrl ? {...listing,docs_url:`${publicUrl}/postpigeon/docs`} : listing)); }
  async get(id: string): Promise<Listing | null> { return this.db.get("listing", id); }
  async listByVendor(vendor_id: string): Promise<Listing[]> { return this.db.list<Listing>("listing").filter(l => l.vendor_id === vendor_id); }
  async search(query: string, opts: { category?: Category; limit?: number } = {}): Promise<Listing[]> {
    const words = query.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return this.db.list<Listing>("listing").filter(l => !opts.category || l.category === opts.category).map(l => ({ l, score: words.filter(w => [l.name, l.category, l.one_line, ...l.keywords].join(" ").toLowerCase().includes(w)).length })).filter(x => !words.length || x.score > 0).sort((a,b) => b.score-a.score).slice(0, Math.max(0, Math.min(opts.limit ?? 5, 100))).map(x => x.l);
  }
  async upsert(listing: Listing): Promise<void> {
    this.db.transaction(() => {
      const clean = publicListing(listing);
      const old = this.db.get<Listing>("listing", listing.id);
      if (old && old.vendor_id !== clean.vendor_id) throw new Error("Cannot change listing vendor");
      if (old?.trial && clean.trial) clean.trial.pool_used = old.trial.pool_used;
      if (old?.trial?.pool_used && !clean.trial) throw new Error("Cannot remove a funded trial policy after use");
      if (clean.trial && clean.trial.pool_total < clean.trial.pool_used) throw new Error("Pool cannot be smaller than consumed usage");
      this.db.put("listing", clean.id, clean);
    });
  }
}

export class QuotaExceededError extends Error { readonly code = "QUOTA_EXCEEDED"; constructor(message = "Trial or vendor quota exhausted") { super(message); this.name = "QuotaExceededError"; } }

export class DurableLedger implements Ledger {
  constructor(private db: DemoDatabase, private now: () => number) {}
  async createTrial(trial: Trial): Promise<void> {
    this.db.transaction(() => {
      const listing = this.db.get<Listing>("listing", trial.listing_id);
      if (!listing?.trial || !Number.isSafeInteger(trial.limit) || trial.limit <= 0 || trial.limit > listing.trial.per_agent || trial.used !== 0 || !trial.token || !Number.isFinite(Date.parse(trial.expires_at)) || Date.parse(trial.expires_at) <= this.now()) throw new Error("Invalid trial or policy");
      if (this.db.list<Trial>("trial").some(t => t.token === trial.token)) throw new Error("Duplicate trial token");
      const active = this.db.list<Trial>("trial").filter(t => t.listing_id === trial.listing_id && ["active", "provisioning"].includes(t.status) && Date.parse(t.expires_at) > this.now());
      if (active.length >= listing.trial.max_concurrent) throw new Error("Vendor concurrent trial limit reached");
      // The allowance applies to the whole agent session, including ended trials.
      if (this.db.list<Trial>("trial").filter(t => t.listing_id === trial.listing_id && t.session_id === trial.session_id).reduce((n,t) => n+t.limit, 0) + trial.limit > listing.trial.per_agent) throw new Error("Session trial allowance already allocated");
      if (listing.trial.pool_used >= listing.trial.pool_total) throw new QuotaExceededError();
      this.db.insert("trial", trial.id, trial);
    });
  }
  async getTrial(id: string): Promise<Trial | null> { return this.db.get("trial", id); }
  async getTrialByToken(token: string): Promise<Trial | null> { return this.db.list<Trial>("trial").find(t => t.token === token) ?? null; }
  async listTrials(session_id: string): Promise<Trial[]> { return this.db.list<Trial>("trial").filter(t => t.session_id === session_id); }
  async updateTrial(id: string, patch: Partial<Trial>): Promise<Trial> {
    return this.db.transaction(() => {
      const trial = this.db.get<Trial>("trial", id); if (!trial) throw new Error("Unknown trial");
      for (const field of ["id", "session_id", "listing_id", "token", "used", "limit", "unit", "expires_at", "started_at"] as const) if (patch[field] !== undefined && patch[field] !== trial[field]) throw new Error(`Trial ${field} is immutable; use recordUsage`);
      if (patch.status && patch.status !== trial.status && ((["ended", "expired"].includes(trial.status)) || (trial.status === "exhausted" && !["ended", "expired"].includes(patch.status)))) throw new Error("Terminal trial cannot be reactivated");
      const next = { ...trial, ...patch }; this.db.put("trial", id, next); return next;
    });
  }
  async recordUsage(id: string, amount: number): Promise<{ used: number; limit: number; exhausted: boolean }> {
    if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error("Usage must be a positive integer");
    return this.db.transaction(() => {
      const t = this.db.get<Trial>("trial", id); if (!t) throw new Error("Unknown trial");
      const l = this.db.get<Listing>("listing", t.listing_id);
      if (t.status !== "active" || Date.parse(t.expires_at) <= this.now()) throw new QuotaExceededError("Trial inactive or expired");
      if (!l?.trial || amount > t.limit-t.used || amount > l.trial.pool_total-l.trial.pool_used) throw new QuotaExceededError();
      t.used += amount; l.trial.pool_used += amount;
      const exhausted = t.used >= t.limit || l.trial.pool_used >= l.trial.pool_total;
      if (exhausted) t.status = "exhausted";
      this.db.put("trial", id, t); this.db.put("listing", l.id, l);
      return { used: t.used, limit: t.limit, exhausted };
    });
  }
  async recordComparison(r: ComparisonReport): Promise<void> { this.idempotent("comparison", r.id, r); }
  async recordReview(r: Review): Promise<void> { this.idempotent("review", r.id, r); }
  async recordPurchase(p: Purchase): Promise<void> { this.idempotent("purchase", p.id, p); }
  private idempotent(kind: string, id: string, value: unknown): void { const old = this.db.get(kind, id); if (old) { if (JSON.stringify(old) !== JSON.stringify(value)) throw new Error(`Conflicting ${kind} id`); return; } this.db.insert(kind, id, value); }
  async updatePurchase(id: string, patch: Partial<Purchase>): Promise<Purchase> {
    return this.db.transaction(() => { const p = this.db.get<Purchase>("purchase", id); if (!p) throw new Error("Unknown purchase"); for (const field of ["id", "listing_id", "session_id", "amount_usd", "created_at"] as const) if (patch[field] !== undefined && patch[field] !== p[field]) throw new Error(`Purchase ${field} is immutable`); if (p.status === "paid" && patch.status && patch.status !== "paid") throw new Error("Cannot overwrite paid purchase"); const next = { ...p, ...patch }; this.db.put("purchase", id, next); return next; });
  }
  async listPurchases(session_id: string): Promise<Purchase[]> { return this.db.list<Purchase>("purchase").filter(p => p.session_id === session_id); }
  async funnel(vendor_id: string): Promise<VendorFunnel> {
    const listings: ListingFunnel[] = this.db.list<Listing>("listing").filter(l => l.vendor_id === vendor_id).map(l => {
      const results = this.db.list<ComparisonReport>("comparison").flatMap(c => c.results).filter(r => r.listing_id === l.id);
      const reviews = this.db.list<Review>("review").filter(r => r.listing_id === l.id);
      const paid = this.db.list<Purchase>("purchase").filter(p => p.listing_id === l.id && p.status === "paid");
      const reasons = new Map<string, number>(); for (const r of reviews) reasons.set(r.reason, (reasons.get(r.reason) ?? 0)+1);
      return { listing_id: l.id, trials: this.db.list<Trial>("trial").filter(t => t.listing_id === l.id).length, checks_run: results.length, checks_passed: results.filter(r => r.ok).length, chosen: reviews.filter(r => r.verdict === "chosen").length, rejected: reviews.filter(r => r.verdict === "rejected").length, purchases: paid.length, revenue_usd: Math.round(paid.reduce((s,p) => s+p.amount_usd, 0)*100)/100, top_reasons: [...reasons].sort((a,b) => b[1]-a[1]).slice(0,3).map(([reason]) => reason) };
    }); return { vendor_id, listings };
  }
}
