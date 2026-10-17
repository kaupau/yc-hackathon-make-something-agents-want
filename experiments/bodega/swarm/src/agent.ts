import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import type { AgentStatus, Bus } from "./events.js";
import type { Mission } from "./missions.js";
import type { Board } from "./board.js";
import type { Desk } from "./desk.js";

export interface CallResult { ok: boolean; data: any; summary: string }

/** One swarm member: its own Bodega customer, bearer token, MCP session and wallet. */
export class Agent {
  private client = new Client({ name: "bodega-swarm", version: "0.0.1" });
  private calls = 0;
  tools: Tool[] = [];
  constructor(
    readonly mission: Mission,
    private readonly bus: Bus,
    readonly board: Board,
    readonly desk: Desk,
    private readonly pace: number,
  ) {}

  async connect(bodegaUrl: string, token: string) {
    await this.client.connect(new StreamableHTTPClientTransport(new URL(`${bodegaUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}` } } }));
    this.tools = (await this.client.listTools()).tools;
  }
  close() { return this.client.close(); }

  status(status: AgentStatus, step: string) { this.bus.emit({ kind: "status", agent: this.mission.id, status, step }); }
  think(text: string) { this.bus.emit({ kind: "thought", agent: this.mission.id, text }); }
  /** Scripted agents pause between steps so people can follow the swarm; --pace 0 runs flat out. */
  pause(ms = 600) { return this.pace > 0 ? new Promise(r => setTimeout(r, ms * this.pace)) : Promise.resolve(); }

  /** Calls a Bodega MCP tool. Bodega answers with one JSON text block; failures are generic by design. */
  async call(tool: string, args: Record<string, unknown> = {}): Promise<CallResult> {
    const id = ++this.calls;
    this.bus.emit({ kind: "call", agent: this.mission.id, id, tool, args });
    let ok = false, data: any = null;
    try {
      const result = await this.client.callTool({ name: tool, arguments: args });
      const text = (result.content as { type: string; text?: string }[]).find(c => c.type === "text")?.text ?? "null";
      try { data = JSON.parse(text); } catch { data = text; }
      ok = !result.isError;
    } catch (error) {
      data = { error: error instanceof Error ? error.message : String(error) };
    }
    const summary = describe(tool, args, ok, data);
    this.bus.emit({ kind: "result", agent: this.mission.id, id, tool, ok, summary, data });
    if (ok && tool === "wallet") this.bus.emit({ kind: "wallet", agent: this.mission.id, cap_usd: data.cap_usd, threshold_usd: data.threshold_usd, spent_usd: data.spent_usd, reserved_usd: data.reserved_usd ?? 0, remaining_usd: data.remaining_usd });
    if (ok && tool === "buy" && data?.status) this.bus.emit({ kind: "purchase", agent: this.mission.id, listing_id: data.listing_id, name: String(args.listing_id), amount_usd: data.amount_usd, status: data.status, payment_mode: data.payment_mode });
    return { ok, data, summary };
  }

  /** buy(), and when the human threshold applies, wait for the human and repeat the same buy. */
  async buy(listingId: string, name: string, reason: string): Promise<CallResult> {
    const request_id = `${this.mission.id}-${listingId}`;
    let r = await this.call("buy", { listing_id: listingId, reason, request_id });
    if (r.ok && r.data.status === "needs_approval") {
      this.status("awaiting_human", `Waiting for the human to approve ${name} at $${Number(r.data.amount_usd).toFixed(2)}`);
      const decision = await this.desk.waitFor(r.data.purchase_id);
      this.think(decision.decision === "approved" ? `Human approved ${name}.` : `Human declined ${name}: ${decision.reason}`);
      this.status("buying", `Repeating the same buy for ${name}`);
      r = await this.call("buy", { listing_id: listingId, reason, request_id });
    }
    return r;
  }
}

const money = (n: unknown) => `$${Number(n ?? 0).toFixed(2)}`;
export function describe(tool: string, args: Record<string, unknown>, ok: boolean, d: any): string {
  if (!ok) return typeof d?.message === "string" ? d.message : typeof d?.error === "string" ? d.error : "Tool call failed";
  switch (tool) {
    case "need": {
      const list = Array.isArray(d) ? d : [];
      return list.length ? list.map((l: any) => `${l.id} ${money(l.price?.buy_usd)}${l.trial ? `, ${l.trial.per_agent} ${l.trial.unit} free` : ""}`).join(" · ") : "No listings matched";
    }
    case "start_trial": return `${d.listing_id}: ${d.quota?.limit} ${d.quota?.unit} vendor-funded, $${Number(d.charged_usd ?? 0).toFixed(2)} to the human`;
    case "run_trial": return `exit ${d.exit_code} in ${d.duration_ms} ms: ${String(d.stdout ?? "").slice(0, 90)}`;
    case "compare": {
      const results = Array.isArray(d.results) ? d.results : [];
      return `${results.filter((r: any) => r.ok).length}/${results.length} passed ${d.check_id}` + results.filter((r: any) => !r.ok).map((r: any) => `; ${r.listing_id}: ${r.error}`).join("") + (d.suggestion ? `; suggests ${d.suggestion}` : "; no ranking (simulated)");
    }
    case "buy": return `${d.listing_id} ${d.status}${d.amount_usd !== undefined ? ` ${money(d.amount_usd)}` : ""} (${d.payment_mode}), ${money(d.remaining_usd)} left`;
    case "wallet": return `spent ${money(d.spent_usd)}, reserved ${money(d.reserved_usd)}, ${money(d.remaining_usd)} left of ${money(d.cap_usd)}`;
    case "review": return `${args.verdict} ${args.listing_id}`;
    case "use":
      if (d?.simulated) return `${args.tool}: simulated, no provider request`;
      if (Number(d?.status) >= 400) return `${args.tool}: provider call failed closed (HTTP ${d.status}); purchase stays valid`;
      return `${args.tool}: ${JSON.stringify(d).slice(0, 120)}`;
    default: return JSON.stringify(d).slice(0, 140);
  }
}
