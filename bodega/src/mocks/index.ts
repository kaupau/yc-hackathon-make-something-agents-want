import type { Services } from "../contracts/index.js";
import { MockApprovals } from "./approvals.js";
import { MockCatalog } from "./catalog.js";
import { MockLedger } from "./ledger.js";
import { MockTrialRuntime } from "./runtime.js";
import { MockVault } from "./vault.js";

export { MockApprovals, MockCatalog, MockLedger, MockTrialRuntime, MockVault };
export * from "./seed.js";

export type MockServices = Services & { approvals: MockApprovals };

/** All five services in memory. Swap any one for a real implementation as it lands. */
export function createMockServices(): MockServices {
  const catalog = new MockCatalog();
  const vault = new MockVault();
  const ledger = new MockLedger(catalog);
  const approvals = new MockApprovals();
  const runtime = new MockTrialRuntime(catalog, ledger, vault);
  return { catalog, vault, ledger, approvals, runtime };
}
