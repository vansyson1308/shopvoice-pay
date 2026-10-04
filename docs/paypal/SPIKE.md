# Day-1 PayPal sandbox spike

The spike decides the payment architecture. No P0 money feature is built on an assumption the spike has not checked.

**Status: done, against the real PayPal sandbox on 2026-10-04 (UTC).**

- Main spike: **15 pass, 6 info, 0 fail.**
- Agent Toolkit spike: **10 pass, 2 info, 0 fail.**
- Sandbox test suite (`npm run test:sandbox`): **5/5.**
- Evidence: [`spike-results.sandbox.json`](spike-results.sandbox.json) and [`toolkit-spike-results.sandbox.json`](toolkit-spike-results.sandbox.json). Ids in them are shortened (for example `0047…0h`); PayPal `debug_id`s are kept so any call can be traced with PayPal.

Setup: sandbox REST app "ShopVoice Pay" (Merchant). The platform account is a US business sandbox account. Vault, Payouts, Invoicing and Transaction search are enabled. The payer is a US personal sandbox account and the supplier is a US business sandbox account.

## How to re-run

```bash
# env: PAYPAL_MODE=sandbox PAYPAL_CLIENT_ID PAYPAL_CLIENT_SECRET SPIKE_SUPPLIER_EMAIL SPIKE_BUYER_EMAIL SPIKE_BUYER_PASSWORD
npm run spike                                               # about 3 minutes, 4 buyer approvals
SPIKE_VAULT_ID=<from SPIKE_STATE_FILE> node scripts/paypal/toolkit-spike.mjs
SANDBOX_VAULT_ID=<same> SANDBOX_SUPPLIER_EMAIL=... npm run test:sandbox
```

**Buyer approvals are automated.** `scripts/paypal/sandbox-approver.mjs` opens the PayPal sandbox approval link in headless Chromium and logs in as the sandbox personal account. It clicks "Continue to Review Order" for an order, or "Save and Continue" for a vault. The spike then confirms the approval through the API, not by trusting the browser. The approver refuses any URL that is not on `sandbox.paypal.com`. Behind this environment's TLS-intercepting proxy, Chromium trusts only the proxy CA's key (`--ignore-certificate-errors-spki-list`); certificate checking is not turned off. Without `SPIKE_BUYER_PASSWORD` the spike prints the link for a person to click.

`PAYPAL_MODE=mock npm run spike` runs the same steps against the in-process fake. That is a self-test of the runner, not evidence about PayPal, and its output is git-ignored.

## Results

Legend: ✅ confirmed in sandbox · ❌ rejected by sandbox (a finding, not a bug) · ℹ️ informational.

### §4.1 OAuth

| Check | Result |
|---|---|
| S1 `POST /v1/oauth2/token` (client credentials) | ✅ Token obtained and cached. A bad client gives 401 `invalid_client`. |

### §4.2 Orders v2 `intent: AUTHORIZE`

| Check | Result |
|---|---|
| S2.1 Buyer-approved order with the **supplier as payee** (`payee.email_address`) | ✅ Status `PAYER_ACTION_REQUIRED` with links `self`, `payer-action`. After approval and `/authorize`, the authorization is `CREATED` with `create_time` 2026-10-04T17:43:09Z and **`expiration_time` 2026-11-02T17:43:09Z (29 days)**. |
| S2.4 Full capture (platform payee) | ✅ Capture `COMPLETED` $84.00; authorization `CAPTURED`. |
| S2.10 Partial capture `final_capture:false`, then void the remainder (**platform payee**) | ✅ $70.00 captured, authorization `PARTIALLY_CAPTURED`; void accepted, authorization `VOIDED`. |
| S2.5 Partial capture `final_capture:true` (platform payee) | ✅ $70.00 captured; authorization goes straight to **`CAPTURED`**, so the remainder is released. A later void fails with 422 `PREVIOUSLY_CAPTURED`. |
| S2.6 Void an untouched authorization (platform payee) | ✅ `VOIDED`; a later capture fails with 422 `AUTHORIZATION_VOIDED`. |
| S2.2 Partial capture, then void (**supplier payee**) | ✅ capture $84.00 → `PARTIALLY_CAPTURED`; ❌ void returns **403 `NOT_AUTHORIZED / PERMISSION_DENIED`**. Only the payee can void. |
| S2.9 Void an untouched supplier-payee authorization | ❌ **403 `PERMISSION_DENIED`**, even before any capture. The platform cannot cancel a hold it does not receive. |
| S2.8 Partial capture `final_capture:true` (supplier payee) | ✅ authorization `CAPTURED`; the remainder is released. A second capture fails with 422 `AUTHORIZATION_ALREADY_CAPTURED`. |
| S2.3 Reauthorize inside the honor period | ✅ Rejected with 422 `REAUTHORIZATION_TOO_SOON`. The honor period is checked before the authorization state. **Honor period: 3 days; validity: 29 days.** |
| S2.7 Idempotency: the same `PayPal-Request-Id` sent twice on a capture | ✅ Same capture id returned; money moved once. |

