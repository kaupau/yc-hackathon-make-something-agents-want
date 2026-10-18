// End-to-end run of the demo script against the mocks: need -> compare -> review -> buy -> wallet -> funnel.
// Proves the contracts cover the demo. The buy/wallet logic here is a stand-in for Stream A's store.

import type { Purchase, WalletView } from "../contracts/index.js";
import { nextId, nowIso } from "./ids.js";
import { createMockServices } from "./index.js";

const CAP_USD = 5;
const THRESHOLD_USD = 1;
const HUMAN_EMAIL = "human@example.com";
const session = "demo-session";

const s = createMockServices();
const line = (title: string) => console.log(`\n== ${title}`);

line('need("agent email, send + receive")');
const found = await s.catalog.search("agent email send receive", { category: "email" });
for (const l of found) {
  console.log(`${l.id.padEnd(18)} ${l.real ? "real" : "mock"}  trial ${l.trial?.per_agent} ${l.trial?.unit}, then $${l.price.buy_usd.toFixed(2)} / ${l.price.unit_label}`);
}

line(`compare(${found.map((l) => l.id).join(", ")})`);
const report = await s.runtime.compare(found.map((l) => l.id), "email.roundtrip", session);
for (const r of report.results) {
  const metrics = Object.entries(r.metrics).map(([k, v]) => `${k}=${v}`).join(" ");
  console.log(`${r.ok ? "PASS" : "FAIL"} ${r.listing_id.padEnd(18)} ${metrics.padEnd(28)} ${r.loc} LOC${r.error ? `  ${r.error}` : ""}`);
}
console.log(`suggestion: ${report.suggestion} (${report.reason})`);

for (const r of report.results) {
  await s.ledger.recordReview({
    id: nextId("rev"),
    listing_id: r.listing_id,
    session_id: session,
    verdict: r.listing_id === report.suggestion ? "chosen" : "rejected",
    reason: r.listing_id === report.suggestion ? report.reason : r.error ?? "slower round trip",
    compared_with: report.results.map((x) => x.listing_id).filter((id) => id !== r.listing_id),
    source: "auto",
    created_at: nowIso(),
  });
}

line("wallet() after trials");
console.log(JSON.stringify(await wallet()));

line(`buy("${report.suggestion}")`);
const listing = await s.catalog.get(report.suggestion!);
if (!listing) throw new Error("no suggestion to buy");
let purchase: Purchase = {
  id: nextId("pur"),
  listing_id: listing.id,
  session_id: session,
  amount_usd: listing.price.buy_usd,
  status: listing.price.buy_usd > THRESHOLD_USD ? "needs_approval" : "paid",
  created_at: nowIso(),
};
await s.ledger.recordPurchase(purchase);
if (purchase.status === "needs_approval") {
  const { approve_url } = await s.approvals.request(purchase, HUMAN_EMAIL);
  console.log(`$${purchase.amount_usd.toFixed(2)} is over the $${THRESHOLD_USD.toFixed(2)} threshold: approval emailed to ${HUMAN_EMAIL} (${approve_url})`);
  s.approvals.decide(purchase.id, "approved"); // the human replies "approve"
  console.log(`approval status: ${await s.approvals.status(purchase.id)}`);
}
purchase = await s.ledger.updatePurchase(purchase.id, {
  status: "paid",
  receipt_id: "pi_mock_1",
  project_key: `bdg_live_${purchase.id}`,
});
console.log(`paid: receipt ${purchase.receipt_id}, project key ${purchase.project_key}, tools now available: ${listing.adds_tools.join(", ")}`);

line("wallet() after buy");
console.log(JSON.stringify(await wallet()));

for (const vendor of ["primitive", "inkbox", "postpigeon"]) {
  line(`vendor funnel: ${vendor}`);
  for (const f of (await s.ledger.funnel(vendor)).listings) {
    console.log(
      `${f.listing_id}: trials ${f.trials}, checks ${f.checks_passed}/${f.checks_run} passed, chosen ${f.chosen}, rejected ${f.rejected}, ` +
        `purchases ${f.purchases} ($${f.revenue_usd.toFixed(2)}), reasons: ${f.top_reasons.join("; ") || "-"}`,
    );
  }
}

async function wallet(): Promise<WalletView> {
  const purchases = await s.ledger.listPurchases(session);
  const spent = purchases.filter((p) => p.status === "paid").reduce((sum, p) => sum + p.amount_usd, 0);
  const trials = await s.ledger.listTrials(session);
  return {
    session_id: session,
    cap_usd: CAP_USD,
    threshold_usd: THRESHOLD_USD,
    spent_usd: spent,
    remaining_usd: CAP_USD - spent,
    purchases,
    trials: await Promise.all(
      trials.map(async (t) => ({
        listing_id: t.listing_id,
        used: t.used,
        limit: t.limit,
        unit: t.unit,
        funded_by: (await s.catalog.get(t.listing_id))?.vendor_id ?? "vendor",
      })),
    ),
  };
}
