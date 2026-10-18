import { randomUUID } from 'node:crypto';

export interface SandboxCreate {
  id: string; image: string; env: Record<string, string>; ttlSeconds: number;
}
export interface SandboxExec {
  command: string; file?: { path: string; content: string }; timeoutMs: number;
}
export interface SandboxOutput { exitCode: number; stdout: string; stderr: string }
/** No implementation may execute the supplied command on the Bodega host. */
export interface SandboxBackend {
  readonly mode: 'blaxel' | 'simulated' | 'unavailable';
  create(input: SandboxCreate): Promise<string>;
  exec(id: string, input: SandboxExec): Promise<SandboxOutput>;
  destroy(id: string): Promise<void>;
}

export const unavailableBackend: SandboxBackend = {
  mode: 'unavailable',
  async create() { throw new Error('Sandbox unavailable: configure an explicit Blaxel backend or simulated demo backend'); },
  async exec() { throw new Error('Sandbox unavailable'); },
  async destroy() {},
};

/** Deterministic fixture. Never evaluates code and never claims real provider measurements. */
export function createSimulatedSandboxBackend(): SandboxBackend {
  const active = new Map<string, SandboxCreate>();
  return {
    mode: 'simulated',
    async create(input) { const id = `simulated-${input.id}`; active.set(id, input); return id; },
    async exec(id, input) {
      const sandbox = active.get(id);
      if (!sandbox) throw new Error('Simulated sandbox ended');
      if (input.file?.path.endsWith('bodega-check.mjs')) {
        const failed = input.file.content.includes('"postpigeon"');
        return { exitCode: failed ? 1 : 0, stdout: JSON.stringify({ ok: !failed, simulated: true, metrics: failed ? {} : { send_ms: 0, deliver_ms: 0 }, ...(failed ? { error: 'Simulated PostPigeon receive authorization failure' } : {}) }), stderr: '' };
      }
      return { exitCode: 0, stdout: '[simulated sandbox: command accepted; no code executed]', stderr: '' };
    },
    async destroy(id) { active.delete(id); },
  };
}

/** Structural SDK boundary permits a fake in tests and avoids loading credentials in simulation. */
export interface BlaxelSDK {
  SandboxInstance: {
    create(input: Record<string, unknown>): Promise<BlaxelSandbox>;
    get(id: string): Promise<BlaxelSandbox>;
    delete(id: string): Promise<unknown>;
  };
}
interface BlaxelSandbox {
  fs: { write(path: string, content: string): Promise<unknown> };
  process: {
    exec(input: Record<string, unknown>): Promise<{ exitCode?: number; stdout?: string; stderr?: string }>;
    kill(name: string): Promise<unknown>;
  };
}
export async function createBlaxelSandboxBackend(sdk?: BlaxelSDK): Promise<SandboxBackend> {
  if (!sdk) {
    if (!process.env.BL_API_KEY || !process.env.BL_WORKSPACE) throw new Error('BL_API_KEY and BL_WORKSPACE are required');
    const moduleName = '@blaxel/core';
    sdk = await import(moduleName) as BlaxelSDK;
  }
  const api = sdk.SandboxInstance;
  return {
    mode: 'blaxel',
    async create(input) {
      await api.create({ name: input.id, image: input.image, memory: 1024, region: process.env.BL_REGION ?? 'us-pdx-1', ttl: `${input.ttlSeconds}s`, labels: { app: 'bodega', managedBy: 'trial-runtime' }, envs: Object.entries(input.env).map(([name, value]) => ({ name, value })) });
      return input.id;
    },
    async exec(id, input) {
      const sandbox = await api.get(id);
      if (input.file) await sandbox.fs.write(input.file.path, input.file.content);
      const name = `bodega-${randomUUID()}`;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          sandbox.process.exec({ name, command: input.command, workingDir: '/blaxel/app', waitForCompletion: true, keepAlive: true, timeout: Math.ceil(input.timeoutMs / 1000) }).then(p => ({ exitCode: p.exitCode ?? 1, stdout: p.stdout ?? '', stderr: p.stderr ?? '' })),
          new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('Sandbox run timed out')), input.timeoutMs); }),
        ]);
      } catch (error) {
        await sandbox.process.kill(name).catch(() => undefined);
        throw error;
      } finally { clearTimeout(timer); }
    },
    async destroy(id) { await api.delete(id); },
  };
}
