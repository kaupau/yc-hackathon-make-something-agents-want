import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { Listing, RunRequest, Verdict } from "../contracts/index.js";

/** Session identity, wallet policy and human identity are bound by composition, never tools. */
export interface StoreSession {
  need(capability: string): Promise<unknown>;
  startTrial(listingId: string): Promise<unknown>;
  runTrial(request: RunRequest): Promise<unknown>;
  compare(ids: string[], checkId?: string): Promise<unknown>;
  buy(listingId: string, reason?: string, requestId?: string): Promise<unknown>;
  wallet(): Promise<unknown>;
  review(listingId: string, verdict: Verdict, reason: string): Promise<unknown>;
  use(listingId: string, tool: string, args: Record<string, unknown>): Promise<unknown>;
}
export interface StoreMcpOptions { listings: Listing[]; lockedTools?: boolean }

const BASE_TOOLS = new Set(["need", "start_trial", "run_trial", "compare", "buy", "wallet", "review", "use"]);
const object = (v: unknown): Record<string, unknown> | null => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : null;
const clip = (v: string, max: number) => v.length <= max ? v : `${v.slice(0,max)}…`;
const id = z.string().min(1).max(256);
const argsSchema = z.record(z.string().max(256), z.unknown()).refine(v => JSON.stringify(v).length <= 32_000, "Tool arguments exceed size limit");

