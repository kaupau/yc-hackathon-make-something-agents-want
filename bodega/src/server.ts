import express, {
  type Request as HttpRequest,
  type Response as HttpResponse,
} from "express";
import { randomUUID, timingSafeEqual } from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { homepage } from "./store/home.js";
import { createStoreMcp } from "./store/mcp.js";
import { createMppHandler } from "./store/mpp.js";
import { Storefront } from "./store/storefront.js";
import { WalletStore } from "./store/wallet.js";
import {
  BODEGA_SANDBOX_ACCOUNT,
  createMockPayments,
  createStripeCliPayments,
  createStripePayments,
  getMppReadiness,
  type PaymentProvider,
} from "./store/payments.js";
import { createVendorServices } from "./vendor/index.js";
import {
  createTrialRuntime,
  createProxyHandler,
  createBlaxelSandboxBackend,
  createSimulatedSandboxBackend,
  type SandboxBackend,
} from "./runtime/index.js";
import { connectInsforge } from "./vendor/insforge.js";
import type { Services } from "./contracts/index.js";

export interface ApplicationOptions {
  publicUrl?: string;
  dbPath?: string;
  walletPath?: string;
  sessionId?: string;
  capCents?: number;
  thresholdCents?: number;
  adminToken?: string;
  agentToken?: string;
  payments?: PaymentProvider;
  backend?: SandboxBackend;
  env?: NodeJS.ProcessEnv;
}
const same = (a: string, b: string) =>
  a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b));
