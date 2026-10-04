export interface SafeFetchConfig {
  readonly allowedDomains: readonly string[];
  readonly allowHttpDomains?: readonly string[];
  readonly maxBytes: number;
  readonly timeoutMs: number;
}

export interface SafeFetchResult {
  readonly contentType: string;
  readonly body: Buffer;
}

function isIpHost(hostname: string): boolean {
  return /^\d+\.\d+\.\d+\.\d+$/.test(hostname);
}

function isPrivateIPv4(hostname: string): boolean {
  if (!isIpHost(hostname)) return false;
  const parts = hostname.split('.').map((x) => Number(x));
  const a = parts[0] ?? -1;
  const b = parts[1] ?? -1;
  if (a === 10) return true;
  if (a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 192 && b === 168) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  return false;
}

export function validateSafeAttachmentUrl(
  input: string,
  allowedDomains: readonly string[],
  allowHttpDomains: readonly string[] = []
): { ok: true; url: URL } | { ok: false } {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false };
  }

  const host = parsed.hostname.toLowerCase();
  if (host === 'localhost' || host === '::1' || host.endsWith('.local')) return { ok: false };
  if (isPrivateIPv4(host)) return { ok: false };

  const allowed = allowedDomains.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (!allowed) return { ok: false };

  const allowHttp = allowHttpDomains.some((suffix) => host === suffix || host.endsWith(`.${suffix}`));
  if (parsed.protocol === 'https:') {
    if (parsed.port && parsed.port !== '443') return { ok: false };
  } else if (parsed.protocol === 'http:') {
    if (!allowHttp) return { ok: false };
  } else {
    return { ok: false };
  }

  return { ok: true, url: parsed };
}

export async function fetchUrlSafely(
  url: string,
  config: SafeFetchConfig,
  fetchImpl: typeof fetch = fetch
): Promise<SafeFetchResult> {
  const validated = validateSafeAttachmentUrl(url, config.allowedDomains, config.allowHttpDomains ?? []);
  if (!validated.ok) {
    throw new Error('unsafe_url');
  }

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), config.timeoutMs);

  try {
    const response = await fetchImpl(validated.url.toString(), {
      method: 'GET',
      redirect: 'error',
      signal: ac.signal
    });

    if (!response.ok) throw new Error('fetch_failed');

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('xml') && !contentType.includes('text/plain') && contentType !== '') {
      throw new Error('invalid_content_type');
    }

    const text = await response.text();
    const body = Buffer.from(text, 'utf8');
    if (body.length > config.maxBytes) {
      throw new Error('payload_too_large');
    }

    return { contentType, body };
  } finally {
    clearTimeout(timer);
  }
}

// ---- Public-internet URL guard (OAuth client metadata documents) -----------
// Unlike validateSafeAttachmentUrl there is no domain allow-list, so every public
// HTTPS host may publish a Client ID Metadata Document. The guard rejects
// loopback, private, link-local, CGNAT, multicast and reserved addresses, and
// callers must re-check the resolved address at connect time (DNS rebinding).

function ipv4ToInt(ip: string): number | null {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const v = Number(part);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

const BLOCKED_V4: readonly [string, number][] = [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.88.99.0', 24], ['192.168.0.0', 16],
  ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4]
];

function isPublicIpv4(ip: string): boolean {
  const n = ipv4ToInt(ip);
  if (n === null) return false;
  for (const [base, bits] of BLOCKED_V4) {
    const b = ipv4ToInt(base) ?? 0;
    const size = 2 ** (32 - bits);
    if (n >= b && n < b + size) return false;
  }
  return true;
}

function expandIpv6(ip: string): number[] | null {
  let s = ip.toLowerCase();
  if (s.startsWith('[') && s.endsWith(']')) s = s.slice(1, -1);
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  let tail: number[] = [];
  const lastColon = s.lastIndexOf(':');
  const maybeV4 = s.slice(lastColon + 1);
  if (maybeV4.includes('.')) {
    const n = ipv4ToInt(maybeV4);
    if (n === null) return null;
    tail = [Math.floor(n / 65536), n % 65536];
    s = `${s.slice(0, lastColon + 1)}0:0`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const parse = (part: string) => (part ? part.split(':').map((h) => (/^[0-9a-f]{1,4}$/.test(h) ? parseInt(h, 16) : NaN)) : []);
  const head = parse(halves[0] ?? '');
  const rest = halves.length === 2 ? parse(halves[1] ?? '') : [];
  const fill = 8 - head.length - rest.length;
  if (halves.length === 1 && fill !== 0) return null;
  if (fill < 0) return null;
  const words = [...head, ...Array<number>(halves.length === 2 ? fill : 0).fill(0), ...rest];
  if (words.length !== 8 || words.some((w) => Number.isNaN(w))) return null;
  if (tail.length === 2) {
    words[6] = tail[0] ?? 0;
    words[7] = tail[1] ?? 0;
  }
  return words;
}

function isPublicIpv6(ip: string): boolean {
  const w = expandIpv6(ip);
  if (!w) return false;
  const [w0 = 0, w1 = 0, w2 = 0, w3 = 0, w4 = 0, w5 = 0, w6 = 0, w7 = 0] = w;
  if (w.every((x) => x === 0)) return false; // ::
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && w5 === 0 && w6 === 0 && w7 === 1) return false; // ::1
  if (w0 === 0 && w1 === 0 && w2 === 0 && w3 === 0 && w4 === 0 && (w5 === 0xffff || w5 === 0)) {
    // IPv4-mapped / -compatible: judge the embedded IPv4 address.
    return isPublicIpv4(`${w6 >> 8}.${w6 & 255}.${w7 >> 8}.${w7 & 255}`);
  }
  if ((w0 & 0xfe00) === 0xfc00) return false; // fc00::/7 unique local
  if ((w0 & 0xffc0) === 0xfe80) return false; // fe80::/10 link local
  if ((w0 & 0xff00) === 0xff00) return false; // ff00::/8 multicast
  if (w0 === 0x64 && w1 === 0xff9b) return false; // 64:ff9b::/96 NAT64
  if (w0 === 0x2001 && w1 === 0x0db8) return false; // documentation
  return true;
}

/** True for a globally routable unicast IPv4/IPv6 literal. */
export function isPublicIpAddress(ip: string): boolean {
  return ip.includes(':') ? isPublicIpv6(ip) : isPublicIpv4(ip);
}

export function validatePublicHttpsUrl(input: string): { ok: true; url: URL } | { ok: false } {
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    return { ok: false };
  }
  if (parsed.protocol !== 'https:') return { ok: false };
  if (parsed.username || parsed.password) return { ok: false };
  if (parsed.port && parsed.port !== '443') return { ok: false };
  const host = parsed.hostname.toLowerCase();
  if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
    return { ok: false };
  }
  const literal = host.startsWith('[') ? host.slice(1, -1) : host;
  if (/^[\d.]+$/.test(literal) || literal.includes(':')) {
    if (!isPublicIpAddress(literal)) return { ok: false };
  } else if (!literal.includes('.')) {
    return { ok: false };
  }
  return { ok: true, url: parsed };
}
