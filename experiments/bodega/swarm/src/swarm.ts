// Bodega agent swarm. Boots a private local Bodega (or targets a running one), provisions one
// customer per agent, runs every agent in parallel over its own MCP session, plays each
// agent's human at the approval desk, and streams it all to a live dashboard.
import { randomBytes } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { Agent } from "./agent.js";
import { Board } from "./board.js";
import { BodegaAdmin, bootLocalBodega } from "./bodega.js";
import { claudeBrain, type ClaudeOptions } from "./brains/claude.js";
import { scriptedBrain, type Outcome } from "./brains/scripted.js";
import { Desk } from "./desk.js";
import { Bus, type SwarmEvent } from "./events.js";
import { MISSIONS, type Mission } from "./missions.js";
import { renderPage } from "./page.js";

const here = path.dirname(fileURLToPath(import.meta.url));

export interface SwarmOptions {
  brain: "scripted" | "claude";
  agents?: string[];
  pace: number;
  bodegaUrl?: string;
  adminToken?: string;
  bodegaPort: number;
  claude: ClaudeOptions;
  runDir: string;
  onEvent?: (e: SwarmEvent) => void;
  bus?: Bus;
}

export async function runSwarm(opts: SwarmOptions) {
  const runId = path.basename(opts.runDir);
  const bus = opts.bus ?? new Bus();
  if (opts.onEvent) bus.on(opts.onEvent);
  const missions = MISSIONS.filter(m => !opts.agents?.length || opts.agents.includes(m.id));
  if (!missions.length) throw new Error(`No missions match ${opts.agents?.join(", ")}; choose from ${MISSIONS.map(m => m.id).join(", ")}`);

  let stopBodega = async () => {};
  let url = opts.bodegaUrl?.replace(/\/$/, "");
  let adminToken = opts.adminToken;
  if (!url) {
    adminToken = `swarm-admin-${randomBytes(18).toString("base64url")}`;
    const local = await bootLocalBodega({ port: opts.bodegaPort, dataDir: path.join(opts.runDir, "bodega-data"), adminToken });
    url = local.url;
    stopBodega = local.stop;
  }
  if (!adminToken) throw new Error("A remote Bodega needs BODEGA_ADMIN_TOKEN to provision swarm customers and answer approvals");
  const admin = new BodegaAdmin(url, adminToken);
  const started = Date.now();
  const agents: Agent[] = [];
  let desk: Desk | undefined;
  try {
    const health = await admin.health();
    const owners = new Map<string, Mission>();
    const board = new Board(bus);
    // Customer ids are unique per run so a shared Bodega keeps every run's wallets apart.
    const suffix = runId.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(-10);
    const tokens = new Map<string, string>();
    for (const m of missions) {
      const customer = `swarm-${m.id}-${suffix}`;
      tokens.set(m.id, await admin.createCustomer(customer, `${m.id}@swarm.example`, m.capCents, m.thresholdCents));
      owners.set(customer, m);
    }
    desk = new Desk(admin, bus, owners, opts.pace > 0 ? 1200 * opts.pace : 0);
    desk.start(opts.pace > 0 ? 300 : 50);
    bus.emit({ kind: "run", run_id: runId, brain: opts.brain === "claude" ? `claude (${opts.claude.model})` : "scripted", bodega_url: url, runtime: health.runtime, payments: health.payments, agents: missions.map(m => ({ id: m.id, name: m.name, goal: m.goal, cap_usd: m.capCents / 100, threshold_usd: m.thresholdCents / 100 })) });

    const outcomes = await Promise.all(missions.map(async m => {
      const agent = new Agent(m, bus, board, desk!, opts.brain === "claude" ? 0 : opts.pace);
      agents.push(agent);
      agent.status("waiting", "Queued");
      await new Promise(r => setTimeout(r, m.startDelayMs * Math.max(opts.pace, opts.brain === "claude" ? 1 : 0)));
      let outcome: Outcome;
      try {
        await agent.connect(url!, tokens.get(m.id)!);
        outcome = opts.brain === "claude" ? await claudeBrain(agent, opts.claude) : await scriptedBrain(agent);
        if (opts.brain === "claude") await agent.call("wallet");
      } catch (error) {
        outcome = { ok: false, summary: "Agent crashed", blockers: [error instanceof Error ? error.message : String(error)] };
      }
      bus.emit({ kind: "done", agent: m.id, ok: outcome.ok, summary: outcome.summary, blockers: outcome.blockers });
      return { mission: m, outcome };
    }));

    // Close the loop for vendors: Bodega's own funnel, built from every trial, review and buy.
    const vendors = await Promise.all((await admin.vendors()).map(v => admin.funnel(v).catch(() => null)));
    bus.emit({ kind: "funnel", vendors: vendors.filter(v => v !== null) });
    bus.emit({ kind: "end", duration_ms: Date.now() - started });
    return { url, outcomes, events: bus.events };
  } finally {
    desk?.stop();
    await Promise.all(agents.map(a => a.close().catch(() => undefined)));
    await stopBodega();
  }
}

export function writeReport(runDir: string, events: SwarmEvent[]) {
  mkdirSync(runDir, { recursive: true });
  writeFileSync(path.join(runDir, "events.json"), JSON.stringify(events, null, 1));
  writeFileSync(path.join(runDir, "report.html"), renderPage({ mode: "replay", events }));
  // Wrapper-free variant for hosts that supply their own document skeleton.
  writeFileSync(path.join(runDir, "report.fragment.html"), renderPage({ mode: "replay", events, fragment: true }));
  return path.join(runDir, "report.html");
}