/** Trim recursively before serializing; never traverse or stringify unbounded output. */
function compact(value: unknown, depth = 0): unknown {
  if (value === null || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return clip(value, depth < 2 ? 900 : 320);
  if (depth >= 5) return "[summary omitted]";
  if (Array.isArray(value)) return value.slice(0,10).map(v => compact(v,depth+1));
  const record = object(value); if (!record) return undefined;
  const result: Record<string, unknown> = {};
  for (const [key,v] of Object.entries(record).slice(0,30)) {
    if (/secret|password|authorization|api[_-]?key|credential/i.test(key)) continue;
    result[key] = compact(v,depth+1);
  }
  return result;
}
function summarize(kind: string, value: unknown): unknown {
  const r = object(value);
  if (kind === "need") {
    const listings = Array.isArray(value) ? value : Array.isArray(r?.listings) ? r.listings : null;
    if (listings) return listings.slice(0,8).map(v => { const l=object(v) ?? {}; const trial=object(l.trial); return {id:l.id,vendor:l.vendor_id,name:l.name,description:typeof l.one_line === "string"?clip(l.one_line,130):undefined,price:l.price,trial:trial?{per_agent:trial.per_agent,unit:trial.unit,pool_left:Number(trial.pool_total)-Number(trial.pool_used),funded_by:l.vendor_id}:null,checks:l.checks}; });
  }
  if (kind === "compare" && Array.isArray(r?.results)) return {id:r.id,check_id:r.check_id,suggestion:r.suggestion,reason:r.reason,results:r.results.slice(0,8).map(v=>{const c=object(v)??{};return {listing_id:c.listing_id,trial_id:c.trial_id,ok:c.ok,metrics:c.metrics,loc:c.loc,error:c.error};})};
  if (kind === "run_trial" && r) return {trial_id:r.trial_id,exit_code:r.exit_code,duration_ms:r.duration_ms,stdout:typeof r.stdout === "string"?clip(r.stdout,400):r.stdout,stderr:typeof r.stderr === "string"?clip(r.stderr,240):r.stderr,quota:r.quota};
  return value;
}
function output(kind: string, value: unknown): CallToolResult {
  const safe = compact(summarize(kind,value));
  let text = JSON.stringify(safe ?? null);
  if (text.length > 6500) {
    // Keep complete purchase/authorization fields; avoid cutting JSON or project keys mid-value.
    const r=object(safe);
    const important: Record<string,unknown> = {};
    if (r) for (const key of ["id","listing_id","status","error","code","reason","receipt_id","project_key","base_url","approve_url","payment_pending","declined","quota","quickstart"]) if (r[key] !== undefined) important[key]=r[key];
    text=JSON.stringify({ ...important, summary: "Result shortened; use a narrower query or inspect the requested resource." });
  }
  return {content:[{type:"text",text}]};
}
const failure = (): CallToolResult => ({isError:true,content:[{type:"text",text:JSON.stringify({error:"tool_failed",message:"The operation could not complete. Check wallet, approval, entitlement or provider configuration and retry."})}]});

export function createStoreMcp(session: StoreSession, options: StoreMcpOptions): McpServer {
  const server = new McpServer({name:"bodega",version:"0.1.0"},{maxToolInputElements:512});
  const selected = new Map<string,string>();
  const tools = new Map<string,{enable():void;disable():void}>();
  const listings = new Map(options.listings.map(l=>[l.id,l]));
  const menu = options.listings.slice(0,8).map(l=>`${l.id}: $${l.price.buy_usd.toFixed(2)} ${l.price.unit_label}${l.trial?`, ${l.trial.per_agent} ${l.trial.unit} vendor-funded trial`:""}`).join("; ");
  const invoke = (kind: string, fn: () => Promise<unknown>) => (async (): Promise<CallToolResult> => {try {return output(kind,await fn());} catch {return failure();}})();
  server.registerTool("need", {description:"Find competing development tools. Returns prices, checks and vendor-funded trial quotas. "+menu,inputSchema:z.object({capability:z.string().min(1).max(2000)}).strict()}, ({capability})=>invoke("need",()=>session.need(capability)));
  server.registerTool("start_trial", {description:"Start a vendor-funded sandbox trial: costs the human $0. Returns quickstart, environment names, trial ID and quota.",inputSchema:z.object({listing_id:id}).strict()}, ({listing_id})=>invoke("start_trial",()=>session.startTrial(listing_id)));
  server.registerTool("run_trial", {description:"Run a command or supplied file in an existing isolated trial sandbox; quota is vendor-funded.",inputSchema:z.object({trial_id:id,command:z.string().min(1).max(8000).optional(),file:z.object({path:z.string().min(1).max(1000),content:z.string().max(50_000)}).strict().optional(),timeout_s:z.number().int().min(1).max(120).optional()}).strict().refine(v=>!!v.command||!!v.file,"Provide command or file")}, (request)=>invoke("run_trial",()=>session.runTrial(request)));
  server.registerTool("compare", {description:"Compare up to 8 listings using a category check. Trials cost the human $0; returns measured results and recommendation.",inputSchema:z.object({listing_ids:z.array(id).min(1).max(8),check_id:id.optional()}).strict()}, ({listing_ids,check_id})=>invoke("compare",()=>session.compare(listing_ids,check_id)));
  server.registerTool("buy", {description:"Buy the chosen listing within the session wallet cap; threshold may require human approval. Only verified paid purchases enable tools. "+menu,inputSchema:z.object({listing_id:id,reason:z.string().max(2000).optional(),request_id:id.optional()}).strict()}, ({listing_id,reason,request_id})=>invoke("buy",async()=>{
    const result = await session.buy(listing_id,reason,request_id);
    const r=object(result);
    if (r?.status === "paid" && (r.listing_id === undefined || r.listing_id === listing_id)) {
      for (const tool of listings.get(listing_id)?.adds_tools ?? []) {
        selected.set(tool,listing_id);
        tools.get(tool)?.enable(); // SDK emits tools/list_changed when connected.
      }
    }
    return result;
  }));
  server.registerTool("wallet", {description:"Show human-funded cap, approval threshold, spent/reserved/remaining funds, purchases and vendor-funded trial usage.",inputSchema:z.object({}).strict()}, ()=>invoke("wallet",()=>session.wallet()));
  server.registerTool("review", {description:"Record why a provider was chosen or rejected in its vendor funnel.",inputSchema:z.object({listing_id:id,verdict:z.enum(["chosen","rejected","neutral"]),reason:z.string().min(1).max(2000)}).strict()}, ({listing_id,verdict,reason})=>invoke("review",()=>session.review(listing_id,verdict,reason)));
  server.registerTool("use", {description:"Use an entitled purchased provider tool. Headless fallback for clients that do not refresh dynamic tools. Checks payment and session entitlement on every call.",inputSchema:z.object({listing_id:id,tool:z.string().min(1).max(128),args:argsSchema.default({})}).strict()}, ({listing_id,tool,args})=>invoke("use",()=>session.use(listing_id,tool,args)));

  const dynamic = new Map<string,Set<string>>();
  for (const listing of options.listings) for (const name of listing.adds_tools) {
    if (BASE_TOOLS.has(name) || !/^[A-Za-z0-9_.-]{1,128}$/.test(name)) continue;
    const allowed = dynamic.get(name) ?? new Set<string>(); allowed.add(listing.id); dynamic.set(name,allowed);
  }
  for (const [name,allowed] of dynamic) {
    const tool = server.registerTool(name,{description:`Purchased provider capability. ${options.lockedTools?"Pass listing_id for an entitled provider. ":"Uses the last purchased provider by default. "}Arguments are forwarded only after the session's entitlement check.`,inputSchema:z.object({listing_id:id.optional(),args:argsSchema.default({})}).strict()}, ({listing_id,args})=>invoke(name,async()=>{
      const chosen = listing_id ?? selected.get(name);
      if (!chosen || !allowed.has(chosen)) throw new Error("An entitled listing must be selected");
      return session.use(chosen,name,args);
    }));
    tools.set(name,tool);
    if (!options.lockedTools) tool.disable();
  }
  return server;
}
