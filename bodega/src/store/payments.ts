import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash } from 'node:crypto';
import Stripe from 'stripe';

export const BODEGA_SANDBOX_ACCOUNT = 'acct_1URdmN2M1S84n0j8';
export interface PaymentOrder {
  id: string; sessionId: string; listingId: string; amountCents: number; currency: 'usd'; idempotencyKey: string; paymentMode?: 'mpp';
}
export interface PaymentResult {
  status: 'paid' | 'pending' | 'declined'; paymentIntentId?: string; error?: string;
}
export interface PaymentProvider {
  readonly mode: 'mock' | 'stripe';
  charge(order: PaymentOrder): Promise<PaymentResult>;
  inspect(order: PaymentOrder, paymentIntentId: string): Promise<PaymentResult>;
  /** Verified notification only; caller must deduplicate event IDs and independently inspect current PI state. */
  verifyWebhook(raw: Buffer, signature: string): { eventId: string; paymentIntentId: string; purchaseId?: string } | null;
}
export interface StripeIntentSnapshot {
  id: string; status: string; livemode: boolean; amount: number; amount_received: number; currency: string; metadata: Record<string, string>;
}
export interface StripePaymentClient {
  accounts: { retrieve(id: null): Promise<{ id: string; deleted?: boolean | void }> };
  paymentIntents: {
    create(params: Stripe.PaymentIntentCreateParams, options: Stripe.RequestOptions): Promise<StripeIntentSnapshot>;
    retrieve(id: string): Promise<StripeIntentSnapshot>;
  };
  webhooks: { constructEvent(raw: Buffer, signature: string, secret: string): { id: string; type: string; livemode: boolean; account?: string; data: { object: { id?: string; object?: string; metadata?: Record<string,string> | null } } } };
}
export interface StripePaymentsOptions {
  secretKey: string; accountId: string; webhookSecret?: string; stripeClient?: StripePaymentClient;
}
function validateOrder(order: PaymentOrder): void {
  if (!Number.isSafeInteger(order.amountCents) || order.amountCents < 50 || order.currency !== 'usd') throw new Error('Payment requires integer USD cents with a 50-cent minimum');
  for (const value of [order.id, order.sessionId, order.listingId]) if (!value || value.length > 200) throw new Error('Invalid payment order binding');
  if (!order.idempotencyKey || order.idempotencyKey.length > 255) throw new Error('A stable idempotency key is required');
}
export const paymentBinding = (order: PaymentOrder) => ({ purchase_id: order.id, session_id: order.sessionId, listing_id: order.listingId, bodega_account_id: BODEGA_SANDBOX_ACCOUNT, bodega_payment_mode: order.paymentMode??'sandbox-test-card-fallback', bodega_attempt_hash: createHash('sha256').update(order.idempotencyKey).digest('hex') });
const fingerprint = (order: PaymentOrder) => createHash('sha256').update(JSON.stringify(order)).digest('hex');

export function createMockPayments(options: { behavior?: 'paid' | 'pending' | 'declined' | ((order: PaymentOrder) => PaymentResult['status']) } = {}): PaymentProvider {
  const attempts = new Map<string, { fingerprint: string; result: PaymentResult }>();
  return {
    mode: 'mock',
    async charge(order) {
      validateOrder(order);
      const previous = attempts.get(order.idempotencyKey);
      if (previous) {
        if (previous.fingerprint !== fingerprint(order)) return { status: 'pending', error: 'Mock idempotency key reused with different parameters' };
        return { ...previous.result };
      }
      const status = typeof options.behavior === 'function' ? options.behavior(order) : options.behavior ?? 'paid';
      const result: PaymentResult = { status, paymentIntentId: `mock_${createHash('sha256').update(order.idempotencyKey).digest('hex').slice(0, 24)}`, ...(status === 'declined' ? { error: 'Explicit simulated decline' } : {}) };
      attempts.set(order.idempotencyKey, { fingerprint: fingerprint(order), result });
      return { ...result };
    },
    async inspect(order, paymentIntentId) {
      validateOrder(order);
      const attempt = attempts.get(order.idempotencyKey);
      return attempt && attempt.fingerprint === fingerprint(order) && attempt.result.paymentIntentId === paymentIntentId ? { ...attempt.result } : { status: 'pending', error: 'Unknown simulated receipt' };
    },
    verifyWebhook() { return null; },
  };
}

