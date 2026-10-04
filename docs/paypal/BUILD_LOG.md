# Build log

Running log for ShopVoice Pay (PayPal AI Hackathon). Newest entry first. Times are Vietnam time (UTC+7).

## 2026-10-05 (Mon, 03:45 VN): M2 build complete except the live hosted preview

**Done (all merged into `main` with CI green)**
- PR #8 (`m2/payment-tools`): the payment tools and the approval ladder, as described in the previous entry.
- PR #9: **owner API and PayPal webhooks**.
  - `/owner/api/*` accepts static tokens only. OAuth tokens and browser `Origin` requests get 403.
  - Approve and decline by payment id. PayPal return pages and a labelled simulated PayPal page in mock mode.
  - Webhook: signature verified on the raw body, `custom_id` mapped to its tenant by a definer function (migration 022), then `sync()` re-reads PayPal. The payload never sets money state (D11).
- PR #10: **"Try the demo"**. Each console visitor gets a private sample shop (migration 023; D12). Reset demo. Idle visitor shops are removed after 3 days. Per-IP and global limits.
- PR #11: **Claude as the console brain**, through Claude in Amazon Bedrock (`AnthropicBedrockMantle`) or the Anthropic API, with the rules brain as an offline fallback.
  - Voice approval: the host asks "Say yes to approve $142 to Valley Farm Eggs", and its own code matches the answer (D13).
- PR #12: **console redesign**. Tabs: Talk, Approvals, Ledger and Suppliers (AG Grid Community, CSP-nonce theming), and Rules & PayPal.
  - The ledger shows "honor period ends" (3 days) and "hold expires" (29 days).
  - Payment dialog with delivery and refund forms; CSV export; PayPal approval QR; honesty banner.
- PR #13: **agent evals and browser e2e**.
  - 22 safety cases with a scripted adversarial model; the CI gate is 100%. 15 quality cases.
  - A Playwright hero story runs in CI and fails on any console error or CSP violation.
  - The evals found two real bugs, both fixed: a question containing "OK" approved a payment, and refunds were offered on seeded history with no capture. The host now enforces intent guards (D14).
- PR #14: **Render Blueprint** (`render.yaml`; D15; `docs/paypal/DEPLOY.md`).
  - Services: console and MCP server as Docker web services, plus Postgres 16 as a private service on a disk. Managed Postgres cannot grant the BYPASSRLS the migrations need.
  - A pre-deploy step runs migrations as the superuser and creates the RLS-bound login `shopvoice_app`.
  - The MCP server refuses to start in production as a superuser or BYPASSRLS login.
  - X-Forwarded-For trusted-hop setting for Render's proxy. CI builds and inspects both images.
- PR #15: **public pages** (docs, privacy, terms, support; English and Vietnamese) and the sign-in pages now describe ShopVoice Pay, with retention matching the code (audit log 90 days, visitor shops 3 idle days).

**Verified (local, on `main` at 5b898b6, and in CI)**
- Unit: 239/239. DB: 57/57 on Postgres 16.
- Evals: safety 100% of 22, quality 100% of 15 (rules brain).
- Browser e2e: 1/1. `demo:e2e`: passed.
- Policy engine coverage: 100% lines, 98.89% branches.
- Deploy path, end to end on a fresh Postgres 16 cluster:
  - built both images, ran the pre-deploy step twice;
  - started both containers as `shopvoice_app`;
  - ran the hero flow by API and in Chromium, with no console errors.
- `PAYPAL_MODE=sandbox` with real sandbox credentials starts against Postgres and creates visitor shops.

**Simulated (labelled in the product)**
- In mock mode: the PayPal approval page (`/sim/paypal`) and the saved PayPal account of each demo shop.
- Seeded payment history has no PayPal transactions behind it, so refunds are offered only on charges made in the session.

**Hosted preview: not live yet.** It needs the owner's Render account (DEPLOY.md, steps 1–5).

