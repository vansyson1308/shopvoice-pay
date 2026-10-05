// HTTP adapter: /<supplier code>/merchant-cart[/<id>[/checkout]] -> SupplierAgent.
// Mounted inside the MCP server by default (one less service to host), or run
// standalone with server.ts.
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SupplierAgent } from './agent.js';

async function readJson(req: IncomingMessage, max = 65_536): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new Error('body_too_large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text ? JSON.parse(text) : {};
}

/** Returns false when the path is not a cart route under `prefix`. */
export async function handleCartHttp(agent: SupplierAgent, prefix: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
  if (!url.pathname.startsWith(`${prefix}/`)) return false;
  const m = /^\/([A-Z0-9-]{2,40})\/merchant-cart(\/.*)?$/.exec(url.pathname.slice(prefix.length));
  const send = (status: number, json: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'x-simulated': 'supplier-agent' });
    res.end(JSON.stringify(json));
  };
  if (!m) {
    send(404, { name: 'RESOURCE_NOT_FOUND', message: 'No such route.' });
    return true;
  }
  let body: unknown = {};
  if (req.method === 'POST' || req.method === 'PUT') {
    try {
      body = await readJson(req);
    } catch {
      send(400, { name: 'INVALID_REQUEST', message: 'Malformed JSON body.' });
      return true;
    }
  }
  const headers: Record<string, string | undefined> = {};
  for (const name of ['authorization', 'paypal-request-id']) {
    const v = req.headers[name];
    headers[name] = Array.isArray(v) ? v[0] : v;
  }
  const out = await agent.handle(m[1] ?? '', req.method ?? 'GET', m[2] ?? '', headers, body);
  send(out.status, out.json);
  return true;
}
