import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Listing, Purchase, Trial } from "../contracts/index.js";
import { createVendorServices, QuotaExceededError } from "./index.js";

const adminToken = "test-administrator-token-32-characters";
const trial = (id: string, session_id = id, limit = 10): Trial => ({ id, listing_id:"postpigeon-email", session_id, sandbox_id:null, status:"active", used:0, limit, unit:"api_calls", token:`bdg_trial_${id}`, started_at:new Date().toISOString(), expires_at:new Date(Date.now()+60_000).toISOString() });
const purchase = (id = "purchase-1"): Purchase => ({ id, listing_id:"postpigeon-email", session_id:"session-1", amount_usd:2, status:"needs_approval", created_at:new Date().toISOString() });
const request = (path: string, init?: RequestInit) => new Request(`http://localhost:8787${path}`,init);

test("SQLite persists catalog, usage and funnel; repeated events do not inflate conversions", async () => {
  const dir = mkdtempSync(join(tmpdir(),"bodega-vendor-")); const dbPath = join(dir,"vendor.sqlite");
  let services = createVendorServices({dbPath});
  try {
    await services.ledger.createTrial(trial("persist"));
    await services.ledger.recordUsage("persist",3);
    const p = {...purchase(), status:"paid" as const, receipt_id:"receipt_test", project_key:"must-not-appear-in-portal"};
    await services.ledger.recordPurchase(p); await services.ledger.recordPurchase(p);
    const report = {id:"compare-1",check_id:"email.roundtrip",session_id:"session-1",results:[{listing_id:"postpigeon-email",trial_id:"persist",ok:false,metrics:{send_ms:10},loc:9,error:"read denied",logs_tail:""}],suggestion:null,reason:"receive failed",created_at:new Date().toISOString()};
    await services.ledger.recordComparison(report); await services.ledger.recordComparison(report);
    const review = {id:"review-1",listing_id:"postpigeon-email",session_id:"session-1",verdict:"rejected" as const,reason:"<script>read failed</script>",compared_with:[],source:"agent" as const,created_at:new Date().toISOString()};
    await services.ledger.recordReview(review); await services.ledger.recordReview(review);
    services.close(); services = createVendorServices({dbPath});
    assert.equal((await services.ledger.getTrial("persist"))?.used,3);
    assert.equal((await services.catalog.get("postpigeon-email"))?.trial?.pool_used,3);
    const f = (await services.ledger.funnel("postpigeon")).listings[0];
    assert.equal(f.purchases,1); assert.equal(f.revenue_usd,2); assert.equal(f.checks_run,1); assert.equal(f.rejected,1);
    const portal = await (await services.handleRequest(request("/portal")))!.text();
    assert.ok(portal.includes("&lt;script&gt;read failed&lt;/script&gt;"));
    assert.ok(!portal.includes("must-not-appear-in-portal"));
  } finally { services.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("concurrent reservations never exceed trial or vendor quota, including multiple DB connections", async () => {
  const dir = mkdtempSync(join(tmpdir(),"bodega-quota-")); const dbPath = join(dir,"vendor.sqlite");
  const a = createVendorServices({dbPath}); const b = createVendorServices({dbPath});
  try {
    const listing = (await a.catalog.get("postpigeon-email"))!;
    listing.trial!.pool_total=7; listing.trial!.per_agent=5;
    await a.catalog.upsert(listing);
    await a.ledger.createTrial(trial("a","session-a",5)); await b.ledger.createTrial(trial("b","session-b",5));
    const outcomes = await Promise.allSettled(Array.from({length:30},(_,i)=>(i%2 ? a : b).ledger.recordUsage(i%2 ? "a" : "b",1)));
    assert.equal(outcomes.filter(r=>r.status==="fulfilled").length,7);
    assert.ok(outcomes.filter(r=>r.status==="rejected").every(r=>r.status==="rejected" && r.reason instanceof QuotaExceededError));
    assert.equal((await a.catalog.get(listing.id))?.trial?.pool_used,7);
    assert.ok((await a.ledger.getTrial("a"))!.used<=5);
    assert.ok((await a.ledger.getTrial("b"))!.used<=5);
    for (const invalid of [-1,0,0.5,NaN,Infinity,Number.MAX_SAFE_INTEGER+1]) await assert.rejects(a.ledger.recordUsage("a",invalid));
    await assert.rejects(a.ledger.updateTrial("a",{used:0}));
    listing.trial!.pool_used=0; await a.catalog.upsert(listing);
    assert.equal((await a.catalog.get(listing.id))?.trial?.pool_used,7);
  } finally { a.close(); b.close(); rmSync(dir,{recursive:true,force:true}); }
});

test("last accepted credit is usable; failed oversized reservations do not consume quota", async () => {
  const s = createVendorServices({dbPath:":memory:"});
  try { await s.ledger.createTrial(trial("last","last",1)); await assert.rejects(s.ledger.recordUsage("last",2),QuotaExceededError); assert.equal((await s.ledger.getTrial("last"))?.used,0); assert.deepEqual(await s.ledger.recordUsage("last",1),{used:1,limit:1,exhausted:true}); await assert.rejects(s.ledger.recordUsage("last",1),QuotaExceededError); } finally {s.close();}
});

test("trial allocation cannot bypass the session allowance or ignore expiration", async () => {
  let clock = Date.now(); const s = createVendorServices({dbPath:":memory:",now:()=>clock});
  try {
    await s.ledger.createTrial(trial("session-first","same-session",10));
    await s.ledger.updateTrial("session-first",{status:"ended"});
    await assert.rejects(s.ledger.createTrial(trial("session-second","same-session",10)),/allowance/);
    await s.ledger.createTrial(trial("expires")); clock += 120_000;
    await assert.rejects(s.ledger.recordUsage("expires",1),QuotaExceededError);
    assert.equal((await s.ledger.getTrial("expires"))?.used,0);
  } finally {s.close();}
});

test("approval is opaque, purchase/session scoped, one-use, expiry checked and GET is safe", async () => {
  let clock = Date.now(); const s = createVendorServices({dbPath:":memory:",now:()=>clock,approvalTtlMs:1000});
  try {
    const p = purchase(); await s.ledger.recordPurchase(p);
    const {approve_url} = await s.approvals.request(p,"human@example.test");
    const path = new URL(approve_url).pathname;
    assert.ok(!path.includes(p.id)); assert.match(path,/^\/approve\/[A-Za-z0-9_-]{43}$/);
    assert.equal(s.deliveryOutbox.length,1);
    assert.equal(await s.approvals.status(p.id),"pending");
    await s.handleRequest(request(path)); assert.equal(await s.approvals.status(p.id),"pending");
    const crossOrigin = await s.handleRequest(request(path,{method:"POST",headers:{origin:"https://evil.example","content-type":"application/x-www-form-urlencoded"},body:"decision=approved"}));
    assert.equal(crossOrigin?.status,403);
    await s.handleRequest(request(path,{method:"POST",body:"decision=approved"}));
    assert.equal(await s.approvals.status(p.id),"approved");
    const replay = await s.handleRequest(request(path,{method:"POST",body:"decision=declined"}));
    assert.ok((await replay!.text()).includes("already used"));
    assert.equal(await s.approvals.status(p.id),"approved");
    const p2 = purchase("expire"); await s.ledger.recordPurchase(p2); const link = await s.approvals.request(p2,"human@example.test");
    clock += 1001; assert.equal(await s.approvals.status(p2.id),"declined"); assert.equal(s.approvals.decide(new URL(link.approve_url).pathname.split("/").pop()!,"approved"),false);
    await assert.rejects(s.approvals.request({...p,session_id:"other-session"},"human@example.test"));
    assert.equal((await s.handleRequest(request(`/approve/${p.id}`)))?.status,200);
  } finally {s.close();}
});

test("admin listing auth, public projections and Vault isolate upstream secrets", async () => {
  const s = createVendorServices({dbPath:":memory:",adminToken,env:{PRIMITIVE_API_KEY:"upstream-secret-must-stay-private"}});
  try {
    const listing = (await s.catalog.get("primitive-email"))!;
    const path = `/portal/listings/${listing.id}`;
    assert.equal((await s.handleRequest(request(path,{method:"PUT",body:JSON.stringify(listing)})))?.status,401);
    const polluted = {...listing,name:"Updated Primitive",secret:"must-be-dropped",credential:{env_var:"PRIVATE"}};
    assert.equal((await s.handleRequest(request(path,{method:"PUT",headers:{authorization:`Bearer ${adminToken}`},body:JSON.stringify(polluted)})))?.status,200);
    const publicData = await (await s.handleRequest(request("/portal/catalog")))!.text();
    assert.ok(!publicData.includes("must-be-dropped")); assert.ok(!publicData.includes("upstream-secret-must-stay-private")); assert.ok(!publicData.includes('"credential"'));
    assert.equal((await s.vault.lease("primitive-email","lease-a")).secret,"upstream-secret-must-stay-private");
    await s.vault.revoke("lease-a"); await assert.rejects(s.vault.lease("primitive-email","lease-a"));
  } finally {s.close();}
});

test("PostPigeon provision is authenticated, send works, receive deliberately fails, revoke invalidates key", async () => {
  const s = createVendorServices({dbPath:":memory:",adminToken});
  try {
    assert.equal((await s.handleRequest(request("/postpigeon/provision",{method:"POST",body:'{"trial_id":"pp"}'})))?.status,401);
    const lease = await s.vault.lease("postpigeon-email","pp");
    assert.deepEqual(await s.vault.lease("postpigeon-email","pp"),lease);
    const headers = {authorization:`Bearer ${lease.secret}`};
    assert.equal((await s.handleRequest(request("/postpigeon/messages",{method:"POST",headers,body:'{"to":"mock@example.test","text":"hello"}'})))?.status,202);
    const read = await s.handleRequest(request("/postpigeon/messages",{headers})); assert.equal(read?.status,401); assert.ok((await read!.text()).includes("lacks read scope"));
    await s.vault.revoke("pp"); assert.equal((await s.handleRequest(request("/postpigeon/messages",{method:"POST",headers,body:"{}"})))?.status,401);
  } finally {s.close();}
});

test("streamed oversized admin bodies are cancelled before unbounded buffering", async () => {
  const s = createVendorServices({dbPath:":memory:",adminToken}); let cancelled = false; let chunks = 0;
  const body = new ReadableStream<Uint8Array>({pull(controller) { chunks++; controller.enqueue(new Uint8Array(40_000)); },cancel() {cancelled=true;} });
  try {
    const init = {method:"PUT",headers:{authorization:`Bearer ${adminToken}`},body,duplex:"half"} as RequestInit;
    assert.equal((await s.handleRequest(request("/portal/listings/test",init)))?.status,400);
    assert.equal(cancelled,true); assert.ok(chunks<=4);
  } finally {s.close();}
});
