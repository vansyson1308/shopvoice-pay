// Postgres OAuthStore: thin wrappers over the SECURITY DEFINER functions of
// migration 018. The runtime role holds no grants on the OAuth tables.
import type { PgPoolLike } from '../../../../packages/common/dist/index.js';
import { query } from '../../../../packages/common/dist/index.js';
import type {
  AccessGrant, AccountCredentials, AuthCodeRecord, ConsumeCodeResult, GrantSummary, Locale, NewTokens,
  OAuthClient, OAuthStore, RotateResult, WebAccount
} from './store.js';
import { AccountExistsError } from './store.js';

const str = (v: unknown): string => (v === null || v === undefined ? '' : String(v));
const arr = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);
const ms = (v: unknown): number => (v instanceof Date ? v.getTime() : new Date(str(v)).getTime());
const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : str(v));

export interface PgOAuthStoreOptions {
  /** Sandbox catalogue (scripts/gen_demo_seed.mjs buildSandboxCatalogue), both locales' profiles included. */
  readonly catalogue: unknown;
  /** Base64 invite pepper (INVITE_PEPPER_B64); linking is disabled when empty. */
  readonly invitePepperB64: string;
}

export class PgOAuthStore implements OAuthStore {
  private cachedCatalogue: string | null = null;

  constructor(private readonly pool: PgPoolLike, private readonly opts: PgOAuthStoreOptions) {}

  private catalogueJson(): string {
    this.cachedCatalogue ??= JSON.stringify(this.opts.catalogue);
    return this.cachedCatalogue;
  }

  async registerClient(c: OAuthClient): Promise<void> {
    await query(this.pool, 'SELECT oauth_register_client($1, $2, $3::text[], $4, $5, $6)', [
      c.clientId, c.clientName, c.redirectUris, c.tokenEndpointAuthMethod, c.clientSecretHash, c.registrationType
    ]);
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const { rows } = await query(this.pool, 'SELECT * FROM oauth_get_client($1)', [clientId]);
    const r = rows[0];
    if (!r) return null;
    return {
      clientId: str(r.client_id),
      clientName: str(r.client_name),
      redirectUris: arr(r.redirect_uris),
      tokenEndpointAuthMethod: str(r.token_endpoint_auth_method) === 'client_secret_post' ? 'client_secret_post' : 'none',
      clientSecretHash: r.client_secret_hash ? str(r.client_secret_hash) : null,
      registrationType: str(r.registration_type) === 'cimd' ? 'cimd' : 'dcr'
    };
  }

  async cleanup(idleDays: number): Promise<number> {
    const { rows } = await query(this.pool, 'SELECT oauth_cleanup($1) AS n', [idleDays]);
    return Number(rows[0]?.n ?? 0);
  }

  async createAccount(input: { email: string; passwordHash: string; locale: Locale }): Promise<WebAccount> {
    let accountId: string;
    try {
      const { rows } = await query(this.pool, 'SELECT account_id FROM web_account_create($1, $2, $3, $4::jsonb)', [
        input.email.toLowerCase(), input.passwordHash, input.locale, this.catalogueJson()
      ]);
      accountId = str(rows[0]?.account_id);
    } catch (error) {
      if (error instanceof Error && /duplicate key|idx_web_accounts_email|23505/.test(error.message)) throw new AccountExistsError();
      throw error;
    }
    const account = await this.getAccount(accountId);
    if (!account) throw new Error('account_create_failed');
    return account;
  }

  async findCredentials(email: string): Promise<AccountCredentials | null> {
    const { rows } = await query(this.pool, 'SELECT * FROM web_account_find_by_email($1)', [email.toLowerCase()]);
    const r = rows[0];
    if (!r) return null;
    return {
      accountId: str(r.account_id),
      passwordHash: str(r.password_hash),
      status: str(r.status) === 'active' ? 'active' : 'disabled',
      lockedUntilMs: r.locked_until ? ms(r.locked_until) : null
    };
  }

  async recordLogin(accountId: string, success: boolean): Promise<void> {
    await query(this.pool, 'SELECT web_account_record_login($1, $2)', [accountId, success]);
  }

  async getAccount(accountId: string): Promise<WebAccount | null> {
    const { rows } = await query(this.pool, 'SELECT * FROM web_account_get($1)', [accountId]);
    const r = rows[0];
    if (!r) return null;
    return {
      accountId: str(r.account_id),
      email: str(r.email),
      tenantId: str(r.tenant_id),
      shopName: str(r.shop_name),
      isSandbox: r.is_sandbox === true,
      locale: str(r.locale) === 'vi' ? 'vi' : 'en',
      status: str(r.status) === 'active' ? 'active' : 'disabled'
    };
  }

