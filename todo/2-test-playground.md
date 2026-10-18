# 2. Test: real trials and a playground

An agent (or a person) should be able to try a provider for free in a sandbox, see real output and timings, and compare providers in the same category.

## Where it stands

- `compare` implements only `email.roundtrip`. Every other check throws `Only email.roundtrip is implemented` (`bodega/src/runtime/runtime.ts:117`), so database, auth, search, queue and voice comparisons return errors.
- Locally the runtime is `simulated`: `run_trial` accepts commands but runs nothing, and comparisons are labeled and never ranked. Real execution needs `BODEGA_RUNTIME=blaxel` (configured on Railway).
- Mock vendors point at `MOCK_VENDOR_BASE` (`http://localhost:4900`, `bodega/src/mocks/seed.ts:7`) and nothing serves that address.
- The proxy allowlist covers only Primitive, Inkbox and PostPigeon paths (`allowedUpstreams` in `bodega/src/server.ts:248`). Any other provider is refused even with a key.
- Quickstarts for most listings are placeholders (`${BODEGA_TOOL_BASE_URL}/...`, e.g. `bodega/src/mocks/seed.ts:189`).
- There is no playground UI. Trials exist only as MCP calls, and their results only show up in the vendor funnel at `/portal`.

## To do

- [ ] For each real listing added in [1-search.md](1-search.md): an `UPSTREAMS` entry (base URL, auth header format, pooled vendor-funded trial key from env), allowlisted paths in `server.ts`, and a real quickstart snippet.
- [ ] Write check adapters next to `emailRoundtripScript` in `bodega/src/runtime/checks.ts`, and route `compare` by check id:
  - [ ] `db.crud`: create table, insert, read back, drop; report `p50_ms`
  - [ ] `auth.signup_login`: sign up a test user, log in, verify the session; report `total_ms`
  - [ ] `search.query`: one query, extract the top page to markdown; report `total_ms`
  - [ ] `queue.enqueue_consume`, `voice.tts_latency` (lower priority)
- [ ] Meter `sandbox_minutes` trials. Only `runs` and API-call units are recorded today, so minute-based trial pools never shrink.
- [ ] Playground page (`/playground/:listing`): shows the quickstart, a code box that calls `start_trial`/`run_trial` for a signed-in customer, stdout and timing, and a side-by-side view for `compare`. It reads the same ledger as the funnel.
- [ ] Vendor-funded trial keys: each real vendor provides a pooled trial key, or Bodega funds the pool and bills the vendor. Document which, per vendor.
- [ ] Remove or clearly fence PostPigeon's deliberately failing receive once a second real email provider (Inkbox key, or Resend/AgentMail) can be compared against Primitive.

## Done when

On the hosted Bodega, `compare(["<db A>", "<db B>"], "db.crud")` runs both in Blaxel sandboxes and returns measured `p50_ms` with a suggestion. A person can repeat the same trial from the playground page and see the same numbers.
