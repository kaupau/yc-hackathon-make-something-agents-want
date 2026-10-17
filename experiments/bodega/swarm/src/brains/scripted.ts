// Deterministic shopper. No LLM: every choice is computed from what Bodega returned
// (listings, trial output, comparison results, wallet), so the run is repeatable and free.
import type { Agent } from "../agent.js";
import type { Finding } from "../board.js";
import { usd, type Need } from "../missions.js";

export interface Outcome { ok: boolean; summary: string; blockers: string[] }
interface Listing { id: string; name: string; description?: string; price: { buy_usd: number; unit_label: string }; trial: { per_agent: number; unit: string } | null; integration?: string; checks?: string[] }

const cents = (l: Listing) => Math.round(l.price.buy_usd * 100);
const SMOKE = `const base = process.env.BODEGA_TOOL_BASE_URL, key = process.env.BODEGA_TOOL_KEY;
const started = Date.now();
const response = await fetch(base + "/", { headers: { Authorization: "Bearer " + key } });
console.log(JSON.stringify({ status: response.status, ms: Date.now() - started }));`;

export async function scriptedBrain(agent: Agent): Promise<Outcome> {
  return agent.mission.greedy ? greedy(agent) : shop(agent);
}

async function shop(agent: Agent): Promise<Outcome> {
  const m = agent.mission;
  const blockers: string[] = [];
  /** Not blocking the job, but the human has to act (e.g. add a provider key). */
  const followups: string[] = [];
  const bought: string[] = [];
  agent.status("shopping", "Reading the wallet the human set");
  let wallet = (await agent.call("wallet")).data;
  agent.think(`Job: ${m.goal} Budget ${usd(Math.round(wallet.cap_usd * 100))}, approval above ${usd(Math.round(wallet.threshold_usd * 100))}.`);

  // Discover every need first so the budget can be split across them.
  const options = new Map<Need, Listing[]>();
  for (const need of m.needs) {
    agent.status("shopping", `need("${need.capability}")`);
    const found: Listing[] = (await agent.call("need", { capability: need.capability })).data ?? [];
    const candidates = found.filter(l => need.check ? l.checks?.includes(need.check) : !l.trial);
    options.set(need, candidates);
    if (!candidates.length) blockers.push(`No listing in the store covers "${need.capability}"`);
    await agent.pause();
  }

  for (const [i, need] of m.needs.entries()) {
    const candidates = options.get(need)!;
    if (!candidates.length) continue;
    const evidence = await evaluate(agent, need, candidates);
    // Keep enough for the cheapest option of every required need still ahead.
    const keep = m.needs.slice(i + 1).filter(n => !n.optional && options.get(n)?.length).reduce((sum, n) => sum + Math.min(...options.get(n)!.map(cents)), 0);
    wallet = (await agent.call("wallet")).data;
    const budget = Math.round(wallet.remaining_usd * 100) - keep;
    const ranked = rank(need, candidates, evidence);
    let chosen: Listing | null = null;
    for (const { listing, score, why } of ranked) {
      if (cents(listing) > budget) {
        agent.think(`${listing.name} (${usd(cents(listing))}) ${score > 0 ? "fits the job best but " : ""}would leave less than ${usd(keep)} for the rest of the job.`);
        continue;
      }
      const reason = `${why}; ${usd(cents(listing))} fits ${usd(Math.round(wallet.remaining_usd * 100))} left${keep ? ` with ${usd(keep)} kept for the rest of the job` : ""}`;
      agent.status("buying", `Buying ${listing.name}`);
      const r = await agent.buy(listing.id, listing.name, reason);
      await agent.pause(400);
      if (r.ok && r.data.status === "paid") {
        chosen = listing;
        bought.push(`${listing.name} ${usd(cents(listing))}`);
        await agent.call("review", { listing_id: listing.id, verdict: "chosen", reason: clip(reason) });
        for (const other of candidates.filter(c => c.id !== listing.id))
          await agent.call("review", { listing_id: other.id, verdict: "rejected", reason: clip(rejectReason(other, listing, evidence, budget)) });
        agent.board.note(m.id, need.topic, `Bought ${listing.name} for ${usd(cents(listing))}: ${why}`);
        if (need.use && (r.data.tools_now_available ?? []).includes(need.use.tool)) await use(agent, listing, need, followups);
        break;
      }
      if (r.ok && r.data.status === "declined") {
        agent.think(`Human said no to ${listing.name}; ${need.optional ? "this was optional, moving on" : "trying the next option"}.`);
        await agent.call("review", { listing_id: listing.id, verdict: "neutral", reason: "Agent wanted it; the human declined the purchase" });
        if (need.optional) break;
        continue;
      }
      blockers.push(`${listing.name}: ${r.summary}`);
    }
    if (!chosen && !need.optional && !blockers.some(b => b.includes(need.capability))) blockers.push(`Nothing affordable and approved for "${need.capability}"`);
    await agent.pause();
  }

  wallet = (await agent.call("wallet")).data;
  const summary = `${bought.length ? `Bought ${bought.join(", ")}` : "Bought nothing"}; spent ${usd(Math.round(wallet.spent_usd * 100))} of ${usd(Math.round(wallet.cap_usd * 100))}.`;
  return { ok: blockers.length === 0, summary, blockers: [...blockers, ...followups] };
}

