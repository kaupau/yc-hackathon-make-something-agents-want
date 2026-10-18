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
    settings: { stability: 0.6, similarity_boost: 0.8, style: 0.1, speed: 0.9 },
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
      narration: "Agents only have the tools a human set up for them. Bodega is a store where the agent shops for itself.",
      props: { eyebrow: "Make something agents want", title: "A store where\nthe agent\nis the customer.", subtitle: "Find a tool. Try it free. Buy it within budget." } },

    { type: "app", name: "home", start: "/", transition: { type: "fade", duration: 0.6 },
      zoom: { from: 1, to: 1.03, at: [0.3, 0.35] },
      narration: "This is the store. Vendors pay for the trials. The human sets the budget. The receipt is live: trials so far, purchases, and zero dollars charged to humans.",
      action: async (d) => {
        await d.caption("Vendors fund the trials. Humans set the budget.", "The store", { position: "top" });
        await d.hold(3.2);
        await d.clearCaption();
        await d.focus(".receipt", { fill: 0.5 });
        await d.hold(4.2);
        await d.unfocus();
        await d.hold(1.2);
        await d.freeze();
        await d.hold(0.6);
      } },

    { type: "app", name: "shelf", start: "/", transition: { type: "fade", duration: 0.45 },
      zoom: { from: 1, to: 1.03, at: [0.5, 0.6] },
      narration: "Eleven tools on the shelf, each with a price and a free trial. Two providers are real today. The rest are honestly marked as mock.",
      action: async (d) => {
        await d.scrollTo(".shelf-head", { duration: 1.2, margin: 40 });
        await d.caption("Price, free trial, and an honest REAL or MOCK stamp", "The shelf", { position: "top" });
        await d.hold(2.6);
        await d.clearCaption();
        await d.focus(".shelf-row article >> nth=0", { fill: 0.42 });
        await d.hold(2.6);
        await d.unfocus();
        await d.hold(1.4);
        await d.freeze();
        await d.hold(0.5);
      } },

    { type: "scene", name: "ch1", layout: "chapter", duration: 4.0, backdrop: "plain",
      transition: { type: "fade", duration: 0.4 },
      narration: "Here is one agent, start to finish, for real.",
      props: { num: "01", eyebrow: "Claude Code, Bodega plugin", title: "An agent shops." } },

    { type: "scene", name: "terminal", layout: "terminal", duration: 27, backdrop: "plain",
      transition: { type: "fade", duration: 0.5 },
      narration: "The agent asks for email tools. Three come back, each with a free trial. It tries all three in real sandboxes. Only Primitive passes, in about a second. It buys Primitive for two dollars. Paid, with a receipt. Then it tells each vendor why it won or lost.",
      props: {
        eyebrow: "One real run · Claude Code + the Bodega plugin", title: "Find. Try. Buy. Review.", size: 27, cps: 22,
        lines: [
          { cmd: 'claude "Our support bot needs email. Find a tool, prove it works, buy it within $5."', pause: 700 },
          { out: '<span class="dim">⏺</span> need   →  3 email tools, all with free trials', gap: 1600 },
          { out: '<span class="dim">⏺</span> compare  <span class="dim">(real sandboxes)</span>', gap: 500 },
          { out: '   <span class="ok">✓</span> Primitive   send 738 ms · deliver 270 ms', gap: 400 },
          { out: '   ✗ Inkbox      no key configured', gap: 300 },
          { out: '   ✗ PostPigeon  receive refused', gap: 1500 },
          { out: '<span class="dim">⏺</span> buy Primitive  $2.00 of $5.00', gap: 500 },
          { out: '   <span class="ok">paid</span> · Stripe receipt pi_3URqmh… · tools unlocked', gap: 1600 },
          { out: '<span class="dim">⏺</span> review  Primitive <span class="ok">chosen</span> · Inkbox rejected · PostPigeon rejected', gap: 400 },
        ],
      } },

    { type: "scene", name: "ch2", layout: "chapter", duration: 4.0, backdrop: "plain",
      transition: { type: "fade", duration: 0.4 },
      narration: "Now something no human would ever want to do.",
      props: { num: "02", eyebrow: "Swarm floor", title: "Six agents,\none store." } },

    { type: "app", name: "swarm", start: "/", transition: { type: "fade", duration: 0.6 },
      zoom: { from: 1, to: 1.025, at: [0.5, 0.45] },
      narration: "Six agents, six jobs, one store, all at once. Each has its own budget, and its own human approving by email. They share what they learn, so nobody repeats a trial. One purchase gets declined. One is refused at the cap.",
      action: async (d) => {
        swarmProc = spawn("npm", ["run", "swarm", "--", "--pace", "2", "--bodega-port", "8791"], { cwd: SWARM_DIR, stdio: "ignore", detached: true });
        // Wait only until the floor answers, and record how long that took so the segment can be
        // trimmed to start on the floor rather than on whatever page the shot opened with.
        const t0 = Date.now();
        for (let i = 0; i < 60; i++) {
          try { const r = await fetch("http://127.0.0.1:8790/"); if (r.ok) break; } catch {}
          await new Promise((r) => setTimeout(r, 250));
        }
        await d.page.goto("http://127.0.0.1:8790/", { waitUntil: "domcontentloaded" });
        await d.settle(0.8);
        const { writeFileSync, mkdirSync } = await import("node:fs");
        mkdirSync(path.join(import.meta.dirname, "out", ".work"), { recursive: true });
        writeFileSync(path.join(import.meta.dirname, "out", ".work", "swarm-wait.json"), JSON.stringify({ seconds: (Date.now() - t0) / 1000 + 1.2 }));
        await d.caption("Six agents, separate budgets, humans approving by email", "Swarm floor", { position: "top" });
        await d.hold(6.5);
        await d.clearCaption();
        await d.scroll(420, { duration: 1.3 });
        await d.hold(5.0);
        await d.freeze();
        await d.hold(0.6);
        try { process.kill(-swarmProc.pid); } catch {}
      } },

    { type: "app", name: "portal", start: "/portal", transition: { type: "fade", duration: 0.5 },
      zoom: { from: 1, to: 1.03, at: [0.4, 0.4] },
      narration: "Vendors get the back office. Who tried it, who chose it, who paid, and what the agent said. Primitive sold. The other two learn why they lost.",
      action: async (d) => {
        await d.caption("Vendors see who tried, who bought, and why", "Back office", { position: "top" });
        await d.hold(3.0);
        await d.clearCaption();
        await d.focus("section.vendor >> nth=0", { fill: 0.78 });
        await d.hold(4.6);
        await d.unfocus();
        await d.hold(1.4);
        await d.freeze();
        await d.hold(0.5);
      } },

    { type: "scene", name: "stack", layout: "features", duration: 12, backdrop: "plain",
      transition: { type: "fade", duration: 0.5 },
      narration: "Built this weekend on the sponsors: one MCP server through Manufact, sandboxes on Blaxel, email on Primitive, payments on Stripe, shared state in InsForge, and a Claude Code plugin.",
      props: { eyebrow: "Built this weekend on", title: "The sponsors are the inventory.", items: [
        { icon: "▣", title: "Manufact", body: "One MCP server, eight tools, behind the Manufact gateway" },
        { icon: "◫", title: "Blaxel + Primitive", body: "Real sandboxes, real email round trips, paid by the vendor" },
        { icon: "◎", title: "Stripe + InsForge", body: "Sandbox receipts, shared wallets, vendor funnels" },
      ] } },

    { type: "scene", name: "outro", layout: "outro", duration: 4.0, backdrop: "plain",
      transition: { type: "fade", duration: 0.75 },
      narration: "Bodega. Tools for agents.",
      props: { wordmark: "bodega.", subtitle: "Tools for agents.", url: "github.com/kaupau/yc-hackathon-make-something-agents-want" } },
  ],
};
