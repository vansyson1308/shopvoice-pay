# Day-1 PayPal sandbox spike

The spike decides the payment architecture. No P0 money feature is built on an assumption that is still marked **pending** below.

**Status (2026-10-04): partially run.** The runner, the sandbox test suite and the mock are written and self-tested. **Sandbox credentials have not been provided yet**, so most checks are still **pending sandbox**. The only real sandbox results so far come from unauthenticated probes (rows marked *probed*). The owner action needed to finish the spike is listed at the end.

How to run it:

```bash
cp .env.example .env    # PAYPAL_MODE=sandbox, PAYPAL_CLIENT_ID/SECRET, SPIKE_SUPPLIER_EMAIL, SPIKE_BUYER_EMAIL
set -a; . ./.env; set +a
npm run spike                                   # writes docs/paypal/spike-results.sandbox.json
node scripts/paypal/toolkit-spike.mjs           # writes docs/paypal/toolkit-spike-results.sandbox.json
```

The runner prints a sandbox URL whenever the buyer has to approve. That happens twice: once for an order and once for the vault. Log in as the sandbox **personal** account and approve; the script polls and continues on its own. `PAYPAL_MODE=mock` runs the same steps against the in-process fake. That is a self-test of the script, not evidence about PayPal, and its output file is git-ignored.

Sources: the PayPal OpenAPI specs at `developer.paypal.com/api/<name>/schema.json` (Orders v2, Payments v2, Payment Method Tokens v3, Payouts v1, Webhooks v1, Agentic Commerce v1), the integration guides, and the unpacked `@paypal/agent-toolkit@1.11.0` package. All were read on 2026-10-04.

## Results

Legend: ✅ confirmed in sandbox · 🔎 probed (real network result, no credentials) · ⏳ pending sandbox (behaviour below is from the docs and is what the mock implements) · ❓ docs ambiguous, so the spike must decide.

### §4.1 OAuth

| Check | Docs | Sandbox result | Status |
|---|---|---|---|
| `POST /v1/oauth2/token`, Basic auth, `grant_type=client_credentials` | Returns `{access_token, token_type: Bearer, app_id, expires_in, nonce}`. `expires_in` is about 32,000 s. | Reachable from the build environment. Invalid credentials return HTTP 401 `{"error":"invalid_client","error_description":"Client Authentication failed"}`. The client maps this to `PayPalApiError(name=invalid_client)`. | 🔎 / ⏳ with real creds (S1) |

### §4.2 Orders v2 `intent: AUTHORIZE` and the three outcomes

| Check | Docs | Sandbox result | Status |
|---|---|---|---|
| Create with `payment_source.paypal.experience_context` | Status `PAYER_ACTION_REQUIRED` and a `rel: "payer-action"` link (`rel: "approve"` only with the legacy `application_context`). Default approval window is 6 h. | — | ⏳ S2.1 |
| Third-party payee `purchase_units[].payee.email_address` on a **buyer-approved** order | Allowed field. Whether the API caller can later capture it is not stated. | — | ❓ S2.1/S2.2 |
| `POST /v2/checkout/orders/{id}/authorize` | Authorization at `purchase_units[0].payments.authorizations[0]`; status `CREATED`; has `expiration_time`. | — | ⏳ S2.1 |
| Full capture | `POST /v2/payments/authorizations/{id}/capture` with `final_capture: true` makes the authorization `CAPTURED`. | — | ⏳ S2.4 |
| Partial capture with `final_capture: false`, then void the remainder | Multiple partial captures are allowed, **but for PayPal-wallet authorizations "partial capture must be enabled on your account"**. A fully captured authorization cannot be voided. | — | ❓ S2.2 |
| Partial capture with `final_capture: true`, then void | "Additional captures are not possible." Whether the remainder is released automatically, and whether a later void returns `AUTHORIZATION_ALREADY_CAPTURED`, is not stated. | — | ❓ S2.5 |
| Void an untouched authorization | 204 (200 with `Prefer: return=representation`). A later capture fails with `AUTHORIZATION_VOIDED`. | — | ⏳ S2.6 |
| Honor period / validity | 3-day honor period, 29-day validity. Reauthorize from day 4 to 29 (new id, fresh honor period, same 29-day end). Over-capture is allowed up to 115% or +$75 in the US (conflicts with the `MAX_CAPTURE_AMOUNT_EXCEEDED` example). **Sandbox authorizations do not expire**; use negative testing. | Recorded: **honor period = 3 days**. | ✅ from docs; S2.3 checks the early-reauthorize error (`REAUTHORIZATION_TOO_SOON`) |
| Idempotency | A replayed `PayPal-Request-Id` returns the current state, not a second money movement. Concurrent duplicates can return 409 `PREVIOUS_REQUEST_IN_PROGRESS`. Retention is 45 days for refunds, 30 days for payouts and 3 h for vault; it is not stated for orders or captures. | — | ⏳ S2.7 |

### §4.3 Vault v3 save-without-purchase

