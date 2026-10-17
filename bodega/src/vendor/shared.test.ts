import test from "node:test";
import assert from "node:assert/strict";
import type { Listing, Purchase, Trial } from "../contracts/index.js";
import { QuotaExceededError } from "./data.js";
import { createConfiguredVendorServices } from "./index.js";
import { createSharedVendorServices, deriveVendorKeys, type VendorRpc } from "./shared.js";

// In-memory model of the RPC contract in migrations/20261017210003_shared-vendors.sql. It is single-threaded,
// so it is trivially atomic; real cross-replica concurrency is covered by shared.pg.test.ts against Postgres.
type Row = Record<string, any>;
function fakeBackend() {
  let clock = 0; // offset added to Date.now(), lets tests expire things
  const now = () => Date.now() + clock;
  const listings = new Map<string, Row>(); let seq = 0;
  const trials = new Map<string, Row>(); const purchases = new Map<string, Row>();
  const comparisons = new Map<string, Row>(); const results: Row[] = []; const reviews = new Map<string, Row>();
  const approvals = new Map<string, Row>(); const notifications = new Map<string, Row>();
  const leases = new Map<string, Row>(); const revocations = new Set<string>();
  const calls: Array<{ fn: string; p: any }> = [];
  const err = (code: string, message: string) => ({ ok: false, code, message });
  const ok = (x: Row = {}) => ({ ok: true, ...x });
  const listingJson = (l: Row) => l.json;
  const trialJson = (t: Row) => { const { token_hash, ...rest } = t; void token_hash; return { ...rest, started_at: new Date(t.started_at).toISOString(), expires_at: new Date(t.expires_at).toISOString() }; };
  const live = (t: Row) => ["active", "provisioning"].includes(t.status) && t.expires_at > now();
  const fns: Record<string, (p: any) => unknown> = {
    bodega_vendor_listing_upsert(p) {
      const v = p.listing; const old = listings.get(v.id);
      if (!old) { listings.set(v.id, { json: structuredClone(v), seq: seq++ }); return ok({ inserted: true }); }
      if (p.seed_only) return ok({ inserted: false });
      if (old.json.vendor_id !== v.vendor_id) return err("conflict", "Cannot change listing vendor");
      if (!v.trial && (old.json.trial?.pool_used ?? 0) > 0) return err("conflict", "Cannot remove a funded trial policy after use");
      const next = structuredClone(v);
      if (next.trial && old.json.trial) next.trial.pool_used = old.json.trial.pool_used;
      if (next.trial && next.trial.pool_total < next.trial.pool_used) return err("conflict", "Pool cannot be smaller than consumed usage");
      old.json = next; return ok({ inserted: false });
    },
    bodega_vendor_listing_get: p => ok({ listing: listings.get(p.id)?.json ?? null }),
    bodega_vendor_listing_by_vendor: p => ok({ listings: [...listings.values()].filter(l => l.json.vendor_id === p.vendor_id).slice(0, p.limit).map(listingJson) }),
    bodega_vendor_listing_search(p) {
      const words: string[] = p.words;
      return ok({ listings: [...listings.values()].filter(l => !p.category || l.json.category === p.category).map(l => ({ l, score: words.filter(w => [l.json.name, l.json.category, l.json.one_line, ...l.json.keywords].join(" ").toLowerCase().includes(w)).length })).filter(x => !words.length || x.score > 0).sort((a, b) => b.score - a.score || a.l.seq - b.l.seq).slice(0, p.limit).map(x => listingJson(x.l)) });
    },
    bodega_vendor_trial_create(p) {
      const v = p.trial; const l = listings.get(v.listing_id)?.json; const exp = Date.parse(v.expires_at);
      if (!l?.trial || v.limit > l.trial.per_agent || v.used !== 0 || v.unit !== l.trial.unit || exp <= now() || !["provisioning", "active"].includes(v.status)) return err("invalid", "Invalid trial or policy");
      if (trials.has(v.id)) return err("conflict", "Duplicate trial id");
      if ([...trials.values()].some(t => t.token_hash === v.token_hash)) return err("invalid", "Duplicate trial token");
      if (p.max_active !== null && [...trials.values()].filter(live).length >= p.max_active) return err("limit", "Global sandbox limit reached");
      if ([...trials.values()].filter(t => t.listing_id === l.id && live(t)).length >= l.trial.max_concurrent) return err("limit", "Vendor concurrent trial limit reached");
      if ([...trials.values()].filter(t => t.listing_id === l.id && t.session_id === v.session_id).reduce((n, t) => n + t.limit, 0) + v.limit > l.trial.per_agent) return err("limit", "Session trial allowance already allocated");
      if (l.trial.pool_used >= l.trial.pool_total) return err("quota_exceeded", "Trial or vendor quota exhausted");
      const row = { ...v, started_at: Date.parse(v.started_at), expires_at: exp }; trials.set(v.id, row); return ok({ trial: trialJson(row) });
    },
    bodega_vendor_trial_get: p => { const t = p.id !== undefined ? trials.get(p.id) : [...trials.values()].find(x => x.token_hash === p.token_hash); return ok({ trial: t ? trialJson(t) : null }); },
    bodega_vendor_trial_list: p => ok({ trials: [...trials.values()].filter(t => t.session_id === p.session_id).slice(0, p.limit).map(trialJson) }),
    bodega_vendor_trial_update(p) {
      const t = trials.get(p.id); if (!t) return err("not_found", "Unknown trial");
      for (const [k, v] of Object.entries(p.expect as Row)) {
        const cur = k === "started_at" || k === "expires_at" ? new Date(t[k]).toISOString() : t[k];
        if (cur !== v) return err("invalid", `Trial ${k} is immutable; use recordUsage`);
      }
      const status = p.patch.status ?? t.status;
      if (status !== t.status && (["ended", "expired"].includes(t.status) || (t.status === "exhausted" && !["ended", "expired"].includes(status)))) return err("invalid", "Terminal trial cannot be reactivated");
      t.status = status; if ("sandbox_id" in p.patch) t.sandbox_id = p.patch.sandbox_id; return ok({ trial: trialJson(t) });
    },
    bodega_vendor_trial_usage(p) {
      const t = trials.get(p.id); if (!t) return err("not_found", "Unknown trial"); const l = listings.get(t.listing_id)!.json;
      if (t.status !== "active" || t.expires_at <= now()) return err("quota_exceeded", "Trial inactive or expired");
      if (!l.trial || p.amount > t.limit - t.used || p.amount > l.trial.pool_total - l.trial.pool_used) return err("quota_exceeded", "Trial or vendor quota exhausted");
      t.used += p.amount; l.trial.pool_used += p.amount; const exhausted = t.used >= t.limit || l.trial.pool_used >= l.trial.pool_total; if (exhausted) t.status = "exhausted";
      return ok({ used: t.used, limit: t.limit, exhausted });
    },
    bodega_vendor_purchase_record(p) {
      const v = p.purchase; if (!listings.has(v.listing_id)) return err("invalid", "Unknown listing");
      const old = purchases.get(v.id); if (!old) { purchases.set(v.id, { ...v }); return ok({ inserted: true }); }
      return JSON.stringify(old) === JSON.stringify(v) ? ok({ inserted: false }) : err("conflict", "Conflicting purchase id");
    },
    bodega_vendor_purchase_update(p) {
      const r = purchases.get(p.id); if (!r) return err("not_found", "Unknown purchase");
      for (const [k, v] of Object.entries(p.expect as Row)) if (r[k] !== v) return err("invalid", `Purchase ${k} is immutable`);
      const status = p.patch.status ?? r.status; const receipt = "receipt_id" in p.patch ? p.patch.receipt_id : r.receipt_id;
      if (r.status === "paid" && (status !== "paid" || receipt !== r.receipt_id)) return err("conflict", "Cannot overwrite paid purchase");
      r.status = status; r.receipt_id = receipt; const { receipt_id, ...rest } = r; return ok({ purchase: receipt_id ? r : rest });
    },
    bodega_vendor_purchase_list: p => ok({ purchases: [...purchases.values()].filter(r => r.session_id === p.session_id).map(r => { const { receipt_id, ...rest } = r; return receipt_id ? r : rest; }) }),
    bodega_vendor_comparison_record(p) {
      const old = comparisons.get(p.comparison.id); if (old) return old.digest === p.digest ? ok({ inserted: false }) : err("conflict", "Conflicting comparison id");
      comparisons.set(p.comparison.id, { ...p.comparison, digest: p.digest }); for (const r of p.results) results.push(r); return ok({ inserted: true });
    },
    bodega_vendor_review_record(p) {
      const old = reviews.get(p.review.id); if (old) return old.digest === p.digest ? ok({ inserted: false }) : err("conflict", "Conflicting review id");
      reviews.set(p.review.id, { ...p.review, digest: p.digest }); return ok({ inserted: true });
    },
    bodega_vendor_funnel(p) {
      const ls = [...listings.values()].filter(l => l.json.vendor_id === p.vendor_id).sort((a, b) => a.seq - b.seq);
      return ok({ funnel: { vendor_id: p.vendor_id, listings: ls.map(({ json: l }) => {
        const rs = results.filter(r => r.listing_id === l.id); const rv = [...reviews.values()].filter(r => r.listing_id === l.id);
        const paid = [...purchases.values()].filter(x => x.listing_id === l.id && x.status === "paid");
        const reasons = new Map<string, number>(); for (const r of rv) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + 1);
        return { listing_id: l.id, trials: [...trials.values()].filter(t => t.listing_id === l.id).length, checks_run: rs.length, checks_passed: rs.filter(r => r.ok).length, chosen: rv.filter(r => r.verdict === "chosen").length, rejected: rv.filter(r => r.verdict === "rejected").length, purchases: paid.length, revenue_usd: Math.round(paid.reduce((s, x) => s + x.amount_usd, 0) * 100) / 100, top_reasons: [...reasons].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([r]) => r) };
      }) } });
    },
    bodega_vendor_approval_request(p) {
      const v = p.purchase; const r = purchases.get(v.id);
      if (!r || r.session_id !== v.session_id || r.listing_id !== v.listing_id || r.amount_usd !== v.amount_usd || r.status !== "needs_approval") return err("invalid", "Record purchase before requesting approval");
      const old = approvals.get(v.id); if (old && old.status !== "pending") return err("conflict", "Approval already decided");
      const expires_at = now() + p.ttl_ms;
      approvals.set(v.id, { purchase_id: v.id, session_id: r.session_id, listing_id: r.listing_id, amount_usd: r.amount_usd, token_hash: p.token_hash, status: "pending", expires_at });
      notifications.set(p.notification.id, { ...p.notification, kind: "approval_request", purchase_id: v.id, attempts: 0, last_error: null, created_at: new Date(now()).toISOString(), updated_at: new Date(now()).toISOString(), delivered_at: null });
      return ok({ expires_at: new Date(expires_at).toISOString() });
    },
    bodega_vendor_approval_status(p) {
      const a = approvals.get(p.purchase_id); if (!a) return ok({ status: "pending" }); const r = purchases.get(a.purchase_id);
      if (!r || r.session_id !== a.session_id || r.listing_id !== a.listing_id || r.amount_usd !== a.amount_usd || (a.status === "pending" && a.expires_at <= now())) return ok({ status: "declined" });
      return ok({ status: a.status });
    },
    bodega_vendor_approval_inspect(p) {
      const a = [...approvals.values()].find(x => x.token_hash === p.token_hash); const r = a && purchases.get(a.purchase_id);
      return ok({ approval: a && r && a.status === "pending" && a.expires_at > now() && r.status === "needs_approval" && r.amount_usd === a.amount_usd ? { purchase_id: a.purchase_id, session_id: a.session_id, listing_id: a.listing_id, amount_usd: a.amount_usd, expires_at: new Date(a.expires_at).toISOString(), status: a.status } : null });
    },
    bodega_vendor_approval_decide(p) {
      const a = [...approvals.values()].find(x => x.token_hash === p.token_hash); const r = a && purchases.get(a.purchase_id);
      if (!a || !r || a.status !== "pending" || a.expires_at <= now() || r.status !== "needs_approval") return ok({ decided: false });
      a.status = p.decision; return ok({ decided: true });
    },
    bodega_vendor_notification_mark(p) {
      const n = notifications.get(p.id); if (!n) return err("not_found", "Unknown notification");
      if (!((n.status === "pending" && p.status === "sending") || (n.status === "sending" && ["sent", "failed"].includes(p.status)))) return err("conflict", "Invalid notification transition");
      n.status = p.status; if (p.status === "sending") n.attempts++; n.last_error = p.status === "failed" ? p.error : null; return ok();
    },
    bodega_vendor_notification_list(p) {
      const all = [...notifications.values()]; const counts: Row = {}; for (const n of all) counts[n.status] = (counts[n.status] ?? 0) + 1;
      return ok({ counts, notifications: all.filter(n => !p.status || n.status === p.status).slice(0, p.limit) });
    },
    bodega_vendor_lease_scoped_issue(p) {
      if (revocations.has(p.lease_id)) return err("revoked", "Lease revoked");
      if (!leases.has(p.lease_id)) leases.set(p.lease_id, { listing_id: p.listing_id, kind: "scoped_hmac", status: "active", key_hash: p.key_hash, expires_at: now() + p.ttl_ms });
      const l = leases.get(p.lease_id)!;
      if (l.listing_id !== p.listing_id || l.kind !== "scoped_hmac" || l.status !== "active" || l.expires_at <= now() || l.key_hash !== p.key_hash) return err("unavailable", "Lease unavailable");
      return ok({ expires_at: new Date(l.expires_at).toISOString() });
    },
    bodega_vendor_scoped_key_check: p => ok({ authorized: [...leases.entries()].some(([id, l]) => l.key_hash === p.key_hash && l.status === "active" && l.expires_at > now() && !revocations.has(id)) }),
    bodega_vendor_lease_revoked: p => ok({ revoked: revocations.has(p.lease_id) }),
    bodega_vendor_lease_claim(p) {
      if (revocations.has(p.lease_id)) return err("revoked", "Lease revoked");
      const l = leases.get(p.lease_id);
      if (!l) { leases.set(p.lease_id, { listing_id: p.listing_id, kind: "webhook_sealed", status: "provisioning", claim_id: p.claim_id, claimed_at: now() }); return ok({ state: "claimed" }); }
      if (l.listing_id !== p.listing_id || l.kind !== "webhook_sealed" || l.status === "revoked") return err("unavailable", "Lease unavailable");
      if (l.status === "active") return l.expires_at <= now() ? err("unavailable", "Lease unavailable") : ok({ state: "active", sealed_secret: l.sealed_secret, expires_at: new Date(l.expires_at).toISOString() });
      if (l.claimed_at > now() - p.stale_ms) return ok({ state: "busy" });
      l.claim_id = p.claim_id; l.claimed_at = now(); return ok({ state: "claimed" });
    },
    bodega_vendor_lease_complete(p) {
      if (revocations.has(p.lease_id)) return err("revoked", "Lease revoked");
      const l = leases.get(p.lease_id); if (!l || l.status !== "provisioning" || l.claim_id !== p.claim_id) return err("unavailable", "Lease claim lost");
      Object.assign(l, { status: "active", sealed_secret: p.sealed_secret, expires_at: Date.parse(p.expires_at), claim_id: null }); return ok();
    },
    bodega_vendor_lease_release: p => { const l = leases.get(p.lease_id); if (l?.status === "provisioning" && l.claim_id === p.claim_id) leases.delete(p.lease_id); return ok(); },
    bodega_vendor_lease_revoke(p) { revocations.add(p.lease_id); const l = leases.get(p.lease_id); if (l) l.status = "revoked"; return ok({ kind: l?.kind ?? null, listing_id: l?.listing_id ?? null, sealed_secret: l?.sealed_secret ?? null }); },
    bodega_vendor_lease_scrub: p => { const l = leases.get(p.lease_id); if (l?.status === "revoked") l.sealed_secret = null; return ok(); },
  };
  const rpc: VendorRpc = async (fn, args) => {
    const p = structuredClone((args as { p: unknown }).p); calls.push({ fn, p });
    const impl = fns[fn]; if (!impl) return { data: null, error: { message: `unknown function ${fn}` } };
    return { data: structuredClone(impl(p)), error: null };
  };
  return { rpc, calls, leases, notifications, advance: (ms: number) => { clock += ms; }, sent: () => JSON.stringify(calls) };
}

