// LLM shopper: each agent is a Claude tool-use loop over Bodega's own MCP tools plus four
// local swarm tools. A manual loop (not the beta tool runner) because the tools come from a
// live MCP session and every call has to stream into the swarm's event log.
import Anthropic from "@anthropic-ai/sdk";
import type { Agent } from "../agent.js";
import { usd } from "../missions.js";
import type { Outcome } from "./scripted.js";

export interface ClaudeOptions { model: string; effort: "low" | "medium" | "high" | "xhigh" | "max"; maxTurns: number }

const BODEGA_TOOLS = new Set(["need", "start_trial", "run_trial", "compare", "buy", "wallet", "review", "use"]);
const LOCAL_TOOLS: Anthropic.Beta.BetaTool[] = [
  { name: "board_read", description: "Read what other agents in the swarm posted: trial results, failures and purchases per topic (email, database, auth, search, queue, voice, phone). Read it before trialing a topic.", input_schema: { type: "object", properties: { topic: { type: "string", description: "Optional topic filter" } }, additionalProperties: false } },
  { name: "board_post", description: "Post one finding for the rest of the swarm: which listings passed or failed a trial and why, or what you bought. Keep it to one or two sentences.", input_schema: { type: "object", properties: { topic: { type: "string" }, note: { type: "string" } }, required: ["topic", "note"], additionalProperties: false } },
  { name: "wait_for_approval", description: "Block until your human approves or declines a purchase that buy() returned as needs_approval. Then call buy again with the same listing_id and request_id.", input_schema: { type: "object", properties: { purchase_id: { type: "string" } }, required: ["purchase_id"], additionalProperties: false } },
  { name: "finish", description: "End your shift with a short summary for your human and any blockers they need to resolve.", input_schema: { type: "object", properties: { summary: { type: "string" }, blockers: { type: "array", items: { type: "string" } } }, required: ["summary", "blockers"], additionalProperties: false } },
];

function system(agent: Agent): string {
  const m = agent.mission;
  return `You are "${m.name}", one of several agents in a swarm. Each agent has its own human, wallet and job, and all of them shop at Bodega, an MCP store for developer tools.

Your human's job for you: ${m.goal}

Your wallet: ${usd(m.capCents)} cap. Purchases above ${usd(m.thresholdCents)} need your human's approval by email; you never see the approval link. Bodega enforces the cap server-side.

Work like this:
1. Call board_read first. Other agents post what they already trialed; do not repeat a trial a peer reported as failed.
2. For each capability your job needs, call need(), then trial the candidates: compare() with check_id "email.roundtrip" for email, otherwise start_trial() and one short run_trial() smoke test. Trials are vendor-funded and cost your human nothing.
3. Choose one listing per capability: measured passes first, then fit to your job, then price. Keep enough budget for every capability you still need. Do not buy anything your job does not need.
4. buy() with request_id "${m.id}-<listing_id>". If the result is needs_approval, call wait_for_approval with its purchase_id, then repeat the identical buy().
5. review() the listing you chose and each one you rejected, with one sentence the vendor can act on.
6. board_post what you learned so the next agent can skip it.
7. If a purchase adds a tool, try it once with use().
8. Call finish with a summary and blockers.

Bodega labels simulated trials and payments. Say so plainly and never claim a measurement you did not get. Keep your text between tool calls to one short sentence.`;
}

