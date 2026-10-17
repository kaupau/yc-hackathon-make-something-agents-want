import type { Catalog, Lease, Ledger, Listing, Vendor } from "../contracts/index.js";
import { opaque, secureEqual } from "./security.js";

/** Purchase binding shown on the approval page. Never contains the token. */
export interface ApprovalView { purchase_id: string; session_id: string; listing_id: string; amount_usd: number; expires_at: number; status: string }
export type MaybePromise<T> = T | Promise<T>;
/** Safe, admin-only view of the notification outbox. Never contains approval URLs or tokens. */
export interface NotificationView { id: string; kind: string; purchase_id: string; recipient: string; subject: string; status: string; attempts: number; last_error: string | null; created_at: string; updated_at: string; delivered_at: string | null }
export interface NotificationOutbox { list(opts?: { status?: string; limit?: number }): Promise<{ counts: Record<string, number>; notifications: NotificationView[] }> }

/** Everything the vendor HTTP surface needs. Local SQLite and shared InsForge backends both satisfy it. */
export interface VendorRouteDeps {
  catalog: Catalog;
  ledger: Pick<Ledger, "funnel">;
  approvals: {
    inspect(token: string): MaybePromise<ApprovalView | null>;
    decide(token: string, status: "approved" | "declined"): MaybePromise<boolean>;
  };
  vault: {
    lease(listing_id: string, trial_id: string): Promise<Lease>;
    revoke(trial_id: string): Promise<void>;
    authorizedPostPigeon(secret: string): MaybePromise<boolean>;
  };
  notifications?: NotificationOutbox;
  vendors: Vendor[];
  publicUrl: string;
  adminToken?: string;
  /** Short label shown on the portal; e.g. "local-demo-sqlite" or "insforge-shared". */
  persistence: string;
}