const keySecret = "test-vendor-key-secret-that-is-at-least-32-bytes";
const adminToken = "test-administrator-token-32-characters";
const request = (path: string, init?: RequestInit) => new Request(`http://localhost:8787${path}`, init);
const trial = (id: string, session_id = id, limit = 10, expiresInMs = 60_000): Trial => ({ id, listing_id: "postpigeon-email", session_id, sandbox_id: null, status: "active", used: 0, limit, unit: "api_calls", token: `bdg_trial_${id}_secret_token`, started_at: new Date().toISOString(), expires_at: new Date(Date.now() + expiresInMs).toISOString() });
const purchase = (id = "purchase-1"): Purchase => ({ id, listing_id: "postpigeon-email", session_id: "session-1", amount_usd: 2, status: "needs_approval", created_at: new Date().toISOString() });
async function shared(extra: Parameters<typeof createSharedVendorServices>[0] = {}) {
  const backend = fakeBackend();
  const services = await createSharedVendorServices({ rpc: backend.rpc, keySecret, adminToken, env: {}, publicUrl: "http://localhost:8787", ...extra });
  return { backend, services };
}

test("shared backend: requires a strong shared key secret and InsForge credentials; selector keeps SQLite default", async () => {
  assert.throws(() => deriveVendorKeys(undefined), /32 bytes/);
  assert.throws(() => deriveVendorKeys("short"), /32 bytes/);
  await assert.rejects(createSharedVendorServices({ env: { BODEGA_VENDOR_KEY_SECRET: keySecret } }), /INSFORGE_URL/);
  await assert.rejects(createConfiguredVendorServices({ env: { BODEGA_VENDOR_BACKEND: "insforge" } }), /BODEGA_VENDOR_KEY_SECRET/);
  await assert.rejects(createConfiguredVendorServices({ env: { BODEGA_VENDOR_BACKEND: "mystery" } }), /Unsupported/);
  const local = await createConfiguredVendorServices({ env: {}, dbPath: ":memory:" });
  try { assert.equal(local.persistence, "local-demo-sqlite"); } finally { local.close(); }
  const viaSelector = await createConfiguredVendorServices({ env: { BODEGA_VENDOR_BACKEND: "insforge", BODEGA_VENDOR_KEY_SECRET: keySecret }, rpc: fakeBackend().rpc });
  assert.equal(viaSelector.persistence, "insforge-shared");
});

