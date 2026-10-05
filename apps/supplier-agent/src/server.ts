// Standalone simulated supplier agents (optional; the MCP server mounts the
// same handler at /supplier-agent by default). Trusts the buyer agent's public
// key from BUYER_AGENT_JWKS (a JSON array of RS256 JWKs).
import { createServer } from 'node:http';
import { createLogger } from '../../../packages/common/dist/index.js';
import type { PublicJwk } from '../../../packages/common/dist/index.js';
import { SupplierAgent, demoCatalogs } from './agent.js';
import { handleCartHttp } from './http.js';

async function main(): Promise<void> {
  const logger = createLogger({ service: 'supplier-agent', level: 'info' });
  const keys = JSON.parse(process.env.BUYER_AGENT_JWKS ?? '[]') as PublicJwk[];
  if (!Array.isArray(keys) || keys.length === 0) throw new Error('BUYER_AGENT_JWKS (the buyer agent public keys, a JSON array) is required');
  const seed = (await import(new URL('../../../scripts/gen_demo_seed.mjs', import.meta.url).href)) as {
    SUPPLIERS: { code: string; name: string }[];
    PRODUCTS: [string, string, string, number, number, number, number, string, boolean][];
  };
  const agent = new SupplierAgent(demoCatalogs(seed.SUPPLIERS, seed.PRODUCTS), () => keys);
  const port = Number.parseInt(process.env.PORT ?? process.env.SUPPLIER_AGENT_PORT ?? '8092', 10);
  createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname === '/healthz') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'supplier-agent', simulated: true }));
      return;
    }
    void handleCartHttp(agent, '', req, res, url).then((handled) => {
      if (!handled) {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ name: 'RESOURCE_NOT_FOUND' }));
      }
    });
  }).listen(port, '0.0.0.0', () => logger.info('supplier_agent_listening', { port, simulated: true }));
}

main().catch((error: unknown) => {
  console.error(JSON.stringify({ level: 'error', service: 'supplier-agent', message: 'start_failed', error: error instanceof Error ? error.message : 'unknown' }));
  process.exit(1);
});
