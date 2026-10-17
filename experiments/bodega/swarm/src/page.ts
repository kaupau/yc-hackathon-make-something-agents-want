// The swarm floor. Live: streams /events from the orchestrator. Replay: the run's events are
// embedded and the page renders the finished run at rest, with a button to play it back.
// Visual language follows the Bodega corner-store look: receipt paper, ink, one red for
// stamps, one yellow for stickers, mono for every number.
import type { SwarmEvent } from "./events.js";

export function renderPage(opts: { mode: "live" | "replay"; events?: SwarmEvent[]; fragment?: boolean }): string {
  const data = opts.mode === "replay" ? JSON.stringify(opts.events ?? []).replace(/</g, "\\u003c") : "[]";
  const head = `<title>Bodega Swarm Floor</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,400..900&display=swap">
<style>
/* Layout: a shop floor. Sign band on top, a tally strip of mono numbers, agent receipts on the
   counter, the approval desk and swarm board on the side, the tape and vendor ledger below. */
:root{
  --paper:#f1ece1; --paper-2:#faf7f0; --ink:#161513; --ink-2:#4a463f; --mute:#857f74; --line:#cfc7b6;
  --red:#c92f17; --yellow:#f7d64a; --yellow-ink:#161513; --ok:#2e6a3a;
  --display:"Archivo","Arial Narrow","Helvetica Neue",Arial,sans-serif;
  --sans:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Arial,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){
  --paper:#151412; --paper-2:#1f1d1a; --ink:#eee8db; --ink-2:#c3bcad; --mute:#918a7e; --line:#3a3630;
  --red:#ff6b4f; --yellow:#e9c83c; --yellow-ink:#161513; --ok:#78c786; color-scheme:dark}}
:root[data-theme="dark"]{
  --paper:#151412; --paper-2:#1f1d1a; --ink:#eee8db; --ink-2:#c3bcad; --mute:#918a7e; --line:#3a3630;
  --red:#ff6b4f; --yellow:#e9c83c; --yellow-ink:#161513; --ok:#78c786; color-scheme:dark}
*{box-sizing:border-box}
body{background:var(--paper);color:var(--ink);font:14px/1.5 var(--sans);margin:0}
.wrap{max-width:1280px;margin:0 auto;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px))}
.num,.mono{font-family:var(--mono);font-variant-numeric:tabular-nums}
.label{font:600 11px var(--mono);letter-spacing:.12em;text-transform:uppercase;color:var(--mute)}
h1,h2,h3{text-wrap:balance;margin:0}
/* Sign */
.sign{border-bottom:3px solid var(--ink)}
.sign .wrap{display:flex;flex-wrap:wrap;align-items:flex-end;justify-content:space-between;gap:12px 24px;padding-block:22px 16px}
.brand{font:900 clamp(34px,6vw,56px)/.9 var(--display);font-stretch:68%;letter-spacing:-.01em;text-transform:uppercase}
.brand span{color:var(--red)}
.sub{color:var(--ink-2);max-width:62ch;margin-top:8px}
.chips{display:flex;flex-wrap:wrap;gap:6px;align-items:center}
.chip{font:600 11px var(--mono);letter-spacing:.08em;text-transform:uppercase;border:1.5px solid var(--ink);padding:3px 8px;border-radius:2px;white-space:nowrap}
.chip.sticker{background:var(--yellow);color:var(--yellow-ink);border-color:var(--yellow)}
.controls{display:flex;gap:8px;align-items:center}
button,select{font:600 12px var(--mono);letter-spacing:.06em;text-transform:uppercase;background:var(--ink);color:var(--paper);border:0;border-radius:2px;padding:8px 12px;cursor:pointer}
select{background:var(--paper-2);color:var(--ink);border:1.5px solid var(--ink)}
button:focus-visible,select:focus-visible,summary:focus-visible{outline:3px solid var(--red);outline-offset:2px}
/* Tally */
.tally{border-bottom:1px solid var(--ink)}
.tally .wrap{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:0}
.tally div{padding-block:12px;padding-right:12px}
.tally b{display:block;font:700 24px var(--mono);font-variant-numeric:tabular-nums;letter-spacing:-.02em}
.tally small{color:var(--ink-2);font-size:12px}
/* Floor */
.floor{display:grid;grid-template-columns:minmax(0,1fr) minmax(280px,340px);gap:24px;padding-block:24px}
@media (max-width:900px){.floor{grid-template-columns:minmax(0,1fr)}}
.agents{display:grid;grid-template-columns:repeat(auto-fill,minmax(290px,1fr));gap:16px;align-content:start}
.receipt{background:var(--paper-2);border:1px solid var(--line);padding:16px 16px 14px;display:flex;flex-direction:column;gap:10px;min-width:0;position:relative}
.receipt::after{content:"";position:absolute;left:0;right:0;bottom:-6px;height:6px;background:radial-gradient(circle at 6px 0,transparent 5px,var(--paper-2) 5.5px) 0 0/12px 6px repeat-x}
.receipt header{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.receipt h3{font:800 20px/1.1 var(--display);font-stretch:80%;text-transform:uppercase;letter-spacing:.01em}
.goal{color:var(--ink-2);font-size:13px;margin:0}
.stamp{font:800 11px var(--mono);letter-spacing:.1em;text-transform:uppercase;border:2px solid currentColor;padding:2px 6px;border-radius:2px;white-space:nowrap;transform:rotate(-2deg)}
.st-waiting,.st-shopping,.st-trialing,.st-buying,.st-using{color:var(--ink-2)}
.st-awaiting_human{color:var(--yellow-ink);background:var(--yellow);border-color:var(--yellow)}
.st-done{color:var(--ok)} .st-blocked{color:var(--red)}
.step{font:12px/1.45 var(--mono);color:var(--ink);min-height:2.9em;overflow-wrap:anywhere}
.live .step::after{content:"▍";animation:blink 1s steps(1) infinite;color:var(--mute)}
.receipt.finished .step::after{content:none}
@keyframes blink{50%{opacity:0}}
@media (prefers-reduced-motion:reduce){.live .step::after{animation:none}}
.thought{font-size:12.5px;color:var(--ink-2);border-left:2px solid var(--line);padding-left:8px;margin:0;overflow-wrap:anywhere}
.meter{display:flex;flex-direction:column;gap:4px}
.bar{position:relative;height:10px;background:transparent;border:1.5px solid var(--ink)}
.bar i{position:absolute;top:0;bottom:0;left:0;background:var(--ink)}
.bar i.res{background:repeating-linear-gradient(45deg,var(--yellow) 0 4px,transparent 4px 7px)}
.bar u{position:absolute;top:-4px;bottom:-4px;width:2px;background:var(--red)}
.meter .row{display:flex;justify-content:space-between;font:11px var(--mono);color:var(--ink-2);font-variant-numeric:tabular-nums}
.lines{list-style:none;margin:0;padding:8px 0 0;border-top:1px dashed var(--ink-2);display:flex;flex-direction:column;gap:3px}
.lines li{display:flex;gap:6px;font:12.5px var(--mono);font-variant-numeric:tabular-nums;align-items:baseline}
.lines li .n{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;min-width:0}
.lines li .dots{flex:1;border-bottom:1px dotted var(--mute);transform:translateY(-3px);min-width:12px}
.lines li.declined .n,.lines li.refused .n{text-decoration:line-through;color:var(--mute)}
.lines li em{font-style:normal;font-weight:700;font-size:10.5px;letter-spacing:.06em;text-transform:uppercase}
.lines li.declined em,.lines li.refused em{color:var(--red)}
.lines li.needs_approval em{background:var(--yellow);color:var(--yellow-ink);padding:0 4px}
.lines li.total{border-top:1px solid var(--ink);padding-top:4px;margin-top:2px;font-weight:700}
.empty{color:var(--mute);font:12px var(--mono)}
.foot{display:flex;flex-wrap:wrap;gap:4px 12px;font:11px var(--mono);color:var(--mute)}
.verdict{font-size:13px;border-top:1px solid var(--ink);padding-top:8px;display:flex;flex-direction:column;gap:4px}
.verdict ul{margin:0;padding-left:18px;color:var(--red);font-size:12.5px}
/* Side */
.side{display:flex;flex-direction:column;gap:24px;min-width:0}
.panel h2,.section h2{font:800 22px/1 var(--display);font-stretch:75%;text-transform:uppercase;margin-bottom:10px;display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.panel ol{list-style:none;margin:0;padding:0;display:flex;flex-direction:column;gap:10px}
.ap{border-top:1px solid var(--line);padding-top:8px;display:grid;grid-template-columns:minmax(0,1fr) auto;gap:2px 8px}
.ap .what{font:12.5px var(--mono);overflow-wrap:anywhere}
.ap .why{grid-column:1/-1;font-size:12.5px;color:var(--ink-2)}
.dec{font:800 10.5px var(--mono);letter-spacing:.08em;text-transform:uppercase;padding:1px 5px;border:1.5px solid currentColor;align-self:start}
.dec.approved{color:var(--ok)} .dec.declined{color:var(--red)} .dec.pending{color:var(--yellow-ink);background:var(--yellow);border-color:var(--yellow)}
.note{border-top:1px solid var(--line);padding-top:8px;font-size:12.5px;overflow-wrap:anywhere}
.tag{font:700 10.5px var(--mono);letter-spacing:.06em;text-transform:uppercase;color:var(--ink);margin-right:6px}
.topic{font:10.5px var(--mono);color:var(--mute);text-transform:uppercase;letter-spacing:.06em}
/* Tape and ledger */
.section{padding-block:8px 28px;border-top:3px solid var(--ink)}
.section h2{margin-top:16px}
.scroll{overflow-x:auto;max-width:100%}
table{border-collapse:collapse;width:100%;min-width:640px}
th{font:600 10.5px var(--mono);letter-spacing:.1em;text-transform:uppercase;color:var(--mute);text-align:left;padding:6px 10px 6px 0;border-bottom:1.5px solid var(--ink)}
td{padding:6px 10px 6px 0;border-bottom:1px solid var(--line);vertical-align:top;font-size:12.5px}
td.num,th.num{text-align:right}
td.sum{color:var(--ink-2);overflow-wrap:anywhere;max-width:60ch}
td .bad{color:var(--red);font-weight:700}
.reasons{color:var(--ink-2);font-size:12px}
.reasons q{quotes:"“" "”"}
details summary{cursor:pointer;font:600 12px var(--mono);text-transform:uppercase;letter-spacing:.06em;margin-top:8px}
footer.end{border-top:1px solid var(--ink);color:var(--ink-2);font-size:12.5px}
footer.end .wrap{padding-block:16px 32px;display:flex;flex-direction:column;gap:6px}
code{font:12px var(--mono);overflow-wrap:anywhere}
</style>`;
  const body = `<div class="sign"><div class="wrap">
  <div><div class="brand">Bodega<span>.</span> swarm floor</div>
  <p class="sub">Six agents with six different jobs walk into one tool store. Each has its own human, wallet cap and approval threshold. They search, run vendor-funded trials, share findings, and buy only what their job needs.</p></div>
  <div class="chips" id="chips"></div>
</div></div>
<div class="tally"><div class="wrap" id="tally"></div></div>
<div class="wrap floor ${opts.mode === "live" ? "live" : ""}" id="floor">
  <div class="agents" id="agents"><p class="empty">Waiting for the swarm to start…</p></div>
  <aside class="side">
    <section class="panel"><h2>Approval desk <span class="label" id="ap-count"></span></h2><ol id="approvals"><li class="empty">No purchase has crossed a threshold yet.</li></ol></section>
    <section class="panel"><h2>Swarm board <span class="label" id="board-count"></span></h2><ol id="board"><li class="empty">Agents post trial findings here so peers can skip repeat trials.</li></ol></section>
  </aside>
</div>
<div class="wrap section"><h2>What the vendors learned <span class="label">from Bodega's funnel</span></h2><div class="scroll"><table><thead><tr><th>Listing</th><th class="num">Trials</th><th class="num">Checks passed</th><th class="num">Chosen</th><th class="num">Rejected</th><th class="num">Purchases</th><th class="num">Revenue</th><th>Why agents chose or passed</th></tr></thead><tbody id="funnel"><tr><td colspan="8" class="empty">Appears when the run ends: Bodega's per-vendor funnel built from every trial, review and purchase.</td></tr></tbody></table></div></div>
<div class="wrap section"><h2>The tape <span class="label" id="tape-count"></span></h2><div class="scroll"><table><thead><tr><th class="num">t+s</th><th>Agent</th><th>Tool</th><th>Result</th></tr></thead><tbody id="tape"></tbody></table></div><details id="more" hidden><summary>Show every call</summary><div class="scroll"><table><tbody id="tape-all"></tbody></table></div></details></div>
<footer class="end"><div class="wrap" id="footer"></div></footer>
<script id="swarm-events" type="application/json">${data}</script>
<script>
(() => {
const MODE = ${JSON.stringify(opts.mode)};
const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
const $ = id => document.getElementById(id);
const money = n => "$" + Number(n || 0).toFixed(2);
const STATUS = {waiting:"Waiting",shopping:"Shopping",trialing:"Trialing",buying:"Buying",awaiting_human:"Asking human",using:"Using",done:"Done",blocked:"Blocked"};
let S;
function reset(){ S = {run:null, agents:{}, order:[], tape:[], approvals:{}, apOrder:[], board:[], funnel:null, end:null, args:{}, calls:0}; }
function A(id){ return S.agents[id] || (S.agents[id] = {card:{id,name:id,goal:"",cap_usd:0,threshold_usd:0}, status:"waiting", step:"", wallet:null, lines:{}, trials:0, calls:0, thought:"", done:null, posts:0}); }
function apply(e){
  switch(e.kind){
    case "run": S.run = e; for (const c of e.agents){ A(c.id).card = c; A(c.id).wallet = {cap_usd:c.cap_usd, threshold_usd:c.threshold_usd, spent_usd:0, reserved_usd:0, remaining_usd:c.cap_usd}; if(!S.order.includes(c.id)) S.order.push(c.id); } break;
    case "status": { const a = A(e.agent); if(!a.done){ a.status = e.status; a.step = e.step; } break; }
    case "thought": A(e.agent).thought = e.text; break;
    case "call": { const a = A(e.agent); a.calls++; S.calls++; S.args[e.agent+":"+e.id] = e.args;
      if (e.tool === "start_trial") a.trials++; if (e.tool === "compare") a.trials += (e.args.listing_ids||[]).length; break; }
    case "result": { S.tape.push(e); const args = S.args[e.agent+":"+e.id] || {};
      if (e.tool === "buy" && !e.ok) A(e.agent).lines[args.listing_id] = {name:args.listing_id, amount:null, status:"refused"}; break; }
    case "purchase": { const a = A(e.agent); a.lines[e.listing_id] = {name:e.listing_id, amount:e.amount_usd, status:e.status, mode:e.payment_mode}; break; }
    case "wallet": A(e.agent).wallet = e; break;
    case "approval": if(!S.approvals[e.purchase_id]) S.apOrder.push(e.purchase_id); S.approvals[e.purchase_id] = e; break;
    case "board": S.board.push(e); A(e.agent).posts++; break;
    case "done": { const a = A(e.agent); a.done = e; a.status = e.ok ? "done" : "blocked"; a.step = e.summary; break; }
    case "funnel": S.funnel = e; break;
    case "end": S.end = e; break;
  }
}
const nameOf = id => (S.agents[id] && S.agents[id].card.name) || id;
function receipt(a){
  const w = a.wallet || {cap_usd:0,threshold_usd:0,spent_usd:0,reserved_usd:0,remaining_usd:0};
  const cap = w.cap_usd || 1, pct = v => Math.min(100, 100 * v / cap);
  const lines = Object.values(a.lines);
  const paid = lines.filter(l => l.status === "paid").reduce((s,l) => s + (l.amount||0), 0);
  const tag = {paid:"paid", needs_approval:"asking", declined:"declined", refused:"refused at cap", pending:"pending"};
  return '<article class="receipt'+(a.done?' finished':'')+'"><header><div><h3>'+esc(a.card.name)+'</h3></div><span class="stamp st-'+a.status+'">'+esc(STATUS[a.status]||a.status)+'</span></header>'
    + '<p class="goal">'+esc(a.card.goal)+'</p>'
    + '<div class="step">'+esc(a.step)+'</div>'
    + (a.thought && !a.done ? '<p class="thought">'+esc(a.thought)+'</p>' : '')
    + '<div class="meter"><div class="bar" role="img" aria-label="'+esc(money(w.spent_usd)+' spent of '+money(w.cap_usd))+'"><i style="width:'+pct(w.spent_usd)+'%"></i><i class="res" style="left:'+pct(w.spent_usd)+'%;width:'+pct(w.reserved_usd||0)+'%"></i><u style="left:calc('+pct(w.threshold_usd)+'% - 1px)" title="Approval threshold"></u></div>'
    + '<div class="row"><span>'+money(w.spent_usd)+' spent'+(w.reserved_usd?' · '+money(w.reserved_usd)+' held':'')+'</span><span>cap '+money(w.cap_usd)+' · ask above '+money(w.threshold_usd)+'</span></div></div>'
    + '<ul class="lines">' + (lines.length ? lines.map(l => '<li class="'+l.status+'"><span class="n">'+esc(l.name)+'</span><span class="dots"></span>'+(l.status==="paid"?'':'<em>'+esc(tag[l.status]||l.status)+'</em>')+'<span>'+(l.amount==null?'':money(l.amount))+'</span></li>').join('') + '<li class="total"><span class="n">Paid</span><span class="dots"></span><span>'+money(paid)+'</span></li>' : '<li class="empty">Nothing bought yet</li>') + '</ul>'
    + '<div class="foot"><span>'+a.calls+' tool calls</span><span>'+a.trials+' vendor-funded trials · $0.00 to the human</span>'+(a.posts?'<span>'+a.posts+' board posts</span>':'')+'</div>'
    + (a.done && a.done.blockers.length ? '<div class="verdict"><span class="label">Left for the human</span><ul>'+a.done.blockers.map(b => '<li>'+esc(b)+'</li>').join('')+'</ul></div>' : '')
    + '</article>';
}
function render(){
  const r = S.run;
  $("chips").innerHTML = r ? [
    '<span class="chip">brain: '+esc(r.brain)+'</span>',
    '<span class="chip'+(r.runtime==="simulated"?' sticker':'')+'">trials: '+esc(r.runtime)+'</span>',
    '<span class="chip'+(r.payments==="simulated"?' sticker':'')+'">payments: '+esc(r.payments)+'</span>',
    MODE === "replay" ? '<span class="controls"><button id="play" type="button">Replay run</button><select id="speed" aria-label="Replay speed"><option value="1">1×</option><option value="3" selected>3×</option><option value="10">10×</option></select></span>' : '<span class="chip">'+(S.end?'run finished':'live')+'</span>'
  ].join('') : '';
  if (MODE === "replay" && $("play")) $("play").onclick = play;
  const ag = S.order.map(id => S.agents[id]);
  const aps = S.apOrder.map(id => S.approvals[id]);
  const spent = ag.reduce((s,a) => s + ((a.wallet&&a.wallet.spent_usd)||0), 0), caps = ag.reduce((s,a) => s + ((a.wallet&&a.wallet.cap_usd)||0), 0);
  const trials = ag.reduce((s,a) => s + a.trials, 0);
  const refused = ag.reduce((s,a) => s + Object.values(a.lines).filter(l => l.status === "refused").length, 0);
  const declined = aps.filter(x => x.decision === "declined").length;
  $("tally").innerHTML = [
    [ag.length, 'agents', ag.filter(a => a.done).length+' finished'],
    [S.calls, 'tool calls', 'over MCP, one session per agent'],
    [trials, 'vendor-funded trials', '$0.00 billed to humans'],
    [aps.length, 'approval emails', declined+' declined by a human'],
    [money(spent), 'spent', 'of '+money(caps)+' in human caps'],
    [refused, 'refused at cap', 'enforced by Bodega, not the agent'],
  ].map(([b,l,s]) => '<div><span class="label">'+l+'</span><b>'+esc(b)+'</b><small>'+esc(s)+'</small></div>').join('');
  if (ag.length) $("agents").innerHTML = ag.map(receipt).join('');
  $("ap-count").textContent = aps.length ? aps.length+' asked' : '';
  if (aps.length) $("approvals").innerHTML = aps.slice().reverse().map(x => '<li class="ap"><span class="what"><span class="tag">'+esc(nameOf(x.agent))+'</span>'+esc(x.listing_id)+' · '+money(x.amount_usd)+'</span><span class="dec '+x.decision+'">'+esc(x.decision)+'</span><span class="why">'+esc(x.reason)+'</span></li>').join('');
  $("board-count").textContent = S.board.length ? S.board.length+' posts' : '';
  if (S.board.length) $("board").innerHTML = S.board.slice().reverse().map(n => '<li class="note"><span class="tag">'+esc(nameOf(n.agent))+'</span><span class="topic">'+esc(n.topic)+'</span><div>'+esc(n.note)+'</div></li>').join('');
  const row = e => '<tr><td class="num mono">'+(e.t/1000).toFixed(1)+'</td><td><span class="tag">'+esc(nameOf(e.agent))+'</span></td><td class="mono">'+esc(e.tool)+'</td><td class="sum">'+(e.ok?'':'<span class="bad">refused · </span>')+esc(e.summary)+'</td></tr>';
  const recent = S.tape.slice(-40).reverse();
  $("tape").innerHTML = recent.length ? recent.map(row).join('') : '<tr><td colspan="4" class="empty">Every MCP call the swarm makes lands here.</td></tr>';
  $("tape-count").textContent = S.tape.length ? (S.tape.length > 40 ? 'latest 40 of ' : '') + S.tape.length+' calls' : '';
  $("more").hidden = S.tape.length <= 40;
  if (S.tape.length > 40 && $("more").open) $("tape-all").innerHTML = S.tape.slice().reverse().map(row).join('');
  if (S.funnel){
    const rows = [];
    for (const v of S.funnel.vendors) for (const l of v.listings) if (l.trials || l.purchases || l.chosen || l.rejected) rows.push(l);
    rows.sort((a,b) => b.revenue_usd - a.revenue_usd || b.trials - a.trials);
    $("funnel").innerHTML = rows.length ? rows.map(l => '<tr><td class="mono">'+esc(l.listing_id)+'</td><td class="num mono">'+l.trials+'</td><td class="num mono">'+l.checks_passed+'/'+l.checks_run+'</td><td class="num mono">'+l.chosen+'</td><td class="num mono">'+l.rejected+'</td><td class="num mono">'+l.purchases+'</td><td class="num mono">'+money(l.revenue_usd)+'</td><td class="reasons">'+l.top_reasons.slice(0,3).map(x => '<q>'+esc(x)+'</q>').join('<br>')+'</td></tr>').join('') : '<tr><td colspan="8" class="empty">No vendor activity recorded.</td></tr>';
  }
  $("footer").innerHTML = r ? '<span>Run <code>'+esc(r.run_id)+'</code> against <code>'+esc(r.bodega_url)+'</code>'+(S.end?' · finished in '+(S.end.duration_ms/1000).toFixed(1)+' s':'')+'.</span><span>'+(r.runtime==="simulated"?'Trials ran on Bodega\\'s simulated runtime: commands are accepted but not executed, and comparisons are labeled, never ranked. ':'')+(r.payments==="simulated"?'Payments are simulated receipts; no card was charged. ':'')+'Approval links, project keys and trial tokens are redacted from this log.</span><span>Run it yourself: <code>cd experiments/bodega/swarm && npm run swarm</code></span>' : '';
}
let raf = 0; const schedule = () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; render(); }); };
document.addEventListener("toggle", e => { if (e.target.id === "more") render(); }, true);
const embedded = JSON.parse($("swarm-events").textContent || "[]");
let timers = [];
function play(){
  timers.forEach(clearTimeout); timers = [];
  const speed = Number(($("speed")||{}).value || 3);
  reset(); $("agents").innerHTML = ''; $("floor").classList.add("live");
  const span = 30;
  embedded.forEach(e => timers.push(setTimeout(() => { apply(e); schedule(); if (e.kind === "end") $("floor").classList.remove("live"); }, e.t / speed + span)));
}
reset();
if (MODE === "replay"){ embedded.forEach(apply); render(); }
else {
  render();
  const es = new EventSource("events");
  es.onmessage = m => { apply(JSON.parse(m.data)); schedule(); };
  es.addEventListener("end", () => { es.close(); $("floor").classList.remove("live"); schedule(); });
}
})();
</script>`;
  if (opts.fragment) return `${head}\n${body}`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">\n${head}\n</head><body>\n${body}\n</body></html>`;
}
