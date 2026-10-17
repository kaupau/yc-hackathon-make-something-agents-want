import { resolve } from "node:path";
import type { UpstreamConfig } from "../contracts/index.js";
import { VENDORS } from "../mocks/seed.js";
import { DurableCatalog, DurableLedger, QuotaExceededError } from "./data.js";
import { DemoDatabase } from "./persistence.js";
import { createVendorRoutes, type ApprovalView, type NotificationOutbox, type NotificationView, type VendorRouteDeps } from "./routes.js";
import { SecureApprovals, SecureVault, type ApprovalMessage } from "./security.js";
import { createSharedVendorServices, parseMaxActiveTrials, type SharedVendorServicesOptions } from "./shared.js";

export { DurableCatalog, DurableLedger, QuotaExceededError, SecureApprovals, SecureVault, createVendorRoutes, createSharedVendorServices, parseMaxActiveTrials };
export type { ApprovalMessage, ApprovalView, NotificationOutbox, NotificationView, VendorRouteDeps, SharedVendorServicesOptions };
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

/** Local outbox projection: same safe shape as the shared outbox, without approval URLs. */
function localNotifications(outbox: ApprovalMessage[]): NotificationOutbox {
  return {
    async list(opts = {}) {
      const items: NotificationView[] = outbox.map((m, i) => ({ id: `local-${i}`, kind: "approval_request", purchase_id: m.purchase_id, recipient: m.to, subject: m.subject, status: "captured", attempts: 0, last_error: null, created_at: "", updated_at: "", delivered_at: null }));
      const filtered = items.filter(n => !opts.status || n.status === opts.status).reverse().slice(0, Math.max(0, Math.min(opts.limit ?? 50, 200)));
      const counts: Record<string, number> = items.length ? { captured: items.length } : {};
      return { counts, notifications: filtered };
    },
  };
}

export function createVendorServices(options: VendorServicesOptions = {}) {
  const env = options.env ?? process.env;
  const publicUrl = (options.publicUrl ?? env.BODEGA_PUBLIC_URL ?? "http://localhost:8787").replace(/\/$/, "");
  const now = options.now ?? Date.now;
  const ttl = options.approvalTtlMs ?? 15*60_000;
  if (!Number.isFinite(ttl) || ttl <= 0) throw new Error("Invalid approval TTL");
  const db = new DemoDatabase(options.dbPath ?? env.BODEGA_VENDOR_DB_PATH ?? resolve(".bodega/vendor-demo.sqlite"));
  const catalog = new DurableCatalog(db, publicUrl);
  const maxActive = parseMaxActiveTrials(env);
  const ledger = new DurableLedger(db, now, maxActive ?? Infinity);
  const vault = new SecureVault(db, now, publicUrl, env, options.upstreams, options.fetcher);
  const approvals = new SecureApprovals(db, publicUrl, now, ttl, options.deliverApproval);
  const notifications = localNotifications(approvals.outbox);
  const handleRequest = createVendorRoutes({ catalog, ledger, approvals, vault, notifications, vendors: VENDORS, publicUrl, adminToken: options.adminToken ?? env.BODEGA_VENDOR_ADMIN_TOKEN, persistence: "local-demo-sqlite" });
  return { catalog, vault, ledger, approvals, notifications, handleRequest, close: () => db.close(), deliveryOutbox: approvals.outbox, persistence: "local-demo-sqlite" as const };
}

export type LocalVendorServices = ReturnType<typeof createVendorServices>;
export type SharedVendorServices = Awaited<ReturnType<typeof createSharedVendorServices>>;

/**
 * Backend selector. BODEGA_VENDOR_BACKEND=insforge selects the shared, authoritative InsForge backend
 * (requires INSFORGE_URL, INSFORGE_API_KEY and BODEGA_VENDOR_KEY_SECRET). Anything else, including unset,
 * keeps the local SQLite default.
 */
export async function createConfiguredVendorServices(options: VendorServicesOptions & Omit<SharedVendorServicesOptions, keyof VendorServicesOptions> = {}): Promise<LocalVendorServices | SharedVendorServices> {
  const env = options.env ?? process.env;
  const backend = (env.BODEGA_VENDOR_BACKEND ?? "sqlite").trim().toLowerCase();
  if (backend === "insforge") return createSharedVendorServices(options);
  if (backend !== "sqlite" && backend !== "local" && backend !== "") throw new Error("Unsupported BODEGA_VENDOR_BACKEND");
  return createVendorServices(options);
}
