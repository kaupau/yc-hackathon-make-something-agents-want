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
  ["need", "find competing tools for a capability", "0.00"],
  ["start_trial", "boot a sandbox with the vendor SDK + a scoped key", "0.00  vendor pays"],
  ["run_trial", "run the agent's own code in that sandbox", "0.00  vendor pays"],
  ["compare", "same check across up to 8 sandboxes at once", "0.00  vendor pays"],
  ["buy", "buy the winner within the cap; over threshold a human signs", "list price"],
  ["wallet", "cap, threshold, spent, remaining, receipts", "0.00"],
  ["review", "record why a vendor won or lost", "0.00"],
  ["use", "call a bought tool from clients that never refresh", "metered"],
];

const money = (n: number) => `$${n.toFixed(2)}`;
const pad = (n: number, w = 4) => String(n).padStart(w, " ");

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
  const now = new Date();
  const stamp = `${now.toISOString().slice(0, 10)}  ${now.toISOString().slice(11, 16)}Z`;

  const tag = (l: Listing) => {
    const [dollars, cents] = l.price.buy_usd.toFixed(2).split(".");
    return `<article class="tag">
  <div class="tag-top"><span class="sku"><em>${esc(l.category)}</em> · ${esc(l.id)}</span><span class="stamp ${l.real ? "stamp-real" : "stamp-mock"}">${l.real ? "REAL" : "MOCK"}</span></div>
  <h3>${esc(l.name)}</h3>
  <p>${esc(l.one_line)}</p>
  <div class="tag-price"><span class="cur">$</span><span class="big">${dollars}</span><span class="cents">.${cents}</span><span class="per">/ ${esc(l.price.unit_label)}</span></div>
  ${l.trial ? `<div class="sticker">FREE TRIAL<small>${l.trial.per_agent} ${esc(l.trial.unit).replace("_", " ")} · ${esc(l.vendor_id)} pays</small></div>` : `<div class="sticker sticker-grey">BUY ONLY<small>no sandbox trial</small></div>`}
</article>`;
  };

  const order = [...categories.keys()];
  const sorted = [...listings].sort((a, b) => Number(b.real) - Number(a.real) || order.indexOf(String(a.category)) - order.indexOf(String(b.category)));
  const shelf = `<section class="shelf"><div class="shelf-edge"><span>all aisles · real providers first</span><span>${listings.length} items</span></div><div class="shelf-row">${sorted.map(tag).join("")}</div></section>`;

  const receiptLine = (label: string, value: string) =>
    `<div class="rl"><span>${esc(label)}</span><i></i><b>${esc(value)}</b></div>`;

  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Bodega — Tools for agents</title><style nonce="${nonce}">