test("shared backend: seeding never overwrites; pool_used preserved; vendor immutable; transport errors are opaque", async () => {
  const { backend, services } = await shared();
  const listing = (await services.catalog.get("postpigeon-email"))!;
  assert.equal(listing.docs_url, "http://localhost:8787/postpigeon/docs");
  await services.ledger.createTrial(trial("t1")); await services.ledger.recordUsage("t1", 3);
  await services.catalog.upsert({ ...listing, name: "Edited", trial: { ...listing.trial!, pool_used: 0 } });
  // A second replica starting up re-seeds: must not reset the edit or usage.
  await createSharedVendorServices({ rpc: backend.rpc, keySecret, env: {} });
  const after = (await services.catalog.get("postpigeon-email"))!;
  assert.equal(after.name, "Edited"); assert.equal(after.trial!.pool_used, 3);
  await assert.rejects(services.catalog.upsert({ ...listing, vendor_id: "someone-else" }), /Cannot change listing vendor/);
  await assert.rejects(services.catalog.upsert({ ...listing, trial: null }), /funded trial/);
  assert.ok((await services.catalog.search("email", { limit: 3 })).length <= 3);
  assert.ok((await services.catalog.search("edited")).some(l => l.id === "postpigeon-email"));
  const broken = await createSharedVendorServices({ rpc: async () => ({ data: null, error: { message: "boom: p={...secret...}" } }), keySecret, env: {}, seed: false });
  await assert.rejects(broken.catalog.get("x"), (e: Error) => e.message === "Shared vendor backend unavailable");
});

