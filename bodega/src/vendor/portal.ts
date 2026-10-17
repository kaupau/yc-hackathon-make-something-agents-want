import type { Listing, Vendor, VendorFunnel, ListingFunnel } from "../contracts/index.js";

const esc = (v: unknown) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => `$${n.toFixed(2)}`;

/** Shared page shell for the portal and approval pages: same header, palette and type as the storefront home. */
export function shell(title: string, body: string, nonce: string, options: { lede?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · Bodega</title><style nonce="${nonce}">
*{box-sizing:border-box}
body{margin:0;background:#f7f5ed;color:#252c25;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
a{color:inherit}
header,main{max-width:1160px;margin:auto;padding:0 24px}
header{display:flex;align-items:center;justify-content:space-between;padding:22px 24px;border-bottom:1px solid #d8dccf}
.brand{font-size:25px;font-weight:800;letter-spacing:-1px;text-decoration:none}
nav{display:flex;gap:24px}nav a{text-decoration:none}nav a.on{border-bottom:2px solid #39754a}
main{padding-top:40px;padding-bottom:60px}
h1{font-size:clamp(32px,5vw,48px);letter-spacing:-1.8px;line-height:1.05;margin:0 0 8px}
.lede{color:#5c665d;font-size:16px;margin:0 0 28px;max-width:720px}
section.vendor{background:#fffefa;border:1px solid #dedfd5;border-radius:14px;padding:22px 24px;margin:0 0 16px}
.vhead{display:flex;justify-content:space-between;align-items:flex-start;gap:16px;margin-bottom:6px}
.vhead h2{font-size:22px;letter-spacing:-.5px;margin:0}
.vhead a{font-size:13px;color:#6c7567;text-decoration:none}
.chip{font-size:12px;border-radius:20px;padding:5px 11px;white-space:nowrap;border:1px solid #d4dccb;color:#6c7567;font-weight:600}
.chip-win{background:#294e35;border-color:#294e35;color:#fff}
.chip-lose{background:#f3e4e1;border-color:#e2c3bd;color:#8a3a30}
.chip-open{background:#eef2e6;border-color:#d6dfca;color:#39754a}
.listing{border-top:1px solid #ebede4;padding:16px 0 4px;margin-top:10px}
.lmeta{display:flex;flex-wrap:wrap;gap:8px 14px;align-items:center;font-size:13px;color:#67715f;margin-bottom:14px}
.lmeta code{font:600 12px ui-monospace,SFMono-Regular,Menlo,monospace;color:#252c25}
.pill{font-size:11px;border:1px solid #d4dccb;border-radius:20px;padding:2px 8px;color:#6c7567}
.pill-real{background:#294e35;border-color:#294e35;color:#fff}
.funnel{display:grid;grid-template-columns:repeat(5,1fr);gap:0;border:1px solid #e3e5da;border-radius:10px;overflow:hidden;background:#fbfaf5}
.step{padding:14px 16px;border-right:1px solid #e3e5da}
.step:last-child{border-right:0}
.step b{display:block;font-size:26px;letter-spacing:-1px;line-height:1.1;font-weight:700}
.step b small{font-size:14px;color:#8a9484;font-weight:500;letter-spacing:0}
.step span{display:block;font-size:11px;color:#6c7567;text-transform:uppercase;letter-spacing:1px;margin-top:4px}
.step.hot b{color:#39754a}
@media(max-width:760px){.funnel{grid-template-columns:repeat(2,1fr)}.step{border-bottom:1px solid #e3e5da}}
.reasons{margin:14px 0 6px}
.reasons .label{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6c7567}
.reasons blockquote{margin:6px 0 0;padding:8px 14px;border-left:3px solid #c9d3bf;color:#3c463d;font-size:14px;background:#f7f8f2;border-radius:0 8px 8px 0}
.empty{color:#8a9484;font-size:13px;margin:6px 0 0}
section.idle{background:transparent;border-style:dashed}
.idle-list{display:flex;flex-wrap:wrap;gap:8px 22px;font-size:13px;color:#5c665d;margin-top:8px}
.idle-list strong{color:#252c25;font-weight:600}
details.admin{margin-top:28px;border:1px dashed #cfd4c6;border-radius:12px;padding:14px 20px;color:#5c665d}
details.admin summary{cursor:pointer;font-weight:600;color:#252c25}
details.admin section{background:transparent;border:0;padding:12px 0 0;margin:0}
label{display:block;font-size:13px;margin:10px 0 2px;color:#4b544c}
input,textarea{display:block;padding:10px;width:100%;margin:4px 0 8px;border:1px solid #cfd4c6;border-radius:6px;font:14px ui-monospace,SFMono-Regular,Menlo,monospace;background:#fff}
textarea{min-height:200px}
button{background:#294e35;color:#fff;border:0;padding:11px 18px;border-radius:8px;cursor:pointer;font-weight:600}
button.reject{background:#9e352d}
.card{background:#fffefa;border:1px solid #dedfd5;border-radius:14px;padding:22px 24px;max-width:640px}
code{font:13px ui-monospace,SFMono-Regular,Menlo,monospace;overflow-wrap:anywhere}
pre{background:#1f2a21;color:#e8efe3;padding:14px 16px;border-radius:10px;overflow:auto;font:12px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace}
small{color:#6c7567}
</style></head><body>
<header><a class="brand" href="/">bodega<span style="color:#57924c">.</span></a><nav><a href="/">Storefront</a><a class="on" href="/portal">Vendor portal</a><a href="/llms.txt">Agent docs ↗</a></nav></header>
<main><h1>${esc(title)}</h1>${options.lede ? `<p class="lede">${esc(options.lede)}</p>` : ""}${body}</main></body></html>`;
}

function verdict(f: ListingFunnel[]): { cls: string; text: string } {
  const t = f.reduce((a, l) => ({ trials: a.trials + l.trials, chosen: a.chosen + l.chosen, rejected: a.rejected + l.rejected, purchases: a.purchases + l.purchases }), { trials: 0, chosen: 0, rejected: 0, purchases: 0 });
  if (t.purchases > 0) return { cls: "chip-win", text: `Bought ${t.purchases}×` };
  if (t.chosen > 0 && t.chosen >= t.rejected) return { cls: "chip-win", text: `Winning · chosen ${t.chosen}, rejected ${t.rejected}` };
  if (t.rejected > t.chosen) return { cls: "chip-lose", text: `Losing · rejected ${t.rejected}, chosen ${t.chosen}` };
  if (t.trials > 0) return { cls: "chip-open", text: `${t.trials} trial${t.trials === 1 ? "" : "s"}, no verdict yet` };
  return { cls: "", text: "No trials yet" };
}

export function vendorCards(rows: Array<{ vendor: Vendor; funnel: VendorFunnel }>, listings: Listing[]): string {
  const byId = new Map(listings.map((l) => [l.id, l]));
  const active = rows.filter((r) => r.funnel.listings.length);
  const activity = (r: { funnel: VendorFunnel }) => r.funnel.listings.reduce((a, l) => a + l.trials + l.purchases * 10, 0);
  const isReal = (r: { funnel: VendorFunnel }) => r.funnel.listings.some((l) => byId.get(l.listing_id)?.real);
  active.sort((a, b) => activity(b) - activity(a) || Number(isReal(b)) - Number(isReal(a)));
  const live = active.filter((r) => activity(r) > 0 || isReal(r));
  const idle = active.filter((r) => !live.includes(r));
  const idleStrip = idle.length
    ? `<section class="vendor idle"><div class="vhead"><div><h2>${idle.length} more vendor${idle.length === 1 ? "" : "s"}, no trials yet</h2><a>Simulated catalog entries: they appear here as soon as an agent starts a trial.</a></div></div><div class="idle-list">${idle
        .map(({ vendor, funnel }) => `<span><strong>${esc(vendor.name.replace(/ \(mock\)$/, ""))}</strong> · ${funnel.listings.map((l) => `<code>${esc(l.listing_id)}</code>`).join(", ")}</span>`)
        .join("")}</div></section>`
    : "";
  return live
    .map(({ vendor, funnel }) => {
      const v = verdict(funnel.listings);
      const site = vendor.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
      const body = funnel.listings
        .map((l) => {
          const li = byId.get(l.listing_id);
          const meta = li
            ? `<code>${esc(l.listing_id)}</code><span>${money(li.price.buy_usd)} / ${esc(li.price.unit_label)}</span>${li.trial ? `<span>trial: ${li.trial.per_agent} ${esc(li.trial.unit).replace("_", " ")}, vendor-funded</span>` : `<span>buy-only</span>`}<span class="pill ${li.real ? "pill-real" : ""}">${li.real ? "Real provider" : "Simulated"}</span>`
            : `<code>${esc(l.listing_id)}</code>`;
          const reasons = l.top_reasons.filter(Boolean).slice(0, 3);
          return `<div class="listing"><div class="lmeta">${meta}</div>
<div class="funnel">
  <div class="step${l.trials ? " hot" : ""}"><b>${l.trials}</b><span>trials</span></div>
  <div class="step${l.checks_passed ? " hot" : ""}"><b>${l.checks_passed}<small>/${l.checks_run}</small></b><span>checks passed</span></div>
  <div class="step${l.chosen ? " hot" : ""}"><b>${l.chosen}<small> / ${l.rejected}</small></b><span>chosen / rejected</span></div>
  <div class="step${l.purchases ? " hot" : ""}"><b>${l.purchases}</b><span>purchases</span></div>
  <div class="step${l.revenue_usd ? " hot" : ""}"><b>${money(l.revenue_usd)}</b><span>revenue</span></div>
</div>
${reasons.length ? `<div class="reasons"><span class="label">What agents said</span>${reasons.map((r) => `<blockquote>${esc(r)}</blockquote>`).join("")}</div>` : `<p class="empty">No agent has compared this listing yet.</p>`}
</div>`;
        })
        .join("");
      return `<section class="vendor"><div class="vhead"><div><h2>${esc(vendor.name)}</h2><a href="${esc(vendor.website)}" rel="noreferrer">${esc(site)}</a></div><span class="chip ${v.cls}">${esc(v.text)}</span></div>${body}</section>`;
    })
    .join("") + idleStrip;
}