import { shell, vendorCards } from "./portal.js";
export const esc = (v: unknown) => String(v).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]!));
export const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" } });
export function html(title: string, body: string, nonce = opaque(), options: { lede?: string } = {}): Response {
  return new Response(shell(title, body, nonce, options), { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "referrer-policy": "no-referrer", "x-frame-options": "DENY", "x-content-type-options": "nosniff", "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'` } });
}

export function createVendorRoutes(deps: VendorRouteDeps): (request: Request) => Promise<Response | null> {
  const { catalog, ledger, approvals, vault, publicUrl, adminToken } = deps;
  const admin = (request: Request) => !!adminToken && adminToken.length >= 24 && secureEqual(request.headers.get("authorization") ?? "", `Bearer ${adminToken}`);
  const shared = deps.persistence !== "local-demo-sqlite";
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
  return async function handleRequest(request: Request): Promise<Response | null> {
    const path = new URL(request.url).pathname;
    if (!(path === "/portal" || path.startsWith("/portal/") || path.startsWith("/approve/") || path.startsWith("/postpigeon/"))) return null;
    try {
      if (path === "/portal" && request.method === "GET") {
        const vendors = await Promise.all(deps.vendors.map(async vendor => ({vendor, funnel: await ledger.funnel(vendor.id)})));
        const listings = await catalog.search("", {limit:100});
        const nonce = opaque();
        const cards = vendorCards(vendors, listings);
        const editor = `<details class="admin"><summary>Admin: create or edit a listing</summary><section><p>Administrator access required. Public listing details only; credential settings stay in server configuration.</p><form id="editor"><label>Admin token<input id="token" type="password" autocomplete="off" required></label><label>Listing ID<input id="listing-id" required></label><label>Listing JSON<textarea id="listing" required>${esc(JSON.stringify(listings[0],null,2))}</textarea></label><button>Save listing</button></form><p id="result" role="status"></p><details><summary>Current public catalog</summary><pre>${esc(JSON.stringify(listings,null,2))}</pre></details></section></details><script nonce="${nonce}">document.getElementById('editor').addEventListener('submit',async(e)=>{e.preventDefault();const token=document.getElementById('token');try{const id=document.getElementById('listing-id').value;const result=await fetch('/portal/listings/'+encodeURIComponent(id),{method:'PUT',headers:{'content-type':'application/json',authorization:'Bearer '+token.value},body:document.getElementById('listing').value});document.getElementById('result').textContent=result.ok?'Saved. Refresh to see the updated catalog.':'Save failed: check token and public listing fields.';}catch{document.getElementById('result').textContent='Save failed.';}finally{token.value='';}});</script>`;
        const banner = shared ? "Shared InsForge persistence" : "Local demo persistence";
        return html("Vendor portal", `${cards}${editor}`, nonce, { lede: `What agents did with each listing: trials they ran, checks that passed, who they chose and why, and what they bought. ${banner}; PostPigeon and the non-email providers are simulated. No payment or provider credentials appear here.` });
      }
      if (path === "/portal/catalog" && request.method === "GET") return json({ persistence: deps.persistence, listings: await catalog.search("", { limit:100 }) });
      if (path.startsWith("/portal/funnel/") && request.method === "GET") return json(await ledger.funnel(decodeURIComponent(path.slice("/portal/funnel/".length))));
      if (path === "/portal/notifications" && request.method === "GET") {
        if (!admin(request)) return json({error:"Administrator authorization required"}, 401);
        if (!deps.notifications) return json({error:"Route or method unavailable"},404);
        const url = new URL(request.url); const status = url.searchParams.get("status") ?? undefined;
        if (status !== undefined && !/^[a-z]{1,20}$/.test(status)) return json({error:"Invalid status filter"},400);
        return json(await deps.notifications.list({ status, limit: Math.min(Number(url.searchParams.get("limit")) || 50, 200) }));
      }
      if (path.startsWith("/portal/listings/") && request.method === "PUT") {
        if (!admin(request)) return json({error:"Administrator authorization required"}, 401);
        const listing = JSON.parse(await readBody(request)) as Listing;
        if (listing.id !== decodeURIComponent(path.slice("/portal/listings/".length))) return json({error:"Listing ID mismatch"},400);
        await catalog.upsert(listing); return json({ saved:true });
      }
      if (path.startsWith("/approve/")) {
        const token = path.slice("/approve/".length);
        const record = await approvals.inspect(token);
        if (!record) return html("Approval unavailable", "<p>This link has expired, was already used, or does not match a pending purchase.</p>");
        if (request.method === "GET") return html("Purchase approval", `<section class="card"><p>Session <code>${esc(record.session_id)}</code> requests <strong>${esc(record.listing_id)}</strong> for <strong>$${record.amount_usd.toFixed(2)}</strong>.</p><p>Expires ${esc(new Date(record.expires_at).toISOString())}. Approval authorizes only this purchase; payment is processed separately.</p><form method="post"><button name="decision" value="approved">Approve $${record.amount_usd.toFixed(2)}</button> <button class="reject" name="decision" value="declined">Decline</button></form></section>`);
        if (request.method === "POST") {
          const origin = request.headers.get("origin");
          if (origin && origin !== new URL(publicUrl).origin) return json({error:"Invalid origin"},403);
          const body = await readBody(request);
          const decision = request.headers.get("content-type")?.includes("application/json") ? (JSON.parse(body) as {decision?:unknown}).decision : new URLSearchParams(body).get("decision");
          if (decision !== "approved" && decision !== "declined") return json({error:"Choose approve or decline"},400);
          if (!await approvals.decide(token, decision)) return json({error:"Approval unavailable"},409);
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
        if (!await vault.authorizedPostPigeon(secret)) return json({error:"Invalid scoped PostPigeon key",simulated:true},401);
        if (request.method === "GET") return json({error:"Scoped trial key lacks read scope",simulated:true},401);
        if (request.method === "POST") { JSON.parse(await readBody(request)); return json({id:`pp_msg_${opaque()}`,status:"sent",simulated:true},202); }
      }
      return json({error:"Route or method unavailable"},404);
    } catch { return json({error:"Invalid request or unavailable resource"},400); }
  };
}
