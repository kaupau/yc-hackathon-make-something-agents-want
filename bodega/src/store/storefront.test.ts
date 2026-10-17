import test from "node:test";
import { get as httpGet } from "node:http";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApplication } from "../server.js";
import { createMockPayments, type PaymentProvider } from "./payments.js";
import { WalletStore } from "./wallet.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
const admin = "test-administrator-token-123456789";
async function fixture(extra: Parameters<typeof createApplication>[0] = {}) {
  const app = await createApplication({
    env: {},
    dbPath: ":memory:",
    walletPath: ":memory:",
    adminToken: admin,
    ...extra,
  });
  return app;
}
const parsed = (r: any) =>
  JSON.parse(r.content.find((c: any) => c.type === "text").text);

test("concurrent buys charge once, replay returns same key, credits are atomic and budget cannot reset", async () => {
  let charges = 0;
  const mock = createMockPayments();
  const payments: PaymentProvider = {
    ...mock,
    charge: async (o) => {
      charges++;
      await new Promise((r) => setTimeout(r, 5));
      return mock.charge(o);
    },
  };
  const a = await fixture({ payments, capCents: 100, thresholdCents: 100 });
  try {
    const results = (await Promise.all(
      Array.from({ length: 15 }, () => a.storefront.buy("postpigeon-email")),
    )) as any[];
    assert.equal(charges, 1);
    assert.ok(results.every((r) => r.status === "paid"));
    assert.equal(new Set(results.map((r) => r.project_key)).size, 1);
    a.state.ensureSession("local-demo", 100000, 100000);
    assert.equal((await a.storefront.wallet()).remaining_usd, 0.1);
    await assert.rejects(a.storefront.buy("seekr-search"), /budget/);
    const p = a.state.list("local-demo")[0];
    assert.equal(
      Array.from({ length: 1005 }, () => a.state.consume(p.id)).filter(Boolean)
        .length,
      1000,
    );
  } finally {
    await a.close();
  }
});

test("approval is required, hidden from purchasing agent and one-use before paid fulfillment", async () => {
  const a = await fixture({ capCents: 500, thresholdCents: 100 });
  try {
    const first: any = await a.storefront.buy("primitive-email");
    assert.equal(first.status, "needs_approval");
    assert.ok(!JSON.stringify(first).includes("/approve/"));
    assert.equal((await a.storefront.wallet()).reserved_usd, 2);
    const url = a.state.list("local-demo")[0].approval_url!;
    const page = await a.vendor.handleRequest(new Request(url));
    assert.equal(page?.status, 200);
    assert.equal(
      ((await a.storefront.buy("primitive-email")) as any).status,
      "needs_approval",
    );
    const response = await a.vendor.handleRequest(
      new Request(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision: "approved" }),
      }),
    );
    assert.equal(response?.status, 200);
    assert.equal(
      ((await a.storefront.buy("primitive-email")) as any).status,
      "paid",
    );
    assert.equal((await a.storefront.wallet()).spent_usd, 2);
    assert.equal(
      (await a.services.ledger.funnel("primitive")).listings[0].purchases,
      1,
    );
  } finally {
    await a.close();
  }
});

test("ambiguous payment retains reservation; same attempt recovers without duplicate fulfillment", async () => {
  const mock = createMockPayments();
  let calls = 0;
  const payments: PaymentProvider = {
    ...mock,
    charge: async (order) => {
      calls++;
      const paid = await mock.charge(order);
      if (calls === 1) throw new Error("lost response");
      return paid;
    },
  };
  const a = await fixture({ payments });
  try {
    assert.equal(
      ((await a.storefront.buy("postpigeon-email")) as any).status,
      "pending",
    );
    assert.equal((await a.storefront.wallet()).reserved_usd, 0.9);
    const second: any = await a.storefront.buy("postpigeon-email");
    assert.equal(second.status, "paid");
    assert.equal(calls, 2);
    assert.equal(
      (await a.services.ledger.funnel("postpigeon")).listings[0].purchases,
      1,
    );
    assert.equal(
      ((await a.storefront.buy("postpigeon-email")) as any).receipt_id,
      second.receipt_id,
    );
  } finally {
    await a.close();
  }
});

