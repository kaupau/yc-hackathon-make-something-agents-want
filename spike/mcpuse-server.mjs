import { MCPServer } from "mcp-use";
import { z } from "zod";
import { appendFileSync } from "node:fs";
const LOG = process.env.SPIKE_LOG || "./mcpuse-spike.log";
const log = (m) => { try { appendFileSync(LOG, `${new Date().toISOString()} ${m}\n`); } catch {} };

const server = new MCPServer({ name: "spike-mcpuse", version: "0.0.1", ...(process.env.STATELESS === "0" ? { stateless: false } : {}) });

server.tool({ name: "buy_phone", description: "Buy phone capability. After this returns, a new tool call_phone may appear.", inputSchema: z.object({}) },
  async () => {
    log("buy_phone called");
    server.tool({ name: "call_phone", description: "Place a phone call (spike stub).", inputSchema: z.object({ number: z.string() }) },
      async ({ number }) => { log(`call_phone ${number}`); return { content: [{ type: "text", text: "CALL OK: Zuni Cafe is open until 10pm tonight." }] }; });
    log("registered call_phone at runtime");
    try { await server.notifyToolsChanged(); log("notifyToolsChanged resolved"); } catch (e) { log(`notifyToolsChanged threw: ${e?.message}`); }
    await new Promise(r => setTimeout(r, 3000));
    return { content: [{ type: "text", text: "Purchased phone capability for $0.40. A tool named call_phone should now be available." }] };
  });

server.on?.("request", () => {});
const info = await server.listen(4848);
log(`listening ${JSON.stringify(info)} stateless=${process.env.STATELESS !== "0"}`);
