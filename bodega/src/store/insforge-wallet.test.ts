import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createApplication } from "../server.js";
import { createMockPayments, type PaymentProvider } from "./payments.js";
import {
  InsforgeWalletStore,
  createWalletBackend,
  keyFingerprint,
  parseAttempt,
  type WalletRpc,
} from "./insforge-wallet.js";
import { StoreError, WalletStore, type Attempt } from "./wallet.js";

const SECRET = Buffer.from("shared-project-key-secret-0123456789abcdef");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const SAFE = 9007199254740991;

/**
 * In-memory stand-in for migrations/20261017210001_shared-wallet.sql. Each RPC is executed
 * serially (like a row-locked transaction) after random network jitter, so concurrent callers
 * from several "nodes" interleave the way independent HTTP requests would.
 */
class FakeWalletDb {
  wallets = new Map<string, { cap_cents: number; threshold_cents: number }>();
  attempts = new Map<string, Attempt>();
  events = new Set<string>();
  credentials = new Map<string, string>();
  fulfilled = new Set<string>();
  fingerprint: string | null = null;
  calls: Array<{ fn: string; args: Record<string, unknown> }> = [];
  fail?: (fn: string) => boolean;
  transform?: (fn: string, data: unknown) => unknown;
  private queue: Promise<unknown> = Promise.resolve();
  rpc: WalletRpc = async (fn, args) => {
    this.calls.push({ fn, args });
    await new Promise((r) => setTimeout(r, Math.random() * 3));
    if (this.fail?.(fn)) throw new Error("socket hang up");
    const run = this.queue.then(() => this.exec(fn, args));
    this.queue = run.catch(() => {});
    let data = JSON.parse(JSON.stringify((await run) ?? null));
    if (this.transform) data = this.transform(fn, data);
    return { data, error: null };
  };
  private used(session: string, filter: (a: Attempt) => boolean) {
    let n = 0;
    for (const a of this.attempts.values())
      if (a.session_id === session && filter(a)) n += a.amount_cents;
    return n;
  }
  private list(session: string) {
    return [...this.attempts.values()]
      .filter((a) => a.session_id === session)
      .sort((x, y) => x.created_at - y.created_at || x.id.localeCompare(y.id));
  }
  private exec(fn: string, a: any): unknown {
    const now = Date.now();
    const at = (id: string) => this.attempts.get(id);
    switch (fn) {
      case "bodega_wallet_register_key":
        this.fingerprint ??= a.p_fingerprint;
        return this.fingerprint === a.p_fingerprint;
      case "bodega_wallet_ensure_session": {
        if (a.p_threshold_cents > a.p_cap_cents)
          return { error: "INVALID_POLICY" };
        if (!this.wallets.has(a.p_session_id))
          this.wallets.set(a.p_session_id, {
            cap_cents: a.p_cap_cents,
            threshold_cents: a.p_threshold_cents,
          });
        return this.wallets.get(a.p_session_id);
      }
      case "bodega_wallet_get":
        return at(a.p_id) ?? null;
      case "bodega_wallet_by_payment":
        return (
          [...this.attempts.values()].find(
            (x) => x.payment_intent_id === a.p_payment_id,
          ) ?? null
        );
      case "bodega_wallet_list":
        return this.list(a.p_session_id);
      case "bodega_wallet_view": {
        const w = this.wallets.get(a.p_session_id);
        if (!w) return { error: "NO_WALLET" };
        const spent = this.used(a.p_session_id, (x) => x.status === "paid");
        const held = this.used(
          a.p_session_id,
          (x) => x.status !== "paid" && x.status !== "declined",
        );
        return {
          session_id: a.p_session_id,
          ...w,
          spent_cents: spent,
          reserved_cents: held,
          remaining_cents: w.cap_cents - spent - held,
          purchases: this.list(a.p_session_id),
        };
      }
      case "bodega_wallet_reserve": {
        const w = this.wallets.get(a.p_session_id);
        if (!w) return { error: "NO_WALLET" };
        const old = [...this.attempts.values()].find(
          (x) =>
            x.session_id === a.p_session_id &&
            x.listing_id === a.p_listing_id &&
            x.request_id === a.p_request_id,
        );
        if (old)
          return old.amount_cents !== a.p_amount_cents ||
            old.payment_mode !== a.p_payment_mode
            ? { error: "IDEMPOTENCY_CONFLICT" }
            : { attempt: old };
        const used = this.used(a.p_session_id, (x) => x.status !== "declined");
        if (w.cap_cents - used < a.p_amount_cents)
          return { error: "BUDGET_EXCEEDED" };
        const id = `pur_${randomUUID()}`;
        const attempt: Attempt = {
          id,
          session_id: a.p_session_id,
          listing_id: a.p_listing_id,
          request_id: a.p_request_id,
          amount_cents: a.p_amount_cents,
          currency: "usd",
          status:
            a.p_amount_cents > w.threshold_cents ? "needs_approval" : "ready",
          idempotency_key: `bodega:${id}`,
          payment_intent_id: null,
          approval_url: null,
          error: null,
          payment_mode: a.p_payment_mode,
          credit_limit: a.p_credit_limit,
          credits_used: 0,
          expires_at: now + 30 * 86400000,
          created_at: now,
          lease_until: 0,
          key_hash: null,
        };
        this.attempts.set(id, attempt);
        return { attempt };
      }
      case "bodega_wallet_set_approval": {
        const x = at(a.p_id);
        if (!x || x.status !== "needs_approval") return null;
        x.approval_url ??= a.p_url;
        return x;
      }
      case "bodega_wallet_approve": {
        const x = at(a.p_id);
        if (!x || x.status !== "needs_approval") return null;
        x.status = "ready";
        return x;
      }
      case "bodega_wallet_decline": {
        const x = at(a.p_id);
        if (!x || !["ready", "needs_approval"].includes(x.status)) return null;
        Object.assign(x, {
          status: "declined",
          error: a.p_reason,
          lease_until: 0,
        });
        return x;
      }
      case "bodega_wallet_claim": {
        const x = at(a.p_id);
        if (
          !x ||
          !["ready", "pending", "charging"].includes(x.status) ||
          x.lease_until > now
        )
          return false;
        Object.assign(x, {
          status: "charging",
          lease_until: now + a.p_lease_ms,
        });
        return true;
      }
      case "bodega_wallet_finish": {
        const x = at(a.p_id);
        if (!x) return { error: "NO_PURCHASE" };
        if (x.status === "paid") return { attempt: x };
        if (x.status === "needs_approval")
          return { error: "APPROVAL_REQUIRED" };
        const pid: string | null = a.p_payment_id;
        if (
          a.p_status === "paid" &&
          (!pid ||
            !/^[0-9a-f]{64}$/.test(a.p_key_hash ?? "") ||
            !(x.payment_mode.startsWith("mock:")
              ? /^mock_[A-Za-z0-9]+$/.test(pid)
              : /^pi_[A-Za-z0-9_]+$/.test(pid)))
        )
          return { error: "NO_RECEIPT" };
        if (
          pid &&
          ((x.payment_intent_id && x.payment_intent_id !== pid) ||
            [...this.attempts.values()].some(
              (o) => o.payment_intent_id === pid && o.id !== x.id,
            ))
        )
          return { error: "RECEIPT_CONFLICT" };
        Object.assign(x, {
          status: a.p_status,
          payment_intent_id: pid ?? x.payment_intent_id,
          error: a.p_error,
          lease_until: 0,
          key_hash: a.p_status === "paid" ? a.p_key_hash : null,
        });
        return { attempt: x };
      }
      case "bodega_wallet_resolve_key":
        return (
          [...this.attempts.values()].find(
            (x) =>
              x.key_hash === a.p_key_hash &&
              x.status === "paid" &&
              x.expires_at > now,
          ) ?? null
        );
      case "bodega_wallet_consume": {
        const x = at(a.p_id);
        if (
          !x ||
          x.status !== "paid" ||
          x.credits_used >= x.credit_limit ||
          x.expires_at <= now
        )
          return false;
        x.credits_used++;
        return true;
      }
      case "bodega_wallet_bind_mpp_credential":
        if (!at(a.p_id)) return false;
        if (!this.credentials.has(a.p_id))
          this.credentials.set(a.p_id, a.p_credential_hash);
        return this.credentials.get(a.p_id) === a.p_credential_hash;
      case "bodega_wallet_has_event":
        return this.events.has(a.p_event_id);
      case "bodega_wallet_mark_event":
        if (this.events.has(a.p_event_id)) return false;
        this.events.add(a.p_event_id);
        return true;
      case "bodega_wallet_is_fulfilled":
        return this.fulfilled.has(a.p_id);
      case "bodega_wallet_mark_fulfilled":
        if (at(a.p_id)?.status !== "paid" || this.fulfilled.has(a.p_id))
          return false;
        this.fulfilled.add(a.p_id);
        return true;
    }
    throw new Error(`unknown rpc ${fn}`);
  }
}

