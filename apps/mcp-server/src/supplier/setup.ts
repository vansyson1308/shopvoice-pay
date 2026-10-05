// Supplier agents from env. SUPPLIER_AGENT_MODE:
//   embedded (default) - the simulated supplier agents run in this process and
//                        are also served at /supplier-agent/<code>/merchant-cart;
//   url                - agents at SUPPLIER_AGENT_URL (standalone apps/supplier-agent);
//                        needs BUYER_AGENT_PRIVATE_KEY_PEM so they can verify our JWTs;
//   off                - no supplier ordering after a hold.
// The buyer agent's public keys are published at /.well-known/buyer-agent-jwks.json.
import { generateSigningKey, signingKeyFromPem } from '../../../../packages/common/dist/index.js';
import type { Logger, PublicJwk } from '../../../../packages/common/dist/index.js';
import { SupplierAgent, demoCatalogs } from '../../../supplier-agent/dist/index.js';
import { DirectCartTransport, HttpCartTransport, SupplierOrders } from './supplier-orders.js';

export interface SupplierSetup {
  readonly agent: SupplierAgent | null;
  readonly orders: SupplierOrders | null;
  readonly jwks: readonly PublicJwk[];
  readonly mode: 'embedded' | 'url' | 'off';
}

type DemoSeed = {
  readonly SUPPLIERS: readonly { readonly code: string; readonly name: string }[];
  readonly PRODUCTS: readonly (readonly [string, string, string, number, number, number, number, string, boolean])[];
};

export function loadSupplierAgents(env: Record<string, string | undefined>, seed: DemoSeed, logger: Logger, now: () => number = Date.now): SupplierSetup {
  const mode = env.SUPPLIER_AGENT_MODE === 'off' ? 'off' : env.SUPPLIER_AGENT_URL ? 'url' : 'embedded';
  if (mode === 'off') return { agent: null, orders: null, jwks: [], mode };
  const pem = env.BUYER_AGENT_PRIVATE_KEY_PEM?.replace(/\\n/g, '\n');
  if (mode === 'url' && !pem) throw new Error('SUPPLIER_AGENT_URL needs BUYER_AGENT_PRIVATE_KEY_PEM (the supplier agents verify our signed requests)');
  const kid = env.BUYER_AGENT_KID || 'shopvoice-buyer-1';
  const key = pem ? signingKeyFromPem(pem, kid) : generateSigningKey(kid);
  const jwks = [key.publicJwk];
  const signer = { privateKey: key.privateKey, kid };
  if (mode === 'url') {
    logger.info('supplier_agents', { mode, url: env.SUPPLIER_AGENT_URL });
    return { agent: null, orders: new SupplierOrders(new HttpCartTransport(env.SUPPLIER_AGENT_URL as string), signer, now), jwks, mode };
  }
  const agent = new SupplierAgent(demoCatalogs(seed.SUPPLIERS, seed.PRODUCTS), () => jwks, now);
  logger.info('supplier_agents', { mode, simulated: true, suppliers: seed.SUPPLIERS.length });
  return { agent, orders: new SupplierOrders(new DirectCartTransport(agent), signer, now), jwks, mode };
}