**Blocked on the owner**
- Render account and Blueprint, about $21/month.
- Bedrock credentials (`BEDROCK_AWS_ACCESS_KEY_ID` and `BEDROCK_AWS_SECRET_ACCESS_KEY`, with `bedrock-mantle:CreateInference` on the Claude model ARNs in us-east-1), or `ANTHROPIC_API_KEY`.
- `SANDBOX_SUPPLIER_EMAILS` for Valley Farm Eggs, Hillside Bakery and Harbor Wholesale.
- GitGuardian dashboard: incidents 37864810 and 37865123 were test fixtures, removed from the branch history before merge. They can be resolved as false positives.

## 2026-10-05 (Mon, 02:30 VN): M2 started: guardrails, US seed, payments in the MCP tools

**Done**
- PR #6 (merged):
  - headless sandbox approval is test-only, behind an explicit flag, and refused in production and on hosting platforms; a test proves it;
  - DECISIONS D1 "Production path" covers multiparty onboarding and cites the sandbox errors `BILLING_AGREEMENT_NOT_FOUND` and 403 on void.
- PR #7: **US demo seed**. "Maria's Corner Market (demo)", America/New_York, 47 generic products, 4 fictional suppliers (`@business.example.com` payees, overridable with `SANDBOX_SUPPLIER_EMAIL(S)`). All money is integer cents (migration 020). Hero numbers are pinned by tests: milk $84 (autopay) and eggs $142 at +31% (step-up).
- Payments wired into the MCP tools:
  - `confirm_reorder` now pays within the rules;
  - new tools: `get_payment_status`, `record_delivery`, `request_refund` (two-step, signed token), `get_spend_summary`, `explain_payment`, `get_spending_policy`, `set_spending_policy`;
  - approval ladder: console → MCP form elicitation → PayPal approval page (URL elicitation, else link) → decline with a reason (DECISIONS D10);
  - money tools commit each ledger write on its own;
  - migration 021: one live payment per draft, plus `owner_elicitation`.

**Verified locally**
- Unit: 210/210, including 11 payment-tool tests. Every tool result, elicitation request and audit entry is checked for approval tokens, the vault id and PayPal authorization/capture ids.
- DB: 51/51 on a fresh Postgres 16 cluster, with migrate → rollback → migrate for 020 and 021.
- Policy coverage: 100% lines, 98.55% branches.
- `demo:e2e`: 5/5. The confirm turn now says "Valley Farm Eggs $142 needs your OK and Northside Dairy $84 held until delivery. Large eggs 30 ct is up 31%."

**Simulated**
- In `PAYPAL_MODE=mock`, demo shops get a simulated saved PayPal account at startup so auto-pay works at once. Sandbox mode needs the owner's own "Connect PayPal" (console, next PR).

**Blocked on the owner**
- Bedrock credentials (`BEDROCK_*`) or an Anthropic API key.
- `SANDBOX_SUPPLIER_EMAILS` for the other three suppliers.

## 2026-10-05 (Mon, early VN): M1 money core complete

**Done**
- PR #4 (merged):
  - **Migration 019**: 8 tenant-scoped tables with forced RLS. Ledger invariants are DB CHECKs; the event log is append-only; each request id can be recorded once.
  - **Ledger state machine**, property-tested over 5,000 random sequences.
  - **PaymentsRepository** with memory and Postgres implementations, held to one shared 10-case contract.
  - Fixed a transaction bug that erased application error classes and codes.
- PR #5: **PaymentsService**:
  - Connect PayPal (vault)
  - pay for a draft within policy: autopay hold, step-up approval (voice, tap or PayPal QR), or block
  - capture on delivery (full, partial + void, none, hold for over-delivery), reauthorize past the honor period
  - refund, Payouts settlement, sync/retry with deterministic `PayPal-Request-Id`s
- **Real-sandbox proof of the hero money path through the service**: vaulted hold of $84, then 10 of 12 delivered → $70 captured and $14 released (PayPal shows `VOIDED`), then a $7 refund and a $63 supplier payout.