/** Trials, or a peer's finding from the board when another agent already covered this topic. */
async function evaluate(agent: Agent, need: Need, candidates: Listing[]): Promise<Finding> {
  const m = agent.mission;
  let peer = agent.board.finding(need.topic);
  if (!peer && !agent.board.claim(need.topic, m.id)) {
    const owner = agent.board.claimedBy(need.topic);
    agent.status("waiting", `${owner} is already testing ${need.topic}; waiting for its findings`);
    peer = await agent.board.waitFor(need.topic, 45_000);
    if (!peer) agent.board.claim(need.topic, m.id);
  }
  if (peer) agent.think(`Board: ${peer.by} already tested ${need.topic}. ${peer.note}`);
  const failed: Record<string, string> = { ...(peer?.failed ?? {}) };
  const passed: string[] = [];
  const unmeasured: string[] = [];
  let simulated = peer?.simulated ?? false;
  const fresh = candidates.filter(c => !failed[c.id]);
  if (peer && Object.keys(peer.failed).length) agent.think(`Skipping ${Object.keys(peer.failed).join(", ")}: ${peer.by} saw ${Object.values(peer.failed).join("; ")}.`);
  try {
    if (need.check === "email.roundtrip" && fresh.length) {
      // A measured check is cheap and vendor-funded, so re-run it on the survivors for our own evidence.
      agent.status("trialing", `compare(${fresh.map(c => c.id).join(", ")}) on email.roundtrip`);
      const r = await agent.call("compare", { listing_ids: fresh.map(c => c.id), check_id: need.check });
      // Bodega labels simulated comparisons and never ranks them.
      simulated = /simulated/i.test(String(r.data?.reason ?? ""));
      for (const res of r.data?.results ?? []) {
        if (res.ok) passed.push(res.listing_id);
        else failed[res.listing_id] = res.error ?? "check failed";
      }
    } else if (peer) {
      unmeasured.push(...peer.unmeasured, ...peer.passed);
      agent.think(`Reusing ${peer.by}'s ${need.topic} trials instead of spending more vendor credits.`);
    } else {
      for (const c of fresh) {
        if (!c.trial) { agent.think(`${c.name} is buy-only: no trial offered, so price and fit decide.`); continue; }
        agent.status("trialing", `Trial: ${c.name} (${c.trial.per_agent} ${c.trial.unit}, vendor-funded)`);
        const t = await agent.call("start_trial", { listing_id: c.id });
        if (!t.ok) { failed[c.id] = "trial would not start"; continue; }
        const run = await agent.call("run_trial", { trial_id: t.data.trial_id, file: { path: "/blaxel/app/smoke.mjs", content: SMOKE }, timeout_s: 30 });
        const out = String(run.data?.stdout ?? "");
        if (!run.ok || run.data.exit_code !== 0) failed[c.id] = `smoke test exited ${run.data?.exit_code ?? "with an error"}`;
        else if (out.startsWith("[simulated")) unmeasured.push(c.id);
        else passed.push(c.id);
        await agent.pause(300);
      }
    }
  } finally {
    if (!peer) {
      const note = [
        passed.length && `passed${simulated ? " (simulated)" : ""}: ${passed.join(", ")}`,
        Object.keys(failed).length && `failed: ${Object.entries(failed).map(([id, e]) => `${id} (${e})`).join(", ")}`,
        unmeasured.length && `trialed, nothing measured (simulated): ${unmeasured.join(", ")}`,
      ].filter(Boolean).join("; ") || "no trials offered";
      agent.board.post({ by: m.id, topic: need.topic, failed, passed, unmeasured, simulated, note });
    }
  }
  return { by: m.id, topic: need.topic, failed, passed, unmeasured, simulated, note: "" };
}

