import { randomUUID } from "node:crypto";
import type {
  Listing,
  Purchase,
  RunRequest,
  Services,
  Verdict,
} from "../contracts/index.js";
import type { PurchasedAccess } from "../runtime/index.js";
import type {
  PaymentOrder,
  PaymentProvider,
  PaymentResult,
} from "./payments.js";
import { StoreError, type Attempt, type WalletBackend } from "./wallet.js";

export interface StorefrontOptions {
  sessionId: string;
  capCents: number;
  thresholdCents: number;
  humanEmail: string;
  publicUrl: string;
  /** Server-injected proxy; never accepts an agent-supplied upstream address. */
  proxy?: (request: Request) => Promise<Response | null>;
  paymentFlow?: "direct" | "mpp";
}
export class Storefront {
  private inFlight = new Map<string, Promise<unknown>>();
  /** Resolves once the wallet session exists; every wallet-touching method awaits it. */
  readonly ready: Promise<void>;
  constructor(
    readonly services: Services,
    readonly payments: PaymentProvider,
    readonly state: WalletBackend,
    readonly options: StorefrontOptions,
  ) {
    // Synchronous backends still throw invalid policies from the constructor.
    this.ready = Promise.resolve(
      state.ensureSession(
        options.sessionId,
        options.capCents,
        options.thresholdCents,
      ),
    );
    this.ready.catch(() => {});
  }
  private async attempt(id: string) {
    const p = await this.state.get(id);
    if (!p) throw new StoreError("NO_PURCHASE", "Purchase unavailable");
    return p;
  }
  order(p: Attempt): PaymentOrder {
    return {
      id: p.id,
      sessionId: p.session_id,
      listingId: p.listing_id,
      amountCents: p.amount_cents,
      currency: p.currency,
      idempotencyKey: p.idempotency_key,
      ...(p.payment_mode === "stripe:mpp"
        ? { paymentMode: "mpp" as const }
        : {}),
    };
  }
  private async listing(id: string) {
    const l = await this.services.catalog.get(id);
    if (!l) throw new StoreError("NO_LISTING", "Unknown listing");
    return l;
  }
  async need(capability: string) {
    return {
      listings: (
        await this.services.catalog.search(capability, { limit: 6 })
      ).map((l) => ({
        id: l.id,
        name: l.name,
        vendor_id: l.vendor_id,
        one_line: l.one_line,
        trial: l.trial,
        price: l.price,
        checks: l.checks,
        provider_integration: l.real
          ? "requires-provider-credentials"
          : "simulated",
      })),
    };
  }
  async startTrial(id: string) {
    const l = await this.listing(id);
    const t = await this.services.runtime.start(l, this.options.sessionId);
    return {
      trial_id: t.id,
      listing_id: id,
      quota: { limit: t.limit, used: t.used, unit: t.unit },
      expires_at: t.expires_at,
      quickstart: l.quickstart,
      env: l.sandbox?.env_hint,
      charged_usd: 0,
    };
  }
  async runTrial(request: RunRequest) {
    const t = await this.services.ledger.getTrial(request.trial_id);
    if (!t || t.session_id !== this.options.sessionId)
      throw new StoreError("NO_TRIAL", "Trial does not belong to this wallet");
    return this.services.runtime.run(request);
  }
  async compare(ids: string[], checkId = "email.roundtrip") {
    if (!ids.length || ids.length > 8 || new Set(ids).size !== ids.length)
      throw new StoreError(
        "BAD_COMPARISON",
        "Choose one to eight distinct listings",
      );
    const report = await this.services.runtime.compare(
      ids,
      checkId,
      this.options.sessionId,
    );
    for (const r of report.results)
      await this.services.ledger.recordReview({
        id: `${report.id}:${r.listing_id}`,
        listing_id: r.listing_id,
        session_id: this.options.sessionId,
        verdict: report.suggestion
          ? report.suggestion === r.listing_id
            ? "chosen"
            : "rejected"
          : "neutral",
        reason: report.suggestion
          ? (r.error ?? report.reason)
          : "Simulated or inconclusive comparison; no real ranking",
        compared_with: ids,
        source: "auto",
        created_at: report.created_at,
      });
    return report;
  }
  private purchase(p: Attempt): Purchase {
    return {
      id: p.id,
      listing_id: p.listing_id,
      session_id: p.session_id,
      amount_usd: p.amount_cents / 100,
      status: p.status,
      created_at: new Date(p.created_at).toISOString(),
      ...(p.payment_intent_id ? { receipt_id: p.payment_intent_id } : {}),
      ...(p.approval_url ? { approve_url: p.approval_url } : {}),
    };
  }
  private async mirror(p: Attempt) {
    const old = (await this.services.ledger.listPurchases(p.session_id)).find(
      (x) => x.id === p.id,
    );
    if (old) await this.services.ledger.updatePurchase(p.id, this.purchase(p));
    else await this.services.ledger.recordPurchase(this.purchase(p));
    if (p.status === "paid" && !(await this.state.isFulfilled(p.id))) {
      await this.services.ledger.recordReview({
        id: `buy:${p.id}`,
        listing_id: p.listing_id,
        session_id: p.session_id,
        verdict: "chosen",
        reason: "Purchased after budget and verified payment gate",
        compared_with: [],
        source: "auto",
        created_at: new Date(p.created_at).toISOString(),
      });
      await this.state.markFulfilled(p.id);
    }
  }
  private async result(p: Attempt, l: Listing) {
    const remaining = (await this.state.view(p.session_id)).remaining_cents;
    return {
      purchase_id: p.id,
      listing_id: p.listing_id,
      status: p.status,
      payment_mode:
        p.payment_mode === "stripe:mpp"
          ? "mpp"
          : p.payment_mode.startsWith("mock:")
            ? "simulated"
            : "stripe-sandbox-test-card-fallback",
      amount_usd: p.amount_cents / 100,
      ...(p.payment_intent_id ? { receipt_id: p.payment_intent_id } : {}),
      ...(p.status === "needs_approval"
        ? {
            needs_approval: true,
            human_action: "Open the protected administrator approval inbox",
          }
        : {}),
      ...(p.status === "paid"
        ? {
            project_key: this.state.tokenFor(p.id),
            base_url: `${this.options.publicUrl}/proxy/${this.state.tokenFor(p.id)}`,
            tools_now_available: l.adds_tools,
          }
        : {}),
      ...(p.status === "pending" || p.status === "charging"
        ? { payment_pending: true }
        : {}),
      ...(p.error ? { error: p.error } : {}),
      remaining_usd: remaining / 100,
    };
  }
  async buy(
    id: string,
    _reason?: string,
    requestId = "initial",
  ): Promise<unknown> {
    const key = `${id}:${requestId}`;
    const existing = this.inFlight.get(key);
    if (existing) return existing;
    const work = this.buyInternal(id, requestId);
    this.inFlight.set(key, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(key);
    }
  }
  private async buyInternal(id: string, requestId: string) {
    await this.ready;
    const l = await this.listing(id);
    let p = await this.state.reserve(
      this.options.sessionId,
      id,
      Math.round(l.price.buy_usd * 100),
      requestId,
      l.category === "email" ? 1000 : 1,
      `${this.payments.mode}:${this.options.paymentFlow ?? "direct"}`,
    );
    await this.mirror(p);
    if (p.status === "needs_approval") {
      if (!p.approval_url) {
        const approval = await this.services.approvals.request(
          this.purchase(p),
          this.options.humanEmail,
        );
        await this.state.setApproval(p.id, approval.approve_url);
        p = await this.attempt(p.id);
        await this.mirror(p);
      }
      const decision = await this.services.approvals.status(p.id);
      if (decision === "pending") return this.result(p, l);
      if (decision === "declined") {
        await this.state.decline(p.id, "Human approval declined or expired");
        p = await this.attempt(p.id);
        await this.mirror(p);
        return this.result(p, l);
      }
      await this.state.approve(p.id);
      p = await this.attempt(p.id);
    }
    if (p.status === "paid" || p.status === "declined")
      return this.result(p, l);
    if (this.options.paymentFlow === "mpp")
      return {
        ...(await this.result(p, l)),
        payment_mode: "mpp",
        payment_url: `${this.options.publicUrl}/mpp/${p.id}`,
      };
    if (!(await this.state.claim(p.id)))
      return this.result(await this.attempt(p.id), l);
    // Re-read under the lease: another node may have recorded a payment id meanwhile.
    p = await this.attempt(p.id);
    let outcome: PaymentResult;
    try {
      outcome = p.payment_intent_id
        ? await this.payments.inspect(this.order(p), p.payment_intent_id)
        : await this.payments.charge(this.order(p));
    } catch {
      outcome = {
        status: "pending",
        error: "Payment outcome unknown; reservation remains held",
      };
    }
    p = await this.state.finish(
      p.id,
      outcome.status,
      outcome.paymentIntentId,
      outcome.error,
    );
    await this.mirror(p);
    return this.result(p, l);
  }
  async completePayment(order: PaymentOrder, result: PaymentResult) {
    await this.ready;
    const p = await this.state.get(order.id);
    if (
      !p ||
      p.session_id !== order.sessionId ||
      JSON.stringify(this.order(p)) !== JSON.stringify(order) ||
      p.status === "needs_approval"
    )
      throw new StoreError(
        "PAYMENT_BINDING",
        "Purchase binding or approval mismatch",
      );
    const verified = result.paymentIntentId
      ? await this.payments.inspect(order, result.paymentIntentId)
      : { status: "pending" as const };
    const done = await this.state.finish(
      p.id,
      verified.status,
      verified.paymentIntentId,
      verified.error,
    );
    await this.mirror(done);
  }
  async reconcile(paymentId: string, purchaseId?: string) {
    await this.ready;
    const p =
      (await this.state.byPayment(paymentId)) ??
      (purchaseId ? await this.state.get(purchaseId) : null);
    if (!p || p.status === "needs_approval") return;
    const result = await this.payments.inspect(this.order(p), paymentId);
    if (result.status === "pending")
      throw new StoreError(
        "PAYMENT_PENDING",
        "Payment verification pending; retry reconciliation",
      );
    const next = await this.state.finish(
      p.id,
      result.status,
      result.paymentIntentId,
      result.error,
    );
    await this.mirror(next);
  }
  async wallet() {
    await this.ready;
    const w = await this.state.view(this.options.sessionId);
    return {
      session_id: w.session_id,
      cap_usd: w.cap_cents / 100,
      threshold_usd: w.threshold_cents / 100,
      spent_usd: w.spent_cents / 100,
      reserved_usd: w.reserved_cents / 100,
      remaining_usd: w.remaining_cents / 100,
      payment_mode:
        this.payments.mode === "mock" ? "simulated" : "stripe-sandbox",
      purchases: w.purchases.map((p) => ({
        id: p.id,
        listing_id: p.listing_id,
        amount_usd: p.amount_cents / 100,
        status: p.status,
        receipt_id: p.payment_intent_id,
        credits_left: p.credit_limit - p.credits_used,
      })),
      trials: (
        await this.services.ledger.listTrials(this.options.sessionId)
      ).map((t) => ({
        listing_id: t.listing_id,
        used: t.used,
        limit: t.limit,
        unit: t.unit,
        funded_by: "vendor",
      })),
    };
  }
  async review(id: string, verdict: Verdict, reason: string) {
    await this.listing(id);
    if (!reason.trim() || reason.length > 500)
      throw new StoreError(
        "BAD_REVIEW",
        "Review reason must be 1–500 characters",
      );
    await this.services.ledger.recordReview({
      id: `review_${randomUUID()}`,
      listing_id: id,
      session_id: this.options.sessionId,
      verdict,
      reason,
      compared_with: [],
      source: "agent",
      created_at: new Date().toISOString(),
    });
    return { recorded: true };
  }
  async resolvePurchasedKey(token: string): Promise<PurchasedAccess | null> {
    const p = await this.state.resolveToken(token);
    return p
      ? {
          listing_id: p.listing_id,
          lease_id: p.id,
          expires_at: new Date(p.expires_at).toISOString(),
          consume: async () => this.state.consume(p.id),
        }
      : null;
  }
  async use(id: string, tool: string, args: Record<string, unknown>) {
    await this.ready;
    const l = await this.listing(id);
    const p = (await this.state.list(this.options.sessionId)).find(
        (p) =>
          p.listing_id === id &&
          p.status === "paid" &&
          p.expires_at > Date.now() &&
          p.credits_used < p.credit_limit,
      );
    if (!p || !l.adds_tools.includes(tool))
      throw new StoreError(
        "NOT_PURCHASED",
        "Purchase this capability before using it",
      );
    if (!l.real) {
      if (!(await this.state.consume(p.id)))
        throw new StoreError("QUOTA_EXCEEDED", "Purchased quota exhausted");
      return {
        simulated: true,
        listing_id: id,
        tool,
        result: "Simulated capability; no provider request executed",
      };
    }
    if (!this.options.proxy)
      throw new StoreError("NO_PROXY", "Provider proxy is not configured");
    let path: string;
    let method = "POST";
    let body: Record<string, unknown> | undefined = args;
    if (
      id === "primitive-email" &&
      ["send_email", "ask_by_email"].includes(tool)
    )
      path = "/send-mail";
    else if (
      id === "inkbox-email" &&
      tool === "send_email" &&
      typeof args.mailbox_id === "string"
    )
      path = `/mail/mailboxes/${encodeURIComponent(args.mailbox_id)}/messages`;
    else if (
      id === "inkbox-email" &&
      tool === "read_inbox" &&
      typeof args.mailbox_id === "string"
    ) {
      path = `/mail/mailboxes/${encodeURIComponent(args.mailbox_id)}/messages`;
      method = "GET";
      body = undefined;
    } else
      throw new StoreError(
        "ADAPTER_UNAVAILABLE",
        "This provider tool requires an implemented adapter and configuration",
      );
    const response = await this.options.proxy(
      new Request(
        `${this.options.publicUrl}/proxy/${this.state.tokenFor(p.id)}${path}`,
        {
          method,
          headers: { "content-type": "application/json" },
          ...(body ? { body: JSON.stringify(body) } : {}),
        },
      ),
    );
    if (!response)
      throw new StoreError("NO_PROXY", "Provider route unavailable");
    return {
      listing_id: id,
      status: response.status,
      body: (await response.text()).slice(0, 2000),
    };
  }
}
