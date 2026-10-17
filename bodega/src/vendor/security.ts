import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { ApprovalStatus, Approvals, Lease, Purchase, UpstreamConfig, Vault } from "../contracts/index.js";
import { UPSTREAMS } from "../mocks/seed.js";
import { DemoDatabase } from "./persistence.js";

export const opaque = () => randomBytes(32).toString("base64url");
export const hash = (s: string) => createHash("sha256").update(s).digest("hex");
export const secureEqual = (a: string, b: string): boolean => timingSafeEqual(Buffer.from(hash(a)), Buffer.from(hash(b)));
export interface ApprovalMessage { purchase_id: string; to: string; subject: string; text: string; approve_url: string }
interface ApprovalRecord { purchase_id: string; session_id: string; listing_id: string; amount_usd: number; token_hash: string; expires_at: number; status: ApprovalStatus }

export class SecureApprovals implements Approvals {
  readonly outbox: ApprovalMessage[] = [];
  constructor(private db: DemoDatabase, private baseUrl: string, private now: () => number, private ttl: number, private deliver?: (message: ApprovalMessage) => Promise<void>) {}
  async request(purchase: Purchase, human_email: string): Promise<{ approve_url: string }> {
    if (purchase.status !== "needs_approval" || !human_email || /[\r\n]/.test(human_email)) throw new Error("Invalid approval request");
    const stored = this.db.get<Purchase>("purchase", purchase.id);
    if (!stored || !this.matches(stored, purchase)) throw new Error("Record purchase before requesting approval");
    const existing = this.db.get<ApprovalRecord>("approval", purchase.id);
    if (existing?.status === "approved" || existing?.status === "declined") throw new Error("Approval already decided");
    const token = opaque();
    const record: ApprovalRecord = { purchase_id: purchase.id, session_id: purchase.session_id, listing_id: purchase.listing_id, amount_usd: purchase.amount_usd, token_hash: hash(token), expires_at: this.now()+this.ttl, status: "pending" };
    this.db.put("approval", purchase.id, record);
    const approve_url = `${this.baseUrl}/approve/${token}`;
    const message: ApprovalMessage = { purchase_id: purchase.id, to: human_email, subject: `Approve Bodega purchase: $${purchase.amount_usd.toFixed(2)}`, text: `Session ${purchase.session_id} requests ${purchase.listing_id} for $${purchase.amount_usd.toFixed(2)}. Review this expiring, one-use link: ${approve_url}`, approve_url };
    // Default is captured local delivery only. No outbound messages without explicit injection.
    if (this.deliver) await this.deliver(message); else this.outbox.push(message);
    return { approve_url };
  }
  async status(purchase_id: string): Promise<ApprovalStatus> {
    const r = this.db.get<ApprovalRecord>("approval", purchase_id);
    if (!r) return "pending";
    const p = this.db.get<Purchase>("purchase", purchase_id);
    if (!p || !this.matches(p,r) || (r.status === "pending" && r.expires_at <= this.now())) return "declined";
    return r.status;
  }
  inspect(token: string): ApprovalRecord | null {
    if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
    const r = this.db.list<ApprovalRecord>("approval").find(r => secureEqual(r.token_hash, hash(token)));
    const p = r && this.db.get<Purchase>("purchase", r.purchase_id);
    return r && p && r.status === "pending" && r.expires_at > this.now() && this.matches(p,r) && p.status === "needs_approval" ? r : null;
  }
  decide(token: string, status: "approved" | "declined"): boolean {
    return this.db.transaction(() => { const r = this.inspect(token); if (!r) return false; r.status = status; this.db.put("approval", r.purchase_id, r); return true; });
  }
  private matches(a: Pick<Purchase,"id"|"session_id"|"listing_id"|"amount_usd">, b: Pick<Purchase,"session_id"|"listing_id"|"amount_usd"> & { id?: string; purchase_id?: string }): boolean { return a.id === (b.id ?? b.purchase_id) && a.session_id === b.session_id && a.listing_id === b.listing_id && a.amount_usd === b.amount_usd; }
}

