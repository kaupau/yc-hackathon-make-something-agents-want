// One event stream drives the terminal log, the live dashboard and the saved replay.
// Every payload is redacted before it is stored, so a replay can be shared.

export type AgentStatus = "waiting" | "shopping" | "trialing" | "buying" | "awaiting_human" | "using" | "done" | "blocked";

export type SwarmEvent =
  | { kind: "run"; t: number; run_id: string; brain: string; bodega_url: string; runtime: string; payments: string; agents: AgentCard[] }
  | { kind: "status"; t: number; agent: string; status: AgentStatus; step: string }
  | { kind: "call"; t: number; agent: string; id: number; tool: string; args: unknown }
  | { kind: "result"; t: number; agent: string; id: number; tool: string; ok: boolean; summary: string; data: unknown }
  | { kind: "thought"; t: number; agent: string; text: string }
  | { kind: "board"; t: number; agent: string; topic: string; note: string }
  | { kind: "approval"; t: number; agent: string; purchase_id: string; listing_id: string; amount_usd: number; decision: "pending" | "approved" | "declined"; reason: string }
  | { kind: "wallet"; t: number; agent: string; cap_usd: number; threshold_usd: number; spent_usd: number; reserved_usd: number; remaining_usd: number }
  | { kind: "purchase"; t: number; agent: string; listing_id: string; name: string; amount_usd: number; status: string; payment_mode: string }
  | { kind: "done"; t: number; agent: string; ok: boolean; summary: string; blockers: string[] }
  | { kind: "funnel"; t: number; vendors: VendorFunnel[] }
  | { kind: "end"; t: number; duration_ms: number };

export interface AgentCard { id: string; name: string; goal: string; cap_usd: number; threshold_usd: number }
export interface VendorFunnel {
  vendor_id: string;
  listings: { listing_id: string; trials: number; checks_run: number; checks_passed: number; chosen: number; rejected: number; purchases: number; revenue_usd: number; top_reasons: string[] }[];
}

type Omit_t<E> = E extends unknown ? Omit<E, "t"> : never;
export type NewEvent = Omit_t<SwarmEvent>;

/** Bearer capabilities Bodega hands out; none of them belong in a log or a shared replay. */
const SECRETS: [RegExp, string][] = [
  [/bdg_(live|agt|trial)_[A-Za-z0-9_-]+/g, "bdg_$1_[redacted]"],
  [/(\/approve\/)[A-Za-z0-9_-]+/g, "$1[redacted]"],
  [/(\/proxy\/)[^/\s"]+/g, "$1[redacted]"],
];
export function redact<T>(value: T): T {
  return JSON.parse(JSON.stringify(value ?? null, (_k, v) => typeof v === "string" ? SECRETS.reduce((s, [re, to]) => s.replace(re, to), v) : v));
}

export class Bus {
  readonly events: SwarmEvent[] = [];
  private listeners = new Set<(e: SwarmEvent) => void>();
  constructor(private readonly start = Date.now()) {}
  emit(event: NewEvent): SwarmEvent {
    const e = redact({ ...event, t: Date.now() - this.start } as SwarmEvent);
    this.events.push(e);
    for (const l of this.listeners) l(e);
    return e;
  }
  on(listener: (e: SwarmEvent) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
}
