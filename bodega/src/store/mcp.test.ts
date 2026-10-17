import test from "node:test";
import assert from "node:assert/strict";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { ToolListChangedNotificationSchema } from "@modelcontextprotocol/sdk/types.js";
import { LISTINGS } from "../mocks/seed.js";
import { createStoreMcp, type StoreSession } from "./mcp.js";

const listings = LISTINGS.filter(l=>["primitive-email","inkbox-email"].includes(l.id));
async function harness(options: {lockedTools?:boolean;buyStatus?:string;throwBuy?:boolean} = {}) {
  const paid = new Set<string>(); const calls: Array<{listing:string;tool:string;args:Record<string,unknown>}> = []; let buyCalls=0;
  const session: StoreSession = {
    need: async()=>listings,
    startTrial:async(id)=>({id:"trial-1",listing_id:id,quota:{used:0,limit:20},quickstart:"fetch(process.env.BODEGA_TOOL_BASE_URL)"}),
    runTrial:async(req)=>({trial_id:req.trial_id,exit_code:0,stdout:"x".repeat(20000),stderr:"",duration_ms:10,quota:{used:1,limit:20}}),
    compare:async(ids,check)=>({id:"cmp",check_id:check,results:ids.map(listing_id=>({listing_id,ok:true,metrics:{ms:10},loc:9,logs_tail:"huge".repeat(10000)})),suggestion:ids[0],reason:"fastest"}),
    buy:async(id)=>{buyCalls++;if(options.throwBuy) throw new Error("Authorization Bearer sk_test_sensitive and database password"); const status=options.buyStatus??"paid";if(status==="paid")paid.add(id);return {id:"purchase-1",listing_id:id,status,project_key:status==="paid"?"bdg_live_project-key":undefined,base_url:"http://localhost/proxy/project-key"};},
    wallet:async()=>({remaining_usd:5,spent_usd:0}),
    review:async()=>({recorded:true}),
    use:async(listing,tool,args)=>{calls.push({listing,tool,args});if(!paid.has(listing))throw new Error("secret upstream key for unauthorized request");return {ok:true,listing_id:listing};},
  };
  const server=createStoreMcp(session,{listings,lockedTools:options.lockedTools});
  const client=new Client({name:"test-bodega",version:"1"});
  let changes=0; client.setNotificationHandler(ToolListChangedNotificationSchema,()=>{changes++;});
  const [clientTransport,serverTransport]=InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);await client.connect(clientTransport);
  return {client,server,calls,get buyCalls(){return buyCalls;},get changes(){return changes;},async close(){await client.close();await server.close();}};
}
function text(result: unknown): string { return (result as {content:Array<{type:string;text?:string}>}).content.filter(c=>c.type==="text").map(c=>c.text).join("\n"); }

test("eight storefront tools initially; verified paid buy enables deduplicated provider tools and notifies",async()=>{
  const h=await harness();
  try {
    assert.deepEqual((await h.client.listTools()).tools.map(t=>t.name).sort(),["buy","compare","need","review","run_trial","start_trial","use","wallet"]);
    const purchase=await h.client.callTool({name:"buy",arguments:{listing_id:"primitive-email",reason:"passed comparison",request_id:"stable-id"}});
    assert.match(text(purchase),/bdg_live_project-key/);
    const names=(await h.client.listTools()).tools.map(t=>t.name);
    assert.equal(names.filter(n=>n==="send_email").length,1);assert.ok(names.includes("ask_by_email"));assert.ok(!names.includes("read_inbox"));
    assert.ok(h.changes>0);
    const use=await h.client.callTool({name:"send_email",arguments:{args:{to:"demo@example.test"}}});
    assert.ok(!use.isError);assert.equal(h.calls.at(-1)?.listing,"primitive-email");
    await h.client.callTool({name:"buy",arguments:{listing_id:"inkbox-email"}});
    await h.client.callTool({name:"send_email",arguments:{args:{to:"demo@example.test"}}});
    assert.equal(h.calls.at(-1)?.listing,"inkbox-email");
  } finally {await h.close();}
});

