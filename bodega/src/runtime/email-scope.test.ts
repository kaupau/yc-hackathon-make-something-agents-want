import test from'node:test';import assert from'node:assert/strict';
import{createVendorServices}from'../vendor/index.js';import{createProxyHandler}from'./proxy.js';import{primitiveInboxFor}from'./email-scope.js';
test('Primitive pooled credentials enforce customer sender and recipient isolation before forwarding',async()=>{
  const v=createVendorServices({dbPath:':memory:',env:{PRIMITIVE_API_KEY:'synthetic-server-key'}});
  const inbox=primitiveInboxFor('customer:alice','agent@tiny-ivy.primitive.email')!;
  let calls=0;let lastUrl:URL|undefined;let lastBody:any;
  const handler=createProxyHandler(v,{primitiveInbox:'agent@tiny-ivy.primitive.email',resolvePurchasedKey:async()=>({listing_id:'primitive-email',lease_id:'p1',session_id:'customer:alice',expires_at:new Date(Date.now()+60000).toISOString(),consume:async()=>true}),fetch:async(url,init)=>{
    calls++;lastUrl=new URL(String(url));lastBody=init?.body?JSON.parse(String(init.body)):null;
    return Response.json(init?.method==='POST'?{success:true,data:{id:'sent1'}}:{data:[{id:'own',recipient:inbox,subject:'hello'},{id:'other',recipient:'victim@tiny-ivy.primitive.email',subject:'private'}],meta:{cursor:'page1',total:999}});
  }});
  try{
    const base='https://bodega.example/proxy/bdg_project_fixture';
    const sent=await handler(new Request(base+'/send-mail',{method:'POST',body:JSON.stringify({from:'victim@tiny-ivy.primitive.email',to:inbox,subject:'hello',body:'test',in_reply_to:'other-tenant-thread'})}));
    assert.equal(sent!.status,200);assert.equal(lastBody.from,inbox);assert.equal(lastBody.body_text,'test');assert.ok(!('in_reply_to'in lastBody));
    const inboxResponse=await handler(new Request(base+'/emails?recipient=victim@tiny-ivy.primitive.email&search=private'));
    assert.equal(lastUrl!.searchParams.get('recipient'),inbox);assert.equal(lastUrl!.searchParams.get('search'),null);
    const content=await inboxResponse!.text();assert.ok(content.includes('own'));assert.ok(!content.includes('victim')&&!content.includes('private')&&!content.includes('999'));
    assert.equal((await handler(new Request(base+'/emails/other-tenant-id')))!.status,403);assert.equal(calls,2);
  }finally{v.close();}
});
