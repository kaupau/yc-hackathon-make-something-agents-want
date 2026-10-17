/**
 * Arbitrage board, nousdata house style. Three questions, in order:
 * 1. What does it cost on each market?  → price map (one row per marketplace, every listing a dot, typical price as a line)
 * 2. Which listings are deals, and can I trust them?  → deal cards with photo, price vs typical, a plain-English verdict + reason
 * 3. Let me browse everything  → per-marketplace photo grid; any listing opens into photos + description via the item tool
 */
import { ThemeProvider, useCallTool, useHostContext, useOpenExternal, useSendFollowUp, useToolContext } from "mcp-use/react";
import { Component, useMemo, useState, type ReactNode } from "react";
import "./view.css";

type Src = { m: string; id: string; title: string; usd: number | null; cond: string | null; url: string; img?: string; size?: string; ship?: number | null; relevance?: number; sold?: boolean };
const usd = (n: number | null | undefined) => (n == null ? "—" : `$${Math.round(n).toLocaleString("en-US")}`);
const pc = (n: number | null | undefined) => (n == null ? null : Math.round(n * 100));
const REASON: Record<string, string> = { read_description: "the title asks you to read the description", damage_or_wear: "wear or damage is mentioned", parts_or_incomplete: "it may be parts only or incomplete", replica_or_authenticity: "authenticity is in doubt", size_or_variant: "it may be a different size or variant", none: "nothing flagged" };

function verdict(o: any): { tone: "ok" | "warn" | "bad"; text: string } {
  const c = o.catch_risk ?? 0, p = o.photo_match, r = o.relevance ?? 1, why = REASON[o.catch_reason ?? "none"];
  if (o.suspected_replica) return { tone: "bad", text: `Suspected replica (${pc(o.replica_risk)}%): priced at ${o.reference_usd ? Math.round(((o.listing.usd ?? 0) / o.reference_usd) * 100) : "?"}% of typical${o.catch_reason === "replica_or_authenticity" ? ", wording looks off" : ""}. Not recommended.` };
  if (c >= 0.6) return { tone: "bad", text: `Likely a catch: ${why}.` };
  if (r < 0.8) return { tone: "warn", text: "Check first: might not be the exact model." };
  if (p != null && p < 0.5) return { tone: "warn", text: `Check first: photos only ${pc(p)}% match the ${o.counterpart?.marketplace ?? "other"} listing.` };
  if (c >= 0.3 && (o.catch_reason ?? "none") !== "none") return { tone: "warn", text: `Check first: ${why}.` };
  return { tone: "ok", text: p != null ? `Looks clean: photos match a ${o.counterpart?.marketplace ?? "comparable"} ${o.counterpart?.sold ? "sale" : "listing"} (${pc(p)}%).` : "Looks clean: nothing flagged in the listing." };
}

function PriceMap({ sources, refPrice }: { sources: Src[]; refPrice: number | null }) {
  const ref = refPrice;
  const priced = sources.filter((s) => s.usd != null && s.usd > 0) as (Src & { usd: number })[];
  if (!priced.length) return null;
  const sorted = priced.map((s) => s.usd).sort((a, b) => a - b);
  const lo = sorted[0], hi = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.97))];
  const markets = [...new Set(priced.map((s) => s.m))].sort((a, b) => { const med = (m: string) => { const xs = priced.filter((s) => s.m === m).map((s) => s.usd).sort((x, y) => x - y); return xs[Math.floor(xs.length / 2)]; }; return med(a) - med(b); });
  const W = 600, L = 84, R = 16, rowH = 22, H = markets.length * rowH + 30;
  const x = (v: number) => L + ((Math.log(Math.max(v, lo)) - Math.log(lo)) / Math.max(1e-9, Math.log(hi) - Math.log(lo))) * (W - L - R);
  return (
    <svg className="nb-map" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="price by marketplace">
      {markets.map((m, i) => (
        <g key={m} transform={`translate(0 ${i * rowH + 14})`}>
          <text x={0} y={4} className="nb-map-label">{m}</text>
          <line x1={L} x2={W - R} y1={0} y2={0} className="nb-map-rail" />
          {priced.filter((s) => s.m === m).map((s, j) => <circle key={s.id + j} cx={x(s.usd)} cy={0} r={s.sold ? 3 : 3.5} className={s.sold ? "nb-map-sold" : "nb-map-dot"}><title>{`${s.sold ? "sold " : ""}${usd(s.usd)} · ${s.title}`}</title></circle>)}
        </g>
      ))}
      {ref != null && ref >= lo && ref <= hi && (<g><line x1={x(ref)} x2={x(ref)} y1={4} y2={markets.length * rowH + 6} className="nb-map-ref" /><text x={x(ref)} y={markets.length * rowH + 20} textAnchor="middle" className="nb-map-reftext">sells for {usd(ref)}</text></g>)}
      <text x={L} y={markets.length * rowH + 20} className="nb-map-axis">{usd(lo)}</text>
      <text x={W - R} y={markets.length * rowH + 20} textAnchor="end" className="nb-map-axis">{usd(hi)}</text>
    </svg>
  );
}