export async function createApplication(options: ApplicationOptions = {}) {
  const env = options.env ?? process.env;
  const publicUrl = (
    options.publicUrl ??
    env.BODEGA_PUBLIC_URL ??
    "http://127.0.0.1:8787"
  ).replace(/\/$/, "");
  const origin = new URL(publicUrl).origin;
  const adminToken = options.adminToken ?? env.BODEGA_VENDOR_ADMIN_TOKEN;
  const agentToken = options.agentToken ?? env.BODEGA_AGENT_TOKEN;
  const vendor = createVendorServices({
    dbPath: options.dbPath,
    publicUrl,
    adminToken,
    env,
  });
  const remote =
    env.INSFORGE_URL && env.INSFORGE_API_KEY
      ? await connectInsforge(vendor, {
          url: env.INSFORGE_URL,
          apiKey: env.INSFORGE_API_KEY,
          outboxPath:
            env.BODEGA_SYNC_DB_PATH ?? ".bodega/insforge-outbox.sqlite",
        })
      : null;
  const state = new WalletStore(
    options.walletPath ??
      env.BODEGA_WALLET_DB_PATH ??
      ".bodega/payments.sqlite",
  );
  const payments =
    options.payments ??
    (env.BODEGA_PAYMENTS === "stripe-cli"
      ? createStripeCliPayments({
          accountId: BODEGA_SANDBOX_ACCOUNT,
          webhookSecret: env.STRIPE_WEBHOOK_SECRET,
        })
      : env.BODEGA_PAYMENTS === "stripe"
        ? createStripePayments({
            accountId: BODEGA_SANDBOX_ACCOUNT,
            secretKey: env.STRIPE_SECRET_KEY ?? "",
            webhookSecret: env.STRIPE_WEBHOOK_SECRET,
          })
        : createMockPayments());
  const runtime = createTrialRuntime(vendor, {
    publicBaseUrl: publicUrl,
    backend:
      options.backend ??
      (env.BODEGA_RUNTIME === "blaxel"
        ? await createBlaxelSandboxBackend()
        : createSimulatedSandboxBackend()),
    email: { primitiveInbox: env.PRIMITIVE_TRIAL_INBOX },
  });
  const services: Services = { ...vendor, runtime };
  let proxy: (r: Request) => Promise<Response | null>;
  const storefront = new Storefront(services, payments, state, {
    sessionId: options.sessionId ?? env.BODEGA_WALLET_ID ?? "local-demo",
    capCents: options.capCents ?? Number(env.BODEGA_CAP_CENTS ?? 1000),
    thresholdCents:
      options.thresholdCents ?? Number(env.BODEGA_THRESHOLD_CENTS ?? 100),
    humanEmail: env.BODEGA_HUMAN_EMAIL ?? "local-operator",
    publicUrl,
    paymentFlow: env.BODEGA_PAYMENT_FLOW === "mpp" ? "mpp" : "direct",
    proxy: (r) => proxy(r),
  });
  const mppHandler =
    env.BODEGA_PAYMENT_FLOW === "mpp"
      ? createMppHandler(storefront, {
          secretKey: env.STRIPE_SECRET_KEY ?? "",
          networkId: env.STRIPE_PROFILE_ID ?? "",
          challengeSecret: env.MPP_SECRET_KEY ?? "",
        })
      : null;
  proxy = createProxyHandler(services, {
    resolvePurchasedKey: (t) => storefront.resolvePurchasedKey(t),
    allowedUpstreams: {
      "primitive-email": {
        origin: "https://api.primitive.dev",
        pathPrefixes: ["/v1/send-mail", "/v1/emails"],
      },
      "inkbox-email": {
        origin: "https://inkbox.ai",
        pathPrefixes: ["/api/v1/mail/mailboxes"],
      },
      "postpigeon-email": {
        origin,
        pathPrefixes: ["/postpigeon/messages"],
        allowPrivate: true,
      },
    },
  });
  const app = express();
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    res.set({
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
    });
    const host = req.headers.host;
    if (
      !host ||
      ![
        new URL(publicUrl).host,
        "127.0.0.1:" + req.socket.localPort,
        "localhost:" + req.socket.localPort,
      ].includes(host)
    ) {
      res.status(403).json({ error: "Invalid host" });
      return;
    }
    if (req.headers.origin && req.headers.origin !== origin) {
      res.status(403).json({ error: "Invalid origin" });
      return;
    }
    next();
  });
  app.get("/health", (_req, res) =>
    res.json({
      ok: true,
      runtime: runtime.backend.mode,
      payments: payments.mode === "mock" ? "simulated" : "stripe-sandbox",
      persistence: remote?.status() ?? "local-sqlite",
      mpp: getMppReadiness({
        profileId: env.STRIPE_PROFILE_ID,
        serverConfigured: !!mppHandler,
        buyerSptConfigured: env.BODEGA_BUYER_SPT_CONFIGURED === "1",
      }),
    }),
  );
  app.get("/", async (_req, res) => {
    const nonce = randomUUID();
    res.set(
      "content-security-policy",
      `default-src 'none'; style-src 'nonce-${nonce}'; base-uri 'none'; frame-ancestors 'none'`,
    );
    const listings = await services.catalog.search("", { limit: 100 });
    const vendors = [...new Set(listings.map((l) => l.vendor_id))];
    const funnels = await Promise.all(
      vendors.map((v) => services.ledger.funnel(v).catch(() => null)),
    );
    const stats = { trials: 0, checks_passed: 0, purchases: 0, revenue_usd: 0 };
    for (const f of funnels) {
      for (const l of f?.listings ?? []) {
        stats.trials += l.trials;
        stats.checks_passed += l.checks_passed;
        stats.purchases += l.purchases;
        stats.revenue_usd += l.revenue_usd;
      }
    }
    res
      .type("html")
      .send(
        homepage(
          listings,
          {
            runtime: runtime.backend.mode,
            payments:
              payments.mode === "mock"
                ? "simulated"
                : "Stripe sandbox test card",
            backend: remote
              ? "InsForge catalog + audit; local admission"
              : "local SQLite",
          },
          nonce,
          stats,
          { publicUrl, agentTokenRequired: !!agentToken },
        ),
      );
  });
  app.get("/llms.txt", (_req, res) =>
    res
      .type("text")
      .send(
        "Bodega MCP: POST /mcp (Streamable HTTP). Tools: need, trial, run, compare, buy, wallet, review, use. Wallet budget is server-controlled and persists across reconnects. Runtime and payment simulation are explicitly labeled. Human approval tokens are never returned to agents. Use /health for MPP configuration readiness. Configured MPP purchases return a payment_url; send SPT credentials using the official MPP client. With agent authentication enabled also pass X-Bodega-Agent-Token on that payment request.",
      ),
  );
  app.post(
    "/stripe/webhook",
    express.raw({ type: "application/json", limit: "1mb" }),
    async (req, res) => {
      const notification = payments.verifyWebhook(
        req.body,
        req.get("stripe-signature") ?? "",
      );
      if (!notification) {
        res.status(400).json({ error: "Invalid or unsupported webhook" });
        return;
      }
      if (state.hasEvent(notification.eventId)) {
        res.json({ received: true, duplicate: true });
        return;
      }
      try {
        await storefront.reconcile(
          notification.paymentIntentId,
          notification.purchaseId,
        );
        state.markEvent(notification.eventId);
        res.json({ received: true });
      } catch {
        res.status(503).json({ error: "Reconciliation must retry" });
      }
    },
  );
  const sessions = new Map<
    string,
    {
      transport: StreamableHTTPServerTransport;
      server: ReturnType<typeof createStoreMcp>;
      last: number;
    }
  >();
  const agentAuthorized = (req: HttpRequest) =>
    !agentToken || same(req.get("authorization") ?? "", `Bearer ${agentToken}`);
  app.all("/mcp", express.json({ limit: "300kb" }), async (req, res) => {
    if (!agentAuthorized(req)) {
      res.status(401).json({ error: "Agent authorization required" });
      return;
    }
    const id = req.get("mcp-session-id");
    try {
      if (id) {
        const session = sessions.get(id);
        if (!session) {
          res.status(404).json({ error: "Unknown MCP session" });
          return;
        }
        session.last = Date.now();
        await session.transport.handleRequest(req, res, req.body);
        return;
      }
      if (req.method !== "POST" || !isInitializeRequest(req.body)) {
        res.status(400).json({ error: "Initialize an MCP session first" });
        return;
      }
      if (sessions.size >= 100) {
        res.status(503).json({ error: "Session limit reached" });
        return;
      }
      const server = createStoreMcp(storefront, {
        listings: await services.catalog.search("", { limit: 100 }),
        lockedTools: env.BODEGA_LOCKED_TOOLS === "1",
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, { transport, server, last: Date.now() });
        },
        enableJsonResponse: true,
      });
      transport.onclose = () => {
        if (transport.sessionId) sessions.delete(transport.sessionId);
      };
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch {
      if (!res.headersSent)
        res.status(500).json({ error: "MCP request failed" });
    }
  });
  app.get("/admin/approvals", (req, res) => {
    if (
      !adminToken ||
      adminToken.length < 24 ||
      !same(req.get("authorization") ?? "", `Bearer ${adminToken}`)
    ) {
      res.status(401).json({ error: "Administrator authorization required" });
      return;
    }
    res.json({
      delivery: "local-captured-outbox",
      messages: vendor.deliveryOutbox,
      pending: state
        .list(storefront.options.sessionId)
        .filter((p) => p.status === "needs_approval")
        .map((p) => ({
          purchase_id: p.id,
          listing_id: p.listing_id,
          amount_cents: p.amount_cents,
          approve_url: p.approval_url,
        })),
    });
  });
  app.all(
    "/mpp/:id",
    express.raw({ type: () => true, limit: "16kb" }),
    async (req, res) => {
      if (
        agentToken &&
        !same(req.get("x-bodega-agent-token") ?? "", agentToken)
      ) {
        res
          .status(401)
          .json({ error: "Agent token required in X-Bodega-Agent-Token" });
        return;
      }
      if (!mppHandler) {
        res.status(503).json({ error: "MPP is not configured" });
        return;
      }
      const web = new Request(new URL(req.originalUrl, publicUrl), {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          typeof v === "string" ? [[k, v]] : [],
        ),
      });
      await send(await mppHandler(web), res);
    },
  );
  app.use(express.raw({ type: () => true, limit: "300kb" }));
  app.use(async (req, res) => {
    try {
      const web = new Request(new URL(req.originalUrl, publicUrl), {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          typeof v === "string" ? [[k, v]] : [],
        ),
        ...(!["GET", "HEAD"].includes(req.method) && req.body?.length
          ? { body: req.body }
          : {}),
      });
      const result = (await proxy(web)) ?? (await vendor.handleRequest(web));
      if (!result) {
        res.status(404).json({ error: "Not found" });
        return;
      }
      await send(result, res);
    } catch {
      res.status(400).json({ error: "Invalid request" });
    }
  });
  app.use(
    (_error: unknown, _req: HttpRequest, res: HttpResponse, _next: unknown) =>
      res.status(400).json({ error: "Invalid or oversized request" }),
  );
  const timer = setInterval(() => {
    for (const [id, s] of sessions)
      if (Date.now() - s.last > 30 * 60_000) {
        sessions.delete(id);
        void s.server.close();
      }
  }, 60000);
  timer.unref();
  return {
    app,
    services,
    storefront,
    state,
    vendor,
    runtime,
    remote,
    async close() {
      clearInterval(timer);
      await Promise.all([...sessions.values()].map((s) => s.server.close()));
      await runtime.close();
      await remote?.close();
      state.close();
      vendor.close();
    },
  };
}
async function send(response: Response, res: HttpResponse) {
  res.status(response.status);
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}
