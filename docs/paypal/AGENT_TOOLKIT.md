# PayPal Agent Toolkit behind the policy layer

ShopVoice uses `@paypal/agent-toolkit` 1.11 for PayPal features that move no money:
- delivery tracking on supplier charges;
- a cross-check of the ledger against PayPal's transaction records;
- invoices for the shop's own catering customers.

The model never gets the toolkit's tools. It calls four ShopVoice MCP tools with ShopVoice ids. Server code (`ToolkitGateway`) decides what to send, and the toolkit's own request code sends it. Decision record: DECISIONS D19. Spike results: SPIKE.md T0–T9.

## Layers

| Layer | File | Job |
|---|---|---|
| MCP tools | `apps/mcp-server/src/toolkit-tools.ts` | `get_delivery_tracking`, `check_paypal_records`, `create_catering_invoice` (two steps), `get_catering_invoices`. They take and return ShopVoice ids only. |
| Policy layer | `apps/mcp-server/src/toolkit/toolkit-gateway.ts` | Bounds, recipient rules and limits. Looks up PayPal ids from the ledger and derives request ids. Writes ledger events and `sales_invoices` rows, and validates PayPal's answers. |
| Runner | `apps/mcp-server/src/toolkit/agent-toolkit.ts` | Allow-list; `PayPal-Request-Id` required on POST. Runs the toolkit's `PayPalAPI` with an injected client: our token, our base URL, our request id. |
| PayPal | sandbox, or `MockPayPal` | Mock mode uses a loopback bridge (127.0.0.1, random path). The real toolkit code runs in tests, and nothing leaves the machine. |

## Allow-list and deny-list

| Toolkit method | Used for | Request id |
|---|---|---|
| `create_shipment_tracking` | Tracking on a capture after delivery (status `DELIVERED`) | `svp-track-<capture id>` |
| `get_shipment_tracking` | `get_delivery_tracking` | (GET) |
| `list_transactions` | `check_paypal_records`, ≤ 31 days | (GET) |
| `create_invoice` | Catering invoice, after the owner confirms | `svp-inv-<invoice number>` |
| `send_invoice` | Same | `svp-inv-<invoice number>-send` |
| `get_invoice` | Paid status for `get_catering_invoices` | (GET) |
| `create_refund`, `create_order`, `pay_order`, `capture_order` | **Denied.** They move money, so they stay in `PaymentsService` behind the rules engine and ledger | |
| `get_merchant_insights` | **Denied.** Not supported in the sandbox (spike T8); spend comes from the ledger | |

## Sequence: a catering invoice

```mermaid
sequenceDiagram
    autonumber
    actor Owner
    participant Console as Console host (voice)
    participant Model as Claude (voice brain)
    participant MCP as MCP tool create_catering_invoice
    participant GW as ToolkitGateway (policy layer)
    participant TK as Agent Toolkit (PayPalAPI, injected client)
    participant PayPal as PayPal sandbox

    Owner->>Console: "Invoice jordan@personal.example.com for two sandwich platters at $45"
    Console->>Model: owner text + tools
    Model->>Console: create_catering_invoice {email, items}
    Console->>Console: owner-intent check ("invoice" in the owner's words)
    Console->>MCP: call
    MCP->>GW: prepareCatering
    GW->>GW: sandbox recipient? ≤10 items, ≤$500 each, total ≤ $1,000, ≤10/day, clean text
    GW-->>MCP: draft row in sales_invoices (RLS)
    MCP-->>Console: preview + confirmation_token (HMAC: shop, invoice, total, recipient; 5 min)
    Console->>Console: hold the token; the model sees "[held by host]"
    Console-->>Owner: "Invoice j***n@personal.example.com $90 … Say confirm"
    Owner->>Console: "Yes, send it"
    Model->>Console: create_catering_invoice {confirmation_token: anything}
    Console->>Console: the owner said yes this turn → substitute the held token
    Console->>MCP: call with the real token
    MCP->>GW: sendCatering (token verified)
    GW->>TK: create_invoice, PayPal-Request-Id svp-inv-SVP-CAT-…
    TK->>PayPal: POST /v2/invoicing/invoices
    PayPal-->>TK: link (invoice id)
    GW->>TK: send_invoice, PayPal-Request-Id svp-inv-SVP-CAT-…-send
    TK->>PayPal: POST /v2/invoicing/invoices/{id}/send
    GW-->>MCP: sales_invoices: sent (PayPal id stays on the server)
    MCP-->>Owner: "Sent. The $90 catering invoice is on its way …"
```

## Tracking after delivery

When `record_delivery` (or an invoice-photo match) charges a delivery, `PaymentsService` calls `ToolkitGateway.trackDelivery` with the new capture id:
- The tracking number is the supplier agent's order number, validated at checkout, or `SVP-<payment>`.
- It is recorded as a `shipment_tracked` ledger event, with the request id and the capture id kept server side.
- A failure never undoes the charge. `get_delivery_tracking` retries it, and the request id prevents duplicates.

## Tests

- `tests/unit/agent-toolkit.test.mjs`:
  - the allow-list, denied methods, and request ids required on POST;
  - replay with the same key; the bridge is loopback-only;
  - catering bounds and the daily limit; a retry after a failed send makes no second invoice;
  - tracking after a charge, and the cross-check (match, then lag);
  - the catering token: forged, from another shop, expired;
  - no capture or invoice id in tool output;
  - `PAYPAL_TOOLKIT=off`;
  - the console host holds the token and refuses a model acting alone.
- `tests/unit/ledger-contract.mjs` (memory and Postgres): sales invoice moves and uniqueness; `shipment_tracked`.
- `tests/db/payments-rls.test.mjs`: `sales_invoices` under forced RLS. `tests/db/demo-shops-db.test.mjs`: a demo reset clears invoices.
- `tests/sandbox/agent-toolkit-sandbox.test.mjs` (CI with sandbox secrets): real capture → tracking; cross-check; a catering invoice sent to the supplier's sandbox account.
- Evals: S23 (the model invoices on its own), S24 (a forged token is replaced; only a yes sends), S25 (real-world address or over the limit), Q16, Q17.

## Simulated or limited

- In `PAYPAL_MODE=mock`, invoicing, tracking and transaction search are served by `MockPayPal`. The response shapes come from the sandbox spike (T1, T2, T4, T5, T7).
- PayPal's sandbox does not email real people. Recipients are limited to reserved `example.com` domains in any case.
- `list_transactions` reads one page (up to 100 rows) of at most 31 days.
