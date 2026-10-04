# Decisions

Each entry gives the decision, the reasoning, and what would change it. Dates are Vietnam time.

## D1. Settlement model: platform procurement wallet + Payouts (2026-10-04, **confirmed by the sandbox spike**)

**Decision.** Every supplier order, auto-pay or step-up, is an `AUTHORIZE` order whose payee is the ShopVoice platform sandbox account (the "procurement wallet").
- Auto-pay orders use the owner's vaulted PayPal account, with no buyer interaction.
- Step-up orders use the same vault once the owner approves in ShopVoice. If no vault exists yet, the owner approves in PayPal (the `payer-action` link or a QR code).
- On delivery we capture what arrived and void the rest.
- The supplier is paid with a Payouts item for the captured amount, net of refunds, in a settlement run.

**Evidence (SPIKE.md, real sandbox runs, 2026-10-04):**
- A vaulted order naming the supplier as payee is rejected with 422 `BILLING_AGREEMENT_NOT_FOUND`, for both CAPTURE and AUTHORIZE. A `MERCHANT` vault token is an agreement with the API caller only.
- When the supplier is the payee (buyer-approved), the platform **cannot void** the authorization: 403 `PERMISSION_DENIED`, even before any capture. It can only release the remainder by capturing with `final_capture:true`. "Cancel the hold because nothing arrived" would therefore be impossible.
- With the platform as payee, everything the product needs works:
  - vaulted AUTHORIZE with no buyer;
  - partial capture then void (`VOIDED`);
  - full capture and refunds;
  - Payouts to the supplier reaching `SUCCESS` in about 31 s.

**Consequences.**
- A refund after the supplier was paid out is netted against that supplier's next settlement and shown as "supplier credit". By default the settlement run waits until the delivery check passes, so refunds for spoiled goods usually reduce the payout instead.
- In production this would be a regulated flow (a platform holding funds for sellers), so production uses a different design; see "Production path" below.
- The `direct_payee` setting is removed from the plan; there is one settlement code path.

### Production path (D1)

**What the demo does, and why.** The platform wallet + Payouts flow is the *sandbox-proven* design for this demo.
- Every supplier order is a PayPal `AUTHORIZE` paid to the ShopVoice platform sandbox account.
- After delivery, the supplier is paid through Payouts.
- We chose it because the spike showed that the direct alternatives do not work for a self-serve app:
  - **A vaulted order naming the supplier as payee is rejected.** 422 `BILLING_AGREEMENT_NOT_FOUND`, for both `AUTHORIZE` and `CAPTURE` (SPIKE.md §4.3; debug ids `f7579910c0f08`, `f6843248f81d9`). A `MERCHANT` vault token is an agreement between the payer and the API caller only.
  - **The platform cannot release a hold it is not the payee of.** Voiding a supplier-payee authorization returns 403 `NOT_AUTHORIZED / PERMISSION_DENIED`, even before any capture (SPIKE.md §4.2, checks S2.2 and S2.9). So "nothing arrived, release the money" would be impossible with direct payees.

**Production.** In production, ShopVoice would **not** hold third-party funds. It would use PayPal's **multiparty / partner onboarding**:
- Each supplier is onboarded through PayPal partner referrals and consents to ShopVoice acting on its behalf. Suppliers become onboarded payees (`purchase_units[].payee.merchant_id`).
- The owner's vault token is created with `usage_type: PLATFORM` under ShopVoice's partner attribution (`PayPal-Partner-Attribution-Id`).
- Holds, captures, voids and refunds are made on the supplier's behalf with `PayPal-Auth-Assertion`.
- Money moves from the shop directly to the supplier. ShopVoice keeps the policy, ledger and audit role, and never sits in the funds flow, so no Payouts step is needed.

**What stays the same in production:** the policy engine, the ledger state machine, the hold-then-capture-on-delivery flow and the agent. Only the payee field and the partner headers change.

**What we have not built** for the hackathon, because it needs PayPal partner approval: supplier onboarding (KYC) and the `PLATFORM` vault flow. README and DEVPOST say so plainly.