test("locked provider tools remain guarded by session.use and do not select unpaid defaults",async()=>{
  const h=await harness({lockedTools:true});
  try {
    assert.equal((await h.client.listTools()).tools.filter(t=>t.name==="send_email").length,1);
    const ambiguous=await h.client.callTool({name:"send_email",arguments:{args:{}}});
    assert.equal(ambiguous.isError,true);assert.equal(h.calls.length,0);
    const unauthorized=await h.client.callTool({name:"send_email",arguments:{listing_id:"primitive-email",args:{}}});
    assert.equal(unauthorized.isError,true);assert.equal(h.calls.length,1);assert.ok(!text(unauthorized).includes("secret upstream"));
    const wrongProvider=await h.client.callTool({name:"read_inbox",arguments:{listing_id:"primitive-email",args:{}}});
    assert.equal(wrongProvider.isError,true);assert.equal(h.calls.length,1);
  } finally {await h.close();}
});

test("declined, pending, and approval purchases never enable provider tools",async()=>{
  for(const buyStatus of ["declined","pending","charging","needs_approval"]){
    const h=await harness({buyStatus});
    try {await h.client.callTool({name:"buy",arguments:{listing_id:"primitive-email"}});assert.equal((await h.client.listTools()).tools.length,8);}finally{await h.close();}
  }
});

test("strict schemas reject policy overrides and malformed arguments before invoking session",async()=>{
  const h=await harness();
  try {
    for(const args of [{listing_id:"primitive-email",session_id:"other"},{listing_id:"primitive-email",cap_usd:999},{listing_id:"primitive-email",human_email:"attacker@example.test"},{listing_id:32}]) {
      const r=await h.client.callTool({name:"buy",arguments:args});assert.equal(r.isError,true);
    }
    assert.equal(h.buyCalls,0);
    assert.equal((await h.client.callTool({name:"run_trial",arguments:{trial_id:"trial-1"}})).isError,true);
    assert.equal((await h.client.callTool({name:"compare",arguments:{listing_ids:[]}})).isError,true);
    assert.equal((await h.client.callTool({name:"review",arguments:{listing_id:"primitive-email",verdict:"approved",reason:"test"}})).isError,true);
  } finally {await h.close();}
});

test("outputs trim logs and catalog setup but preserve required trial and purchase details; errors redact",async()=>{
  const h=await harness({throwBuy:true});
  try {
    const found=await h.client.callTool({name:"need",arguments:{capability:"email"}});assert.ok(text(found).length<1600);assert.ok(!text(found).includes("quickstart"));
    const trial=await h.client.callTool({name:"start_trial",arguments:{listing_id:"primitive-email"}});assert.match(text(trial),/trial-1/);assert.match(text(trial),/quickstart/);
    const run=await h.client.callTool({name:"run_trial",arguments:{trial_id:"trial-1",command:"node demo.js"}});assert.ok(text(run).length<900);
    const compare=await h.client.callTool({name:"compare",arguments:{listing_ids:["primitive-email","inkbox-email"],check_id:"email.roundtrip"}});assert.ok(text(compare).length<900);assert.ok(!text(compare).includes("logs_tail"));
    const error=await h.client.callTool({name:"buy",arguments:{listing_id:"primitive-email"}});assert.equal(error.isError,true);assert.ok(!text(error).includes("sk_test"));assert.ok(!text(error).includes("password"));
  } finally {await h.close();}
});

test("headless use delegates to the same entitlement checks",async()=>{
  const h=await harness();
  try {
    const denied=await h.client.callTool({name:"use",arguments:{listing_id:"primitive-email",tool:"send_email",args:{}}});assert.equal(denied.isError,true);
    await h.client.callTool({name:"buy",arguments:{listing_id:"primitive-email"}});
    const permitted=await h.client.callTool({name:"use",arguments:{listing_id:"primitive-email",tool:"send_email",args:{to:"demo@example.test"}}});assert.ok(!permitted.isError);
  } finally {await h.close();}
});
