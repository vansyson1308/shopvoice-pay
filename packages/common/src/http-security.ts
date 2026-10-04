export interface SecurityHeadersConfig {
  readonly enabled: boolean;
  readonly hstsEnabled: boolean;
  readonly hstsValue: string;
  readonly cspValue: string;
  readonly frameOptions: string;
  readonly referrerPolicy: string;
  readonly allowOrigin?: string;
}

export function loadSecurityHeadersConfig(env: Record<string, string | undefined>): SecurityHeadersConfig {
  const allowOrigin = (env.CORS_ALLOW_ORIGIN ?? '').trim();
  return {
    enabled: (env.SECURITY_HEADERS_ENABLED ?? 'true') === 'true',
    hstsEnabled: (env.SECURITY_HEADERS_HSTS_ENABLED ?? 'false') === 'true',
    hstsValue: env.SECURITY_HEADERS_HSTS_VALUE ?? 'max-age=31536000; includeSubDomains',
    cspValue: env.SECURITY_HEADERS_CSP ?? "default-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    frameOptions: env.SECURITY_HEADERS_FRAME_OPTIONS ?? 'DENY',
    referrerPolicy: env.SECURITY_HEADERS_REFERRER_POLICY ?? 'no-referrer',
    ...(allowOrigin ? { allowOrigin } : {})
  };
}

export function getSecurityHeaders(config: SecurityHeadersConfig): Record<string, string> {
  if (!config.enabled) return {};
  const headers: Record<string, string> = {
    'x-content-type-options': 'nosniff',
    'x-frame-options': config.frameOptions,
    'referrer-policy': config.referrerPolicy,
    'content-security-policy': config.cspValue
  };
  if (config.hstsEnabled) headers['strict-transport-security'] = config.hstsValue;
  if (config.allowOrigin) {
    headers['access-control-allow-origin'] = config.allowOrigin;
    headers.vary = 'Origin';
  }
  return headers;
}