/** Explicit sandbox test-card fallback. It does not charge a human card or implement buyer-wallet/SPT authorization. */
export function createStripePayments(options: StripePaymentsOptions): PaymentProvider {
  if (options.accountId !== BODEGA_SANDBOX_ACCOUNT) throw new Error('Only the Bodega Development sandbox account is allowed');
  if (!/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(options.secretKey)) throw new Error('A Stripe sandbox test key is required; live keys are refused');
  const stripe: StripePaymentClient = options.stripeClient ?? new Stripe(options.secretKey, { maxNetworkRetries: 2, timeout: 15000 });
  return buildStripeProvider(stripe, options);
}
function buildStripeProvider(stripe: StripePaymentClient, options: { webhookSecret?: string }): PaymentProvider {
  // Lazy verification does not expose or read credentials. It is repeated on each inspect/charge
  // so an injected client cannot change authenticated account between attempts.
  async function verifyAccount() {
    const account = await stripe.accounts.retrieve(null);
    if (account.deleted || account.id !== BODEGA_SANDBOX_ACCOUNT) throw new Error('Stripe authenticated account does not match Bodega sandbox');
  }
  function verifyReceipt(order: PaymentOrder, intent: StripeIntentSnapshot, expectedId: string): PaymentResult {
    const failedBinding = intent.id !== expectedId || !/^pi_[A-Za-z0-9]+$/.test(intent.id) || intent.livemode !== false || intent.amount !== order.amountCents || intent.currency !== order.currency || Object.entries(paymentBinding(order)).some(([key, value]) => intent.metadata?.[key] !== value);
    if (failedBinding) return { status: 'pending', paymentIntentId: expectedId, error: 'Receipt verification failed; purchase remains blocked' };
    if (intent.status === 'succeeded') {
      if (intent.amount_received !== order.amountCents) return { status: 'pending', paymentIntentId: intent.id, error: 'Receipt amount received does not match order' };
      return { status: 'paid', paymentIntentId: intent.id };
    }
    if ((intent.status === 'canceled' || intent.status === 'requires_payment_method') && intent.amount_received === 0) return { status: 'declined', paymentIntentId: intent.id, error: 'Payment was not completed' };
    return { status: 'pending', paymentIntentId: intent.id, error: 'Payment awaits a confirmed terminal status' };
  }
  async function inspect(order: PaymentOrder, paymentIntentId: string): Promise<PaymentResult> {
    validateOrder(order);
    if (!/^pi_[A-Za-z0-9]+$/.test(paymentIntentId)) return { status: 'pending', error: 'Invalid PaymentIntent receipt' };
    try {
      await verifyAccount();
      return verifyReceipt(order, await stripe.paymentIntents.retrieve(paymentIntentId), paymentIntentId);
    } catch { return { status: 'pending', paymentIntentId, error: 'Stripe verification unavailable; reservation must remain held' }; }
  }
  return {
    mode: 'stripe',
    async charge(order) {
      validateOrder(order);
      let intentId: string | undefined;
      try {
        await verifyAccount();
        const intent = await stripe.paymentIntents.create({ amount: order.amountCents, currency: order.currency, confirm: true, payment_method: 'pm_card_visa', automatic_payment_methods: { enabled: true, allow_redirects: 'never' }, metadata: paymentBinding(order), description: 'Bodega sandbox test-card fallback (simulated card; no human funds)' }, { idempotencyKey: order.idempotencyKey });
        intentId = intent.id;
        // The create response is never itself a receipt gate.
        return await inspect(order, intentId);
      } catch (error) {
        const failure = error as { type?: string; payment_intent?: { id?: string }; raw?: { type?: string; payment_intent?: { id?: string } } };
        intentId ??= failure.payment_intent?.id ?? failure.raw?.payment_intent?.id;
        if (intentId) return inspect(order, intentId);
        if (failure.type === 'StripeCardError' || failure.type === 'card_error' || failure.raw?.type === 'card_error') return { status: 'declined', error: 'Sandbox test card declined' };
        // Replaying the identical create with its original key recovers a lost create response.
        return { status: 'pending', error: 'Stripe outcome unknown; retain reservation and replay the same idempotent attempt' };
      }
    },
    inspect,
    verifyWebhook(raw, signature) {
      if (!options.webhookSecret || !signature) return null;
      try {
        const event = stripe.webhooks.constructEvent(raw, signature, options.webhookSecret);
        if (!/^evt_[A-Za-z0-9]+$/.test(event.id) || event.livemode !== false || (event.account !== undefined && event.account !== BODEGA_SANDBOX_ACCOUNT)) return null;
        if (!['payment_intent.succeeded', 'payment_intent.processing', 'payment_intent.payment_failed', 'payment_intent.canceled'].includes(event.type)) return null;
        const object = event.data.object;
        if (object.object !== 'payment_intent' || typeof object.id !== 'string' || !/^pi_[A-Za-z0-9]+$/.test(object.id)) return null;
        return { eventId: event.id, paymentIntentId: object.id, ...(object.metadata?.purchase_id?{purchaseId:object.metadata.purchase_id}:{}) };
      } catch { return null; }
    },
  };
}

