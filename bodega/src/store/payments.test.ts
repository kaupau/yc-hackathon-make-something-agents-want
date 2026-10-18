import test from 'node:test';
import assert from 'node:assert/strict';
import Stripe from 'stripe';
import { BODEGA_SANDBOX_ACCOUNT, createMockPayments, createStripePayments, createStripeCliPayments, getMppReadiness, type PaymentOrder, type StripeIntentSnapshot, type StripePaymentClient } from './payments.js';

const order: PaymentOrder = { id: 'purchase1', sessionId: 'session1', listingId: 'primitive-email', amountCents: 200, currency: 'usd', idempotencyKey: 'session1:primitive-email:1' };
const testKey = ['sk', 'test', 'syntheticFixture'].join('_');
function stub() {
  let created = 0; let retrieved = 0; let account = BODEGA_SANDBOX_ACCOUNT;
  let snapshot: StripeIntentSnapshot = { id: 'pi_fixture123', status: 'succeeded', livemode: false, amount: 200, amount_received: 200, currency: 'usd', metadata: {} };
  let createError: unknown; let retrieveError: unknown; let createParams: Stripe.PaymentIntentCreateParams | undefined; let idempotencyKey: string | undefined;
  const client: StripePaymentClient = {
    accounts: { async retrieve() { return { id: account }; } },
    paymentIntents: {
      async create(params, opts) { created++; createParams = params; idempotencyKey = opts.idempotencyKey; if (createError) throw createError; snapshot.metadata = params.metadata as Record<string, string>; snapshot.transfer_data = params.transfer_data ? { destination: params.transfer_data.destination, ...params.transfer_data.amount === undefined ? {} : { amount: params.transfer_data.amount } } : null; snapshot.application_fee_amount = params.application_fee_amount ?? null; return { ...snapshot }; },
      async retrieve() { retrieved++; if (retrieveError) throw retrieveError; return { ...snapshot }; },
    },
    webhooks: { constructEvent: (raw, signature, secret) => Stripe.webhooks.constructEvent(raw, signature, secret) },
  };
  const provider = createStripePayments({ secretKey: testKey, accountId: BODEGA_SANDBOX_ACCOUNT, stripeClient: client, webhookSecret: 'whsec_syntheticfixture' });
  return { provider, client, get snapshot() { return snapshot; }, set snapshot(value) { snapshot = value; }, get created() { return created; }, get retrieved() { return retrieved; }, get params() { return createParams; }, get key() { return idempotencyKey; }, set account(value: string) { account = value; }, set createError(value: unknown) { createError = value; }, set retrieveError(value: unknown) { retrieveError = value; } };
}

test('explicit mock receipts are deterministic, distinguishable and immutable under idempotency', async () => {
  const mock = createMockPayments(); const first = await mock.charge(order);
  assert.equal(first.status, 'paid'); assert.match(first.paymentIntentId!, /^mock_/); assert.deepEqual(await mock.charge(order), first);
  assert.equal((await mock.charge({ ...order, amountCents: 300 })).status, 'pending');
  assert.equal((await mock.inspect({ ...order, id: 'other' }, first.paymentIntentId!)).status, 'pending');
  assert.equal((await createMockPayments({ behavior: 'declined' }).charge(order)).status, 'declined');
});

test('Stripe returns paid only after separate verified retrieval and binds metadata/idempotency', async () => {
  const s = stub(); const result = await s.provider.charge(order);
  assert.equal(result.status, 'paid'); assert.equal(s.created, 1); assert.equal(s.retrieved, 1); assert.equal(s.key, order.idempotencyKey);
  assert.equal(s.params?.amount, 200); assert.equal(s.params?.payment_method, 'pm_card_visa'); assert.ok(!Object.hasOwn(s.params ?? {}, 'payment_method_types'));
  assert.equal(s.params?.metadata?.purchase_id, order.id); assert.equal(s.params?.metadata?.session_id, order.sessionId); assert.equal(s.params?.metadata?.listing_id, order.listingId); assert.equal(s.params?.metadata?.bodega_account_id, BODEGA_SANDBOX_ACCOUNT);
});

test('live keys, other accounts and amounts below 50 cents cannot create payments', async () => {
  assert.throws(() => createStripePayments({ secretKey: ['sk', 'live', 'fixture'].join('_'), accountId: BODEGA_SANDBOX_ACCOUNT }), /test key/);
  assert.throws(() => createStripePayments({ secretKey: testKey, accountId: 'acct_other' }), /sandbox account/);
  const s = stub(); s.account = 'acct_other'; assert.equal((await s.provider.charge(order)).status, 'pending'); assert.equal(s.created, 0);
  await assert.rejects(s.provider.charge({ ...order, amountCents: 49 }), /minimum/);
  await assert.rejects(s.provider.charge({ ...order, amountCents: 200.5 }), /integer/);
});

test('destination receipts must transfer the full agreed amount to the bound seller with zero fee', async () => {
  const s=stub(); const marketplaceOrder={...order,sellerAccountId:'acct_sellerFixture',platformFeeCents:0};
  assert.equal((await s.provider.charge(marketplaceOrder)).status,'paid');
  assert.deepEqual(s.params?.transfer_data,{destination:'acct_sellerFixture'});
  assert.equal(s.params?.application_fee_amount,undefined);
  s.snapshot={...s.snapshot,transfer_data:{destination:'acct_attacker'}};
  assert.equal((await s.provider.inspect(marketplaceOrder,'pi_fixture123')).status,'pending');
  s.snapshot={...s.snapshot,transfer_data:{destination:'acct_sellerFixture',amount:100}};
  assert.equal((await s.provider.inspect(marketplaceOrder,'pi_fixture123')).status,'pending');
  s.snapshot={...s.snapshot,transfer_data:{destination:'acct_sellerFixture'},application_fee_amount:20};
  assert.equal((await s.provider.inspect(marketplaceOrder,'pi_fixture123')).status,'pending');
  await assert.rejects(s.provider.charge({...marketplaceOrder,platformFeeCents:20}),/zero marketplace fee/);
});

