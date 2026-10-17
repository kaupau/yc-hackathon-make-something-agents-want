import Stripe from 'stripe';
import { createAdminClient } from '@insforge/sdk';
import { createHash } from 'node:crypto';
import type { Catalog } from '../contracts/index.js';
import { DemoDatabase } from '../vendor/persistence.js';
import { BODEGA_SANDBOX_ACCOUNT, type PaymentOrder, type PaymentProvider } from './payments.js';

export interface Seller { vendorId: string; accountId: string; createdAt: number }
export interface Settlement { purchaseId: string; orderHash: string; accountId: string; feeCents: 0 }
export interface ConnectRepository {
  seller(vendorId: string): Promise<Seller | null>;
  saveSeller(seller: Seller): Promise<Seller>;
  settlement(id: string): Promise<Settlement | null>;
  freeze(settlement: Settlement): Promise<Settlement>;
  close(): void;
}
export class LocalConnectRepository implements ConnectRepository {
  private db: DemoDatabase;
  constructor(path: string) { this.db = new DemoDatabase(path); }
  async seller(id: string) { return this.db.get<Seller>('connect_seller', id); }
  async saveSeller(s: Seller) {
    return this.db.transaction(() => {
      const old = this.db.get<Seller>('connect_seller', s.vendorId);
      if (old && old.accountId !== s.accountId) throw new Error('Seller destination is immutable');
      if (!old) this.db.insert('connect_seller', s.vendorId, s);
      return old ?? s;
    });
  }
  async settlement(id: string) { return this.db.get<Settlement>('connect_settlement', id); }
  async freeze(s: Settlement) {
    return this.db.transaction(() => {
      const old = this.db.get<Settlement>('connect_settlement', s.purchaseId);
      if (old && JSON.stringify(old) !== JSON.stringify(s)) throw new Error('Settlement is immutable');
      if (!old) this.db.insert('connect_settlement', s.purchaseId, s);
      return old ?? s;
    });
  }
  close() { this.db.close(); }
}
export class InsforgeConnectRepository implements ConnectRepository {
  private client: ReturnType<typeof createAdminClient>;
  constructor(url: string, apiKey: string) { this.client = createAdminClient({ baseUrl: url, apiKey }); }
  private async rpc<T>(op: string, payload: unknown): Promise<T> {
    const { data, error } = await this.client.database.rpc('bodega_connect', { p_op: op, p_payload: payload });
    if (error) throw new Error('Connect repository unavailable');
    return data as T;
  }
  seller(vendorId: string) { return this.rpc<Seller | null>('seller', { vendorId }); }
  saveSeller(s: Seller) { return this.rpc<Seller>('save_seller', s); }
  settlement(purchaseId: string) { return this.rpc<Settlement | null>('settlement', { purchaseId }); }
  freeze(s: Settlement) { return this.rpc<Settlement>('freeze', s); }
  close() {}
}
export type ConnectClient = Pick<Stripe, 'accounts' | 'v2'>;
const validVendor = (id: string) => /^[a-z0-9][a-z0-9_-]{0,100}$/i.test(id);
const hashOrder = (p: PaymentOrder) => createHash('sha256').update(JSON.stringify([p.id,p.sessionId,p.listingId,p.amountCents,p.currency,p.idempotencyKey,p.paymentMode??'direct'])).digest('hex');

