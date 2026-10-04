# Decisions

Each entry gives the decision, the reasoning, and what would change it. Dates are Vietnam time.

## D1. Settlement model: platform procurement wallet, with direct payee as a promotion (2026-10-04, provisional)

**Decision.** Auto-pay orders are vaulted `AUTHORIZE` orders whose payee is the ShopVoice platform sandbox account (the "procurement wallet"). On delivery we capture what arrived, void the rest, and settle the supplier with a Payouts item for the captured amount, net of any refunds, in a settlement run. Settlement is configurable as `platform_payout` or `direct_payee`. With `direct_payee`, the order names the supplier in `purchase_units[].payee` and the Payouts step is skipped.

**Why.** The owner should approve once ("Connect PayPal") and then let routine orders pay without a checkout, so vaulting is required. PayPal documents only one way to charge a vaulted token to a *different* merchant: the Platforms (multiparty) flow, with `usage_type: PLATFORM`, a partner BN code, `PayPal-Auth-Assertion` and supplier consent through partner onboarding. A self-serve sandbox app cannot complete that flow, so we expect `PAYEE_NOT_CONSENTED` or `PERMISSION_DENIED` (SPIKE §4.3). The wallet model is the documented fallback and keeps one consistent flow for both the hero story and the tests.

**Consequences.**
- A refund after the supplier was paid out is netted against that supplier's next settlement. The ledger shows it as "supplier credit". In the demo, the settlement run waits until the delivery has been checked, so refunds for spoiled goods usually reduce the payout instead of needing a clawback.
- In production this is a regulated money flow. The honest production path is PayPal Multiparty with onboarded suppliers. README and DEVPOST say so.

**Revisit when.** If spike row S3.vault-authorize-payee is accepted in the sandbox, set the default to `direct_payee`.

## D2. Hold first, capture on delivery (2026-10-04)

**Decision.** Every supplier order uses `intent: AUTHORIZE`. Delivery triggers a full capture, or a partial capture with `final_capture: false` followed by an explicit void of the remainder. A variance above tolerance places a hold (step-up). Authorizations older than the 3-day honor period are reauthorized before capture, and the UI warns from day 2.

**Why.** "Pays only for what arrived" is the product. An explicit void, rather than relying on `final_capture: true` to release the rest, gives a ledger event we can show and test either way. The docs are silent on what `final_capture: true` does to the remainder (SPIKE S2.5).

**Fallback.** If partial capture turns out not to be enabled for wallet authorizations in the sandbox (S2.2), void the whole authorization and place a new vaulted `CAPTURE` order for the delivered amount, recorded as a re-charge.

## D3. Our own thin REST client for money movement; Agent Toolkit for everything else (2026-10-04)

**Decision.** Orders, authorize/capture/void/reauthorize, Vault, Payouts, refunds and webhook verification go through `apps/mcp-server/src/payments` (our client). `@paypal/agent-toolkit` provides invoicing (the store's catering sales), shipment tracking, the transaction list and order lookup. Toolkit tools are wrapped behind our policy layer and never exposed raw to the LLM.

**Why.** Toolkit 1.11.0 has no authorize, void, vault, payout or cart tools. Its `create_order` is CAPTURE-only with no payee. Its `context.request_id` pins one idempotency key per toolkit instance. Money movement needs a fresh key per operation, replayed exactly on retry, plus ledger and audit writes in the same code path.

## D4. Mock PayPal is a fetch implementation, not a separate code path (2026-10-04)

**Decision.** `PAYPAL_MODE=mock` passes an in-process fake (`mock-paypal.ts`) to the same `PayPalClient` as its `fetch`. The fake models the state machines and idempotent replay, and can inject 5xx, network failures and lost responses.

**Why.** CI and judges' local runs need no credentials, but tests must exercise the real client: headers, retries, error mapping and redaction. Behaviour that the sandbox spike corrects is updated in the fake and noted in SPIKE.md.

## D5. Import verbatim, then restructure (2026-10-04)

**Decision.** The first commit copies the needed files from groceryclaw @0fb3af4 at their original paths. The second commit renames them (`alexa-sim` → `console`, `db/v2` → `db`, …) and prunes legacy modules.

**Why.** A verbatim import can be diffed against the source commit, which makes the "existing code significantly updated" claim easy to verify. The brief asked for `apps/console` in the import commit. This differs only in timing (the rename lands one commit later), so the provenance claim gets stronger.

Database role names inside migrations 001–018 (`groceryclaw_app_runtime`, …) are kept unchanged. Renaming them would mean rewriting already-applied migrations.

## D6. Cart API: implement the merchant side, keep our AUTHORIZE order (2026-10-04)

**Decision.** The simulated supplier agent implements PayPal Cart API v1 merchant endpoints (`/merchant-cart`, `PUT`, `/checkout`) with `validation_issues` for out-of-stock items and price changes. ShopVoice's buyer agent negotiates against it. At checkout, the supplier treats ShopVoice's `AUTHORIZE` order id as the payment token and confirms the order *without capturing*; capture still waits for delivery.

**Why.** In PayPal's spec the merchant captures at checkout. Our product rule is pay-on-delivery. This is a deliberate deviation and is labelled in the UI ("Simulated supplier agent implementing PayPal's Cart API spec").

## D7. Remote PayPal MCP server is not on the payment path (2026-10-04)

**Decision.** We do not call `mcp.sandbox.paypal.com` from the server.

**Why.** Probing on 2026-10-04 showed that it only supports OAuth `authorization_code` + PKCE (a browser login), so an unattended agent cannot use it with client credentials. Spike T9 checks whether a REST bearer token is accepted. If it is, we may expose it as an optional read-only channel.

## D8. Work staging until the new repository exists (2026-10-04)

**Decision.** `vansyson1308/shopvoice-pay` did not exist at the start of M0, and creating it is the owner's step (§11). The repository was therefore built as its own git history. Its commits will be pushed unchanged once the repository exists, so commit dates stay as built. Nothing was pushed to groceryclaw `main`.
