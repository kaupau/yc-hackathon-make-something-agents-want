// Shared, authoritative vendor backend on InsForge (BODEGA_VENDOR_BACKEND=insforge).
//
// Every read and write goes through server-only RPC functions defined in
// migrations/20261017213502_shared-vendors.sql. Each RPC is one database transaction, so quota admission,
// usage metering, approval decisions and lease revocation are atomic across all replicas.
//
// Secrets: trial tokens, approval tokens and PostPigeon scoped keys only ever reach the database as SHA-256
// hashes. Pooled upstream keys stay in server env. External webhook leases are sealed with AES-256-GCM using
// a key derived from BODEGA_VENDOR_KEY_SECRET, which never leaves this process.
import { createAdminClient } from "@insforge/sdk";
import { createCipheriv, createDecipheriv, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import type { ApprovalStatus, Approvals, Catalog, Category, CheckResult, ComparisonReport, Lease, Ledger, Listing, ListingFunnel, Purchase, Review, Trial, UpstreamConfig, Vault, VendorFunnel } from "../contracts/index.js";
import { LISTINGS, VENDORS } from "../mocks/seed.js";
import { QuotaExceededError, publicListing } from "./data.js";
import { createVendorRoutes, type ApprovalView, type NotificationOutbox, type NotificationView } from "./routes.js";
import { hash, opaque, vendorUpstreams, type ApprovalMessage } from "./security.js";

/** Test seam: same shape as `createAdminClient(...).database.rpc(fn, args)`. */
export type VendorRpc = (fn: string, args: Record<string, unknown>) => PromiseLike<{ data: unknown; error: unknown }>;

export interface SharedVendorServicesOptions {
  /** Defaults to env INSFORGE_URL / INSFORGE_API_KEY. The API key is a full-access admin key: server only. */
  url?: string;
  apiKey?: string;
  /** Inject an RPC transport (tests, or an already-constructed admin client). */
  rpc?: VendorRpc;
  publicUrl?: string;
  adminToken?: string;
  env?: NodeJS.ProcessEnv;
  upstreams?: UpstreamConfig[];
  approvalTtlMs?: number;
  /** Root-owned delivery callback. Receives the approval URL in memory only; it is never persisted. */
  deliverApproval?: (message: ApprovalMessage) => Promise<void>;
  fetcher?: typeof fetch;
  /** Defaults to env BODEGA_VENDOR_KEY_SECRET (>= 32 bytes). Must be identical on every replica. */
  keySecret?: string;
  /** Global live-trial cap; defaults to env BODEGA_MAX_ACTIVE_TRIALS. null = no global cap. */
  maxActiveTrials?: number | null;
  /** Insert missing seed listings at startup (never overwrites). Default true. */
  seed?: boolean;
}

export class SharedVendorError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = "SharedVendorError"; }
}

const UNAVAILABLE = "Shared vendor backend unavailable";
const LEASE_TTL_MS = 30 * 60_000;
const POSTPIGEON = "postpigeon-email";

type Ok<T> = T & { ok: true };
async function call<T extends object>(rpc: VendorRpc, fn: string, p: Record<string, unknown>): Promise<Ok<T>> {
  let result: { data: unknown; error: unknown };
  // Transport errors may echo request bodies; never surface them (they can contain hashes or sealed blobs).
  try { result = await rpc(fn, { p }); } catch { throw new SharedVendorError("unavailable", UNAVAILABLE); }
  if (result.error || !result.data || typeof result.data !== "object") throw new SharedVendorError("unavailable", UNAVAILABLE);
  const data = result.data as { ok?: unknown; code?: unknown; message?: unknown };
  if (data.ok === true) return data as Ok<T>;
  const code = typeof data.code === "string" ? data.code : "unavailable";
  const message = typeof data.message === "string" && data.message.length <= 200 ? data.message : UNAVAILABLE;
  if (code === "quota_exceeded") throw new QuotaExceededError(message);
  throw new SharedVendorError(code, message);
}

