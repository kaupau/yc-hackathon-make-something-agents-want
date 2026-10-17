import { readFileSync, writeFileSync } from "node:fs";
import sharp from "sharp";
const items = JSON.parse(readFileSync(".cache/ga-analysis.json", "utf8"));
const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const usd = (n) => n == null ? "&mdash;" : "$" + Math.round(n).toLocaleString("en-US");
const pc = (n) => n == null ? "&mdash;" : Math.round(n * 100);
const cache = new Map();
async function photo(url, w = 240) { if (!url) return null; const k = url + w; if (cache.has(k)) return cache.get(k); try { const r = await fetch(url.replace(/\._AC_[A-Z0-9_,]+_\.jpg$/, "._AC_SL500_.jpg"), { headers: { accept: "image/jpeg,image/png,image/webp;q=0.9,*/*;q=0.1" } }); if (!r.ok) throw 0; const buf = Buffer.from(await r.arrayBuffer()); const out = await sharp(buf).rotate().resize({ width: w, height: w, fit: "cover" }).jpeg({ quality: 70 }).toBuffer(); const v = `data:image/jpeg;base64,${out.toString("base64")}`; cache.set(k, v); return v; } catch { cache.set(k, null); return null; } }
for (const it of items) { it._img = await photo(it.img); for (const c of (it.candidates ?? []).slice(0, 4)) c._img = await photo(c.img, 160); for (const r of (it.rejected ?? []).slice(0, 3)) r._img = await photo(r.img, 120); }
const REASON = { read_description: "title asks to read the description", damage_or_wear: "wear or damage mentioned", parts_or_incomplete: "parts or incomplete", replica_or_authenticity: "authenticity in doubt", size_or_variant: "different size or variant", none: "nothing flagged" };
function position(it) { const g = it.grailed_ask_median, s = it.sold_median; const ref = s ?? g; if (ref == null) return { tone: "dim", label: "No market data", text: "Not enough relevant listings or sales to place this price." };
  const ratio = it.price / ref; const basis = s != null ? `median of ${it.sold_n} real sales` : `median Grailed ask (${it.grailed_n} listings)`;
  if (ratio > 1.35) return { tone: "warn", label: "Above market", text: `${Math.round((ratio - 1) * 100)}% above the ${basis} (${usd(ref)}).` };
  if (ratio < 0.8) return { tone: "ok", label: "Below market", text: `${Math.round((1 - ratio) * 100)}% below the ${basis} (${usd(ref)}). Room to raise.` };
  return { tone: "ok", label: "In line", text: `Within ${Math.abs(Math.round((ratio - 1) * 100))}% of the ${basis} (${usd(ref)}).` }; }
