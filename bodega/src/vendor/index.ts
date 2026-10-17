import { resolve } from "node:path";
import type { Listing, UpstreamConfig } from "../contracts/index.js";
import { VENDORS } from "../mocks/seed.js";
import { DurableCatalog, DurableLedger, QuotaExceededError } from "./data.js";
import { DemoDatabase } from "./persistence.js";
import { SecureApprovals, SecureVault, opaque, secureEqual, type ApprovalMessage } from "./security.js";

export { DurableCatalog, DurableLedger, QuotaExceededError, SecureApprovals, SecureVault };
export type { ApprovalMessage };
export interface VendorServicesOptions {
  /** Local demo persistence. Use a mounted volume for restart durability. */
  dbPath?: string;
  publicUrl?: string;
  adminToken?: string;
  env?: NodeJS.ProcessEnv;
  upstreams?: UpstreamConfig[];
  now?: () => number;
  approvalTtlMs?: number;
  /** Only inject when explicitly authorized to send outbound human email. */
  deliverApproval?: (message: ApprovalMessage) => Promise<void>;
  fetcher?: typeof fetch;
}
const esc = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
function html(title: string, body: string, nonce = opaque()): Response {
  return new Response(`<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · Bodega</title><style nonce="${nonce}">body{font:16px system-ui;background:#f6f4ec;color:#242421;max-width:1080px;margin:40px auto;padding:0 24px}h1{font-size:38px}section{background:white;border:1px solid #ddd8c8;border-radius:14px;padding:22px;margin:20px 0}table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:10px;border-bottom:1px solid #eee}small{color:#666}button{background:#275f46;color:white;border:0;padding:12px;border-radius:8px;cursor:pointer}input,textarea{display:block;padding:10px;width:95%;margin:8px 0;border:1px solid #bbb;border-radius:6px}textarea{min-height:180px}.reject{background:#9e352d}code{overflow-wrap:anywhere}a{color:#275f46}</style></head><body><h1>Bodega <small>${esc(title)}</small></h1>${body}</body></html>`, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` } });
}

export function createVendorServices(options: VendorServicesOptions = {}) {
  const env = options.env ?? process.env;
  const publicUrl = (options.publicUrl ?? env.BODEGA_PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
  const now = options.now ?? Date.now;
  const ttl = options.approvalTtlMs ?? 15*60_000;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("Invalid approval TTL");
  const db = new DemoDatabase(options.dbPath ?? env.BODEGA_VENDOR_DB_PATH ?? resolve(".bodega/vendor-demo.sqlite"));
  const catalog = new DurableCatalog(db, publicUrl);
  const maxActive = env.BODEGA_MAX_ACTIVE_TRIALS ? Number(env.BODEGA_MAX_ACTIVE_TRIALS) : Infinity;
  if (maxActive !== Infinity && (!Number.isSafeInteger(maxActive) || maxActive < 1)) throw new Error("Invalid global trial limit");
  const ledger = new DurableLedger(db, now, maxActive);
  const vault = new SecureVault(db, now, publicUrl, env, options.upstreams, options.fetcher);
  const approvals = new SecureApprovals(db, publicUrl, now, ttl, options.deliverApproval);
  const adminToken = options.adminToken ?? env.BODEGA_VENDOR_ADMIN_TOKEN;
  const admin = (request: Request) => !!adminToken && adminToken.length >= 24 && secureEqual(request.headers.get("authorization") ?? "", `Bearer ${adminToken}`);
  async function readBody(request: Request): Promise<string> {
    const limit = 100_000;
    if (Number(request.headers.get("content-length")) > limit) { await request.body?.cancel(); throw new Error("Request too large"); }
    const reader = request.body?.getReader(); if (!reader) return "";
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (true) {
        const result = await reader.read(); if (result.done) break;
        length += result.value.byteLength;
        if (length > limit) { await reader.cancel(); throw new Error("Request too large"); }
        chunks.push(result.value);
      }
      return Buffer.concat(chunks, length).toString("utf8");
    } finally { reader.releaseLock(); }
  }
  async function handleRequest(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!(path === "/portal" || path.startsWith("/portal/") || path.startsWith("/approve/") || path.startsWith("/postpigeon/"))) return null;
    try {
      if (path === "/portal" && request.method === "GET") {
        const vendors = await Promise.all(VENDORS.map(async vendor => ({vendor, funnel: await ledger.funnel(vendor.id)})));
        const listings = await catalog.search("", {limit:100});
        const nonce = opaque();
        const cards = vendors.filter(v => v.funnel.listings.length).map(({vendor,funnel}) => `<section><h2>${esc(vendor.name)}</h2><table><thead><tr><th>Listing</th><th>Trials</th><th>Checks passed</th><th>Chosen / rejected</th><th>Purchases</th><th>Revenue</th></tr></thead><tbody>${funnel.listings.map(l => `<tr><td>${esc(l.listing_id)}</td><td>${l.trials}</td><td>${l.checks_passed}/${l.checks_run}</td><td>${l.chosen} / ${l.rejected}</td><td>${l.purchases}</td><td>$${l.revenue_usd.toFixed(2)}</td></tr>${l.top_reasons.length ? `<tr><td colspan="6"><small>${l.top_reasons.map(esc).join(" · ")}</small></td></tr>` : ""}`).join("")}</tbody></table></section>`).join("");
        const editor = `<section><h2>Create or edit a listing</h2><p>Administrator access required. Public listing details only; credential settings stay in server configuration.</p><form id="editor"><label>Admin token<input id="token" type="password" autocomplete="off" required></label><label>Listing ID<input id="listing-id" required></label><label>Listing JSON<textarea id="listing" required>${esc(JSON.stringify(listings[0],null,2))}</textarea></label><button>Save listing</button></form><p id="result" role="status"></p><details><summary>Current public catalog</summary><pre>${esc(JSON.stringify(listings,null,2))}</pre></details></section><script nonce="${nonce}">document.getElementById('editor').addEventListener('submit',async(e)=>{e.preventDefault();const token=document.getElementById('token');try{const id=document.getElementById('listing-id').value;const result=await fetch('/portal/listings/'+encodeURIComponent(id),{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+token.value},body:document.getElementById('listing').value});document.getElementById('result').textContent=result.ok?'Saved. Refresh to see the updated catalog.':'Save failed: check token and public listing fields.';}catch{document.getElementById('result').textContent='Save failed.';}finally{token.value='';}});</script>`;
        return html("Vendor portal", `<p>Local demo persistence · PostPigeon and non-email providers are simulated. No payment or provider credentials appear here.</p>${cards}${editor}`, nonce);
      }
      if (path === "/portal/catalog" && request.method === "GET") return json({ persistence: "local-demo-sqlite", listings: await catalog.search("", { limit:100 }) });
      if (path.startsWith("/portal/funnel/") && request.method === "GET") return json(await ledger.funnel(decodeURIComponent(path.slice("/portal/funnel/".length))));
      if (path.startsWith("/portal/listings/") && request.method === "PUT") {
        if (!admin(request)) return json({error:"Administrator authorization required"}, 401);
        const listing = JSON.parse(await readBody(request)) as Listing;
        if (listing.id !== decodeURIComponent(path.slice("/portal/listings/".length))) return json({error:"Listing ID mismatch"},400);
        await catalog.upsert(listing); return json({ saved:true });
      }
      if (path.startsWith("/approve/")) {
        const token = path.slice("/approve/".length);
        const record = approvals.inspect(token);
        if (!record) return html("Approval unavailable", "<p>This link has expired, was already used, or does not match a pending purchase.</p>");
        if (request.method === "GET") return html("Purchase approval", `<section><p>Session <code>${esc(record.session_id)}</code> requests <strong>${esc(record.listing_id)}</strong> for <strong>$${record.amount_usd.toFixed(2)}</strong>.</p><p>Expires ${esc(new Date(record.expires_at).toISOString())}. Approval authorizes only this purchase; payment is processed separately.</p><form method="post"><button name="decision" value="approved">Approve $${record.amount_usd.toFixed(2)}</button> <button class="reject" name="decision" value="declined">Decline</button></form></section>`);
        if (request.method === "POST") {
          const origin = request.headers.get("origin");
          if (origin && origin !== new URL(publicUrl).origin) return json({error:"Invalid origin"},403);
          const body = await readBody(request);
          const decision = request.headers.get("content-type")?.includes("application/json") ? (JSON.parse(body) as {decision?:unknown}).decision : new URLSearchParams(body).get("decision");
          if (decision !== "approved" && decision !== "declined") return json({error:"Choose approve or decline"},400);
          if (!approvals.decide(token, decision)) return json({error:"Approval unavailable"},409);
          return html("Decision recorded", `<p>Purchase ${esc(decision)}. Return to the agent to continue.</p>`);
        }
      }
      if (path === "/postpigeon/docs" && request.method === "GET") return json({simulated:true, endpoints:{"POST /messages":"Sends a simulated message with a scoped key", "GET /messages":"Deliberate 401: scoped trial key lacks read permission"}});
      if (path === "/postpigeon/provision" && request.method === "POST") {
        if (!admin(request)) return json({error:"Provisioning authorization required"},401);
        const {trial_id} = JSON.parse(await readBody(request)) as {trial_id?:unknown};
        if (typeof trial_id !== "string" || !trial_id || trial_id.length > 200) return json({error:"Invalid trial id"},400);
        return json(await vault.lease("postpigeon-email", trial_id));
      }
      if (path === "/postpigeon/revoke" && request.method === "POST") {
        if (!admin(request)) return json({error:"Provisioning authorization required"},401);
        const {trial_id} = JSON.parse(await readBody(request)) as {trial_id?:unknown};
        if (typeof trial_id !== "string") return json({error:"Invalid trial id"},400);
        await vault.revoke(trial_id); return json({revoked:true});
      }
      if (path === "/postpigeon/messages") {
        const secret = (request.headers.get("authorization") ?? "").replace(/^Bearer /, "");
        if (!vault.authorizedPostPigeon(secret)) return json({error:"Invalid scoped PostPigeon key",simulated:true},401);
        if (request.method === "GET") return json({error:"Scoped trial key lacks read scope",simulated:true},401);
        if (request.method === "POST") { JSON.parse(await readBody(request)); return json({id:`pp_msg_${opaque()}`,status:"sent",simulated:true},202); }
      }
      return json({error:"Route or method unavailable"},404);
    } catch { return json({error:"Invalid request or unavailable resource"},400); }
  }
  return { catalog, vault, ledger, approvals, handleRequest, close: () => db.close(), deliveryOutbox: approvals.outbox, persistence: "local-demo-sqlite" as const };
}
