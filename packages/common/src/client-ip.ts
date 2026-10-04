import type { IncomingMessage } from 'node:http';

type IpSource = Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string | undefined } };

/**
 * Client address for rate limiting. Proxies append to X-Forwarded-For whatever
 * the viewer sent, so only entries added by trusted proxies can be believed.
 * `trustedHops` says which entry from the right is the viewer: 1 when the edge
 * appends the viewer address last (CloudFront), 2 when another proxy appends
 * its own address after it (Render). 0 or false ignores the header.
 */
export function clientIpFrom(req: IpSource, trustedHops: boolean | number): string {
  const hops = trustedHops === true ? 1 : trustedHops === false ? 0 : Math.max(0, Math.floor(trustedHops));
  if (hops > 0) {
    const raw = req.headers?.['x-forwarded-for'];
    const value = Array.isArray(raw) ? raw.join(',') : raw;
    const entries = value?.split(',').map((part) => part.trim()).filter(Boolean) ?? [];
    // Fewer entries than trusted hops means the chain is not the expected one: ignore it.
    if (entries.length >= hops) return entries[entries.length - hops]!;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

/** Parses a trust-proxy setting: "true" = 1 hop, "false"/empty = off, or a hop count (max 5). */
export function trustedProxyHops(value: string | undefined): number {
  if (value === undefined || value === '' || value === 'false' || value === '0') return 0;
  if (value === 'true') return 1;
  const parsed = Number.parseInt(value, 10);
  return Number.isNaN(parsed) ? 0 : Math.min(5, Math.max(0, parsed));
}
