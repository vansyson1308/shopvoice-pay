// OAuth Client ID Metadata Documents (draft-ietf-oauth-client-id-metadata-document,
// MCP authorization 2025-11-25). A client_id that is an HTTPS URL is fetched,
// validated and cached. The fetch is SSRF-guarded twice: the URL must name a
// public host, and the address the socket actually connects to is checked in
// a custom DNS lookup, so a rebinding DNS answer cannot reach private space.
import { lookup as dnsLookup } from 'node:dns';
import type { LookupAddress, LookupOptions } from 'node:dns';
import { request } from 'node:https';
import { isPublicIpAddress, validatePublicHttpsUrl } from '../../../../packages/common/dist/index.js';
import { validateRegisteredRedirectUri } from './redirect.js';

export interface ClientMetadataDocument {
  readonly clientId: string;
  readonly clientName: string;
  readonly clientUri: string | null;
  readonly redirectUris: readonly string[];
}

export interface CimdFetchResponse {
  readonly status: number;
  readonly headers: Record<string, string>;
  readonly body: string;
}

export type CimdFetcher = (url: URL, opts: { timeoutMs: number; maxBytes: number }) => Promise<CimdFetchResponse>;

export class CimdError extends Error {}

const MAX_BYTES = 5 * 1024;
const TIMEOUT_MS = 3000;
const MIN_TTL_MS = 60_000;
const MAX_TTL_MS = 24 * 3600_000;
const DEFAULT_TTL_MS = 3600_000;

export function isCimdClientId(clientId: string): boolean {
  if (clientId.length > 512 || clientId.includes('#')) return false;
  try {
    const url = new URL(clientId);
    return url.protocol === 'https:' && url.pathname.length > 1 && !url.hash;
  } catch {
    return false;
  }
}

export function validateCimdDocument(clientId: string, doc: unknown): ClientMetadataDocument {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new CimdError('invalid_document');
  const d = doc as Record<string, unknown>;
  if (d.client_id !== clientId) throw new CimdError('client_id_mismatch');
  if ('client_secret' in d || 'client_secret_expires_at' in d) throw new CimdError('client_secret_not_allowed');
  const method = d.token_endpoint_auth_method ?? 'none';
  if (method !== 'none') throw new CimdError('unsupported_auth_method');
  const uris = d.redirect_uris;
  if (!Array.isArray(uris) || uris.length === 0 || uris.length > 10
    || !uris.every((u) => typeof u === 'string' && validateRegisteredRedirectUri(u))) {
    throw new CimdError('invalid_redirect_uris');
  }
  if (d.grant_types !== undefined && (!Array.isArray(d.grant_types)
    || !d.grant_types.every((g) => g === 'authorization_code' || g === 'refresh_token'))) {
    throw new CimdError('unsupported_grant_type');
  }
  const name = typeof d.client_name === 'string' ? d.client_name.trim().slice(0, 100) : '';
  const clientUri = typeof d.client_uri === 'string' && validatePublicHttpsUrl(d.client_uri).ok ? d.client_uri : null;
  return { clientId, clientName: name, clientUri, redirectUris: uris as string[] };
}

function ttlFrom(cacheControl: string | undefined): number {
  if (!cacheControl) return DEFAULT_TTL_MS;
  if (/no-store|no-cache/i.test(cacheControl)) return MIN_TTL_MS;
  const m = /max-age=(\d+)/i.exec(cacheControl);
  if (!m?.[1]) return DEFAULT_TTL_MS;
  return Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(m[1]) * 1000));
}

export class CimdResolver {
  private readonly cache = new Map<string, { doc: ClientMetadataDocument; expiresMs: number }>();
  private readonly fetcher: CimdFetcher;
  private readonly now: () => number;

  constructor(opts: { fetcher?: CimdFetcher; now?: () => number } = {}) {
    this.fetcher = opts.fetcher ?? nodeCimdFetcher;
    this.now = opts.now ?? Date.now;
  }

  async resolve(clientId: string): Promise<ClientMetadataDocument> {
    const cached = this.cache.get(clientId);
    if (cached && cached.expiresMs > this.now()) return cached.doc;
    if (!isCimdClientId(clientId)) throw new CimdError('invalid_client_id');
    const checked = validatePublicHttpsUrl(clientId);
    if (!checked.ok) throw new CimdError('unsafe_url');
    let res: CimdFetchResponse;
    try {
      res = await this.fetcher(checked.url, { timeoutMs: TIMEOUT_MS, maxBytes: MAX_BYTES });
    } catch (error) {
      if (error instanceof CimdError) throw error;
      throw new CimdError('fetch_failed');
    }
    if (res.status !== 200) throw new CimdError('fetch_failed');
    const type = (res.headers['content-type'] ?? '').toLowerCase();
    if (!type.startsWith('application/json') && !/^application\/[\w.+-]*\+json/.test(type)) throw new CimdError('invalid_content_type');
    if (Buffer.byteLength(res.body, 'utf8') > MAX_BYTES) throw new CimdError('document_too_large');
    let parsed: unknown;
    try {
      parsed = JSON.parse(res.body);
    } catch {
      throw new CimdError('invalid_document');
    }
    const doc = validateCimdDocument(clientId, parsed);
    if (this.cache.size > 1000) this.cache.clear();
    this.cache.set(clientId, { doc, expiresMs: this.now() + ttlFrom(res.headers['cache-control']) });
    return doc;
  }
}

type LookupCallback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

/** DNS lookup that refuses non-public answers (checked at connect time). */
export function publicOnlyLookup(hostname: string, options: LookupOptions, callback: LookupCallback): void {
  dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    const safe = list.filter((a) => isPublicIpAddress(a.address));
    if (safe.length === 0 || safe.length !== list.length) {
      return callback(Object.assign(new Error('unsafe_address'), { code: 'EUNSAFE' }), []);
    }
    if (options.all) return callback(null, safe);
    const first = safe[0] as LookupAddress;
    return callback(null, first.address, first.family);
  });
}

export const nodeCimdFetcher: CimdFetcher = (url, { timeoutMs, maxBytes }) => new Promise((resolve, reject) => {
  const req = request(url, {
    method: 'GET',
    headers: { accept: 'application/json', 'user-agent': 'ShopVoice-OAuth/1.0' },
    lookup: publicOnlyLookup as unknown as NonNullable<Parameters<typeof request>[1]>['lookup'],
    timeout: timeoutMs
  }, (res) => {
    // Redirects are not followed: the document must live at the client_id URL.
    let size = 0;
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        req.destroy(new CimdError('document_too_large'));
        return;
      }
      chunks.push(chunk);
    });
    res.on('end', () => {
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(res.headers)) if (typeof v === 'string') headers[k] = v;
      resolve({ status: res.statusCode ?? 0, headers, body: Buffer.concat(chunks).toString('utf8') });
    });
    res.on('error', reject);
  });
  req.on('timeout', () => req.destroy(new CimdError('fetch_failed')));
  req.on('error', reject);
  req.end();
});
