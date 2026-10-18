import type {
  Catalog,
  CheckId,
  CheckResult,
  ComparisonReport,
  Ledger,
  Listing,
  ListingId,
  RunRequest,
  RunResult,
  SessionId,
  Trial,
  TrialRuntime,
  Vault,
} from "../contracts/index.js";
import { nextId, nowIso } from "./ids.js";

// Canned results for the demo category. The real runtime (B) measures these in Blaxel sandboxes.
const CANNED: Record<string, Omit<CheckResult, "listing_id" | "trial_id">> = {
  "primitive-email": { ok: true, metrics: { send_ms: 640, deliver_ms: 1460 }, loc: 9, logs_tail: "sent msg_1; received after 3 polls" },
  "inkbox-email": { ok: true, metrics: { send_ms: 910, deliver_ms: 2490 }, loc: 14, logs_tail: "sent msg_1; received after 5 polls" },
  "postpigeon-email": {
    ok: false,
    metrics: { send_ms: 520 },
    loc: 11,
    error: "401 on GET /messages: scoped trial key lacks read scope",
    logs_tail: "sent msg_1; receive failed",
  },
};

const CALLS_PER_CHECK = 3; // create/get inbox, send, poll

export class MockTrialRuntime implements TrialRuntime {
  constructor(
    private catalog: Catalog,
    private ledger: Ledger,
    private vault: Vault,
  ) {}

  async start(listing: Listing, session_id: SessionId): Promise<Trial> {
    if (!listing.trial || !listing.sandbox) throw new Error(`${listing.id} has no trial; buy() it instead`);
    const existing = (await this.ledger.listTrials(session_id)).find((t) => t.listing_id === listing.id && t.status === "active");
    if (existing) return existing;
    const id = nextId("trial");
    const trial: Trial = {
      id,
      listing_id: listing.id,
      session_id,
      sandbox_id: `mock-sbx-${id}`,
      status: "active",
      used: 0,
      limit: listing.trial.per_agent,
      unit: listing.trial.unit,
      token: `bdg_trial_${id}`,
      started_at: nowIso(),
      expires_at: new Date(Date.now() + listing.trial.expires_after_min * 60_000).toISOString(),
    };
    await this.vault.lease(listing.id, id); // real runtime hands this to the proxy, never the sandbox
    await this.ledger.createTrial(trial);
    return trial;
  }

  async run(req: RunRequest): Promise<RunResult> {
    const trial = await this.ledger.getTrial(req.trial_id);
    if (!trial) throw new Error(`no trial ${req.trial_id}`);
    const usage = await this.ledger.recordUsage(trial.id, 1);
    return {
      trial_id: trial.id,
      exit_code: 0,
      stdout: `[mock sandbox ${trial.sandbox_id}] ran: ${req.command ?? req.file?.path ?? "(nothing)"}`,
      stderr: "",
      duration_ms: 120,
      quota: { used: usage.used, limit: usage.limit, unit: trial.unit },
    };
  }

  async compare(listing_ids: ListingId[], check_id: CheckId, session_id: SessionId): Promise<ComparisonReport> {
    const results = await Promise.all(
      listing_ids.map(async (id): Promise<CheckResult> => {
        const listing = await this.catalog.get(id);
        if (!listing) throw new Error(`no listing ${id}`);
        const trial = await this.start(listing, session_id);
        await this.ledger.recordUsage(trial.id, CALLS_PER_CHECK);
        const canned = CANNED[id] ?? { ok: true, metrics: { total_ms: 800 + id.length * 37 }, loc: 10, logs_tail: "mock check passed" };
        return { listing_id: id, trial_id: trial.id, ...canned };
      }),
    );
    const total = (r: CheckResult) => Object.values(r.metrics).reduce((a, b) => a + b, 0);
    const best = results.filter((r) => r.ok).sort((a, b) => total(a) - total(b) || a.loc - b.loc)[0];
    const report: ComparisonReport = {
      id: nextId("cmp"),
      check_id,
      session_id,
      results,
      suggestion: best?.listing_id ?? null,
      reason: best ? `fastest passing ${check_id} (${total(best)} ms, ${best.loc} LOC)` : "no listing passed",
      created_at: nowIso(),
    };
    await this.ledger.recordComparison(report);
    return report;
  }

  async end(trial_id: string): Promise<void> {
    await this.ledger.updateTrial(trial_id, { status: "ended" });
    await this.vault.revoke(trial_id);
  }
}