const iso = (value: unknown): string => {
  const ms = Date.parse(String(value));
  if (!Number.isFinite(ms)) throw new SharedVendorError("invalid", "Invalid timestamp");
  return new Date(ms).toISOString();
};
const str = (value: unknown, name: string, max = 200): string => {
  if (typeof value !== "string" || !value || value.length > max) throw new SharedVendorError("invalid", `Invalid ${name}`);
  return value;
};
const safeInt = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value);
/** Canonical JSON (sorted keys) so idempotency digests are stable across replicas. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical((value as Record<string, unknown>)[k])}`).join(",")}}`;
  return JSON.stringify(value ?? null);
}
export function parseMaxActiveTrials(env: NodeJS.ProcessEnv): number | null {
  if (!env.BODEGA_MAX_ACTIVE_TRIALS) return null;
  const maxActive = Number(env.BODEGA_MAX_ACTIVE_TRIALS);
  if (!Number.isSafeInteger(maxActive) || maxActive < 1) throw new Error("Invalid global trial limit");
  return maxActive;
}

// ---------------------------------------------------------------------------------------------------------
// Key material
// ---------------------------------------------------------------------------------------------------------

export interface VendorKeys { scopedKeyMac: Buffer; leaseSeal: Buffer }
export function deriveVendorKeys(secret: string | undefined): VendorKeys {
  if (typeof secret !== "string" || Buffer.byteLength(secret, "utf8") < 32) throw new Error("BODEGA_VENDOR_KEY_SECRET must be set to at least 32 bytes for the shared vendor backend");
  const derive = (info: string) => Buffer.from(hkdfSync("sha256", Buffer.from(secret, "utf8"), Buffer.from("bodega-vendor-v1"), Buffer.from(info), 32));
  return { scopedKeyMac: derive("postpigeon-scoped-key"), leaseSeal: derive("webhook-lease-seal") };
}
function sealLease(key: Buffer, lease_id: string, listing_id: string, secret: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(Buffer.from(`bodega-lease-v1\0${lease_id}\0${listing_id}`));
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64url")}.${cipher.getAuthTag().toString("base64url")}.${ct.toString("base64url")}`;
}
function unsealLease(key: Buffer, lease_id: string, listing_id: string, sealed: unknown): string {
  const parts = typeof sealed === "string" ? sealed.split(".") : [];
  if (parts.length !== 4 || parts[0] !== "v1") throw new SharedVendorError("unavailable", "Lease unavailable");
  try {
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(parts[1], "base64url"));
    decipher.setAAD(Buffer.from(`bodega-lease-v1\0${lease_id}\0${listing_id}`));
    decipher.setAuthTag(Buffer.from(parts[2], "base64url"));
    return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64url")), decipher.final()]).toString("utf8");
  } catch { throw new SharedVendorError("unavailable", "Lease unavailable"); }
}

// ---------------------------------------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------------------------------------

export class SharedCatalog implements Catalog {
  constructor(private rpc: VendorRpc) {}
  async get(id: string): Promise<Listing | null> {
    const r = await call<{ listing: Listing | null }>(this.rpc, "bodega_vendor_listing_get", { id });
    return r.listing ? publicListing(r.listing) : null;
  }
  async listByVendor(vendor_id: string): Promise<Listing[]> {
    const r = await call<{ listings: Listing[] }>(this.rpc, "bodega_vendor_listing_by_vendor", { vendor_id, limit: 200 });
    return r.listings.map(publicListing);
  }
  async search(query: string, opts: { category?: Category; limit?: number } = {}): Promise<Listing[]> {
    const words = [...new Set(String(query).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean))].slice(0, 32);
    const limit = Math.max(0, Math.min(Math.trunc(opts.limit ?? 5) || 0, 100));
    const r = await call<{ listings: Listing[] }>(this.rpc, "bodega_vendor_listing_search", { words, category: opts.category ?? null, limit });
    return r.listings.map(publicListing);
  }
  async upsert(listing: Listing): Promise<void> {
    await call(this.rpc, "bodega_vendor_listing_upsert", { listing: publicListing(listing), seed_only: false });
  }
  /** Inserts listings that do not exist yet; never overwrites shared state (pool usage, vendor edits). */
  async seed(listings: Listing[]): Promise<void> {
    for (const listing of listings) await call(this.rpc, "bodega_vendor_listing_upsert", { listing: publicListing(listing), seed_only: true });
  }
}

