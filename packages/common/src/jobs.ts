import type { NotificationType, NotificationTemplateVars } from './notifier-templates.js';

export type WorkerJobType =
  | 'PROCESS_INBOUND_EVENT'
  | 'PROCESS_IMAGE_INVOICE'
  | 'PROCESS_EXCEL_INVOICE'
  | 'CHATBOT_REPLY'
  | 'NOTIFY_USER'
  | 'FLUSH_PENDING_NOTIFICATIONS'
  | 'MAP_RESOLVE'
  | 'KIOTVIET_SYNC'
  | 'KIOTVIET_PRODUCT_SYNC'
  | 'CONFIRM_MAPPING';

export interface WorkerJobEnvelope {
  readonly job_type: WorkerJobType;
  readonly tenant_id: string | null;
  readonly inbound_event_id: string | null;
  readonly platform_user_id: string;
  readonly message_id: string;
  readonly correlation_id: string;
  readonly user_id?: string;
  readonly telegram_chat_id?: number;
  readonly file_id?: string;
  readonly canonical_invoice_id?: string;
  readonly notification_type?: NotificationType;
  readonly template_vars?: NotificationTemplateVars;
  readonly enqueued_at_ms?: number;
  readonly message_text?: string;
  readonly reply_to_message_id?: number;
}

function asNonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value : null;
}

function isRecord(value: unknown): value is Record<string, string | number | boolean> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return false;
  }
  return Object.values(value).every((v) => ['string', 'number', 'boolean'].includes(typeof v));
}

export function validateWorkerJobEnvelope(input: unknown): { ok: true; value: WorkerJobEnvelope } | { ok: false } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false };
  }

  const payload = input as Record<string, unknown>;
  const jobType = asNonEmptyString(payload.job_type);
  const platformUserId = asNonEmptyString(payload.platform_user_id);
  const messageId = asNonEmptyString(payload.message_id);
  const correlationId = asNonEmptyString(payload.correlation_id);

  if (!jobType || !platformUserId || !messageId || !correlationId) {
    return { ok: false };
  }

  const allowed: WorkerJobType[] = ['PROCESS_INBOUND_EVENT', 'PROCESS_IMAGE_INVOICE', 'PROCESS_EXCEL_INVOICE', 'CHATBOT_REPLY', 'NOTIFY_USER', 'FLUSH_PENDING_NOTIFICATIONS', 'MAP_RESOLVE', 'KIOTVIET_SYNC', 'KIOTVIET_PRODUCT_SYNC', 'CONFIRM_MAPPING'];
  if (!allowed.includes(jobType as WorkerJobType)) {
    return { ok: false };
  }

  const tenantIdRaw = payload.tenant_id;
  const inboundEventIdRaw = payload.inbound_event_id;
  const canonicalInvoiceRaw = payload.canonical_invoice_id;
  const tenantId = tenantIdRaw === null ? null : asNonEmptyString(tenantIdRaw);
  const inboundEventId = inboundEventIdRaw === null ? null : asNonEmptyString(inboundEventIdRaw);
  const canonicalInvoiceId = canonicalInvoiceRaw === undefined ? null : asNonEmptyString(canonicalInvoiceRaw);

  if (tenantIdRaw !== null && tenantId === null) return { ok: false };
  if (inboundEventIdRaw !== null && inboundEventId === null) return { ok: false };

  if (jobType === 'PROCESS_INBOUND_EVENT' && (!tenantId || !inboundEventId)) {
    return { ok: false };
  }
  if (jobType === 'PROCESS_IMAGE_INVOICE' && (!tenantId || !inboundEventId)) {
    return { ok: false };
  }
  if (jobType === 'PROCESS_EXCEL_INVOICE' && (!tenantId || !inboundEventId)) {
    return { ok: false };
  }
  if (jobType === 'CHATBOT_REPLY' && !tenantId) {
    return { ok: false };
  }
  if (jobType === 'FLUSH_PENDING_NOTIFICATIONS' && !tenantId) {
    return { ok: false };
  }
  if ((jobType === 'MAP_RESOLVE' || jobType === 'KIOTVIET_SYNC') && (!tenantId || !canonicalInvoiceId)) {
    return { ok: false };
  }
  if (jobType === 'CONFIRM_MAPPING' && !tenantId) {
    return { ok: false };
  }

  const notificationType = payload.notification_type === undefined ? null : asNonEmptyString(payload.notification_type);
  const templateVars = payload.template_vars;
  const enqueuedAtMs = payload.enqueued_at_ms;
  if (enqueuedAtMs !== undefined && (!Number.isFinite(enqueuedAtMs) || typeof enqueuedAtMs !== 'number' || enqueuedAtMs <= 0)) {
    return { ok: false };
  }

  if (jobType === 'NOTIFY_USER') {
    const validTypes: NotificationType[] = ['WELCOME_LINKED', 'INVOICE_PROCESSED', 'NEED_MAPPING_INPUT', 'PROCESSING_FAILED', 'RATE_LIMITED', 'GENERIC_INFO'];
    if (!notificationType || !validTypes.includes(notificationType as NotificationType)) {
      return { ok: false };
    }
    if (templateVars !== undefined && !isRecord(templateVars)) {
      return { ok: false };
    }
  }

  const telegramChatId = payload.telegram_chat_id;
  if (telegramChatId !== undefined && (typeof telegramChatId !== 'number' || !Number.isInteger(telegramChatId))) {
    return { ok: false };
  }

  const fileId = payload.file_id;
  if (fileId !== undefined && typeof fileId !== 'string') {
    return { ok: false };
  }

  return {
    ok: true,
    value: {
      job_type: jobType as WorkerJobType,
      tenant_id: tenantId,
      inbound_event_id: inboundEventId,
      platform_user_id: platformUserId,
      message_id: messageId,
      correlation_id: correlationId,
      ...(typeof payload.user_id === 'string' && payload.user_id.length > 0 ? { user_id: payload.user_id as string } : {}),
      ...(typeof telegramChatId === 'number' ? { telegram_chat_id: telegramChatId } : {}),
      ...(typeof fileId === 'string' && fileId.length > 0 ? { file_id: fileId } : {}),
      ...(canonicalInvoiceId ? { canonical_invoice_id: canonicalInvoiceId } : {}),
      ...(notificationType ? { notification_type: notificationType as NotificationType } : {}),
      ...(templateVars && isRecord(templateVars) ? { template_vars: templateVars } : {}),
      ...(typeof enqueuedAtMs === 'number' ? { enqueued_at_ms: enqueuedAtMs } : {}),
      ...(typeof payload.message_text === 'string' ? { message_text: payload.message_text } : {}),
      ...(typeof payload.reply_to_message_id === 'number' && Number.isInteger(payload.reply_to_message_id) && payload.reply_to_message_id > 0 ? { reply_to_message_id: payload.reply_to_message_id } : {})
    }
  };
}
