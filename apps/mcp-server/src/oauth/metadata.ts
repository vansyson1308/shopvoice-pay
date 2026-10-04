// Discovery documents (RFC 9728 protected resource metadata, RFC 8414
// authorization server metadata) and the WWW-Authenticate challenge.

export const SCOPES = ['shop.read', 'shop.write', 'offline_access'] as const;
export type Scope = (typeof SCOPES)[number];
export const CHALLENGE_SCOPE = 'shop.read shop.write';
export const WRITE_SCOPE: Scope = 'shop.write';

export interface OAuthUrls {
  readonly issuer: string;
  readonly resource: string;
  readonly prmUrl: string;
  readonly prmRootUrl: string;
  readonly asMetadataUrl: string;
  readonly authorize: string;
  readonly token: string;
  readonly register: string;
  readonly revoke: string;
  readonly account: string;
}

export function oauthUrls(publicBaseUrl: string, mcpPath = '/mcp'): OAuthUrls {
  const issuer = publicBaseUrl.replace(/\/+$/, '');
  return {
    issuer,
    resource: `${issuer}${mcpPath}`,
    prmUrl: `${issuer}/.well-known/oauth-protected-resource${mcpPath}`,
    prmRootUrl: `${issuer}/.well-known/oauth-protected-resource`,
    asMetadataUrl: `${issuer}/.well-known/oauth-authorization-server`,
    authorize: `${issuer}/oauth/authorize`,
    token: `${issuer}/oauth/token`,
    register: `${issuer}/oauth/register`,
    revoke: `${issuer}/oauth/revoke`,
    account: `${issuer}/account`
  };
}

export function protectedResourceMetadata(urls: OAuthUrls): Record<string, unknown> {
  return {
    resource: urls.resource,
    authorization_servers: [urls.issuer],
    scopes_supported: [...SCOPES],
    bearer_methods_supported: ['header'],
    resource_name: 'ShopVoice',
    resource_documentation: `${urls.issuer}/docs`,
    resource_policy_uri: `${urls.issuer}/privacy`,
    resource_tos_uri: `${urls.issuer}/terms`
  };
}

export function authorizationServerMetadata(urls: OAuthUrls): Record<string, unknown> {
  return {
    issuer: urls.issuer,
    authorization_endpoint: urls.authorize,
    token_endpoint: urls.token,
    registration_endpoint: urls.register,
    revocation_endpoint: urls.revoke,
    scopes_supported: [...SCOPES],
    response_types_supported: ['code'],
    response_modes_supported: ['query'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    revocation_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    code_challenge_methods_supported: ['S256'],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${urls.issuer}/docs`,
    op_policy_uri: `${urls.issuer}/privacy`,
    op_tos_uri: `${urls.issuer}/terms`,
    ui_locales_supported: ['en', 'vi']
  };
}

function quote(value: string): string {
  return `"${value.replace(/["\\]/g, '')}"`;
}

export function wwwAuthenticate(
  urls: OAuthUrls,
  opts: { error?: 'invalid_token' | 'insufficient_scope'; description?: string; scope?: string }
): string {
  const params = ['realm="shopvoice"'];
  if (opts.error) params.push(`error=${quote(opts.error)}`);
  if (opts.description) params.push(`error_description=${quote(opts.description)}`);
  params.push(`resource_metadata=${quote(urls.prmUrl)}`);
  params.push(`scope=${quote(opts.scope ?? CHALLENGE_SCOPE)}`);
  return `Bearer ${params.join(', ')}`;
}

/**
 * Space-separated scope parameter -> known scopes (deduplicated, shop.read
 * always included). Empty means the default (read + write). Unknown -> null.
 */
export function parseScopeParam(scope: string | undefined): Scope[] | null {
  const requested = (scope ?? '').split(/\s+/).filter(Boolean);
  if (requested.length === 0) return ['shop.read', 'shop.write'];
  const out: Scope[] = ['shop.read'];
  for (const s of requested) {
    if (!(SCOPES as readonly string[]).includes(s)) return null;
    if (!out.includes(s as Scope)) out.push(s as Scope);
  }
  return out;
}