test('false receipts, wrong mode, amount, currency or purchase binding never unlock tools', async () => {
  for (const patch of [{ livemode: true }, { amount: 201 }, { amount_received: 199 }, { currency: 'eur' }, { id: 'pi_other' }, { metadata: { purchase_id: 'wrong' } }]) {
    const s = stub(); await s.provider.charge(order); s.snapshot = { ...s.snapshot, ...patch };
    assert.equal((await s.provider.inspect(order, 'pi_fixture123')).status, 'pending', JSON.stringify(patch));
  }
  const s = stub(); assert.equal((await s.provider.inspect(order, 'mock_fake')).status, 'pending'); assert.equal(s.retrieved, 0);
});

test('timeouts retain reservations, known intents are re-read and confirmed failures decline', async () => {
  const s = stub(); s.createError = new Error('timeout secret details');
  let result = await s.provider.charge(order); assert.equal(result.status, 'pending'); assert.ok(!result.error?.includes('secret details'));
  s.createError = undefined; s.retrieveError = new Error('timeout'); result = await s.provider.charge(order); assert.equal(result.status, 'pending'); assert.equal(result.paymentIntentId, 'pi_fixture123');
  s.retrieveError = undefined; s.snapshot = { ...s.snapshot, status: 'processing', amount_received: 0 }; assert.equal((await s.provider.inspect(order, 'pi_fixture123')).status, 'pending');
  s.snapshot = { ...s.snapshot, status: 'requires_payment_method' }; assert.equal((await s.provider.inspect(order, 'pi_fixture123')).status, 'declined');
  s.snapshot = { ...s.snapshot, status: 'succeeded', amount_received: 200 }; s.createError = { type: 'StripeCardError', payment_intent: { id: 'pi_fixture123' } }; assert.equal((await s.provider.charge(order)).status, 'paid');
  s.createError = { type: 'StripeCardError' }; assert.equal((await s.provider.charge(order)).status, 'declined');
});

test('raw webhook signatures are verified and live/wrong account events are rejected', () => {
  const s = stub();
  const verify = (patch: Record<string, unknown> = {}) => {
    const payload = JSON.stringify({ id: 'evt_fixture1', type: 'payment_intent.succeeded', livemode: false, data: { object: { object: 'payment_intent', id: 'pi_fixture123' } }, ...patch });
    const signature = Stripe.webhooks.generateTestHeaderString({ payload, secret: 'whsec_syntheticfixture' });
    return s.provider.verifyWebhook(Buffer.from(payload), signature);
  };
  assert.deepEqual(verify(), { eventId: 'evt_fixture1', paymentIntentId: 'pi_fixture123' });
  assert.equal(verify({ livemode: true }), null); assert.equal(verify({ account: 'acct_wrong' }), null); assert.equal(verify({ type: 'customer.created' }), null);
  assert.equal(s.provider.verifyWebhook(Buffer.from('{}'), 't=1,v1=invalid'), null);
});

test('CLI adapter verifies sandbox test identity immediately before mutation and never requests live mode', async () => {
  const calls: string[][] = []; let metadata: Record<string, string> = {};
  const provider = createStripeCliPayments({ accountId: BODEGA_SANDBOX_ACCOUNT, run: async args => {
    calls.push(args);
    if (args[0] === 'whoami') return JSON.stringify({ account_id: BODEGA_SANDBOX_ACCOUNT, mode: 'test' });
    if (args[0] === 'post') {
      metadata = Object.fromEntries(args.flatMap((arg, i) => arg === '-d' && args[i + 1].startsWith('metadata[') ? [args[i + 1].match(/^metadata\[([^\]]+)\]=(.*)$/)!.slice(1)] : []));
    }
    return JSON.stringify({ id: 'pi_clifixture', status: 'succeeded', livemode: false, amount: 200, amount_received: 200, currency: 'usd', metadata });
  } });
  assert.equal((await provider.charge(order)).status, 'paid');
  const postIndex = calls.findIndex(args => args[0] === 'post'); assert.equal(calls[postIndex - 1][0], 'whoami');
  assert.equal(calls[postIndex][calls[postIndex].indexOf('--idempotency') + 1], order.idempotencyKey);
  assert.ok(calls.every(args => !args.includes('--live') && !args.includes('--api-key')));
});

test('CLI wrong account or live identity cannot mutate, unknown outcomes stay pending', async () => {
  let mutations = 0;
  for (const auth of [{ account_id: 'acct_wrong', mode: 'test' }, { account_id: BODEGA_SANDBOX_ACCOUNT, mode: 'live' }]) {
    const provider = createStripeCliPayments({ accountId: BODEGA_SANDBOX_ACCOUNT, run: async args => { if (args[0] === 'post') mutations++; return JSON.stringify(auth); } });
    assert.equal((await provider.charge(order)).status, 'pending');
  }
  assert.equal(mutations, 0);
  assert.equal(getMppReadiness().ready, false); assert.ok(getMppReadiness().missing.includes('STRIPE_PROFILE_ID'));
});