// ---------------------------------------------------------------------------------------------------------
// Ledger
// ---------------------------------------------------------------------------------------------------------

interface TrialRow { id: string; listing_id: string; session_id: string; sandbox_id: string | null; status: Trial["status"]; used: number; limit: number; unit: Trial["unit"]; started_at: string; expires_at: string }
interface PurchaseRow { id: string; listing_id: string; session_id: string; amount_usd: number; status: Purchase["status"]; receipt_id?: string; created_at: string }

/** Trial tokens are stored hashed. Only getTrialByToken echoes the caller's own token; other reads return "". */
function toTrial(row: TrialRow, token = ""): Trial {
  return { id: row.id, listing_id: row.listing_id, session_id: row.session_id, sandbox_id: row.sandbox_id ?? null, status: row.status, used: Number(row.used), limit: Number(row.limit), unit: row.unit, token, started_at: iso(row.started_at), expires_at: iso(row.expires_at) };
}
function toPurchase(row: PurchaseRow): Purchase {
  return { id: row.id, listing_id: row.listing_id, session_id: row.session_id, amount_usd: Number(row.amount_usd), status: row.status, ...(row.receipt_id ? { receipt_id: row.receipt_id } : {}), created_at: iso(row.created_at) };
}
const TRIAL_STATUSES = ["provisioning", "active", "exhausted", "expired", "ended"];
const PURCHASE_STATUSES = ["paid", "needs_approval", "declined", "ready", "charging", "pending"];

export class SharedLedger implements Ledger {
  constructor(private rpc: VendorRpc, private maxActive: number | null = null) {}

