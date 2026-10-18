import type { Bus } from "./events.js";

/** What one agent learned about a category, for the rest of the swarm. */
export interface Finding {
  by: string;
  topic: string;
  /** Listings that failed a measured check, with the observed error. */
  failed: Record<string, string>;
  passed: string[];
  /** Trials ran but nothing was measured (simulated runtime or no check adapter). */
  unmeasured: string[];
  /** The check ran on Bodega's simulated runtime: pass/fail is a fixture, not a measurement. */
  simulated: boolean;
  note: string;
}

/**
 * Shared swarm memory. An agent claims a topic before trialing it; a peer that needs the
 * same topic waits for the finding instead of spending a second set of vendor trials.
 */
export class Board {
  private findings = new Map<string, Finding>();
  private claims = new Map<string, string>();
  private waiters = new Map<string, ((f: Finding | null) => void)[]>();
  readonly notes: { agent: string; topic: string; note: string }[] = [];
  constructor(private readonly bus: Bus) {}

  finding(topic: string) { return this.findings.get(topic) ?? null; }
  claimedBy(topic: string) { return this.claims.get(topic) ?? null; }
  claim(topic: string, agent: string) {
    if (this.claims.has(topic) || this.findings.has(topic)) return false;
    this.claims.set(topic, agent);
    return true;
  }
  /** Resolves with the topic's finding, or null when the claimer gives up or the wait times out. */
  waitFor(topic: string, timeoutMs: number): Promise<Finding | null> {
    const existing = this.findings.get(topic);
    if (existing) return Promise.resolve(existing);
    return new Promise(resolve => {
      const timer = setTimeout(() => resolve(null), timeoutMs);
      const list = this.waiters.get(topic) ?? [];
      list.push(f => { clearTimeout(timer); resolve(f); });
      this.waiters.set(topic, list);
    });
  }
  release(topic: string, agent: string) {
    if (this.claims.get(topic) !== agent) return;
    this.claims.delete(topic);
    for (const w of this.waiters.get(topic) ?? []) w(null);
    this.waiters.delete(topic);
  }
  post(finding: Finding) {
    this.findings.set(finding.topic, finding);
    this.claims.delete(finding.topic);
    this.note(finding.by, finding.topic, finding.note);
    for (const w of this.waiters.get(finding.topic) ?? []) w(finding);
    this.waiters.delete(finding.topic);
  }
  /** Free-form note; the Claude brain uses this directly. */
  note(agent: string, topic: string, note: string) {
    this.notes.push({ agent, topic, note });
    this.bus.emit({ kind: "board", agent, topic, note });
  }
  read(topic?: string) { return this.notes.filter(n => !topic || n.topic === topic); }
}
