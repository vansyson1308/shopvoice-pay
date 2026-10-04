export interface RateLimiterDecision {
  readonly allowed: boolean;
  readonly remaining: number;
}

interface Bucket {
  tokens: number;
  lastRefillMs: number;
}

export class InMemoryTokenBucketRateLimiter {
  private readonly buckets = new Map<string, Bucket>();

  constructor(
    private readonly capacity: number,
    private readonly refillPerMinute: number
  ) {}

  consume(key: string, amount = 1): RateLimiterDecision {
    const now = Date.now();
    const refillRatePerMs = this.refillPerMinute / 60_000;
    const existing = this.buckets.get(key);

    if (!existing) {
      const remaining = this.capacity - amount;
      if (remaining < 0) {
        return { allowed: false, remaining: 0 };
      }

      this.buckets.set(key, {
        tokens: remaining,
        lastRefillMs: now
      });
      return { allowed: true, remaining };
    }

    const elapsed = Math.max(0, now - existing.lastRefillMs);
    existing.tokens = Math.min(this.capacity, existing.tokens + elapsed * refillRatePerMs);
    existing.lastRefillMs = now;

    if (existing.tokens < amount) {
      return { allowed: false, remaining: Math.floor(existing.tokens) };
    }

    existing.tokens -= amount;
    return { allowed: true, remaining: Math.floor(existing.tokens) };
  }
}
