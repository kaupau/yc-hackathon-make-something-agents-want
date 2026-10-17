import { DatabaseSync } from "node:sqlite";
import {
  randomUUID,
  randomBytes,
  createHash,
  createHmac,
  timingSafeEqual,
} from "node:crypto";
import {
  mkdirSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

export type AttemptStatus =
  "needs_approval" | "ready" | "charging" | "pending" | "paid" | "declined";
export interface Attempt {
  id: string;
  session_id: string;
  listing_id: string;
  request_id: string;
  amount_cents: number;
  currency: "usd";
  status: AttemptStatus;
  idempotency_key: string;
  payment_intent_id: string | null;
  approval_url: string | null;
  error: string | null;
  payment_mode: string;
  credit_limit: number;
  credits_used: number;
  expires_at: number;
  created_at: number;
  lease_until: number;
  key_hash: string | null;
}
export class StoreError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export type MaybePromise<T> = T | Promise<T>;
export interface WalletView {
  session_id: string;
  cap_cents: number;
  threshold_cents: number;
  spent_cents: number;
  reserved_cents: number;
  remaining_cents: number;
  purchases: Attempt[];
}
/**
 * Wallet admission authority. Implementations may be synchronous (local SQLite) or
 * asynchronous (shared InsForge/Postgres); callers must always `await` results.
 * Invariants every backend keeps:
 * - ensureSession never resets or replenishes an existing wallet.
 * - reserve is idempotent per (session, listing, request) and rejects changed amount/payment mode.
 * - every non-declined attempt (pending/charging included) holds budget; paid is never downgraded.
 * - paid requires a receipt whose prefix matches the attempt payment mode.
 * - a receipt binds to at most one attempt and never changes once recorded.
 * - claim grants one lease at a time; consume/credential/event/fulfilled markers are atomic.
 */
export interface WalletBackend {
  readonly kind: "local-sqlite" | "insforge";
  ensureSession(
    sessionId: string,
    capCents: number,
    thresholdCents: number,
  ): MaybePromise<void>;
  get(id: string): MaybePromise<Attempt | null>;
  byPayment(id: string): MaybePromise<Attempt | null>;
  list(sessionId: string): MaybePromise<Attempt[]>;
  view(sessionId: string): MaybePromise<WalletView>;
  reserve(
    sessionId: string,
    listingId: string,
    amountCents: number,
    requestId?: string,
    creditLimit?: number,
    paymentMode?: string,
  ): MaybePromise<Attempt>;
  setApproval(id: string, url: string): MaybePromise<void>;
  approve(id: string): MaybePromise<void>;
  decline(id: string, reason: string): MaybePromise<void>;
  claim(id: string): MaybePromise<boolean>;
  finish(
    id: string,
    status: "paid" | "pending" | "declined",
    paymentId?: string,
    error?: string,
  ): MaybePromise<Attempt>;
  /** Deterministic project key; a pure function of the (shared) signing secret. */
  tokenFor(id: string): string;
  resolveToken(token: string): MaybePromise<Attempt | null>;
  consume(id: string): MaybePromise<boolean>;
  bindMppCredential(id: string, credential: string): MaybePromise<boolean>;
  hasEvent(eventId: string): MaybePromise<boolean>;
  markEvent(eventId: string): MaybePromise<void>;
  isFulfilled(id: string): MaybePromise<boolean>;
  markFulfilled(id: string): MaybePromise<void>;
  close(): MaybePromise<void>;
}
export const cents = (value: number) =>
  Number.isSafeInteger(value) && value >= 0;
export const digest = (s: string) =>
  createHash("sha256").update(s).digest("hex");
export const REQUEST_ID = /^[a-zA-Z0-9_-]{1,128}$/;
export const signProjectKey = (secret: Buffer, id: string) =>
  `bdg_live_${id}_${createHmac("sha256", secret).update(id).digest("base64url")}`;
/** A receipt must match its payment-mode family: a mock receipt never settles a Stripe attempt. */
export const receiptMatchesMode = (mode: string, paymentId: string) =>
  mode.startsWith("mock:")
    ? /^mock_[A-Za-z0-9]{1,255}$/.test(paymentId)
    : mode.startsWith("stripe:")
      ? /^pi_[A-Za-z0-9_]{1,255}$/.test(paymentId)
      : false;
export const validPurchase = (
  amountCents: number,
  creditLimit: number,
  requestId: string,
) =>
  Number.isSafeInteger(amountCents) &&
  amountCents >= 50 &&
  Number.isSafeInteger(creditLimit) &&
  creditLimit >= 1 &&
  REQUEST_ID.test(requestId);

/** Local durable demo wallet. All reservations/admissions use SQLite transactions. */
export class WalletStore implements WalletBackend {
  readonly kind = "local-sqlite" as const;
  readonly db: DatabaseSync;
  private secret: Buffer;
  constructor(
    path = resolve(".bodega/payments.sqlite"),
    private now = Date.now,
    keySecret?: Buffer,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS wallets(session_id TEXT PRIMARY KEY,cap_cents INTEGER NOT NULL,threshold_cents INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS attempts(
        id TEXT PRIMARY KEY,session_id TEXT NOT NULL,listing_id TEXT NOT NULL,request_id TEXT NOT NULL,
        amount_cents INTEGER NOT NULL,currency TEXT NOT NULL DEFAULT 'usd',status TEXT NOT NULL,
        idempotency_key TEXT NOT NULL UNIQUE,payment_intent_id TEXT,approval_url TEXT,error TEXT,
        credit_limit INTEGER NOT NULL,credits_used INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,created_at INTEGER NOT NULL,lease_until INTEGER NOT NULL DEFAULT 0,key_hash TEXT,
        UNIQUE(session_id,listing_id,request_id));
      CREATE UNIQUE INDEX IF NOT EXISTS receipt_once ON attempts(payment_intent_id) WHERE payment_intent_id IS NOT NULL;
      CREATE TABLE IF NOT EXISTS webhook_events(event_id TEXT PRIMARY KEY,processed_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS mpp_credentials(purchase_id TEXT PRIMARY KEY,credential_hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS fulfilled(purchase_id TEXT PRIMARY KEY,fulfilled_at INTEGER NOT NULL);`);
    if (
      !this.db
        .prepare("PRAGMA table_info(attempts)")
        .all()
        .some((c) => c.name === "payment_mode")
    )
      this.db.exec(
        "ALTER TABLE attempts ADD COLUMN payment_mode TEXT NOT NULL DEFAULT 'mock:direct'",
      );
    if (keySecret) this.secret = keySecret;
    else if (path === ":memory:") this.secret = randomBytes(32);
    else {
      const file = `${path}.key`;
      if (!existsSync(file)) {
        try {
          writeFileSync(file, randomBytes(32), { mode: 0o600, flag: "wx" });
        } catch (e) {
          if (!existsSync(file)) throw e;
        }
      }
      chmodSync(file, 0o600);
      this.secret = readFileSync(file);
    }
    if (this.secret.length < 32)
      throw new Error("Wallet signing key must be at least 32 bytes");
  }
  private atomic<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = fn();
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  ensureSession(sessionId: string, capCents: number, thresholdCents: number) {
    if (
      !sessionId ||
      !cents(capCents) ||
      !cents(thresholdCents) ||
      thresholdCents > capCents
    )
      throw new StoreError("INVALID_POLICY", "Invalid wallet policy");
    // Reconnecting MCP must never reset an existing wallet or replenish its budget.
    this.db
      .prepare("INSERT OR IGNORE INTO wallets VALUES(?,?,?)")
      .run(sessionId, capCents, thresholdCents);
  }
  get(id: string): Attempt | null {
    return (
      (this.db
        .prepare("SELECT * FROM attempts WHERE id=?")
        .get(id) as unknown as Attempt) ?? null
    );
  }
  byPayment(id: string): Attempt | null {
    return (
      (this.db
        .prepare("SELECT * FROM attempts WHERE payment_intent_id=?")
        .get(id) as unknown as Attempt) ?? null
    );
  }
  list(sessionId: string): Attempt[] {
    return this.db
      .prepare(
        "SELECT * FROM attempts WHERE session_id=? ORDER BY created_at,id",
      )
      .all(sessionId) as unknown as Attempt[];
  }
  view(sessionId: string): WalletView {
    const policy = this.db
      .prepare(
        "SELECT cap_cents,threshold_cents FROM wallets WHERE session_id=?",
      )
      .get(sessionId) as
      { cap_cents: number; threshold_cents: number } | undefined;
    if (!policy) throw new StoreError("NO_WALLET", "Wallet unavailable");
    const attempts = this.list(sessionId);
    const spent = attempts
      .filter((p) => p.status === "paid")
      .reduce((s, p) => s + p.amount_cents, 0);
    const reserved = attempts
      .filter((p) => !["paid", "declined"].includes(p.status))
      .reduce((s, p) => s + p.amount_cents, 0);
    return {
      session_id: sessionId,
      cap_cents: policy.cap_cents,
      threshold_cents: policy.threshold_cents,
      spent_cents: spent,
      reserved_cents: reserved,
      remaining_cents: policy.cap_cents - spent - reserved,
      purchases: attempts,
    };
  }
  reserve(
    sessionId: string,
    listingId: string,
    amountCents: number,
    requestId = "initial",
    creditLimit = 1000,
    paymentMode = "mock:direct",
  ): Attempt {
    if (!validPurchase(amountCents, creditLimit, requestId))
      throw new StoreError(
        "INVALID_PURCHASE",
        "Invalid purchase or amount below $0.50",
      );
    return this.atomic(() => {
      const old = this.db
        .prepare(
          "SELECT * FROM attempts WHERE session_id=? AND listing_id=? AND request_id=?",
        )
        .get(sessionId, listingId, requestId) as unknown as Attempt | undefined;
      if (old) {
        if (
          old.amount_cents !== amountCents ||
          old.payment_mode !== paymentMode
        )
          throw new StoreError(
            "IDEMPOTENCY_CONFLICT",
            "Purchase terms changed; use an explicit new request ID",
          );
        return old;
      }
      const view = this.view(sessionId);
      if (view.remaining_cents < amountCents)
        throw new StoreError(
          "BUDGET_EXCEEDED",
          "Purchase exceeds the remaining human budget",
        );
      const id = `pur_${randomUUID()}`;
      const status: AttemptStatus =
        amountCents > view.threshold_cents ? "needs_approval" : "ready";
      this.db
        .prepare(
          `INSERT INTO attempts(id,session_id,listing_id,request_id,amount_cents,status,idempotency_key,credit_limit,expires_at,created_at,payment_mode) VALUES(?,?,?,?,?,?,?,?,?,?,?)`,
        )
        .run(
          id,
          sessionId,
          listingId,
          requestId,
          amountCents,
          status,
          `bodega:${id}`,
          creditLimit,
          this.now() + 30 * 86400000,
          this.now(),
          paymentMode,
        );
      return this.get(id)!;
    });
  }
  setApproval(id: string, url: string) {
    this.db
      .prepare(
        // First approval request wins so concurrent buyers converge on one approval link.
        "UPDATE attempts SET approval_url=COALESCE(approval_url,?) WHERE id=? AND status='needs_approval'",
      )
      .run(url, id);
  }
  approve(id: string) {
    this.db
      .prepare(
        "UPDATE attempts SET status='ready' WHERE id=? AND status='needs_approval'",
      )
      .run(id);
  }
  decline(id: string, reason: string) {
    this.db
      .prepare(
        "UPDATE attempts SET status='declined',error=?,lease_until=0 WHERE id=? AND status IN ('ready','needs_approval')",
      )
      .run(reason, id);
  }
  claim(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE attempts SET status='charging',lease_until=? WHERE id=? AND status IN ('ready','pending','charging') AND lease_until<=?",
        )
        .run(this.now() + 60000, id, this.now()).changes === 1
    );
  }
  finish(
    id: string,
    status: "paid" | "pending" | "declined",
    paymentId?: string,
    error?: string,
  ): Attempt {
    return this.atomic(() => {
      const old = this.get(id);
      if (!old) throw new StoreError("NO_PURCHASE", "Purchase unavailable");
      if (old.status === "paid") return old; // Late failed events never downgrade a paid purchase.
      if (old.status === "needs_approval")
        throw new StoreError("APPROVAL_REQUIRED", "Human approval required");
      if (
        status === "paid" &&
        (!paymentId || !receiptMatchesMode(old.payment_mode, paymentId))
      )
        throw new StoreError(
          "NO_RECEIPT",
          "Verified payment identifier required",
        );
      if (paymentId) {
        const owner = this.byPayment(paymentId);
        if (
          (old.payment_intent_id && old.payment_intent_id !== paymentId) ||
          (owner && owner.id !== id)
        )
          throw new StoreError(
            "RECEIPT_CONFLICT",
            "Payment identifier conflicts with the recorded attempt",
          );
      }
      const token = this.tokenFor(id);
      this.db
        .prepare(
          "UPDATE attempts SET status=?,payment_intent_id=COALESCE(?,payment_intent_id),error=?,lease_until=0,key_hash=? WHERE id=?",
        )
        .run(
          status,
          paymentId ?? null,
          error ?? null,
          status === "paid" ? digest(token) : null,
          id,
        );
      return this.get(id)!;
    });
  }
  tokenFor(id: string) {
    return signProjectKey(this.secret, id);
  }
  resolveToken(token: string) {
    const row = this.db
      .prepare(
        "SELECT * FROM attempts WHERE key_hash=? AND status='paid' AND expires_at>?",
      )
      .get(digest(token), this.now()) as unknown as Attempt | undefined;
    if (!row) return null;
    const expected = Buffer.from(this.tokenFor(row.id));
    const actual = Buffer.from(token);
    return actual.length === expected.length &&
      timingSafeEqual(actual, expected)
      ? row
      : null;
  }
  consume(id: string): boolean {
    return (
      this.db
        .prepare(
          "UPDATE attempts SET credits_used=credits_used+1 WHERE id=? AND status='paid' AND credits_used<credit_limit AND expires_at>?",
        )
        .run(id, this.now()).changes === 1
    );
  }
  bindMppCredential(id: string, credential: string): boolean {
    return this.atomic(() => {
      const hash = digest(credential);
      const old = this.db
        .prepare(
          "SELECT credential_hash FROM mpp_credentials WHERE purchase_id=?",
        )
        .get(id);
      if (old) return old.credential_hash === hash;
      this.db.prepare("INSERT INTO mpp_credentials VALUES(?,?)").run(id, hash);
      return true;
    });
  }
  hasEvent(eventId: string) {
    return !!this.db
      .prepare("SELECT 1 FROM webhook_events WHERE event_id=?")
      .get(eventId);
  }
  markEvent(eventId: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO webhook_events VALUES(?,?)")
      .run(eventId, this.now());
  }
  isFulfilled(id: string) {
    return !!this.db
      .prepare("SELECT 1 FROM fulfilled WHERE purchase_id=?")
      .get(id);
  }
  markFulfilled(id: string) {
    this.db
      .prepare("INSERT OR IGNORE INTO fulfilled VALUES(?,?)")
      .run(id, this.now());
  }
  close() {
    this.db.close();
  }
}
