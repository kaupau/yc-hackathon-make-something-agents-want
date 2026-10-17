import type { Listing } from "../contracts/index.js";

const esc = (value: unknown) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );

export interface HomeStats {
  trials: number;
  checks_passed: number;
  purchases: number;
  revenue_usd: number;
}

export interface HomeStatus {
  runtime: string;
  payments: string;
  backend: string;
}

export interface HomeOptions {
  publicUrl: string;
  agentTokenRequired: boolean;
}

const TOOLS: Array<[name: string, does: string, cost: string]> = [
  ["need", "Find competing tools for a capability: prices, checks, trial quotas", "$0"],
  ["start_trial", "Boot a sandbox with the vendor SDK and a scoped trial key", "$0, vendor-funded"],
  ["run_trial", "Run the agent's own code inside that sandbox", "$0, vendor-funded"],
  ["compare", "Run the category's standard check across up to 8 sandboxes at once", "$0, vendor-funded"],
  ["buy", "Buy the winner within the cap; over the threshold, a human approves", "listing price"],
  ["wallet", "Cap, threshold, spent, remaining, purchases, trial usage", "$0"],
  ["review", "Record why a provider won or lost, into the vendor's funnel", "$0"],
  ["use", "Call a purchased provider tool from clients that never refresh tool lists", "metered"],
];

const money = (n: number) => `$${n.toFixed(2)}`;

