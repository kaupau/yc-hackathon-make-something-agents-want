// Risk spike: does Claude Code pick up notifications/tools/list_changed mid-session?
// Minimal stdio MCP server, no SDK. Starts with one tool `buy_phone`; when called it
// waits WAIT_MS, registers `call_phone`, sends list_changed, then returns.
import { createInterface } from "node:readline";

const WAIT_MS = Number(process.env.WAIT_MS || 20000);
let unlocked = false;
import { appendFileSync } from "node:fs";
const LOG = process.env.SPIKE_LOG || "/tmp/spike.log";
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };
const send = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");

const tools = () => {
  const t = [{
    name: "buy_phone",
    description: "Buy phone capability. After this returns, a new tool call_phone may appear.",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
  }];
  if (unlocked) t.push({
    name: "call_phone",
    description: "Place a phone call (spike stub). Returns a canned answer.",
    inputSchema: { type: "object", properties: { number: { type: "string" } } },
  });
  return t;
};

const rl = createInterface({ input: process.stdin });
rl.on("line", (line) => {
  let msg; try { msg = JSON.parse(line); } catch { return; }
  const { id, method, params } = msg;
  if (method === "initialize") {
    send({ jsonrpc: "2.0", id, result: {
      protocolVersion: params?.protocolVersion || "2025-06-18",
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "spike", version: "0.0.1" },
    }});
  } else if (method === "notifications/initialized") {
    log("initialized");
  } else if (method === "tools/list") {
    log(`tools/list -> ${tools().map(t => t.name).join(",")}`);
    send({ jsonrpc: "2.0", id, result: { tools: tools() } });
  } else if (method === "tools/call") {
    const name = params?.name;
    if (name === "buy_phone") {
      log(`buy_phone called, waiting ${WAIT_MS}ms`);
      setTimeout(() => {
        unlocked = true;
        send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
        log("sent list_changed; delaying result 3s");
        setTimeout(() => { log("returning buy_phone result"); send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "Purchased phone capability for $0.40. A tool named call_phone should now be available." }] } }); }, 3000);
      }, WAIT_MS);
    } else if (name === "call_phone" && unlocked) {
      log("call_phone called");
      send({ jsonrpc: "2.0", id, result: { content: [{ type: "text", text: "CALL OK: Zuni Cafe is open until 10pm tonight." }] } });
    } else {
      send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unknown tool ${name}` } });
    }
  } else if (method === "ping") {
    send({ jsonrpc: "2.0", id, result: {} });
  } else if (id !== undefined) {
    send({ jsonrpc: "2.0", id, error: { code: -32601, message: `unsupported ${method}` } });
  }
});
