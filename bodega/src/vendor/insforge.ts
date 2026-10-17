import { createAdminClient } from "@insforge/sdk";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import type { Catalog, Ledger, Listing } from "../contracts/index.js";
import { publicListing } from "./data.js";

/** Server-only remote catalog + audit backend. Local SQLite remains the admission authority.
 * Durable outbox survives network failures; never uploads tokens, leases, or approval URLs.
 * This is a single-server architecture, not a distributed wallet/quota implementation.
 */
export async function connectInsforge(
  services: { catalog: Catalog; ledger: Ledger },
  options: {
    url: string;
    apiKey: string;
    outboxPath: string;
    publicUrl?: string;
  },
) {
  const client = createAdminClient({
    baseUrl: options.url,
    apiKey: options.apiKey,
  });
  mkdirSync(dirname(options.outboxPath), { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(options.outboxPath);
  chmodSync(options.outboxPath, 0o600);
  db.exec(
    "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS sync_outbox(kind TEXT,id TEXT,payload TEXT,revision INTEGER DEFAULT 1,PRIMARY KEY(kind,id));",
  );
  let lastError: string | null = null;
  let active: Promise<void> | undefined;
  function queue(kind: string, id: string, payload: unknown) {
    db.prepare(
      "INSERT INTO sync_outbox(kind,id,payload) VALUES(?,?,?) ON CONFLICT(kind,id) DO UPDATE SET payload=excluded.payload,revision=revision+1",
    ).run(kind, id, JSON.stringify(payload));
  }
  async function flush() {
    if (active) return active;
    active = (async () => {
      for (const row of db
        .prepare("SELECT kind,id,payload,revision FROM sync_outbox LIMIT 50")
        .all()) {
        const payload = JSON.parse(row.payload as string);
        const table =
          row.kind === "listing" ? "bodega_catalog" : "bodega_events";
        const record =
          row.kind === "listing"
            ? {
                id: row.id,
                vendor_id: payload.vendor_id,
                category: payload.category,
                listing: payload,
                updated_at: new Date().toISOString(),
              }
            : {
                kind: row.kind,
                id: row.id,
                session_id: payload.session_id,
                payload,
                updated_at: new Date().toISOString(),
              };
        const { error } = await client.database.from(table).upsert([record]);
        if (error) {
          lastError = "InsForge sync unavailable";
          break;
        }
        db.prepare(
          "DELETE FROM sync_outbox WHERE kind=? AND id=? AND revision=?",
        ).run(row.kind, row.id, row.revision);
        lastError = null;
      }
    })();
    try {
      await active;
    } finally {
      active = undefined;
    }
  }
  const localCatalog = services.catalog;
  const { data, error } = await client.database
    .from("bodega_catalog")
    .select("id,listing")
    .limit(100);
  if (error) {
    db.close();
    throw new Error(
      "InsForge catalog connection failed; verify project schema and server credentials",
    );
  }
  for (const row of data ?? [])
    await localCatalog.upsert(
      publicListing(
        row.id === "postpigeon-email" && options.publicUrl
          ? {
              ...(row.listing as Listing),
              docs_url: `${options.publicUrl}/postpigeon/docs`,
            }
          : (row.listing as Listing),
      ),
    );
  for (const listing of await localCatalog.search("", { limit: 100 }))
    queue("listing", listing.id, listing);
  const originalUpsert = localCatalog.upsert.bind(localCatalog);
  localCatalog.upsert = async (listing) => {
    await originalUpsert(listing);
    queue("listing", listing.id, await localCatalog.get(listing.id));
    void flush().catch(() => {
      lastError = "InsForge sync unavailable";
    });
  };
  const ledger = services.ledger;
  for (const method of [
    "recordPurchase",
    "recordReview",
    "recordComparison",
    "createTrial",
  ] as const) {
    const original = ledger[method].bind(ledger) as (
      value: any,
    ) => Promise<void>;
    (ledger as any)[method] = async (value: any) => {
      await original(value);
      capture(
        method === "recordPurchase"
          ? "purchase"
          : method === "recordReview"
            ? "review"
            : method === "recordComparison"
              ? "comparison"
              : "trial",
        value,
      );
    };
  }
  for (const [method, kind] of [
    ["updatePurchase", "purchase"],
    ["updateTrial", "trial"],
  ] as const) {
    const original = ledger[method].bind(ledger) as (
      id: string,
      value: any,
    ) => Promise<any>;
    (ledger as any)[method] = async (id: string, value: any) => {
      const result = await original(id, value);
      capture(kind, result);
      return result;
    };
  }
  function capture(kind: string, value: any) {
    const { token, approve_url, sandbox_id, ...safe } = value;
    queue(kind, value.id, safe);
    void flush().catch(() => {
      lastError = "InsForge sync unavailable";
    });
  }
  const originalUsage = ledger.recordUsage.bind(ledger);
  ledger.recordUsage = async (id, amount) => {
    const result = await originalUsage(id, amount);
    const trial = await ledger.getTrial(id);
    if (trial) {
      capture("trial", trial);
      const listing = await localCatalog.get(trial.listing_id);
      if (listing) queue("listing", listing.id, listing);
    }
    return result;
  };
  await flush();
  const timer = setInterval(() => {
    void flush().catch(() => {
      lastError = "InsForge sync unavailable";
    });
  }, 10000);
  timer.unref();
  return {
    status: () => ({
      mode: "insforge-catalog-audit-local-admission",
      pending: Number(
        db.prepare("SELECT count(*) AS n FROM sync_outbox").get()!.n,
      ),
      error: lastError,
    }),
    flush,
    async close() {
      clearInterval(timer);
      await flush();
      db.close();
    },
  };
}
