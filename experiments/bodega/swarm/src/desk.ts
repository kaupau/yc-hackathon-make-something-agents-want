import type { BodegaAdmin } from "./bodega.js";
import type { Bus } from "./events.js";
import { usd, type Mission } from "./missions.js";

export interface Decision { decision: "approved" | "declined"; reason: string }

/**
 * Plays each agent's human. Bodega never returns approval links to agents, so the desk reads
 * the operator approval inbox (admin token), applies that human's policy, and answers the
 * one-use link exactly as a person clicking Approve or Decline would.
 */
export class Desk {
  private decided = new Map<string, Decision>();
  private waiting = new Map<string, (d: Decision) => void>();
  private seen = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly admin: BodegaAdmin,
    private readonly bus: Bus,
    /** Bodega customer id → mission. */
    private readonly owners: Map<string, Mission>,
    private readonly humanDelayMs: number,
  ) {}

  start(pollMs = 300) {
    this.timer = setInterval(() => void this.poll().catch(() => undefined), pollMs);
  }
  stop() { clearInterval(this.timer); }

  waitFor(purchaseId: string, timeoutMs = 60_000): Promise<Decision> {
    const known = this.decided.get(purchaseId);
    if (known) return Promise.resolve(known);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve({ decision: "declined", reason: "No human answer before the approval wait ended" }), timeoutMs);
      this.waiting.set(purchaseId, d => { clearTimeout(timer); resolve(d); });
    });
  }

  private async poll() {
    for (const p of await this.admin.pendingApprovals()) {
      const mission = p.customer_id ? this.owners.get(p.customer_id) : undefined;
      if (!mission || this.seen.has(p.purchase_id) || !p.approve_url) continue;
      this.seen.add(p.purchase_id);
      void this.handle(mission, p.purchase_id, p.listing_id, p.amount_cents, p.approve_url);
    }
  }

  private async handle(mission: Mission, purchaseId: string, listingId: string, amountCents: number, url: string) {
    this.bus.emit({ kind: "approval", agent: mission.id, purchase_id: purchaseId, listing_id: listingId, amount_usd: amountCents / 100, decision: "pending", reason: `Approval email for ${usd(amountCents)} (over the ${usd(mission.thresholdCents)} threshold)` });
    await new Promise(r => setTimeout(r, this.humanDelayMs));
    const veto = mission.human.declines?.[listingId];
    const d: Decision = veto
      ? { decision: "declined", reason: veto }
      : amountCents <= mission.human.approveUpToCents
        ? { decision: "approved", reason: `Fits "${mission.name}" and is under my ${usd(mission.human.approveUpToCents)} comfort limit` }
        : { decision: "declined", reason: mission.greedy ? "Buy what a task needs, not one of everything." : `Over my ${usd(mission.human.approveUpToCents)} limit for this agent` };
    try {
      await this.admin.decide(url, d.decision);
    } catch {
      d.decision = "declined";
      d.reason = "The approval link was no longer valid";
    }
    this.decided.set(purchaseId, d);
    this.bus.emit({ kind: "approval", agent: mission.id, purchase_id: purchaseId, listing_id: listingId, amount_usd: amountCents / 100, decision: d.decision, reason: d.reason });
    this.waiting.get(purchaseId)?.(d);
    this.waiting.delete(purchaseId);
  }
}
