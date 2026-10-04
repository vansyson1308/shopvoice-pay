// Persistence contract for the OAuth authorization server. The Postgres
// implementation calls the SECURITY DEFINER functions from migration 018; the
// memory implementation mirrors their semantics for tests and offline demos.
// All token/code/secret arguments are SHA-256 hex digests, never plaintext.
import { randomUUID } from 'node:crypto';

export type AuthMethod = 'none' | 'client_secret_post';
export type Locale = 'en' | 'vi';

export interface OAuthClient {
  readonly clientId: string;
  readonly clientName: string;
  readonly redirectUris: readonly string[];
  readonly tokenEndpointAuthMethod: AuthMethod;
  readonly clientSecretHash: string | null;
  readonly registrationType: 'dcr' | 'cimd';
}

export interface WebAccount {
  readonly accountId: string;
  readonly email: string;
  readonly tenantId: string;
  readonly shopName: string;
  readonly isSandbox: boolean;
  readonly locale: Locale;
  readonly status: 'active' | 'disabled';
}

export interface AccountCredentials {
  readonly accountId: string;
  readonly passwordHash: string;
  readonly status: 'active' | 'disabled';
  readonly lockedUntilMs: number | null;
}

export interface AuthCodeRecord {
  readonly clientId: string;
  readonly accountId: string;
  readonly redirectUri: string;
  readonly codeChallenge: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly familyId: string;
}

export type ConsumeCodeResult =
  | { readonly outcome: 'ok'; readonly code: AuthCodeRecord }
  | { readonly outcome: 'invalid' | 'expired' | 'reused' };

export interface AccessGrant {
  readonly tenantId: string;
  readonly accountId: string;
  readonly clientId: string;
  readonly scopes: readonly string[];
  readonly resource: string;
  readonly expiresAtMs: number;
  readonly isSandbox: boolean;
}

export interface NewTokens {
  readonly accessHash: string;
  readonly accessTtlSeconds: number;
  readonly refreshHash: string | null;
  readonly refreshTtlSeconds: number;
}

export type RotateResult =
  | { readonly outcome: 'ok'; readonly accountId: string; readonly scopes: readonly string[]; readonly resource: string }
  | { readonly outcome: 'invalid' | 'reuse' };

export interface GrantSummary {
  readonly clientId: string;
  readonly clientName: string;
  readonly registrationType: 'dcr' | 'cimd';
  readonly redirectUris: readonly string[];
  readonly scopes: readonly string[];
  readonly firstGrantedAt: string;
  readonly lastUsedAt: string;
}

export class AccountExistsError extends Error {
  constructor() {
    super('account_exists');
  }
}

export interface OAuthStore {
  registerClient(client: OAuthClient): Promise<void>;
  getClient(clientId: string): Promise<OAuthClient | null>;
  /** Deletes DCR clients idle for `idleDays` with no live token; purges dead codes/tokens. */
  cleanup(idleDays: number): Promise<number>;

  /** Creates the account and provisions its sandbox shop (sample data). */
  createAccount(input: { email: string; passwordHash: string; locale: Locale }): Promise<WebAccount>;
  findCredentials(email: string): Promise<AccountCredentials | null>;
  recordLogin(accountId: string, success: boolean): Promise<void>;
  getAccount(accountId: string): Promise<WebAccount | null>;
  /** Links the account to a real GroceryClaw shop through an invite code; revokes its tokens. */
  linkInvite(accountId: string, code: string): Promise<{ ok: boolean; tenantId: string | null }>;
  /** Re-seeds a sandbox shop at most once per day (shop timezone). */
  refreshSandbox(tenantId: string): Promise<boolean>;

