import json,glob,os,sys
rows=[]
for f in sorted(glob.glob(".cache/usecases/*.json")):
    raw=open(f).read().strip(); name=f.split("/")[-1][:-5].replace("_"," ")
    if not raw: rows.append((name,"—","—","—","interrupted run")); continue
    try: d=json.loads(raw); res=d["result"]
    except: rows.append((name,"—","—","—","parse fail")); continue
    if res.get("isError"): rows.append((name,"—","—","—","error: "+res["content"][0]["text"][:60])); continue
    r=res["structuredContent"]; opps=r["opportunities"]
    clean=[o for o in opps if not o.get("suspected_replica") and (o.get("catch_risk") or 0)<0.6]
    reps=sum(1 for o in opps if o.get("suspected_replica")); catches=sum(1 for o in opps if not o.get("suspected_replica") and (o.get("catch_risk") or 0)>=0.6)
    comps=f"{r['reference']['sold_comps']} ({'+'.join(r['reference'].get('sold_venues') or []) or 'none'})"
    if clean:
        o=clean[0]; l=o["listing"]
        best=f"buy {l['m']} ${l['usd']:.0f} ({o['tier']}) → ~${o['sell_est_usd']} on {o['comps_venue']} ({o['comps_n']} sold, {o['demand_label']}) → **net ${o['net_profit_usd']}** ({int(o['margin_pct']*100)}%)"
        verdict="worth working" if o['net_profit_usd']>=50 else "thin"
    else:
        best="none"
        if opps: verdict="only suspect deals"
        elif r['reference']['sold_comps']<3: verdict="no sell side (no sold comps)"
        elif r['reference']['sold_comps']>=20: verdict="efficient market (no gap after fees)"
        else: verdict="no flip found (thin comps)"
    flagged=f"{reps} replica-suspect, {catches} catch" if (reps or catches) else "—"
    rows.append((name, str(r['considered']), comps, best, verdict, flagged))
print("| Market | Live | Sold comps | Best clean flip | Verdict | Filtered out |")
print("|---|---|---|---|---|---|")
for row in rows:
    if len(row)==5: name,a,b,c,note=row; print(f"| {name} | {a} | {b} | {c} | {note} | |")
    else: print("| "+" | ".join(row)+" |")
