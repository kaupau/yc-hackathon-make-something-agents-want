import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createApplication } from "../server.js";
import { createMockPayments, type PaymentProvider } from "../store/payments.js";
import {
  InsforgeIdentityRepository,
  SqliteIdentityRepository,
  type RpcCall,
} from "./repository.js";
import { IdentityService, hashAgentToken } from "./service.js";

const admin = "test-administrator-token-123456789";
const legacyToken = "legacy-agent-token-0123456789";

async function serve(extra: Parameters<typeof createApplication>[0] = {}) {
  const app = await createApplication({
    env: {},
    dbPath: ":memory:",
    walletPath: ":memory:",
    adminToken: admin,
    ...extra,
  });
  const server = app.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const clients: Client[] = [];
  return {
    app,
    base,
    async adminCall(path: string, body?: unknown, token = admin) {
      const r = await fetch(base + path, {
        method: body === undefined ? "GET" : "POST",
        headers: {
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          "content-type": "application/json",
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      return { status: r.status, text: await r.text() };
    },
    async customer(id: string, cap = 100, threshold = 100) {
      const r = await this.adminCall("/admin/customers", {
        id,
        email: `${id}@example.test`,
        cap_cents: cap,
        threshold_cents: threshold,
      });
      assert.equal(r.status, 201, r.text);
      return JSON.parse(r.text) as {
        customer: { id: string };
        agent_credential: { id: string; token: string };
        agent_configuration: any;
      };
    },
    async connect(token?: string) {
      const c = new Client({ name: "isolation-test", version: "1" });
      const transport = new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
        requestInit: token ? { headers: { authorization: `Bearer ${token}` } } : {},
      });
      await c.connect(transport);
      clients.push(c);
      return { client: c, sessionId: transport.sessionId! };
    },
    async close() {
      for (const c of clients) await c.close().catch(() => {});
      await new Promise<void>((r) => server.close(() => r()));
      await app.close();
    },
  };
}
const parsed = (r: any) => JSON.parse(r.content.find((c: any) => c.type === "text").text);
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) =>
  c.callTool({ name, arguments: args });
const rawMcp = (base: string, token: string, sessionId: string) =>
  fetch(base + "/mcp", {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      "mcp-session-id": sessionId,
    },
    body: JSON.stringify({ jsonrpc: "2.0", id: 99, method: "tools/list", params: {} }),
  });

test("only administrators provision customers; tokens are returned once and never listed", async () => {
  const h = await serve({ agentToken: legacyToken });
  try {
    const body = { email: "a@example.test", cap_cents: 500, threshold_cents: 100 };
    assert.equal((await h.adminCall("/admin/customers", body, "")).status, 401);
    assert.equal((await h.adminCall("/admin/customers", body, legacyToken)).status, 401);
    assert.equal((await h.adminCall("/admin/customers", body, "x".repeat(40))).status, 401);
    const a = await h.customer("acme");
    assert.match(a.agent_credential.token, /^bdg_agt_[A-Za-z0-9_-]{43}$/);
    assert.equal(
      a.agent_configuration.mcpServers.bodega.headers.Authorization,
      `Bearer ${a.agent_credential.token}`,
    );
    // A customer agent token cannot administer customers or read the approval inbox.
    for (const path of ["/admin/customers", "/admin/approvals"])
      assert.equal((await h.adminCall(path, undefined, a.agent_credential.token)).status, 401);
    assert.equal((await h.adminCall("/admin/customers", body, a.agent_credential.token)).status, 401);
    const listing = await h.adminCall("/admin/customers");
    assert.equal(listing.status, 200);
    assert.ok(!listing.text.includes(a.agent_credential.token));
    assert.ok(!listing.text.includes(hashAgentToken(a.agent_credential.token)));
    assert.ok(!/token_hash|"token"/.test(listing.text));
    const customers = JSON.parse(listing.text).customers;
    assert.equal(customers[0].id, "acme");
    assert.equal(customers[0].credentials[0].id, a.agent_credential.id);
    // Validation and no client-chosen extras.
    for (const bad of [
      { ...body, email: "not-an-email" },
      { ...body, threshold_cents: 900 },
      { ...body, cap_cents: -1 },
      { ...body, cap_cents: 1.5 },
      { ...body, id: "Upper Case" },
      { ...body, active: false },
      { ...body, token: "bdg_agt_chosen" },
    ])
      assert.equal((await h.adminCall("/admin/customers", bad)).status, 400);
    assert.equal((await h.customer("acme-2")).customer.id, "acme-2");
    assert.equal(
      (await h.adminCall("/admin/customers", { ...body, id: "acme" })).status,
      409,
    );
  } finally {
    await h.close();
  }
});