/**
 * Optional real-Postgres seam: BODEGA_WALLET_TEST_PSQL=<libpq connection string> runs the
 * backend-agnostic suite through `psql` against a database with the migration applied
 * (one connection/transaction per call, so concurrency is real). Never run against production.
 */
function psqlRpc(dsn: string): WalletRpc {
  return (fn, args) => {
    const entries = Object.entries(args);
    const vars = entries.flatMap(([, v], i) =>
      v === null || v === undefined ? [] : ["-v", `a${i}=${String(v)}`],
    );
    const params = entries
      .map(([k, v], i) => `${k} => ${v == null ? "NULL" : `:'a${i}'`}`)
      .join(", ");
    const sql = `SELECT to_jsonb(public.${fn}(${params}));\n`;
    return new Promise((resolve) => {
      const child = execFile(
        "psql",
        [dsn, "-XqtA", "-v", "ON_ERROR_STOP=1", ...vars],
        (error, stdout, stderr) =>
          resolve(
            error
              ? { data: null, error: { message: stderr || error.message } }
              : {
                  data: stdout.trim() ? JSON.parse(stdout.trim()) : null,
                  error: null,
                },
          ),
      );
      child.stdin!.end(sql);
    });
  };
}

interface Harness {
  name: string;
  rpc(): WalletRpc;
}
const harnesses: Harness[] = [
  {
    name: "fake",
    rpc: (() => {
      let db: FakeWalletDb | undefined;
      return () => (db ??= new FakeWalletDb()).rpc;
    })(),
  },
];
if (process.env.BODEGA_WALLET_TEST_PSQL)
  harnesses.push({
    name: "psql",
    rpc: () => psqlRpc(process.env.BODEGA_WALLET_TEST_PSQL!),
  });

