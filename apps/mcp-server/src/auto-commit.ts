// A ShopRepository whose every call runs in its own short tenant transaction
// (ShopStore.withTenant), so each write commits as soon as it returns. Money
// tools use it: a PayPal hold and the ledger row that records it must survive
// whatever happens later in the same tool call, and waiting for the owner's
// approval must never keep a database transaction open. RLS still applies to
// every call, exactly as in withTenant.
import type { PaymentsRepository } from './ledger/types.js';
import type { ShopRepository, ShopStore } from './store.js';

type AnyMethod = (...args: unknown[]) => Promise<unknown>;

function method(target: object, name: string): AnyMethod {
  const fn = (target as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new TypeError(`repository has no method ${name}`);
  return (fn as AnyMethod).bind(target);
}

function perCall<T extends object>(run: (name: string, args: unknown[]) => Promise<unknown>, extra: Record<string, unknown> = {}): T {
  return new Proxy({}, {
    get(_target, name) {
      // Not a thenable, not a symbol-keyed protocol object: only named methods.
      if (typeof name !== 'string' || name === 'then') return undefined;
      if (name in extra) return extra[name];
      return (...args: unknown[]) => run(name, args);
    }
  }) as T;
}

export function autoCommitRepository(store: ShopStore, tenantId: string): ShopRepository {
  const payments = perCall<PaymentsRepository>((name, args) => store.withTenant(tenantId, (repo) => method(repo.payments, name)(...args)));
  return perCall<ShopRepository>((name, args) => store.withTenant(tenantId, (repo) => method(repo, name)(...args)), { payments });
}
