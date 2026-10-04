# Built during the PayPal AI Hackathon

The PayPal AI Hackathon submission period opened on **Oct 1, 2026, 9:00 PT**. The rules allow existing code only if it is "significantly updated after the start of the Hackathon Submission Period".

## What existed before

The first commit of this repository, `Import from groceryclaw @0fb3af4 (MIT)` (2026-10-04), is a verbatim copy of parts of [GroceryClaw](https://github.com/vansyson1308/groceryclaw) at commit `0fb3af4`:

- a voice-first store-assistant MCP server (read tools for stock, sales and invoices; a reorder *draft* that only flipped a status)
- a push-to-talk web console
- shared utilities and Postgres migrations 001–018

**No payment code of any kind existed.** It had no PayPal integration, no spending policy, no ledger, no delivery matching and no LLM brain verified against real credentials. Money was stored in Vietnamese dong. You can diff the import against the source with:

```bash
git clone https://github.com/vansyson1308/groceryclaw /tmp/gc && git -C /tmp/gc checkout 0fb3af4
git show --stat <import-commit>
```

## What was built during the hackathon

Every commit after the import. The table is updated at each milestone; `git log --reverse` is the authoritative list.

| Date (UTC) | Commit | What |
|---|---|---|
| 2026-10-04 | Restructure the import into the ShopVoice Pay layout | Repo layout, pruning of legacy modules, new build config |
| 2026-10-04 | Add CI | GitHub Actions: lint, typecheck, unit, Postgres RLS, e2e, opt-in sandbox job |
| 2026-10-04 | Add PayPal payments client with mock mode, sandbox spike and tests | OAuth, Orders v2 AUTHORIZE, Payments v2 capture/void/reauthorize/refund, Vault v3, Payouts, webhook verification, idempotency + retries, mock PayPal, spike runners |
| 2026-10-04 | M0 docs | README, NOTICE, SPIKE, DECISIONS, ARCHITECTURE, BUILD_LOG |
| 2026-10-04 | Add the spending policy engine (PR #2) | Deterministic autopay / step-up / block rules, substitution check, ≥95% branch-coverage gate |
| 2026-10-04 | Day-1 sandbox spike (PR #3) | Real sandbox evidence, automated sandbox buyer approval, mock aligned with the sandbox, settlement decision confirmed |
| 2026-10-04 | Ledger (PR #4) | Migration 019 with RLS, ledger state machine with a property test, memory/Postgres payments repository |
| 2026-10-04 | PaymentsService (PR #5) | Vault onboarding, pay within policy, step-up approval, capture on delivery, refunds, Payouts settlement; hero money path verified in sandbox |

Planned for the following milestones (see `docs/paypal/BUILD_LOG.md`): spending policy engine, payment ledger and migration 019, vault onboarding, paying confirm_reorder, delivery capture with 3-way match, refunds, the LLM brain with safety evals, the console redesign with AG Grid, the simulated Cart API supplier agent, Agent Toolkit integration, and the hosted demo.