const node = async (rpc: WalletRpc, secret = SECRET) => {
  const store = new InsforgeWalletStore({ rpc, keySecret: secret });
  await store.connect();
  return store;
};
const session = () => `test-${randomUUID()}`;

for (const h of harnesses) {
  test(`[${h.name}] two nodes share one budget; reservations are idempotent and never over-admit`, async () => {
    const rpc = h.rpc();
    const [a, b] = [await node(rpc), await node(rpc)];
    const s = session();
    await a.ensureSession(s, 500, 500);
    await b.ensureSession(s, 999999, 999999); // reconnect must not replenish
    const results = await Promise.allSettled(
      Array.from({ length: 12 }, (_, i) =>
        (i % 2 ? a : b).reserve(s, `listing-${i}`, 90, "initial", 1),
      ),
    );
    const admitted = results.filter((r) => r.status === "fulfilled");
    assert.equal(admitted.length, 5);
    for (const r of results)
      if (r.status === "rejected")
        assert.equal((r.reason as StoreError).code, "BUDGET_EXCEEDED");
    const view = await b.view(s);
    assert.equal(view.cap_cents, 500);
    assert.equal(view.reserved_cents, 450);
    assert.equal(view.remaining_cents, 50);
    const held = (admitted[0] as PromiseFulfilledResult<Attempt>).value;
    const same = await Promise.all(
      [a, b, a, b].map((n) =>
        n.reserve(s, held.listing_id, 90, "initial", 1),
      ),
    );
    assert.ok(same.every((p) => p.id === held.id));
    await assert.rejects(a.reserve(s, held.listing_id, 95, "initial", 1), {
      code: "IDEMPOTENCY_CONFLICT",
    });
    await assert.rejects(
      a.reserve(s, held.listing_id, 90, "initial", 1, "stripe:direct"),
      { code: "IDEMPOTENCY_CONFLICT" },
    );
    await assert.rejects(a.reserve(s, "x", 49), { code: "INVALID_PURCHASE" });
    await assert.rejects(a.reserve(s, "x", SAFE + 1), {
      code: "INVALID_PURCHASE",
    });
    await assert.rejects(a.ensureSession(s, 10, 11), {
      code: "INVALID_POLICY",
    });
    await assert.rejects(a.view(session()), { code: "NO_WALLET" });
  });

  test(`[${h.name}] leases are exclusive across nodes; ambiguous outcomes keep the reservation`, async () => {
    const rpc = h.rpc();
    const [a, b] = [await node(rpc), await node(rpc)];
    const s = session();
    await a.ensureSession(s, 1000, 1000);
    const p = await a.reserve(s, "email", 200);
    const claims = await Promise.all(
      Array.from({ length: 16 }, (_, i) => (i % 2 ? a : b).claim(p.id)),
    );
    assert.equal(claims.filter(Boolean).length, 1);
    const pending = await b.finish(p.id, "pending", undefined, "lost response");
    assert.equal(pending.status, "pending");
    assert.equal((await a.view(s)).reserved_cents, 200);
    assert.equal(await a.claim(p.id), true);
    await assert.rejects(b.finish(p.id, "paid", "pi_wrongfamily"), {
      code: "NO_RECEIPT",
    });
    await assert.rejects(b.finish(p.id, "paid"), { code: "NO_RECEIPT" });
    const paid = await b.finish(p.id, "paid", "mock_receipt1");
    assert.equal(paid.status, "paid");
    assert.equal(paid.lease_until, 0);
    const late = await a.finish(p.id, "declined", undefined, "late failure");
    assert.equal(late.status, "paid");
    const v = await a.view(s);
    assert.equal(v.spent_cents, 200);
    assert.equal(v.reserved_cents, 0);
    assert.equal((await b.byPayment("mock_receipt1"))?.id, p.id);
    const other = await a.reserve(s, "email", 200, "second");
    assert.equal(await a.claim(other.id), true);
    await assert.rejects(a.finish(other.id, "paid", "mock_receipt1"), {
      code: "RECEIPT_CONFLICT",
    });
    await a.finish(other.id, "pending", "mock_receipt2");
    await assert.rejects(a.finish(other.id, "paid", "mock_receipt3"), {
      code: "RECEIPT_CONFLICT",
    });
    const third = await a.reserve(s, "email", 200, "third");
    await a.decline(third.id, "no");
    assert.equal((await a.get(third.id))?.status, "declined");
    assert.equal((await a.view(s)).reserved_cents, 200);
  });

  test(`[${h.name}] approvals converge on first link and finish refuses unapproved attempts`, async () => {
    const rpc = h.rpc();
    const [a, b] = [await node(rpc), await node(rpc)];
    const s = session();
    await a.ensureSession(s, 1000, 100);
    const p = await a.reserve(s, "big", 300);
    assert.equal(p.status, "needs_approval");
    await Promise.all([
      a.setApproval(p.id, "https://x/approve/1"),
      b.setApproval(p.id, "https://x/approve/2"),
    ]);
    const url = (await a.get(p.id))!.approval_url;
    assert.ok(url === "https://x/approve/1" || url === "https://x/approve/2");
    assert.equal(await a.claim(p.id), false);
    await assert.rejects(a.finish(p.id, "paid", "mock_x"), {
      code: "APPROVAL_REQUIRED",
    });
    await b.approve(p.id);
    assert.equal((await a.get(p.id))!.status, "ready");
    assert.equal((await a.get(p.id))!.approval_url, url);
  });

  test(`[${h.name}] project keys are shared-secret HMACs, stored only as digests, and credits are atomic`, async () => {
    const rpc = h.rpc();
    const [a, b] = [await node(rpc), await node(rpc)];
    const s = session();
    await a.ensureSession(s, 1000, 1000);
    const p = await a.reserve(s, "email", 100, "initial", 3);
    await a.claim(p.id);
    const paid = await a.finish(p.id, "paid", `mock_${randomUUID().replaceAll("-", "")}`);
    const token = a.tokenFor(p.id);
    assert.equal(b.tokenFor(p.id), token);
    assert.equal(paid.key_hash, sha(token));
    assert.equal((await b.resolveToken(token))?.id, p.id);
    assert.equal(await b.resolveToken(token + "x"), null);
    assert.equal(await b.resolveToken("bdg_live_forged"), null);
    const used = await Promise.all(
      Array.from({ length: 10 }, (_, i) => (i % 2 ? a : b).consume(p.id)),
    );
    assert.equal(used.filter(Boolean).length, 3);
    assert.equal(await a.bindMppCredential(p.id, "spt_first"), true);
    assert.equal(await b.bindMppCredential(p.id, "spt_first"), true);
    assert.equal(await b.bindMppCredential(p.id, "spt_other"), false);
    const evt = `evt_${randomUUID()}`;
    assert.equal(await a.hasEvent(evt), false);
    await Promise.all([a.markEvent(evt), b.markEvent(evt)]);
    assert.equal(await b.hasEvent(evt), true);
    assert.equal(await b.isFulfilled(p.id), false);
    await Promise.all([a.markFulfilled(p.id), b.markFulfilled(p.id)]);
    assert.equal(await a.isFulfilled(p.id), true);
    await assert.rejects(
      node(rpc, Buffer.from("a-different-secret-that-is-32-bytes-long!!")),
      /does not match/,
    );
  });
}

