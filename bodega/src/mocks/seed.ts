// Seed catalog. Email is the one real head-to-head category (Primitive, Inkbox); PostPigeon and
// every non-email listing are mocked vendors. Phone and human are the original Bodega
// capabilities, kept as buy-only listings (real APIs in PLAN.md §3.1 and §3.4 if time allows).

import type { CheckSpec, Listing, TrialPolicy, UpstreamConfig, Vendor } from "../contracts/index.js";

export const MOCK_VENDOR_BASE = process.env.MOCK_VENDOR_BASE ?? "http://localhost:4900";

const trial = (unit: TrialPolicy["unit"], per_agent: number, pool_total: number): TrialPolicy => ({
  unit,
  per_agent,
  pool_total,
  pool_used: 0,
  expires_after_min: 30,
  max_concurrent: 10,
});

const baseImage = (install: string[] = []) => ({
  image: "blaxel/base-image:latest",
  install,
  env_hint: {
    BODEGA_TOOL_BASE_URL: "vendor API base URL, routed through the Bodega metering proxy",
    BODEGA_TOOL_KEY: "Bodega trial token; send it as the vendor's usual auth header",
  },
});

export const VENDORS: Vendor[] = [
  { id: "primitive", name: "Primitive", website: "https://primitive.dev", contact_email: "vendor@primitive.example" },
  { id: "inkbox", name: "Inkbox", website: "https://inkbox.ai", contact_email: "vendor@inkbox.example" },
  { id: "postpigeon", name: "PostPigeon (mock)", website: "https://postpigeon.example", contact_email: "hi@postpigeon.example" },
  { id: "tabletop", name: "TableTop DB (mock)", website: "https://tabletop.example", contact_email: "hi@tabletop.example" },
  { id: "quarry", name: "Quarry (mock)", website: "https://quarry.example", contact_email: "hi@quarry.example" },
  { id: "gatekeep", name: "GateKeep (mock)", website: "https://gatekeep.example", contact_email: "hi@gatekeep.example" },
  { id: "callwire", name: "Callwire (mock)", website: "https://callwire.example", contact_email: "hi@callwire.example" },
  { id: "seekr", name: "Seekr (mock)", website: "https://seekr.example", contact_email: "hi@seekr.example" },
  { id: "relay", name: "Relay (mock)", website: "https://relay.example", contact_email: "hi@relay.example" },
  { id: "kelam", name: "Kelam", website: "https://kelam.sh", contact_email: "vendor@kelam.example" },
  { id: "bodega", name: "Bodega house listings", website: "https://bodega.example", contact_email: "team@bodega.example" },
];

export const CHECKS: CheckSpec[] = [
  { id: "email.roundtrip", category: "email", description: "Create or get an inbox, send to itself, poll until received", metrics: ["send_ms", "deliver_ms"] },
  { id: "db.crud", category: "database", description: "Create a table, insert, read back, delete", metrics: ["p50_ms"] },
  { id: "auth.signup_login", category: "auth", description: "Sign up a test user, log in, verify the session", metrics: ["total_ms"] },
  { id: "voice.tts_latency", category: "voice", description: "Synthesize one sentence, time to first audio byte", metrics: ["first_byte_ms"] },
  { id: "search.query", category: "search", description: "Run one query, extract the top page as markdown", metrics: ["total_ms"] },
  { id: "queue.enqueue_consume", category: "queue", description: "Enqueue a job and consume it", metrics: ["roundtrip_ms"] },
];

