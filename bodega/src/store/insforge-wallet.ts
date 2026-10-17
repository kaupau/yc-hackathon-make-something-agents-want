import { createAdminClient } from "@insforge/sdk";
import { createHmac, timingSafeEqual } from "node:crypto";
import {
  StoreError,
  WalletStore,
  cents,
  digest,
  signProjectKey,
  validPurchase,
  type Attempt,
  type AttemptStatus,
  type WalletBackend,
  type WalletView,
} from "./wallet.js";

/** Minimal RPC seam: the InsForge admin client in production, a fake or psql harness in tests. */
export type WalletRpc = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { message?: string } | null }>;

export interface InsforgeWalletOptions {
  rpc: WalletRpc;
  /** Shared project-key signing secret (BODEGA_PROJECT_KEY_SECRET), at least 32 bytes. */
  keySecret: Buffer;
  /** Charging lease length; the database clock is authoritative. */
  leaseMs?: number;
}

const STATUSES: readonly AttemptStatus[] = [
  "needs_approval",
  "ready",
  "charging",
  "pending",
  "paid",
  "declined",
];
const MESSAGES: Record<string, string> = {
  INVALID_POLICY: "Invalid wallet policy",
  INVALID_PURCHASE: "Invalid purchase or amount below $0.50",
  NO_WALLET: "Wallet unavailable",
  IDEMPOTENCY_CONFLICT: "Purchase terms changed; use an explicit new request ID",
  BUDGET_EXCEEDED: "Purchase exceeds the remaining human budget",
  NO_PURCHASE: "Purchase unavailable",
  NO_RECEIPT: "Verified payment identifier required",
  RECEIPT_CONFLICT: "Payment identifier conflicts with the recorded attempt",
  APPROVAL_REQUIRED: "Human approval required",
  INVALID_STATUS: "Invalid payment status",
};
const unavailable = () =>
  new StoreError("WALLET_UNAVAILABLE", "Shared wallet unavailable; retry");
const corrupt = () =>
  new StoreError("WALLET_CORRUPT", "Shared wallet returned an invalid record");

/** Accepts JSON numbers or digit strings (bigint transports) but only within the safe-integer range. */
function safeInt(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string" && /^-?\d{1,16}$/.test(value)
        ? Number(value)
        : NaN;
  if (!Number.isSafeInteger(n)) throw corrupt();
  return n;
}
const text = (value: unknown) => {
  if (typeof value !== "string") throw corrupt();
  return value;
};
const nullableText = (value: unknown) =>
  value === null || value === undefined ? null : text(value);

export function parseAttempt(raw: unknown): Attempt {
  if (!raw || typeof raw !== "object") throw corrupt();
  const r = raw as Record<string, unknown>;
  const status = text(r.status) as AttemptStatus;
  if (!STATUSES.includes(status) || r.currency !== "usd") throw corrupt();
  const attempt: Attempt = {
    id: text(r.id),
    session_id: text(r.session_id),
    listing_id: text(r.listing_id),
    request_id: text(r.request_id),
    amount_cents: safeInt(r.amount_cents),
    currency: "usd",
    status,
    idempotency_key: text(r.idempotency_key),
    payment_intent_id: nullableText(r.payment_intent_id),
    approval_url: nullableText(r.approval_url),
    error: nullableText(r.error),
    payment_mode: text(r.payment_mode),
    credit_limit: safeInt(r.credit_limit),
    credits_used: safeInt(r.credits_used),
    expires_at: safeInt(r.expires_at),
    created_at: safeInt(r.created_at),
    lease_until: safeInt(r.lease_until),
    key_hash: nullableText(r.key_hash),
  };
  if (attempt.amount_cents < 0 || attempt.credits_used > attempt.credit_limit)
    throw corrupt();
  return attempt;
}

export const keyFingerprint = (secret: Buffer) =>
  createHmac("sha256", secret)
    .update("bodega-project-key-fingerprint:v1")
    .digest("hex");

/**
 * Shared InsForge/Postgres wallet. Every admission decision is one atomic RPC defined in
 * migrations/20261017210001_shared-wallet.sql. Raw project keys and MPP credentials never
 * leave the process: only SHA-256 digests are sent. Transport failures surface as
 * WALLET_UNAVAILABLE and are never retried automatically (consume/claim are not idempotent).
 */
