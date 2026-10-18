import express, { type Request, type Response } from "express";
import { randomBytes } from "node:crypto";
import { IdentityError } from "./repository.js";
import type { IdentityService, IssuedCredential } from "./service.js";

/** Client configuration handed to the human operator; contains the one-time token. */
export function agentConfiguration(publicUrl: string, credential: IssuedCredential) {
  return {
    mcpServers: {
      bodega: {
        type: "http",
        url: `${publicUrl}/mcp`,
        headers: { Authorization: `Bearer ${credential.token}` },
      },
    },
    mpp_payment_header: { "X-Bodega-Agent-Token": credential.token },
  };
}

function fail(res: Response, e: unknown) {
  if (e instanceof IdentityError) {
    const status =
      e.code === "INVALID_INPUT"
        ? 400
        : e.code === "CONFLICT"
          ? 409
          : e.code === "NOT_FOUND"
            ? 404
            : 503;
    res.status(status).json({ error: e.message, code: e.code });
    return;
  }
  res.status(500).json({ error: "Customer administration failed" });
}
const body = (req: Request): Record<string, unknown> =>
  req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? req.body
    : {};
const only = (b: Record<string, unknown>, allowed: string[]) =>
  Object.keys(b).every((k) => allowed.includes(k));

/**
 * Administrator-only customer provisioning. Raw agent tokens appear only in the
 * creation/issue response and are never stored, listed, or logged.
 */
export function customerAdminRouter(
  identity: IdentityService,
  options: { publicUrl: string; isAdmin: (req: Request) => boolean },
) {
  const router = express.Router();
  router.get("/admin/customers/console", (_req, res) => {
    const nonce = randomBytes(16).toString("base64url");
    res.set(
      "content-security-policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
    );
    res.set("x-frame-options", "DENY");
    res.type("html").send(consolePage(nonce));
  });
  router.use(
    "/admin/customers",
    (req, res, next) => {
      if (!options.isAdmin(req)) {
        res.status(401).json({ error: "Administrator authorization required" });
        return;
      }
      next();
    },
    express.json({ limit: "8kb" }),
  );
  router.use("/admin/credentials", (req, res, next) => {
    if (!options.isAdmin(req)) {
      res.status(401).json({ error: "Administrator authorization required" });
      return;
    }
    next();
  });
  router.get("/admin/customers", async (_req, res) => {
    try {
      res.json({
        backend: identity.repository.mode,
        customers: await identity.listCustomers(),
      });
    } catch (e) {
      fail(res, e);
    }
  });
  router.post("/admin/customers", async (req, res) => {
    const b = body(req);
    if (!only(b, ["id", "email", "cap_cents", "threshold_cents", "token_ttl_days"])) {
      res.status(400).json({ error: "Unsupported customer field" });
      return;
    }
    try {
      const { customer, credential } = await identity.createCustomer(b);
      res.status(201).json({
        customer,
        agent_credential: { ...credential, shown_once: true },
        agent_configuration: agentConfiguration(options.publicUrl, credential),
      });
    } catch (e) {
      fail(res, e);
    }
  });
  router.post("/admin/customers/:id/credentials", async (req, res) => {
    const b = body(req);
    if (!only(b, ["token_ttl_days", "revoke_existing"]) ||
      (b.revoke_existing !== undefined && typeof b.revoke_existing !== "boolean")) {
      res.status(400).json({ error: "Unsupported credential field" });
      return;
    }
    try {
      const credential = await identity.issueCredential(String(req.params.id), {
        ttlDays: b.token_ttl_days,
        revokeExisting: b.revoke_existing === true,
      });
      res.status(201).json({
        customer_id: req.params.id,
        rotated: b.revoke_existing === true,
        agent_credential: { ...credential, shown_once: true },
        agent_configuration: agentConfiguration(options.publicUrl, credential),
      });
    } catch (e) {
      fail(res, e);
    }
  });
  router.post("/admin/customers/:id/active", async (req, res) => {
    const b = body(req);
    if (!only(b, ["active"]) || typeof b.active !== "boolean") {
      res.status(400).json({ error: "active must be a boolean" });
      return;
    }
    try {
      const customer = await identity.setActive(String(req.params.id), b.active);
      if (!customer) {
        res.status(404).json({ error: "Customer not found" });
        return;
      }
      res.json({ customer });
    } catch (e) {
      fail(res, e);
    }
  });
  router.post("/admin/credentials/:id/revoke", async (req, res) => {
    try {
      const revoked = await identity.revokeCredential(String(req.params.id));
      if (!revoked) {
        res.status(404).json({ error: "Active credential not found" });
        return;
      }
      res.json({ revoked: true });
    } catch (e) {
      fail(res, e);
    }
  });
  return router;
}

