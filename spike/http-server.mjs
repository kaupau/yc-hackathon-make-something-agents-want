import express from "express";
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

const LOG = process.env.SPIKE_LOG || "/tmp/spike-http.log";
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

function build() {
  const server = new McpServer({ name: "spike-http", version: "0.0.1" });
  const callTool = server.registerTool("call_phone", {
    description: "Place a phone call (spike stub).",
    inputSchema: { number: z.string() },
  }, async ({ number }) => { log(`call_phone ${number}`); return { content: [{ type: "text", text: "CALL OK: Zuni Cafe is open until 10pm tonight." }] }; });
  callTool.disable(); // hidden until purchased
  server.registerTool("buy_phone", {
    description: "Buy phone capability. After this returns, a new tool call_phone may appear.",
    inputSchema: {},
  }, async () => {
    log("buy_phone called");
    await new Promise(r => setTimeout(r, 3000));
    callTool.enable(); // SDK sends notifications/tools/list_changed
    log("enabled call_phone (list_changed sent)");
    await new Promise(r => setTimeout(r, 3000));
    log("returning buy_phone result");
    return { content: [{ type: "text", text: "Purchased phone capability for $0.40. A tool named call_phone should now be available." }] };
  });
  // observe tools/list requests
  const orig = server.server.setRequestHandler.bind(server.server);
  return server;
}

const app = express();
app.use(express.json());
const transports = {};
app.post("/mcp", async (req, res) => {
  const sid = req.headers["mcp-session-id"];
  let t = sid && transports[sid];
  if (!t) {
    t = new StreamableHTTPServerTransport({ sessionIdGenerator: () => randomUUID(), onsessioninitialized: (id) => { transports[id] = t; log(`session ${id}`); } });
    const server = build();
    server.server.oninitialized = () => log("initialized");
    await server.connect(t);
  }
  if (req.body?.method) log(`<- ${req.body.method}`);
  await t.handleRequest(req, res, req.body);
});
app.get("/mcp", async (req, res) => { const t = transports[req.headers["mcp-session-id"]]; log("GET stream opened"); if (!t) return res.status(400).end(); await t.handleRequest(req, res); });
app.delete("/mcp", async (req, res) => { const t = transports[req.headers["mcp-session-id"]]; if (!t) return res.status(400).end(); await t.handleRequest(req, res); });
app.listen(4747, () => log("listening 4747"));