test("SQLite restart preserves signing key, spend and pending charge leases", () => {
  const dir = mkdtempSync(join(tmpdir(), "bodega-wallet-"));
  try {
    const path = join(dir, "wallet.sqlite");
    let w = new WalletStore(path);
    w.ensureSession("human", 100, 100);
    const p = w.reserve("human", "listing", 90);
    assert.equal(w.claim(p.id), true);
    w.finish(p.id, "paid", "mock_fixture");
    const token = w.tokenFor(p.id);
    w.close();
    w = new WalletStore(path);
    w.ensureSession("human", 9999, 9999);
    assert.equal(w.view("human").remaining_cents, 10);
    assert.equal(w.resolveToken(token)?.id, p.id);
    w.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("HTTP MCP reconnect shares durable wallet; admin inbox and origin/host checks are enforced", async () => {
  const a = await fixture({
    agentToken: "test-agent-token",
    capCents: 100,
    thresholdCents: 100,
  });
  const server = a.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const address = server.address() as { port: number };
  const base = `http://127.0.0.1:${address.port}`;
  const clients: Client[] = [];
  try {
    assert.equal((await fetch(base + "/admin/approvals")).status, 401);
    assert.equal(
      (
        await fetch(base + "/admin/approvals", {
          headers: { authorization: `Bearer ${admin}` },
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await fetch(base + "/mcp", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      401,
    );
    assert.equal(
      (
        await fetch(base + "/health", {
          headers: { origin: "https://attacker.example" },
        })
      ).status,
      403,
    );
    for (let i = 0; i < 2; i++) {
      const c = new Client({ name: "http-test", version: "1" });
      clients.push(c);
      await c.connect(
        new StreamableHTTPClientTransport(new URL(base + "/mcp"), {
          requestInit: {
            headers: { authorization: "Bearer test-agent-token" },
          },
        }),
      );
      if (i === 0) {
        const result = parsed(
          await c.callTool({
            name: "buy",
            arguments: { listing_id: "postpigeon-email" },
          }),
        );
        assert.equal(result.status, "paid");
      }
      const wallet = parsed(
        await c.callTool({ name: "wallet", arguments: {} }),
      );
      assert.equal(wallet.spent_usd, 0.9);
      assert.equal(wallet.remaining_usd, 0.1);
    }
  } finally {
    for (const c of clients) await c.close();
    await new Promise<void>((r) => server.close(() => r()));
    await a.close();
  }
});

test("exhausted trial cleanup destroys sandbox without allowing trial reset", async () => {
  const a = await fixture();
  try {
    const t = await a.runtime.start(
      (await a.services.catalog.get("tabletop-db"))!,
      "trial-owner",
    );
    await a.services.ledger.recordUsage(t.id, t.limit);
    await a.runtime.end(t.id);
    assert.equal((await a.services.ledger.getTrial(t.id))?.status, "ended");
    await assert.rejects(
      a.runtime.start(
        (await a.services.catalog.get("tabletop-db"))!,
        "trial-owner",
      ),
    );
  } finally {
    await a.close();
  }
});

test("HTTP webhooks retry unavailable verification, reconcile lost receipts, and deduplicate fulfillment", async () => {
  let ready = false;
  let inspections = 0;
  const payments: PaymentProvider = {
    mode: "stripe",
    charge: async () => ({ status: "pending" }),
    inspect: async () => {
      inspections++;
      return ready
        ? { status: "paid", paymentIntentId: "pi_webhookfixture" }
        : { status: "pending", error: "Verification unavailable" };
    },
    verifyWebhook: (_raw, signature) =>
      signature === "valid"
        ? {
            eventId: "evt_webhookfixture",
            paymentIntentId: "pi_webhookfixture",
            purchaseId: purchaseId,
          }
        : null,
  };
  const a = await fixture({ payments });
  let purchaseId = "";
  const server = a.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  try {
    purchaseId = ((await a.storefront.buy("postpigeon-email")) as any)
      .purchase_id;
    const notify = (signature = "valid") =>
      fetch(base + "/stripe/webhook", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "stripe-signature": signature,
        },
        body: '{"opaque":"raw fixture"}',
      });
    assert.equal((await notify("bad")).status, 400);
    assert.equal((await notify()).status, 503);
    assert.equal(a.state.hasEvent("evt_webhookfixture"), false);
    assert.equal((await a.storefront.wallet()).reserved_usd, 0.9);
    ready = true;
    assert.equal((await notify()).status, 200);
    assert.equal(a.state.hasEvent("evt_webhookfixture"), true);
    assert.equal((await a.storefront.wallet()).spent_usd, 0.9);
    const n = inspections;
    assert.equal((await notify()).status, 200);
    assert.equal(inspections, n);
    assert.equal(
      (await a.services.ledger.funnel("postpigeon")).listings[0].purchases,
      1,
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await a.close();
  }
});

test("cloud trial settings bound sandbox TTL and enforce a global cross-listing limit", async () => {
  const created: Array<{ ttlSeconds: number }> = [];
  const backend = {
    mode: "blaxel" as const,
    create: async (input: { id: string; ttlSeconds: number }) => {
      created.push(input);
      return input.id;
    },
    exec: async () => ({ exitCode: 0, stdout: "ok", stderr: "" }),
    destroy: async () => {},
  };
  const app = await createApplication({
    env: { BODEGA_MAX_ACTIVE_TRIALS: "1", BODEGA_MAX_TRIAL_MINUTES: "5" },
    dbPath: ":memory:",
    walletPath: ":memory:",
    backend,
  });
  try {
    const first = await app.runtime.start(
      (await app.services.catalog.get("postpigeon-email"))!,
      "cloud-trial-test",
    );
    assert.equal(created[0].ttlSeconds, 300);
    assert.equal(
      Date.parse(first.expires_at) - Date.parse(first.started_at),
      300000,
    );
    await assert.rejects(
      app.runtime.start(
        (await app.services.catalog.get("primitive-email"))!,
        "cloud-trial-test",
      ),
      /Global sandbox limit/,
    );
    assert.equal(created.length, 1);
    await app.runtime.end(first.id);
    await app.runtime.start(
      (await app.services.catalog.get("primitive-email"))!,
      "cloud-trial-test",
    );
    assert.equal(created.length, 2);
  } finally {
    await app.close();
  }
});

test("Railway healthcheck host is allowed only on GET /health", async () => {
  const a = await fixture();
  const server = a.app.listen(0, "127.0.0.1");
  await new Promise<void>((r) => server.once("listening", r));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const probe = (path: string, host: string) =>
    new Promise<number>((resolve, reject) => {
      const request = httpGet(
        new URL(path, base),
        { headers: { host } },
        (response) => {
          response.resume();
          response.on("end", () => resolve(response.statusCode!));
        },
      );
      request.on("error", reject);
    });
  try {
    assert.equal(await probe("/health", "healthcheck.railway.app"), 200);
    assert.equal(await probe("/portal", "healthcheck.railway.app"), 403);
    assert.equal(await probe("/health", "attacker.example"), 403);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    await a.close();
  }
});
