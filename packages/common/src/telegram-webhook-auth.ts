import { timingSafeEqual } from 'node:crypto';

export interface TelegramWebhookAuthResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly statusCode: number;
}

export function verifyTelegramWebhook(
  expectedToken: string,
  receivedToken: string | undefined
): TelegramWebhookAuthResult {
  if (!expectedToken) {
    return { ok: true, statusCode: 200 };
  }

  if (!receivedToken) {
    return { ok: false, reason: 'missing_secret_token', statusCode: 401 };
  }

  if (expectedToken.length !== receivedToken.length) {
    return { ok: false, reason: 'invalid_secret_token', statusCode: 403 };
  }

  const a = Buffer.from(expectedToken, 'utf8');
  const b = Buffer.from(receivedToken, 'utf8');

  if (!timingSafeEqual(a, b)) {
    return { ok: false, reason: 'invalid_secret_token', statusCode: 403 };
  }

  return { ok: true, statusCode: 200 };
}