export async function claudeBrain(agent: Agent, opts: ClaudeOptions): Promise<Outcome> {
  const client = new Anthropic({ maxRetries: 4 });
  const tools: Anthropic.Beta.BetaTool[] = [
    ...agent.tools.filter(t => BODEGA_TOOLS.has(t.name)).map(t => {
      const { $schema: _drop, ...schema } = t.inputSchema as Record<string, unknown>;
      return { name: t.name, description: t.description ?? "", input_schema: schema as Anthropic.Beta.BetaTool.InputSchema };
    }),
    ...LOCAL_TOOLS,
  ];
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: "user", content: `Start your shift. Job: ${agent.mission.goal}` }];
  agent.status("shopping", `Thinking (${opts.model})`);

  for (let turn = 0; turn < opts.maxTurns; turn++) {
    let response: Anthropic.Beta.BetaMessage;
    try {
      response = await client.beta.messages.create({
        model: opts.model,
        max_tokens: 16000,
        betas: ["server-side-fallback-2026-07-01", "thinking-display-updates-2026-08-18"],
        fallbacks: "default",
        thinking: { type: "adaptive", display: "updates" },
        output_config: { effort: opts.effort },
        system: [{ type: "text", text: system(agent), cache_control: { type: "ephemeral" } }],
        tools,
        messages,
      });
    } catch (error) {
      const detail = error instanceof Anthropic.APIError ? `Claude API ${error.status ?? ""} ${error.message}` : String(error);
      return { ok: false, summary: "Stopped: the model call failed.", blockers: [detail] };
    }
    if (response.stop_reason === "refusal") return { ok: false, summary: "Stopped: the model declined this request.", blockers: ["Model refusal"] };
    for (const block of response.content) {
      if (block.type === "text" && block.text.trim()) agent.think(block.text.trim());
      if (block.type === "thinking" && block.thinking.trim()) agent.think(block.thinking.trim());
    }
    messages.push({ role: "assistant", content: response.content });
    if (response.stop_reason === "pause_turn") continue;
    if (response.stop_reason === "max_tokens") return { ok: false, summary: "Stopped: the response hit max_tokens.", blockers: ["max_tokens"] };
    const uses = response.content.filter((b): b is Anthropic.Beta.BetaToolUseBlock => b.type === "tool_use");
    if (!uses.length) return { ok: true, summary: textOf(response) || "Finished without a summary.", blockers: [] };

    const finish = uses.find(u => u.name === "finish");
    if (finish) {
      const input = finish.input as { summary?: string; blockers?: string[] };
      return { ok: !(input.blockers ?? []).length, summary: String(input.summary ?? ""), blockers: (input.blockers ?? []).map(String) };
    }
    // Run the turn's calls together and answer them in one message, which keeps parallel calls coming.
    const results = await Promise.all(uses.map(u => run(agent, u)));
    messages.push({ role: "user", content: results });
  }
  return { ok: false, summary: `Stopped after ${opts.maxTurns} turns.`, blockers: ["Turn limit reached"] };
}

async function run(agent: Agent, u: Anthropic.Beta.BetaToolUseBlock): Promise<Anthropic.Beta.BetaToolResultBlockParam> {
  const input = (u.input ?? {}) as Record<string, any>;
  const reply = (content: unknown, is_error = false): Anthropic.Beta.BetaToolResultBlockParam =>
    ({ type: "tool_result", tool_use_id: u.id, content: (typeof content === "string" ? content : JSON.stringify(content)).slice(0, 8000), is_error });
  switch (u.name) {
    case "board_read": return reply(agent.board.read(typeof input.topic === "string" ? input.topic : undefined));
    case "board_post": agent.board.note(agent.mission.id, String(input.topic ?? "general"), String(input.note ?? "")); return reply({ posted: true });
    case "wait_for_approval": {
      agent.status("awaiting_human", "Waiting for the human");
      const d = await agent.desk.waitFor(String(input.purchase_id ?? ""));
      agent.status("buying", `Human ${d.decision}; repeating the buy`);
      return reply(d);
    }
    default: {
      if (!BODEGA_TOOLS.has(u.name)) return reply({ error: `Unknown tool ${u.name}` }, true);
      if (u.name === "start_trial" || u.name === "run_trial" || u.name === "compare") agent.status("trialing", `${u.name}(${input.listing_id ?? (input.listing_ids ?? []).join(", ") ?? ""})`);
      else if (u.name === "buy") agent.status("buying", `buy(${input.listing_id})`);
      else if (u.name === "use") agent.status("using", `use(${input.tool})`);
      else agent.status("shopping", `${u.name}()`);
      const r = await agent.call(u.name, input);
      return reply(r.data, !r.ok);
    }
  }
}

const textOf = (m: Anthropic.Beta.BetaMessage) => m.content.flatMap(b => b.type === "text" ? [b.text] : []).join("\n").trim();