test("two customers cannot share MCP sessions, purchases, wallets or trials", async () => {
  const h = await serve({ agentToken: legacyToken });
  try {
    const a = await h.customer("alpha");
    const b = await h.customer("beta");
    const ca = await h.connect(a.agent_credential.token);
    const cb = await h.connect(b.agent_credential.token);
    const bought = parsed(await call(ca.client, "buy", { listing_id: "postpigeon-email" }));
    assert.equal(bought.status, "paid");
    assert.equal(parsed(await call(ca.client, "wallet")).spent_usd, 0.9);
    const wb = parsed(await call(cb.client, "wallet"));
    assert.equal(wb.spent_usd, 0);
    assert.equal(wb.purchases.length, 0);
    assert.notEqual(wb.session_id, parsed(await call(ca.client, "wallet")).session_id);
    // B cannot use A's paid capability.
    const used = await call(cb.client, "use", {
      listing_id: "postpigeon-email",
      tool: (await h.app.services.catalog.get("postpigeon-email"))!.adds_tools[0],
      args: {},
    });
    assert.equal(used.isError, true);
    // B cannot ride A's MCP session ID; A can (positive control).
    assert.equal((await rawMcp(h.base, b.agent_credential.token, ca.sessionId)).status, 404);
    assert.equal((await rawMcp(h.base, legacyToken, ca.sessionId)).status, 404);
    assert.equal((await rawMcp(h.base, a.agent_credential.token, ca.sessionId)).status, 200);
    // Trials are bound to the starting customer.
    const trial = parsed(await call(ca.client, "start_trial", { listing_id: "postpigeon-email" }));
    assert.ok(trial.trial_id);
    const stolen = await call(cb.client, "run_trial", { trial_id: trial.trial_id, command: "echo hi" });
    assert.equal(stolen.isError, true);
    assert.equal(parsed(await call(cb.client, "wallet")).trials.length, 0);
    // Legacy principal is isolated from both customers.
    const legacy = await h.connect(legacyToken);
    assert.equal(parsed(await call(legacy.client, "wallet")).spent_usd, 0);
    assert.equal(parsed(await call(legacy.client, "wallet")).session_id, "local-demo");
  } finally {
    await h.close();
  }
});

