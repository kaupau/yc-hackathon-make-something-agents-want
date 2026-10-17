import type { ApprovalMessage } from './security.js';

/** Explicitly enabled server-only delivery; never accepts a destination from an agent. */
export function primitiveApprovalDelivery(env: NodeJS.ProcessEnv, publicUrl: string, send: typeof fetch = fetch) {
  if (env.BODEGA_APPROVAL_EMAIL_PROVIDER !== 'primitive') return undefined;
  const key=env.PRIMITIVE_API_KEY;
  const from=env.BODEGA_APPROVAL_FROM;
  if (!key || !from || !/^[^\s@]+@[a-z0-9-]+\.primitive\.email$/.test(from)) throw new Error('Primitive approval delivery requires server credentials and a managed sender');
  return async (message: ApprovalMessage) => {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(message.to) || new URL(message.approve_url).origin !== new URL(publicUrl).origin) throw new Error('Invalid approval delivery binding');
    const response = await send('https://api.primitive.dev/v1/send-mail', {
      method:'POST',redirect:'error',signal:AbortSignal.timeout(15000),
      headers:{authorization:`Bearer ${key}`,'content-type':'application/json','idempotency-key':`bodega-approval:${message.purchase_id}`},
      body:JSON.stringify({from,to:message.to,subject:message.subject,body_text:message.text}),
    });
    if (!response.ok) { await response.body?.cancel(); throw new Error('Approval email delivery rejected'); }
    const result=await response.json() as any;
    if (!result.success || !result.data?.id || ['agent_failed','gate_denied','canceled','failed'].includes(result.data.status)) throw new Error('Approval email was not accepted');
  };
}
