import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Logger } from '../../../packages/common/dist/index.js';
import type { ShopStore } from './store.js';
import { ShopDataError } from './store.js';
import { ALL_TOOLS } from './tool-catalog.js';
import type { ApprovalChannel, ClientAnswer, ToolContext, ToolDefinition } from './tools.js';
import { autoCommitRepository } from './auto-commit.js';
import type { PaymentsService } from './payments/service.js';
import type { ShopRepository } from './store.js';
import { randomUUID } from 'node:crypto';
import { countWords, fitSpeech, MAX_SPOKEN_WORDS } from './speech.js';
import { toMarkdown } from './markdown.js';
import type { z } from 'zod';

export const SERVER_NAME = 'shopvoice';
export const SERVER_VERSION = '0.1.0';

/** voice: the console / static bearer (spoken sentence); chat: OAuth clients such as Claude (markdown). */
export type ClientProfile = 'voice' | 'chat';

export interface McpFactoryOptions {
  readonly profile?: ClientProfile;
  readonly store: ShopStore;
  readonly tenantId: string;
  readonly logger: Logger;
  readonly confirmTtlSeconds: number;
  /** Absent: tools that pay say payments are not set up. */
  readonly payments?: PaymentsService | null;
  /** How long to wait for the owner's answer in the client's confirmation form. */
  readonly elicitationTimeoutMs?: number;
  readonly onToolLatency?: (tool: string, latencyMs: number, outcome: 'ok' | 'error') => void;
}

const SAFE_ERROR_SPEECH = "Sorry, I couldn't reach your shop data just now. Please try again in a moment.";

/** Chat clients get a specific, actionable message instead of the short spoken one. */
export function safeErrorText(error: unknown, profile: ClientProfile): string {
  if (profile === 'voice') return safeErrorSpeech(error);
  const message = error instanceof Error ? error.message : '';
  if (error instanceof ShopDataError && error.code === 'profile_missing') {
    return 'This ShopVoice account has no shop profile yet, so there is no shop data to read. Sign in at the ShopVoice account page and link a shop with an invite code, or use the demo shop created at sign-up.';
  }
  if (message.startsWith('custom_period') || message.startsWith('invalid_date')) {
    return 'The date range is invalid: use YYYY-MM-DD dates in the past, with start_date on or before end_date (for example period="custom", start_date="2026-09-01", end_date="2026-09-07").';
  }
  return 'ShopVoice could not read or update the shop data just now (a temporary server or database problem). Retry in a few seconds; if it keeps failing, contact ShopVoice support from the /support page.';
}

export function safeErrorSpeech(error: unknown): string {
  const message = error instanceof Error ? error.message : '';
  if (error instanceof ShopDataError && error.code === 'profile_missing') {
    return 'Your shop profile is not set up yet, so I cannot answer that. Please finish setting up the shop first.';
  }
  if (message.startsWith('custom_period') || message.startsWith('invalid_date')) {
    return 'I need a valid date range in the past, for example from the first to the seventh of this month.';
  }
  return SAFE_ERROR_SPEECH;
}

function defaultRedact(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    out[key] = /token|secret|password/i.test(key) ? '[redacted]' : value;
  }
  return out;
}

const VOICE_INSTRUCTIONS = 'ShopVoice answers a grocery shop owner by voice. Tool results include content[0].text: a short sentence meant to be spoken as-is. Reorders are two-step: create_reorder_draft, read the summary aloud, and call confirm_reorder only after the owner explicitly says yes. Payments follow the owner\'s spending rules; anything over them waits for the owner\'s own approval in the ShopVoice console.';

export const CHAT_INSTRUCTIONS = 'ShopVoice exposes one small grocery or convenience shop: stock levels, daily sales, supplier invoices, purchase-order drafts and supplier payments through PayPal. Amounts are in the shop\'s display currency (the currency field; *_minor fields hold exact amounts in cents) and quantities are in each product\'s own unit. Reorders take two calls: create_reorder_draft returns a confirmation_token valid for 5 minutes, and confirm_reorder confirms the drafts and pays each supplier within the owner\'s spending rules, asking the owner directly when a payment needs approval.';

/** One McpServer per MCP session, bound to the tenant resolved from the bearer token. */
export function createShopVoiceServer(opts: McpFactoryOptions): McpServer {
  const profile = opts.profile ?? 'voice';
  const server = new McpServer(
    { name: SERVER_NAME, title: 'ShopVoice', version: SERVER_VERSION },
    {
      capabilities: { tools: {}, prompts: {}, resources: {} },
      instructions: profile === 'chat' ? CHAT_INSTRUCTIONS : VOICE_INSTRUCTIONS
    }
  );

  for (const tool of ALL_TOOLS) {
    registerTool(server, tool as unknown as ToolDefinition<z.ZodRawShape, z.ZodRawShape>, opts);
  }

  server.registerPrompt('morning_briefing', {
    title: 'Morning shop briefing',
    description: 'Start-of-day briefing for the shop owner: sales, low stock and invoices, then offer next steps.'
  }, () => ({
    messages: [{
      role: 'user',
      content: {
        type: 'text',
        text: 'Give me my morning shop briefing. Call get_daily_briefing and speak its answer. Then ask if I want to hear what is running low or draft a reorder. Keep every spoken answer under 35 words.'
      }
    }]
  }));

  server.registerResource('shop-profile', 'shop://profile', {
    title: 'Shop profile',
    description: 'Shop name, display currency, timezone and locale for the connected shop.',
    mimeType: 'application/json'
  }, async (uri) => {
    const profile = await opts.store.withTenant(opts.tenantId, (repo) => repo.getProfile());
    return {
      contents: [{
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify({
          shop_name: profile.shopName,
          display_currency: profile.displayCurrency,
          minor_per_unit: profile.minorPerUnit,
          timezone: profile.timezone,
          locale: profile.locale
        })
      }]
    };
  });

  return server;
}

