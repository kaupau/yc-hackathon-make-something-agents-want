# Experiments scoreboard

One folder per idea. Copy `_template/` to start one. Update the row when the status changes so we can see at a glance what is worth more time.

Status ladder: `idea` → `building` → `demoable` (ran end to end once) → `shipped` (submitted) / `dropped`.

| Experiment | One-liner | Tracks | Status | Smallest test done? | Verdict |
|---|---|---|---|---|---|
| [bodega](bodega/) | Agent shops for capabilities mid-task and pays from a human-set budget | Manufact, Stripe, Primitive, Inkbox, Blaxel, Armature, InsForge | candidate | spike only (tool refresh across clients, see `bodega/spike/`) | — |

## How we judge an experiment
- Does it use the sponsor's product for real (judges are the founders)?
- Does the two-minute demo have one moment nobody else in the room has?
- Did the smallest test pass in under two hours? If not, drop or shrink.
- Which prizes does it plausibly reach, and how much cash is that (see `../SPONSORS.md`)?
