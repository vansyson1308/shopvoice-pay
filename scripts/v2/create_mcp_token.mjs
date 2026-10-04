#!/usr/bin/env node
// Mint a ShopVoice MCP bearer token for a tenant.
// Usage: DATABASE_URL=... node scripts/v2/create_mcp_token.mjs <tenant-uuid> [label]
// The token is printed once; only its SHA-256 hash is stored in mcp_access_tokens.
import { mintMcpToken } from './mcp_token_lib.mjs';

const [tenantId, label = 'cli'] = process.argv.slice(2);
if (!tenantId) {
  console.error('usage: node scripts/v2/create_mcp_token.mjs <tenant-uuid> [label]');
  process.exit(1);
}

const { token } = mintMcpToken({ tenantId, label });
console.log(token);