export function getMppReadiness(options: { profileId?: string; buyerSptConfigured?: boolean; serverConfigured?: boolean } = {}): { ready: boolean; missing: string[]; note: string } {
  const missing = [!options.profileId ? 'STRIPE_PROFILE_ID' : '', !options.buyerSptConfigured ? 'Buyer SPT wallet/token provider' : '', !options.serverConfigured ? 'Test SDK key and MPP_SECRET_KEY' : ''].filter(Boolean);
  return { ready: missing.length===0, missing, note: 'Official mppx Stripe HTTP adapter is implemented. End-to-end Stripe SPT commerce requires preview access and a buyer wallet. Direct mode remains an explicitly labeled sandbox test-card fallback.' };
}

export interface StripeCliPaymentsOptions {
  accountId: string;
  /** Test seam. Production default invokes the local authenticated CLI without a shell. */
  run?: (args: string[]) => Promise<string>;
  webhookSecret?: string;
}
/** Local development only; real Stripe sandbox ledger, documented pm_card_visa simulated card. */
export function createStripeCliPayments(options: StripeCliPaymentsOptions): PaymentProvider {
  if (options.accountId !== BODEGA_SANDBOX_ACCOUNT) throw new Error('Only the Bodega Development sandbox account is allowed');
  const exec = promisify(execFile);
  const run = options.run ?? (async (args: string[]) => (await exec('stripe', args, { timeout: 20000, maxBuffer: 2000000, windowsHide: true })).stdout);
  const decode = async (args: string[]): Promise<Record<string, unknown>> => {
    const value: unknown = JSON.parse(await run(args));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Unexpected Stripe CLI response');
    const object = value as Record<string, unknown>;
    if (object.error) throw { raw: object.error };
    return object;
  };
  async function identity() {
    const auth = await decode(['whoami', '--format', 'json']);
    if (auth.account_id !== BODEGA_SANDBOX_ACCOUNT || auth.mode !== 'test') throw new Error('Stripe CLI must be authenticated to Bodega Development in test mode');
    return { id: BODEGA_SANDBOX_ACCOUNT };
  }
  const client: StripePaymentClient = {
    accounts: { retrieve: identity },
    paymentIntents: {
      async create(params, requestOptions) {
        // Validate again directly before mutation, after building the fixed request payload.
        await identity();
        const args = ['post', '/v1/payment_intents', '--confirm', '--idempotency', requestOptions.idempotencyKey!, '-d', `amount=${params.amount}`, '-d', `currency=${params.currency}`, '-d', 'confirm=true', '-d', 'payment_method=pm_card_visa', '-d', 'automatic_payment_methods[enabled]=true', '-d', 'automatic_payment_methods[allow_redirects]=never', '-d', `description=${params.description}`];
        for (const [key, value] of Object.entries(params.metadata ?? {})) args.push('-d', `metadata[${key}]=${value}`);
        const result = await decode(args);
        return result as unknown as StripeIntentSnapshot;
      },
      async retrieve(id) {
        await identity();
        return await decode(['get', `/v1/payment_intents/${id}`]) as unknown as StripeIntentSnapshot;
      },
    },
    webhooks: { constructEvent: (raw, signature, secret) => Stripe.webhooks.constructEvent(raw, signature, secret) },
  };
  return buildStripeProvider(client, options);
}