  createCode(codeHash: string, code: Omit<AuthCodeRecord, 'familyId'>, ttlSeconds: number): Promise<void>;
  consumeCode(codeHash: string): Promise<ConsumeCodeResult>;
  issueTokens(familyId: string, grant: { clientId: string; accountId: string; scopes: readonly string[]; resource: string }, tokens: NewTokens): Promise<void>;
  resolveAccessToken(accessHash: string): Promise<AccessGrant | null>;
  rotateRefreshToken(refreshHash: string, clientId: string, next: NewTokens): Promise<RotateResult>;
  revokeToken(tokenHash: string, clientId: string): Promise<boolean>;
  listGrants(accountId: string): Promise<GrantSummary[]>;
  revokeGrant(accountId: string, clientId: string): Promise<number>;
  /** Deletes the account, its tokens and its sandbox shop data (self-service, /account). */
  deleteAccount(accountId: string): Promise<boolean>;
  /** Tool-call audit retention; returns rows removed. */
  purgeAuditLog(days: number): Promise<number>;
}

// ---------------------------------------------------------------------------
// In-memory implementation
// ---------------------------------------------------------------------------

interface MemAccount {
  accountId: string;
  email: string;
  passwordHash: string;
  tenantId: string;
  isSandbox: boolean;
  locale: Locale;
  status: 'active' | 'disabled';
  failed: number;
  lockedUntilMs: number | null;
}

interface MemCode extends AuthCodeRecord {
  expiresMs: number;
  usedMs: number | null;
}

interface MemToken {
  hash: string;
  kind: 'access' | 'refresh';
  familyId: string;
  clientId: string;
  accountId: string;
  scopes: readonly string[];
  resource: string;
  status: 'active' | 'rotated' | 'revoked';
  expiresMs: number;
  createdMs: number;
  lastUsedMs: number | null;
}

export interface MemorySandboxHooks {
  /** Creates the sandbox tenant's shop data; returns its display name. */
  provision(tenantId: string, locale: Locale): Promise<string> | string;
  /** Links an invite code to a tenant id (test double for consume_invite_code). */
  redeemInvite?(code: string): { tenantId: string; shopName: string } | null;
  /** Drops a deleted account's sandbox data. */
  remove?(tenantId: string): void;
}

export class MemoryOAuthStore implements OAuthStore {
  private readonly clients = new Map<string, OAuthClient & { createdMs: number; lastUsedMs: number | null }>();
  private readonly accounts = new Map<string, MemAccount>();
  private readonly shopNames = new Map<string, string>();
  private readonly codes = new Map<string, MemCode>();
  private readonly tokens = new Map<string, MemToken>();

  constructor(private readonly hooks: MemorySandboxHooks, private readonly now: () => number = Date.now) {}

  async registerClient(client: OAuthClient): Promise<void> {
    const existing = this.clients.get(client.clientId);
    if (existing && (existing.registrationType !== 'cimd' || client.registrationType !== 'cimd')) throw new Error('client_exists');
    this.clients.set(client.clientId, { ...client, createdMs: existing?.createdMs ?? this.now(), lastUsedMs: existing?.lastUsedMs ?? null });
  }

  async getClient(clientId: string): Promise<OAuthClient | null> {
    const c = this.clients.get(clientId);
    if (!c) return null;
    const { createdMs: _c, lastUsedMs: _l, ...client } = c;
    return client;
  }

  async cleanup(idleDays: number): Promise<number> {
    const cutoff = this.now() - idleDays * 86_400_000;
    for (const [hash, code] of this.codes) if (code.expiresMs < this.now() - 86_400_000) this.codes.delete(hash);
    for (const [hash, token] of this.tokens) if (token.expiresMs < this.now() - 7 * 86_400_000) this.tokens.delete(hash);
    let removed = 0;
    for (const [id, c] of this.clients) {
      if (c.registrationType !== 'dcr' || (c.lastUsedMs ?? c.createdMs) >= cutoff) continue;
      const live = [...this.tokens.values()].some((t) => t.clientId === id && t.status === 'active' && t.expiresMs > this.now());
      if (live) continue;
      this.clients.delete(id);
      removed += 1;
    }
    return removed;
  }

