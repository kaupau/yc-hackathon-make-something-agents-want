import type { Listing } from '../contracts/index.js';

export interface EmailCheckOptions { primitiveInbox?: string; inkboxInbox?: string; pollIntervalMs?: number; timeoutMs?: number }
/** Script executes within the isolated sandbox; all REST calls target the metering proxy. */
export function emailRoundtripScript(listing: Listing, options: EmailCheckOptions = {}): string {
  if (!['primitive', 'inkbox', 'postpigeon'].includes(listing.vendor_id)) throw new Error('No email.roundtrip adapter for this provider');
  const config = JSON.stringify({ vendor: listing.vendor_id, inbox: listing.vendor_id === 'primitive' ? options.primitiveInbox : options.inkboxInbox, pollIntervalMs: options.pollIntervalMs ?? 1500, timeoutMs: options.timeoutMs ?? 40000 });
  return `const config = ${config};
const base = process.env.BODEGA_TOOL_BASE_URL;
const key = process.env.BODEGA_TOOL_KEY;
const tag = 'bodega-' + crypto.randomUUID();
const deadline = Date.now() + config.timeoutMs;
const api = async (path, body) => {
  const response = await fetch(base + path, { method: body ? 'POST' : 'GET', redirect: 'error', signal: AbortSignal.timeout(Math.min(10000, Math.max(1, deadline - Date.now()))), headers: { Authorization: 'Bearer ' + key, 'X-API-Key': key, 'content-type': 'application/json', 'Idempotency-Key': tag, Prefer: 'idempotency-replay' }, ...(body ? { body: JSON.stringify(body) } : {}) });
  if (!response.ok) throw new Error('Provider returned HTTP ' + response.status + ' on ' + path.split('?')[0]);
  return response.json();
};
try {
  let inbox = config.inbox;
  if (config.vendor === 'inkbox' && !inbox) {
    const mailboxes = await api('/mail/mailboxes?limit=1');
    inbox = (Array.isArray(mailboxes) ? mailboxes : mailboxes.items)?.[0]?.email_address;
  }
  if (config.vendor === 'primitive' && !inbox) throw new Error('Configure PRIMITIVE_TRIAL_INBOX: a managed self-loop inbox is required');
  if (config.vendor === 'postpigeon') inbox = 'trial@postpigeon.example';
  if (!inbox) throw new Error('No configured trial mailbox');
  const path = config.vendor === 'inkbox' ? '/mail/mailboxes/' + encodeURIComponent(inbox) + '/messages' : config.vendor === 'primitive' ? '/send-mail' : '/messages';
  const start = Date.now();
  await api(path, config.vendor === 'inkbox' ? { recipients: { to: [inbox] }, subject: tag, body_text: tag } : { from: inbox, to: inbox, subject: tag, body_text: tag, text: tag });
  const sent = Date.now();
  while (Date.now() < deadline) {
    const pollPath = config.vendor === 'primitive' ? '/emails?limit=100' : path + '?direction=inbound&limit=100';
    const response = await api(pollPath);
    const messages = Array.isArray(response) ? response : response.items ?? response.data?.emails ?? response.data ?? response.emails ?? [];
    if (Array.isArray(messages) && messages.some(m => m.subject === tag && m.direction !== 'outbound')) {
      console.log(JSON.stringify({ ok: true, metrics: { send_ms: sent - start, deliver_ms: Date.now() - sent } }));
      process.exit(0);
    }
    await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
  }
  throw new Error('Self-loop delivery was not observed before timeout');
} catch (error) { console.log(JSON.stringify({ ok: false, metrics: {}, error: error.message })); process.exitCode = 1; }
`;
}
