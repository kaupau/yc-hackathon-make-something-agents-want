import { randomBytes, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { CheckResult, ComparisonReport, Listing, RunRequest, RunResult, Services, Trial, TrialRuntime } from '../contracts/index.js';
import { unavailableBackend, type SandboxBackend } from './backend.js';
import { emailRoundtripScript, type EmailCheckOptions } from './checks.js';

export type RuntimeServices = Pick<Services, 'catalog' | 'ledger' | 'vault'>;
export interface RuntimeOptions {
  backend?: SandboxBackend; publicBaseUrl?: string; maxOutputBytes?: number; maxRunTimeoutMs?: number;
  reaperIntervalMs?: number; now?: () => number; email?: EmailCheckOptions;
}
const shellQuote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const trim = (text: string, max: number) => Buffer.from(text).subarray(0, max).toString('utf8');
export function createTrialRuntime(services: RuntimeServices, options: RuntimeOptions = {}): ManagedTrialRuntime {
  return new ManagedTrialRuntime(services, options);
}
export class ManagedTrialRuntime implements TrialRuntime {
  readonly backend: SandboxBackend;
  private readonly now: () => number;
  private readonly owned = new Set<string>();
  private readonly pendingStarts = new Map<string, Promise<Trial>>();
  private readonly pendingEnds = new Map<string, Promise<void>>();
  private readonly busyRuns = new Set<string>();
  private readonly timer?: ReturnType<typeof setInterval>;
  constructor(private services: RuntimeServices, private options: RuntimeOptions = {}) {
    this.backend = options.backend ?? unavailableBackend;
    this.now = options.now ?? Date.now;
    if ((options.reaperIntervalMs ?? 30000) > 0) {
      this.timer = setInterval(() => { void this.reapExpired().catch(() => undefined); }, options.reaperIntervalMs ?? 30000);
      this.timer.unref();
    }
  }
  async start(listing: Listing, session_id: string): Promise<Trial> {
    const key = listing.id;
    const pending = this.pendingStarts.get(key);
    if (pending) { await pending.catch(() => undefined); return this.start(listing, session_id); }
    const operation = this.startInternal(listing, session_id);
    this.pendingStarts.set(key, operation);
    try { return await operation; } finally { this.pendingStarts.delete(key); }
  }
  private async startInternal(listing: Listing, session_id: string): Promise<Trial> {
    if (!listing.trial || !listing.sandbox) throw new Error('Listing does not offer a sandbox trial');
    if (!Number.isFinite(listing.trial.expires_after_min) || listing.trial.expires_after_min <= 0 || listing.trial.per_agent <= 0) throw new Error('Invalid trial policy');
    const trials = await this.services.ledger.listTrials(session_id);
    const existing = trials.find(t => t.listing_id === listing.id && t.status === 'active' && Date.parse(t.expires_at) > this.now());
    if (existing) return existing;
    if (trials.some(t => t.listing_id === listing.id && t.sandbox_id)) throw new Error('This session already received its trial; ending a trial does not reset its allotment');
    const active = (await Promise.all([...this.owned].map(id => this.services.ledger.getTrial(id)))).filter(t => t && t.listing_id === listing.id && ['active', 'provisioning'].includes(t.status) && Date.parse(t.expires_at) > this.now());
    if (active.length >= listing.trial.max_concurrent) throw new Error('Concurrent trial limit reached');
    const id = `trial-${randomUUID()}`;
    const base = this.options.publicBaseUrl ?? process.env.BODEGA_PUBLIC_URL;
    if (!base) throw new Error('BODEGA_PUBLIC_URL or publicBaseUrl is required for sandbox proxy access');
    const proxy = new URL(base);
    if (!['http:', 'https:'].includes(proxy.protocol) || proxy.username || proxy.password) throw new Error('Invalid public proxy URL');
    const trial: Trial = { id, listing_id: listing.id, session_id, sandbox_id: null, status: 'provisioning', used: 0, limit: listing.trial.per_agent, unit: listing.trial.unit, token: `bdg_trial_${randomBytes(24).toString('base64url')}`, started_at: new Date(this.now()).toISOString(), expires_at: new Date(this.now() + listing.trial.expires_after_min * 60000).toISOString() };
    await this.services.ledger.createTrial(trial);
    this.owned.add(id);
    try {
      // No upstream credential is ever requested here or sent to the sandbox.
      const sandboxId = await this.backend.create({ id: `bodega-${randomUUID()}`, image: listing.sandbox.image, ttlSeconds: Math.ceil(listing.trial.expires_after_min * 60), env: { BODEGA_TOOL_BASE_URL: `${proxy.origin}/proxy/${trial.token}`, BODEGA_TOOL_KEY: trial.token } });
      await this.services.ledger.updateTrial(id, { sandbox_id: sandboxId });
      for (const command of listing.sandbox.install) {
        const result = await this.backend.exec(sandboxId, { command, timeoutMs: 30000 });
        if (result.exitCode !== 0) throw new Error('Sandbox setup command failed');
      }
      return await this.services.ledger.updateTrial(id, { status: 'active' });
    } catch {
      await this.end(id).catch(() => undefined);
      throw new Error('Trial provisioning failed; check sandbox configuration');
    }
  }
  async run(req: RunRequest): Promise<RunResult> {
    if (this.busyRuns.has(req.trial_id)) throw new Error('A run is already active in this trial');
    const trial = await this.services.ledger.getTrial(req.trial_id);
    if (!trial || trial.status !== 'active' || !trial.sandbox_id) throw new Error('Trial is not active');
    if (Date.parse(trial.expires_at) <= this.now()) { await this.expire(trial); throw new Error('Trial expired'); }
    if (!req.command && !req.file) throw new Error('Provide command or file');
    if (req.file) {
      const normalized = path.posix.normalize(req.file.path);
      if ((!normalized.startsWith('/blaxel/app/') && normalized !== '/blaxel/app') || req.file.path.includes('\0') || Buffer.byteLength(req.file.content) > 256000) throw new Error('Trial file must be under /blaxel/app and below 256 KB');
    }
    const timeoutMs = Math.min((req.timeout_s ?? 45) * 1000, this.options.maxRunTimeoutMs ?? 55000, Date.parse(trial.expires_at) - this.now());
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid run timeout');
    this.busyRuns.add(trial.id);
    const start = this.now();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (trial.unit === 'runs') await this.services.ledger.recordUsage(trial.id, 1);
      let output;
      try {
        output = await Promise.race([
          this.backend.exec(trial.sandbox_id, { command: req.command ?? `node ${shellQuote(req.file!.path)}`, file: req.file, timeoutMs }),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('timeout')), timeoutMs); }),
        ]);
      } catch {
        // Destroy the whole sandbox on ambiguous timeout: a detached process cannot keep spending.
        await this.end(trial.id);
        output = { exitCode: 124, stdout: '', stderr: 'Sandbox execution failed or timed out; trial ended' };
      }
      const current = await this.services.ledger.getTrial(trial.id) ?? trial;
      return { trial_id: trial.id, exit_code: output.exitCode, stdout: trim(output.stdout, this.options.maxOutputBytes ?? 12000), stderr: trim(output.stderr, this.options.maxOutputBytes ?? 12000), duration_ms: this.now() - start, quota: { used: current.used, limit: current.limit, unit: current.unit } };
    } finally { clearTimeout(timer); this.busyRuns.delete(trial.id); }
  }
  async compare(listing_ids: string[], check_id: string, session_id: string): Promise<ComparisonReport> {
    if (listing_ids.length === 0 || listing_ids.length > 10) throw new Error('Compare requires 1–10 listings');
    const results = await Promise.all([...new Set(listing_ids)].map(async (id): Promise<CheckResult> => {
      let trial: Trial | undefined;
      let loc = 0;
      try {
        const listing = await this.services.catalog.get(id);
        if (!listing || !listing.checks.includes(check_id)) throw new Error('Listing does not support this check');
        if (check_id !== 'email.roundtrip') throw new Error('Only email.roundtrip is implemented');
        const content = emailRoundtripScript(listing, this.options.email);
        loc = content.trim().split('\n').length;
        trial = await this.start(listing, session_id);
        const result = await this.run({ trial_id: trial.id, file: { path: '/blaxel/app/bodega-check.mjs', content }, timeout_s: Math.ceil((this.options.email?.timeoutMs ?? 40000) / 1000) + 3 });
        const line = result.stdout.trim().split('\n').at(-1) ?? '{}';
        const payload = JSON.parse(line) as { ok?: unknown; simulated?: unknown; metrics?: unknown; error?: unknown };
        const metrics: Record<string, number> = {};
        if (payload.metrics && typeof payload.metrics === 'object') for (const [key, value] of Object.entries(payload.metrics)) if (typeof value === 'number' && Number.isFinite(value) && value >= 0) metrics[key] = value;
        const simulated = this.backend.mode === 'simulated' || payload.simulated === true;
        const ok = payload.ok === true && result.exit_code === 0;
        return { listing_id: id, trial_id: trial.id, ok, metrics, loc, logs_tail: simulated ? '[SIMULATED: no email sent or measured]' : (ok ? 'Self-loop message observed in inbound mailbox' : 'Provider check failed'), ...(!ok ? { error: typeof payload.error === 'string' ? trim(payload.error, 300) : 'Check failed or timed out' } : {}) };
      } catch (error) {
        return { listing_id: id, trial_id: trial?.id ?? '', ok: false, metrics: {}, loc, error: error instanceof Error && /Listing does not|Only email|No email/.test(error.message) ? error.message : 'Trial check could not complete; check provider and sandbox configuration', logs_tail: this.backend.mode === 'simulated' ? '[SIMULATED]' : '' };
      } finally { if (trial) await this.end(trial.id).catch(() => undefined); }
    }));
    const passing = results.filter(r => r.ok).sort((a, b) => ((a.metrics.send_ms ?? 0) + (a.metrics.deliver_ms ?? 0)) - ((b.metrics.send_ms ?? 0) + (b.metrics.deliver_ms ?? 0)) || a.loc - b.loc);
    const best = passing[0];
    const simulated = this.backend.mode === 'simulated' || results.some(r=>r.logs_tail?.startsWith('[SIMULATED'));
    const report: ComparisonReport = { id: `cmp-${randomUUID()}`, check_id, session_id, results, suggestion: simulated ? null : best?.listing_id ?? null, reason: simulated ? 'Simulated comparison only; no real provider performance recommendation' : best ? 'Lowest total latency among passing self-loop checks' : 'No provider passed', created_at: new Date(this.now()).toISOString() };
    await this.services.ledger.recordComparison(report);
    return report;
  }
  async end(trial_id: string): Promise<void> {
    const pending = this.pendingEnds.get(trial_id);
    if (pending) return pending;
    const operation = this.endInternal(trial_id);
    this.pendingEnds.set(trial_id, operation);
    try { await operation; } finally { this.pendingEnds.delete(trial_id); }
  }
  private async endInternal(trial_id: string): Promise<void> {
    const trial = await this.services.ledger.getTrial(trial_id);
    if (!trial) return;
    await this.services.ledger.updateTrial(trial_id, { status: trial.status === 'expired' ? 'expired' : 'ended' });
    // Fail closed even when cloud deletion fails; reaper retains the ID to retry.
    await this.services.vault.revoke(trial_id);
    if (trial.sandbox_id) await this.backend.destroy(trial.sandbox_id);
    this.owned.delete(trial_id);
  }
  private async expire(trial: Trial): Promise<void> { await this.services.ledger.updateTrial(trial.id, { status: 'expired' }); await this.end(trial.id); }
  async reapExpired(): Promise<void> {
    await Promise.all([...this.owned].map(async id => { const trial = await this.services.ledger.getTrial(id); if (trial && ['ended', 'expired', 'exhausted'].includes(trial.status)) await this.end(id); else if (trial && Date.parse(trial.expires_at) <= this.now()) await this.expire(trial); }));
  }
  async close(): Promise<void> { clearInterval(this.timer); await Promise.all([...this.owned].map(id => this.end(id))); }
}
