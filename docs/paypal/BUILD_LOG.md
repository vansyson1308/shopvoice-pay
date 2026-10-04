# Build log

Running log for ShopVoice Pay (PayPal AI Hackathon). Newest entry first. Times are Vietnam time (UTC+7).

## 2026-10-04 (Sun): M0 started

**Done**
- Read the hackathon rules and resources pages.
  - Rules relevant to us: projects must be "newly created or significantly updated after the start of the Hackathon Submission Period" (Oct 1, 2026 9:00 PT), with no financial or preferential support from the sponsor. The rules say nothing about entering other hackathons.
  - Submission period: Oct 1 – Nov 12, 2026, 12:00 PT. Judging: Dec 1–15. Winners: about Dec 21.
- Built the new repository locally (see DECISIONS.md D8: `vansyson1308/shopvoice-pay` does not exist yet).
  1. `Import from groceryclaw @0fb3af4 (MIT)`: a verbatim copy of mcp-server, alexa-sim, common, migrations 001–018, seeds, and the scripts, tests and tools they need (131 files).
  2. Restructure: `alexa-sim` → `console`, `db/v2` → `db`, `tests/v2` → `tests/{unit,db}`. Pruned Telegram, Redis/BullMQ, Excel/XML and notifier modules from `packages/common`. New root package/tsconfig/lockfile.
  3. CI (`.github/workflows/ci.yml`): lint, format, typecheck, SQL guard, unit tests, Postgres 16 migrations and RLS tests, voice e2e. A sandbox job runs only when the repo has `PAYPAL_CLIENT_ID`.
  4. Payments client (`apps/mcp-server/src/payments`) with `PAYPAL_MODE=mock`, the spike runners, sandbox tests, and a lint rule that refuses live PayPal hosts.
- Researched the PayPal APIs from the OpenAPI specs (Orders v2, Payments v2, Vault v3, Payouts, Webhooks, Cart API v1) and the unpacked `@paypal/agent-toolkit@1.11.0`. Findings and ambiguities are in SPIKE.md.
- Real network probes (no credentials needed):
  - The sandbox OAuth endpoint is reachable (`invalid_client` with bad credentials).
  - The remote PayPal MCP server's Streamable HTTP endpoint is `/mcp`, not the documented `/http` (404). It only supports browser OAuth (authorization_code + PKCE, no client credentials).

**Verified locally**
- `npm run lint`, `format:check`, `typecheck`, `sql:guard`: pass.
- Unit tests: 136/136 (115 imported + 21 new payments-client tests).
- DB tests on Postgres 16 (`npm run test:db` after `db:migrate`): 30/30.
- `npm run demo:e2e` (memory backend, rules brain): 5/5 turns.
- `npm run spike` in mock mode: 12 pass, 4 info, 1 skipped (webhook registration needs a public URL). This is a self-test of the runner only.
- `npm run test:sandbox` without credentials: 5 skipped, as intended.

**Blocked on the owner**
- Create the empty public repo `vansyson1308/shopvoice-pay` and give push access (or approve the agent creating it).
- Sandbox REST app plus 1 personal and 4 business sandbox accounts, added as environment variables (SPIKE.md, "Owner action").

**Next**
- Push the history to the new repo, open the first PR, and get CI green on GitHub.
- Run the sandbox spike and fill in SPIKE.md. Confirm or revise D1/D2.
- M1: migration 019, policy engine, ledger.
