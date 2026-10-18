// End to end: boots a private Bodega, runs the whole scripted swarm flat out, checks the guardrails.
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { SwarmEvent } from "./events.js";
import { runSwarm } from "./swarm.js";

test("scripted swarm shops within every human's rules", { timeout: 120_000 }, async () => {
  const runDir = mkdtempSync(path.join(tmpdir(), "bodega-swarm-"));
  try {
    const { events } = await runSwarm({
      brain: "scripted", pace: 0, bodegaPort: 18_000 + Math.floor(Math.random() * 2000), runDir,
      claude: { model: "unused", effort: "low", maxTurns: 1 },
    });
    const of = <K extends SwarmEvent["kind"]>(kind: K) => events.filter((e): e is Extract<SwarmEvent, { kind: K }> => e.kind === kind);
    const done = new Map(of("done").map(e => [e.agent, e]));
    assert.deepEqual([...done.keys()].sort(), ["concierge", "hoarder", "login", "scout", "support", "waitlist"]);
    for (const id of ["waitlist", "scout", "concierge", "login", "support"]) assert.ok(done.get(id)!.ok, `${id}: ${done.get(id)!.blockers.join("; ")}`);

    // Every wallet stays inside its human's cap.
    const last = new Map(of("wallet").map(w => [w.agent, w]));
    for (const w of last.values()) assert.ok(w.spent_usd <= w.cap_usd + 1e-9, `${w.agent} overspent`);

    // The human vetoes the concierge's optional voice purchase; the greedy agent hits the server-side cap.
    assert.ok(of("approval").some(a => a.agent === "concierge" && a.listing_id === "callwire-voice" && a.decision === "declined"));
    const calls = new Map(of("call").map(c => [`${c.agent}:${c.id}`, c]));
    assert.ok(of("result").some(r => r.agent === "hoarder" && r.tool === "buy" && !r.ok), "cap refusal expected");

    // The swarm board saves vendor trials: PostPigeon's failing roundtrip is tested once, not twice.
    const pigeonCompares = of("call").filter(c => c.tool === "compare" && JSON.stringify(c.args).includes("postpigeon-email"));
    assert.equal(pigeonCompares.length, 1);
    // Support cannot afford Primitive plus a database on $2.50, so it picks Inkbox and Quarry.
    const supportBuys = of("purchase").filter(p => p.agent === "support" && p.status === "paid").map(p => p.listing_id).sort();
    assert.deepEqual(supportBuys, ["inkbox-email", "quarry-db"]);
    assert.ok(calls.size > 40);

    // Vendors get their funnel; nothing secret reaches the log.
    assert.ok(of("funnel")[0].vendors.some(v => v.listings.some(l => l.purchases > 0)));
    assert.doesNotMatch(JSON.stringify(events), /bdg_(live|agt|trial)_(?!\[redacted\])|\/approve\/(?!\[redacted\])/);
  } finally {
    rmSync(runDir, { recursive: true, force: true });
  }
});