test("adapter never sends raw project keys or MPP credentials and validates safe integers", async () => {
  const db = new FakeWalletDb();
  const a = await node(db.rpc);
  await a.ensureSession("s", 1000, 1000);
  const p = await a.reserve("s", "email", 100);
  await a.claim(p.id);
  await a.finish(p.id, "paid", "mock_abc");
  const token = a.tokenFor(p.id);
  await a.resolveToken(token);
  await a.bindMppCredential(p.id, "spt_secret_credential");
  const wire = JSON.stringify(db.calls);
  assert.ok(!wire.includes(token));
  assert.ok(!wire.includes("spt_secret_credential"));
  assert.ok(!wire.includes(SECRET.toString()));
  assert.ok(wire.includes(keyFingerprint(SECRET)));
  // bigint transported as digit strings is accepted; beyond 2^53 is rejected.
  db.transform = (fn, d: any) =>
    fn === "bodega_wallet_get" ? { ...d, amount_cents: "100" } : d;
  assert.equal((await a.get(p.id))?.amount_cents, 100);
  db.transform = (fn, d: any) =>
    fn === "bodega_wallet_get" ? { ...d, amount_cents: 2 ** 53 + 2 } : d;
  await assert.rejects(a.get(p.id), { code: "WALLET_CORRUPT" });
  db.transform = (fn, d: any) =>
    fn === "bodega_wallet_view" ? { ...d, remaining_cents: 999 } : d;
  await assert.rejects(a.view("s"), { code: "WALLET_CORRUPT" });
  db.transform = undefined;
  assert.throws(() => parseAttempt({ ...p, status: "refunded" }), {
    code: "WALLET_CORRUPT",
  });
  db.fail = (fn) => fn === "bodega_wallet_consume";
  await assert.rejects(a.consume(p.id), { code: "WALLET_UNAVAILABLE" });
  db.fail = undefined;
  const errored = new InsforgeWalletStore({
    rpc: async () => ({ data: null, error: { message: "permission denied" } }),
    keySecret: SECRET,
  });
  await assert.rejects(errored.get("x"), { code: "WALLET_UNAVAILABLE" });
  assert.throws(
    () => new InsforgeWalletStore({ rpc: db.rpc, keySecret: Buffer.alloc(31) }),
    /32 bytes/,
  );
});