  async createAccount(input: { email: string; passwordHash: string; locale: Locale }): Promise<WebAccount> {
    const email = input.email.toLowerCase();
    if ([...this.accounts.values()].some((a) => a.email === email)) throw new AccountExistsError();
    const accountId = randomUUID();
    const tenantId = randomUUID();
    const shopName = await this.hooks.provision(tenantId, input.locale);
    this.shopNames.set(tenantId, shopName);
    const account: MemAccount = { accountId, email, passwordHash: input.passwordHash, tenantId, isSandbox: true, locale: input.locale, status: 'active', failed: 0, lockedUntilMs: null };
    this.accounts.set(accountId, account);
    return this.view(account);
  }

  private view(a: MemAccount): WebAccount {
    return { accountId: a.accountId, email: a.email, tenantId: a.tenantId, shopName: this.shopNames.get(a.tenantId) ?? '', isSandbox: a.isSandbox, locale: a.locale, status: a.status };
  }

  async findCredentials(email: string): Promise<AccountCredentials | null> {
    const a = [...this.accounts.values()].find((x) => x.email === email.toLowerCase());
    return a ? { accountId: a.accountId, passwordHash: a.passwordHash, status: a.status, lockedUntilMs: a.lockedUntilMs } : null;
  }

  async recordLogin(accountId: string, success: boolean): Promise<void> {
    const a = this.accounts.get(accountId);
    if (!a) return;
    if (success) {
      a.failed = 0;
      a.lockedUntilMs = null;
    } else {
      a.failed += 1;
      if (a.failed >= 5) a.lockedUntilMs = this.now() + 15 * 60_000;
    }
  }

  async getAccount(accountId: string): Promise<WebAccount | null> {
    const a = this.accounts.get(accountId);
    return a ? this.view(a) : null;
  }

  async linkInvite(accountId: string, code: string): Promise<{ ok: boolean; tenantId: string | null }> {
    const a = this.accounts.get(accountId);
    const hit = a && a.status === 'active' ? this.hooks.redeemInvite?.(code) ?? null : null;
    if (!a || !hit) return { ok: false, tenantId: null };
    a.tenantId = hit.tenantId;
    a.isSandbox = false;
    this.shopNames.set(hit.tenantId, hit.shopName);
    for (const t of this.tokens.values()) if (t.accountId === accountId && t.status === 'active') t.status = 'revoked';
    return { ok: true, tenantId: hit.tenantId };
  }

  async refreshSandbox(): Promise<boolean> {
    return false;
  }

  async createCode(codeHash: string, code: Omit<AuthCodeRecord, 'familyId'>, ttlSeconds: number): Promise<void> {
    this.codes.set(codeHash, { ...code, familyId: randomUUID(), expiresMs: this.now() + ttlSeconds * 1000, usedMs: null });
    const c = this.clients.get(code.clientId);
    if (c) c.lastUsedMs = this.now();
  }

  async consumeCode(codeHash: string): Promise<ConsumeCodeResult> {
    const code = this.codes.get(codeHash);
    if (!code) return { outcome: 'invalid' };
    if (code.usedMs !== null) {
      for (const t of this.tokens.values()) if (t.familyId === code.familyId) t.status = 'revoked';
      return { outcome: 'reused' };
    }
    code.usedMs = this.now();
    if (code.expiresMs <= this.now()) return { outcome: 'expired' };
    const { expiresMs: _e, usedMs: _u, ...record } = code;
    return { outcome: 'ok', code: record };
  }

  async issueTokens(familyId: string, grant: { clientId: string; accountId: string; scopes: readonly string[]; resource: string }, tokens: NewTokens): Promise<void> {
    const base = { familyId, clientId: grant.clientId, accountId: grant.accountId, scopes: [...grant.scopes], resource: grant.resource, status: 'active' as const, createdMs: this.now(), lastUsedMs: null };
    this.tokens.set(tokens.accessHash, { ...base, hash: tokens.accessHash, kind: 'access', expiresMs: this.now() + tokens.accessTtlSeconds * 1000 });
    if (tokens.refreshHash) {
      this.tokens.set(tokens.refreshHash, { ...base, hash: tokens.refreshHash, kind: 'refresh', expiresMs: this.now() + tokens.refreshTtlSeconds * 1000 });
    }
  }

