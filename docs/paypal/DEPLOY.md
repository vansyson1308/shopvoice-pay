# Deploying the hosted demo (Render)

`render.yaml` is a Render Blueprint. Everything is PayPal **sandbox** only, and there is no live mode. D15 in DECISIONS.md explains the design.

| Service | Plan | About |
|---|---|---|
| `shopvoice-console` | 0.5 CPU / 512 MB web | $7/month |
| `shopvoice-mcp` | 0.5 CPU / 512 MB web | $7/month |
| `shopvoice-db` | 0.5 CPU / 512 MB private service + 1 GB disk | $7.25/month |

That is about **$21 per month**. Paid instances do not sleep, which the demo needs: it must stay reachable until at least Dec 21. Check Render's current prices when you sign up.

## Owner steps

1. **Render account.** Sign up at render.com and connect GitHub with access to `vansyson1308/shopvoice-pay`. Add a payment method.
2. **Create the Blueprint.** Choose New > Blueprint, pick the repository and branch `main`, and Render reads `render.yaml`. It asks for the `sync: false` values. Type them into Render's form; never paste them anywhere else:

   | Variable | Value |
   |---|---|
   | `PAYPAL_CLIENT_ID`, `PAYPAL_CLIENT_SECRET` | the sandbox REST app "ShopVoice Pay" |
   | `CONSOLE_PUBLIC_URL` | `https://shopvoice-console.onrender.com` (adjust in step 4 if Render picks another name) |
   | `PUBLIC_BASE_URL` | `https://shopvoice-mcp.onrender.com` (same caveat) |
   | `SANDBOX_SUPPLIER_EMAIL` | the sandbox business account that plays Northside Dairy |
   | `SANDBOX_SUPPLIER_EMAILS` | the other three, comma-separated: Valley Farm Eggs, Hillside Bakery, Harbor Wholesale |
   | `PAYPAL_WEBHOOK_ID` | leave empty for now (step 5) |
   | `BEDROCK_AWS_ACCESS_KEY_ID`, `BEDROCK_AWS_SECRET_ACCESS_KEY`, `ANTHROPIC_API_KEY` | leave empty until Claude access is ready (step 7) |

3. **Apply.** Render builds the two images, starts Postgres, and runs `node scripts/deploy/db_prepare.mjs` before the MCP server starts. That step applies migrations, creates the RLS-bound app role and seeds the demo shop. The deploy log shows `db_prepare: done`.
4. **Check the URLs.** If either service URL differs from the defaults above, update `CONSOLE_PUBLIC_URL` and `PUBLIC_BASE_URL` on `shopvoice-mcp` (Environment) and redeploy.
5. **PayPal webhook.** In the sandbox app, under Webhooks, add `https://<shopvoice-mcp URL>/webhooks/paypal` with the events listed in SPIKE.md S6. Copy its webhook id into `PAYPAL_WEBHOOK_ID` on `shopvoice-mcp`.
6. **Smoke test.**
   - `https://<shopvoice-mcp URL>/readyz` returns `{"status":"ready","checks":{"database":"ok"}}`.
   - Open the console URL, click **Try the demo**, and run the hero story.
   - Proxy hop setting: the `demo_shop_created` and rate-limit logs on the MCP service should show visitor addresses, not Render's. If they show a 10.x address, set `MCP_TRUST_PROXY` and `SIM_TRUST_PROXY` to `1`.
7. **Claude (when access is ready).** On `shopvoice-console`, set `BRAIN=claude-bedrock` plus `BEDROCK_AWS_ACCESS_KEY_ID` and `BEDROCK_AWS_SECRET_ACCESS_KEY`. The IAM principal needs `bedrock-mantle:CreateInference` on the Claude model ARNs in us-east-1. Alternatively, set `BRAIN=claude-api` with `ANTHROPIC_API_KEY`. If Claude cannot be reached, the console falls back to the offline rules brain and says so.

Later deploys happen automatically when CI passes on `main` (`autoDeployTrigger: checksPass`).

## Running the same images locally

```bash
docker build -f apps/mcp-server/Dockerfile -t shopvoice-mcp .
docker build -f apps/console/Dockerfile -t shopvoice-console .
```

The MCP image includes `psql`, the migrations and `scripts/deploy/db_prepare.mjs`. Run it with `node scripts/deploy/db_prepare.mjs`, with `MCP_DB_HOST`, `DB_ADMIN_PASSWORD` (or `DB_ADMIN_URL`), `MCP_DB_USER` and `MCP_DB_PASSWORD`, before starting the server.