test("wallet factory defaults to SQLite and validates InsForge configuration", async () => {
  const local = await createWalletBackend({ env: {}, walletPath: ":memory:" });
  assert.ok(local instanceof WalletStore);
  await local.close();
  await assert.rejects(
    createWalletBackend({ env: { BODEGA_WALLET_BACKEND: "redis" } }),
    /Unsupported/,
  );
  await assert.rejects(
    createWalletBackend({
      env: { BODEGA_WALLET_BACKEND: "insforge", BODEGA_PROJECT_KEY_SECRET: "short" },
    }),
    /32 bytes/,
  );
  await assert.rejects(
    createWalletBackend({
      env: {
        BODEGA_WALLET_BACKEND: "insforge",
        BODEGA_PROJECT_KEY_SECRET: SECRET.toString(),
      },
    }),
    /INSFORGE_URL/,
  );
  const db = new FakeWalletDb();
  const remote = await createWalletBackend({
    env: {
      BODEGA_WALLET_BACKEND: "insforge",
      BODEGA_PROJECT_KEY_SECRET: SECRET.toString(),
    },
    rpc: db.rpc,
  });
  assert.equal(remote.kind, "insforge");
  assert.equal(db.fingerprint, keyFingerprint(SECRET));
});

async function insforgeApp(db: FakeWalletDb, payments: PaymentProvider, cap = 100) {
  return createApplication({
    env: {
      BODEGA_WALLET_BACKEND: "insforge",
      BODEGA_PROJECT_KEY_SECRET: SECRET.toString(),
    },
    dbPath: ":memory:",
    capCents: cap,
    thresholdCents: cap,
    payments,
    walletFactory: { rpc: db.rpc },
  });
}

