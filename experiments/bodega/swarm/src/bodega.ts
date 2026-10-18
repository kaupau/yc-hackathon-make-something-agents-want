import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { VendorFunnel } from "./events.js";

const here = path.dirname(fileURLToPath(import.meta.url));
export const BODEGA_DIR = path.resolve(here, "../../../../bodega");

export interface Health { ok: boolean; runtime: string; payments: string; identity?: { agent_credentials_required: boolean } }
export interface PendingApproval { purchase_id: string; customer_id: string | null; listing_id: string; amount_cents: number; approve_url: string }

/** Operator-side calls. The admin token never reaches an agent. */
export class BodegaAdmin {
  constructor(readonly url: string, private readonly adminToken: string) {}
  private async json<T>(p: string, init: RequestInit = {}): Promise<T> {
    const response = await fetch(`${this.url}${p}`, { ...init, headers: { authorization: `Bearer ${this.adminToken}`, "content-type": "application/json", ...init.headers } });
    const body = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${init.method ?? "GET"} ${p} → ${response.status} ${(body as { error?: string }).error ?? ""}`.trim());
    return body as T;
  }
  health() { return this.json<Health>("/health"); }
  async createCustomer(id: string, email: string, capCents: number, thresholdCents: number) {
    const r = await this.json<{ agent_credential: { token: string } }>("/admin/customers", { method: "POST", body: JSON.stringify({ id, email, cap_cents: capCents, threshold_cents: thresholdCents, token_ttl_days: 1 }) });
    return r.agent_credential.token;
  }
  async pendingApprovals() { return (await this.json<{ pending: PendingApproval[] }>("/admin/approvals")).pending; }
  /** The human's one-use approval link. A GET only shows the purchase; the decision is a POST. */
  async decide(approveUrl: string, decision: "approved" | "declined") {
    const response = await fetch(approveUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ decision }) });
    if (!response.ok) throw new Error(`Approval ${decision} failed: ${response.status}`);
  }
  async vendors(): Promise<string[]> {
    const r = await this.json<{ listings: { vendor_id: string }[] }>("/portal/catalog");
    return [...new Set(r.listings.map(l => l.vendor_id))];
  }
  funnel(vendor: string) { return this.json<VendorFunnel>(`/portal/funnel/${encodeURIComponent(vendor)}`); }
}

/**
 * Boots a private local Bodega: simulated runtime, simulated payments, per-customer agent
 * auth required, all state in dataDir. Nothing here touches Stripe, Blaxel or a real inbox.
 */
export async function bootLocalBodega(opts: { port: number; dataDir: string; adminToken: string; log?: (line: string) => void }): Promise<{ url: string; stop: () => Promise<void> }> {
  if (!existsSync(path.join(BODEGA_DIR, "node_modules"))) throw new Error(`Bodega dependencies are missing: run "npm ci" in ${BODEGA_DIR}`);
  mkdirSync(opts.dataDir, { recursive: true });
  const url = `http://127.0.0.1:${opts.port}`;
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH, HOME: process.env.HOME,
    HOST: "127.0.0.1", PORT: String(opts.port), BODEGA_PUBLIC_URL: url,
    BODEGA_VENDOR_ADMIN_TOKEN: opts.adminToken, BODEGA_REQUIRE_AGENT_AUTH: "1",
    BODEGA_PAYMENTS: "mock", BODEGA_PAYMENT_FLOW: "direct", BODEGA_RUNTIME: "simulated",
    BODEGA_WALLET_DB_PATH: path.join(opts.dataDir, "payments.sqlite"),
    BODEGA_IDENTITY_DB_PATH: path.join(opts.dataDir, "identity.sqlite"),
    BODEGA_VENDOR_DB_PATH: path.join(opts.dataDir, "vendor.sqlite"),
    BODEGA_CONNECT_DB_PATH: path.join(opts.dataDir, "connect.sqlite"),
    BODEGA_MAX_MCP_SESSIONS_PER_PRINCIPAL: "4",
    NODE_NO_WARNINGS: "1",
  };
  // --env-file-if-exists is deliberately absent: a developer's bodega/.env must not leak in.
  const child: ChildProcess = spawn(process.execPath, ["--import", "tsx", "src/main.ts"], { cwd: BODEGA_DIR, env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  const collect = (chunk: Buffer) => { output += chunk; for (const line of String(chunk).split("\n").filter(Boolean)) opts.log?.(line); };
  child.stdout!.on("data", collect);
  child.stderr!.on("data", collect);
  const exited = new Promise<number | null>(resolve => child.once("exit", resolve));
  const deadline = Date.now() + 45_000;
  while (true) {
    if (child.exitCode !== null) throw new Error(`Bodega exited during startup:\n${output}`);
    try { if ((await fetch(`${url}/health`)).ok) break; } catch { /* not listening yet */ }
    if (Date.now() > deadline) { child.kill(); throw new Error(`Bodega did not become healthy:\n${output}`); }
    await new Promise(r => setTimeout(r, 250));
  }
  return { url, stop: async () => { if (child.exitCode === null) { child.kill("SIGTERM"); await exited; } } };
}