export function homepage(
  listings: Listing[],
  status: HomeStatus,
  nonce: string,
  stats: HomeStats = { trials: 0, checks_passed: 0, purchases: 0, revenue_usd: 0 },
  options: HomeOptions = { publicUrl: "http://127.0.0.1:8787", agentTokenRequired: false },
) {
  const mcpUrl = `${options.publicUrl.replace(/\/$/, "")}/mcp`;
  const connect = options.agentTokenRequired
    ? `claude mcp add --transport http bodega ${mcpUrl} \\\n  --header "Authorization: Bearer $BODEGA_AGENT_TOKEN"`
    : `claude mcp add --transport http bodega ${mcpUrl}`;

  const categories = new Map<string, Listing[]>();
  for (const l of listings) {
    const key = String(l.category);
    categories.set(key, [...(categories.get(key) ?? []), l]);
  }
  const real = listings.filter((l) => l.real).length;

  const card = (l: Listing) => `<article>
  <div class="card-top"><h3>${esc(l.name)}</h3><span class="pill ${l.real ? "pill-real" : ""}">${l.real ? "Real provider" : "Simulated"}</span></div>
  <p>${esc(l.one_line)}</p>
  <div class="price"><span>${money(l.price.buy_usd)} <small>/ ${esc(l.price.unit_label)}</small></span></div>
  <div class="trial">${l.trial ? `Try first: ${l.trial.per_agent} ${esc(l.trial.unit).replace("_", " ")}, paid by ${esc(l.vendor_id)}` : "Buy-only capability"}<br><code>${esc(l.id)}</code></div>
</article>`;

  const shelf = [...categories.entries()]
    .map(
      ([cat, ls]) => `<section class="category"><h4>${esc(cat)}<span>${ls.length}</span></h4><div class="grid">${ls.map(card).join("")}</div></section>`,
    )
    .join("");

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bodega — Tools for agents</title><style nonce="${nonce}">
*{box-sizing:border-box}
body{margin:0;background:#f7f5ed;color:#252c25;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
header,main,footer{max-width:1160px;margin:auto;padding:0 24px}
header{display:flex;align-items:center;justify-content:space-between;padding:22px 24px;border-bottom:1px solid #d8dccf}
.brand{font-size:25px;font-weight:800;letter-spacing:-1px;text-decoration:none}
nav{display:flex;gap:24px}nav a{text-decoration:none}
.hero{padding:64px 0 28px;max-width:860px}
.eyebrow{text-transform:uppercase;letter-spacing:2px;font-size:11px;color:#4e6d50}
h1{font-size:clamp(40px,7vw,76px);letter-spacing:-3px;line-height:1.02;margin:18px 0}
h1 em{font-style:normal;color:#39754a}
.thesis{max-width:680px;color:#3c463d;font-size:19px;line-height:1.55;margin:0 0 10px}
.thesis strong{color:#252c25}
.sub{max-width:620px;color:#5c665d;font-size:16px;line-height:1.6;margin:0}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0;margin:34px 0 0;border:1px solid #d8dccf;border-radius:12px;background:#fffefa;overflow:hidden}
.stat{padding:18px 20px;border-right:1px solid #ebede4}
.stat:last-child{border-right:0}
.stat b{display:block;font-size:30px;letter-spacing:-1.5px;line-height:1.1;font-weight:700}
.stat span{font-size:12px;color:#6c7567;text-transform:uppercase;letter-spacing:1px}
.stats-note{font-size:12px;color:#75806e;margin:8px 2px 0}
.status{margin:28px 0 0;padding:14px 18px;background:#e9eee2;border:1px solid #d6dfca;border-radius:10px;line-height:1.7;font-size:13px}
.two{display:grid;grid-template-columns:1.1fr .9fr;gap:40px;padding:44px 0;border-bottom:1px solid #d8dccf}
@media(max-width:1000px){.two{grid-template-columns:1fr;gap:28px}}
h2{font-size:24px;letter-spacing:-.6px;margin:0 0 14px}
.connect p{color:#5c665d;margin:0 0 14px}
pre{margin:0 0 12px;padding:16px 18px;background:#1f2a21;color:#e8efe3;border-radius:10px;font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,monospace;overflow:auto}
.links{display:flex;gap:18px;flex-wrap:wrap;font-size:14px}
.button{display:inline-block;background:#294e35;color:#fff;border-radius:8px;padding:11px 18px;text-decoration:none;font-weight:600}
table{width:100%;border-collapse:collapse;font-size:14px}
th{text-align:left;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6c7567;font-weight:600;padding:0 0 8px;border-bottom:1px solid #d8dccf}
td{padding:9px 0;border-bottom:1px solid #ebede4;vertical-align:top;color:#4b544c}
td:first-child{font:600 13px ui-monospace,SFMono-Regular,Menlo,monospace;color:#252c25;white-space:nowrap;padding-right:14px}
td:last-child{white-space:nowrap;color:#39754a;font-weight:600;padding-left:14px;text-align:right}
.shelf-head{display:flex;justify-content:space-between;align-items:baseline;margin:44px 0 6px}
.shelf-head p{margin:0;color:#6c7567;font-size:14px}
.category h4{display:flex;align-items:baseline;gap:10px;font-size:12px;text-transform:uppercase;letter-spacing:2px;color:#4e6d50;margin:28px 0 12px}
.category h4 span{color:#9aa493;letter-spacing:0;font-weight:400}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:14px}
article{background:#fffefa;border:1px solid #dedfd5;border-radius:12px;padding:20px 22px;display:flex;flex-direction:column;min-height:200px}
.card-top{display:flex;justify-content:space-between;align-items:flex-start;gap:10px}
article h3{font-size:20px;margin:0;letter-spacing:-.4px}
article p{color:#667063;line-height:1.55;margin:8px 0 16px;flex:1}
.price{font-weight:700;font-size:17px}
.price small{color:#71806a;font-weight:400;font-size:13px}
.trial{border-top:1px solid #ebede4;margin-top:14px;padding-top:11px;color:#67715f;font-size:12px;line-height:1.7}
code{font:12px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
.pill{font-size:11px;border:1px solid #d4dccb;border-radius:20px;padding:3px 9px;white-space:nowrap;color:#6c7567}
.pill-real{background:#294e35;border-color:#294e35;color:#fff}
footer{color:#75806e;font-size:12px;padding:40px 24px}
</style></head><body>
<header><a class="brand" href="/">bodega<span style="color:#57924c">.</span></a><nav><a href="/portal">Vendor portal</a><a href="/llms.txt">Agent docs ↗</a></nav></header>
<main>
<section class="hero">
  <span class="eyebrow">A developer marketplace where the customer is an agent</span>
  <h1>Find it. Try it.<br><em>Put it to work.</em></h1>
  <p class="thesis"><strong>Agents only have the tools a human wired in before the task started.</strong> Bodega lets them shop mid-task: find competing tools, try each one in a sandbox on the vendor's dime, and buy the winner within the budget the human set.</p>
  <p class="sub">Vendors fund the trials and pay per conversion. Humans set a cap, an approval threshold, and get receipts. Nothing is pre-installed.</p>
</section>

<div class="stats">
  <div class="stat"><b>${listings.length}</b><span>listings · ${real} real</span></div>
  <div class="stat"><b>${stats.trials}</b><span>trials started</span></div>
  <div class="stat"><b>${stats.checks_passed}</b><span>checks passed</span></div>
  <div class="stat"><b>${stats.purchases}</b><span>purchases</span></div>
  <div class="stat"><b>${money(stats.revenue_usd)}</b><span>paid to vendors</span></div>
</div>
<p class="stats-note">Live from the ledger. Trials cost the human nothing; purchases are verified receipts only.</p>

<div class="status"><strong>Development environment</strong> · Payments: ${esc(status.payments)} · Runtime: ${esc(status.runtime)} · Backend: ${esc(status.backend)}.<br>Primitive and Inkbox require provider credentials. Other catalog capabilities are simulated. Trial comparisons in simulation do not rank real providers.</div>

<div class="two">
  <section class="connect">
    <h2>Connect your agent</h2>
    <p>One MCP server, eight tools. Works in any MCP client; clients that never refresh their tool list call <code>use()</code> after a purchase.</p>
    <pre>${esc(connect)}</pre>
    <div class="links"><a class="button" href="/llms.txt">Agent docs ↗</a><a href="/.well-known/mpp">Payment discovery</a><a href="/portal/catalog">Catalog JSON</a><a href="/health">Service status</a></div>
  </section>
  <section>
    <h2>What the agent can call</h2>
    <table><thead><tr><th>Tool</th><th>Does</th><th>Costs the human</th></tr></thead><tbody>
    ${TOOLS.map(([n, d, c]) => `<tr><td>${esc(n)}</td><td>${esc(d)}</td><td>${esc(c)}</td></tr>`).join("")}
    </tbody></table>
  </section>
</div>

<div class="shelf-head"><h2>The tool shelf</h2><p>${listings.length} listings across ${categories.size} categories</p></div>
${shelf}
</main>
<footer>Bodega · Development build · <a href="/health">Service status</a> · <a href="/portal/catalog">Catalog JSON</a> · <a href="/portal">Vendor portal</a></footer>
</body></html>`;
}