const APPROVE_SCHEMA = {
  type: 'object' as const,
  properties: { approve: { type: 'boolean' as const, title: 'Approve', description: 'Yes to approve, no to decline.', default: false } },
  required: ['approve']
};

/** The approval channel for one tool call: the owner's console, or this MCP client via elicitation. */
function approvalChannel(server: McpServer, opts: McpFactoryOptions, relatedRequestId: string | number): ApprovalChannel {
  const kind = opts.profile === 'chat' ? 'client' : 'console';
  const timeout = opts.elicitationTimeoutMs ?? 120_000;
  const caps = () => server.server.getClientCapabilities()?.elicitation;
  const ask = async (run: () => Promise<{ action: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> | undefined }>, accepted: (content: Record<string, unknown> | undefined) => boolean): Promise<ClientAnswer> => {
    try {
      const result = await run();
      if (result.action === 'accept') return accepted(result.content) ? 'accept' : 'decline';
      return result.action;
    } catch (error) {
      opts.logger.warn('mcp_elicitation_failed', { error: error instanceof Error ? error.message : 'unknown' });
      return 'unavailable';
    }
  };
  return {
    kind,
    async confirm(message) {
      if (kind !== 'client' || !caps()?.form) return 'unavailable';
      return ask(() => server.server.elicitInput({ mode: 'form', message, requestedSchema: APPROVE_SCHEMA }, { relatedRequestId, timeout }), (c) => c?.approve === true);
    },
    async openUrl(message, url) {
      if (kind !== 'client' || !caps()?.url) return 'unavailable';
      return ask(() => server.server.elicitInput({ mode: 'url', message, url, elicitationId: randomUUID() }, { relatedRequestId, timeout }), () => true);
    }
  };
}

function registerTool(server: McpServer, tool: ToolDefinition<z.ZodRawShape, z.ZodRawShape>, opts: McpFactoryOptions): void {
  server.registerTool(tool.name, {
    title: tool.title,
    description: tool.description,
    inputSchema: tool.input,
    outputSchema: tool.output,
    annotations: { title: tool.title, ...tool.annotations }
  }, async (rawArgs: Record<string, unknown>, extra: { requestId: string | number }) => {
    const started = performance.now();
    const args = rawArgs as z.infer<z.ZodObject<z.ZodRawShape>>;
    const redacted = tool.redact ? tool.redact(args) : defaultRedact(rawArgs);
    try {
      const correlationId = randomUUID();
      const run = async (repo: ShopRepository) => {
        const profile = await repo.getProfile();
        const suppliers = opts.payments ? new Map((await repo.listSuppliers()).map((s) => [s.code, s.name])) : new Map<string, string>();
        const ctx: ToolContext = {
          repo,
          profile,
          today: await repo.today(),
          money: { currency: profile.displayCurrency, minorPerUnit: profile.minorPerUnit },
          confirmTtlSeconds: opts.confirmTtlSeconds,
          payments: opts.payments
            ? { service: opts.payments, ctx: { repo: repo.payments, correlationId, supplierName: (code: string) => suppliers.get(code) ?? code } }
            : null,
          approvals: approvalChannel(server, opts, extra.requestId)
        };
        return tool.run(ctx, args);
      };
      // Session tools commit each repository call on its own (see ToolDefinition.session).
      const outcome = tool.session
        ? await run(autoCommitRepository(opts.store, opts.tenantId))
        : await opts.store.withTenant(opts.tenantId, run);
      let speech = outcome.speech;
      if (countWords(speech) > MAX_SPOKEN_WORDS) {
        opts.logger.warn('mcp_speech_over_budget', { tool: tool.name, words: countWords(speech) });
        speech = fitSpeech([speech]);
      }
      const latencyMs = performance.now() - started;
      await audit(opts, tool.name, redacted, speech, 'ok', latencyMs);
      opts.onToolLatency?.(tool.name, latencyMs, 'ok');
      const text = opts.profile === 'chat' ? toMarkdown(tool.name, outcome.data, speech) : speech;
      return {
        content: [{ type: 'text' as const, text }],
        structuredContent: outcome.data as Record<string, unknown>
      };
    } catch (error) {
      const latencyMs = performance.now() - started;
      const speech = safeErrorText(error, opts.profile ?? 'voice');
      opts.logger.error('mcp_tool_failed', { tool: tool.name, tenant_id: opts.tenantId, error: error instanceof Error ? error.message : 'unknown' });
      await audit(opts, tool.name, redacted, speech, 'error', latencyMs);
      opts.onToolLatency?.(tool.name, latencyMs, 'error');
      return { content: [{ type: 'text' as const, text: speech }], isError: true };
    }
  });
}

async function audit(opts: McpFactoryOptions, toolName: string, args: Record<string, unknown>, summary: string, outcome: 'ok' | 'error', latencyMs: number): Promise<void> {
  try {
    await opts.store.withTenant(opts.tenantId, (repo) => repo.audit({ toolName, argsRedacted: args, resultSummary: summary, outcome, latencyMs }));
  } catch (error) {
    // Auditing must never break the spoken answer; surface it in logs instead.
    opts.logger.error('mcp_audit_failed', { tool: toolName, error: error instanceof Error ? error.message : 'unknown' });
  }
}
