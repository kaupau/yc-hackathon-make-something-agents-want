import Stripe from "stripe";
import { Mppx, stripe } from "mppx/server";
import { BODEGA_SANDBOX_ACCOUNT, paymentBinding, settlementParams } from "./payments.js";
import type { Storefront } from "./storefront.js";

export interface MppOptions {
  secretKey: string;
  networkId: string;
  challengeSecret: string;
  client?: Stripe;
}
/** Official HTTP 402/SPT adapter. Never falls back to a test card when the buyer supplies no credential. */
export function createMppHandler(store: Storefront, options: MppOptions) {
  if (
    !/^(?:sk|rk)_test_[A-Za-z0-9]+$/.test(options.secretKey) ||
    !options.networkId ||
    Buffer.byteLength(options.challengeSecret) < 32
  )
    throw new Error(
      "MPP requires sandbox SDK credentials, Stripe network ID and a 32-byte signing secret",
    );
  const client =
    options.client ??
    new Stripe(options.secretKey, { maxNetworkRetries: 2, timeout: 15000 });
  return async (request: Request): Promise<Response> => {
    const id = new URL(request.url).pathname.split("/").at(-1)!;
    await store.ready;
    let p = await store.state.get(id);
    if (!p || p.session_id !== store.options.sessionId)
      return Response.json({ error: "Purchase unavailable" }, { status: 404 });
    if (p.status === "needs_approval" || p.status === "declined")
      return Response.json(
        { error: "Human approval required or purchase declined" },
        { status: 403 },
      );
    if (p.payment_intent_id && ["pending", "charging"].includes(p.status)) {
      try {
        await store.reconcile(p.payment_intent_id, id);
        p = (await store.state.get(id))!;
      } catch {
        /* Keep reservation while verification is unavailable. */
      }
    }
    if (p.status === "paid")
      return Response.json({
        status: "paid",
        receipt_id: p.payment_intent_id,
        project_key: await store.state.tokenFor(id),
      });
    const baseOrder = store.order(p);
    let order = baseOrder;
    if (order.paymentMode !== "mpp")
      return Response.json(
        { error: "MPP is not enabled for this purchase" },
        { status: 409 },
      );
    let reference: string | undefined;
    let claimed = false;
    try {
      order = await store.payments.prepare?.(baseOrder) ?? baseOrder;
      // All credentials are verified by mppx before this narrow client performs a mutation.
      const fixedClient = {
        paymentIntents: {
          create: async (params: any, requestOptions: any) => {
            const account = await client.accounts.retrieve(null!);
            if (account.id !== BODEGA_SANDBOX_ACCOUNT)
              throw new Error("Sandbox account mismatch");
            if (
              params.amount !== order.amountCents ||
              params.currency !== order.currency ||
              typeof params.shared_payment_granted_token !== "string"
            )
              throw new Error("Order mismatch");
            if (
              !(await store.state.bindMppCredential(
                id,
                params.shared_payment_granted_token,
              ))
            )
              throw new Error("Use the original credential for this purchase");
            if (!(await store.state.claim(id)))
              throw new Error("Payment already in progress");
            claimed = true;
            const result = await client.paymentIntents.create(
              { ...params, ...settlementParams(order), metadata: paymentBinding(order) },
              { ...requestOptions, idempotencyKey: order.idempotencyKey },
            );
            reference = result.id;
            return result;
          },
        },
      };
      const mpp = Mppx.create({
        secretKey: options.challengeSecret,
        methods: [
          stripe.charge({
            client: fixedClient,
            networkId: options.networkId,
            currency: "usd",
            decimals: 2,
            paymentMethodTypes: ["card"],
            onPaymentSuccess: ({ receipt }) => {
              reference = receipt.reference;
            },
          }),
        ],
      });
      const result = await mpp.charge({
        amount: (p.amount_cents / 100).toFixed(2),
        externalId: id,
        metadata: paymentBinding(order),
        scope: `bodega/purchase/${id}`,
        expires: new Date(p.created_at + 15 * 60000),
      })(request);
      if (result.status === 402) {
        if (claimed)
          await store.state.finish(
            id,
            "pending",
            reference,
            "MPP payment outcome requires verification",
          );
        return new Response(
          JSON.stringify({
            error: "Payment credential required or not verified",
          }),
          { status: 402, headers: result.challenge.headers },
        );
      }
      if (!reference) throw new Error("Missing verified receipt");
      await store.completePayment(baseOrder, {
        status: "paid",
        paymentIntentId: reference,
      });
      p = (await store.state.get(id))!;
      if (p.status !== "paid")
        return Response.json(
          { error: "Payment verification pending" },
          { status: 503 },
        );
      return result.withReceipt(
        Response.json({
          status: "paid",
          purchase_id: id,
          receipt_id: p.payment_intent_id,
          project_key: await store.state.tokenFor(id),
          base_url: `${store.options.publicUrl}/proxy/${await store.state.tokenFor(id)}`,
        }),
      );
    } catch {
      if (claimed)
        // Best effort: if the shared wallet is unreachable the charging lease expires and is re-claimable.
        await Promise.resolve()
          .then(() =>
            store.state.finish(
              id,
              "pending",
              reference,
              "MPP verification pending; replay original purchase",
            ),
          )
          .catch(() => {});
      return Response.json(
        { error: "MPP payment unavailable or verification pending" },
        { status: 503 },
      );
    }
  };
}