/** Static page; every action calls the protected JSON API with an in-memory admin token. */
function consolePage(nonce: string) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Customers · Bodega operator</title><style nonce="${nonce}">body{font:15px system-ui;background:#f6f4ec;color:#242421;max-width:980px;margin:32px auto;padding:0 20px}section{background:#fff;border:1px solid #ddd8c8;border-radius:12px;padding:20px;margin:18px 0}label{display:block;margin:8px 0}input{display:block;padding:8px;width:95%;border:1px solid #bbb;border-radius:6px}button{background:#275f46;color:#fff;border:0;padding:9px 14px;border-radius:7px;cursor:pointer;margin:4px 4px 4px 0}button.warn{background:#9e352d}pre{background:#f1efe6;padding:12px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}table{width:100%;border-collapse:collapse}td,th{padding:6px;border-bottom:1px solid #eee;text-align:left;font-size:13px}.note{color:#666}</style></head><body>
<h1>Bodega customers</h1><p class="note">Operator console. The administrator token stays in this page's memory only. Agent tokens are shown once; copy the configuration to the customer's agent, then close this page.</p>
<section><label>Administrator token<input id="admin" type="password" autocomplete="off"></label><button id="load">Load customers</button></section>
<section><h2>Create customer</h2><form id="create"><label>Customer ID (optional; lowercase)<input name="id" pattern="[a-z0-9][a-z0-9_-]{2,63}"></label><label>Approver email<input name="email" type="email" required></label><label>Budget cap (cents)<input name="cap_cents" type="number" min="0" step="1" required value="1000"></label><label>Approval threshold (cents)<input name="threshold_cents" type="number" min="0" step="1" required value="100"></label><label>Token lifetime (days)<input name="token_ttl_days" type="number" min="1" max="365" value="90"></label><button>Create and issue agent token</button></form></section>
<section><h2>One-time agent configuration</h2><p class="note">Not retrievable later. Rotate to issue a replacement.</p><pre id="issued">—</pre></section>
<section><h2>Customers</h2><div id="list" class="note">Load to view.</div></section>
<script nonce="${nonce}">
const $=id=>document.getElementById(id);
const show=(v)=>{$('issued').textContent=typeof v==='string'?v:JSON.stringify(v,null,2)};
async function api(path,method='GET',payload){const r=await fetch(path,{method,headers:{authorization:'Bearer '+$('admin').value,'content-type':'application/json'},body:payload?JSON.stringify(payload):undefined});const data=await r.json().catch(()=>({}));if(!r.ok)throw new Error(data.error||('HTTP '+r.status));return data}
function cell(t){const td=document.createElement('td');td.textContent=t;return td}
function btn(label,fn,warn){const b=document.createElement('button');b.textContent=label;if(warn)b.className='warn';b.addEventListener('click',async()=>{try{await fn();await load()}catch(e){show('Error: '+e.message)}});return b}
async function load(){try{const {customers,backend}=await api('/admin/customers');const t=document.createElement('table');t.innerHTML='<tr><th>Customer</th><th>Email</th><th>Cap / threshold</th><th>Status</th><th>Credentials</th><th>Actions</th></tr>';for(const c of customers){const tr=document.createElement('tr');tr.append(cell(c.id),cell(c.email),cell('$'+(c.cap_cents/100).toFixed(2)+' / $'+(c.threshold_cents/100).toFixed(2)),cell(c.active?'active':'disabled'));const creds=document.createElement('td');for(const k of c.credentials){const d=document.createElement('div');d.textContent=k.id+' · '+(k.revoked_at?'revoked':('expires '+k.expires_at.slice(0,10)));if(!k.revoked_at)d.append(btn('Revoke',()=>api('/admin/credentials/'+k.id+'/revoke','POST'),true));creds.append(d)}tr.append(creds);const a=document.createElement('td');a.append(btn('Rotate token',async()=>show((await api('/admin/customers/'+c.id+'/credentials','POST',{revoke_existing:true})).agent_configuration)),btn(c.active?'Disable':'Enable',()=>api('/admin/customers/'+c.id+'/active','POST',{active:!c.active}),c.active));tr.append(a);t.append(tr)}$('list').replaceChildren(t);$('list').prepend('Backend: '+backend)}catch(e){$('list').textContent='Error: '+e.message}}
$('load').addEventListener('click',load);
$('create').addEventListener('submit',async(e)=>{e.preventDefault();const f=new FormData(e.target);const p={email:f.get('email'),cap_cents:Number(f.get('cap_cents')),threshold_cents:Number(f.get('threshold_cents')),token_ttl_days:Number(f.get('token_ttl_days')||90)};if(f.get('id'))p.id=f.get('id');try{const r=await api('/admin/customers','POST',p);show(r.agent_configuration);e.target.reset();await load()}catch(err){show('Error: '+err.message)}});
</script></body></html>`;
}