  async createTrial(trial: Trial): Promise<void> {
    if (!trial || !safeInt(trial.limit) || trial.limit <= 0 || trial.used !== 0 || typeof trial.token !== "string" || !trial.token || trial.token.length > 500 || !Number.isFinite(Date.parse(trial.expires_at)) || !Number.isFinite(Date.parse(trial.started_at)) || !TRIAL_STATUSES.includes(trial.status)) throw new Error("Invalid trial or policy");
    if (trial.sandbox_id !== null && typeof trial.sandbox_id !== "string") throw new Error("Invalid trial or policy");
    await call(this.rpc, "bodega_vendor_trial_create", {
      trial: { id: str(trial.id, "trial id"), listing_id: str(trial.listing_id, "listing id"), session_id: str(trial.session_id, "session id"), sandbox_id: trial.sandbox_id, status: trial.status, used: 0, limit: trial.limit, unit: trial.unit, token_hash: hash(trial.token), started_at: iso(trial.started_at), expires_at: iso(trial.expires_at) },
      max_active: this.maxActive,
    });
  }
  async getTrial(id: string): Promise<Trial | null> {
    if (typeof id !== "string" || !id || id.length > 200) return null;
    const r = await call<{ trial: TrialRow | null }>(this.rpc, "bodega_vendor_trial_get", { id });
    return r.trial ? toTrial(r.trial) : null;
  }
  async getTrialByToken(token: string): Promise<Trial | null> {
    if (typeof token !== "string" || !token || token.length > 500) return null;
    const r = await call<{ trial: TrialRow | null }>(this.rpc, "bodega_vendor_trial_get", { token_hash: hash(token) });
    return r.trial ? toTrial(r.trial, token) : null;
  }
  async listTrials(session_id: string): Promise<Trial[]> {
    const r = await call<{ trials: TrialRow[] }>(this.rpc, "bodega_vendor_trial_list", { session_id, limit: 500 });
    return r.trials.map(t => toTrial(t));
  }
  async updateTrial(id: string, patch: Partial<Trial>): Promise<Trial> {
    const mutable: Record<string, unknown> = {};
    const expect: Record<string, unknown> = {};
    if (patch.id !== undefined && patch.id !== id) throw new Error("Trial id is immutable; use recordUsage");
    if (patch.status !== undefined) { if (!TRIAL_STATUSES.includes(patch.status)) throw new Error("Invalid trial status"); mutable.status = patch.status; }
    if (patch.sandbox_id !== undefined) { if (patch.sandbox_id !== null && (typeof patch.sandbox_id !== "string" || patch.sandbox_id.length > 500)) throw new Error("Invalid sandbox id"); mutable.sandbox_id = patch.sandbox_id; }
    for (const field of ["session_id", "listing_id", "used", "limit", "unit"] as const) if (patch[field] !== undefined) expect[field] = patch[field];
    for (const field of ["started_at", "expires_at"] as const) if (patch[field] !== undefined) expect[field] = Number.isFinite(Date.parse(patch[field]!)) ? iso(patch[field]) : "invalid";
    if (patch.token !== undefined) expect.token_hash = hash(String(patch.token));
    for (const [field, value] of Object.entries(expect)) if (value === "invalid") throw new Error(`Trial ${field} is immutable; use recordUsage`);
    const r = await call<{ trial: TrialRow }>(this.rpc, "bodega_vendor_trial_update", { id, patch: mutable, expect });
    return toTrial(r.trial);
  }
  async recordUsage(trial_id: string, amount: number): Promise<{ used: number; limit: number; exhausted: boolean }> {
    if (!safeInt(amount) || amount <= 0) throw new Error("Usage must be a positive integer");
    const r = await call<{ used: number; limit: number; exhausted: boolean }>(this.rpc, "bodega_vendor_trial_usage", { id: trial_id, amount });
    return { used: Number(r.used), limit: Number(r.limit), exhausted: r.exhausted === true };
  }
  async recordComparison(report: ComparisonReport): Promise<void> {
    if (!Array.isArray(report?.results) || report.results.length > 64) throw new Error("Invalid comparison results");
    const comparison = { id: str(report.id, "comparison id"), check_id: str(report.check_id, "check id"), session_id: str(report.session_id, "session id"), suggestion: report.suggestion ?? null, reason: String(report.reason ?? ""), created_at: iso(report.created_at) };
    const results = report.results.map((r: CheckResult) => {
      if (typeof r.ok !== "boolean" || typeof r.loc !== "number" || !Number.isFinite(r.loc) || r.loc < 0 || !r.metrics || typeof r.metrics !== "object") throw new Error("Invalid comparison results");
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(r.metrics)) { if (typeof v !== "number" || !Number.isFinite(v)) throw new Error("Invalid comparison metrics"); metrics[k] = v; }
      return { listing_id: str(r.listing_id, "listing id"), trial_id: String(r.trial_id ?? ""), ok: r.ok, metrics, loc: Math.round(r.loc), error: r.error ?? null, logs_tail: String(r.logs_tail ?? "") };
    });
    await call(this.rpc, "bodega_vendor_comparison_record", { comparison, results, digest: hash(canonical({ comparison, results })) });
  }
  async recordReview(review: Review): Promise<void> {
    if (!Array.isArray(review?.compared_with) || !review.compared_with.every(x => typeof x === "string")) throw new Error("Invalid review");
    const normalized = { id: str(review.id, "review id", 400), listing_id: str(review.listing_id, "listing id"), session_id: str(review.session_id, "session id"), verdict: review.verdict, reason: String(review.reason ?? ""), compared_with: review.compared_with, source: review.source, created_at: iso(review.created_at) };
    await call(this.rpc, "bodega_vendor_review_record", { review: normalized, digest: hash(canonical(normalized)) });
  }
  /** approve_url and project_key are bearer secrets owned elsewhere; they are never persisted here. */
  async recordPurchase(p: Purchase): Promise<void> {
    if (!p || typeof p.amount_usd !== "number" || !Number.isFinite(p.amount_usd) || p.amount_usd < 0 || !PURCHASE_STATUSES.includes(p.status)) throw new Error("Invalid purchase");
    await call(this.rpc, "bodega_vendor_purchase_record", { purchase: { id: str(p.id, "purchase id"), listing_id: str(p.listing_id, "listing id"), session_id: str(p.session_id, "session id"), amount_usd: p.amount_usd, status: p.status, receipt_id: p.receipt_id ?? null, created_at: iso(p.created_at) } });
  }
  async updatePurchase(id: string, patch: Partial<Purchase>): Promise<Purchase> {
    if (patch.id !== undefined && patch.id !== id) throw new Error("Purchase id is immutable");
    const mutable: Record<string, unknown> = {};
    if (patch.status !== undefined) { if (!PURCHASE_STATUSES.includes(patch.status)) throw new Error("Invalid purchase status"); mutable.status = patch.status; }
    if (patch.receipt_id !== undefined) { if (typeof patch.receipt_id !== "string" || patch.receipt_id.length > 500) throw new Error("Invalid receipt id"); mutable.receipt_id = patch.receipt_id; }
    const expect: Record<string, unknown> = {};
    for (const field of ["listing_id", "session_id", "amount_usd"] as const) if (patch[field] !== undefined) expect[field] = patch[field];
    if (patch.created_at !== undefined) { if (!Number.isFinite(Date.parse(patch.created_at))) throw new Error("Purchase created_at is immutable"); expect.created_at = iso(patch.created_at); }
    const r = await call<{ purchase: PurchaseRow }>(this.rpc, "bodega_vendor_purchase_update", { id, patch: mutable, expect });
    return toPurchase(r.purchase);
  }
  async listPurchases(session_id: string): Promise<Purchase[]> {
    const r = await call<{ purchases: PurchaseRow[] }>(this.rpc, "bodega_vendor_purchase_list", { session_id, limit: 500 });
    return r.purchases.map(toPurchase);
  }
  async funnel(vendor_id: string): Promise<VendorFunnel> {
    const r = await call<{ funnel: VendorFunnel }>(this.rpc, "bodega_vendor_funnel", { vendor_id });
    return { vendor_id: r.funnel.vendor_id, listings: r.funnel.listings.map((l: ListingFunnel) => ({ listing_id: l.listing_id, trials: Number(l.trials), checks_run: Number(l.checks_run), checks_passed: Number(l.checks_passed), chosen: Number(l.chosen), rejected: Number(l.rejected), purchases: Number(l.purchases), revenue_usd: Number(l.revenue_usd), top_reasons: l.top_reasons.map(String) })) };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Approvals + notification outbox
// ---------------------------------------------------------------------------------------------------------

const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;
export class SharedApprovals implements Approvals {
  constructor(private rpc: VendorRpc, private baseUrl: string, private ttl: number, private deliver: ((message: ApprovalMessage) => Promise<void>) | undefined, private tokenKey: Buffer) {}
  async request(purchase: Purchase, human_email: string): Promise<{ approve_url: string }> {
    if (purchase?.status !== "needs_approval" || typeof human_email !== "string" || !human_email || human_email.length > 320 || /[\r\n]/.test(human_email)) throw new Error("Invalid approval request");
    const token = createHmac('sha256',this.tokenKey).update('approval/v1\0'+canonical([purchase.id,purchase.session_id,purchase.listing_id,purchase.amount_usd])).digest('base64url');
    const approve_url = `${this.baseUrl}/approve/${token}`;
    const subject = `Approve Bodega purchase: $${purchase.amount_usd.toFixed(2)}`;
    const notificationId = `ntf_approval_${hash(purchase.id)}`;
    await call(this.rpc, "bodega_vendor_approval_request", {
      purchase: { id: purchase.id, session_id: purchase.session_id, listing_id: purchase.listing_id, amount_usd: purchase.amount_usd },
      token_hash: hash(token), ttl_ms: this.ttl,
      notification: { id: notificationId, recipient: human_email, subject, status: this.deliver ? "pending" : "captured" },
    });
    if (this.deliver) {
      const message: ApprovalMessage = { purchase_id: purchase.id, to: human_email, subject, text: `Session ${purchase.session_id} requests ${purchase.listing_id} for $${purchase.amount_usd.toFixed(2)}. Review this expiring, one-use link: ${approve_url}`, approve_url };
      await call(this.rpc, "bodega_vendor_notification_mark", { id: notificationId, status: "sending" });
      try { await this.deliver(message); }
      catch {
        // The provider error may echo the message (and its URL); record only a fixed code.
        await call(this.rpc, "bodega_vendor_notification_mark", { id: notificationId, status: "failed", error: "delivery_failed" }).catch(() => undefined);
        throw new Error("Approval delivery failed; request approval again to issue a new link");
      }
      await call(this.rpc, "bodega_vendor_notification_mark", { id: notificationId, status: "sent" });
    }
    return { approve_url };
  }
  async status(purchase_id: string): Promise<ApprovalStatus> {
    const r = await call<{ status: ApprovalStatus }>(this.rpc, "bodega_vendor_approval_status", { purchase_id });
    return r.status === "approved" || r.status === "declined" ? r.status : "pending";
  }
  /** Read-only: safe to call from GET. */
  async inspect(token: string): Promise<ApprovalView | null> {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return null;
    const r = await call<{ approval: { purchase_id: string; session_id: string; listing_id: string; amount_usd: number; expires_at: string; status: string } | null }>(this.rpc, "bodega_vendor_approval_inspect", { token_hash: hash(token) });
    if (!r.approval) return null;
    return { ...r.approval, amount_usd: Number(r.approval.amount_usd), expires_at: Date.parse(r.approval.expires_at) };
  }
  /** Atomic, one-use. Returns false for unknown, expired, decided or rebound approvals. */
  async decide(token: string, status: "approved" | "declined"): Promise<boolean> {
    if (typeof token !== "string" || !TOKEN_RE.test(token) || (status !== "approved" && status !== "declined")) return false;
    const r = await call<{ decided: boolean }>(this.rpc, "bodega_vendor_approval_decide", { token_hash: hash(token), decision: status });
    return r.decided === true;
  }
}

export class SharedNotifications implements NotificationOutbox {
  constructor(private rpc: VendorRpc) {}
  async list(opts: { status?: string; limit?: number } = {}) {
    const r = await call<{ counts: Record<string, number>; notifications: NotificationView[] }>(this.rpc, "bodega_vendor_notification_list", { status: opts.status ?? null, limit: Math.max(0, Math.min(Math.trunc(opts.limit ?? 50) || 0, 200)) });
    return { counts: r.counts, notifications: r.notifications };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Vault
// ---------------------------------------------------------------------------------------------------------

const SCOPED_KEY_RE = /^pp_[A-Za-z0-9_-]{43}$/;
export class SharedVault implements Vault {
  private readonly upstreams: Map<string, UpstreamConfig>;
  constructor(private rpc: VendorRpc, private keys: VendorKeys, publicUrl: string, private env: NodeJS.ProcessEnv, upstreams?: UpstreamConfig[], private fetcher: typeof fetch = fetch) {
    this.upstreams = vendorUpstreams(publicUrl, upstreams);
  }
  async upstream(listing_id: string): Promise<UpstreamConfig> { const u = this.upstreams.get(listing_id); if (!u) throw new Error("Upstream unavailable"); return structuredClone(u); }

  async lease(listing_id: string, lease_id: string): Promise<Lease> {
    str(lease_id, "lease id");
    const u = await this.upstream(listing_id);
    if (u.credential.kind === "pooled_key") {
      const revoked = await call<{ revoked: boolean }>(this.rpc, "bodega_vendor_lease_revoked", { lease_id });
      if (revoked.revoked) throw new Error("Lease revoked");
      const secret = this.env[u.credential.env_var];
      if (!secret) throw new Error(`Missing vendor credential ${u.credential.env_var}`);
      // Pooled credentials are read at the boundary and never persisted.
      return { secret, expires_at: new Date(Date.now() + LEASE_TTL_MS).toISOString() };
    }
    if (listing_id === POSTPIGEON) {
      // Deterministic per lease: any replica can re-derive the key; the database only stores its hash.
      const secret = this.scopedKey(listing_id, lease_id);
      const r = await call<{ expires_at: string }>(this.rpc, "bodega_vendor_lease_scoped_issue", { lease_id, listing_id, key_hash: hash(secret), ttl_ms: LEASE_TTL_MS }).catch(rethrowLease);
      return { secret, expires_at: iso(r.expires_at) };
    }
    return this.webhookLease(u, listing_id, lease_id);
  }

  async revoke(lease_id: string): Promise<void> {
    str(lease_id, "lease id");
    // The revocation row is committed first, so every replica blocks this lease before upstream cleanup.
    const r = await call<{ kind: string | null; listing_id: string | null; sealed_secret: string | null }>(this.rpc, "bodega_vendor_lease_revoke", { lease_id });
    if (r.kind !== "webhook_sealed" || !r.sealed_secret || !r.listing_id) return;
    const u = this.upstreams.get(r.listing_id);
    if (u?.credential.kind === "provision_webhook" && u.credential.revoke_url) {
      const secret = unsealLease(this.keys.leaseSeal, lease_id, r.listing_id, r.sealed_secret);
      await this.callRevokeWebhook(u, lease_id, secret);
    }
    await call(this.rpc, "bodega_vendor_lease_scrub", { lease_id });
    // Pooled keys cannot be revoked upstream per trial. Proxy checks trial status and the shared revocation.
  }

  async authorizedPostPigeon(secret: string): Promise<boolean> {
    if (typeof secret !== "string" || !SCOPED_KEY_RE.test(secret)) return false;
    const r = await call<{ authorized: boolean }>(this.rpc, "bodega_vendor_scoped_key_check", { key_hash: hash(secret) });
    return r.authorized === true;
  }

  private scopedKey(listing_id: string, lease_id: string): string {
    return `pp_${createHmac("sha256", this.keys.scopedKeyMac).update(`${listing_id}\0${lease_id}`).digest("base64url")}`;
  }

  /** External vendor webhooks: single-flight across replicas; the minted key is stored sealed only. */
  private async webhookLease(u: UpstreamConfig, listing_id: string, lease_id: string): Promise<Lease> {
    if (u.credential.kind !== "provision_webhook") throw new Error("Upstream unavailable");
    const url = new URL(u.credential.url);
    if (url.protocol !== "https:") throw new Error("Provisioning webhook must use HTTPS");
    const claim_id = opaque();
    const claim = await call<{ state: "active" | "claimed" | "busy"; sealed_secret?: string; expires_at?: string }>(this.rpc, "bodega_vendor_lease_claim", { lease_id, listing_id, claim_id, stale_ms: 30_000 }).catch(rethrowLease);
    if (claim.state === "active") return { secret: unsealLease(this.keys.leaseSeal, lease_id, listing_id, claim.sealed_secret), expires_at: iso(claim.expires_at) };
    if (claim.state !== "claimed") throw new Error("Lease provisioning in progress; retry");
    let lease: Lease;
    try {
      const response = await this.fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trial_id: lease_id }), redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Vendor provisioning failed");
      const data = await response.json() as Lease;
      if (typeof data.secret !== "string" || !data.secret || data.secret.length > 4096 || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= Date.now()) throw new Error("Invalid provisioning response");
      lease = { secret: data.secret, expires_at: iso(data.expires_at) };
    } catch {
      await call(this.rpc, "bodega_vendor_lease_release", { lease_id, claim_id }).catch(() => undefined);
      throw new Error("Vendor provisioning failed");
    }
    try {
      await call(this.rpc, "bodega_vendor_lease_complete", { lease_id, claim_id, sealed_secret: sealLease(this.keys.leaseSeal, lease_id, listing_id, lease.secret), expires_at: lease.expires_at });
    } catch {
      // Revoked or claim lost while provisioning: best-effort revoke the orphaned key, then fail closed.
      if (u.credential.revoke_url) await this.callRevokeWebhook(u, lease_id, lease.secret).catch(() => undefined);
      throw new Error("Lease unavailable");
    }
    return lease;
  }

  private async callRevokeWebhook(u: UpstreamConfig, lease_id: string, secret: string): Promise<void> {
    if (u.credential.kind !== "provision_webhook" || !u.credential.revoke_url) return;
    const url = new URL(u.credential.revoke_url);
    if (url.protocol !== "https:") throw new Error("Revocation webhook must use HTTPS");
    const response = await this.fetcher(url, { method: "POST", headers: { "content-type": "application/json", [u.auth.header]: u.auth.format.replace("{key}", secret) }, body: JSON.stringify({ trial_id: lease_id }), redirect: "error", signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error("Upstream revocation failed; proxy access remains blocked");
  }
}
function rethrowLease(error: unknown): never {
  if (error instanceof SharedVendorError && error.code === "revoked") throw new Error("Lease revoked");
  if (error instanceof SharedVendorError && error.code === "unavailable") throw new Error("Lease unavailable");
  throw error;
}

// ---------------------------------------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------------------------------------

export async function createSharedVendorServices(options: SharedVendorServicesOptions = {}) {
  const env = options.env ?? process.env;
  const publicUrl = (options.publicUrl ?? env.BODEGA_PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
  const ttl = options.approvalTtlMs ?? 15 * 60_000;
  if (!Number.isFinite(ttl) || ttl <= 0 || ttl > 7 * 24 * 60 * 60_000) throw new Error("Invalid approval TTL");
  const keys = deriveVendorKeys(options.keySecret ?? env.BODEGA_VENDOR_KEY_SECRET);
  const maxActive = options.maxActiveTrials !== undefined ? options.maxActiveTrials : parseMaxActiveTrials(env);
  if (maxActive !== null && (!Number.isSafeInteger(maxActive) || maxActive < 1)) throw new Error("Invalid global trial limit");
  let rpc = options.rpc;
  if (!rpc) {
    const baseUrl = options.url ?? env.INSFORGE_URL;
    const apiKey = options.apiKey ?? env.INSFORGE_API_KEY;
    if (!baseUrl || !apiKey) throw new Error("INSFORGE_URL and INSFORGE_API_KEY are required for BODEGA_VENDOR_BACKEND=insforge");
    const client = createAdminClient({ baseUrl, apiKey });
    rpc = (fn, args) => client.database.rpc(fn, args);
  }
  const catalog = new SharedCatalog(rpc);
  const ledger = new SharedLedger(rpc, maxActive);
  const vault = new SharedVault(rpc, keys, publicUrl, env, options.upstreams, options.fetcher);
  const approvals = new SharedApprovals(rpc, publicUrl, ttl, options.deliverApproval, keys.scopedKeyMac);
  const notifications = new SharedNotifications(rpc);
  if (options.seed !== false) {
    try { await catalog.seed(LISTINGS.map(l => l.id === POSTPIGEON ? { ...l, docs_url: `${publicUrl}/postpigeon/docs` } : l)); }
    catch { throw new Error("InsForge shared vendor backend unavailable; verify the shared-vendors migration and server credentials"); }
  }
  const handleRequest = createVendorRoutes({ catalog, ledger, approvals, vault, notifications, vendors: VENDORS, publicUrl, adminToken: options.adminToken ?? env.BODEGA_VENDOR_ADMIN_TOKEN, persistence: "insforge-shared" });
  return { catalog, vault, ledger, approvals, notifications, handleRequest, close: () => {}, persistence: "insforge-shared" as const };
}