export class InsforgeWalletStore implements WalletBackend {
  readonly kind = "insforge" as const;
  private readonly rpc: WalletRpc;
  private readonly secret: Buffer;
  private readonly leaseMs: number;
  private connected?: Promise<void>;
  constructor(options: InsforgeWalletOptions) {
    if (!Buffer.isBuffer(options.keySecret) || options.keySecret.length < 32)
      throw new Error("BODEGA_PROJECT_KEY_SECRET must be at least 32 bytes");
    this.rpc = options.rpc;
    this.secret = Buffer.from(options.keySecret);
    this.leaseMs = options.leaseMs ?? 60000;
  }
  /** Registers (first node) or verifies (later nodes) the shared signing-key fingerprint. */
  connect(): Promise<void> {
    this.connected ??= (async () => {
      const ok = await this.call("bodega_wallet_register_key", {
        p_fingerprint: keyFingerprint(this.secret),
      });
      if (ok !== true)
        throw new Error(
          "BODEGA_PROJECT_KEY_SECRET does not match the shared wallet signing key",
        );
    })();
    this.connected.catch(() => {
      this.connected = undefined;
    });
    return this.connected;
  }
  private async call(fn: string, args: Record<string, unknown>) {
    let result: Awaited<ReturnType<WalletRpc>>;
    try {
      result = await this.rpc(fn, args);
    } catch {
      throw unavailable();
    }
    if (!result || result.error) throw unavailable();
    return result.data;
  }
  /** Mutations return `{attempt}` or `{error: CODE}`; codes map to StoreError. */
  private async attemptCall(fn: string, args: Record<string, unknown>) {
    await this.connect();
    const data = await this.call(fn, args);
    if (!data || typeof data !== "object") throw corrupt();
    const d = data as { attempt?: unknown; error?: unknown };
    if (typeof d.error === "string")
      throw new StoreError(d.error, MESSAGES[d.error] ?? "Wallet rejected");
    return parseAttempt(d.attempt);
  }
  private async maybeAttempt(fn: string, args: Record<string, unknown>) {
    await this.connect();
    const data = await this.call(fn, args);
    return data === null || data === undefined ? null : parseAttempt(data);
  }
  private async bool(fn: string, args: Record<string, unknown>) {
    await this.connect();
    const data = await this.call(fn, args);
    if (typeof data !== "boolean") throw corrupt();
    return data;
  }
  async ensureSession(
    sessionId: string,
    capCents: number,
    thresholdCents: number,
  ) {
    if (
      !sessionId ||
      !cents(capCents) ||
      !cents(thresholdCents) ||
      thresholdCents > capCents
    )
      throw new StoreError("INVALID_POLICY", "Invalid wallet policy");
    await this.connect();
    const data = (await this.call("bodega_wallet_ensure_session", {
      p_session_id: sessionId,
      p_cap_cents: capCents,
      p_threshold_cents: thresholdCents,
    })) as { error?: string; cap_cents?: unknown } | null;
    if (!data || typeof data !== "object") throw corrupt();
    if (typeof data.error === "string")
      throw new StoreError(data.error, MESSAGES[data.error] ?? "Invalid");
    safeInt(data.cap_cents);
  }
  get(id: string) {
    return this.maybeAttempt("bodega_wallet_get", { p_id: id });
  }
  byPayment(id: string) {
    return this.maybeAttempt("bodega_wallet_by_payment", { p_payment_id: id });
  }
  async list(sessionId: string) {
    await this.connect();
    const data = await this.call("bodega_wallet_list", {
      p_session_id: sessionId,
    });
    if (!Array.isArray(data)) throw corrupt();
    return data.map(parseAttempt);
  }
  async view(sessionId: string): Promise<WalletView> {
    await this.connect();
    const data = (await this.call("bodega_wallet_view", {
      p_session_id: sessionId,
    })) as Record<string, unknown> | null;
    if (!data || typeof data !== "object") throw corrupt();
    if (data.error === "NO_WALLET")
      throw new StoreError("NO_WALLET", "Wallet unavailable");
    if (!Array.isArray(data.purchases)) throw corrupt();
    const view: WalletView = {
      session_id: text(data.session_id),
      cap_cents: safeInt(data.cap_cents),
      threshold_cents: safeInt(data.threshold_cents),
      spent_cents: safeInt(data.spent_cents),
      reserved_cents: safeInt(data.reserved_cents),
      remaining_cents: safeInt(data.remaining_cents),
      purchases: data.purchases.map(parseAttempt),
    };
    if (
      view.remaining_cents !==
      view.cap_cents - view.spent_cents - view.reserved_cents
    )
      throw corrupt();
    return view;
  }
  reserve(
    sessionId: string,
    listingId: string,
    amountCents: number,
    requestId = "initial",
    creditLimit = 1000,
    paymentMode = "mock:direct",
  ) {
    if (!validPurchase(amountCents, creditLimit, requestId))
      return Promise.reject(
        new StoreError("INVALID_PURCHASE", MESSAGES.INVALID_PURCHASE),
      );
    return this.attemptCall("bodega_wallet_reserve", {
      p_session_id: sessionId,
      p_listing_id: listingId,
      p_amount_cents: amountCents,
      p_request_id: requestId,
      p_credit_limit: creditLimit,
      p_payment_mode: paymentMode,
    });
  }
  async setApproval(id: string, url: string) {
    await this.maybeAttempt("bodega_wallet_set_approval", {
      p_id: id,
      p_url: url,
    });
  }
  async approve(id: string) {
    await this.maybeAttempt("bodega_wallet_approve", { p_id: id });
  }
  async decline(id: string, reason: string) {
    await this.maybeAttempt("bodega_wallet_decline", {
      p_id: id,
      p_reason: reason,
    });
  }
  claim(id: string) {
    return this.bool("bodega_wallet_claim", {
      p_id: id,
      p_lease_ms: this.leaseMs,
    });
  }
  finish(
    id: string,
    status: "paid" | "pending" | "declined",
    paymentId?: string,
    error?: string,
  ) {
    return this.attemptCall("bodega_wallet_finish", {
      p_id: id,
      p_status: status,
      p_payment_id: paymentId ?? null,
      p_error: error ?? null,
      // Only the digest of the project key is persisted; the key itself is derived on demand.
      p_key_hash: status === "paid" ? digest(this.tokenFor(id)) : null,
    });
  }
  tokenFor(id: string) {
    return signProjectKey(this.secret, id);
  }
  async resolveToken(token: string) {
    if (typeof token !== "string" || token.length > 512) return null;
    const row = await this.maybeAttempt("bodega_wallet_resolve_key", {
      p_key_hash: digest(token),
    });
    if (!row) return null;
    const expected = Buffer.from(this.tokenFor(row.id));
    const actual = Buffer.from(token);
    return actual.length === expected.length &&
      timingSafeEqual(actual, expected)
      ? row
      : null;
  }
  consume(id: string) {
    return this.bool("bodega_wallet_consume", { p_id: id });
  }
  bindMppCredential(id: string, credential: string) {
    return this.bool("bodega_wallet_bind_mpp_credential", {
      p_id: id,
      p_credential_hash: digest(credential),
    });
  }
  hasEvent(eventId: string) {
    return this.bool("bodega_wallet_has_event", { p_event_id: eventId });
  }
  async markEvent(eventId: string) {
    await this.bool("bodega_wallet_mark_event", { p_event_id: eventId });
  }
  isFulfilled(id: string) {
    return this.bool("bodega_wallet_is_fulfilled", { p_id: id });
  }
  async markFulfilled(id: string) {
    await this.bool("bodega_wallet_mark_fulfilled", { p_id: id });
  }
  close() {}
}