  async linkInvite(accountId: string, code: string): Promise<{ ok: boolean; tenantId: string | null }> {
    if (!this.opts.invitePepperB64) return { ok: false, tenantId: null };
    const client = await this.pool.connect();
    try {
      await query(client, 'BEGIN');
      await query(client, "SELECT set_config('app.invite_pepper_b64', $1, true)", [this.opts.invitePepperB64]);
      const { rows } = await query(client, 'SELECT ok, tenant_id FROM web_account_link_invite($1, $2)', [accountId, code]);
      await query(client, 'COMMIT');
      const r = rows[0];
      return { ok: r?.ok === true, tenantId: r?.tenant_id ? str(r.tenant_id) : null };
    } catch (error) {
      await query(client, 'ROLLBACK').catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async refreshSandbox(tenantId: string): Promise<boolean> {
    const { rows } = await query(this.pool, 'SELECT sandbox_refresh($1, $2::jsonb) AS reseeded', [tenantId, this.catalogueJson()]);
    return rows[0]?.reseeded === true;
  }

  async createCode(codeHash: string, code: Omit<AuthCodeRecord, 'familyId'>, ttlSeconds: number): Promise<void> {
    await query(this.pool, 'SELECT oauth_create_code($1, $2, $3, $4, $5, $6::text[], $7, $8)', [
      codeHash, code.clientId, code.accountId, code.redirectUri, code.codeChallenge, [...code.scopes], code.resource, ttlSeconds
    ]);
  }

  async consumeCode(codeHash: string): Promise<ConsumeCodeResult> {
    const { rows } = await query(this.pool, 'SELECT * FROM oauth_consume_code($1)', [codeHash]);
    const r = rows[0];
    const outcome = str(r?.outcome);
    if (outcome !== 'ok' || !r) return { outcome: outcome === 'reused' ? 'reused' : outcome === 'expired' ? 'expired' : 'invalid' };
    return {
      outcome: 'ok',
      code: {
        clientId: str(r.client_id),
        accountId: str(r.account_id),
        redirectUri: str(r.redirect_uri),
        codeChallenge: str(r.code_challenge),
        scopes: arr(r.scopes),
        resource: str(r.resource),
        familyId: str(r.family_id)
      }
    };
  }

  async issueTokens(familyId: string, grant: { clientId: string; accountId: string; scopes: readonly string[]; resource: string }, t: NewTokens): Promise<void> {
    await query(this.pool, 'SELECT oauth_issue_tokens($1, $2, $3, $4::text[], $5, $6, $7, $8, $9)', [
      familyId, grant.clientId, grant.accountId, [...grant.scopes], grant.resource, t.accessHash, t.accessTtlSeconds, t.refreshHash, t.refreshTtlSeconds
    ]);
  }

  async resolveAccessToken(accessHash: string): Promise<AccessGrant | null> {
    const { rows } = await query(this.pool, 'SELECT * FROM oauth_resolve_access_token($1)', [accessHash]);
    const r = rows[0];
    if (!r) return null;
    return {
      tenantId: str(r.tenant_id),
      accountId: str(r.account_id),
      clientId: str(r.client_id),
      scopes: arr(r.scopes),
      resource: str(r.resource),
      expiresAtMs: ms(r.expires_at),
      isSandbox: r.is_sandbox === true
    };
  }

  async rotateRefreshToken(refreshHash: string, clientId: string, next: NewTokens): Promise<RotateResult> {
    const { rows } = await query(this.pool, 'SELECT * FROM oauth_rotate_refresh($1, $2, $3, $4, $5, $6)', [
      refreshHash, clientId, next.accessHash, next.accessTtlSeconds, next.refreshHash, next.refreshTtlSeconds
    ]);
    const r = rows[0];
    const outcome = str(r?.outcome);
    if (outcome === 'ok' && r) return { outcome: 'ok', accountId: str(r.account_id), scopes: arr(r.scopes), resource: str(r.resource) };
    return { outcome: outcome === 'reuse' ? 'reuse' : 'invalid' };
  }

  async revokeToken(tokenHash: string, clientId: string): Promise<boolean> {
    const { rows } = await query(this.pool, 'SELECT oauth_revoke_token($1, $2) AS ok', [tokenHash, clientId]);
    return rows[0]?.ok === true;
  }

  async listGrants(accountId: string): Promise<GrantSummary[]> {
    const { rows } = await query(this.pool, 'SELECT * FROM oauth_list_grants($1)', [accountId]);
    return rows.map((r) => ({
      clientId: str(r.client_id),
      clientName: str(r.client_name),
      registrationType: str(r.registration_type) === 'cimd' ? 'cimd' : 'dcr',
      redirectUris: arr(r.redirect_uris),
      scopes: arr(r.scopes),
      firstGrantedAt: iso(r.first_granted_at),
      lastUsedAt: iso(r.last_used_at)
    }));
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    const { rows } = await query(this.pool, 'SELECT web_account_delete($1) AS ok', [accountId]);
    return rows[0]?.ok === true;
  }

  async purgeAuditLog(days: number): Promise<number> {
    const { rows } = await query(this.pool, 'SELECT purge_voice_audit_log($1) AS n', [days]);
    return Number(rows[0]?.n ?? 0);
  }

  async revokeGrant(accountId: string, clientId: string): Promise<number> {
    const { rows } = await query(this.pool, 'SELECT oauth_revoke_grant($1, $2) AS n', [accountId, clientId]);
    return Number(rows[0]?.n ?? 0);
  }
}
