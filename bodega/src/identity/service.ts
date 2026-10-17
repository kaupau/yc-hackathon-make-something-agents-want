import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  IdentityError,
  type CustomerRecord,
  type CustomerSummary,
  type IdentityRepository,
} from "./repository.js";

/**
 * Server-trusted identity bound to one durable wallet. `id` is the wallet session
 * ID and is derived only from authentication, never from request content.
 */
export interface Principal {
  id: string;
  kind: "legacy" | "customer";
  customerId: string | null;
  email: string;
  capCents: number;
  thresholdCents: number;
  credentialId: string | null;
}

export const AGENT_TOKEN_PREFIX = "bdg_agt_";
const TOKEN_PATTERN = /^bdg_agt_[A-Za-z0-9_-]{43}$/;
export const CUSTOMER_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{2,63}$/;
const CREDENTIAL_ID_PATTERN = /^agt_[a-f0-9]{24}$/;
const EMAIL_PATTERN =
  /^[A-Za-z0-9.!#$%&*+/=?^_`{|}~-]{1,64}@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;
export const MAX_CAP_CENTS = 10_000_000;
export const CUSTOMER_WALLET_PREFIX = "customer:";

export const hashAgentToken = (token: string) =>
  createHash("sha256").update(token, "utf8").digest("hex");
/** 256 bits from the OS CSPRNG. */
export function mintAgentToken() {
  const token = AGENT_TOKEN_PREFIX + randomBytes(32).toString("base64url");
  return { token, hash: hashAgentToken(token) };
}
export const customerWalletId = (customerId: string) =>
  `${CUSTOMER_WALLET_PREFIX}${customerId}`;
const same = (a: string, b: string) => {
  const left = Buffer.from(a),
    right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
/** Extracts a bearer credential; malformed headers yield an empty string (never anonymous). */
export function bearer(header: string | undefined): string | null {
  if (header === undefined || header === "") return null;
  const match = /^Bearer ([\x21-\x7e]{1,512})$/.exec(header);
  return match ? match[1] : "";
}

export interface NewCustomerInput {
  id?: unknown;
  email?: unknown;
  cap_cents?: unknown;
  threshold_cents?: unknown;
  token_ttl_days?: unknown;
}
export interface IssuedCredential {
  id: string;
  /** Raw bearer token. Returned exactly once and never persisted. */
  token: string;
  expires_at: string;
}
export interface IdentityServiceOptions {
  legacy: {
    sessionId: string;
    capCents: number;
    thresholdCents: number;
    email: string;
    /** Legacy BODEGA_AGENT_TOKEN; authenticates only the legacy principal. */
    token?: string;
  };
  /** Local demo only: requests without credentials act as the legacy principal. */
  allowAnonymousLegacy: boolean;
  cacheMs?: number;
  now?: () => number;
}

const centsOf = (v: unknown, name: string) => {
  if (!Number.isSafeInteger(v) || (v as number) < 0 || (v as number) > MAX_CAP_CENTS)
    throw new IdentityError(
      "INVALID_INPUT",
      `${name} must be an integer number of cents between 0 and ${MAX_CAP_CENTS}`,
    );
  return v as number;
};
const ttlOf = (v: unknown) => {
  if (v === undefined) return 90;
  if (!Number.isSafeInteger(v) || (v as number) < 1 || (v as number) > 365)
    throw new IdentityError("INVALID_INPUT", "token_ttl_days must be 1–365");
  return v as number;
};

export class IdentityService {
  readonly legacy: Principal;
  private cache = new Map<string, { principal: Principal; until: number }>();
  private now: () => number;
  constructor(
    readonly repository: IdentityRepository,
    private options: IdentityServiceOptions,
  ) {
    const { legacy } = options;
    if (!legacy.sessionId || legacy.sessionId.startsWith(CUSTOMER_WALLET_PREFIX))
      throw new Error(
        `Legacy wallet ID must be non-empty and not start with ${CUSTOMER_WALLET_PREFIX}`,
      );
    if (legacy.token !== undefined && legacy.token.length < 16)
      throw new Error("Legacy agent token is too short");
    this.legacy = {
      id: legacy.sessionId,
      kind: "legacy",
      customerId: null,
      email: legacy.email,
      capCents: legacy.capCents,
      thresholdCents: legacy.thresholdCents,
      credentialId: null,
    };
    this.now = options.now ?? Date.now;
  }
  get requiresCredentials() {
    return !this.options.allowAnonymousLegacy;
  }
  private principal(c: CustomerRecord, credentialId: string | null): Principal {
    return {
      id: customerWalletId(c.id),
      kind: "customer",
      customerId: c.id,
      email: c.email,
      capCents: c.cap_cents,
      thresholdCents: c.threshold_cents,
      credentialId,
    };
  }
  /**
   * `null` raw credential means none was presented. An empty string means a malformed
   * credential was presented and always fails (it never degrades to anonymous access).
   */
  async authenticate(raw: string | null): Promise<Principal | null> {
    if (raw === null)
      return this.options.allowAnonymousLegacy ? this.legacy : null;
    if (!raw) return null;
    if (this.options.legacy.token && same(raw, this.options.legacy.token))
      return this.legacy;
    if (!TOKEN_PATTERN.test(raw)) return null;
    const hash = hashAgentToken(raw);
    const cached = this.cache.get(hash);
    if (cached && cached.until > this.now()) return cached.principal;
    const found = await this.repository.authenticate(hash);
    if (!found) {
      this.cache.delete(hash);
      return null;
    }
    const principal = this.principal(found.customer, found.credential_id);
    const ttl = this.options.cacheMs ?? 0;
    if (ttl > 0) {
      if (this.cache.size > 1000) this.cache.clear();
      this.cache.set(hash, { principal, until: this.now() + ttl });
    }
    return principal;
  }
  /** Resolves a purchase owner for trusted server-side reconciliation. */
  async principalForWallet(walletId: string): Promise<Principal | null> {
    if (walletId === this.legacy.id) return this.legacy;
    if (!walletId.startsWith(CUSTOMER_WALLET_PREFIX)) return null;
    const customer = await this.repository.getCustomer(
      walletId.slice(CUSTOMER_WALLET_PREFIX.length),
    );
    return customer ? this.principal(customer, null) : null;
  }
  private credential(ttlDays: number) {
    const { token, hash } = mintAgentToken();
    const id = `agt_${randomBytes(12).toString("hex")}`;
    const expires_at = new Date(this.now() + ttlDays * 86_400_000).toISOString();
    return { issued: { id, token, expires_at }, stored: { id, token_hash: hash, expires_at } };
  }
  private invalidate() {
    this.cache.clear();
  }
  async createCustomer(input: NewCustomerInput) {
    const id =
      input.id === undefined ? `cus_${randomBytes(8).toString("hex")}` : input.id;
    if (typeof id !== "string" || !CUSTOMER_ID_PATTERN.test(id))
      throw new IdentityError(
        "INVALID_INPUT",
        "id must be 3–64 lowercase letters, digits, '-' or '_'",
      );
    const email = typeof input.email === "string" ? input.email.trim() : "";
    if (email.length > 254 || !EMAIL_PATTERN.test(email))
      throw new IdentityError("INVALID_INPUT", "A valid email is required");
    const cap = centsOf(input.cap_cents, "cap_cents");
    const threshold = centsOf(input.threshold_cents, "threshold_cents");
    if (threshold > cap)
      throw new IdentityError("INVALID_INPUT", "threshold_cents cannot exceed cap_cents");
    const { issued, stored } = this.credential(ttlOf(input.token_ttl_days));
    const customer = await this.repository.createCustomer(
      { id, email: email.toLowerCase(), cap_cents: cap, threshold_cents: threshold },
      stored,
    );
    return { customer, credential: issued };
  }
  async issueCredential(
    customerId: string,
    options: { ttlDays?: unknown; revokeExisting: boolean },
  ): Promise<IssuedCredential> {
    if (!CUSTOMER_ID_PATTERN.test(customerId))
      throw new IdentityError("NOT_FOUND", "Customer not found");
    const { issued, stored } = this.credential(ttlOf(options.ttlDays));
    const ok = await this.repository.addCredential(
      customerId,
      stored,
      options.revokeExisting,
    );
    this.invalidate();
    if (!ok) throw new IdentityError("NOT_FOUND", "Customer not found");
    return issued;
  }
  async revokeCredential(credentialId: string) {
    if (!CREDENTIAL_ID_PATTERN.test(credentialId)) return false;
    const ok = await this.repository.revokeCredential(credentialId);
    this.invalidate();
    return ok;
  }
  async setActive(customerId: string, active: boolean) {
    if (!CUSTOMER_ID_PATTERN.test(customerId)) return null;
    const result = await this.repository.setActive(customerId, active);
    this.invalidate();
    return result;
  }
  listCustomers(): Promise<CustomerSummary[]> {
    return this.repository.listCustomers();
  }
}
