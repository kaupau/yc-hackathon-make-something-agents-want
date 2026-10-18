// The swarm: six agents, each building something different, each with its own human,
// wallet cap and approval threshold. Budgets are tuned so the run shows every guardrail:
// instant buys under the threshold, human approvals and a veto above it, a budget-forced
// trade-off, and a greedy agent that the server refuses once its cap is reached.

export interface Need {
  /** What the agent asks Bodega's need() for. */
  capability: string;
  /** Board topic; agents that share a topic share findings. */
  topic: string;
  /** Category check: candidates must support it. Omit for buy-only capabilities (no trial). */
  check?: string;
  /** Words in a listing that make it a better fit for this mission. */
  prefer: string[];
  /** Skip rather than block when nothing affordable is approved. */
  optional?: boolean;
  /** First call made with the purchased capability, when the listing adds a tool. */
  use?: { tool: string; args: Record<string, unknown> };
}

export interface Mission {
  id: string;
  name: string;
  goal: string;
  capCents: number;
  thresholdCents: number;
  /** Staggered starts make the swarm watchable and let later agents learn from the board. */
  startDelayMs: number;
  needs: Need[];
  /** The scripted human behind this agent's approval emails. */
  human: { approveUpToCents: number; declines?: Record<string, string> };
  /** Buys everything it can find; exists to show the server-side cap. */
  greedy?: boolean;
}

export const MISSIONS: Mission[] = [
  {
    id: "waitlist",
    name: "Waitlist builder",
    goal: "Ship Sunday's launch waitlist: store every signup and email each one a confirmation they can reply to.",
    capCents: 500,
    thresholdCents: 100,
    startDelayMs: 0,
    needs: [
      {
        capability: "email inbox that can send and receive replies",
        topic: "email",
        check: "email.roundtrip",
        prefer: ["receive", "reply", "replies", "threaded"],
        use: { tool: "send_email", args: { to: "waitlist-test@example.com", subject: "hackathon test: you're on the list", body_text: "Reply to this email with questions." } },
      },
      { capability: "postgres database for signups", topic: "database", check: "db.crud", prefer: ["postgres", "branch"] },
    ],
    human: { approveUpToCents: 250 },
  },
  {
    id: "scout",
    name: "Price-watch scout",
    goal: "Every night, search competitors' pricing pages, extract them to markdown and diff against yesterday.",
    capCents: 300,
    thresholdCents: 100,
    startDelayMs: 500,
    needs: [
      { capability: "web search with page extraction to markdown", topic: "search", check: "search.query", prefer: ["markdown", "extraction", "search"] },
      { capability: "cron jobs and background queue", topic: "queue", check: "queue.enqueue_consume", prefer: ["cron", "queues", "jobs"] },
    ],
    human: { approveUpToCents: 150 },
  },
  {
    id: "concierge",
    name: "Dinner concierge",
    goal: "Book a table for six tonight by phone, then leave the host a spoken confirmation.",
    capCents: 400,
    thresholdCents: 100,
    startDelayMs: 1000,
    needs: [
      {
        capability: "place a phone call to a restaurant",
        topic: "phone",
        prefer: ["phone", "call", "dial"],
        use: { tool: "call_phone", args: { number: "+14155550142", goal: "hackathon test: book a table for 6 at 8pm tonight", extract: ["confirmed", "name_on_booking"] } },
      },
      { capability: "realtime text to speech voice", topic: "voice", check: "voice.tts_latency", prefer: ["speech", "realtime", "voice"], optional: true },
    ],
    human: { approveUpToCents: 250, declines: { "callwire-voice": "The phone call already confirms the booking. Skip the voice message." } },
  },
  {
    id: "login",
    name: "Dashboard login",
    goal: "Add signup, login and sessions to the metrics dashboard prototype before the demo.",
    capCents: 300,
    thresholdCents: 100,
    startDelayMs: 1500,
    needs: [{ capability: "drop-in signup login and sessions", topic: "auth", check: "auth.signup_login", prefer: ["signup", "login", "session"] }],
    human: { approveUpToCents: 200 },
  },
  {
    id: "support",
    name: "Support triage",
    goal: "Answer customer emails within five minutes and log every ticket, on a $2.50 budget.",
    capCents: 250,
    thresholdCents: 100,
    startDelayMs: 2000,
    needs: [
      {
        capability: "email inbox that can send and receive replies",
        topic: "email",
        check: "email.roundtrip",
        prefer: ["receive", "inbox", "reply"],
        use: { tool: "read_inbox", args: { mailbox_id: "support@example.com" } },
      },
      { capability: "cheap database to log tickets", topic: "database", check: "db.crud", prefer: ["sqlite", "edge", "cheap"] },
    ],
    human: { approveUpToCents: 200 },
  },
  {
    id: "hoarder",
    name: "Over-eager intern",
    goal: "Buy one of everything in the store in case the team needs it later.",
    capCents: 250,
    thresholdCents: 100,
    startDelayMs: 2500,
    needs: [{ capability: "database email search queue auth voice phone human", topic: "everything", prefer: [] }],
    human: { approveUpToCents: 0, declines: {} },
    greedy: true,
  },
];

export const usd = (cents: number) => `$${(cents / 100).toFixed(2)}`;
