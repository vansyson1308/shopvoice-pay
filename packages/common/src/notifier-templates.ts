export type NotificationType =
  | 'WELCOME_LINKED'
  | 'INVOICE_PROCESSED'
  | 'NEED_MAPPING_INPUT'
  | 'PROCESSING_FAILED'
  | 'RATE_LIMITED'
  | 'GENERIC_INFO';

export type NotificationTemplateVars = Record<string, string | number | boolean>;

export interface NotifyUserPayload {
  readonly tenant_id: string | null;
  readonly platform_user_id: string;
  readonly user_id?: string;
  readonly telegram_chat_id?: number;
  readonly notification_type: NotificationType;
  readonly template_vars: NotificationTemplateVars;
  readonly correlation_id: string;
}

function escapeUnsafe(input: string): string {
  return input.replace(/[\r\n\t]/g, ' ').replace(/[<>]/g, '');
}

function ensureNoSensitivePatterns(text: string): void {
  if (/token|secret|api[_-]?key|bearer\s+/i.test(text)) {
    throw new Error('message_contains_sensitive_pattern');
  }
  if (/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/i.test(text)) {
    throw new Error('message_contains_internal_id');
  }
}

function requireVars(vars: NotificationTemplateVars, keys: string[]): void {
  for (const key of keys) {
    if (!(key in vars)) {
      throw new Error(`missing_template_var:${key}`);
    }
  }
}

export function renderNotificationTemplate(payload: NotifyUserPayload, maxLen = 500): string {
  let text = '';
  switch (payload.notification_type) {
    case 'WELCOME_LINKED':
      text = 'Kết nối cửa hàng thành công. Bạn có thể gửi hóa đơn để xử lý ngay.';
      break;
    case 'INVOICE_PROCESSED':
      if (payload.template_vars.item_count !== undefined) {
        text = `Da xu ly thanh cong hoa don voi ${payload.template_vars.item_count} san pham. Tong: ${Number(payload.template_vars.total ?? 0).toLocaleString()} ${payload.template_vars.currency ?? 'VND'}.`;
      } else {
        requireVars(payload.template_vars, ['invoice_number']);
        text = `Hoa don ${payload.template_vars.invoice_number} da duoc xu ly thanh cong.`;
      }
      break;
    case 'NEED_MAPPING_INPUT':
      requireVars(payload.template_vars, ['unresolved_count']);
      text = `Có ${payload.template_vars.unresolved_count} mặt hàng chưa ánh xạ. Vui lòng bổ sung thông tin.`;
      break;
    case 'PROCESSING_FAILED':
      text = 'Không thể xử lý yêu cầu lúc này. Vui lòng thử lại sau.';
      break;
    case 'RATE_LIMITED':
      text = 'Bạn thao tác quá nhanh. Vui lòng chờ và thử lại.';
      break;
    case 'GENERIC_INFO':
      requireVars(payload.template_vars, ['message']);
      text = String(payload.template_vars.message);
      break;
    default:
      throw new Error('unsupported_notification_type');
  }

  const safe = escapeUnsafe(text).trim();
  ensureNoSensitivePatterns(safe);

  if (safe.length === 0) {
    throw new Error('empty_message');
  }

  if (safe.length > maxLen) {
    return `${safe.slice(0, maxLen - 1)}…`;
  }

  return safe;
}
