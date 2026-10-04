export interface InviteIntent {
  readonly isInviteAttempt: boolean;
  readonly inviteCode?: string;
}

function normalizeWhitespace(input: string): string {
  return input.trim().replace(/\s+/g, ' ');
}

export function detectInviteIntent(text: string | undefined): InviteIntent {
  if (!text) {
    return { isInviteAttempt: false };
  }

  const cleaned = normalizeWhitespace(text);
  if (cleaned.length === 0) {
    return { isInviteAttempt: false };
  }

  const prefixed = /^(?:invite|code)\s+([a-z0-9\-\s]{4,64})$/i.exec(cleaned);
  if (prefixed && prefixed[1]) {
    return { isInviteAttempt: true, inviteCode: prefixed[1] };
  }

  const bare = /^([A-Z0-9][A-Z0-9-]{3,63})$/.exec(cleaned.toUpperCase());
  if (bare && bare[1]) {
    return { isInviteAttempt: true, inviteCode: bare[1] };
  }

  return { isInviteAttempt: false };
}