:root{--paper:#f1ece1;--paper-2:#faf7f0;--ink:#161513;--ink-2:#4a463f;--mute:#8a847a;--rule:#161513;--red:#d1331b;--yellow:#f7d64a;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Inter,Arial,sans-serif}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;color:var(--ink);font:15px/1.5 var(--sans);background:var(--paper)}
a{color:inherit}
.wrap{max-width:1180px;margin:auto;padding:0 24px}
/* top bar */
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:2px solid var(--rule)}
.brand{font-weight:900;font-size:26px;letter-spacing:-1.5px;text-decoration:none}
.brand i{font-style:normal;color:var(--red)}
.open{font:12px var(--mono);letter-spacing:1px;text-transform:uppercase;display:flex;align-items:center;gap:8px}
.open b{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--red);box-shadow:0 0 0 3px #f3c9c2}
nav{display:flex;gap:22px;font:13px var(--mono);text-transform:uppercase;letter-spacing:1px}
nav a{text-decoration:none;border-bottom:2px solid transparent;padding-bottom:2px}nav a:hover{border-color:var(--ink)}
/* sign */
.sign{display:grid;grid-template-columns:1.4fr 1fr;gap:40px;align-items:start;padding:56px 0 40px;border-bottom:2px solid var(--rule)}
@media(max-width:900px){.sign{grid-template-columns:1fr}}
.kicker{font:12px var(--mono);letter-spacing:2px;text-transform:uppercase;color:var(--ink-2);margin:0 0 14px}
h1{font-size:clamp(46px,8vw,104px);line-height:.92;letter-spacing:-4px;margin:0 0 22px;font-weight:900;text-transform:uppercase}
h1 span{display:block}
h1 .red{color:var(--red)}
.thesis{font:16px/1.6 var(--mono);color:var(--ink);max-width:600px;margin:0 0 10px}
.thesis strong{background:var(--yellow);padding:0 4px;font-weight:600}
.sub{font:13px/1.6 var(--mono);color:var(--ink-2);max-width:560px;margin:0}
/* receipt */
.receipt{background:#fff;padding:22px 22px 26px;border:1px solid #d9d3c6;box-shadow:0 1px 0 #d9d3c6,0 10px 20px -16px rgba(0,0,0,.4);font:13px/1.9 var(--mono);text-transform:uppercase;position:relative;max-width:420px;justify-self:end;width:100%}
.receipt:before,.receipt:after{content:"";position:absolute;left:0;right:0;height:8px;background:radial-gradient(circle at 6px -2px,transparent 6px,#fff 7px) left/12px 8px repeat-x}
.receipt:before{top:-8px}
.receipt:after{bottom:-8px;transform:rotate(180deg)}
.receipt h2{font:inherit;font-weight:700;text-align:center;letter-spacing:2px;margin:0 0 4px}
.receipt .meta{text-align:center;color:var(--mute);font-size:11px;margin-bottom:12px;text-transform:none}
.rl{display:flex;align-items:baseline;gap:8px}
.rl i{flex:1;border-bottom:2px dotted #b9b2a3;transform:translateY(-5px)}
.rl b{font-weight:700}
.rl.total{border-top:1px solid var(--ink);margin-top:8px;padding-top:6px}
.barcode{height:38px;margin:16px 0 6px;background:repeating-linear-gradient(90deg,var(--ink) 0 2px,transparent 2px 4px,var(--ink) 4px 5px,transparent 5px 8px,var(--ink) 8px 11px,transparent 11px 13px)}
.thanks{text-align:center;font-size:11px;letter-spacing:2px}
/* notice */
.notice{font:12px/1.7 var(--mono);color:var(--ink-2);padding:14px 0;border-bottom:1px dashed #b9b2a3}
.notice b{color:var(--ink)}
/* connect + board */
.two{display:grid;grid-template-columns:1fr 1fr;gap:40px;padding:44px 0;border-bottom:2px solid var(--rule)}
.two>*{min-width:0}
@media(max-width:1000px){.two{grid-template-columns:1fr;gap:28px}}
h2.sec{font-size:13px;font-family:var(--mono);letter-spacing:2px;text-transform:uppercase;margin:0 0 14px;display:flex;align-items:center;gap:12px}
h2.sec:after{content:"";flex:1;border-top:2px solid var(--rule)}
.connect p{font:14px/1.6 var(--mono);color:var(--ink-2);margin:0 0 14px}
pre{margin:0 0 14px;padding:16px 18px;background:#fff;border:2px solid var(--ink);font:13px/1.6 var(--mono);overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere}
.links{display:flex;gap:10px;flex-wrap:wrap}
.links a{font:12px var(--mono);text-transform:uppercase;letter-spacing:1px;text-decoration:none;border:2px solid var(--ink);padding:8px 12px}
.links a.primary{background:var(--ink);color:var(--paper)}
.board{background:var(--ink);color:#f3efe6;padding:22px 24px;font:14px/1.7 var(--mono)}
.board h2{margin:0 0 12px;font:inherit;font-weight:700;letter-spacing:2px;text-transform:uppercase;color:var(--yellow);display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}
.board .rl i{border-color:#5a5750}
.board .rl span:first-child{color:#fff;font-weight:700}
.board .rl small{color:#bdb7aa;display:block;margin:-6px 0 4px;font-size:12px;line-height:1.4}
.board .rl b{color:var(--yellow);font-weight:600;white-space:nowrap}
/* shelf */
.shelf-head{display:flex;justify-content:space-between;align-items:baseline;margin:44px 0 10px}
.shelf-head h2{font-size:34px;letter-spacing:-1.5px;margin:0;text-transform:uppercase;font-weight:900}
.shelf-head p{margin:0;font:12px var(--mono);letter-spacing:1px;text-transform:uppercase;color:var(--ink-2)}
.shelf{margin:22px 0 0}
.shelf-edge{display:flex;justify-content:space-between;background:var(--ink);color:var(--paper);font:12px var(--mono);letter-spacing:2px;text-transform:uppercase;padding:7px 12px}
.shelf-row{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:0;border:2px solid var(--ink);border-top:0;background:var(--paper-2)}
.tag{padding:16px 18px 18px;border-right:2px solid var(--ink);border-bottom:2px solid var(--ink);position:relative;display:flex;flex-direction:column;min-height:230px}
.tag-top{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px}
.sku{font:11px var(--mono);color:var(--mute);letter-spacing:1px}
.sku em{font-style:normal;color:var(--ink);font-weight:700;text-transform:uppercase}
.stamp{font:11px var(--mono);font-weight:700;letter-spacing:2px;border:2px solid currentColor;padding:1px 6px;transform:rotate(-6deg)}
.stamp-real{color:var(--red)}
.stamp-mock{color:var(--mute);border-style:dashed}
.tag h3{margin:0 0 6px;font-size:19px;letter-spacing:-.4px;font-weight:800}
.tag p{margin:0 0 14px;color:var(--ink-2);font-size:13.5px;line-height:1.5;flex:1}
.tag-price{font-family:var(--mono);display:flex;align-items:baseline;gap:2px;margin-bottom:12px}
.tag-price .cur{font-size:18px;font-weight:700;align-self:flex-start;margin-top:6px}
.tag-price .big{font-size:40px;font-weight:700;letter-spacing:-2px;line-height:1}
.tag-price .cents{font-size:18px;font-weight:700}
.tag-price .per{font-size:11px;color:var(--mute);margin-left:8px;text-transform:uppercase;letter-spacing:1px}
.sticker{align-self:flex-start;background:var(--yellow);color:var(--ink);font:11px var(--mono);font-weight:700;letter-spacing:1.5px;padding:6px 10px;transform:rotate(-2deg);box-shadow:1px 1px 0 rgba(0,0,0,.25)}
.sticker small{display:block;font-weight:500;letter-spacing:.5px;text-transform:none;margin-top:2px}
.sticker-grey{background:#dcd6c8;color:var(--ink-2)}
footer{font:12px var(--mono);color:var(--mute);padding:40px 0;text-transform:uppercase;letter-spacing:1px;display:flex;justify-content:space-between;flex-wrap:wrap;gap:10px}
footer a{text-decoration:none}
</style></head><body>
<div class="wrap">
<div class="bar">
  <a class="brand" href="/">bodega<i>.</i></a>
  <span class="open"><b></b>open 24/7 · no humans required</span>
  <nav><a href="/portal">Back office</a><a href="/llms.txt">Agent docs ↗</a></nav>
</div>

<section class="sign">
  <div>
    <p class="kicker">Corner store · the customer is an agent</p>
    <h1><span>Tools</span><span class="red">for agents.</span></h1>
    <p class="thesis"><strong>Agents only have the tools a human wired in before the task started.</strong> Bodega lets them shop mid-task: find competing tools, try each in a sandbox on the vendor's dime, buy the winner within the budget the human set.</p>
    <p class="sub">Vendors fund the trials and pay per conversion. Humans set a cap, an approval threshold, and get receipts. Nothing is pre-installed.</p>
  </div>
  <div class="receipt">
    <h2>Bodega</h2>
    <div class="meta">live from the ledger · ${esc(stamp)}</div>
    ${receiptLine("listings on shelf", pad(listings.length))}
    ${receiptLine("real providers", pad(real))}
    ${receiptLine("trials started", pad(stats.trials))}
    ${receiptLine("checks passed", pad(stats.checks_passed))}
    ${receiptLine("purchases", pad(stats.purchases))}
    <div class="rl total"><span>paid to vendors</span><i></i><b>${esc(money(stats.revenue_usd))}</b></div>
    ${receiptLine("charged to humans for trials", "$0.00")}
    <div class="barcode"></div>
    <div class="thanks">thank you · come again</div>
  </div>
</section>

<div class="notice"><b>Dev build</b> · payments: ${esc(status.payments)} · runtime: ${esc(status.runtime)} · backend: ${esc(status.backend)}. Primitive and Inkbox need provider credentials; other listings are simulated and comparisons in simulation never rank real providers.</div>

<div class="two">
  <section class="connect">
    <h2 class="sec">Connect your agent</h2>
    <p>One MCP server, eight tools. Any MCP client. Clients that never refresh their tool list call <code>use()</code> after a purchase.</p>
    <pre>${esc(connect)}</pre>
    <div class="links"><a class="primary" href="/llms.txt">Agent docs ↗</a><a href="/.well-known/mpp">Payment discovery</a><a href="/portal/catalog">Catalog JSON</a><a href="/health">Status</a></div>
  </section>
  <section class="board">
    <h2><span>Menu</span><span>what it costs the human</span></h2>
    ${TOOLS.map(([n, d, c]) => `<div class="rl"><span>${esc(n)}</span><i></i><b>${esc(c)}</b></div><div class="rl"><small>${esc(d)}</small></div>`).join("")}
  </section>
</div>

<div class="shelf-head"><h2>The shelf</h2><p>${listings.length} listings · ${categories.size} aisles</p></div>
${shelf}

<footer><span>Bodega · dev build</span><span><a href="/health">status</a> · <a href="/portal/catalog">catalog json</a> · <a href="/portal">back office</a></span></footer>
</div>
</body></html>`;
}
