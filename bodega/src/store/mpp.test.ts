import test from "node:test";
import assert from "node:assert/strict";
import type Stripe from "stripe";
import { Challenge, Credential } from "mppx";
import { createApplication } from "../server.js";
import { createMppHandler } from "./mpp.js";
import {
  BODEGA_SANDBOX_ACCOUNT,
  createStripePayments,
  type StripePaymentClient,
} from "./payments.js";
async function setup(destination?: string) {
  let mutations = 0;
  let snapshot: any;
  const client = {
    accounts: { retrieve: async () => ({ id: BODEGA_SANDBOX_ACCOUNT }) },
    paymentIntents: {
      create: async (params: any, opts: any) => {
        mutations++;
        snapshot = {
          ...params,
          id: "pi_mppfixture",
          status: "succeeded",
          livemode: false,
          amount_received: params.amount,
        };
        assert.ok(opts.idempotencyKey.startsWith("bodega:pur_"));
        return snapshot;
      },
      retrieve: async () => snapshot,
    },
    webhooks: {
      constructEvent: () => {
        throw new Error("not used");
      },
    },
  };
  const payments = createStripePayments({
    secretKey: "sk_test_fixture123",
    accountId: BODEGA_SANDBOX_ACCOUNT,
    stripeClient: client as StripePaymentClient,
  });
  const app = await createApplication({
    env: {},
    dbPath: ":memory:",
    walletPath: ":memory:",
    payments: destination ? {
      ...payments,
      prepare: async order => ({ ...order, sellerAccountId: destination, platformFeeCents: 0 }),
      inspect: (order, id) => payments.inspect({ ...order, sellerAccountId: destination, platformFeeCents: 0 }, id),
    } : payments,
  });
  app.storefront.options.paymentFlow = "mpp";
  const purchase: any = await app.storefront.buy("postpigeon-email");
  const handler = createMppHandler(app.storefront, {
    secretKey: "sk_test_fixture123",
    networkId: "internal",
    challengeSecret: "test-challenge-signing-secret-at-least-32-bytes",
    client: client as unknown as Stripe,
  });
  return {
    app,
    handler,
    purchase,
    get mutations() {
      return mutations;
    },
  };
}
test("official MPP challenge binds amount and order; unsigned and tampered credentials cannot spend", async () => {
  const h = await setup();
  try {
    const url = "http://127.0.0.1:8787/mpp/" + h.purchase.purchase_id;
    const response = await h.handler(new Request(url));
    assert.equal(response.status, 402);
    const challenge = Challenge.fromResponse(response);
    assert.equal(challenge.method, "stripe");
    assert.equal(challenge.request.amount, "90");
    assert.equal(challenge.request.externalId, h.purchase.purchase_id);
    assert.equal(h.mutations, 0);
    const tampered = {
      ...challenge,
      request: { ...challenge.request, amount: "1" },
    };
    const credential = Credential.serialize({
      challenge: tampered,
      payload: { spt: "spt_fixture", externalId: h.purchase.purchase_id },
    });
    const failed = await h.handler(
      new Request(url, { headers: { authorization: credential } }),
    );
    assert.notEqual(failed.status, 200);
    assert.equal(h.mutations, 0);
  } finally {
    await h.app.close();
  }
});
test("official MPP SPT flow verifies receipt before fulfillment and replay does not charge again", async () => {
  const h = await setup();
  try {
    const url = "http://127.0.0.1:8787/mpp/" + h.purchase.purchase_id;
    const challenge = Challenge.fromResponse(await h.handler(new Request(url)));
    const credential = Credential.serialize({
      challenge,
      payload: { spt: "spt_fixture", externalId: h.purchase.purchase_id },
    });
    const result = await h.handler(
      new Request(url, { headers: { authorization: credential } }),
    );
    assert.equal(result.status, 200);
    assert.ok(result.headers.has("payment-receipt"));
    const payload = await result.json();
    assert.equal(payload.status, "paid");
    assert.equal(payload.receipt_id, "pi_mppfixture");
    assert.equal(h.mutations, 1);
    assert.equal((await h.app.storefront.wallet()).spent_usd, 0.9);
    const replay = await h.handler(
      new Request(url, { headers: { authorization: credential } }),
    );
    assert.equal(replay.status, 200);
    assert.equal(h.mutations, 1);
  } finally {
    await h.app.close();
  }
});

test("MPP destination settlement preserves base wallet binding and verifies the seller receipt", async () => {
  const h = await setup("acct_sandboxseller");
  try {
    const url = "http://127.0.0.1:8787/mpp/" + h.purchase.purchase_id;
    const challenge = Challenge.fromResponse(await h.handler(new Request(url)));
    const credential = Credential.serialize({ challenge, payload: { spt: "spt_destination_fixture", externalId: h.purchase.purchase_id } });
    const result = await h.handler(new Request(url, { headers: { authorization: credential } }));
    assert.equal(result.status, 200);
    assert.equal((await result.json()).status, "paid");
    assert.equal((await h.app.storefront.wallet()).spent_usd, 0.9);
    assert.equal(h.mutations, 1);
  } finally { await h.app.close(); }
});
