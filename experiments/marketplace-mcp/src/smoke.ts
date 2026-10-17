import { mkdirSync, writeFileSync } from "node:fs";
import { adapters } from "./adapters/index.js";
import { closeBrowser } from "./browser.js";

const query = process.argv.slice(2).join(" ") || "arcteryx beta ar jacket";
console.log(`query: "${query}"\n`);
const results = await Promise.all(Object.values(adapters).map(async (a) => {
  const t = Date.now();
  try { const rows = await Promise.race([a.search(query, { limit: 8 }), new Promise<never>((_, rej) => setTimeout(() => rej(new Error("timeout 90s")), 90_000))]); return { name: a.name, ms: Date.now() - t, rows, path: (a as any).lastPath }; }
  catch (e: any) { return { name: a.name, ms: Date.now() - t, rows: [], error: e.message.split("\n")[0] }; }
}));
for (const r of results) {
  console.log(`== ${r.name}: ${r.rows.length} listings in ${r.ms} ms${r.path ? ` via ${r.path}` : ""}${r.error ? `  ERROR ${r.error}` : ""}`);
  for (const l of r.rows.slice(0, 5)) console.log(`   ${l.price_usd === null ? "   ?" : "$" + String(l.price_usd).padStart(4)}  ${(l.condition ?? "").padEnd(12).slice(0, 12)}  ${l.title.slice(0, 70)}  ${l.url}`);
}
mkdirSync(".cache", { recursive: true }); writeFileSync(".cache/smoke.json", JSON.stringify(results, null, 1));
await closeBrowser();
