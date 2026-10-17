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
import type { WalletBackend } from "./store/wallet.js";
import { createWalletBackend, type WalletFactoryOptions } from "./store/insforge-wallet.js";
import {
  BODEGA_SANDBOX_ACCOUNT,
  createMockPayments,
  createStripeCliPayments,
  createStripePayments,
  getMppReadiness,
  type PaymentProvider,
} from "./store/payments.js";
import { createConfiguredVendorServices } from "./vendor/index.js";
import {
  createTrialRuntime,
  createProxyHandler,
  createBlaxelSandboxBackend,
  createSimulatedSandboxBackend,
  type SandboxBackend,
} from "./runtime/index.js";
import { connectInsforge } from "./vendor/insforge.js";
import type { Services } from "./contracts/index.js";
import {
  SqliteIdentityRepository,
  connectInsforgeIdentity,
  type IdentityRepository,
} from "./identity/repository.js";
import {
  IdentityService,
  bearer,
  customerWalletId,
  type Principal,
} from "./identity/service.js";
import { customerAdminRouter } from "./identity/admin.js";
import Stripe from "stripe";
import { MarketplaceConnect, LocalConnectRepository, InsforgeConnectRepository } from "./store/connect.js";
import { primitiveApprovalDelivery } from "./vendor/notifications.js";

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
  /** Test/deployment seam for customer identities. Defaults by BODEGA_IDENTITY_BACKEND. */
  identity?: IdentityRepository;
  identityPath?: string;
  wallet?: WalletBackend;
  walletFactory?: Omit<WalletFactoryOptions, "env" | "walletPath">;
}
const same = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export async function createApplication(options: ApplicationOptions = {}) {
  const env = options.env ?? process.env;
  const publicUrl = (
    options.publicUrl ??
    env.BODEGA_PUBLIC_URL ??
    (env.RAILWAY_PUBLIC_DOMAIN
      ? `https://${env.RAILWAY_PUBLIC_DOMAIN}`
      : "http://127.0.0.1:8787")
  ).replace(/\/$/, "");
  const origin = new URL(publicUrl).origin;
  const adminToken = options.adminToken ?? env.BODEGA_VENDOR_ADMIN_TOKEN;
  const agentToken = (options.agentToken ?? env.BODEGA_AGENT_TOKEN) || undefined;
  const identityBackend = env.BODEGA_IDENTITY_BACKEND || "sqlite";
  if (!options.identity && !["sqlite", "insforge"].includes(identityBackend))
    throw new Error("BODEGA_IDENTITY_BACKEND must be sqlite or insforge");
  if (
    !options.identity &&
    identityBackend === "insforge" &&
    !(env.INSFORGE_URL && env.INSFORGE_API_KEY)
  )
    throw new Error(
      "BODEGA_IDENTITY_BACKEND=insforge requires server-only INSFORGE_URL and INSFORGE_API_KEY",
    );
  const vendor = await createConfiguredVendorServices({
    dbPath: options.dbPath,
    publicUrl,
    adminToken,
    env,
    deliverApproval: primitiveApprovalDelivery(env, publicUrl),
  });
  const remote =
    vendor.persistence !== 'insforge-shared' && env.INSFORGE_URL && env.INSFORGE_API_KEY
      ? await connectInsforge(vendor, {
          url: env.INSFORGE_URL,
          apiKey: env.INSFORGE_API_KEY,
          publicUrl,
          outboxPath:
            env.BODEGA_SYNC_DB_PATH ?? ".bodega/insforge-outbox.sqlite",
        })
      : null;
  const walletPath =
    options.walletPath ?? env.BODEGA_WALLET_DB_PATH ?? ".bodega/payments.sqlite";
  const state = options.wallet ?? await createWalletBackend({ ...options.walletFactory, env, walletPath });
  const repository: IdentityRepository =
    options.identity ??
    (identityBackend === "insforge"
      ? connectInsforgeIdentity({
          url: env.INSFORGE_URL!,
          apiKey: env.INSFORGE_API_KEY!,
        })
      : new SqliteIdentityRepository(
          options.identityPath ??
            (env.BODEGA_IDENTITY_DB_PATH || undefined) ??
            (walletPath === ":memory:" ? ":memory:" : ".bodega/identity.sqlite"),
        ));
  const identity = new IdentityService(repository, {
    legacy: {
      sessionId: options.sessionId ?? env.BODEGA_WALLET_ID ?? "local-demo",
      capCents: options.capCents ?? Number(env.BODEGA_CAP_CENTS ?? 1000),
      thresholdCents:
        options.thresholdCents ?? Number(env.BODEGA_THRESHOLD_CENTS ?? 100),
      email: env.BODEGA_HUMAN_EMAIL ?? "local-operator",
      token: agentToken,
    },
    // Anonymous access to the legacy demo wallet exists only for local, unauthenticated demos.
    allowAnonymousLegacy:
      !agentToken &&
      identityBackend !== "insforge" &&
      env.BODEGA_REQUIRE_AGENT_AUTH !== "1",
    cacheMs: Math.min(
      60_000,
      Number(
        env.BODEGA_AUTH_CACHE_MS || (identityBackend === "insforge" ? 5000 : 0),
      ) || 0,
    ),
  });
  const basePayments =
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
  const connect = env.BODEGA_CONNECT === "1" ? new MarketplaceConnect(
    env.BODEGA_CONNECT_BACKEND === "insforge"
      ? new InsforgeConnectRepository(env.INSFORGE_URL!, env.INSFORGE_API_KEY!)
      : new LocalConnectRepository(env.BODEGA_CONNECT_DB_PATH ?? (walletPath === ":memory:" ? ":memory:" : ".bodega/connect.sqlite")),
    new Stripe(env.STRIPE_SECRET_KEY ?? "", { timeout: 15000, maxNetworkRetries: 2 }),
    vendor.catalog, publicUrl,
  ) : null;
  if (connect && (!/^(?:rk|sk)_test_[A-Za-z0-9]+$/.test(env.STRIPE_SECRET_KEY ?? "") || basePayments.mode !== "stripe")) throw new Error("Connect requires sandbox Stripe payments");
  const payments = connect ? connect.payments(basePayments) : basePayments;
  const runtime = createTrialRuntime(vendor, {
    maxTrialMinutes: env.BODEGA_MAX_TRIAL_MINUTES
      ? Number(env.BODEGA_MAX_TRIAL_MINUTES)
      : undefined,
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
  // One storefront per authenticated principal, keyed by its stable wallet ID.
  // Wallet ID, budget and approver email come only from trusted identity records.
  const storefronts = new Map<string, Promise<Storefront>>();
  const storefrontFor = (principal: Principal): Promise<Storefront> => {
    let existing = storefronts.get(principal.id);
    if (!existing) {
      existing = (async () => {
        const store = new Storefront(services, payments, state, {
          sessionId: principal.id,
          capCents: principal.capCents,
          thresholdCents: principal.thresholdCents,
          humanEmail: principal.email,
          publicUrl,
          paymentFlow: env.BODEGA_PAYMENT_FLOW === "mpp" ? "mpp" : "direct",
          primitiveInbox: env.PRIMITIVE_TRIAL_INBOX,
          proxy: (r) => proxy(r),
        });
        await store.ready;
        return store;
      })();
      storefronts.set(principal.id, existing);
      existing.catch(() => storefronts.delete(principal.id));
    }
    return existing;
  };
  const storefront = await storefrontFor(identity.legacy);
  const mppConfig =
    env.BODEGA_PAYMENT_FLOW === "mpp"
      ? {
          secretKey: env.STRIPE_SECRET_KEY ?? "",
          networkId: env.STRIPE_PROFILE_ID ?? "",
          challengeSecret: env.MPP_SECRET_KEY ?? "",
        }
      : null;
  const mppHandlers = new WeakMap<
    Storefront,
    ReturnType<typeof createMppHandler>
  >();
  const mppFor = (s: Storefront) => {
    let handler = mppHandlers.get(s);
    if (!handler) {
      handler = createMppHandler(s, mppConfig!);
      mppHandlers.set(s, handler);
    }
    return handler;
  };
  // Validates MPP configuration eagerly at startup.
  const mppHandler = mppConfig ? mppFor(storefront) : null;
  proxy = createProxyHandler(services, {
    primitiveInbox: env.PRIMITIVE_TRIAL_INBOX,
    // Paid project keys are bearer capabilities resolved globally by their HMAC;
    // possession of the key is the grant. MCP use/buy remain principal-scoped.
    resolvePurchasedKey: async (token) => {
      const p = await state.resolveToken(token);
      return p
        ? {
            listing_id: p.listing_id,
            session_id: p.session_id,
            lease_id: p.id,
            expires_at: new Date(p.expires_at).toISOString(),
            consume: async () => await state.consume(p.id),
          }
        : null;
    },
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
    const railwayHealthcheck =
      host === "healthcheck.railway.app" &&
      req.method === "GET" &&
      req.path === "/health";
    if (
      !host ||
      (!railwayHealthcheck &&
        ![
          new URL(publicUrl).host,
          "127.0.0.1:" + req.socket.localPort,
          "localhost:" + req.socket.localPort,
        ].includes(host))
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
      persistence: remote?.status() ?? vendor.persistence,
      wallet: state.kind,
      connect: { enabled: !!connect, marketplace_fee_percent: 0, charge_pattern: connect ? "destination" : null },
      identity: {
        backend: repository.mode,
        agent_credentials_required: identity.requiresCredentials,
      },
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
    res.type("html").send(
      homepage(
        await services.catalog.search("", { limit: 100 }),
        {
          runtime: runtime.backend.mode,
          payments:
            payments.mode === "mock" ? "simulated" : "Stripe sandbox test card",
          backend: vendor.persistence === 'insforge-shared' ? 'InsForge shared transactions' : remote ? "InsForge catalog + audit; local admission" : "local SQLite",
        },
        nonce,
      ),
    );
  });
  app.get("/llms.txt", (_req, res) =>
    res
      .type("text")
      .send(
        "Bodega MCP: POST /mcp (Streamable HTTP). Tools: need, trial, run, compare, buy, wallet, review, use. Wallet budget is server-controlled and persists across reconnects. Runtime and payment simulation are explicitly labeled. Each customer agent authenticates with its own administrator-issued bearer token (Authorization: Bearer bdg_agt_...); its wallet and budget are bound server-side to that customer and MCP sessions cannot be shared across customers. Human approval tokens are never returned to agents, and agent tokens cannot approve purchases. Use /health for MPP configuration readiness. Configured MPP purchases return a payment_url; send SPT credentials using the official MPP client. With agent authentication enabled also pass X-Bodega-Agent-Token on that payment request.",
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
      try {
        if (await state.hasEvent(notification.eventId)) {
          res.json({ received: true, duplicate: true });
          return;
        }
        // Reconcile in the purchase owner's storefront, never an arbitrary wallet.
        const attempt =
          (await state.byPayment(notification.paymentIntentId)) ??
          (notification.purchaseId
            ? await state.get(notification.purchaseId)
            : null);
        if (attempt) {
          const owner = await identity.principalForWallet(attempt.session_id);
          if (!owner) throw new Error("Purchase owner unavailable");
          await (
            await storefrontFor(owner)
          ).reconcile(notification.paymentIntentId, attempt.id);
        }
        await state.markEvent(notification.eventId);
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
      principalId: string;
      last: number;
    }
  >();
  const maxSessionsPerPrincipal = Math.max(
    1,
    Number(env.BODEGA_MAX_MCP_SESSIONS_PER_PRINCIPAL ?? 10) || 10,
  );
  /** undefined = identity backend unavailable; null = unauthenticated. */
  const authenticate = async (raw: string | null) => {
    try {
      return await identity.authenticate(raw);
    } catch {
      return undefined;
    }
  };
  app.all("/mcp", express.json({ limit: "300kb" }), async (req, res) => {
    const principal = await authenticate(bearer(req.get("authorization")));
    if (principal === undefined) {
      res.status(503).json({ error: "Agent authentication unavailable" });
      return;
    }
    if (!principal) {
      res.status(401).json({ error: "Agent authorization required" });
      return;
    }
    const id = req.get("mcp-session-id");
    try {
      if (id) {
        const session = sessions.get(id);
        // Another principal's session is indistinguishable from an unknown one.
        if (!session || session.principalId !== principal.id) {
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
      const own = [...sessions.entries()]
        .filter(([, s]) => s.principalId === principal.id)
        .sort((a, b) => a[1].last - b[1].last);
      // A principal at its limit loses its own oldest session, never another's.
      if (own.length >= maxSessionsPerPrincipal) {
        const [oldestId, oldest] = own[0];
        sessions.delete(oldestId);
        void oldest.server.close();
      }
      if (sessions.size >= 100) {
        res.status(503).json({ error: "Session limit reached" });
        return;
      }
      const server = createStoreMcp(await storefrontFor(principal), {
        listings: await services.catalog.search("", { limit: 100 }),
        lockedTools: env.BODEGA_LOCKED_TOOLS === "1",
      });
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: randomUUID,
        onsessioninitialized: (sessionId) => {
          sessions.set(sessionId, {
            transport,
            server,
            principalId: principal.id,
            last: Date.now(),
          });
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
  // Administrator credential only; agent tokens (legacy or customer) never satisfy it.
  const isAdmin = (req: HttpRequest) =>
    !!adminToken &&
    adminToken.length >= 24 &&
    adminToken !== agentToken &&
    same(req.get("authorization") ?? "", `Bearer ${adminToken}`);
  app.post("/admin/sellers/onboard", express.json({ limit: "8kb" }), async (req, res) => {
    if (!isAdmin(req)) { res.status(401).json({ error: "Administrator authorization required" }); return; }
    if (!connect) { res.status(503).json({ error: "Connect is not configured" }); return; }
    try {
      const body = req.body;
      if (!body || Object.keys(body).some(k => !["vendorId", "email", "displayName", "country"].includes(k)) || ![body.vendorId,body.email,body.displayName,body.country].every(v => typeof v === "string")) throw new Error("Invalid seller details");
      res.json(await connect.onboard(body));
    } catch { res.status(400).json({ error: "Seller onboarding unavailable; verify details and Connect configuration" }); }
  });
  app.get("/admin/sellers/:vendorId", async (req,res) => {
    if (!isAdmin(req)) { res.status(401).json({ error: "Administrator authorization required" }); return; }
    if (!connect) { res.status(503).json({ error: "Connect is not configured" }); return; }
    try { res.json(await connect.status(String(req.params.vendorId))); }
    catch { res.status(503).json({ error: "Seller verification unavailable" }); }
  });
  for (const page of ["refresh", "return"]) app.get(`/seller/onboarding/${page}`, (_req,res) => {
    res.type("text").send(page === "refresh" ? "Your Stripe onboarding link expired. Ask your Bodega operator for a fresh authenticated onboarding link." : "Stripe onboarding returned to Bodega. Your operator must verify transfer eligibility before enabling checkout; returning here does not prove onboarding is complete.");
  });
  app.get("/admin/approvals", async (req, res) => {
    if (!isAdmin(req)) {
      res.status(401).json({ error: "Administrator authorization required" });
      return;
    }
    try {
      const owners = [
        {
          wallet: identity.legacy.id,
          customer_id: null as string | null,
          approver: identity.legacy.email,
        },
        ...(await identity.listCustomers()).map((c) => ({
          wallet: customerWalletId(c.id),
          customer_id: c.id as string | null,
          approver: c.email,
        })),
      ];
      const pending = [];
      for (const owner of owners)
        for (const p of await state.list(owner.wallet))
          if (p.status === "needs_approval")
            pending.push({
              purchase_id: p.id,
              customer_id: owner.customer_id,
              approver_email: owner.approver,
              listing_id: p.listing_id,
              amount_cents: p.amount_cents,
              approve_url: p.approval_url,
            });
      res.json({
        delivery: "local-captured-outbox",
        messages: 'deliveryOutbox' in vendor ? vendor.deliveryOutbox : [],
        notifications: await vendor.notifications.list({limit:50}),
        pending,
      });
    } catch {
      res.status(503).json({ error: "Approval inbox unavailable" });
    }
  });
  app.use(customerAdminRouter(identity, { publicUrl, isAdmin }));
  app.all(
    "/mpp/:id",
    express.raw({ type: () => true, limit: "16kb" }),
    async (req, res) => {
      const header = req.get("x-bodega-agent-token");
      const principal = await authenticate(
        header === undefined ? null : header,
      );
      if (principal === undefined) {
        res.status(503).json({ error: "Agent authentication unavailable" });
        return;
      }
      if (!principal) {
        res
          .status(401)
          .json({ error: "Agent token required in X-Bodega-Agent-Token" });
        return;
      }
      if (!mppHandler) {
        res.status(503).json({ error: "MPP is not configured" });
        return;
      }
      // The principal's handler rejects purchases owned by any other wallet.
      const handler = mppFor(await storefrontFor(principal));
      const web = new Request(new URL(req.originalUrl, publicUrl), {
        method: req.method,
        headers: Object.entries(req.headers).flatMap(([k, v]) =>
          typeof v === "string" ? [[k, v]] : [],
        ),
      });
      await send(await handler(web), res);
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
    storefrontFor,
    identity,
    state,
    vendor,
    runtime,
    remote,
    connect,
    async close() {
      clearInterval(timer);
      await Promise.all([...sessions.values()].map((s) => s.server.close()));
      await runtime.close();
      await remote?.close();
      await state.close();
      await repository.close();
      connect?.repository.close();
      vendor.close();
    },
  };
}
async function send(response: Response, res: HttpResponse) {
  res.status(response.status);
  response.headers.forEach((v, k) => res.setHeader(k, v));
  res.end(Buffer.from(await response.arrayBuffer()));
}
