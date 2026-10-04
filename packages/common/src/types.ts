export type TenantId = string & { readonly __brand: 'TenantId' };
export type CorrelationId = string & { readonly __brand: 'CorrelationId' };

export type RuntimeEnvironment = 'development' | 'test' | 'production';
