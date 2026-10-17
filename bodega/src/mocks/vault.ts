import type { Lease, ListingId, UpstreamConfig, Vault } from "../contracts/index.js";
import { UPSTREAMS } from "./seed.js";

export class MockVault implements Vault {
  private upstreams = new Map<ListingId, UpstreamConfig>(UPSTREAMS.map((u) => [u.listing_id, u]));
  readonly revoked = new Set<string>();

  async upstream(listing_id: ListingId): Promise<UpstreamConfig> {
    const u = this.upstreams.get(listing_id);
    if (!u) throw new Error(`no upstream for ${listing_id}`);
    return u;
  }

  async lease(listing_id: ListingId, trial_id: string): Promise<Lease> {
    const u = await this.upstream(listing_id);
    const expires_at = new Date(Date.now() + 30 * 60_000).toISOString();
    if (u.credential.kind === "pooled_key") {
      return { secret: process.env[u.credential.env_var] ?? `mock-${listing_id}-key`, expires_at };
    }
    // provision_webhook: the real Vault POSTs {trial_id, limits} to the vendor and gets a scoped key back.
    return { secret: `scoped_${listing_id}_${trial_id}`, expires_at };
  }

  async revoke(trial_id: string): Promise<void> {
    this.revoked.add(trial_id);
  }
}
