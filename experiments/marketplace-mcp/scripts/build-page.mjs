import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import sharp from "sharp";
const dir = ".cache/usecases"; const files = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => `${dir}/${f}`).concat([".cache/flip_arc2.json"]);
const markets = [];
for (const f of files) { const raw = readFileSync(f, "utf8").trim(); if (!raw) continue; let d; try { d = JSON.parse(raw); } catch { continue; } const res = d.result; if (!res || res.isError) continue; markets.push(res.structuredContent); }
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n) => n == null ? "—" : "$" + Math.round(n).toLocaleString("en-US");
const pc = (n) => n == null ? "—" : Math.round(n * 100);
const REASON = { read_description: "the title asks you to read the description", damage_or_wear: "wear or damage is mentioned", parts_or_incomplete: "it may be parts only or incomplete", replica_or_authenticity: "authenticity is in doubt", size_or_variant: "it may be a different size or variant", none: "nothing flagged" };
function verdict(o) { const c = o.catch_risk ?? 0, p = o.photo_match, r = o.relevance ?? 1, why = REASON[o.catch_reason ?? "none"];
  if (o.suspected_replica) return { tone: "bad", text: `Suspected replica (${pc(o.replica_risk)}%): priced at ${o.reference_usd ? Math.round(((o.listing.usd ?? 0) / o.reference_usd) * 100) : "?"}% of what it sells for${o.catch_reason === "replica_or_authenticity" ? ", wording looks off" : ""}. Not recommended.` };
  if (c >= 0.6) return { tone: "bad", text: `Likely a catch: ${why}.` };
  if (r < 0.8) return { tone: "warn", text: "Check first: might not be the exact model." };
  if (p != null && p < 0.5) return { tone: "warn", text: `Check first: photos only ${pc(p)}% match the ${o.counterpart?.marketplace ?? "comparable"} ${o.counterpart?.sold ? "sale" : "listing"}.` };
  if (c >= 0.3 && (o.catch_reason ?? "none") !== "none") return { tone: "warn", text: `Check first: ${why}.` };
  return { tone: "ok", text: p != null ? `Looks clean: photos match a ${o.counterpart?.marketplace ?? "comparable"} ${o.counterpart?.sold ? "sale" : "listing"} (${pc(p)}%).` : "Looks clean: nothing flagged in the listing." }; }
// embed photos of opportunity listings (external images are blocked inside artifacts)
const cache = new Map();
async function photo(url) { if (!url) return null; if (cache.has(url)) return cache.get(url); try { const u = url.replace(/\._AC_[A-Z0-9_,]+_\.jpg$/, "._AC_SL500_.jpg"); const r = await fetch(u, { headers: { accept: "image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.1" } }); if (!r.ok) throw 0; const buf = Buffer.from(await r.arrayBuffer()); const out = await sharp(buf).rotate().resize({ width: 240, height: 240, fit: "cover" }).jpeg({ quality: 72 }).toBuffer(); const v = `data:image/jpeg;base64,${out.toString("base64")}`; cache.set(url, v); return v; } catch { cache.set(url, null); return null; } }
for (const m of markets) for (const o of m.opportunities) o._img = await photo(o.listing.img);
// summary rows
const rows = markets.map((m) => { const opps = m.opportunities; const clean = opps.filter((o) => !o.suspected_replica && (o.catch_risk ?? 0) < 0.6); const reps = opps.filter((o) => o.suspected_replica).length; const catches = opps.filter((o) => !o.suspected_replica && (o.catch_risk ?? 0) >= 0.6).length;
  let verdictLabel, tone; if (clean.length) { verdictLabel = clean[0].net_profit_usd >= 50 ? "Worth working" : "Thin"; tone = clean[0].net_profit_usd >= 50 ? "ok" : "warn"; } else if (opps.length) { verdictLabel = "Only suspect deals"; tone = "bad"; } else if (m.reference.sold_comps < 3) { verdictLabel = "No sell side"; tone = "dim"; } else if (m.reference.sold_comps >= 20) { verdictLabel = "Efficient market"; tone = "dim"; } else { verdictLabel = "No flip found"; tone = "dim"; }
  return { m, clean, reps, catches, verdictLabel, tone, best: clean[0] ?? null }; });