export const LISTINGS: Listing[] = [
  {
    id: "primitive-email",
    vendor_id: "primitive",
    name: "Primitive",
    category: "email",
    one_line: "Managed inboxes for agents: send, receive and get threaded replies in one call",
    keywords: ["email", "inbox", "send", "receive", "reply", "replies", "mail", "agent"],
    docs_url: "https://docs.primitive.dev/llms.txt",
    quickstart:
      "await fetch(`${process.env.BODEGA_TOOL_BASE_URL}/send-mail`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.BODEGA_TOOL_KEY}`, 'content-type': 'application/json' }, body: JSON.stringify({ to, subject, body }) })",
    sandbox: baseImage(),
    checks: ["email.roundtrip"],
    trial: trial("api_calls", 20, 500),
    price: { buy_usd: 2.0, unit_label: "1,000 emails" },
    adds_tools: ["send_email", "ask_by_email"],
    real: true,
  },
  {
    id: "inkbox-email",
    vendor_id: "inkbox",
    name: "Inkbox",
    category: "email",
    one_line: "Persistent agent identity with email, phone and iMessage",
    keywords: ["email", "inbox", "send", "receive", "identity", "imessage", "mail", "agent"],
    docs_url: "https://inkbox.ai",
    quickstart:
      "await fetch(`${process.env.BODEGA_TOOL_BASE_URL}/...`, { headers: { 'X-API-Key': process.env.BODEGA_TOOL_KEY } })",
    sandbox: baseImage(),
    checks: ["email.roundtrip"],
    trial: trial("api_calls", 20, 500),
    price: { buy_usd: 1.5, unit_label: "1,000 emails" },
    adds_tools: ["send_email", "read_inbox"],
    real: true,
  },
  {
    id: "postpigeon-email",
    vendor_id: "postpigeon",
    name: "PostPigeon",
    category: "email",
    one_line: "Cheap transactional email with scoped per-trial keys",
    keywords: ["email", "send", "receive", "transactional", "mail"],
    docs_url: `${MOCK_VENDOR_BASE}/postpigeon/docs`,
    quickstart:
      "await fetch(`${process.env.BODEGA_TOOL_BASE_URL}/messages`, { method: 'POST', headers: { Authorization: `Bearer ${process.env.BODEGA_TOOL_KEY}` }, body: JSON.stringify({ to, text }) })",
    sandbox: baseImage(),
    checks: ["email.roundtrip"],
    trial: trial("api_calls", 10, 100),
    price: { buy_usd: 0.9, unit_label: "1,000 emails" },
    adds_tools: ["send_email"],
    real: false,
  },
  mockListing("tabletop-db", "tabletop", "TableTop DB", "database", "Serverless Postgres with a branch per agent task", ["database", "db", "postgres", "sql", "storage"], "db.crud", 1.0),
  mockListing("quarry-db", "quarry", "Quarry", "database", "Embedded SQLite replicated to the edge", ["database", "db", "sqlite", "sql", "edge", "storage"], "db.crud", 0.6),
  mockListing("gatekeep-auth", "gatekeep", "GateKeep", "auth", "Drop-in signup, login and sessions", ["auth", "login", "signup", "session", "users"], "auth.signup_login", 1.2),
  mockListing("callwire-voice", "callwire", "Callwire", "voice", "Realtime text-to-speech and voice agents", ["voice", "tts", "speech", "audio", "realtime"], "voice.tts_latency", 1.8),
  mockListing("seekr-search", "seekr", "Seekr", "search", "Web search with page extraction to markdown", ["search", "web", "fetch", "scrape", "markdown"], "search.query", 0.5),
  mockListing("relay-queue", "relay", "Relay", "queue", "Durable queues and cron for agent jobs", ["queue", "jobs", "cron", "background", "worker"], "queue.enqueue_consume", 0.8),
  {
    id: "phone-call",
    vendor_id: "kelam",
    name: "Kelam phone call",
    category: "phone",
    one_line: "Place a real phone call that pursues a goal and returns structured fields",
    keywords: ["phone", "call", "voice", "dial", "restaurant"],
    docs_url: "https://kelam.sh",
    quickstart: "call_phone({ number, goal, extract })",
    sandbox: null,
    checks: [],
    trial: null,
    price: { buy_usd: 0.4, unit_label: "per call" },
    adds_tools: ["call_phone"],
    real: false,
  },
  {
    id: "human",
    vendor_id: "bodega",
    name: "Ten minutes of a human",
    category: "human",
    one_line: "A person does a task over iMessage and replies, photos included",
    keywords: ["human", "person", "photo", "errand", "imessage"],
    docs_url: "https://bodega.example/human",
    quickstart: "ask_human({ task, deadline_s })",
    sandbox: null,
    checks: [],
    trial: null,
    price: { buy_usd: 2.0, unit_label: "10 minutes" },
    adds_tools: ["ask_human"],
    real: false,
  },
];

export const UPSTREAMS: UpstreamConfig[] = [
  {
    listing_id: "primitive-email",
    base_url: "https://api.primitive.dev/v1",
    auth: { header: "Authorization", format: "Bearer {key}" },
    credential: { kind: "pooled_key", env_var: "PRIMITIVE_API_KEY" },
  },
  {
    listing_id: "inkbox-email",
    base_url: "https://inkbox.ai/api/v1",
    auth: { header: "X-API-Key", format: "{key}" },
    credential: { kind: "pooled_key", env_var: "INKBOX_API_KEY" },
  },
  {
    listing_id: "postpigeon-email",
    base_url: `${MOCK_VENDOR_BASE}/postpigeon`,
    auth: { header: "Authorization", format: "Bearer {key}" },
    credential: { kind: "provision_webhook", url: `${MOCK_VENDOR_BASE}/postpigeon/provision`, revoke_url: `${MOCK_VENDOR_BASE}/postpigeon/revoke` },
  },
  ...LISTINGS.filter((l) => !l.real && l.sandbox && l.id !== "postpigeon-email").map(
    (l): UpstreamConfig => ({
      listing_id: l.id,
      base_url: `${MOCK_VENDOR_BASE}/${l.vendor_id}`,
      auth: { header: "Authorization", format: "Bearer {key}" },
      credential: { kind: "pooled_key", env_var: "MOCK_VENDOR_KEY" },
    }),
  ),
];

function mockListing(
  id: string,
  vendor_id: string,
  name: string,
  category: Listing["category"],
  one_line: string,
  keywords: string[],
  check: string,
  buy_usd: number,
): Listing {
  return {
    id,
    vendor_id,
    name,
    category,
    one_line,
    keywords,
    docs_url: `${MOCK_VENDOR_BASE}/${vendor_id}/docs`,
    quickstart: "await fetch(`${process.env.BODEGA_TOOL_BASE_URL}/...`, { headers: { Authorization: `Bearer ${process.env.BODEGA_TOOL_KEY}` } })",
    sandbox: baseImage(),
    checks: [check],
    trial: trial("sandbox_minutes", 15, 300),
    price: { buy_usd, unit_label: "first month" },
    adds_tools: [],
    real: false,
  };
}
