import type { Listing, Vendor, VendorFunnel, ListingFunnel } from "../contracts/index.js";

const esc = (v: unknown) =>
  String(v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => `$${n.toFixed(2)}`;

/** Shared page shell for the back office and approval pages: same paper, ink and mono as the storefront. */
export function shell(title: string, body: string, nonce: string, options: { lede?: string } = {}): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)} · Bodega</title><style nonce="${nonce}">
:root{--paper:#f1ece1;--paper-2:#faf7f0;--ink:#161513;--ink-2:#4a463f;--mute:#8a847a;--rule:#161513;--red:#d1331b;--yellow:#f7d64a;--mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;--sans:-apple-system,BlinkMacSystemFont,"Helvetica Neue",Inter,Arial,sans-serif}
*{box-sizing:border-box}
html{background:var(--paper)}
body{margin:0;color:var(--ink);font:15px/1.5 var(--sans);background:var(--paper)}
a{color:inherit}
.wrap{max-width:1180px;margin:auto;padding:0 24px 60px}
.bar{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 0;border-bottom:2px solid var(--rule)}
.brand{font-weight:900;font-size:26px;letter-spacing:-1.5px;text-decoration:none}
.brand i{font-style:normal;color:var(--red)}
nav{display:flex;gap:22px;font:13px var(--mono);text-transform:uppercase;letter-spacing:1px}
nav a{text-decoration:none;border-bottom:2px solid transparent;padding-bottom:2px}nav a.on{border-color:var(--ink)}
.kicker{font:12px var(--mono);letter-spacing:2px;text-transform:uppercase;color:var(--ink-2);margin:40px 0 10px}
h1{font-size:clamp(38px,6vw,72px);line-height:.95;letter-spacing:-3px;margin:0 0 14px;font-weight:900;text-transform:uppercase}
.lede{font:14px/1.6 var(--mono);color:var(--ink-2);margin:0 0 30px;max-width:760px}
/* ledger sheets */
section.vendor{background:var(--paper-2);border:2px solid var(--ink);margin:0 0 18px}
.vhead{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:12px 18px;border-bottom:2px solid var(--ink);background:#fff}
.vhead h2{font-size:22px;letter-spacing:-.6px;margin:0;font-weight:900;text-transform:uppercase}
.vhead a{font:12px var(--mono);color:var(--mute);text-decoration:none;margin-left:12px}
.stamp{font:12px var(--mono);font-weight:700;letter-spacing:2px;text-transform:uppercase;border:2px solid currentColor;padding:3px 9px;transform:rotate(-4deg);white-space:nowrap}
.stamp-win{color:var(--red)}
.stamp-lose{color:var(--ink);border-style:double}
.stamp-open{color:var(--ink-2)}
.stamp-idle{color:var(--mute);border-style:dashed}
.listing{padding:16px 18px 18px;border-top:1px dashed #b9b2a3}
.listing:first-of-type{border-top:0}
.lmeta{display:flex;flex-wrap:wrap;gap:6px 16px;align-items:center;font:12px var(--mono);color:var(--ink-2);margin-bottom:12px;text-transform:uppercase;letter-spacing:.5px}
.lmeta code{font-weight:700;color:var(--ink)}
.pill{border:2px solid currentColor;padding:0 6px;font-weight:700;letter-spacing:1.5px}
.pill-real{color:var(--red)}
.funnel{display:grid;grid-template-columns:repeat(5,1fr);border:2px solid var(--ink);background:#fff}
.step{padding:12px 14px;border-right:2px solid var(--ink)}
.step:last-child{border-right:0}
.step b{display:block;font:700 30px/1 var(--mono);letter-spacing:-1.5px}
.step b small{font-size:14px;color:var(--mute);font-weight:500;letter-spacing:0}
.step span{display:block;font:11px var(--mono);color:var(--ink-2);text-transform:uppercase;letter-spacing:1px;margin-top:6px}
.step.hot b{color:var(--red)}
@media(max-width:760px){.funnel{grid-template-columns:repeat(2,1fr)}.step{border-bottom:2px solid var(--ink)}}
.reasons{margin:14px 0 4px}
.reasons .label{font:11px var(--mono);text-transform:uppercase;letter-spacing:2px;color:var(--ink-2)}
.reasons blockquote{margin:6px 0 0;padding:6px 12px;border-left:3px solid var(--ink);font:13px/1.6 var(--mono);color:var(--ink)}
.empty{font:12px var(--mono);color:var(--mute);margin:4px 0 0;text-transform:uppercase;letter-spacing:1px}
section.idle{border-style:dashed;background:transparent}
section.idle .vhead{background:transparent;border-bottom:0}
.idle-list{display:flex;flex-wrap:wrap;gap:8px 22px;font:12px var(--mono);color:var(--ink-2);padding:0 18px 16px}
.idle-list strong{color:var(--ink)}
details.admin{margin-top:28px;border:2px dashed #b9b2a3;padding:12px 18px;font:13px var(--mono);color:var(--ink-2)}
details.admin summary{cursor:pointer;font-weight:700;color:var(--ink);text-transform:uppercase;letter-spacing:1px}
details.admin section{background:transparent;border:0;padding:12px 0 0;margin:0}
label{display:block;font:12px var(--mono);margin:10px 0 2px;text-transform:uppercase;letter-spacing:1px}
input,textarea{display:block;padding:10px;width:100%;margin:4px 0 8px;border:2px solid var(--ink);font:13px var(--mono);background:#fff}
textarea{min-height:200px}
button{background:var(--ink);color:var(--paper);border:0;padding:11px 18px;font:700 12px var(--mono);letter-spacing:2px;text-transform:uppercase;cursor:pointer}
button.reject{background:var(--red)}
.card{background:#fff;border:2px solid var(--ink);padding:22px 24px;max-width:640px;font:14px/1.7 var(--mono)}
code{font:13px var(--mono);overflow-wrap:anywhere}
pre{background:#fff;border:2px solid var(--ink);padding:14px 16px;overflow:auto;font:12px/1.5 var(--mono)}
small{color:var(--mute)}
</style></head><body><div class="wrap">
<div class="bar"><a class="brand" href="/">bodega<i>.</i></a><nav><a href="/">Storefront</a><a class="on" href="/portal">Back office</a><a href="/llms.txt">Agent docs ↗</a></nav></div>
<p class="kicker">Back office · vendor ledger</p>
<h1>${esc(title)}</h1>${options.lede ? `<p class="lede">${esc(options.lede)}</p>` : ""}${body}</div></body></html>`;
}

function verdict(f: ListingFunnel[]): { cls: string; text: string } {
  const t = f.reduce((a, l) => ({ trials: a.trials + l.trials, chosen: a.chosen + l.chosen, rejected: a.rejected + l.rejected, purchases: a.purchases + l.purchases }), { trials: 0, chosen: 0, rejected: 0, purchases: 0 });
  if (t.purchases > 0) return { cls: "stamp-win", text: `Sold ×${t.purchases}` };
  if (t.chosen > 0 && t.chosen >= t.rejected) return { cls: "stamp-win", text: `Chosen ${t.chosen} · rejected ${t.rejected}` };
  if (t.rejected > t.chosen) return { cls: "stamp-lose", text: `Rejected ${t.rejected} · chosen ${t.chosen}` };
  if (t.trials > 0) return { cls: "stamp-open", text: `${t.trials} trial${t.trials === 1 ? "" : "s"} · no verdict` };
  return { cls: "stamp-idle", text: "No trials yet" };
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
    ? `<section class="vendor idle"><div class="vhead"><h2>${idle.length} more vendor${idle.length === 1 ? "" : "s"}, no trials yet</h2><span class="stamp stamp-idle">Simulated</span></div><div class="idle-list">${idle
        .map(({ vendor, funnel }) => `<span><strong>${esc(vendor.name.replace(/ \(mock\)$/, ""))}</strong> · ${funnel.listings.map((l) => `<code>${esc(l.listing_id)}</code>`).join(", ")}</span>`)
        .join("")}</div></section>`
    : "";
  return (
    live
      .map(({ vendor, funnel }) => {
        const v = verdict(funnel.listings);
        const site = vendor.website.replace(/^https?:\/\//, "").replace(/\/$/, "");
        const body = funnel.listings
          .map((l) => {
            const li = byId.get(l.listing_id);
            const meta = li
              ? `<code>${esc(l.listing_id)}</code><span>${money(li.price.buy_usd)} / ${esc(li.price.unit_label)}</span>${li.trial ? `<span>trial ${li.trial.per_agent} ${esc(li.trial.unit).replace("_", " ")} · vendor pays</span>` : `<span>buy only</span>`}<span class="pill ${li.real ? "pill-real" : ""}">${li.real ? "Real" : "Mock"}</span>`
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
        return `<section class="vendor"><div class="vhead"><div><h2>${esc(vendor.name)}</h2><a href="${esc(vendor.website)}" rel="noreferrer">${esc(site)}</a></div><span class="stamp ${v.cls}">${esc(v.text)}</span></div>${body}</section>`;
      })
      .join("") + idleStrip
  );
}