const order = { ok: 0, warn: 1, bad: 2, dim: 3 }; rows.sort((a, b) => order[a.tone] - order[b.tone] || (b.best?.net_profit_usd ?? 0) - (a.best?.net_profit_usd ?? 0));
const slug = (q) => q.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
function priceMap(m) { const srcs = (m.sources ?? []).filter((s) => s.usd != null && s.usd > 0); if (!srcs.length) return ""; const sorted = srcs.map((s) => s.usd).sort((a, b) => a - b); const lo = sorted[0], hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))]; if (hi <= lo) return "";
  const med = (mk) => { const xs = srcs.filter((s) => s.m === mk).map((s) => s.usd).sort((a, b) => a - b); return xs[Math.floor(xs.length / 2)]; }; const mks = [...new Set(srcs.map((s) => s.m))].sort((a, b) => med(a) - med(b));
  const W = 640, L = 90, R = 16, rowH = 22, H = mks.length * rowH + 30; const x = (v) => L + ((Math.log(Math.max(v, lo)) - Math.log(lo)) / (Math.log(hi) - Math.log(lo))) * (W - L - R); const ref = m.opportunities[0]?.sell_est_usd ?? m.reference.sold_median_usd;
  let g = ""; mks.forEach((mk, i) => { g += `<g transform="translate(0 ${i * rowH + 14})"><text x="0" y="4" class="ml">${esc(mk)}</text><line x1="${L}" x2="${W - R}" y1="0" y2="0" class="rail"/>`; for (const s of srcs.filter((s) => s.m === mk)) g += `<circle cx="${x(s.usd).toFixed(1)}" cy="0" r="${s.sold ? 3 : 3.5}" class="${s.sold ? "sold" : "live"}"><title>${esc((s.sold ? "sold " : "") + usd(s.usd) + " · " + s.title)}</title></circle>`; g += `</g>`; });
  if (ref != null && ref >= lo && ref <= hi) g += `<line x1="${x(ref).toFixed(1)}" x2="${x(ref).toFixed(1)}" y1="4" y2="${mks.length * rowH + 6}" class="refl"/><text x="${x(ref).toFixed(1)}" y="${mks.length * rowH + 20}" text-anchor="middle" class="reft">sells for ${usd(ref)}</text>`;
  g += `<text x="${L}" y="${mks.length * rowH + 20}" class="ax">${usd(lo)}</text><text x="${W - R}" y="${mks.length * rowH + 20}" text-anchor="end" class="ax">${usd(hi)}</text>`;
  return `<svg class="map" viewBox="0 0 ${W} ${H}" role="img" aria-label="price by marketplace">${g}</svg><p class="legend"><span class="dot live"></span> live listing <span class="dot sold"></span> sold</p>`; }
function card(o) { const v = verdict(o); const l = o.listing; return `<article class="card ${v.tone}">
  <div class="ph">${o._img ? `<img src="${o._img}" alt="">` : `<span>${esc(l.m)}</span>`}</div>
  <div class="body">
    <div class="pricerow"><span class="price">${usd(l.usd)}</span><span class="ref">buy on ${esc(l.m)}${l.ship ? ` + ${usd(l.ship)} shipping` : ""}${(l.offer ? " · accepts offers" : "")}</span></div>
    <p class="profit"><span>sells for <b>${usd(o.sell_est_usd ?? o.reference_usd)}</b> on ${esc(o.comps_venue ?? "resale")} (${o.comps_n ?? 0} sold${o.comps_tier && o.comps_tier !== "any" ? ", " + esc(String(o.comps_tier).replace("_", " ")) : ""})</span><span>fees ${pc(o.fee_pct ?? 0)}%${o.ship_assumed ? ` · ~${usd(o.ship_usd)} shipping assumed` : ""}</span><span class="net">net ${usd(o.net_profit_usd)} · ${pc(o.margin_pct)}% margin${o.net_if_offer_usd != null ? ` (${usd(o.net_if_offer_usd)} if a 10% offer lands)` : ""}</span>${o.demand_label ? `<span class="demand ${o.demand_label.replace(" ", "-")}">${esc(o.demand_label)}</span>` : ""}</p>
    <a class="title" href="${esc(l.url)}" target="_blank" rel="noopener">${esc(l.title)}</a>
    <p class="verdict ${v.tone}">${esc(v.text)}</p>
    <p class="meta"><span class="pill">${esc(l.m)}</span>${l.cond ? `<span>${esc(l.cond)}</span>` : ""}${l.size ? `<span>size ${esc(l.size)}</span>` : ""}${o.counterpart ? `<a href="${esc(o.counterpart.url)}" target="_blank" rel="noopener">photo compared with a ${esc(o.counterpart.marketplace)} ${o.counterpart.sold ? "sale" : "listing"} at ${usd(o.counterpart.price_usd)}</a>` : ""}</p>
    ${Array.isArray(o.comp_sample) && o.comp_sample.length ? `<p class="comps">based on ${esc(o.comp_basis ?? "")}: ${o.comp_sample.map((c) => `<a href="${esc(c.url)}" target="_blank" rel="noopener">${usd(c.usd)}${c.size ? ` (${esc(c.size)})` : ""}</a>`).join(" ")}</p>` : ""}
  </div></article>`; }
