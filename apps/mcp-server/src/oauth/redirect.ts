// Redirect URI rules (OAuth 2.1 exact matching + RFC 8252 loopback).
// Claude's hosted apps use one fixed callback; Claude Code uses a loopback
// redirect on an ephemeral port, so loopback URIs match with the port ignored.

export const CLAUDE_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function parse(uri: string): URL | null {
  try {
    return new URL(uri);
  } catch {
    return null;
  }
}

export function isLoopbackRedirect(uri: string): boolean {
  const url = parse(uri);
  return !!url && url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/** What a client may register: https anywhere, or http on a loopback host. */
export function validateRegisteredRedirectUri(uri: string): boolean {
  if (uri.length > 2048) return false;
  const url = parse(uri);
  if (!url || url.hash || uri.includes('#') || url.username || url.password) return false;
  if (url.protocol === 'https:') return !!url.hostname;
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

export function redirectUriMatches(requested: string, registered: readonly string[]): boolean {
  const req = parse(requested);
  if (!req || req.hash || requested.includes('#')) return false;
  if (req.protocol === 'http:' && LOOPBACK_HOSTS.has(req.hostname)) {
    return registered.some((candidate) => {
      const reg = parse(candidate);
      return !!reg && reg.protocol === 'http:' && reg.hostname === req.hostname
        && reg.pathname === req.pathname && reg.search === req.search && !reg.hash;
    });
  }
  return registered.includes(requested);
}

export function redirectHost(uri: string): string {
  return parse(uri)?.host ?? uri;
}