Partial capture of PayPal-wallet authorizations is enabled on this sandbox account. The docs warned it might need enabling, so S2.2, S2.5 and S2.10 settle that question.

### §4.3 Vault v3 save-without-purchase

| Check | Result |
|---|---|
| S3.1 `POST /v3/vault/setup-tokens` → buyer approves → `POST /v3/vault/payment-tokens` | ✅ Setup token `PAYER_ACTION_REQUIRED`, approve link `/agreements/approve`. The payment token returns a vault id, a `customer.id` and the payer email. |
| S3 vaulted `AUTHORIZE`, **platform** payee | ✅ Single call, `COMPLETED`, authorization `CREATED`, no buyer interaction. |
| S3 vaulted `CAPTURE`, **platform** payee | ✅ Single call, `COMPLETED`, capture `COMPLETED`. |
| S3 vaulted `AUTHORIZE`, **supplier** payee | ❌ **422 `BILLING_AGREEMENT_NOT_FOUND`** (debug `f7579910c0f08`). |
| S3 vaulted `CAPTURE`, **supplier** payee | ❌ **422 `BILLING_AGREEMENT_NOT_FOUND`** (debug `f6843248f81d9`). |

A `MERCHANT` vault token is a billing agreement with the API caller only. Charging it to another merchant would need PayPal's partner Platforms flow, which this app does not have.

### §4.4 Refunds

| Check | Result |
|---|---|
| S4 Partial refund, then the rest, then once more | ✅ $12.00 `COMPLETED`, then $72.00 `COMPLETED`. The third refund fails with 422 `CAPTURE_FULLY_REFUNDED`. |

### Settlement: Payouts

| Check | Result |
|---|---|
| S5 `POST /v1/payments/payouts`, platform → supplier business account | ✅ Batch `PENDING`, then **`SUCCESS` after 31 s**; item `SUCCESS`. Payouts work in this sandbox app. |

### §4.5 Agent Toolkit 1.11.0 and the remote MCP server

| Check | Result |
|---|---|
| T0 tools | ✅ `create_invoice, list_invoices, get_invoice, send_invoice, create_shipment_tracking, get_shipment_tracking, get_order, list_transactions, create_refund, get_refund, get_merchant_insights`, called directly through `PayPalMCPToolkit#getPaypalAPIService().run()`, no LLM. |
| T1/T2 `create_invoice`, `send_invoice` | ✅ Invoice created and sent to the sandbox personal account. The tool returns a link object (`rel`, `href`, `method`), not the invoice. |
| T3 `get_order` | ✅ |
| T4/T5 `create_shipment_tracking`, `get_shipment_tracking` on a captured transaction | ✅ 1 tracker, no errors. |
| T6 `create_refund` | ✅ `COMPLETED` |
| T7 `list_transactions` (last 30 days) | ✅ Returned, but only 1 transaction while the spike had made many. **Transaction search lags behind real time in sandbox**, so spend summaries must come from our own ledger, with the toolkit as a cross-check. |
| T8 `get_merchant_insights` | ℹ️ `"get_merchant_insights is not supported in sandbox mode"`, as documented. Not used. |
| T9 Remote MCP `mcp.sandbox.paypal.com/mcp` | ℹ️ No token: 401 (`WWW-Authenticate` points to the OAuth metadata). REST client-credentials bearer: **404**. `/http` (the documented path) gives 404 even without a token. The server only accepts tokens from its own OAuth `authorization_code` + PKCE flow, which needs a browser login. |

### §4.6 Webhooks