const summary = `<table class="sum"><thead><tr><th>Market</th><th>Live</th><th>Sold comps</th><th>Best clean flip</th><th>Verdict</th><th>Filtered out</th></tr></thead><tbody>${rows.map(({ m, best, reps, catches, verdictLabel, tone }) => `<tr><td><a href="#${slug(m.query)}">${esc(m.query)}</a></td><td>${m.considered}</td><td>${m.reference.sold_comps}${(m.reference.sold_venues ?? []).length ? ` <small>${esc(m.reference.sold_venues.join(" + "))}</small>` : ""}</td><td>${best ? `buy ${esc(best.listing.m)} ${usd(best.listing.usd)} → ~${usd(best.sell_est_usd)} on ${esc(best.comps_venue)} (${best.comps_n} sold) → <b>net ${usd(best.net_profit_usd)}</b> (${pc(best.margin_pct)}%)` : "none"}</td><td><span class="chip ${tone}">${verdictLabel}</span></td><td>${reps || catches ? `${reps} replica-suspect, ${catches} catch` : "—"}</td></tr>`).join("")}</tbody></table>`;
const sections = rows.map(({ m, clean, verdictLabel, tone }) => { const ref = m.opportunities[0]?.sell_est_usd ?? m.reference.sold_median_usd; const flagged = m.opportunities.filter((o) => !clean.includes(o));
  return `<section id="${slug(m.query)}" class="market">
  <p class="eyebrow">${esc(m.query)} <span class="chip ${tone}">${verdictLabel}</span></p>
  <p class="lead">${m.reference.sold_comps > 0 ? `Sells for about <b>${usd(ref)}</b> (${m.reference.sold_comps} sold on ${esc((m.reference.sold_venues ?? []).join(" and ") || "resale sites")}). ` : "No sold listings found, so there is no reliable sell price. "}${clean[0] ? `Best clean flip: buy at <b>${usd(clean[0].listing.usd)}</b> on ${esc(clean[0].listing.m)}, about <b>${usd(clean[0].net_profit_usd)}</b> net after fees.` : m.opportunities.length ? "Every candidate has something to check first." : "No listing clears a margin after fees."} <span class="dim">${m.considered} live listings, ${m.kept_after_relevance} judged the right product.</span></p>
  ${priceMap(m)}
  ${clean.length ? `<h3>Deals</h3><div class="cards">${clean.map(card).join("")}</div>` : ""}
  ${flagged.length ? `<h3>Filtered out</h3><div class="cards">${flagged.map(card).join("")}</div>` : ""}
  ${m.errors?.length ? `<p class="foot"><span class="eyebrow">skipped</span> ${esc(m.errors.join(" · "))}</p>` : ""}
</section>`; }).join("\n");
const html = `<title>Flip Finder Sweep</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
<style>
/* layout: one reading column, summary table first, then one section per market with price map + cards */
:root { --bg:#f5f0e8; --fg:#1a1a1a; --fg-muted:#6b6358; --fg-dim:#8a8078; --divider:rgba(0,0,0,0.1); --accent:#16a34a; --warn:#b45309; --bad:#b91c1c; --card:rgba(255,255,255,0.35);
  --sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#08080a; --fg:#e5e5e5; --fg-muted:#999; --fg-dim:#666; --divider:rgba(255,255,255,0.12); --accent:#6ee7b7; --warn:#fbbf24; --bad:#f87171; --card:rgba(255,255,255,0.03); color-scheme:dark } }
:root[data-theme="dark"] { --bg:#08080a; --fg:#e5e5e5; --fg-muted:#999; --fg-dim:#666; --divider:rgba(255,255,255,0.12); --accent:#6ee7b7; --warn:#fbbf24; --bad:#f87171; --card:rgba(255,255,255,0.03); color-scheme:dark }
body { background:var(--bg); color:var(--fg); font-family:var(--sans); font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased; font-variant-numeric:tabular-nums; }
.wrap { max-width: 860px; margin: 0 auto; padding-block: 32px 60px; padding-inline: 20px; }
h1 { font-size: 30px; font-weight: 500; letter-spacing: -0.03em; line-height: 1.2; margin: 0 0 8px; text-wrap: balance; }
h2 { font-size: 20px; font-weight: 500; letter-spacing: -0.02em; margin: 40px 0 10px; }
h3 { font-size: 12px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fg-dim); margin: 18px 0 6px; }
.sub { color: var(--fg-muted); margin: 0 0 20px; max-width: 62ch; }
.eyebrow { font-size: 12px; font-weight: 500; letter-spacing: 0.12em; text-transform: uppercase; color: var(--fg-dim); margin: 0 0 8px; display:flex; gap:10px; align-items:center; flex-wrap:wrap; }
.chip { display:inline-block; font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; border:1px solid var(--divider); border-radius: 999px; padding: 2px 9px; color: var(--fg-muted); white-space:nowrap; }
.chip.ok { color: var(--accent); border-color: currentColor } .chip.warn { color: var(--warn); border-color: currentColor } .chip.bad { color: var(--bad); border-color: currentColor } .chip.dim { color: var(--fg-dim) }
.tablewrap { overflow-x:auto; border-top:1px solid var(--divider); border-bottom:1px solid var(--divider); }
.sum { width:100%; border-collapse:collapse; font-size: 13.5px; min-width: 720px; }
.sum th { text-align:left; font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; color: var(--fg-dim); font-weight: 500; padding: 10px 8px 8px 0; border-bottom: 1px solid var(--divider); }
.sum td { padding: 9px 8px 9px 0; border-bottom: 1px solid var(--divider); vertical-align: top; }
.sum tr:last-child td { border-bottom: 0 }
.sum td a { color: var(--fg); text-decoration: none; border-bottom: 1px solid var(--divider); font-weight: 500; }
.sum small { color: var(--fg-dim); }
.market { border-top: 1px solid var(--divider); padding-top: 24px; margin-top: 36px; }
.lead { margin: 0 0 12px; max-width: 70ch; }
.dim { color: var(--fg-dim); }
.map { width:100%; height:auto; display:block; margin: 6px 0 2px; }
.ml { font-family: var(--sans); font-size: 12px; fill: var(--fg-muted); } .rail { stroke: var(--divider); stroke-width:1 } .live { fill: var(--bg); stroke: var(--fg); stroke-width: 1.2; opacity: 0.85 } .sold { fill: var(--accent); } .refl { stroke: var(--accent); stroke-dasharray: 2 3; } .reft { font-family: var(--sans); font-size: 11px; fill: var(--accent); } .ax { font-family: var(--sans); font-size: 11px; fill: var(--fg-dim); }
.legend { font-size: 12px; color: var(--fg-dim); margin: 0 0 8px; display:flex; gap:14px; align-items:center } .dot { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:5px; vertical-align:middle } .dot.live { border:1px solid var(--fg); background: var(--bg) } .dot.sold { background: var(--accent) }
.cards { display:grid; gap:0; }
.card { display:grid; grid-template-columns: 112px 1fr; gap: 16px; padding: 16px 0; border-top: 1px solid var(--divider); }
.card:last-child { border-bottom: 1px solid var(--divider); }
.ph { width:112px; height:112px; border-radius: 6px; overflow:hidden; border:1px solid var(--divider); display:grid; place-items:center; color: var(--fg-dim); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; background: var(--card); }
.ph img { width:100%; height:100%; object-fit: cover; display:block }
.body { min-width: 0 }
.pricerow { display:flex; align-items:baseline; gap: 10px; flex-wrap: wrap }
.price { font-size: 24px; font-weight: 600; letter-spacing: -0.02em } .ref { font-size: 13px; color: var(--fg-muted) }
.profit { display:flex; flex-wrap:wrap; gap: 4px 14px; align-items: baseline; margin: 2px 0 6px; font-size: 13.5px; color: var(--fg-muted) } .profit b { color: var(--fg); font-weight: 600 } .profit .net { color: var(--accent); font-weight: 600; font-size: 15px }
.demand { color: var(--fg-muted) } .demand.sells-fast { color: var(--accent) } .demand.slow { color: var(--warn) }
.title { display:block; color: var(--fg); font-weight: 500; text-decoration: none; margin: 2px 0 6px; } .title:hover { text-decoration: underline }
.verdict { margin: 0 0 6px; font-size: 14px; display:flex; gap: 8px; align-items: baseline } .verdict::before { content:""; width:7px; height:7px; border-radius:50%; flex:none; background: var(--accent); position: relative; top: -1px } .verdict.warn::before { background: var(--warn) } .verdict.bad::before { background: var(--bad) } .verdict.bad { color: var(--bad) } .verdict.warn { color: var(--warn) }
.meta { display:flex; flex-wrap:wrap; gap: 6px 12px; align-items:center; margin: 0; color: var(--fg-muted); font-size: 13px } .meta a { color: var(--fg-muted); text-decoration:none; border-bottom: 1px solid var(--divider) }
.pill { font-size: 11px; font-weight: 500; letter-spacing: 0.08em; text-transform: uppercase; border: 1px solid var(--divider); border-radius: 999px; padding: 2px 8px; }
.comps { margin: 6px 0 0; font-size: 12.5px; color: var(--fg-dim); display:flex; flex-wrap:wrap; gap: 4px 10px } .comps a { color: var(--fg-muted); text-decoration:none; border-bottom: 1px solid var(--divider) }
.foot { color: var(--fg-muted); font-size: 12.5px; margin: 14px 0 0 } .foot .eyebrow { display:inline; margin:0 6px 0 0 }
.how { border-top: 1px solid var(--divider); margin-top: 40px; padding-top: 20px; color: var(--fg-muted); font-size: 13.5px; max-width: 70ch }
@media (max-width: 520px) { .card { grid-template-columns: 84px 1fr; gap: 12px } .ph { width:84px; height:84px } .price { font-size: 21px } }
a:focus-visible, button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px }
</style>
<div class="wrap">
  <p class="eyebrow">Marketplace MCP · flip finder sweep · 2026-10-17</p>
  <h1>Where the flips actually are</h1>
  <p class="sub">${markets.length} product markets run through the <code style="font:inherit">arbitrage</code> tool. Sell price is the median of real sold listings on Poshmark and Mercari in the same condition tier; net is after that venue's seller fees, the buy price and inbound shipping. Only listings with at least 3 comps, net ≥ $25 and margin ≥ 20% count as flips. Jev judges relevance, photo match, catches and replica risk on each one.</p>
  <div class="tablewrap">${summary}</div>
  <p class="how">Worth working = a clean flip with net ≥ $50. Efficient market = plenty of sold data and no gap after fees. Only suspect deals = every cheap listing was flagged as a replica or a catch. No sell side = fewer than 3 sold comps reachable (eBay's sold view is closed to us).</p>
  <h2>Markets</h2>
  ${sections}
  <p class="how">Built from live runs on 2026-10-17 between 18:40 and 19:50 PT. Prices move; links open the original listings. Photos are the listings' own thumbnails. eBay was bot-walled for most queries, so the buy side there is thinner than it will be on a good day.</p>
</div>`;
writeFileSync("/private/tmp/claude-501/-Users-kaushik-Documents-Work/53e7db1f-a2fd-488b-8221-123498b56b65/scratchpad/flip-finder-sweep.html", html);
console.log("markets", markets.length, "bytes", html.length, "photos embedded", [...cache.values()].filter(Boolean).length, "of", cache.size);
