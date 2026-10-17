// Shared types for all three streams. Change only by team agreement, in one PR.
// A = store (MCP server), B = runtime (sandboxes, proxy, compare), C = vendor (data, portal, approvals).

export type ListingId = string;
export type VendorId = string;
export type SessionId = string;
export type CheckId = string; // e.g. "email.roundtrip"

export type Category =
  | "email"
  | "database"
  | "auth"
  | "voice"
  | "search"
  | "queue"
  | "phone"
  | "human"
  | (string & {});

export interface Vendor {
  id: VendorId;
  name: string;
  website: string;
  contact_email: string;
}

export type TrialUnit = "api_calls" | "sandbox_minutes" | "runs";

/** What the vendor funds. Bodega enforces it in the metering proxy (B) via Ledger.recordUsage (C). */
export interface TrialPolicy {
  unit: TrialUnit;
  per_agent: number; // allotment per agent session
  pool_total: number; // vendor's total funded pool, in `unit`
  pool_used: number;
  expires_after_min: number; // trial TTL
  max_concurrent: number;
}

export interface SandboxSetup {
  image: string; // Blaxel image, e.g. "blaxel/base-image:latest"
  install: string[]; // shell commands run once at sandbox creation
  env_hint: Record<string, string>; // env var name -> what it holds (shown to the agent)
}

/** Public listing: safe to return to agents. Secrets live in UpstreamConfig, never here. */
export interface Listing {
  id: ListingId;
  vendor_id: VendorId;
  name: string;
  category: Category;
  one_line: string;
  keywords: string[];
  docs_url: string;
  quickstart: string; // short snippet using BODEGA_TOOL_BASE_URL / BODEGA_TOOL_KEY
  sandbox: SandboxSetup | null; // null = no sandbox trial (buy-only capability)
  checks: CheckId[]; // standard checks this listing supports
  trial: TrialPolicy | null; // null = no trial, buy only
  price: { buy_usd: number; unit_label: string }; // what buy() charges the human, e.g. 2.00 "1,000 emails"
  adds_tools: string[]; // tools enabled in the session after buy()
  real: boolean; // false = mocked vendor (seed data)
}

export type CredentialMode =
  | { kind: "pooled_key"; env_var: string } // vendor gave Bodega one restricted key, read from env
  | { kind: "provision_webhook"; url: string; revoke_url?: string }; // vendor mints a scoped key per trial

/** Secret side of a listing. Held by Vault (C), read by the metering proxy (B). Never sent to agents. */
export interface UpstreamConfig {
  listing_id: ListingId;
  base_url: string; // e.g. "https://api.primitive.dev/v1"
  auth: { header: string; format: string }; // e.g. { header: "Authorization", format: "Bearer {key}" }
  credential: CredentialMode;
}

export interface Lease {
  secret: string; // the real upstream credential; stays inside the proxy
  expires_at: string; // ISO
}

export type TrialStatus = "provisioning" | "active" | "exhausted" | "expired" | "ended";

export interface Trial {
  id: string;
  listing_id: ListingId;
  session_id: SessionId;
  sandbox_id: string | null;
  status: TrialStatus;
  used: number;
  limit: number;
  unit: TrialUnit;
  token: string; // Bodega trial token the sandbox presents to /proxy; never the vendor key
  started_at: string;
  expires_at: string;
}

export interface RunRequest {
  trial_id: string;
  command?: string; // shell command
  file?: { path: string; content: string }; // written before `command` runs
  timeout_s?: number;
}

export interface QuotaView {
  used: number;
  limit: number;
  unit: TrialUnit;
}

export interface RunResult {
  trial_id: string;
  exit_code: number;
  stdout: string; // trimmed for tokens
  stderr: string; // trimmed for tokens
  duration_ms: number;
  quota: QuotaView;
}

export interface CheckSpec {
  id: CheckId;
  category: Category;
  description: string;
  metrics: string[]; // metric names a CheckResult reports, e.g. ["send_ms", "deliver_ms"]
}

export interface CheckResult {
  listing_id: ListingId;
  trial_id: string;
  ok: boolean;
  metrics: Record<string, number>;
  loc: number; // lines of code the adapter needed
  error?: string;
  logs_tail: string;
}

export interface ComparisonReport {
  id: string;
  check_id: CheckId;
  session_id: SessionId;
  results: CheckResult[];
  suggestion: ListingId | null;
  reason: string;
  created_at: string;
}

export type Verdict = "chosen" | "rejected" | "neutral";

export interface Review {
  id: string;
  listing_id: ListingId;
  session_id: SessionId;
  verdict: Verdict;
  reason: string;
  compared_with: ListingId[];
  source: "agent" | "auto";
  created_at: string;
}

export type PurchaseStatus = "paid" | "needs_approval" | "declined";

export interface Purchase {
  id: string;
  listing_id: ListingId;
  session_id: SessionId;
  amount_usd: number;
  status: PurchaseStatus;
  receipt_id?: string; // MPP receipt or Stripe PaymentIntent id once paid
  approve_url?: string;
  project_key?: string; // metered key for the repo, served by the same proxy
  created_at: string;
}

export interface WalletView {
  session_id: SessionId;
  cap_usd: number;
  threshold_usd: number;
  spent_usd: number;
  remaining_usd: number;
  purchases: Purchase[];
  trials: Array<{ listing_id: ListingId; used: number; limit: number; unit: TrialUnit; funded_by: string }>;
}

export interface ListingFunnel {
  listing_id: ListingId;
  trials: number;
  checks_run: number;
  checks_passed: number;
  chosen: number;
  rejected: number;
  purchases: number;
  revenue_usd: number;
  top_reasons: string[];
}

export interface VendorFunnel {
  vendor_id: VendorId;
  listings: ListingFunnel[];
}

export type ApprovalStatus = "pending" | "approved" | "declined";
