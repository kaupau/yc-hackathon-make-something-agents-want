# Live demo runbook (2 minutes on stage)

Written 2026-10-18 early morning. Everything below was exercised the night before; the traps are real.

## Before you walk up (10 minutes before)

1. **Fresh agent identity.** A session's trial allotment never resets, so a rehearsal that trialed Primitive on a wallet burns that wallet's one Primitive trial. Mint a new customer token on the hosted store right before the demo (operator console `/admin/customers/console`, or `npm run customers -- create --email you@example.com --cap 500 --threshold 300` in `bodega/`). Configure it in Claude Code: `/plugin configure bodega@bodega`.
2. **Payments.** Railway runs `BODEGA_PAYMENT_FLOW=mpp`, which means `buy` hands back a payment link that only an MPP buyer wallet can settle. For a buy that ends in `paid` on stage, the Railway service must be on `BODEGA_PAYMENT_FLOW=direct` (Stripe sandbox test card), redeployed. If it is still `mpp`, stop the live demo after `compare` and show the paid purchase in the video instead.
3. **Sandbox cap.** Hosted allows 3 active trials; each lives 5 minutes. Do not run the swarm against the hosted store within 5 minutes of the demo.
4. **Open on the second screen:** the back office `https://bodega-production-4802.up.railway.app/portal` and the Manufact analytics for `warm-spark-aqsz0`.
5. **Fallback ready:** `experiments/bodega/demo/out/bodega-demo.mp4` queued in a player.

## The two minutes

**0:00** Storefront on screen (`/`). One sentence: *"Agents only have the tools a human wired in before the task started. Bodega is a corner store where the agent is the customer."* Point at the receipt: trials cost humans nothing.

**0:20** Claude Code, Bodega plugin connected, no other MCP. Paste:

> Our support bot must email customers and read their replies. Use the Bodega store: find a provider, prove it works with email.roundtrip, buy the winner within my $5 budget, and show me the wallet.

Narrate what appears: `need` (three providers, prices, free trials) → `compare` (real Blaxel sandboxes; Primitive passes in about a second, the others fail and say why) → `buy` (paid, Stripe sandbox receipt, tools unlocked) → `wallet` (spent $2, $3 left) → `review` ×3.

**1:20** Switch to the back office. Primitive stamped CHOSEN / SOLD, the funnel, and the agent's own reason under "What agents said." *"Vendors fund the trials and learn why they won or lost."*

**1:40** One line on the swarm: *"Six agents, six jobs, one store, separate wallets and humans. No person would ever want to run that."* Show the floor or the replay for ten seconds.

**1:55** Close: *"Nothing pre-installed. The agent found it, tried it, bought it, and used it."*

## If something breaks

| Symptom | Cause | Do |
|---|---|---|
| `compare` says "Trial check could not complete", no trial_id | wallet already used its Primitive allotment, or the 3-sandbox cap is full | switch to the pre-minted spare token; or show the video's terminal scene |
| `buy` returns `ready` with a payment URL | Railway on `mpp` | say "that is the Machine Payments challenge; here is the same buy settled" and cut to the video |
| Tools don't appear in Claude Code | plugin token not configured | `/plugin configure bodega@bodega`, or `claude mcp add --transport http bodega <url>/mcp --header "Authorization: Bearer <token>"` |
| Inkbox fails with 502 | no Inkbox key on the server | expected; it is on camera too |