| Check | Result |
|---|---|
| S6.1 `POST /v1/notifications/webhooks` with the six events (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.CAPTURE.REFUNDED`, `VAULT.PAYMENT-TOKEN.CREATED`) | ✅ Registered (to a placeholder URL), then deleted (S6.3). The hosted demo registers its real URL in M4. |
| S6.2 `POST /v1/notifications/verify-webhook-signature` with a forged delivery | ✅ `verification_status: FAILURE`. The first run found that **`webhook_id` must match `^[a-zA-Z0-9]+$`** (400 otherwise); the client and the mock now enforce that. The raw event is passed through byte-for-byte. |
| Polling fallback | ✅ `GET` order, authorization and capture are used throughout the spike. |

### §4.7 Agentic Commerce Cart API v1 (merchant side, for the simulated supplier agent)

From `developer.paypal.com/api/agentic-commerce/v1/schema.json` ("PayPal Cart API v1", OpenAPI 3.2.0). Access to the real program is gated and limited to US buyers, USD and physical goods, so ShopVoice implements the **merchant side** in a simulated supplier agent.

- **Auth:** PayPal calls the merchant with `Authorization: Bearer <JWT>` (RS256) from `https://www.paypal.ai/.well-known/jwks.json`. Example claims: `merchant_id`, `scope: ["cart"]`, `iat`, `exp`.
- **Endpoints:** `POST /merchant-cart` (201), `GET /merchant-cart/{id}`, `PUT /merchant-cart/{id}` (full replacement), `POST /merchant-cart/{id}/checkout` (200 with `payment_confirmation {merchant_order_number, order_review_page}`).
- **Cart:** `status` is `CREATED | INCOMPLETE | READY | COMPLETED`; `validation_status` is `VALID | INVALID | REQUIRES_ADDITIONAL_INFORMATION`. Other fields: `items[] {variant_id, quantity, name, price}`, `totals {total, subtotal, …}`, `payment_method {type, token, payer_id}`.
- **`validation_issues[]`:** `{code: INVENTORY_ISSUE|PRICING_ERROR|…, type: MISSING_FIELD|INVALID_DATA|BUSINESS_RULE, message, user_message?, variant_id?, context {specific_issue: ITEM_OUT_OF_STOCK|PRICE_MISMATCH|…, available_quantity, suggested_alternatives}, resolution_options[{action: SUGGEST_ALTERNATIVE|ACCEPT_NEW_PRICE|REMOVE_ITEM|…, label}]}`.
  - Business problems return 200 with issues.
  - 422 is used only when no cart can be created, 400 for malformed requests and 404 for an unknown cart.
- **Payment tie-in in PayPal's flow:** the merchant creates an order and returns its id as `payment_method.token`. On checkout the merchant captures. ShopVoice deviates on purpose (DECISIONS.md D6): checkout confirms the order, and capture waits for delivery.

## Architecture decision: confirmed

See [DECISIONS.md](DECISIONS.md) D1 and D2.

1. **Settlement = platform procurement wallet + Payouts.** Two findings rule out direct payee:
   - A vault token cannot pay a third-party payee (`BILLING_AGREEMENT_NOT_FOUND`).
   - When the supplier is the payee, the platform cannot void the hold (`PERMISSION_DENIED`), so "hold, then release what didn't arrive" would only work by capturing.

   With the platform as payee, every operation the product needs works: vaulted AUTHORIZE, partial capture, void, refund. Payouts reach the supplier in about 30 s.
2. **Step-up orders use the same model.** They are buyer-approved (or vaulted after the owner taps Approve) and paid to the platform, so they keep the void path. A direct-payee order is never used.
3. **Delivery capture:**
   - Short delivery: `capture(delivered, final_capture:false)` then `void`. Two ledger events; confirmed by S2.10.
   - Full delivery: `capture(final_capture:true)`.
   - If an explicit void ever fails, `final_capture:true` on the last capture releases the remainder (S2.5). That is the fallback.
4. **Honor period handling:** captures inside 3 days need nothing extra. From day 3 the UI warns, and from day 4 the server reauthorizes before capturing. A reauthorization gets a new id; the 29-day end date does not move.
5. **Spend summaries** come from our ledger (transaction search lags in sandbox). `list_transactions` is a cross-check, and `get_merchant_insights` is not used.

## What the mock now copies from the sandbox

`apps/mcp-server/src/payments/mock-paypal.ts` was updated after the spike to reproduce:
- `BILLING_AGREEMENT_NOT_FOUND` for vault + third-party payee (now the default);
- 403 `PERMISSION_DENIED` when voiding a third-party-payee authorization;
- `PREVIOUSLY_CAPTURED` on void after a final capture;
- the honor-period check running before the state check on reauthorize;
- the alphanumeric `webhook_id` rule.

Unit tests cover each one.