/** InsForge admin-client RPC with a per-call timeout. Server-only: the API key never leaves the process. */
export function insforgeRpc(
  url: string,
  apiKey: string,
  timeoutMs = 10000,
): WalletRpc {
  const client = createAdminClient({ baseUrl: url, apiKey });
  return async (fn, args) => {
    const { data, error } = await client.database
      .rpc(fn, args)
      .abortSignal(AbortSignal.timeout(timeoutMs));
    return { data, error };
  };
}

export interface WalletFactoryOptions {
  env?: NodeJS.ProcessEnv;
  /** SQLite path for the default local backend. */
  walletPath?: string;
  /** Test seam: replaces the InsForge admin client. */
  rpc?: WalletRpc;
  leaseMs?: number;
}

/**
 * Local SQLite stays the default. Set BODEGA_WALLET_BACKEND=insforge with INSFORGE_URL,
 * INSFORGE_API_KEY and BODEGA_PROJECT_KEY_SECRET (>= 32 bytes, identical on every node).
 */
export async function createWalletBackend(
  options: WalletFactoryOptions = {},
): Promise<WalletBackend> {
  const env = options.env ?? process.env;
  const mode = env.BODEGA_WALLET_BACKEND ?? "sqlite";
  if (mode === "sqlite" || mode === "local")
    return new WalletStore(
      options.walletPath ??
        env.BODEGA_WALLET_DB_PATH ??
        ".bodega/payments.sqlite",
    );
  if (mode !== "insforge")
    throw new Error(`Unsupported BODEGA_WALLET_BACKEND: ${mode}`);
  const secret = env.BODEGA_PROJECT_KEY_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32)
    throw new Error(
      "BODEGA_WALLET_BACKEND=insforge requires BODEGA_PROJECT_KEY_SECRET of at least 32 bytes",
    );
  let rpc = options.rpc;
  if (!rpc) {
    if (!env.INSFORGE_URL || !env.INSFORGE_API_KEY)
      throw new Error(
        "BODEGA_WALLET_BACKEND=insforge requires INSFORGE_URL and INSFORGE_API_KEY",
      );
    rpc = insforgeRpc(env.INSFORGE_URL, env.INSFORGE_API_KEY);
  }
  const store = new InsforgeWalletStore({
    rpc,
    keySecret: Buffer.from(secret),
    leaseMs: options.leaseMs,
  });
  await store.connect();
  return store;
}