| Check | Docs | Sandbox result | Status |
|---|---|---|---|
| `POST /v3/vault/setup-tokens` (`usage_type: MERCHANT`, `customer_type: CONSUMER`) | `PAYER_ACTION_REQUIRED` plus a `rel: "approve"` link (`/agreements/approve?approval_session_id=…`). A setup token lives 3 days. The app needs **Vault ticked** in its sandbox settings. | — | ⏳ S3.1 |
| `POST /v3/vault/payment-tokens` `{payment_source:{token:{id, type: SETUP_TOKEN}}}` | Returns `id` (the vault id), `customer.id` and the payer email. | — | ⏳ S3.1 |
| Vaulted order, no payer interaction (`payment_source.paypal.vault_id`) | Single step: the create response is already `COMPLETED` with `authorizations[]` or `captures[]`. Whether `stored_credential` is required is unclear (the guide omits it, the spec example includes it); we send `payment_initiator: MERCHANT`. | — | ⏳ S3.vault-authorize-platform, S3.vault-capture-platform |
| Vaulted order **with a third-party payee** | The only documented route is the Platforms flow: `usage_type: PLATFORM`, `PayPal-Partner-Attribution-Id`, `PayPal-Auth-Assertion`, and seller consent via partner onboarding. Without it, expect `PAYEE_NOT_CONSENTED` or `PERMISSION_DENIED`. | — | ❓ S3.vault-authorize-payee, S3.vault-capture-payee. **Decides the architecture.** |

### §4.4 Refunds

| Check | Docs | Sandbox result | Status |
|---|---|---|---|
| Partial refund `{amount}`, then full `{}` | 201 (200 on idempotent replay). Status `COMPLETED`. Errors: `REFUND_AMOUNT_EXCEEDED`, `CAPTURE_FULLY_REFUNDED`. | — | ⏳ S4 |

### Fallback settlement: Payouts

| Check | Docs | Sandbox result | Status |
|---|---|---|---|
| `POST /v1/payments/payouts` to the supplier sandbox email | No sandbox activation step is listed. `sender_batch_id` is single-use for 30 days. Amounts use `currency`, not `currency_code`. | — | ⏳ S5 |

### §4.5 Agent Toolkit and the remote MCP server

| Check | Docs / package | Sandbox result | Status |
|---|---|---|---|
| `@paypal/agent-toolkit` 1.11.0 tools | Subpath exports `/ai-sdk`, `/openai`, `/langchain`, `/mcp`, `/bedrock`. The tools we enable are `create_invoice`, `send_invoice`, `get_invoice`, `list_invoices`, `get_order`, `create_refund`, `get_refund`, `create_shipment_tracking`, `get_shipment_tracking`, `list_transactions` and `get_merchant_insights`. **No authorize, void, vault, payout or cart tools.** `create_order` is CAPTURE-only, USD-only and has no payee. `context.request_id` pins one `PayPal-Request-Id` per toolkit instance. | Installed. The tool list and the parameter schemas were read from the package (`toolkit-spike.mjs` T0). | ✅ offline; ⏳ calls T1–T8 |
| Calling a tool without an LLM | `new PayPalMCPToolkit({accessToken, configuration}).getPaypalAPIService().run(method, args)`; it returns a JSON string. | — | ⏳ T1–T8 |
| `get_merchant_insights` in sandbox | Docs say it throws in sandbox. | — | ⏳ T8 |
| Remote MCP server | Docs give `https://mcp.sandbox.paypal.com/http` and `/sse`. | **Probed:** `POST /http` → **404**. `POST /mcp` → **401** (the Streamable HTTP endpoint is `/mcp`). `GET /sse` → 401 with `WWW-Authenticate: Bearer … resource_metadata=…/oauth-protected-resource/sse`. OAuth metadata: issuer `mcp.sandbox.paypal.com`, `grant_types_supported: [authorization_code, refresh_token]`, PKCE S256, dynamic client registration at `/register`. **No client-credentials grant**, so an unattended server cannot log in without a browser. | 🔎; T9 checks whether a REST bearer token is accepted |

### §4.6 Webhooks

| Check | Docs | Sandbox result | Status |
|---|---|---|---|
| Register the six events (`CHECKOUT.ORDER.APPROVED`, `PAYMENT.AUTHORIZATION.CREATED`, `PAYMENT.CAPTURE.COMPLETED`, `PAYMENT.AUTHORIZATION.VOIDED`, `PAYMENT.CAPTURE.REFUNDED`, `VAULT.PAYMENT-TOKEN.CREATED`) | `POST /v1/notifications/webhooks {url, event_types}`. HTTPS URL, at most 10 per app. | Needs a public https URL (the hosted demo). | ⏳ S6.1 |
| `POST /v1/notifications/verify-webhook-signature` | `{auth_algo, cert_url, transmission_id, transmission_sig, transmission_time, webhook_id, webhook_event}` returns `verification_status` `SUCCESS` or `FAILURE`. **The event must be posted back exactly as received**, so our client splices the raw body in without re-serialising it. Offline verification (CRC32 + cert) is documented as preferred. | — | ⏳ S6.2 (forged delivery must come back `FAILURE`) |
| Polling fallback | `GET` order, authorization and capture. | Implemented in the client. | ✅ code |

