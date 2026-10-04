export type TenantId = string & { readonly __brand: 'TenantId' };
export type PlatformUserId = string & { readonly __brand: 'PlatformUserId' };
export type TelegramChatId = number & { readonly __brand: 'TelegramChatId' };
export type CorrelationId = string & { readonly __brand: 'CorrelationId' };

/** @deprecated Use PlatformUserId instead */
export type ZaloPlatformUserId = PlatformUserId;
/** @deprecated No longer used */
export type ZaloUserId = string & { readonly __brand: 'ZaloUserId' };

export type RuntimeEnvironment = 'development' | 'test' | 'production';

export type TelegramMode = 'polling' | 'webhook';

export interface TelegramConfig {
  readonly botToken: string;
  readonly mode: TelegramMode;
  readonly webhookSecret?: string;
  readonly webhookUrl?: string;
}

export interface ServiceIdentity {
  readonly service: 'gateway' | 'admin' | 'worker';
  readonly env: RuntimeEnvironment;
}
