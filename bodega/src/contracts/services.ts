// Cross-stream interfaces. Each stream exports a factory returning its implementation;
// A's main.ts composes real or mock per component via BODEGA_MOCK=catalog,runtime,...

import type {
  ApprovalStatus,
  Category,
  CheckId,
  ComparisonReport,
  Lease,
  Listing,
  ListingId,
  Purchase,
  Review,
  RunRequest,
  RunResult,
  SessionId,
  Trial,
  UpstreamConfig,
  VendorFunnel,
  VendorId,
} from "./types.js";

/** C provides, A uses. */
export interface Catalog {
  search(query: string, opts?: { category?: Category; limit?: number }): Promise<Listing[]>;
  get(id: ListingId): Promise<Listing | null>;
  listByVendor(vendor_id: VendorId): Promise<Listing[]>; // vendor portal + funnel
  upsert(listing: Listing): Promise<void>; // vendor portal
}

/** C provides, B uses. The only holder of real vendor credentials. */
export interface Vault {
  upstream(listing_id: ListingId): Promise<UpstreamConfig>;
  /** pooled_key: returns the pooled key. provision_webhook: asks the vendor to mint a scoped key. */
  lease(listing_id: ListingId, trial_id: string): Promise<Lease>;
  revoke(trial_id: string): Promise<void>;
}

/** C provides, A and B use. Durable record of everything the funnel is built from. */
export interface Ledger {
  createTrial(trial: Trial): Promise<void>;
  getTrial(id: string): Promise<Trial | null>;
  getTrialByToken(token: string): Promise<Trial | null>; // proxy looks trials up by token
  updateTrial(id: string, patch: Partial<Trial>): Promise<Trial>;
  listTrials(session_id: SessionId): Promise<Trial[]>;
  /** Atomically counts usage against the trial and the vendor's pool. */
  recordUsage(trial_id: string, amount: number): Promise<{ used: number; limit: number; exhausted: boolean }>;
  recordComparison(report: ComparisonReport): Promise<void>;
  recordReview(review: Review): Promise<void>;
  recordPurchase(purchase: Purchase): Promise<void>;
  updatePurchase(id: string, patch: Partial<Purchase>): Promise<Purchase>;
  listPurchases(session_id: SessionId): Promise<Purchase[]>;
  funnel(vendor_id: VendorId): Promise<VendorFunnel>;
}

/** C provides, A uses. Over-threshold buys wait here for the human. */
export interface Approvals {
  request(purchase: Purchase, human_email: string): Promise<{ approve_url: string }>;
  status(purchase_id: string): Promise<ApprovalStatus>;
}

/** B provides, A uses. */
export interface TrialRuntime {
  start(listing: Listing, session_id: SessionId): Promise<Trial>;
  run(req: RunRequest): Promise<RunResult>;
  compare(listing_ids: ListingId[], check_id: CheckId, session_id: SessionId): Promise<ComparisonReport>;
  end(trial_id: string): Promise<void>;
}

export interface Services {
  catalog: Catalog;
  vault: Vault;
  ledger: Ledger;
  approvals: Approvals;
  runtime: TrialRuntime;
}
