import { InMemoryTokenBucketRateLimiter } from './rate-limiter.js';

export interface NotifierRateLimitConfig {
  readonly enabled: boolean;
  readonly globalPerMinute: number;
  readonly perTenantPerMinute: number;
  readonly perUserBurst: number;
}

export interface NotifierRateLimitInput {
  readonly tenantId: string | null;
  readonly platformUserId: string;
}

export interface NotifierRateLimitResult {
  readonly allowed: boolean;
  readonly scope: 'global' | 'tenant' | 'user' | 'disabled';
}

export class NotifierOutboundRateLimiter {
  private readonly globalLimiter: InMemoryTokenBucketRateLimiter;
  private readonly tenantLimiter: InMemoryTokenBucketRateLimiter;
  private readonly userLimiter: InMemoryTokenBucketRateLimiter;

  constructor(private readonly cfg: NotifierRateLimitConfig) {
    this.globalLimiter = new InMemoryTokenBucketRateLimiter(cfg.globalPerMinute, cfg.globalPerMinute);
    this.tenantLimiter = new InMemoryTokenBucketRateLimiter(cfg.perTenantPerMinute, cfg.perTenantPerMinute);
    this.userLimiter = new InMemoryTokenBucketRateLimiter(cfg.perUserBurst, cfg.perUserBurst);
  }

  consume(input: NotifierRateLimitInput): NotifierRateLimitResult {
    if (!this.cfg.enabled) {
      return { allowed: true, scope: 'disabled' };
    }

    if (!this.globalLimiter.consume('notifier:global').allowed) {
      return { allowed: false, scope: 'global' };
    }

    if (input.tenantId && !this.tenantLimiter.consume(`notifier:tenant:${input.tenantId}`).allowed) {
      return { allowed: false, scope: 'tenant' };
    }

    if (!this.userLimiter.consume(`notifier:user:${input.platformUserId}`).allowed) {
      return { allowed: false, scope: 'user' };
    }

    return { allowed: true, scope: 'global' };
  }
}
