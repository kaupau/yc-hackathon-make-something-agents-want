/** Arbitrage board: the arbitrage tool's result as a scannable table with the evidence that backs each spread. */
import { ThemeProvider, useOpenExternal, useToolContext } from "mcp-use/react";
import "./view.css";

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}%`);
const riskClass = (r: number | undefined) => (r == null ? "" : r >= 0.6 ? "bad" : r >= 0.3 ? "warn" : "good");
const matchClass = (m: number | null | undefined) => (m == null ? "" : m >= 0.75 ? "good" : m >= 0.5 ? "warn" : "bad");

export default function ArbitrageBoard() {
  const view = useToolContext<"arbitrage">();
  const openExternal = useOpenExternal();
  const open = (url: string) => (e: React.MouseEvent) => { e.preventDefault(); void openExternal({ url }); };

  if (view.status === "error") return <ThemeProvider><div className="ab"><p className="ab-err">arbitrage failed: {view.error.message}</p></div></ThemeProvider>;
  if (view.status === "pending") {
    return <ThemeProvider><div className="ab"><header className="ab-head"><h1>{view.toolInput?.query ?? "…"}</h1><p className="ab-sub">searching every marketplace, judging relevance, comparing photos…</p></header><div className="ab-skel" /><div className="ab-skel" /><div className="ab-skel" /></div></ThemeProvider>;
  }
  const d = view.toolOutput;
  const markets = Object.entries(d.by_marketplace);
  const maxSpread = Math.max(1, ...d.opportunities.map((o) => o.spread_pct));
  return (
    <ThemeProvider>
      <div className="ab">
        <header className="ab-head">
          <h1>{d.query}</h1>
          <p className="ab-sub">{d.considered} listings across {markets.length} marketplaces · {d.kept_after_relevance} judged the product itself · reference {d.reference.sold_median_usd != null ? `median of ${d.reference.sold_comps} sold comps` : "median live ask elsewhere"}</p>
        </header>
        <div className="ab-markets">
          {markets.map(([name, m]) => (
            <div key={name} className={`ab-mkt${m.n === 0 ? " empty" : ""}`}>
              <span className="ab-mkt-name">{name}</span>
              <span className="ab-mkt-n">{m.n}</span>
              <span className="ab-mkt-p">{usd(m.min)} <em>min</em></span>
              <span className="ab-mkt-p">{usd(m.median)} <em>med</em></span>
            </div>
          ))}
        </div>
        {d.opportunities.length === 0 ? <p className="ab-none">No listing far enough below its reference.</p> : (
          <ol className="ab-list">
            {d.opportunities.map((o, i) => (
              <li key={o.listing.id + i} className="ab-row">
                <div className="ab-thumb">{o.listing.img ? <img src={o.listing.img} alt="" loading="lazy" /> : <span className="ab-thumb-x">{o.listing.m.slice(0, 2)}</span>}</div>
                <div className="ab-main">
                  <a className="ab-title" href={o.listing.url} onClick={open(o.listing.url)}>{o.listing.title}</a>
                  <div className="ab-meta">
                    <span className="ab-tag">{o.listing.m}</span>
                    {o.listing.cond && <span>{o.listing.cond}</span>}
                    {o.listing.size && <span>size {o.listing.size}</span>}
                    {o.listing.ship != null && <span>+{usd(o.listing.ship)} ship</span>}
                    {o.counterpart && <a href={o.counterpart.url} onClick={open(o.counterpart.url)}>vs {o.counterpart.marketplace} {usd(o.counterpart.price_usd)}</a>}
                  </div>
                  <div className="ab-bar"><span style={{ width: `${Math.round((o.spread_pct / maxSpread) * 100)}%` }} /></div>
                </div>
                <div className="ab-nums">
                  <div className="ab-price">{usd(o.listing.usd)} <small>vs {usd(o.reference_usd)}</small></div>
                  <div className="ab-spread">−{usd(o.spread_usd)} · {pct(o.spread_pct)}</div>
                  <div className="ab-badges">
                    <span title="Jev: is this the product itself?">rel {pct(o.relevance)}</span>
                    <span className={matchClass(o.photo_match)} title="Jev: do the photos show the same product?">photo {pct(o.photo_match)}</span>
                    <span className={riskClass(o.catch_risk)} title="Jev: does the text signal damage, parts, 'read description'?">catch {pct(o.catch_risk)}</span>
                  </div>
                </div>
              </li>
            ))}
          </ol>
        )}
        {d.errors.length > 0 && <p className="ab-err">{d.errors.join(" · ")}</p>}
      </div>
    </ThemeProvider>
  );
}
