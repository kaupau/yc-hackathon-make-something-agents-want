// Bodega hackathon demo. Records the real local store (Blaxel sandboxes, Stripe sandbox payments)
// and the six-agent swarm floor; the terminal scene replays a real Claude Code run verbatim.
import { spawn } from "node:child_process";
import path from "node:path";

const SWARM_DIR = "/private/tmp/claude-501/-Users-kaushik-Documents-Work/85c52ea8-f46b-4de9-9752-e5e9da361d29/scratchpad/nifty/experiments/bodega/swarm";
const PW_DIR = "/Users/kaushik/Documents/Work/hackathon/agents-want-marketplace/experiments/marketplace-mcp";

let swarmProc = null;

export default {
  name: "bodega-demo",
  out: "out",
  viewport: { width: 1440, height: 810 },
  colorScheme: "light",
  chrome: { padX: 104, radius: 12, titlebar: { url: "bodega-production-4802.up.railway.app" } },
  sceneStyle: { backdrop: "plain" },
  gif: false,

  brand: {
    tokens: {
      bg: "#f1ece1", fg: "#161513", "fg-muted": "#4a463f", surface: "#faf7f0",
      border: "rgba(22,21,19,.18)", divider: "rgba(22,21,19,.32)",
      accent: "#d1331b", accent2: "#f7d64a",
      sans: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Inter, Arial, sans-serif',
      mono: 'ui-monospace, "SF Mono", SFMono-Regular, Menlo, Consolas, monospace',
    },
    display: '-apple-system, BlinkMacSystemFont, "Helvetica Neue", Inter, Arial, sans-serif',
    displayWeight: 900,
    captionBg: "#161513", captionFg: "#f1ece1", dim: 0.55,
  },

  app: { baseURL: "http://127.0.0.1:8787", projectDir: PW_DIR },

  narration: {
    provider: "elevenlabs",
    voice: "SAz9YHcvj6GT2YYXdXww",
    model: "eleven_multilingual_v2",
    apiKeyCommand: "doppler secrets get ELEVENLABS_API_KEY -p airwave -c dev --plain",
    lead: 0.5, tail: 0.6,
  },

  shots: [
    { type: "scene", name: "sting", layout: "sting", duration: 1.8, backdrop: "plain",
      transition: { type: "cut" },
      props: { wordmark: "bodega.", subtitle: "tools for agents", size: 190 } },

    { type: "scene", name: "title", layout: "title", duration: 6.4, backdrop: "plain",
      transition: { type: "fade", duration: 0.5 },
      narration: "Agents only have the tools a human wired in before the task started. Bodega lets them shop mid-task.",
      props: { eyebrow: "Make something agents want", title: "A corner store\nwhere the customer\nis an agent.", subtitle: "Find it. Try it. Put it to work." } },

    { type: "app", name: "home", start: "/", transition: { type: "fade", duration: 0.6 },
      zoom: { from: 1, to: 1.03, at: [0.3, 0.35] },
      narration: "Vendors fund free trials. Humans set a cap and an approval threshold. Every number on that receipt is live from the ledger, including what it charged humans for trials: nothing.",
      action: async (d) => {
        await d.hold(1.6);
        await d.focus(".receipt", { fill: 0.5 });
        await d.hold(4.2);
        await d.unfocus();
        await d.hold(1.2);
        await d.freeze();
        await d.hold(0.6);
      } },

    { type: "app", name: "shelf", start: "/", transition: { type: "fade", duration: 0.45 },
      zoom: { from: 1, to: 1.03, at: [0.5, 0.6] },
      narration: "Eleven listings on the shelf: price tags, free-trial stickers, and an honest stamp. Two providers are real today, Primitive and Inkbox. The rest are marked mock.",
      action: async (d) => {
        await d.scrollTo(".shelf-head", { duration: 1.2, margin: 40 });
        await d.hold(1.0);
        await d.focus(".shelf-row article >> nth=0", { fill: 0.42 });
        await d.hold(2.6);
        await d.unfocus();
        await d.hold(1.4);
        await d.freeze();
        await d.hold(0.5);
      } },

    { type: "scene", name: "ch1", layout: "chapter", duration: 4.0, backdrop: "plain",
      transition: { type: "fade", duration: 0.4 },
      narration: "Here is one agent doing the whole loop, for real.",
      props: { num: "01", eyebrow: "Claude Code, Bodega plugin", title: "An agent shops." } },

    { type: "scene", name: "terminal", layout: "terminal", duration: 28.4, backdrop: "plain",
      transition: { type: "fade", duration: 0.5 },
      narration: "Claude Code asks for two-way email. Need returns three candidates. Compare boots real Blaxel sandboxes and runs an email round trip through Bodega's metering proxy, on the vendors' dime. Primitive passes in about a second; the other two fail, and say why. The agent buys Primitive for two dollars, under the human's threshold: a real Stripe sandbox receipt, tools unlocked, three dollars left. Then it reviews all three, so every vendor learns why it won or lost.",
      props: {
        eyebrow: "Real run · 12 turns · 25 s · $0.26", title: "need → compare → buy → review", size: 23, cps: 30,
        lines: [
          { cmd: 'claude "Our support bot must email customers and read their replies. Find a provider, prove it works, buy it within $5."', pause: 500 },
          { out: '<span class="dim">⏺</span> bodega:need(<span class="dim">"two-way email for a support bot"</span>)', gap: 80 },
          { out: '  primitive-email $2.00 · inkbox-email $1.50 · postpigeon-email $0.90  <span class="dim">vendor-funded trials</span>', gap: 420 },
          { out: '<span class="dim">⏺</span> bodega:compare([primitive, inkbox, postpigeon], <span class="dim">email.roundtrip</span>)', gap: 700 },
          { out: '  <span class="ok">✓</span> primitive-email   send 738 ms · deliver 270 ms   <span class="dim">real Blaxel sandbox</span>', gap: 120 },
          { out: '  ✗ inkbox-email      HTTP 502 <span class="dim">no provider key configured</span>', gap: 120 },
          { out: '  ✗ postpigeon-email  HTTP 401 <span class="dim">receive refused</span>', gap: 120 },
          { out: '  <span class="dim">→ suggestion:</span> primitive-email, lowest latency among passing checks', gap: 520 },
          { out: '<span class="dim">⏺</span> bodega:buy(<span class="dim">"primitive-email"</span>)   $2.00 of $5.00 · under the $3 threshold', gap: 160 },
          { out: '  <span class="ok">paid</span> · receipt pi_3URqmh2M1S84n0j812RwPky6 · Stripe sandbox', gap: 120 },
          { out: '  tools unlocked: send_email, ask_by_email', gap: 420 },
          { out: '<span class="dim">⏺</span> bodega:wallet()   spent $2.00 · $3.00 left · 1,000 credits', gap: 420 },
          { out: '<span class="dim">⏺</span> bodega:review(primitive, <span class="ok">chosen</span>) · review(inkbox, rejected) · review(postpigeon, rejected)', gap: 300 },
        ],
      } },

    { type: "scene", name: "ch2", layout: "chapter", duration: 4.0, backdrop: "plain",
      transition: { type: "fade", duration: 0.4 },
      narration: "Now the part no human would ever want to do.",
      props: { num: "02", eyebrow: "Swarm floor", title: "Six agents,\none store." } },

    { type: "app", name: "swarm", start: "/", transition: { type: "fade", duration: 0.6 },
      zoom: { from: 1, to: 1.025, at: [0.5, 0.45] },
      narration: "Six agents with six different jobs shop at the same time. Separate wallets, scripted humans answering approval emails, and a shared board so nobody repeats a trial. One purchase gets vetoed. One agent hits its cap and Bodega refuses it server-side.",
      action: async (d) => {
        swarmProc = spawn("npm", ["run", "swarm", "--", "--pace", "2", "--bodega-port", "8791"], { cwd: SWARM_DIR, stdio: "ignore", detached: true });
        await d.hold(7);
        await d.page.goto("http://127.0.0.1:8790/", { waitUntil: "domcontentloaded" });
        await d.settle(0.6);
        await d.hold(6.5);
        await d.scroll(420, { duration: 1.3 });
        await d.hold(5.0);
        await d.freeze();
        await d.hold(0.6);
        try { process.kill(-swarmProc.pid); } catch {}
      } },

    { type: "app", name: "portal", start: "/portal", transition: { type: "fade", duration: 0.5 },
      zoom: { from: 1, to: 1.03, at: [0.4, 0.4] },
      narration: "The back office is the vendor's view: trials, checks passed, chosen or rejected, revenue, and what the agents said. Primitive sold. Inkbox and PostPigeon learn why they lost.",
      action: async (d) => {
        await d.hold(1.2);
        await d.focus("section.vendor >> nth=0", { fill: 0.78 });
        await d.hold(4.6);
        await d.unfocus();
        await d.hold(1.4);
        await d.freeze();
        await d.hold(0.5);
      } },

    { type: "scene", name: "stack", layout: "features", duration: 11, backdrop: "plain",
      transition: { type: "fade", duration: 0.5 },
      narration: "Under the hood: hosted on Railway and metered through Manufact's gateway. Sandboxes on Blaxel. Email through Primitive. Payments and the Machine Payments Protocol on Stripe. Shared state in InsForge. And a Claude Code plugin, so any agent can shop here.",
      props: { eyebrow: "Built this weekend on", title: "Sponsors as inventory.", items: [
        { icon: "▣", title: "Manufact + Railway", body: "One MCP server, eight tools, fronted by the Manufact gateway" },
        { icon: "◫", title: "Blaxel + Primitive", body: "Real sandboxes run real email round trips on the vendor's dime" },
        { icon: "◎", title: "Stripe + InsForge", body: "Sandbox receipts, MPP over MCP, shared wallets and funnels" },
      ] } },

    { type: "scene", name: "outro", layout: "outro", duration: 4.0, backdrop: "plain",
      transition: { type: "fade", duration: 0.75 },
      narration: "Bodega. Tools for agents. Nothing pre-installed.",
      props: { wordmark: "bodega.", subtitle: "Tools for agents. Nothing pre-installed.", url: "github.com/kaupau/yc-hackathon-make-something-agents-want" } },
  ],
};