test("shared backend: trial tokens are hashed, quotas map to QuotaExceededError, lifecycle and allowance guarded", async () => {
  const { backend, services } = await shared({ maxActiveTrials: 2 });
  const t = trial("hash-me", "s1", 2);
  await services.ledger.createTrial(t);
  assert.ok(!backend.sent().includes(t.token), "raw trial token must never be sent to the database");
  assert.equal((await services.ledger.getTrial(t.id))!.token, "");
  assert.equal((await services.ledger.getTrialByToken(t.token))!.id, t.id);
  assert.equal(await services.ledger.getTrialByToken("bdg_trial_unknown"), null);
  await assert.rejects(services.ledger.recordUsage(t.id, 3), QuotaExceededError);
  assert.deepEqual(await services.ledger.recordUsage(t.id, 2), { used: 2, limit: 2, exhausted: true });
  await assert.rejects(services.ledger.recordUsage(t.id, 1), QuotaExceededError);
  for (const invalid of [-1, 0, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) await assert.rejects(services.ledger.recordUsage(t.id, invalid));
  await assert.rejects(services.ledger.updateTrial(t.id, { used: 0 }), /immutable/);
  await assert.rejects(services.ledger.updateTrial(t.id, { token: "other" }), /immutable/);
  await assert.rejects(services.ledger.updateTrial(t.id, { status: "active" }), /Terminal/);
  assert.equal((await services.ledger.updateTrial(t.id, { status: "ended", token: t.token, used: 2 })).status, "ended");
  await assert.rejects(services.ledger.createTrial(trial("again", "s1", 9)), /allowance/);
  await services.ledger.createTrial(trial("g1", "g1", 1)); await services.ledger.createTrial(trial("g2", "g2", 1));
  await assert.rejects(services.ledger.createTrial(trial("g3", "g3", 1)), /Global sandbox limit/);
  const expiring = await shared();
  await expiring.services.ledger.createTrial(trial("exp", "exp", 5)); expiring.backend.advance(120_000);
  await assert.rejects(expiring.services.ledger.recordUsage("exp", 1), QuotaExceededError);
});

test("shared backend: idempotent events, immutable paid purchases, bounded funnel aggregate without secrets", async () => {
  const { backend, services } = await shared();
  const p = { ...purchase(), status: "paid" as const, receipt_id: "receipt_test", project_key: "must-not-persist", approve_url: "http://x/approve/must-not-persist" };
  await services.ledger.recordPurchase(p); await services.ledger.recordPurchase(p);
  assert.ok(!backend.sent().includes("must-not-persist"));
  await assert.rejects(services.ledger.updatePurchase(p.id, { status: "declined" }), /paid/);
  await assert.rejects(services.ledger.updatePurchase(p.id, { amount_usd: 0.01 }), /immutable/);
  await assert.rejects(services.ledger.updatePurchase(p.id, { session_id: "thief" }), /immutable/);
  const report = { id: "cmp-1", check_id: "email.roundtrip", session_id: "session-1", results: [{ listing_id: "postpigeon-email", trial_id: "t", ok: false, metrics: { send_ms: 10 }, loc: 9, error: "read denied", logs_tail: "" }], suggestion: null, reason: "receive failed", created_at: new Date().toISOString() };
  await services.ledger.recordComparison(report); await services.ledger.recordComparison(structuredClone(report));
  await assert.rejects(services.ledger.recordComparison({ ...report, reason: "different" }), /Conflicting/);
  const review = { id: "rev-1", listing_id: "postpigeon-email", session_id: "session-1", verdict: "rejected" as const, reason: "<script>read failed</script>", compared_with: [], source: "agent" as const, created_at: new Date().toISOString() };
  await services.ledger.recordReview(review); await services.ledger.recordReview(review);
  const f = (await services.ledger.funnel("postpigeon")).listings[0];
  assert.equal(f.purchases, 1); assert.equal(f.revenue_usd, 2); assert.equal(f.checks_run, 1); assert.equal(f.rejected, 1);
  const portal = await (await services.handleRequest(request("/portal")))!.text();
  assert.ok(portal.includes("Shared InsForge persistence")); assert.ok(portal.includes("&lt;script&gt;read failed&lt;/script&gt;"));
  assert.equal((await (await services.handleRequest(request("/portal/catalog")))!.json() as { persistence: string }).persistence, "insforge-shared");
});

test("shared backend: approval token hashed, safe GET, atomic one-use POST, expiry, outbox status without URLs", async () => {
  const delivered: string[] = [];
  const { backend, services } = await shared({ approvalTtlMs: 1000, deliverApproval: async m => { delivered.push(m.approve_url); } });
  const p = purchase(); await services.ledger.recordPurchase(p);
  const { approve_url } = await services.approvals.request(p, "human@example.test");
  const token = new URL(approve_url).pathname.split("/").pop()!;
  assert.match(token, /^[A-Za-z0-9_-]{43}$/); assert.deepEqual(delivered, [approve_url]);
  assert.ok(!backend.sent().includes(token), "approval token must never be sent to the database");
  const path = new URL(approve_url).pathname;
  assert.equal((await services.handleRequest(request(path)))?.status, 200); assert.equal(await services.approvals.status(p.id), "pending");
  assert.equal((await services.handleRequest(request(path, { method: "POST", headers: { origin: "https://evil.example" }, body: "decision=approved" })))?.status, 403);
  await services.handleRequest(request(path, { method: "POST", body: "decision=approved" }));
  assert.equal(await services.approvals.status(p.id), "approved");
  assert.ok((await (await services.handleRequest(request(path, { method: "POST", body: "decision=declined" })))!.text()).includes("already used"));
  assert.equal(await services.approvals.decide(token, "declined"), false);
  await assert.rejects(services.approvals.request(p, "human@example.test"), /already decided/);
  await assert.rejects(services.approvals.request({ ...purchase("other"), session_id: "x" }, "human@example.test"), /Record purchase/);
  const p2 = purchase("expire"); await services.ledger.recordPurchase(p2);
  const link = await services.approvals.request(p2, "human@example.test"); backend.advance(1001);
  assert.equal(await services.approvals.status(p2.id), "declined");
  assert.equal(await services.approvals.decide(new URL(link.approve_url).pathname.split("/").pop()!, "approved"), false);
  assert.equal(await services.approvals.inspect("not-a-token"), null);
  // Outbox: admin only, durable status, never contains the URL or token.
  assert.equal((await services.handleRequest(request("/portal/notifications")))?.status, 401);
  const outbox = await (await services.handleRequest(request("/portal/notifications", { headers: { authorization: `Bearer ${adminToken}` } })))!.text();
  assert.ok(!outbox.includes(token) && !outbox.includes("/approve/"));
  assert.equal((JSON.parse(outbox) as { counts: Record<string, number> }).counts.sent, 2);
  // Delivery failure: recorded as failed with a fixed code; provider error text is not stored.
  const failing = await shared({ deliverApproval: async m => { throw new Error(`smtp rejected ${m.approve_url}`); } });
  const p3 = purchase("fail"); await failing.services.ledger.recordPurchase(p3);
  await assert.rejects(failing.services.approvals.request(p3, "human@example.test"), /delivery failed/);
  const row = [...failing.backend.notifications.values()][0];
  assert.equal(row.status, "failed"); assert.equal(row.last_error, "delivery_failed");
  // No deliverer: captured, URL only returned to the caller.
  const captured = await shared(); const p4 = purchase("cap"); await captured.services.ledger.recordPurchase(p4);
  await captured.services.approvals.request(p4, "human@example.test");
  assert.equal([...captured.backend.notifications.values()][0].status, "captured");
});

test("shared backend: PostPigeon scoped keys work across replicas, only hashes persisted, revoke is global", async () => {
  const { backend, services: a } = await shared();
  const b = await createSharedVendorServices({ rpc: backend.rpc, keySecret, adminToken, env: {}, publicUrl: "http://localhost:8787" });
  const lease = await a.vault.lease("postpigeon-email", "pp");
  assert.match(lease.secret, /^pp_[A-Za-z0-9_-]{43}$/);
  assert.ok(!backend.sent().includes(lease.secret), "scoped key must never be sent to the database");
  assert.deepEqual(await b.vault.lease("postpigeon-email", "pp"), lease, "replica B derives the same lease");
  const headers = { authorization: `Bearer ${lease.secret}` };
  assert.equal((await b.handleRequest(request("/postpigeon/messages", { method: "POST", headers, body: '{"to":"mock@example.test"}' })))?.status, 202);
  assert.equal((await b.handleRequest(request("/postpigeon/messages", { headers })))?.status, 401);
  assert.equal((await a.handleRequest(request("/postpigeon/provision", { method: "POST", body: '{"trial_id":"pp"}' })))?.status, 401);
  await a.vault.revoke("pp");
  assert.equal((await b.handleRequest(request("/postpigeon/messages", { method: "POST", headers, body: "{}" })))?.status, 401);
  await assert.rejects(b.vault.lease("postpigeon-email", "pp"), /revoked/);
  const otherSecret = await createSharedVendorServices({ rpc: backend.rpc, keySecret: `${keySecret}-rotated`, env: {} });
  await a.vault.lease("postpigeon-email", "pp2");
  await assert.rejects(otherSecret.vault.lease("postpigeon-email", "pp2"), /unavailable/, "mismatched replica secret fails closed");
});

test("shared backend: pooled keys never persisted; external webhook leases sealed, single-flight, revoked upstream", async () => {
  const upstreams = [
    { listing_id: "primitive-email", base_url: "https://api.example", auth: { header: "Authorization", format: "Bearer {key}" }, credential: { kind: "pooled_key" as const, env_var: "PRIMITIVE_API_KEY" } },
    { listing_id: "postpigeon-email", base_url: "https://hooks.example", auth: { header: "Authorization", format: "Bearer {key}" }, credential: { kind: "provision_webhook" as const, url: "https://hooks.example/provision", revoke_url: "https://hooks.example/revoke" } },
  ];
  const minted = "vendor-minted-secret-must-be-sealed"; const hits: string[] = [];
  const fetcher = (async (url: URL, init: RequestInit) => { hits.push(`${url.pathname} ${new Headers(init.headers).get("authorization") ?? ""}`); return url.pathname === "/provision" ? Response.json({ secret: minted, expires_at: new Date(Date.now() + 60_000).toISOString() }) : new Response(null, { status: 204 }); }) as typeof fetch;
  // Use a separate listing id for the webhook so the built-in PostPigeon path is not taken.
  const hookUpstreams = [upstreams[0], { ...upstreams[1], listing_id: "hooked-email" }];
  const { backend, services } = await shared({ upstreams: hookUpstreams, fetcher, env: { PRIMITIVE_API_KEY: "pooled-secret-env-only" } });
  assert.equal((await services.vault.lease("primitive-email", "lease-a")).secret, "pooled-secret-env-only");
  await services.vault.revoke("lease-a"); await assert.rejects(services.vault.lease("primitive-email", "lease-a"), /revoked/);
  const first = await services.vault.lease("hooked-email", "w1");
  assert.equal(first.secret, minted);
  const replica = await createSharedVendorServices({ rpc: backend.rpc, keySecret, env: {}, upstreams: hookUpstreams, fetcher });
  assert.equal((await replica.vault.lease("hooked-email", "w1")).secret, minted, "other replica unseals the same lease");
  assert.equal(hits.filter(h => h.startsWith("/provision")).length, 1, "single provisioning call");
  const text = backend.sent();
  assert.ok(!text.includes("pooled-secret-env-only") && !text.includes(minted), "no plaintext provider secret reaches the database");
  await replica.vault.revoke("w1");
  assert.ok(hits.includes(`/revoke Bearer ${minted}`));
  assert.equal(backend.leases.get("w1")!.sealed_secret, null, "sealed material scrubbed after upstream revoke");
  await assert.rejects(services.vault.lease("hooked-email", "w1"), /revoked/);
  const insecure = await shared({ upstreams: [{ ...upstreams[1], listing_id: "hooked-email", credential: { kind: "provision_webhook", url: "http://insecure.example/p" } }], fetcher });
  await assert.rejects(insecure.services.vault.lease("hooked-email", "w2"), /HTTPS/);
});
