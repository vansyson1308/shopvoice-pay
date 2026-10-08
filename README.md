# ShopVoice Pay

[![M8ven Score](https://m8ven.ai/badge/mcp/vansyson1308-shopvoice-pay-1l94ym?v=427b09930c35b48396729a1e1ffacadc&variant=verified)](https://m8ven.ai/mcp/vansyson1308-shopvoice-pay-1l94ym?s=readme)

**A voice-first purchasing agent for independent grocers. It reorders from suppliers and pays them through PayPal, but only within spending rules the owner sets, and it pays only for what actually arrived.**

> Status: **M4 complete** for the [PayPal AI Hackathon](https://paypalaihackathon.devpost.com) (Oct–Nov 2026). The money path, Claude brain, invoice 3-way match, simulated Cart API suppliers, Agent Toolkit integration and threat model are built and tested in CI.
> **Hosted demo:** https://shopvoice-console.onrender.com · Demo video: coming soon.

## The 30-second pitch

Corner-store owners run on thin margins and late nights: stock-outs, supplier calls, paper invoices, and payments squeezed in after closing. An AI agent that "can pay" sounds like help, until it hallucinates an order or pays twice. That is real money.

ShopVoice Pay makes agentic payments trustworthy with three rules:

1. **The model cannot break the rules.** Spending policy (per-order limits, budgets, allow-listed suppliers, price-jump checks, duplicate detection) is enforced in deterministic server code. The LLM can only *propose* a payment.
2. **Money is held, not sent, until delivery is verified.** Orders use PayPal `intent: AUTHORIZE`. On delivery the agent compares PO, delivery count and invoice (a 3-way match), captures only what arrived, and voids the rest.
3. **A human approves exactly where the risk is.** Routine, in-policy orders auto-pay from the owner's vaulted PayPal account. Anything unusual (a new supplier, a 31% price jump, triple the usual quantity) steps up to a one-tap or spoken "yes".

Meet Maria (fictional), who runs a corner store in Queens. While closing up, she says "Reorder milk and eggs." The milk order ($84, allow-listed supplier) is authorized automatically: *held, not charged*. Eggs went up 31%, so the agent asks first. The next morning 10 of 12 crates arrive. Maria snaps the invoice, and the agent charges for 10 and releases the rest. Every authorization, capture, void and refund appears in a ledger, with the reason the agent took that action.

## Try it

**Hosted demo:** https://shopvoice-console.onrender.com (Render, PayPal sandbox, Claude Sonnet 5.5; see [docs/paypal/DEPLOY.md](docs/paypal/DEPLOY.md)).

1. Click **Try the demo**. You get a private sample shop; **Reset demo** starts it over.
2. Optional, for auto-pay from a saved PayPal: **Rules & PayPal → Connect PayPal** and log in with a PayPal *sandbox* buyer account (judges: credentials are in the Devpost testing instructions). Without it, each order asks you to approve it in PayPal.
3. In **Talk**, hold the mic button (Chrome or Edge) or type: "Reorder milk and eggs" → "Yes, confirm" → "Yes, approve it" → "Only 8 crates of milk came" → "Two crates of milk were spoiled, refund them" → "Yes". Watch the **Ledger** tab.

No real money moves: everything runs in the PayPal sandbox.

**Locally (about 2 minutes, Node 20+, no accounts needed):**

```bash
git clone https://github.com/vansyson1308/shopvoice-pay && cd shopvoice-pay
npm ci
npm test            # build + 284 unit tests, with PayPal mocked
npm run demo:e2e    # voice flow against the in-memory demo store
npm run evals       # 25 safety + 17 quality agent cases
```

**Open the console in your browser** (two terminals, after `npm test` has built the project):

```bash
# terminal 1: MCP server with the in-memory demo shop and simulated PayPal
MCP_DATA_BACKEND=memory DEMO_PROVISION_SECRET=local-demo-secret-0123456789abcdef npm run start:mcp
# terminal 2: console
DEMO_PROVISION_SECRET=local-demo-secret-0123456789abcdef npm run start:console
```

Then open http://localhost:8091, click **Try the demo**, and say or type "Reorder milk and eggs". Use Chrome or Edge for push-to-talk speech recognition. This runs the offline rules brain. To use Claude, also set `BRAIN=claude-api` and `ANTHROPIC_API_KEY` in terminal 2 (see [AI used](#ai-used-and-what-is-simulated)).

`PAYPAL_MODE=mock` (the default) runs an in-process fake of the PayPal endpoints we use, so nothing leaves your machine. Its behaviour was calibrated against the real sandbox ([SPIKE.md](docs/paypal/SPIKE.md)). To run against the real PayPal sandbox, copy `.env.example` to `.env`, set `PAYPAL_MODE=sandbox` with sandbox REST app credentials, and run `npm run spike` and `npm run test:sandbox`.

## Architecture

```mermaid
flowchart LR
  owner([Store owner<br/>voice / chat]) --> console[Console<br/>push-to-talk, approvals,<br/>AG Grid ledger]
  console -->|MCP tool calls| mcp[ShopVoice MCP server]
  subgraph server [ShopVoice MCP server]
    tools[Tools] --> policy[Policy engine<br/>deterministic]
    policy --> payments[Payments client<br/>idempotent, retries]
    policy --> ledger[(Ledger + audit log<br/>Postgres, RLS)]
    payments --> ledger
  end
  mcp --- server
  payments -->|Orders v2, Payments v2,<br/>Vault v3, Payouts, Webhooks| paypal[(PayPal sandbox)]
  console -.LLM proposes, never pays.-> llm[LLM brain]
  mcp <-->|Cart API shape<br/>simulated| supplier[Supplier agent]
```

Details: [docs/paypal/ARCHITECTURE.md](docs/paypal/ARCHITECTURE.md). Day-1 sandbox spike: [docs/paypal/SPIKE.md](docs/paypal/SPIKE.md). Decisions: [docs/paypal/DECISIONS.md](docs/paypal/DECISIONS.md). Threat model, with the tests that prove each mitigation: [SECURITY.md](SECURITY.md).

## PayPal APIs used

| API | Endpoint | Used for |
|---|---|---|
| OAuth 2.0 | `POST /v1/oauth2/token` | client-credentials access token |
| Orders v2 | `POST /v2/checkout/orders` (`intent: AUTHORIZE`), `GET …/{id}`, `POST …/{id}/authorize` | supplier orders: vaulted (auto-pay) or buyer-approved (step-up) |
| Payments v2 | `POST /v2/payments/authorizations/{id}/capture`, `…/void`, `…/reauthorize`, `GET …` | pay on delivery: full or partial capture, release the remainder, extend past the 3-day honor period |
| Payments v2 | `POST /v2/payments/captures/{id}/refund`, `GET /v2/payments/refunds/{id}` | refunds for spoiled or short goods |
| Vault v3 | `POST /v3/vault/setup-tokens`, `POST /v3/vault/payment-tokens`, `GET`/`DELETE …/{id}` | "Connect PayPal" once, then merchant-initiated payments with no checkout |
| Payouts v1 | `POST /v1/payments/payouts`, `GET …/{batch_id}` | supplier settlement: orders are paid to the ShopVoice platform account, and suppliers are paid out for what was captured (DECISIONS.md D1, confirmed in sandbox) |
| Webhooks v1 | `POST /v1/notifications/webhooks`, `POST /v1/notifications/verify-webhook-signature` | ledger sync; polling fallback for local runs |
| Agent Toolkit | `@paypal/agent-toolkit` 1.11.0, called by server code (never handed to the model): `create_shipment_tracking`, `get_shipment_tracking`, `list_transactions`, `create_invoice`, `send_invoice`, `get_invoice` | tracking on supplier charges after delivery, a cross-check of the ledger against PayPal's records, and invoices for the shop's catering customers. Refunds and merchant insights are deliberately not used through it ([AGENT_TOOLKIT.md](docs/paypal/AGENT_TOOLKIT.md), DECISIONS D19) |
| Agentic Commerce Cart API v1 | merchant side: `POST /merchant-cart`, `GET`/`PUT /merchant-cart/{id}`, `POST /merchant-cart/{id}/checkout` | **simulated** supplier agents that ShopVoice's buyer agent places held orders with, accepting substitutions only within the owner's rules ([SUPPLIER_AGENT.md](docs/paypal/SUPPLIER_AGENT.md)) |

Every POST carries a `PayPal-Request-Id` idempotency key. Retries only ever replay the same key.

**Demo settlement vs. production.** The demo charges the shop into a ShopVoice platform sandbox account and pays suppliers out with Payouts. We chose that because the sandbox spike showed the direct routes are closed to a self-serve app:
- a vaulted payment to a supplier payee is rejected (`BILLING_AGREEMENT_NOT_FOUND`);
- the platform cannot release a hold it is not the payee of (403 `PERMISSION_DENIED`).

In production, ShopVoice would use PayPal's multiparty partner onboarding, so suppliers are onboarded payees and ShopVoice never holds third-party funds. See [DECISIONS.md → Production path](docs/paypal/DECISIONS.md#production-path-d1).

## AI used, and what is simulated

- **Claude brain:** Claude Sonnet 5.5 by default, or Claude Haiku 4.5 as the fast option (`CLAUDE_MODEL=sonnet|haiku`), called through Claude in Amazon Bedrock (`BRAIN=claude-bedrock`) or the Anthropic API (`BRAIN=claude-api`). It understands spoken requests, calls the MCP tools, summarises spend and explains decisions. Opus is refused for the voice loop to keep turns fast. If Claude is unreachable, the console falls back to the offline `rules` brain and says so. The `rules` brain also runs the tests.
- **Invoice vision:** Claude reads a photo of a supplier invoice into line items for the 3-way match. The photo is treated as untrusted: it can only lower or hold a charge, and its text never reaches the voice brain ([SECURITY.md](SECURITY.md)).
- **It never decides whether money moves.** The deterministic rules engine does, and spoken approvals are matched by code, not by the model. Agent evals check this: 25 safety cases, including a scripted adversarial model, gated at 100% in CI.
- **Simulated:** the supplier's seller agent implements PayPal's Cart API merchant spec. In production, PayPal Store Sync would connect real suppliers. Anything simulated is labelled as such in the UI.
- All store, supplier and product data is fictional. Products have generic names ("Whole milk, 1 gal").

## Repository layout

```
apps/mcp-server   MCP server, OAuth 2.1, REST for the console, payments client (src/payments)
apps/console      push-to-talk voice + chat console (MCP client), Claude brain, invoice reader
apps/supplier-agent  simulated supplier agents on PayPal's Cart API spec
packages/common   logging, Postgres/RLS helpers, rate limiting, crypto
db/migrations     Postgres schema with forced row-level security
scripts/paypal    sandbox spike runners
tests/            unit (PayPal mocked), db (Postgres), e2e (browser), sandbox (real sandbox, opt-in)
evals/            agent safety and quality cases
docs/paypal       spike, architecture, decisions, build log
```

## Credits and license

ShopVoice Pay is built on parts of [GroceryClaw](https://github.com/vansyson1308/groceryclaw) (MIT), imported at commit `0fb3af4`. GroceryClaw's production ingestion pipeline (Telegram/Zalo gateway, worker, KiotViet POS sync) stays in that repository and is not part of this demo. See [NOTICE](NOTICE) and [BUILT_DURING_PAYPAL.md](BUILT_DURING_PAYPAL.md).

MIT License, see [LICENSE](LICENSE). PayPal is a trademark of PayPal, Inc. This project is not affiliated with PayPal.