interface ScopedKey { trial_id: string; key_hash: string; expires_at: string; revoked: boolean }
interface StoredLease extends Lease { listing_id: string; revoked: boolean }
export class SecureVault implements Vault {
  private readonly upstreams: Map<string, UpstreamConfig>;
  constructor(private db: DemoDatabase, private now: () => number, publicUrl: string, private env: NodeJS.ProcessEnv, upstreams?: UpstreamConfig[], private fetcher: typeof fetch = fetch) {
    this.upstreams = new Map((upstreams ?? UPSTREAMS.map(u => u.listing_id === "postpigeon-email" ? { ...u, base_url: `${publicUrl}/postpigeon`, credential: { kind: "provision_webhook" as const, url: `${publicUrl}/postpigeon/provision`, revoke_url: `${publicUrl}/postpigeon/revoke` } } : u)).map(u => [u.listing_id, structuredClone(u)]));
  }
  async upstream(listing_id: string): Promise<UpstreamConfig> { const u = this.upstreams.get(listing_id); if (!u) throw new Error("Upstream unavailable"); return structuredClone(u); }
  async lease(listing_id: string, trial_id: string): Promise<Lease> {
    if (this.db.get<{revoked:boolean}>("revocation", trial_id)?.revoked) throw new Error("Lease revoked");
    const prior = this.db.get<StoredLease>("lease", trial_id);
    if (prior) { if (prior.listing_id !== listing_id || prior.revoked || Date.parse(prior.expires_at) <= this.now()) throw new Error("Lease unavailable"); return { secret: prior.secret, expires_at: prior.expires_at }; }
    const u = await this.upstream(listing_id);
    let lease: Lease;
    if (u.credential.kind === "pooled_key") {
      const secret = this.env[u.credential.env_var];
      if (!secret) throw new Error(`Missing vendor credential ${u.credential.env_var}`);
      // Pooled credentials are read at the boundary and never persisted.
      return { secret, expires_at: new Date(this.now()+30*60_000).toISOString() };
    }
    if (listing_id === "postpigeon-email") lease = this.mintPostPigeon(trial_id);
    else {
      const url = new URL(u.credential.url); if (url.protocol !== "https:") throw new Error("Provisioning webhook must use HTTPS");
      const response = await this.fetcher(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ trial_id }), redirect: "error", signal: AbortSignal.timeout(10000) });
      if (!response.ok) throw new Error("Vendor provisioning failed");
      const data = await response.json() as Lease;
      if (typeof data.secret !== "string" || !data.secret || !Number.isFinite(Date.parse(data.expires_at)) || Date.parse(data.expires_at) <= this.now()) throw new Error("Invalid provisioning response");
      lease = { secret: data.secret, expires_at: data.expires_at };
    }
    this.db.put("lease", trial_id, { ...lease, listing_id, revoked: false }); return lease;
  }
  async revoke(trial_id: string): Promise<void> {
    this.db.put("revocation", trial_id, {revoked:true});
    const scoped = this.db.get<ScopedKey>("postpigeon_key", trial_id); if (scoped) this.db.put("postpigeon_key", trial_id, { ...scoped, revoked: true });
    const prior = this.db.get<StoredLease>("lease", trial_id); if (prior) this.db.put("lease", trial_id, { ...prior, revoked: true });
    if (prior?.secret && prior.listing_id !== "postpigeon-email") {
      const u = await this.upstream(prior.listing_id);
      if (u.credential.kind === "provision_webhook" && u.credential.revoke_url) {
        const url = new URL(u.credential.revoke_url); if (url.protocol !== "https:") throw new Error("Revocation webhook must use HTTPS");
        const response = await this.fetcher(url, {method:"POST",headers:{"content-type":"application/json",[u.auth.header]:u.auth.format.replace("{key}",prior.secret)},body:JSON.stringify({trial_id}),redirect:"error",signal:AbortSignal.timeout(10000)});
        if (!response.ok) throw new Error("Upstream revocation failed; proxy access remains blocked");
      }
    }
    if (prior) this.db.put("lease", trial_id, { ...prior, revoked:true, secret:"" });
    // Pooled keys cannot be revoked upstream per trial. Proxy checks trial status.
  }
  mintPostPigeon(trial_id: string): Lease {
    const secret = `pp_${opaque()}`; const expires_at = new Date(this.now()+30*60_000).toISOString();
    this.db.put("postpigeon_key", trial_id, { trial_id, key_hash: hash(secret), expires_at, revoked: false } satisfies ScopedKey);
    return { secret, expires_at };
  }
  authorizedPostPigeon(secret: string): boolean { return this.db.list<ScopedKey>("postpigeon_key").some(k => !k.revoked && Date.parse(k.expires_at) > this.now() && secureEqual(k.key_hash, hash(secret))); }
}
