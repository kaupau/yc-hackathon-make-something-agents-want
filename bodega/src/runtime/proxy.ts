import type { Services } from '../contracts/index.js';

export interface UpstreamPolicy { origin: string; pathPrefixes: string[]; allowPrivate?: boolean }
export interface PurchasedAccess {
  listing_id: string; lease_id: string; expires_at: string;
  /** Atomically reserve one paid credit. False means do not forward. */
  consume(): Promise<boolean>;
}
export interface ProxyOptions {
  fetch?: typeof globalThis.fetch; allowedUpstreams?: Record<string, UpstreamPolicy>;
  resolvePurchasedKey?: (token: string) => Promise<PurchasedAccess | null>;
  /** Store-owned official MPP challenge, if configured. Default is a plain JSON 402. */
  paymentRequired?: (listingId: string) => Promise<Response>;
  timeoutMs?: number; maxRequestBytes?: number; maxResponseBytes?: number; now?: () => number;
}
const DEFAULT_POLICIES: Record<string, UpstreamPolicy> = {
  'primitive-email': { origin: 'https://api.primitive.dev', pathPrefixes: ['/v1/send-mail', '/v1/emails'] },
  'inkbox-email': { origin: 'https://inkbox.ai', pathPrefixes: ['/api/v1/mail/mailboxes'] },
};
const json = (status: number, error: string) => Response.json({ error }, { status, headers: { 'cache-control': 'no-store' } });
const privateHost = (host: string) => host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.includes(':') || /^\d+\./.test(host);
const fits = (path: string, prefix: string) => path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`);
async function boundedBody(body: ReadableStream<Uint8Array> | null, limit: number, signal?: AbortSignal): Promise<Uint8Array> {
  if (!body) return new Uint8Array();
  const reader = body.getReader();
  const abort = () => { void reader.cancel(); };
  signal?.addEventListener('abort', abort, { once: true });
  const parts: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      if (signal?.aborted) throw new Error('ABORTED');
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error('ABORTED');
      if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); throw new Error('BODY_LIMIT'); }
      parts.push(value);
    }
  } finally { signal?.removeEventListener('abort', abort); reader.releaseLock(); }
  const result = new Uint8Array(length); let offset = 0;
  for (const part of parts) { result.set(part, offset); offset += part.length; }
  return result;
}
export function createProxyHandler(services: Pick<Services, 'vault' | 'ledger'>, options: ProxyOptions = {}): (request: Request) => Promise<Response | null> {
  const fetchUpstream = options.fetch ?? globalThis.fetch;
  const policies = options.allowedUpstreams ?? DEFAULT_POLICIES;
  const now = options.now ?? Date.now;
  return async request => {
    const incoming = new URL(request.url);
    if (!incoming.pathname.startsWith('/proxy/')) return null;
    const match = /^\/proxy\/([a-zA-Z0-9_-]{8,200})(\/.*)?$/.exec(incoming.pathname);
    if (!match) return json(400, 'Invalid proxy path');
    const [, token, suffix = '/'] = match;
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(request.method)) return json(405, 'Method not allowed');
    try {
      const trial = await services.ledger.getTrialByToken(token);
      const purchased = trial ? null : await options.resolvePurchasedKey?.(token);
      if (!trial && !purchased) return json(401, 'Unknown access token');
      const listingId = trial?.listing_id ?? purchased!.listing_id;
      const deny = () => options.paymentRequired ? options.paymentRequired(listingId) : Promise.resolve(json(402, 'Quota exhausted; purchase more access through Bodega'));
      if (trial && ((!Number.isFinite(Date.parse(trial.expires_at)) || Date.parse(trial.expires_at) <= now()) || !['active', 'exhausted'].includes(trial.status))) return json(403, 'Trial inactive or expired');
      if (trial && (trial.used >= trial.limit || trial.status === 'exhausted')) return deny();
      if (purchased && (!Number.isFinite(Date.parse(purchased.expires_at)) || Date.parse(purchased.expires_at) <= now())) return json(403, 'Purchased access expired');
      const config = await services.vault.upstream(listingId);
      const policy = policies[listingId];
      if (!policy) return json(403, 'No upstream policy configured');
      const base = new URL(config.base_url);
      if (base.origin !== new URL(policy.origin).origin || base.username || base.password || base.search || base.hash || (!policy.allowPrivate && (base.protocol !== 'https:' || privateHost(base.hostname)))) return json(403, 'Upstream host is not allowed');
      // Reject encoded separators, traversal and scheme-relative or absolute target URLs.
      let decoded: string;
      try { decoded = decodeURIComponent(suffix); } catch { return json(400, 'Invalid encoded path'); }
      if (/[\\\0]/.test(decoded) || /%[0-9a-f]{2}/i.test(decoded) || decoded.startsWith('//') || decoded.split('/').some(p => p === '.' || p === '..') || /%2f|%5c|%2e/i.test(suffix)) return json(400, 'Unsafe upstream path');
      const target = new URL(`${base.pathname.replace(/\/$/, '')}${suffix}${incoming.search}`, base.origin);
      if (target.origin !== base.origin || !policy.pathPrefixes.some(prefix => fits(target.pathname, prefix))) return json(403, 'Upstream path is not allowed');
      if (trial && trial.unit !== 'api_calls') return json(403, 'This token does not have an API-call quota');
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15000);
      const abort = () => controller.abort(); request.signal.addEventListener('abort', abort, { once: true });
      if (request.signal.aborted) controller.abort();
      let secret: string | undefined;
      try {
        const body = await boundedBody(request.body, options.maxRequestBytes ?? 256000, controller.signal);
        const lease = await services.vault.lease(listingId, trial?.id ?? purchased!.lease_id);
        secret = lease.secret;
        if (!secret || !Number.isFinite(Date.parse(lease.expires_at)) || Date.parse(lease.expires_at) <= now()) return json(503, 'Upstream credential unavailable');
        const headers = new Headers();
        // Only known data headers cross the trust boundary. Caller auth/cookies/forwarding headers are discarded.
        for (const name of ['content-type', 'accept', 'idempotency-key', 'prefer']) { const value = request.headers.get(name); if (value) headers.set(name, value); }
        headers.set(config.auth.header, config.auth.format.replaceAll('{key}', secret));
        if (controller.signal.aborted) return json(504, 'Request canceled or timed out');
        if (trial) {
          try { await services.ledger.recordUsage(trial.id, 1); }
          catch (error) { if ((error as { code?: string }).code === 'QUOTA_EXCEEDED') return deny(); throw error; }
        } else if (!await purchased!.consume()) return deny();
        const upstream = await fetchUpstream(target, { method: request.method, headers, body: body.length ? Buffer.from(body) : undefined, signal: controller.signal, redirect: 'manual' });
        if (upstream.status >= 300 && upstream.status < 400) { await upstream.body?.cancel(); return json(502, 'Upstream redirects are disabled'); }
        const payload = await boundedBody(upstream.body, options.maxResponseBytes ?? 1000000, controller.signal);
        // Restrict API responses to text/JSON and scrub accidental credential reflection.
        const contentType = upstream.headers.get('content-type') ?? 'application/json';
        if (!/json|text\//i.test(contentType)) return json(502, 'Unsupported upstream response type');
        let text = new TextDecoder().decode(payload);
        text = text.replaceAll(secret, '[redacted]');
        const mime = contentType.split(';')[0].trim().toLowerCase();
        const safeContentType = /^application\/(?:[a-z0-9.+-]+\+)?json$/.test(mime) ? 'application/json; charset=utf-8' : 'text/plain; charset=utf-8';
        const responseHeaders = new Headers({ 'content-type': safeContentType, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'content-security-policy': "default-src 'none'; sandbox", 'referrer-policy': 'no-referrer' });
        const remaining = trial ? await services.ledger.getTrial(trial.id) : null;
        if (remaining) responseHeaders.set('x-bodega-quota-remaining', String(Math.max(0, remaining.limit - remaining.used)));
        return new Response(request.method === 'HEAD' || [204, 205, 304].includes(upstream.status) ? null : text, { status: upstream.status, headers: responseHeaders });
      } catch (error) {
        if (error instanceof Error && error.message === 'BODY_LIMIT') return json(413, 'Proxy body limit exceeded');
        return json(controller.signal.aborted ? 504 : 502, controller.signal.aborted ? 'Upstream timed out' : 'Upstream request failed');
      } finally { clearTimeout(timer); request.signal.removeEventListener('abort', abort); secret = undefined; }
    } catch { return json(503, 'Proxy service unavailable'); }
  };
}