### §4.7 Agentic Commerce Cart API v1 (merchant side, for the simulated supplier agent)

Notes from `developer.paypal.com/api/agentic-commerce/v1/schema.json` ("PayPal Cart API v1", OpenAPI 3.2.0). Access to the real program is gated by a request form and limited to US buyers, USD and physical goods.

- **Auth:** PayPal calls the merchant with `Authorization: Bearer <JWT>` (RS256), verified against `https://www.paypal.ai/.well-known/jwks.json`. Example claims: `merchant_id`, `scope: ["cart"]`, `iat`, `exp`. The merchant chooses the base path; the examples use `/api/paypal/v1`.
- **Endpoints:** `POST /merchant-cart` (201), `GET /merchant-cart/{id}`, `PUT /merchant-cart/{id}` (full replacement), `POST /merchant-cart/{id}/checkout` (200 with `payment_confirmation {merchant_order_number, order_review_page}`).
- **Cart:** `status` `CREATED | INCOMPLETE | READY | COMPLETED`; `validation_status` `VALID | INVALID | REQUIRES_ADDITIONAL_INFORMATION`; `items[] {variant_id, quantity, name, price}`; `totals {total, subtotal, …}`; `payment_method {type, token, payer_id}`.
- **`validation_issues[]`:** `{code: INVENTORY_ISSUE|PRICING_ERROR|…, type: MISSING_FIELD|INVALID_DATA|BUSINESS_RULE, message, user_message?, variant_id?, context {specific_issue: ITEM_OUT_OF_STOCK|PRICE_MISMATCH|…, available_quantity, suggested_alternatives}, resolution_options[{action: SUGGEST_ALTERNATIVE|ACCEPT_NEW_PRICE|REMOVE_ITEM|…, label}]}`. Business problems return 200 with issues. 422 is used only when no cart can be created, 400 for malformed requests and 404 for an unknown cart.
- **Payment tie-in:** on create, the merchant creates a PayPal order and returns its id as `payment_method.token`. On changes it PATCHes the order amount. On checkout it captures (`POST /v2/checkout/orders/{token}/capture`) and returns `COMPLETED`.
- **Ambiguities we resolve in our implementation:** `payment_method.type` casing (`paypal` vs `PAYPAL`, so we accept both); `READY` appears in the spec but not in the guide table; create returns 201 even with issues; every example uses CAPTURE. ShopVoice keeps its own **AUTHORIZE** order and treats the supplier's checkout as order confirmation, with capture still on delivery. This is documented as a deviation in DECISIONS.md D6.

## Architecture decision (provisional until S2/S3 run)

See [DECISIONS.md](DECISIONS.md) D1–D3 for the full reasoning. In short:

- **Primary model: platform procurement wallet** (marketplace model). The owner's vaulted PayPal account authorizes each supplier order to the ShopVoice platform sandbox account. Capture happens on delivery. The supplier is settled with a Payouts item for the captured amount, net of refunds, in a settlement run. We chose this because the documented way to charge a vaulted MERCHANT token to a *different* payee is PayPal's partner Platforms flow, which a self-serve sandbox app cannot complete.
- **Promotion rule:** if S3.vault-authorize-payee is accepted in the sandbox, auto-pay orders name the supplier as `payee` directly and the Payouts step is skipped. The code supports both through one `settlement` setting, so the spike result changes configuration, not design.
- **Partial delivery:** `capture(delivered, final_capture: false)` then an explicit `void` of the remainder, so the ledger records the release. If S2.2 shows that partial capture is not enabled for wallet authorizations, the fallback is to void the authorization and place a new vaulted `CAPTURE` order for the delivered amount. This is recorded in the ledger as a re-charge, not a capture.

## Owner action needed to finish the spike

1. developer.paypal.com → Apps & Credentials → **Sandbox** → Create App (type: Merchant). Under *Features*, make sure **Accept payments**, **Vault** (Advanced options) and **Payouts** are ticked, then save.
2. Testing Tools → Sandbox Accounts: create **1 Personal** (US, shop owner Maria) and **4 Business** (US, the four fictional suppliers). Note the emails. Passwords stay in your notes; the personal account's test login also goes into the README for judges.
3. Give the agent the values as **environment variables**, never in chat. In the Claude Code session's title bar, open the cloud environment menu → *Edit*, and add:
   `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET`, `SPIKE_SUPPLIER_EMAIL` (the "Northside Dairy" business account), `SPIKE_BUYER_EMAIL` (the personal account), and optionally `SPIKE_BUYER_PASSWORD` (the personal account's *sandbox* password). A new session picks them up.
4. Buyer approval: the spike prints two sandbox approval URLs. Either open them yourself and approve while it runs, or set `SPIKE_BUYER_PASSWORD` so the agent can approve in a headless browser. The headless approval will be built and checked against the real sandbox login page in the first session that has credentials.

With those, the spike takes about 15 minutes.