class Boundary extends Component<{ children: ReactNode }, { err: string | null }> {
  state = { err: null as string | null };
  static getDerivedStateFromError(e: any) { return { err: String(e?.message ?? e) }; }
  render() { return this.state.err ? <section className="nb"><p className="nb-eyebrow">BOARD ERROR</p><p className="nb-err">{this.state.err}</p></section> : this.props.children; }
}

export default function ArbitrageBoard() { return <Boundary><Board /></Boundary>; }

function Board() {
  const view = useToolContext<"arbitrage">();
  const openExternal = useOpenExternal();
  const sendFollowUp = useSendFollowUp();
  const { hostCapabilities } = useHostContext();
  const item = useCallTool("item");
  const [open, setOpen] = useState<string | null>(null);
  const [tab, setTab] = useState<string>("deals");
  const canFollowUp = hostCapabilities?.message !== undefined;
  const go = (url: string) => (e: React.MouseEvent) => { e.preventDefault(); void openExternal({ url }); };
  const expand = (s: { m: string; id: string }) => { const k = `${s.m}:${s.id}`; if (open === k) { setOpen(null); return; } setOpen(k); item.callTool({ marketplace: s.m, id: s.id }).catch(() => {}); };

  const ready: any = view.status === "ready" ? view.toolOutput : null;
  const sources: Src[] = useMemo(() => ready?.sources ?? [], [ready]);

  if (view.status === "error") return <ThemeProvider><section className="nb"><p className="nb-eyebrow">ARBITRAGE</p><p className="nb-err">{view.error.message}</p></section></ThemeProvider>;
  if (view.status === "pending") return <ThemeProvider><section className="nb"><p className="nb-eyebrow">ARBITRAGE <span className="nb-live">● SEARCHING</span></p><h1 className="nb-h1">{view.toolInput?.query ?? "…"}</h1><p className="nb-sub">Every marketplace, then relevance, photos and the catch check. 20–40 s.</p><div className="nb-skel" /><div className="nb-skel" /></section></ThemeProvider>;

  const d = view.toolOutput;
  const ref = d.opportunities[0]?.reference_usd ?? d.reference.sold_median_usd ?? null;
  const clean = d.opportunities.find((o) => verdict(o).tone === "ok");
  const _unusedRef = ref;
  const markets = [...new Set(sources.map((s) => s.m))];
  const detail = (s: { m: string; id: string }) => {
    if (open !== `${s.m}:${s.id}`) return null;
    const r: any = item.data?.structuredContent;
    return (
      <div className="nb-detail">
        {item.isPending && <p className="nb-sub">loading photos…</p>}
        {r?.error && <p className="nb-err">{r.error}</p>}
        {r?.photos?.length > 0 && <div className="nb-strip">{r.photos.map((p: string, i: number) => <img key={i} src={p} alt="" loading="lazy" />)}</div>}
        {r?.listing && <p className="nb-meta"><span>{r.listing.cond ?? ""}</span>{r.listing.size && <span>size {r.listing.size}</span>}{r.listing.rating != null && <span>seller {r.listing.rating}/5{r.listing.reviews ? ` · ${r.listing.reviews}` : ""}</span>}</p>}
        {r?.description && <p className="nb-desc">{r.description}</p>}
        {r?.reviews?.length > 0 && <p className="nb-desc">“{r.reviews[0].body}”</p>}
      </div>
    );
  };

  return (
    <ThemeProvider>
      <section className="nb">
        <p className="nb-eyebrow">ARBITRAGE · {markets.length || Object.keys(d.by_marketplace).length} MARKETPLACES <span className="nb-live">● LIVE</span></p>
        <h1 className="nb-h1">{d.query}</h1>
        <p className="nb-lead">{d.reference.sold_comps > 0 ? <>Sells for about <b>{usd(d.reference.sold_median_usd)}</b> ({d.reference.sold_comps} sold on {(d.reference as any).sold_venues?.join(" and ") ?? "resale sites"}). </> : <>No sold listings found, so there is no reliable sell price. </>}{clean ? <>Best clean flip: buy at <b>{usd(clean.listing.usd)}</b> on {clean.listing.m}, about <b>{usd((clean as any).net_profit_usd)}</b> net after fees.</> : d.opportunities.length ? <>Every candidate has something to check first.</> : <>No listing clears a margin after fees.</>} <span className="nb-dim">{d.considered} live listings, {d.kept_after_relevance} judged the right product.</span></p>

        <PriceMap sources={sources} refPrice={ref} />

        <nav className="nb-tabs">
          <button className={tab === "deals" ? "on" : ""} onClick={() => setTab("deals")}>Deals <em>{d.opportunities.length}</em></button>
          {markets.map((m) => <button key={m} className={tab === m ? "on" : ""} onClick={() => setTab(m)}>{m} <em>{sources.filter((s) => s.m === m && !s.sold).length}{sources.some((s) => s.m === m && s.sold) ? ` + ${sources.filter((s) => s.m === m && s.sold).length} sold` : ""}</em></button>)}
        </nav>

        {tab === "deals" && (
          d.opportunities.length === 0 ? <p className="nb-sub">No listing is {Math.round((view.toolInput?.min_spread_pct ?? 0.25) * 100)}% or more below the typical price.</p> : (
            <div className="nb-cards">
              {d.opportunities.map((o, i) => { const v = verdict(o); const l = o.listing; return (
                <article key={l.id + i} className={`nb-card ${v.tone}`}>
                  <button className="nb-photo" onClick={() => expand(l)} aria-label="photos and details">{l.img ? <img src={l.img} alt="" loading="lazy" /> : <span>{l.m}</span>}</button>
                  <div className="nb-body">
                    <div className="nb-pricerow"><span className="nb-price">{usd(l.usd)}</span><span className="nb-ref">buy on {l.m}{l.ship ? ` + ${usd(l.ship)} shipping` : ""}</span></div>
                    <p className="nb-profit"><span>sells for <b>{usd((o as any).sell_est_usd ?? o.reference_usd)}</b> on {(o as any).comps_venue ?? "resale"} ({(o as any).comps_n ?? 0} sold{(o as any).comps_tier && (o as any).comps_tier !== "any" ? `, ${String((o as any).comps_tier).replace("_", " ")}` : ""})</span><span>fees {pc((o as any).fee_pct ?? 0)}%{(o as any).ship_assumed ? ` · ~${usd((o as any).ship_usd)} shipping assumed` : ""}</span><span className="net">net {usd((o as any).net_profit_usd)} · {pc((o as any).margin_pct)}% margin</span>{(o as any).demand_label && <span className={`nb-demand ${(o as any).demand_label.replace(" ", "-")}`}>{(o as any).demand_label}: {(o as any).comps_n} sold vs {d.by_marketplace[(o as any).comps_venue]?.n ?? 0} listed there</span>}</p>
                    {Array.isArray((o as any).comp_sample) && (o as any).comp_sample.length > 0 && <p className="nb-comps">based on {(o as any).comp_basis}: {(o as any).comp_sample.map((c: any, k: number) => <a key={k} href={c.url} onClick={go(c.url)}>{usd(c.usd)}{c.size ? ` (${c.size})` : ""}</a>)}</p>}
                    <a className="nb-title" href={l.url} onClick={go(l.url)}>{l.title}</a>
                    <p className={`nb-verdict ${v.tone}`}>{v.text}</p>
                    <p className="nb-meta"><span className="nb-pill">{l.m}</span>{l.cond && <span>{l.cond}</span>}{l.size && <span>size {l.size}</span>}{l.ship != null && <span>+{usd(l.ship)} shipping</span>}{o.counterpart && <a href={o.counterpart.url} onClick={go(o.counterpart.url)}>photo compared with a {o.counterpart.marketplace} {(o.counterpart as any).sold ? "sale" : "listing"} at {usd(o.counterpart.price_usd)}</a>}</p>
                    <p className="nb-actions"><button onClick={() => expand(l)}>{open === `${l.m}:${l.id}` ? "Hide" : "Photos & details"}</button><a href={l.url} onClick={go(l.url)}>Open listing ↗</a></p>
                    {detail(l)}
                  </div>
                </article>
              ); })}
            </div>
          )
        )}

        {tab !== "deals" && (
          <div className="nb-grid">
            {sources.filter((s) => s.m === tab).map((s, i) => (
              <div key={s.id + i} className={`nb-tile${(s.relevance ?? 1) < 0.6 ? " faint" : ""}`}>
                <button className="nb-photo" onClick={() => expand(s)} aria-label="photos and details">{s.img ? <img src={s.img} alt="" loading="lazy" /> : <span>{s.m}</span>}</button>
                <div className="nb-tile-price">{s.sold ? <em>sold </em> : null}{usd(s.usd)}{s.size ? <em> · {s.size}</em> : null}</div>
                <a className="nb-tile-title" href={s.url} onClick={go(s.url)}>{s.title}</a>
                {detail(s)}
              </div>
            ))}
          </div>
        )}

        {canFollowUp && (
          <p className="nb-chips"><span className="nb-eyebrow">ASK THE AGENT</span>
            <button onClick={() => void sendFollowUp({ prompt: `For "${d.query}", only consider listings in my size and show the three cheapest clean ones.` })}>Only my size</button>
            <button onClick={() => void sendFollowUp({ prompt: `Check the top deal for "${d.query}" in detail: open its photos and description with item() and tell me whether to buy.` })}>Vet the top deal</button>
            <button onClick={() => void sendFollowUp({ prompt: `Search "${d.query}" with sold=true to see what buyers actually paid, then revisit the deals.` })}>Sold prices</button>
          </p>
        )}
        <p className="nb-foot"><span className="nb-eyebrow">HOW</span>sell price = median of sold listings in the same condition tier on the venue with the most sales; net = sell price minus that venue's seller fees, the buy price and inbound shipping. Only listings with at least 3 comps and a positive margin are shown.{d.errors.length > 0 && <> <span className="nb-eyebrow">SKIPPED</span>{d.errors.join(" · ")}</>}</p>
      </section>
    </ThemeProvider>
  );
}