test("reconnects and restarts never replenish a customer budget; rotation keeps the wallet", async () => {
  const dir = mkdtempSync(join(tmpdir(), "bodega-identity-"));
  const paths = {
    dbPath: join(dir, "vendor.sqlite"),
    walletPath: join(dir, "wallet.sqlite"),
    identityPath: join(dir, "identity.sqlite"),
  };
  try {
    let h = await serve(paths);
    let token: string;
    try {
      const a = await h.customer("gamma", 100, 100);
      token = a.agent_credential.token;
      const first = await h.connect(token);
      assert.equal(parsed(await call(first.client, "buy", { listing_id: "postpigeon-email" })).status, "paid");
      const again = await h.connect(token);
      assert.equal(parsed(await call(again.client, "wallet")).remaining_usd, 0.1);
      assert.equal((await call(again.client, "buy", { listing_id: "seekr-search" })).isError, true);
    } finally {
      await h.close();
    }
    h = await serve(paths);
    try {
      const after = await h.connect(token);
      const w = parsed(await call(after.client, "wallet"));
      assert.equal(w.remaining_usd, 0.1);
      assert.equal(w.cap_usd, 1);
      const rotated = await h.adminCall("/admin/customers/gamma/credentials", { revoke_existing: true });
      assert.equal(rotated.status, 201);
      const fresh = JSON.parse(rotated.text).agent_credential.token as string;
      assert.notEqual(fresh, token);
      assert.equal((await rawMcp(h.base, token, after.sessionId)).status, 401);
      const next = await h.connect(fresh);
      assert.equal(parsed(await call(next.client, "wallet")).remaining_usd, 0.1);
    } finally {
      await h.close();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("revoked, deactivated, expired-format and malformed tokens fail; no anonymous fallback", async () => {
  // No legacy token configured: anonymous local demo access remains for compatibility.
  const h = await serve();
  try {
    const anonymous = await h.connect();
    assert.equal(parsed(await call(anonymous.client, "wallet")).session_id, "local-demo");
    const a = await h.customer("delta");
    const c = await h.connect(a.agent_credential.token);
    assert.equal((await rawMcp(h.base, a.agent_credential.token, c.sessionId)).status, 200);
    // A presented-but-invalid credential never degrades to the anonymous wallet.
    for (const bad of ["bdg_agt_" + "A".repeat(43), "garbage", a.agent_credential.token + "x"])
      assert.equal((await rawMcp(h.base, bad, c.sessionId)).status, 401);
    const r = await fetch(h.base + "/mcp", {
      method: "POST",
      headers: { authorization: "Basic abc", "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(r.status, 401);
    assert.equal((await h.adminCall(`/admin/credentials/${a.agent_credential.id}/revoke`, {})).status, 200);
    assert.equal((await rawMcp(h.base, a.agent_credential.token, c.sessionId)).status, 401);
    await assert.rejects(h.connect(a.agent_credential.token));
    assert.equal((await h.adminCall(`/admin/credentials/${a.agent_credential.id}/revoke`, {})).status, 404);
    // Deactivation disables every credential of the customer.
    const issued = await h.adminCall("/admin/customers/delta/credentials", {});
    const second = JSON.parse(issued.text).agent_credential.token as string;
    const s = await h.connect(second);
    assert.equal((await h.adminCall("/admin/customers/delta/active", { active: false })).status, 200);
    assert.equal((await rawMcp(h.base, second, s.sessionId)).status, 401);
    assert.equal((await h.adminCall("/admin/customers/delta/active", { active: true })).status, 200);
    assert.equal((await rawMcp(h.base, second, s.sessionId)).status, 200);
  } finally {
    await h.close();
  }
});

test("customer approvals use the trusted customer email and agent tokens cannot approve", async () => {
  const h = await serve({ agentToken: legacyToken });
  try {
    const a = await h.customer("epsilon", 500, 100);
    const c = await h.connect(a.agent_credential.token);
    const first = parsed(await call(c.client, "buy", { listing_id: "primitive-email" }));
    assert.equal(first.status, "needs_approval");
    assert.ok(!JSON.stringify(first).includes("/approve/"));
    assert.equal((await h.adminCall("/admin/approvals", undefined, a.agent_credential.token)).status, 401);
    const inbox = JSON.parse((await h.adminCall("/admin/approvals")).text);
    const pending = inbox.pending.find((p: any) => p.customer_id === "epsilon");
    assert.equal(pending.approver_email, "epsilon@example.test");
    assert.ok(inbox.messages.some((m: any) => JSON.stringify(m).includes("epsilon@example.test")));
    // The approval link authorizes by its own one-use token, not the agent's credential.
    const approve = await h.app.vendor.handleRequest(
      new Request(pending.approve_url, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${a.agent_credential.token}` },
        body: JSON.stringify({ decision: "approved" }),
      }),
    );
    assert.equal(approve?.status, 200);
    assert.equal(parsed(await call(c.client, "buy", { listing_id: "primitive-email" })).status, "paid");
  } finally {
    await h.close();
  }
});

test("webhooks reconcile in the purchase owner's wallet", async () => {
  let ready = false;
  let purchaseId = "";
  const payments: PaymentProvider = {
    mode: "stripe",
    charge: async () => ({ status: "pending" }),
    inspect: async () =>
      ready ? { status: "paid", paymentIntentId: "pi_ownerfixture" } : { status: "pending" },
    verifyWebhook: (_raw, signature) =>
      signature === "valid"
        ? { eventId: "evt_ownerfixture", paymentIntentId: "pi_ownerfixture", purchaseId }
        : null,
  };
  const h = await serve({ agentToken: legacyToken, payments });
  try {
    const a = await h.customer("zeta");
    const c = await h.connect(a.agent_credential.token);
    const pending = parsed(await call(c.client, "buy", { listing_id: "postpigeon-email" }));
    assert.equal(pending.status, "pending");
    purchaseId = pending.purchase_id;
    ready = true;
    const r = await fetch(h.base + "/stripe/webhook", {
      method: "POST",
      headers: { "content-type": "application/json", "stripe-signature": "valid" },
      body: "{}",
    });
    assert.equal(r.status, 200);
    assert.equal(parsed(await call(c.client, "wallet")).spent_usd, 0.9);
    assert.equal((await h.app.storefront.wallet()).spent_usd, 0);
  } finally {
    await h.close();
  }
});

test("/mpp authenticates per principal and dispatches only the owner's storefront", async () => {
  const h = await serve({
    agentToken: legacyToken,
    payments: createMockPayments(),
    env: {
      BODEGA_PAYMENT_FLOW: "mpp",
      STRIPE_SECRET_KEY: "sk_test_fixture123",
      STRIPE_PROFILE_ID: "internal",
      MPP_SECRET_KEY: "test-challenge-signing-secret-at-least-32-bytes",
    },
  });
  try {
    const a = await h.customer("eta");
    const b = await h.customer("theta");
    const c = await h.connect(a.agent_credential.token);
    const bought = parsed(await call(c.client, "buy", { listing_id: "postpigeon-email" }));
    assert.match(bought.payment_url, /\/mpp\/pur_/);
    const url = h.base + new URL(bought.payment_url).pathname;
    const pay = (token?: string) =>
      fetch(url, token ? { headers: { "x-bodega-agent-token": token } } : {});
    assert.equal((await pay()).status, 401);
    assert.equal((await pay("bdg_agt_" + "B".repeat(43))).status, 401);
    assert.equal((await pay(b.agent_credential.token)).status, 404);
    assert.equal((await pay(legacyToken)).status, 404);
    // Owner reaches its own handler (mock payments are not MPP-enabled → 409).
    assert.equal((await pay(a.agent_credential.token)).status, 409);
  } finally {
    await h.close();
  }
});

test("InsForge repository seam sends only token hashes over RPC and maps conflicts", async () => {
  const backing = new SqliteIdentityRepository(":memory:");
  const calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  const rpc: RpcCall = async (fn, args) => {
    calls.push({ fn, args });
    const cred = (a: any) => ({ id: a.p_credential_id, token_hash: a.p_token_hash, expires_at: a.p_expires_at });
    try {
      switch (fn) {
        case "bodega_create_customer":
          return {
            data: await backing.createCustomer(
              { id: args.p_id as string, email: args.p_email as string, cap_cents: args.p_cap_cents as number, threshold_cents: args.p_threshold_cents as number },
              cred(args),
            ),
            error: null,
          };
        case "bodega_get_customer":
          return { data: await backing.getCustomer(args.p_id as string), error: null };
        case "bodega_list_customers":
          return { data: await backing.listCustomers(), error: null };
        case "bodega_set_customer_active":
          return { data: await backing.setActive(args.p_id as string, args.p_active as boolean), error: null };
        case "bodega_add_agent_credential":
          return { data: await backing.addCredential(args.p_customer_id as string, cred(args), args.p_revoke_existing as boolean), error: null };
        case "bodega_revoke_agent_credential":
          return { data: await backing.revokeCredential(args.p_credential_id as string), error: null };
        case "bodega_authenticate_agent":
          return { data: await backing.authenticate(args.p_token_hash as string), error: null };
      }
    } catch {
      return { data: null, error: { code: "23505", message: "duplicate key value (p_email=...)" } };
    }
    return { data: null, error: { code: "42883" } };
  };
  const h = await serve({ agentToken: legacyToken, identity: new InsforgeIdentityRepository(rpc) });
  try {
    const health = await (await fetch(h.base + "/health")).json();
    assert.equal(health.identity.backend, "insforge-rpc");
    assert.equal(health.identity.agent_credentials_required, true);
    const a = await h.customer("iota");
    const c = await h.connect(a.agent_credential.token);
    assert.equal(parsed(await call(c.client, "wallet")).session_id, "customer:iota");
    const dup = await h.adminCall("/admin/customers", { id: "iota", email: "x@example.test", cap_cents: 1, threshold_cents: 0 });
    assert.equal(dup.status, 409);
    assert.ok(!dup.text.includes("duplicate key"));
    assert.ok(calls.some((x) => x.fn === "bodega_authenticate_agent"));
    assert.ok(!JSON.stringify(calls).includes(a.agent_credential.token));
    assert.ok(JSON.stringify(calls).includes(hashAgentToken(a.agent_credential.token)));
  } finally {
    await h.close();
    backing.close();
  }
});

test("operator console is static and data endpoints stay protected", async () => {
  const h = await serve();
  try {
    const page = await fetch(h.base + "/admin/customers/console");
    assert.equal(page.status, 200);
    const html = await page.text();
    assert.match(page.headers.get("content-security-policy") ?? "", /script-src 'nonce-/);
    assert.ok(!html.includes(admin));
    assert.equal((await fetch(h.base + "/admin/customers")).status, 401);
    assert.equal((await fetch(h.base + "/admin/credentials/agt_000000000000000000000000/revoke", { method: "POST" })).status, 401);
  } finally {
    await h.close();
  }
});

test("credentials expire, legacy token maps only to the legacy principal", async () => {
  let t = Date.parse("2026-10-17T00:00:00Z");
  const repo = new SqliteIdentityRepository(":memory:", () => t);
  const identity = new IdentityService(repo, {
    legacy: { sessionId: "local-demo", capCents: 100, thresholdCents: 100, email: "op", token: legacyToken },
    allowAnonymousLegacy: false,
    now: () => t,
  });
  try {
    const { credential } = await identity.createCustomer({
      id: "kappa", email: "k@example.test", cap_cents: 100, threshold_cents: 50, token_ttl_days: 1,
    });
    assert.equal((await identity.authenticate(credential.token))?.id, "customer:kappa");
    assert.equal((await identity.authenticate(legacyToken))?.id, "local-demo");
    assert.equal(await identity.authenticate(null), null);
    t += 2 * 86_400_000;
    assert.equal(await identity.authenticate(credential.token), null);
    await assert.rejects(identity.createCustomer({ email: "k@example.test", cap_cents: 1, threshold_cents: 0, token_ttl_days: 999 }));
    assert.throws(
      () => new IdentityService(repo, { legacy: { sessionId: "customer:kappa", capCents: 1, thresholdCents: 0, email: "op" }, allowAnonymousLegacy: true }),
    );
  } finally {
    repo.close();
  }
});

test("per-principal MCP session limit evicts only that principal's oldest session", async () => {
  const h = await serve({ agentToken: legacyToken, env: { BODEGA_MAX_MCP_SESSIONS_PER_PRINCIPAL: "2" } });
  try {
    const a = await h.customer("lambda");
    const b = await h.customer("mu-2");
    const sb = await h.connect(b.agent_credential.token);
    const s1 = await h.connect(a.agent_credential.token);
    const s2 = await h.connect(a.agent_credential.token);
    const s3 = await h.connect(a.agent_credential.token);
    assert.equal((await rawMcp(h.base, a.agent_credential.token, s1.sessionId)).status, 404);
    for (const s of [s2, s3])
      assert.equal((await rawMcp(h.base, a.agent_credential.token, s.sessionId)).status, 200);
    assert.equal((await rawMcp(h.base, b.agent_credential.token, sb.sessionId)).status, 200);
  } finally {
    await h.close();
  }
});