  async resolveAccessToken(accessHash: string): Promise<AccessGrant | null> {
    const t = this.tokens.get(accessHash);
    if (!t || t.kind !== 'access' || t.status !== 'active' || t.expiresMs <= this.now()) return null;
    const a = this.accounts.get(t.accountId);
    if (!a || a.status !== 'active') return null;
    t.lastUsedMs = this.now();
    return { tenantId: a.tenantId, accountId: a.accountId, clientId: t.clientId, scopes: t.scopes, resource: t.resource, expiresAtMs: t.expiresMs, isSandbox: a.isSandbox };
  }

  async rotateRefreshToken(refreshHash: string, clientId: string, next: NewTokens): Promise<RotateResult> {
    const t = this.tokens.get(refreshHash);
    if (!t || t.kind !== 'refresh' || t.clientId !== clientId) return { outcome: 'invalid' };
    if (t.status !== 'active') {
      for (const x of this.tokens.values()) if (x.familyId === t.familyId) x.status = 'revoked';
      return { outcome: 'reuse' };
    }
    const account = this.accounts.get(t.accountId);
    if (t.expiresMs <= this.now() || !account || account.status !== 'active') return { outcome: 'invalid' };
    t.status = 'rotated';
    await this.issueTokens(t.familyId, t, next);
    const c = this.clients.get(clientId);
    if (c) c.lastUsedMs = this.now();
    return { outcome: 'ok', accountId: t.accountId, scopes: t.scopes, resource: t.resource };
  }

  async revokeToken(tokenHash: string, clientId: string): Promise<boolean> {
    const t = this.tokens.get(tokenHash);
    if (!t || t.clientId !== clientId) return false;
    for (const x of this.tokens.values()) if (x.familyId === t.familyId) x.status = 'revoked';
    return true;
  }

  async listGrants(accountId: string): Promise<GrantSummary[]> {
    const byClient = new Map<string, MemToken[]>();
    for (const t of this.tokens.values()) {
      if (t.accountId !== accountId || t.status !== 'active' || t.expiresMs <= this.now()) continue;
      byClient.set(t.clientId, [...(byClient.get(t.clientId) ?? []), t]);
    }
    const out: GrantSummary[] = [];
    for (const [clientId, list] of byClient) {
      const c = this.clients.get(clientId);
      if (!c) continue;
      const iso = (ms: number) => new Date(ms).toISOString();
      out.push({
        clientId,
        clientName: c.clientName,
        registrationType: c.registrationType,
        redirectUris: c.redirectUris,
        scopes: [...new Set(list.flatMap((t) => t.scopes))].sort(),
        firstGrantedAt: iso(Math.min(...list.map((t) => t.createdMs))),
        lastUsedAt: iso(Math.max(...list.map((t) => t.lastUsedMs ?? t.createdMs)))
      });
    }
    return out.sort((a, b) => b.lastUsedAt.localeCompare(a.lastUsedAt));
  }

  async deleteAccount(accountId: string): Promise<boolean> {
    const a = this.accounts.get(accountId);
    if (!a) return false;
    this.accounts.delete(accountId);
    for (const [hash, t] of this.tokens) if (t.accountId === accountId) this.tokens.delete(hash);
    for (const [hash, c] of this.codes) if (c.accountId === accountId) this.codes.delete(hash);
    this.hooks.remove?.(a.tenantId);
    return true;
  }

  async purgeAuditLog(): Promise<number> {
    return 0;
  }

  async revokeGrant(accountId: string, clientId: string): Promise<number> {
    let n = 0;
    for (const t of this.tokens.values()) {
      if (t.accountId === accountId && t.clientId === clientId && t.status !== 'revoked') {
        t.status = 'revoked';
        n += 1;
      }
    }
    return n;
  }
}
