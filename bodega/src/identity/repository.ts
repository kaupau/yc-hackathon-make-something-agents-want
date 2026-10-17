import { DatabaseSync } from "node:sqlite";
import { chmodSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { createAdminClient } from "@insforge/sdk";

/** Administrator-provisioned customer account. Budgets are never agent-supplied. */
export interface CustomerRecord {
  id: string;
  email: string;
  cap_cents: number;
  threshold_cents: number;
  active: boolean;
  created_at: string;
}
/** Agent credential metadata. The raw token and its hash are never part of this shape. */
export interface CredentialRecord {
  id: string;
  customer_id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  last_used_at: string | null;
}
export interface CustomerSummary extends CustomerRecord {
  credentials: CredentialRecord[];
}
export interface NewCustomer {
  id: string;
  email: string;
  cap_cents: number;
  threshold_cents: number;
}
/** Only a SHA-256 digest of the bearer token ever reaches persistence. */
export interface NewCredential {
  id: string;
  token_hash: string;
  expires_at: string;
}
export interface AuthenticatedCustomer {
  customer: CustomerRecord;
  credential_id: string;
}

export class IdentityError extends Error {
  constructor(
    readonly code:
      | "INVALID_INPUT"
      | "CONFLICT"
      | "NOT_FOUND"
      | "BACKEND_UNAVAILABLE",
    message: string,
  ) {
    super(message);
  }
}

/** Persistence seam for customer identities and agent credentials. */
export interface IdentityRepository {
  readonly mode: string;
  createCustomer(
    customer: NewCustomer,
    credential: NewCredential,
  ): Promise<CustomerRecord>;
  getCustomer(id: string): Promise<CustomerRecord | null>;
  listCustomers(): Promise<CustomerSummary[]>;
  setActive(id: string, active: boolean): Promise<CustomerRecord | null>;
  /** Returns false when the customer does not exist. */
  addCredential(
    customerId: string,
    credential: NewCredential,
    revokeExisting: boolean,
  ): Promise<boolean>;
  revokeCredential(credentialId: string): Promise<boolean>;
  /** Active customer, unrevoked and unexpired credential only. */
  authenticate(tokenHash: string): Promise<AuthenticatedCustomer | null>;
  close(): Promise<void> | void;
}

const iso = (v: unknown) =>
  v === null || v === undefined ? null : new Date(v as string).toISOString();

/** Local durable fallback for offline development and tests. */
export class SqliteIdentityRepository implements IdentityRepository {
  readonly mode = "local-sqlite";
  private db: DatabaseSync;
  constructor(
    path: string,
    private now = Date.now,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS customers(
        id TEXT PRIMARY KEY, email TEXT NOT NULL,
        cap_cents INTEGER NOT NULL CHECK(cap_cents>=0),
        threshold_cents INTEGER NOT NULL CHECK(threshold_cents>=0 AND threshold_cents<=cap_cents),
        active INTEGER NOT NULL DEFAULT 1, created_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS agent_credentials(
        id TEXT PRIMARY KEY, customer_id TEXT NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
        token_hash TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
        revoked_at INTEGER, last_used_at INTEGER);
      CREATE INDEX IF NOT EXISTS agent_credentials_customer ON agent_credentials(customer_id);`);
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
  private customer(row: any): CustomerRecord {
    return {
      id: row.id,
      email: row.email,
      cap_cents: Number(row.cap_cents),
      threshold_cents: Number(row.threshold_cents),
      active: Number(row.active) === 1,
      created_at: iso(Number(row.created_at))!,
    };
  }
  private insertCredential(customerId: string, c: NewCredential) {
    this.db
      .prepare(
        "INSERT INTO agent_credentials(id,customer_id,token_hash,created_at,expires_at) VALUES(?,?,?,?,?)",
      )
      .run(c.id, customerId, c.token_hash, this.now(), Date.parse(c.expires_at));
  }
  async createCustomer(customer: NewCustomer, credential: NewCredential) {
    try {
      return this.atomic(() => {
        this.db
          .prepare(
            "INSERT INTO customers(id,email,cap_cents,threshold_cents,active,created_at) VALUES(?,?,?,?,1,?)",
          )
          .run(
            customer.id,
            customer.email,
            customer.cap_cents,
            customer.threshold_cents,
            this.now(),
          );
        this.insertCredential(customer.id, credential);
        return this.customer(
          this.db.prepare("SELECT * FROM customers WHERE id=?").get(customer.id),
        );
      });
    } catch (e) {
      if (/UNIQUE|PRIMARY KEY/i.test(String((e as Error).message)))
        throw new IdentityError("CONFLICT", "Customer already exists");
      throw e;
    }
  }
  async getCustomer(id: string) {
    const row = this.db.prepare("SELECT * FROM customers WHERE id=?").get(id);
    return row ? this.customer(row) : null;
  }
  async listCustomers(): Promise<CustomerSummary[]> {
    const creds = this.db
      .prepare(
        "SELECT id,customer_id,created_at,expires_at,revoked_at,last_used_at FROM agent_credentials ORDER BY created_at,id",
      )
      .all();
    return this.db
      .prepare("SELECT * FROM customers ORDER BY created_at,id")
      .all()
      .map((row) => ({
        ...this.customer(row),
        credentials: creds
          .filter((c) => c.customer_id === row.id)
          .map((c) => ({
            id: c.id as string,
            customer_id: c.customer_id as string,
            created_at: iso(Number(c.created_at))!,
            expires_at: iso(Number(c.expires_at))!,
            revoked_at: c.revoked_at === null ? null : iso(Number(c.revoked_at)),
            last_used_at:
              c.last_used_at === null ? null : iso(Number(c.last_used_at)),
          })),
      }));
  }
  async setActive(id: string, active: boolean) {
    this.db
      .prepare("UPDATE customers SET active=? WHERE id=?")
      .run(active ? 1 : 0, id);
    return this.getCustomer(id);
  }
  async addCredential(
    customerId: string,
    credential: NewCredential,
    revokeExisting: boolean,
  ) {
    return this.atomic(() => {
      if (!this.db.prepare("SELECT 1 FROM customers WHERE id=?").get(customerId))
        return false;
      if (revokeExisting)
        this.db
          .prepare(
            "UPDATE agent_credentials SET revoked_at=? WHERE customer_id=? AND revoked_at IS NULL",
          )
          .run(this.now(), customerId);
      this.insertCredential(customerId, credential);
      return true;
    });
  }
  async revokeCredential(credentialId: string) {
    return (
      this.db
        .prepare(
          "UPDATE agent_credentials SET revoked_at=? WHERE id=? AND revoked_at IS NULL",
        )
        .run(this.now(), credentialId).changes === 1
    );
  }
  async authenticate(tokenHash: string) {
    const now = this.now();
    const row = this.db
      .prepare(
        `SELECT c.*, k.id AS credential_id, k.last_used_at AS credential_last_used FROM agent_credentials k
         JOIN customers c ON c.id=k.customer_id
         WHERE k.token_hash=? AND k.revoked_at IS NULL AND k.expires_at>? AND c.active=1`,
      )
      .get(tokenHash, now);
    if (!row) return null;
    if (row.credential_last_used === null || now - Number(row.credential_last_used) > 60_000)
      this.db
        .prepare("UPDATE agent_credentials SET last_used_at=? WHERE id=?")
        .run(now, row.credential_id);
    return {
      customer: this.customer(row),
      credential_id: row.credential_id as string,
    };
  }
  close() {
    this.db.close();
  }
}

export type RpcCall = (
  fn: string,
  args: Record<string, unknown>,
) => Promise<{ data: unknown; error: { code?: string; message?: string } | null }>;

/**
 * Server-only InsForge backend. Every operation is a narrow RPC defined in
 * migrations/20261017210002_customer-identities.sql; the admin API key must
 * never be shipped to browsers or agents.
 */
export class InsforgeIdentityRepository implements IdentityRepository {
  readonly mode = "insforge-rpc";
  constructor(private rpc: RpcCall) {}
  private async call<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    let result: Awaited<ReturnType<RpcCall>>;
    try {
      result = await this.rpc(fn, args);
    } catch {
      throw new IdentityError("BACKEND_UNAVAILABLE", "Identity backend unavailable");
    }
    if (result.error) {
      if (result.error.code === "23505")
        throw new IdentityError("CONFLICT", "Customer already exists");
      if (["23514", "22023", "23503"].includes(result.error.code ?? ""))
        throw new IdentityError("INVALID_INPUT", "Identity backend rejected input");
      // Never surface backend error text: it may echo request parameters.
      throw new IdentityError("BACKEND_UNAVAILABLE", "Identity backend unavailable");
    }
    return result.data as T;
  }
  private customer(row: any): CustomerRecord | null {
    if (!row || typeof row !== "object") return null;
    return {
      id: String(row.id),
      email: String(row.email),
      cap_cents: Number(row.cap_cents),
      threshold_cents: Number(row.threshold_cents),
      active: row.active === true,
      created_at: iso(row.created_at)!,
    };
  }
  async createCustomer(customer: NewCustomer, credential: NewCredential) {
    const row = await this.call("bodega_create_customer", {
      p_id: customer.id,
      p_email: customer.email,
      p_cap_cents: customer.cap_cents,
      p_threshold_cents: customer.threshold_cents,
      p_credential_id: credential.id,
      p_token_hash: credential.token_hash,
      p_expires_at: credential.expires_at,
    });
    const result = this.customer(row);
    if (!result)
      throw new IdentityError("BACKEND_UNAVAILABLE", "Identity backend unavailable");
    return result;
  }
  async getCustomer(id: string) {
    return this.customer(await this.call("bodega_get_customer", { p_id: id }));
  }
  async listCustomers() {
    const rows = await this.call<any[]>("bodega_list_customers", {});
    return (Array.isArray(rows) ? rows : []).map((row) => ({
      ...this.customer(row)!,
      credentials: (Array.isArray(row.credentials) ? row.credentials : []).map(
        (c: any) => ({
          id: String(c.id),
          customer_id: String(c.customer_id),
          created_at: iso(c.created_at)!,
          expires_at: iso(c.expires_at)!,
          revoked_at: iso(c.revoked_at),
          last_used_at: iso(c.last_used_at),
        }),
      ),
    }));
  }
  async setActive(id: string, active: boolean) {
    return this.customer(
      await this.call("bodega_set_customer_active", {
        p_id: id,
        p_active: active,
      }),
    );
  }
  async addCredential(
    customerId: string,
    credential: NewCredential,
    revokeExisting: boolean,
  ) {
    return (
      (await this.call("bodega_add_agent_credential", {
        p_customer_id: customerId,
        p_credential_id: credential.id,
        p_token_hash: credential.token_hash,
        p_expires_at: credential.expires_at,
        p_revoke_existing: revokeExisting,
      })) === true
    );
  }
  async revokeCredential(credentialId: string) {
    return (
      (await this.call("bodega_revoke_agent_credential", {
        p_credential_id: credentialId,
      })) === true
    );
  }
  async authenticate(tokenHash: string) {
    const row = await this.call<any>("bodega_authenticate_agent", {
      p_token_hash: tokenHash,
    });
    const customer = this.customer(row?.customer);
    if (!customer || !customer.active || typeof row.credential_id !== "string")
      return null;
    return { customer, credential_id: row.credential_id };
  }
  close() {}
}

export function connectInsforgeIdentity(options: {
  url: string;
  apiKey: string;
}): InsforgeIdentityRepository {
  const client = createAdminClient({
    baseUrl: options.url,
    apiKey: options.apiKey,
  });
  return new InsforgeIdentityRepository(async (fn, args) => {
    const { data, error } = await client.database.rpc(fn, args);
    return { data, error: error ? { code: (error as any).code, message: "" } : null };
  });
}
