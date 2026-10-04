import type { IncomingMessage } from 'node:http';

type IpSource = Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string | undefined } };

// Client address for rate limiting. Behind a trusted proxy (CloudFront), only the
// rightmost X-Forwarded-For entry is trustworthy: the proxy appends the real
// viewer address to whatever the viewer sent, so earlier entries can be forged.
export function clientIpFrom(req: IpSource, trustProxy: boolean): string {
  if (trustProxy) {
    const raw = req.headers['x-forwarded-for'];
    const value = Array.isArray(raw) ? raw.join(',') : raw;
    const last = value?.split(',').map((part) => part.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  return req.socket.remoteAddress ?? 'unknown';
}
