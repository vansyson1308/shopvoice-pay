// Console routes for "snap the delivery invoice": the browser sends a photo (or
// picks a sample), the console reads it into plain line items, and the MCP
// server's 3-way match decides what may be charged. Reads are kept on the
// console for 15 minutes so "apply" sends exactly the lines the owner was shown.
// The extracted text is shown to the owner and sent to the match as data; it
// never reaches the voice brain.
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Logger } from '../../../packages/common/dist/index.js';
import { InvoiceReadError, MAX_INVOICE_BYTES, SAMPLE_INVOICES, invoiceImageFrom } from './invoice-extract.js';
import type { ExtractedInvoice, InvoiceExtractor, InvoiceImage } from './invoice-extract.js';

type OwnerApi = (token: string, method: string, path: string, body?: unknown) => Promise<{ status: number; json: Record<string, unknown> }>;

interface StoredRead {
  readonly tokenHash: string;
  readonly paymentId: string;
  readonly invoice: ExtractedInvoice;
  readonly expiresAt: number;
}

const READ_TTL_MS = 15 * 60 * 1000;
const MAX_READS = 500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function readJsonBody(req: IncomingMessage, max: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > max) throw new Error('body_too_large');
    chunks.push(buf);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed: unknown = text ? JSON.parse(text) : {};
  return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : {};
}

export function invoiceView(invoice: ExtractedInvoice) {
  return {
    supplier_name: invoice.supplierName,
    invoice_number: invoice.invoiceNumber,
    lines: invoice.lines.map((l) => ({ description: l.description, sku: l.sku, quantity: l.quantity, unit_price_minor: l.unitPriceMinor })),
    ignored_text: invoice.ignoredText,
    extractor: invoice.extractor,
    simulated: invoice.simulated
  };
}

export function createInvoiceRoutes(deps: { reader: InvoiceExtractor; api: OwnerApi; samplesDir: string; logger: Logger; now?: () => number }) {
  const reads = new Map<string, StoredRead>();
  const now = deps.now ?? Date.now;
  const hashOf = (token: string) => createHash('sha256').update(token).digest('hex');

  function send(res: ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(JSON.stringify(body));
  }

  function sweep(): void {
    const t = now();
    for (const [id, r] of reads) if (r.expiresAt <= t) reads.delete(id);
    while (reads.size >= MAX_READS) reads.delete(reads.keys().next().value as string);
  }

  function stored(token: string, readId: unknown): StoredRead | null {
    if (typeof readId !== 'string') return null;
    const r = reads.get(readId);
    return r && r.tokenHash === hashOf(token) && r.expiresAt > now() ? r : null;
  }

  async function match(token: string, read: StoredRead, counted: unknown, preview: boolean) {
    return deps.api(token, 'POST', `/payments/${encodeURIComponent(read.paymentId)}/invoice`, {
      preview,
      lines: invoiceView(read.invoice).lines,
      ...(Array.isArray(counted) ? { counted } : {}),
      extractor: read.invoice.extractor
    });
  }

  return {
    /** Handles /api/invoice/*; returns false for other paths. The caller has checked the session. */
    async handle(token: string, req: IncomingMessage, res: ServerResponse, url: URL): Promise<boolean> {
      if (!url.pathname.startsWith('/api/invoice/')) return false;
      try {
        if (req.method === 'GET' && url.pathname === '/api/invoice/samples') {
          send(res, 200, { reader: deps.reader.name, samples: SAMPLE_INVOICES.map((s) => ({ id: s.id, supplier_code: s.supplierCode, title: s.title, url: `/static/samples/${s.file}` })) });
          return true;
        }
        if (req.method === 'POST' && url.pathname === '/api/invoice/read') {
          const body = await readJsonBody(req, Math.ceil(MAX_INVOICE_BYTES * 1.4) + 4096);
          const paymentId = typeof body.payment_id === 'string' && UUID.test(body.payment_id) ? body.payment_id : null;
          if (!paymentId) {
            send(res, 400, { error: 'invalid_field', message: 'payment_id is required' });
            return true;
          }
          const view = await deps.api(token, 'GET', `/payments/${paymentId}`);
          if (view.status !== 200) {
            send(res, view.status, view.json);
            return true;
          }
          const payment = (view.json.payment ?? {}) as { supplier_name?: string; lines?: { sku: string; name: string }[]; held_minor?: number };
          if (!payment.held_minor) {
            send(res, 409, { error: 'nothing_held', message: 'This order has no money on hold.' });
            return true;
          }
          let image: InvoiceImage;
          if (typeof body.sample_id === 'string') {
            const sample = SAMPLE_INVOICES.find((s) => s.id === body.sample_id);
            if (!sample) {
              send(res, 404, { error: 'no_such_sample' });
              return true;
            }
            image = { mediaType: 'image/png', base64: (await readFile(join(deps.samplesDir, sample.file))).toString('base64') };
          } else {
            image = invoiceImageFrom(body.media_type, body.image_base64);
          }
          const invoice = await deps.reader.extract(image, { supplierName: payment.supplier_name ?? '', poLines: (payment.lines ?? []).map((l) => ({ sku: l.sku, name: l.name })) });
          sweep();
          const readId = randomUUID();
          const read: StoredRead = { tokenHash: hashOf(token), paymentId, invoice, expiresAt: now() + READ_TTL_MS };
          reads.set(readId, read);
          const preview = await match(token, read, null, true);
          deps.logger.info('invoice_read', { payment_id: paymentId, extractor: invoice.extractor, lines: invoice.lines.length, ignored_text: invoice.ignoredText.length });
          send(res, preview.status, { read_id: readId, invoice: invoiceView(invoice), ...preview.json });
          return true;
        }
        if (req.method === 'POST' && (url.pathname === '/api/invoice/preview' || url.pathname === '/api/invoice/apply')) {
          const body = await readJsonBody(req, 16_384);
          const read = stored(token, body.read_id);
          if (!read) {
            send(res, 404, { error: 'read_expired', message: 'That invoice reading expired. Read the photo again.' });
            return true;
          }
          const apply = url.pathname.endsWith('/apply');
          const out = await match(token, read, body.counted, !apply);
          if (apply && out.status === 200) reads.delete(String(body.read_id));
          send(res, out.status, { read_id: apply ? null : body.read_id, invoice: invoiceView(read.invoice), ...out.json });
          return true;
        }
        send(res, 404, { error: 'not_found' });
        return true;
      } catch (error) {
        if (error instanceof InvoiceReadError) {
          send(res, error.code === 'not_configured' ? 501 : 422, { error: error.code, message: error.message });
          return true;
        }
        throw error;
      }
    }
  };
}
