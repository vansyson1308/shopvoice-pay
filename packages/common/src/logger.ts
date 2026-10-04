export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogContext {
  readonly correlation_id?: string;
  readonly [key: string]: unknown;
}

export interface Logger {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
}

const order: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40
};

const sensitiveKeyPattern = /(token|secret|password|authorization|api[_-]?key|mek|invite_pepper)/i;
const sensitiveStringPatterns = [
  /(authorization\s*:\s*bearer\s+)[^\s"']+/ig,
  /(token\s*=\s*)[^\s"']+/ig,
  /(admin_mek_b64\s*=\s*)[^\s"']+/ig,
  /(invite_pepper\s*=\s*)[^\s"']+/ig
];

function sanitizeString(input: string): string {
  let out = input;
  for (const pattern of sensitiveStringPatterns) {
    out = out.replace(pattern, '$1[REDACTED]');
  }
  return out;
}

function sanitizeUnknown(value: unknown): unknown {
  if (typeof value === 'string') {
    return sanitizeString(value);
  }
  if (Array.isArray(value)) {
    return value.map((item) => sanitizeUnknown(item));
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      if (sensitiveKeyPattern.test(key)) {
        out[key] = '[REDACTED]';
      } else {
        out[key] = sanitizeUnknown(inner);
      }
    }
    return out;
  }
  return value;
}

function write(level: LogLevel, service: string, minLevel: LogLevel, message: string, context?: LogContext): void {
  if (order[level] < order[minLevel]) {
    return;
  }

  const safeContext = (sanitizeUnknown(context) ?? {}) as Record<string, unknown>;

  const payload = {
    ts: new Date().toISOString(),
    level,
    service,
    message: sanitizeString(message),
    correlation_id: (safeContext.correlation_id as string | undefined) ?? null,
    ...safeContext
  };

  const line = JSON.stringify(payload);
  if (level === 'error' || level === 'warn') {
    console.error(line);
    return;
  }

  console.log(line);
}

export function createLogger(opts: { readonly service: string; readonly level: LogLevel }): Logger {
  return {
    debug(message, context) {
      write('debug', opts.service, opts.level, message, context);
    },
    info(message, context) {
      write('info', opts.service, opts.level, message, context);
    },
    warn(message, context) {
      write('warn', opts.service, opts.level, message, context);
    },
    error(message, context) {
      write('error', opts.service, opts.level, message, context);
    }
  };
}