function serveDashboard(bus: Bus, port: number): Promise<Server> {
  const clients = new Set<import("node:http").ServerResponse>();
  let ended = false;
  bus.on(e => {
    for (const c of clients) {
      c.write(`data: ${JSON.stringify(e)}\n\n`);
      if (e.kind === "end") c.write("event: end\ndata: {}\n\n");
    }
    if (e.kind === "end") ended = true;
  });
  const page = renderPage({ mode: "live" });
  const server = createServer((req, res) => {
    if (req.url === "/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      for (const e of bus.events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      if (ended) res.write("event: end\ndata: {}\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (req.url === "/" || req.url === "/index.html") { res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }); res.end(page); return; }
    res.writeHead(404).end();
  });
  return new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, "127.0.0.1", () => resolve(server)); });
}

// Terminal view: one colored lane per agent.
const COLORS = [33, 36, 35, 32, 34, 31];
function terminal(missions: Mission[]) {
  const color = new Map(missions.map((m, i) => [m.id, COLORS[i % COLORS.length]]));
  const tag = (id: string) => `\x1b[${color.get(id) ?? 37}m${id.padEnd(10)}\x1b[0m`;
  const s = (t: number) => `\x1b[2m${(t / 1000).toFixed(1).padStart(5)}s\x1b[0m`;
  return (e: SwarmEvent) => {
    if (e.kind === "result") console.log(`${s(e.t)} ${tag(e.agent)} ${e.ok ? "" : "\x1b[31m✗ \x1b[0m"}${e.tool.padEnd(11)} ${e.summary}`);
    else if (e.kind === "thought") console.log(`${s(e.t)} ${tag(e.agent)} \x1b[2m${e.text}\x1b[0m`);
    else if (e.kind === "approval" && e.decision !== "pending") console.log(`${s(e.t)} ${tag(e.agent)} \x1b[1mhuman ${e.decision}\x1b[0m ${e.listing_id} $${e.amount_usd.toFixed(2)}: ${e.reason}`);
    else if (e.kind === "board") console.log(`${s(e.t)} ${tag(e.agent)} \x1b[1mboard[${e.topic}]\x1b[0m ${e.note}`);
    else if (e.kind === "done") console.log(`${s(e.t)} ${tag(e.agent)} \x1b[1m${e.ok ? "DONE" : "BLOCKED"}\x1b[0m ${e.summary}${e.blockers.length ? `\n${" ".repeat(18)}↳ ${e.blockers.join(`\n${" ".repeat(18)}↳ `)}` : ""}`);
  };
}

async function main() {
  const { values } = parseArgs({
    options: {
      brain: { type: "string", default: "scripted" },
      agents: { type: "string" },
      pace: { type: "string", default: "1" },
      port: { type: "string", default: "8790" },
      "bodega-port": { type: "string", default: "8799" },
      "bodega-url": { type: "string" },
      model: { type: "string", default: "claude-opus-5-5" },
      effort: { type: "string", default: "medium" },
      "max-turns": { type: "string", default: "40" },
      "no-dashboard": { type: "boolean", default: false },
      once: { type: "boolean", default: false },
      quiet: { type: "boolean", default: false },
    },
  });
  const brain = values.brain === "claude" ? "claude" : "scripted";
  if (values.brain !== brain) throw new Error(`--brain must be scripted or claude`);
  if (brain === "claude" && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN)
    console.warn("No ANTHROPIC_API_KEY in the environment; the SDK will try an `ant auth login` profile.");
  const runId = new Date().toISOString().replace(/[:.]/g, "-").replace("T", "_").slice(0, 19);
  const runDir = path.resolve(here, "../runs", runId);
  const agentsList = values.agents?.split(",").map(s => s.trim()).filter(Boolean);
  const bus = new Bus();
  const missions = MISSIONS.filter(m => !agentsList?.length || agentsList.includes(m.id));
  if (!values.quiet) bus.on(terminal(missions));
  let server: Server | undefined;
  if (!values["no-dashboard"]) {
    server = await serveDashboard(bus, Number(values.port));
    console.log(`\x1b[1mSwarm floor:\x1b[0m http://127.0.0.1:${values.port}  (brain: ${brain}${brain === "claude" ? `, ${values.model}` : ""})\n`);
  }
  const result = await runSwarm({
    brain, agents: agentsList, pace: Number(values.pace), bodegaPort: Number(values["bodega-port"]),
    bodegaUrl: values["bodega-url"] ?? process.env.BODEGA_URL, adminToken: process.env.BODEGA_ADMIN_TOKEN,
    claude: { model: values.model!, effort: values.effort as ClaudeOptions["effort"], maxTurns: Number(values["max-turns"]) },
    runDir, bus,
  });
  const report = writeReport(runDir, result.events);
  const done = result.outcomes.filter(o => o.outcome.ok).length;
  console.log(`\n${done}/${result.outcomes.length} agents finished their job without blockers. Replay: ${report}`);
  if (server && !values.once) console.log(`Swarm floor still at http://127.0.0.1:${values.port}. Ctrl-C to exit.`);
  else server?.close();
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(error instanceof Error ? error.message : error); process.exit(1); });