/** Sandbox-only Accounts v2 recipient onboarding and destination-charge settlement. */
export class MarketplaceConnect {
  constructor(readonly repository: ConnectRepository, private client: ConnectClient, private catalog: Catalog, private publicUrl: string) {}
  private async verifyPlatform() {
    const account = await this.client.accounts.retrieve(null!);
    if (account.id !== BODEGA_SANDBOX_ACCOUNT) throw new Error('Only Bodega Development sandbox is allowed');
  }
  private async account(s: Seller) {
    await this.verifyPlatform();
    const account = await this.client.v2.core.accounts.retrieve(s.accountId, { include: ['configuration.recipient', 'defaults'] });
    if (account.livemode !== false || account.closed || account.metadata?.bodega_vendor_id !== s.vendorId || account.dashboard !== 'express' || account.defaults?.responsibilities?.fees_collector !== 'application' || account.defaults?.responsibilities?.losses_collector !== 'application') throw new Error('Seller account configuration mismatch');
    return account;
  }
  async onboard(input: { vendorId: string; email: string; displayName: string; country: string }) {
    if (!validVendor(input.vendorId) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input.email) || input.email.length > 254 || !/^[A-Z]{2}$/.test(input.country) || !input.displayName || input.displayName.length > 150) throw new Error('Invalid seller details');
    if (!(await this.catalog.listByVendor(input.vendorId)).length) throw new Error('Register a seller listing first');
    await this.verifyPlatform();
    let seller = await this.repository.seller(input.vendorId);
    if (!seller) {
      const account = await this.client.v2.core.accounts.create({
        contact_email: input.email, display_name: input.displayName, identity: { country: input.country },
        dashboard: 'express', defaults: { currency: 'usd', responsibilities: { fees_collector: 'application', losses_collector: 'application' } },
        configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { requested: true } } } } },
        metadata: { bodega_vendor_id: input.vendorId },
      }, { idempotencyKey: `bodega-seller-v1:${input.vendorId}` });
      if (account.livemode !== false) throw new Error('Live seller accounts are refused');
      seller = await this.repository.saveSeller({ vendorId: input.vendorId, accountId: account.id, createdAt: Date.now() });
    }
    await this.account(seller);
    const link = await this.client.v2.core.accountLinks.create({ account: seller.accountId, use_case: { type: 'account_onboarding', account_onboarding: { refresh_url: `${this.publicUrl}/seller/onboarding/refresh`, return_url: `${this.publicUrl}/seller/onboarding/return`, collection_options: { fields: 'eventually_due' } } } });
    // Never put this one-use URL in an email or public catalog. Return only to the authenticated operator.
    return { seller, onboarding_url: link.url, expires_at: link.expires_at, marketplace_fee_percent: 0 };
  }
  async status(vendorId: string) {
    const seller = await this.repository.seller(vendorId);
    if (!seller) return { configured: false, transfers_active: false, marketplace_fee_percent: 0 };
    const account = await this.account(seller);
    const balances = account.configuration?.recipient?.capabilities?.stripe_balance;
    return { configured: true, account_id: seller.accountId, transfers_active: balances?.stripe_transfers?.status === 'active', payouts_active: balances?.payouts?.status === 'active', marketplace_fee_percent: 0 };
  }
  async prepare(order: PaymentOrder): Promise<PaymentOrder> {
    if (order.sellerAccountId || order.platformFeeCents !== undefined) throw new Error('Seller terms must come from the server registry');
    const old = await this.repository.settlement(order.id);
    if (old) {
      if (old.orderHash !== hashOrder(order)) throw new Error('Purchase settlement binding changed');
      return { ...order, sellerAccountId: old.accountId, platformFeeCents: old.feeCents };
    }
    const listing = await this.catalog.get(order.listingId);
    const seller = listing && await this.repository.seller(listing.vendor_id);
    if (!seller) throw new Error('Seller has not connected Stripe; checkout is unavailable');
    const account = await this.account(seller);
    if (account.configuration?.recipient?.capabilities?.stripe_balance?.stripe_transfers?.status !== 'active') throw new Error('Seller must finish Stripe onboarding before checkout');
    const terms = await this.repository.freeze({ purchaseId: order.id, orderHash: hashOrder(order), accountId: seller.accountId, feeCents: 0 });
    return { ...order, sellerAccountId: terms.accountId, platformFeeCents: terms.feeCents };
  }
  payments(provider: PaymentProvider): PaymentProvider {
    return {
      mode: provider.mode,
      prepare: p => this.prepare(p),
      charge: async p => {
        let order: PaymentOrder;
        try { order = await this.prepare(p); }
        catch { return { status: 'declined', error: 'Seller onboarding or settlement is unavailable' }; }
        return provider.charge(order);
      },
      inspect: async (p, id) => {
        const terms = await this.repository.settlement(p.id);
        if (!terms || terms.orderHash !== hashOrder(p)) return { status: 'pending', paymentIntentId: id, error: 'Missing immutable seller settlement' };
        return provider.inspect({ ...p, sellerAccountId: terms.accountId, platformFeeCents: terms.feeCents }, id);
      },
      verifyWebhook: (raw, signature) => provider.verifyWebhook(raw, signature),
    };
  }
}