## D2. Hold first, capture on delivery (2026-10-04, **confirmed**)

**Decision.**
- Every supplier order uses `intent: AUTHORIZE`.
- Full delivery: `capture(final_capture: true)`.
- Short delivery: `capture(delivered value, final_capture: false)` then `void` of the remainder. Two ledger events, so the "released" amount is visible.
- Nothing delivered: `void`.
- Variance above tolerance: hold and step up.
- Honor period: from day 3 the UI warns; from day 4 the server reauthorizes (new authorization id, same 29-day end) before capturing.

**Evidence.**
- Partial capture is enabled for wallet authorizations on this sandbox account: S2.2, S2.5, S2.10.
- Partial capture then void ends `VOIDED` (S2.10).
- `final_capture:true` releases the remainder (`CAPTURED`, S2.5/S2.8) and is the fallback if a void ever fails.
- Reauthorizing early returns `REAUTHORIZATION_TOO_SOON` (S2.3).
- Authorizations expire 29 days after creation (S2.1).

## D3. Our own thin REST client for money movement; Agent Toolkit for everything else (2026-10-04)

**Decision.** Orders, authorize/capture/void/reauthorize, Vault, Payouts, refunds and webhook verification go through `apps/mcp-server/src/payments` (our client). `@paypal/agent-toolkit` provides invoicing (the store's catering sales), shipment tracking, the transaction list and order lookup. Toolkit tools are wrapped behind our policy layer and never exposed raw to the LLM.

Spike T1–T8 confirmed `create_invoice`, `send_invoice`, `get_order`, `create_shipment_tracking`, `get_shipment_tracking`, `create_refund` and `list_transactions` in sandbox. `get_merchant_insights` is not supported in sandbox. `list_transactions` lags behind real time in sandbox (1 result after dozens of transactions), so spend summaries come from our ledger and the toolkit is a cross-check.

**Why.** Toolkit 1.11.0 has no authorize, void, vault, payout or cart tools (spike T0). Its `create_order` is CAPTURE-only with no payee. Its `context.request_id` pins one idempotency key per toolkit instance. Money movement needs a fresh key per operation, replayed exactly on retry, plus ledger and audit writes in the same code path.

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

**Why.** The server only supports OAuth `authorization_code` + PKCE (a browser login). Spike T9: with no token, `/mcp` returns 401; with a REST client-credentials bearer it returns 404; the documented `/http` path returns 404. An unattended agent therefore cannot use it. The Agent Toolkit gives the same tools in-process.

## D8. Work staging until the new repository existed (2026-10-04, resolved)

`vansyson1308/shopvoice-pay` did not exist at the start of M0. The GitHub connector cannot create repositories (403), so the owner created it. The history was built locally and pushed with `main` = the import commit; everything after it went through PRs. Nothing was pushed to groceryclaw on any branch.

## D9. Sandbox buyer approval is automated with Playwright, for tests only (2026-10-04, gated 2026-10-05)

**Decision.** `scripts/paypal/sandbox-approver.mjs` logs in as the sandbox personal account in headless Chromium and approves orders and vault setup tokens, so the spike and the sandbox tests can run unattended.
- It refuses non-sandbox URLs.
- Behind a TLS-intercepting proxy it pins the proxy CA's key instead of disabling certificate checks.

**Gate (owner decision, 2026-10-05).** The approver runs only when `SHOPVOICE_TEST_ONLY_HEADLESS_APPROVAL=1` is set. It refuses when `NODE_ENV=production` and when it detects a hosting platform (`RENDER`, `RENDER_SERVICE_ID`, `RAILWAY_ENVIRONMENT`). Only `npm run spike` sets the flag. `tests/unit/approver-gate.test.mjs` proves that:
- the gate refuses in each of those cases;
- no file under `apps/` or `packages/` (source or build output) references the approver or imports Playwright;
- no Dockerfile copies `scripts/paypal`;
- Playwright is a dev dependency only.

**Why.** Four buyer approvals per spike run, and later the hosted e2e, would otherwise need a person at a keyboard. The product itself never automates the owner's approval. Playwright is also the planned e2e runner (§7.B), so this adds no new framework.

## D10. Approving a step-up from any MCP client, without the model (2026-10-05, owner decision for M2)

**Decision.** When the rules say "ask the owner" (step-up), `confirm_reorder` gets the approval by the first path that applies:
1. **The owner's ShopVoice console** (static bearer, voice profile). The payment waits on the console's approval card. A spoken "yes" is matched by server code, not by the model.
2. **Other MCP clients that support a form (MCP elicitation, form mode).** The server asks the client directly: "Approve $142 to Valley Farm Eggs? …" with a yes/no field. Accept places the hold (`approved_by = owner_elicitation`, migration 021). Decline voids the payment.
3. **Otherwise, PayPal's own approval page.** The server creates a one-off AUTHORIZE order and the owner approves it on PayPal (phone link or QR). PayPal's login is the step-up. If the client supports URL elicitation, the link goes straight to the client and is left out of the tool result. Otherwise it is returned as `approval_url`. When PayPal reports the order approved, the rules run again before the hold is placed (`approved_by = owner_paypal`).
4. **Otherwise the payment is declined, with the reason** ("I couldn't get an approval request to you, so I didn't pay").

**What the model never sees.**
- The ShopVoice approval token: it is stored only as a hash, and none of the paths returns it.
- The vault id, and PayPal authorization and capture ids.
- The PayPal order id appears only inside PayPal's approval URL in path 3, and it cannot move money without the owner's PayPal login and our server credentials.
- `tests/unit/mcp-payments.test.mjs` checks every tool result, the elicitation requests and the audit log for these values.

**Spending rules follow the same principle.** Tightening a rule applies at once. A change that lets more be paid without asking (a higher limit, a removed hard cap, a newly approved supplier, looser checks) needs the owner's own approval: the client's form, or the console's Policy tab. Otherwise nothing changes.

**Transactions.** Payment tools run as "session" tools: every repository call commits on its own (`auto-commit.ts`), still under RLS. So a PayPal hold and the ledger row that records it are durable together, and waiting for the owner never holds a database transaction open. Clients that declare elicitation get streamed (SSE) responses for their session, because a JSON response cannot carry a server-to-client request mid-call. Other clients keep plain JSON.

**Idempotency.** One draft backs at most one live payment (unique index, migration 021). Confirming the same drafts again reports the existing payments. A step-up still waiting gets a fresh approval request; nothing is paid twice.

## D11. The console's owner API is separate from MCP and closed to AI clients (2026-10-05)

**Decision.** The console's screens (approvals, ledger, rules, suppliers, Connect PayPal, deliveries, refunds) use `/owner/api/*` on the MCP server, not MCP tools:
- The browser calls the console. The console server forwards with its own server-side credential, which the browser never holds.
- The owner API accepts only static (console) bearer tokens. It refuses OAuth tokens, which belong to third-party AI clients, and it refuses any request carrying a browser `Origin`.
- No model sits on this path. A tap on the approval card approves by ledger id (`approved_by = owner_tap`), with the same rules re-check and expiry as every other approval path.

**Webhooks.** `POST /webhooks/paypal`:
1. verifies the signature with PayPal against the raw body, byte for byte;
2. maps the event's `custom_id` (our payment id) to its tenant with a security-definer lookup that returns nothing else (migration 022);
3. records `webhook_received` once per event id;
4. calls `sync()`, which re-reads PayPal's state.

Money state is never taken from the webhook payload, so a forged or replayed event cannot move it (tested).

**Simulated PayPal (mock mode only).** With `PAYPAL_MODE=mock`, approval links point at the console's `/sim/paypal/*` page. Its banner says it is simulated and that no money moves. It redirects back only within the console. With `PAYPAL_MODE=sandbox`, the same links go to sandbox.paypal.com.