const rows = items.map((it) => ({ it, pos: position(it), best: (it.candidates ?? []).find((c) => c.net_at_store_price >= 50) ?? null }));
const totalSource = rows.reduce((a, r) => a + (r.best ? r.best.net_at_store_price : 0), 0);
const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").toLowerCase();
const table = `<table class="sum"><thead><tr><th>Item</th><th>Store price</th><th>Grailed asks</th><th>Real sales</th><th>Position</th><th>Best genuine source</th></tr></thead><tbody>${rows.map(({ it, pos, best }) => `<tr><td><a href="#${slug(it.title)}">${esc(it.title)}</a><small>${esc(it.brand)}${it.size ? " · " + esc(it.size) : ""}</small></td><td>${usd(it.price)}</td><td>${it.grailed_n ? `${usd(it.grailed_ask_median)} <small>med of ${it.grailed_n}, min ${usd(it.grailed_ask_min)}</small>` : "&mdash;"}</td><td>${it.sold_n ? `${usd(it.sold_median)} <small>${it.sold_n} sold${it.sold_fakes_removed ? `, ${it.sold_fakes_removed} fakes removed` : ""}</small>` : "&mdash;"}</td><td><span class="chip ${pos.tone}">${pos.label}</span></td><td>${best ? `${esc(best.m)} ${usd(best.usd)} &rarr; <b>+${usd(best.net_at_store_price)}</b> at store price` : "none passed the fake screen"}</td></tr>`).join("")}</tbody></table>`;
const card = (c, it) => `<article class="card ${c.net_at_store_price >= 50 ? "ok" : "warn"}"><div class="ph">${c._img ? `<img src="${c._img}" alt="">` : `<span>${esc(c.m)}</span>`}</div><div class="body"><div class="pricerow"><span class="price">${usd(c.usd)}</span><span class="ref">on ${esc(c.m)}${c.ship != null ? ` + ${usd(c.ship)} shipping` : ""}${c.size ? ` · size ${esc(c.size)}` : ""}${c.cond ? ` · ${esc(c.cond)}` : ""}</span></div><p class="profit"><span>relist at ${usd(it.price)} &rarr; <span class="net">+${usd(c.net_at_store_price)}</span> after Shopify fees</span></p><a class="title" href="${esc(c.url)}" target="_blank" rel="noopener">${esc(c.title)}</a><p class="verdict ok">Genuine-looking: replica risk ${pc(c.replica_risk)}%, catch ${pc(c.catch_risk)}%${c.photo_match != null ? `, photo vs the store's unit ${pc(c.photo_match)}%` : ""}.</p></div></article>`;
const rej = (r) => `<article class="card bad small"><div class="ph">${r._img ? `<img src="${r._img}" alt="">` : `<span>${esc(r.m)}</span>`}</div><div class="body"><div class="pricerow"><span class="price">${usd(r.usd)}</span><span class="ref">on ${esc(r.m)}</span></div><a class="title" href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}</a><p class="verdict bad">${r.replica_risk >= 0.5 ? `Suspected replica (${pc(r.replica_risk)}%)` : `Likely a catch (${pc(r.catch_risk)}%)`}: ${esc(REASON[r.catch_reason] ?? r.catch_reason)}.</p></div></article>`;
const sections = rows.map(({ it, pos, best }) => `<section id="${slug(it.title)}" class="market"><div class="head"><div class="ph big">${it._img ? `<img src="${it._img}" alt="">` : ""}</div><div><p class="eyebrow">${esc(it.brand)} <span class="chip ${pos.tone}">${pos.label}</span></p><h2>${esc(it.title)} <span class="dim">${usd(it.price)}${it.size ? ` · ${esc(it.size)}` : ""}</span></h2><p class="lead">${pos.text} ${it.live_relevant} relevant live listings${it.grailed_n ? `, Grailed asks ${usd(it.grailed_ask_min)}&ndash;${usd(it.grailed_ask_median)} median` : ""}${it.sold_n ? `, ${it.sold_n} real sales at ${usd(it.sold_median)} median` : ", no clean sales found"}.</p></div></div>
${(it.candidates ?? []).length ? `<h3>Genuine-looking units cheaper than the store price</h3><div class="cards">${it.candidates.slice(0, 4).map((c) => card(c, it)).join("")}</div>` : `<p class="dim">No cheaper listing passed the fake screen.</p>`}
${(it.rejected ?? []).length ? `<h3>Rejected</h3><div class="cards">${it.rejected.slice(0, 3).map(rej).join("")}</div>` : ""}
${it.errors?.length ? `<p class="foot"><span class="eyebrow">skipped</span> ${esc(it.errors.join(" &middot; "))}</p>` : ""}</section>`).join("\n");
const html = `<title>Green Airlines Market Check</title>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap">
<style>
/* layout: one column; summary table, then one section per store item with its photo, position, sourcing candidates and rejected fakes */
:root { --bg:#f5f0e8; --fg:#1a1a1a; --fg-muted:#6b6358; --fg-dim:#8a8078; --divider:rgba(0,0,0,0.1); --accent:#16a34a; --warn:#b45309; --bad:#b91c1c; --card:rgba(255,255,255,0.35); --sans:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif; }
@media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { --bg:#08080a; --fg:#e5e5e5; --fg-muted:#999; --fg-dim:#666; --divider:rgba(255,255,255,0.12); --accent:#6ee7b7; --warn:#fbbf24; --bad:#f87171; --card:rgba(255,255,255,0.03); color-scheme:dark } }
:root[data-theme="dark"] { --bg:#08080a; --fg:#e5e5e5; --fg-muted:#999; --fg-dim:#666; --divider:rgba(255,255,255,0.12); --accent:#6ee7b7; --warn:#fbbf24; --bad:#f87171; --card:rgba(255,255,255,0.03); color-scheme:dark }
body { background:var(--bg); color:var(--fg); font-family:var(--sans); font-size:15px; line-height:1.55; -webkit-font-smoothing:antialiased; font-variant-numeric:tabular-nums; }
.wrap { max-width:860px; margin:0 auto; padding-block:32px 60px; padding-inline:20px; }
h1 { font-size:30px; font-weight:500; letter-spacing:-0.03em; line-height:1.2; margin:0 0 8px; text-wrap:balance }
h2 { font-size:20px; font-weight:500; letter-spacing:-0.02em; margin:0 0 6px } h2 .dim { font-weight:400; }
h3 { font-size:12px; font-weight:500; letter-spacing:0.12em; text-transform:uppercase; color:var(--fg-dim); margin:18px 0 6px }
.sub { color:var(--fg-muted); margin:0 0 20px; max-width:64ch }
.kpis { display:flex; flex-wrap:wrap; gap:10px 28px; margin:0 0 18px; } .kpis div { display:flex; flex-direction:column } .kpis b { font-size:22px; font-weight:600; letter-spacing:-0.02em } .kpis span { font-size:12px; color:var(--fg-dim); letter-spacing:0.08em; text-transform:uppercase }
.eyebrow { font-size:12px; font-weight:500; letter-spacing:0.12em; text-transform:uppercase; color:var(--fg-dim); margin:0 0 6px; display:flex; gap:10px; align-items:center; flex-wrap:wrap }
.chip { display:inline-block; font-size:11px; font-weight:500; letter-spacing:0.08em; text-transform:uppercase; border:1px solid var(--divider); border-radius:999px; padding:2px 9px; color:var(--fg-muted); white-space:nowrap }
.chip.ok { color:var(--accent); border-color:currentColor } .chip.warn { color:var(--warn); border-color:currentColor } .chip.bad { color:var(--bad); border-color:currentColor } .chip.dim { color:var(--fg-dim) }
.tablewrap { overflow-x:auto; border-top:1px solid var(--divider); border-bottom:1px solid var(--divider) }
.sum { width:100%; border-collapse:collapse; font-size:13.5px; min-width:760px } .sum th { text-align:left; font-size:11px; letter-spacing:0.1em; text-transform:uppercase; color:var(--fg-dim); font-weight:500; padding:10px 8px 8px 0; border-bottom:1px solid var(--divider) } .sum td { padding:9px 8px 9px 0; border-bottom:1px solid var(--divider); vertical-align:top } .sum tr:last-child td { border-bottom:0 } .sum td a { color:var(--fg); text-decoration:none; border-bottom:1px solid var(--divider); font-weight:500 } .sum small { display:block; color:var(--fg-dim) }
.market { border-top:1px solid var(--divider); padding-top:24px; margin-top:36px } .head { display:grid; grid-template-columns:120px 1fr; gap:18px; align-items:start } .ph.big { width:120px; height:120px }
.lead { margin:0; max-width:70ch; color:var(--fg-muted) } .dim { color:var(--fg-dim) }
.cards { display:grid; gap:0 } .card { display:grid; grid-template-columns:112px 1fr; gap:16px; padding:14px 0; border-top:1px solid var(--divider) } .card:last-child { border-bottom:1px solid var(--divider) } .card.small { grid-template-columns:72px 1fr } .card.small .ph { width:72px; height:72px }
.ph { width:112px; height:112px; border-radius:6px; overflow:hidden; border:1px solid var(--divider); display:grid; place-items:center; color:var(--fg-dim); font-size:11px; letter-spacing:0.1em; text-transform:uppercase; background:var(--card) } .ph img { width:100%; height:100%; object-fit:cover; display:block }
.body { min-width:0 } .pricerow { display:flex; align-items:baseline; gap:10px; flex-wrap:wrap } .price { font-size:22px; font-weight:600; letter-spacing:-0.02em } .ref { font-size:13px; color:var(--fg-muted) }
.profit { margin:2px 0 4px; font-size:13.5px; color:var(--fg-muted) } .net { color:var(--accent); font-weight:600; font-size:15px }
.title { display:block; color:var(--fg); font-weight:500; text-decoration:none; margin:2px 0 4px } .title:hover { text-decoration:underline }
.verdict { margin:0; font-size:13.5px; display:flex; gap:8px; align-items:baseline } .verdict::before { content:""; width:7px; height:7px; border-radius:50%; flex:none; background:var(--accent); position:relative; top:-1px } .verdict.bad::before { background:var(--bad) } .verdict.bad { color:var(--bad) }
.foot { color:var(--fg-muted); font-size:12.5px; margin:14px 0 0 } .foot .eyebrow { display:inline; margin:0 6px 0 0 }
.how { border-top:1px solid var(--divider); margin-top:40px; padding-top:20px; color:var(--fg-muted); font-size:13.5px; max-width:70ch }
@media (max-width:520px) { .card { grid-template-columns:84px 1fr; gap:12px } .ph { width:84px; height:84px } .head { grid-template-columns:84px 1fr } .ph.big { width:84px; height:84px } .price { font-size:20px } }
a:focus-visible { outline:2px solid var(--accent); outline-offset:2px }
</style>
<div class="wrap">
  <p class="eyebrow">greenairlines.us &middot; inventory vs market &middot; 2026-10-17</p>
  <h1>Green Airlines market check</h1>
  <p class="sub">Every item in the store priced against Grailed asks and real sales on Poshmark and Mercari, with fakes screened out of the comps. Then, for each item, genuine-looking units listed cheaper than the store price, with what they'd clear if relisted at the store price (Shopify Payments fees, no marketplace cut).</p>
  <div class="kpis"><div><b>${items.length}</b><span>items checked</span></div><div><b>${rows.filter((r) => r.pos.label === "Above market").length}</b><span>priced above market</span></div><div><b>${rows.filter((r) => r.best).length}</b><span>items with a genuine cheaper source</span></div><div><b>${usd(totalSource)}</b><span>sourcing margin found</span></div><div><b>${items.reduce((a, it) => a + (it.rejected?.length ?? 0) + (it.sold_fakes_removed ?? 0), 0)}</b><span>fakes and catches rejected</span></div></div>
  <div class="tablewrap">${table}</div>
  <p class="how">Position compares the store price with the median of real sales when there are any, else the median Grailed ask. Chrome Hearts sold data on Poshmark and Mercari is thick with replicas; anything under 35% of the store price was screened by Jev before counting. Sourcing candidates passed both the replica and the catch screen; the top three were also photo-compared against the store's own unit.</p>
  ${sections}
  <p class="how">Live runs on 2026-10-17 evening. eBay was bot-walled on most queries, so eBay sources are under-represented. Links open the original listings.</p>
</div>`;
writeFileSync("/private/tmp/claude-501/-Users-kaushik-Documents-Work/53e7db1f-a2fd-488b-8221-123498b56b65/scratchpad/green-airlines-market-check.html", html);
console.log("items", items.length, "bytes", html.length, "photos", [...cache.values()].filter(Boolean).length);