**Verified locally**
- Unit tests: 192/192.
- DB tests: all green on Postgres 16 (RLS, contract, imported suites).
- Sandbox: 5/5 suite + service hero path.
- Coverage: policy 98.6% branches; service 95% lines.

**Next (M2):**
- Wire the service into the MCP tools: paying `confirm_reorder`, `record_delivery`, `request_refund`, `get_payment_status`, `get_spend_summary`, `explain_payment`, `get/set_spending_policy`.
- US seed.
- LLM brain (Bedrock).
- Console with approvals and the AG Grid ledger.

## 2026-10-05 (Mon, 00:30 VN): Day-1 spike run against the real sandbox; settlement confirmed

**Owner set up:** sandbox app "ShopVoice Pay" (Merchant; the platform account is a US business sandbox account; Vault, Payouts, Invoicing and Transaction search enabled), 1 personal and 4 business US sandbox accounts, env vars, repo Actions secrets, and branch protection on `main`.

**Done**
- Sandbox buyer approval automated with Playwright (`scripts/paypal/sandbox-approver.mjs`). Inside this environment Chromium trusts the egress proxy CA by its SPKI pin; certificate checks stay on.
- Main spike: 15 pass / 6 info / 0 fail. Toolkit spike: 10 pass / 2 info. `npm run test:sandbox`: 5/5, including vaulted authorize → partial capture → void → refund with no person involved.
- **Settlement decision confirmed: platform wallet + Payouts** (DECISIONS.md D1). Findings:
  - vault + third-party payee → `BILLING_AGREEMENT_NOT_FOUND`;
  - the platform cannot void a supplier-payee authorization → 403 `PERMISSION_DENIED`;
  - the platform-payee flow works end to end;
  - Payouts reach `SUCCESS` in 31 s.
- Other findings:
  - authorizations expire after 29 days; reauthorizing early → `REAUTHORIZATION_TOO_SOON`;
  - void after a final capture → `PREVIOUSLY_CAPTURED`;
  - `webhook_id` must be alphanumeric;
  - transaction search lags in sandbox; `get_merchant_insights` is unsupported in sandbox;
  - the remote PayPal MCP server rejects REST tokens (404) and needs a browser OAuth login.
- The mock now reproduces each of these and has tests for them (22 client tests).

**Next (M1):** migration 019 + RLS tests, memory/pg ledger + property test, vault onboarding, paying `confirm_reorder`, `record_delivery`, refunds.

## 2026-10-04 (Sun, late): repo live, CI green, M1 started

**Done**
- The owner created `vansyson1308/shopvoice-pay`, since the GitHub connector cannot create repositories (403). `main` holds only the import commit, which now also carries NOTICE and a credit README, as the owner asked.
  - The rest went up as PR vansyson1308/shopvoice-pay#1 (`m0/foundation`).
- GitGuardian flagged the CI's per-run Postgres password env line as a "Generic Password". It was a false positive (a throwaway value made from `github.run_id`).
  - Fixed by using `POSTGRES_HOST_AUTH_METHOD: trust` for the localhost-only service container, with no credential at all.
  - The unmerged PR branch was rewritten so the line never existed. The incident may still show as "Triggered" in the GitGuardian dashboard and can be resolved there as a false positive.
- M1 started: the spending policy engine, as PR vansyson1308/shopvoice-pay#2, stacked on #1.
  - `evaluatePolicy` (block, step-up and autopay rules with speakable reasons) and `evaluateSubstitution`.
  - 18 tests, 98.6% branch coverage, and a CI gate at 95%.

**Verified**
- GitHub Actions on #1: lint, typecheck, unit, Postgres, e2e; the sandbox job is skipped because no secret is set.
- Locally on the M1 branch: 154 unit tests and 30 DB tests pass.

**Still blocked on the owner**: sandbox REST app and accounts (SPIKE.md "Owner action").

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
