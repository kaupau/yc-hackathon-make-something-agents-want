import server from "../index.js";
import { jevAvailable } from "./jev.js";
// Laptop runner without the mcp-use CLI (no Views). `npm run dev` uses the CLI and serves the board.
const port = Number(process.env.PORT ?? 3777);
await server.listen(port);
console.log(`marketplace-mcp listening on http://localhost:${port}/mcp  (jev ${jevAvailable() ? "on" : "off"})`);