function rank(need: Need, candidates: Listing[], e: Finding) {
  return candidates
    .filter(c => !e.failed[c.id])
    .map(listing => {
      const text = `${listing.name} ${listing.description ?? ""}`.toLowerCase();
      const hits = need.prefer.filter(w => text.includes(w));
      const measured = e.passed.includes(listing.id);
      const score = hits.length * 2 + (measured ? 3 : 0);
      const why = [
        measured ? `passed ${need.check}${e.simulated ? " (simulated runtime)" : ""}` : e.unmeasured.includes(listing.id) ? "trial ran, nothing measured" : !listing.trial ? "buy-only listing" : "",
        hits.length ? `matches ${hits.map(h => `"${h}"`).join(", ")}` : "",
      ].filter(Boolean).join(", ") || "only remaining option";
      return { listing, score, why: why[0].toUpperCase() + why.slice(1) };
    })
    .sort((a, b) => b.score - a.score || cents(a.listing) - cents(b.listing));
}

function rejectReason(other: Listing, chosen: Listing, e: Finding, budget: number) {
  if (e.failed[other.id]) return `Failed ${e.failed[other.id]}`;
  if (cents(other) > budget) return `${usd(cents(other))} did not fit the budget; chose ${chosen.name} at ${usd(cents(chosen))}`;
  return `${chosen.name} fit this job better`;
}

async function use(agent: Agent, listing: Listing, need: Need, followups: string[]) {
  agent.status("using", `Trying ${need.use!.tool} on ${listing.name}`);
  const r = await agent.call("use", { listing_id: listing.id, tool: need.use!.tool, args: need.use!.args });
  // A real provider answers through Bodega's proxy; its HTTP status is in the result body.
  if (!r.ok || Number(r.data?.status) >= 400) {
    const note = listing.integration === "requires-provider-credentials"
      ? `${listing.name} is paid for; ${need.use!.tool} failed closed because this Bodega has no ${listing.name} provider key`
      : `${need.use!.tool} failed: ${r.summary}`;
    agent.think(note);
    followups.push(note);
  }
}

/** Buys everything need() shows, in the order shown. The human threshold and the cap stop it. */
async function greedy(agent: Agent): Promise<Outcome> {
  const m = agent.mission;
  agent.status("shopping", "Looking for anything to buy");
  const found: Listing[] = (await agent.call("need", { capability: m.needs[0].capability })).data ?? [];
  agent.think(`Found ${found.length} listings. Buying all of them.`);
  const bought: string[] = [], vetoed: string[] = [], refused: string[] = [];
  for (const l of found) {
    agent.status("buying", `Buying ${l.name} (${usd(cents(l))})`);
    const r = await agent.buy(l.id, l.name, "Might need it later");
    if (r.ok && r.data.status === "paid") bought.push(l.name);
    else if (r.ok && r.data.status === "declined") vetoed.push(l.name);
    else {
      const w = (await agent.call("wallet")).data;
      agent.think(`Bodega refused ${l.name}: ${usd(cents(l))} is more than the ${usd(Math.round(w.remaining_usd * 100))} left under the human's cap.`);
      refused.push(l.name);
    }
    await agent.pause(400);
  }
  const w = (await agent.call("wallet")).data;
  return {
    ok: false,
    summary: `Bought ${bought.length} tools no task asked for (${usd(Math.round(w.spent_usd * 100))} of ${usd(Math.round(w.cap_usd * 100))}); the human declined ${vetoed.length}; Bodega refused ${refused.length} at the cap.`,
    blockers: [...vetoed.map(n => `Human declined ${n}`), ...refused.map(n => `Cap reached: ${n} refused server-side`)],
  };
}

const clip = (s: string) => s.length > 480 ? `${s.slice(0, 477)}…` : s;