test("two app nodes on one shared wallet charge once, share keys, and keep budget across reconnects", async () => {
  let charges = 0;
  const mock = createMockPayments();
  const payments: PaymentProvider = {
    ...mock,
    charge: async (o) => {
      charges++;
      await new Promise((r) => setTimeout(r, 20));
      return mock.charge(o);
    },
  };
  const db = new FakeWalletDb();
  const a = await insforgeApp(db, payments);
  const b = await insforgeApp(db, payments);
  try {
    assert.equal(a.state.kind, "insforge");
    const first = (await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 ? a : b).storefront.buy("postpigeon-email"),
      ),
    )) as any[];
    assert.equal(charges, 1);
    assert.ok(
      first.every((r) => ["paid", "charging"].includes(r.status)),
      JSON.stringify(first.map((r) => r.status)),
    );
    const settled: any = await b.storefront.buy("postpigeon-email");
    assert.equal(settled.status, "paid");
    const again: any = await a.storefront.buy("postpigeon-email");
    assert.equal(again.project_key, settled.project_key);
    assert.equal(charges, 1);
    const access = await a.storefront.resolvePurchasedKey(settled.project_key);
    assert.equal(access?.listing_id, "postpigeon-email");
    const c = await insforgeApp(db, payments, 99999);
    try {
      const w = await c.storefront.wallet();
      assert.equal(w.cap_usd, 1);
      assert.equal(w.remaining_usd, 0.1);
      await assert.rejects(c.storefront.buy("seekr-search"), /budget/);
    } finally {
      await c.close();
    }
  } finally {
    await a.close();
    await b.close();
  }
});

test("ambiguous charge on one node holds the reservation; another node recovers the same attempt", async () => {
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
  const db = new FakeWalletDb();
  const a = await insforgeApp(db, payments, 1000);
  const b = await insforgeApp(db, payments, 1000);
  try {
    assert.equal(
      ((await a.storefront.buy("postpigeon-email")) as any).status,
      "pending",
    );
    assert.equal((await b.storefront.wallet()).reserved_usd, 0.9);
    const recovered: any = await b.storefront.buy("postpigeon-email");
    assert.equal(recovered.status, "paid");
    assert.equal(calls, 2);
    assert.equal(db.fulfilled.size, 1);
    assert.equal((await a.storefront.wallet()).spent_usd, 0.9);
    db.fail = () => true;
    await assert.rejects(a.storefront.wallet(), { code: "WALLET_UNAVAILABLE" });
  } finally {
    db.fail = undefined;
    await a.close();
    await b.close();
  }
});
