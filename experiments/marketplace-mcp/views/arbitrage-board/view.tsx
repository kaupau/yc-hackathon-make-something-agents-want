/** Arbitrage board in the nousdata house style: hairline rows, dim numerals, eyebrow labels, pill tags, one accent. */
import { ThemeProvider, useOpenExternal, useToolContext } from "mcp-use/react";
import "./view.css";

const usd = (n: number | null | undefined) => (n == null ? "—" : `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`);
const pct = (n: number | null | undefined) => (n == null ? "—" : `${Math.round(n * 100)}`);
const nn = (i: number) => String(i + 1).padStart(2, "0");
const riskTone = (r: number | undefined) => (r == null ? "" : r >= 0.6 ? "bad" : r >= 0.3 ? "warn" : "ok");
const matchTone = (m: number | null | undefined) => (m == null ? "" : m >= 0.75 ? "ok" : m >= 0.5 ? "warn" : "bad");

export default function ArbitrageBoard() {
  const view = useToolContext<"arbitrage">();
  const openExternal = useOpenExternal();
  const open = (url: string) => (e: React.MouseEvent) => { e.preventDefault(); void openExternal({ url }); };

  if (view.status === "error") return <ThemeProvider><section className="nb"><p className="nb-eyebrow">ARBITRAGE</p><p className="nb-err">{view.error.message}</p></section></ThemeProvider>;
  if (view.status === "pending") {
    return <ThemeProvider><section className="nb"><p className="nb-eyebrow">ARBITRAGE <span className="nb-live">● SEARCHING</span></p><h1 className="nb-h1">{view.toolInput?.query ?? "…"}</h1><p className="nb-sub">Every marketplace, then relevance, photos and the catch check.</p><div className="nb-skel" /><div className="nb-skel" /><div className="nb-skel" /></section></ThemeProvider>;
  }
  const d = view.toolOutput;
  const markets = Object.entries(d.by_marketplace).sort((a, b) => (b[1].n - a[1].n));
  const maxSpread = Math.max(1, ...d.opportunities.map((o) => o.spread_pct));
  const refFrom = d.reference.sold_median_usd != null ? `median of ${d.reference.sold_comps} sold comps` : "median live ask on the other marketplaces";
  return (
    <ThemeProvider>
      <section className="nb">
        <p className="nb-eyebrow">ARBITRAGE · {markets.length} MARKETPLACES <span className="nb-live">● LIVE</span></p>
        <h1 className="nb-h1">{d.query}</h1>
        <p className="nb-sub">{d.considered} listings seen, {d.kept_after_relevance} judged the product itself.</p>

        <table className="nb-markets">
          <tbody>
            {markets.map(([name, m], i) => (
              <tr key={name} className={m.n === 0 ? "dim" : ""}>
                <td className="nb-idx">{nn(i)}</td>
                <td className="nb-name">{name}</td>
                <td className="nb-num">{m.n} <em>listings</em></td>
                <td className="nb-num">{usd(m.min)} <em>min</em></td>
                <td className="nb-num">{usd(m.median)} <em>median</em></td>
              </tr>
            ))}
          </tbody>
        </table>

        <p className="nb-eyebrow nb-gap">OPPORTUNITIES</p>
        {d.opportunities.length === 0 ? <p className="nb-sub">Nothing far enough below its reference.</p> : (
          <ol className="nb-list">
            {d.opportunities.map((o, i) => (
              <li key={o.listing.id + i} className="nb-row">
                <div className="nb-big">{nn(i)}</div>
                <div className="nb-thumb">{o.listing.img ? <img src={o.listing.img} alt="" loading="lazy" /> : null}</div>
                <div className="nb-main">
                  <a className="nb-title" href={o.listing.url} onClick={open(o.listing.url)}>{o.listing.title}</a>
                  <p className="nb-meta">
                    <span className="nb-pill">{o.listing.m}</span>
                    {o.listing.cond && <span>{o.listing.cond}</span>}
                    {o.listing.size && <span>size {o.listing.size}</span>}
                    {o.listing.ship != null && <span>+{usd(o.listing.ship)} shipping</span>}
                    {o.counterpart && <a href={o.counterpart.url} onClick={open(o.counterpart.url)}>vs {o.counterpart.marketplace} at {usd(o.counterpart.price_usd)}</a>}
                  </p>
                  <div className="nb-bar"><span style={{ width: `${Math.round((o.spread_pct / maxSpread) * 100)}%` }} /></div>
                  <p className="nb-checked">
                    <span className="nb-eyebrow">CHECKED BY JEV</span>
                    <span className="nb-pill ok">REL {pct(o.relevance)}</span>
                    <span className={`nb-pill ${matchTone(o.photo_match)}`}>PHOTO {pct(o.photo_match)}</span>
                    <span className={`nb-pill ${riskTone(o.catch_risk)}`}>CATCH {pct(o.catch_risk)}</span>
                  </p>
                </div>
                <div className="nb-nums">
                  <div className="nb-price">{usd(o.listing.usd)}</div>
                  <div className="nb-ref">vs {usd(o.reference_usd)}</div>
                  <div className="nb-spread">−{usd(o.spread_usd)} · {pct(o.spread_pct)}%</div>
                </div>
              </li>
            ))}
          </ol>
        )}

        <p className="nb-foot"><span className="nb-eyebrow">REFERENCE</span> {refFrom}.{d.errors.length > 0 && <> <span className="nb-eyebrow">SKIPPED</span> {d.errors.join(" · ")}</>}</p>
      </section>
    </ThemeProvider>
  );
}
