import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalConnectRepository, MarketplaceConnect, type ConnectClient } from './connect.js';
import { createMockPayments, BODEGA_SANDBOX_ACCOUNT, type PaymentOrder } from './payments.js';
import { createVendorServices } from '../vendor/index.js';

const order: PaymentOrder = { id: 'p1', sessionId: 'alice', listingId: 'primitive-email', amountCents: 200, currency: 'usd', idempotencyKey: 'alice:p1' };
function fixture() {
  let status = 'active'; let platform = BODEGA_SANDBOX_ACCOUNT; let created: any; let link: any;
  const account = () => ({ id: 'acct_sellerFixture', livemode: false, dashboard: 'express', metadata: { bodega_vendor_id: 'primitive' }, defaults: { responsibilities: { fees_collector: 'application', losses_collector: 'application' } }, configuration: { recipient: { capabilities: { stripe_balance: { stripe_transfers: { status }, payouts: { status } } } } } });
  const client = { accounts: { retrieve: async () => ({ id: platform }) }, v2: { core: { accounts: { create: async (p: any) => { created=p; return account(); }, retrieve: async () => account() }, accountLinks: { create: async (p: any) => {link=p;return {url:'https://connect.stripe.com/setup/synthetic',expires_at:'2026-10-17T22:00:00Z'};} } } } } as unknown as ConnectClient;
  const vendor = createVendorServices({ dbPath: ':memory:' });
  const repository = new LocalConnectRepository(':memory:');
  const service = new MarketplaceConnect(repository, client, vendor.catalog, 'https://bodega.example');
  return {service,repository,vendor,get created(){return created;},get link(){return link;},set status(s:string){status=s;},set platform(s:string){platform=s;},close(){repository.close();vendor.close();}};
}
test('Accounts v2 onboarding requests only recipient transfers with the agreed Express responsibilities', async () => {
  const f=fixture();try {
    const result=await f.service.onboard({vendorId:'primitive',email:'seller@example.com',displayName:'Primitive test seller',country:'US'});
    assert.equal(result.marketplace_fee_percent,0);
    assert.equal(f.created.dashboard,'express');
    assert.deepEqual(f.created.defaults.responsibilities,{fees_collector:'application',losses_collector:'application'});
    assert.deepEqual(f.created.configuration,{recipient:{capabilities:{stripe_balance:{stripe_transfers:{requested:true}}}}});
    assert.equal(f.link.use_case.type,'account_onboarding');
    assert.equal(f.link.use_case.account_onboarding.refresh_url,'https://bodega.example/seller/onboarding/refresh');
  }finally{f.close();}
});
test('marketplace settlement is bound to the purchase, zero fee and trusted catalog seller',async()=>{
  const f=fixture();try{
    const listing=await f.vendor.catalog.get('primitive-email');assert.ok(listing);
    await f.repository.saveSeller({vendorId:listing.vendor_id,accountId:'acct_sellerFixture',createdAt:1});
    const p=await f.service.prepare(order);
    assert.equal(p.sellerAccountId,'acct_sellerFixture');assert.equal(p.platformFeeCents,0);
    await assert.rejects(f.service.prepare({...order,amountCents:300}),/binding changed/);
    await assert.rejects(f.service.prepare({...order,sellerAccountId:'acct_attacker'}),/server registry/);
    f.status='restricted';assert.deepEqual(await f.service.prepare(order),p);
    await assert.rejects(f.service.prepare({...order,id:'p2',idempotencyKey:'alice:p2'}),/finish Stripe onboarding/);
    const payments=f.service.payments(createMockPayments());
    assert.equal((await payments.charge(order)).status,'paid');
    assert.equal((await payments.inspect({...order,sessionId:'mallory'},'mock_fake')).status,'pending');
  }finally{f.close();}
});
test('unconnected sellers and other Stripe accounts cannot charge or onboard',async()=>{
  const f=fixture();try{
    assert.equal((await f.service.payments(createMockPayments()).charge(order)).status,'declined');
    f.platform='acct_liveOther';
    await assert.rejects(f.service.onboard({vendorId:'primitive',email:'seller@example.com',displayName:'Test',country:'US'}),/sandbox/);
  }finally{f.close();}
});
