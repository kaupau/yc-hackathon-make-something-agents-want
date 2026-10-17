import type { ApprovalStatus, Approvals, Purchase } from "../contracts/index.js";

export class MockApprovals implements Approvals {
  private decisions = new Map<string, ApprovalStatus>();
  readonly sent: Array<{ purchase_id: string; to: string }> = [];

  constructor(private baseUrl = process.env.BODEGA_PUBLIC_URL ?? "http://localhost:8787") {}

  async request(purchase: Purchase, human_email: string): Promise<{ approve_url: string }> {
    this.decisions.set(purchase.id, "pending");
    this.sent.push({ purchase_id: purchase.id, to: human_email });
    return { approve_url: `${this.baseUrl}/approve/${purchase.id}` };
  }

  async status(purchase_id: string): Promise<ApprovalStatus> {
    return this.decisions.get(purchase_id) ?? "pending";
  }

  /** Mock-only: stands in for the human replying "approve" or clicking the link. */
  decide(purchase_id: string, status: Exclude<ApprovalStatus, "pending">): void {
    this.decisions.set(purchase_id, status);
  }
}
