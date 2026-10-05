// Claude as the console's brain, through Claude in Amazon Bedrock or the
// Anthropic API. The agent loop keeps Converse-shaped history ({text},
// {toolUse}, {toolResult}); this class maps it to the Messages API and back.
// Claude's thinking blocks are kept verbatim in the assistant turns they came
// from, because a tool-use turn must send them back unchanged.
//
// The voice loop targets a p50 under 3 s, so it runs Claude Sonnet 5.5 at low
// effort by default, or Claude Haiku 4.5 as the fast option (CLAUDE_MODEL).
// Opus models are refused here: they are too slow for a spoken turn.
//
// The brain only proposes tool calls. The host (agent.ts) decides whether a
// call may run, fills in held tokens itself, and approves payments only from
// a spoken yes matched by its own code; nothing here can move money.
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrock, AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { Block, Brain, BrainResponse, ChatMessage, ToolSpec } from './brain.js';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';
export type VoiceModelFamily = 'sonnet' | 'haiku';

/** The one SDK call the brain makes; real clients and test stubs both fit. */
export interface MessagesClient {
  readonly messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface ClaudeBrainConfig {
  readonly provider: 'bedrock' | 'anthropic';
  readonly model: string;
  readonly family: VoiceModelFamily;
  /** Sent only to models that accept it (Sonnet 5.5); Haiku 4.5 has no effort parameter. */
  readonly effort: Effort;
  readonly maxTokens: number;
}

export interface ClaudeEnv {
  readonly BRAIN?: string | undefined;
  readonly CLAUDE_MODEL?: string | undefined;
  readonly CLAUDE_EFFORT?: string | undefined;
  readonly BEDROCK_REGION?: string | undefined;
  readonly BEDROCK_AWS_ACCESS_KEY_ID?: string | undefined;
  readonly BEDROCK_AWS_SECRET_ACCESS_KEY?: string | undefined;
  readonly BEDROCK_AWS_SESSION_TOKEN?: string | undefined;
  readonly BEDROCK_API_KEY?: string | undefined;
  readonly ANTHROPIC_API_KEY?: string | undefined;
}

/**
 * Model ids per provider. Sonnet 5.5 is served on Bedrock's Mantle endpoint
 * (`anthropic.` ids); Haiku 4.5 runs on the Bedrock runtime and is called
 * through a US cross-region inference profile.
 */
export const VOICE_MODELS: Readonly<Record<VoiceModelFamily, { readonly bedrock: string; readonly anthropic: string }>> = {
  sonnet: { bedrock: 'anthropic.claude-sonnet-5-5', anthropic: 'claude-sonnet-5-5' },
  haiku: { bedrock: 'us.anthropic.claude-haiku-4-5-20251001-v1:0', anthropic: 'claude-haiku-4-5-20251001' }
};
export const DEFAULT_BEDROCK_MODEL = VOICE_MODELS.sonnet.bedrock;
export const DEFAULT_ANTHROPIC_MODEL = VOICE_MODELS.sonnet.anthropic;

/**
 * CLAUDE_MODEL: empty or "sonnet" (default), "haiku", or a full model id of
 * either family. Anything else (Opus, Fable, unknown) is refused for voice.
 */
export function resolveVoiceModel(provider: 'bedrock' | 'anthropic', value: string | undefined): { model: string; family: VoiceModelFamily } {
  const raw = (value ?? '').trim();
  const alias = raw.toLowerCase();
  if (alias === '' || alias === 'sonnet') return { model: VOICE_MODELS.sonnet[provider], family: 'sonnet' };
  if (alias === 'haiku' || alias === 'fast') return { model: VOICE_MODELS.haiku[provider], family: 'haiku' };
  const family: VoiceModelFamily | null = /sonnet-5-5/.test(alias) ? 'sonnet' : /haiku-4-5/.test(alias) ? 'haiku' : null;
  if (!family) {
    throw new Error(`CLAUDE_MODEL=${raw} is not a voice model. Use "sonnet" (Claude Sonnet 5.5, default) or "haiku" (Claude Haiku 4.5); Opus is too slow for the voice loop`);
  }
  if (provider === 'anthropic' && raw.includes('anthropic.')) throw new Error(`CLAUDE_MODEL=${raw} is a Bedrock id; the Anthropic API uses ids like ${VOICE_MODELS[family].anthropic}`);
  if (provider === 'bedrock' && !raw.includes('anthropic.')) throw new Error(`Claude in Amazon Bedrock model ids contain "anthropic." (got ${raw}); try ${VOICE_MODELS[family].bedrock}`);
  return { model: raw, family };
}

/** Bedrock ids without a region prefix or version suffix are served by Mantle; inference profiles by the runtime. */
export function bedrockEndpointFor(model: string): 'mantle' | 'runtime' {
  return /^anthropic\.claude-[a-z0-9-]+$/.test(model) ? 'mantle' : 'runtime';
}

/** Builds the SDK client from env. Bedrock credentials are separate from any other AWS_* in the environment. */
export function claudeClientFromEnv(env: ClaudeEnv): { client: MessagesClient; config: ClaudeBrainConfig } {
  const provider = env.BRAIN === 'claude-api' ? 'anthropic' : 'bedrock';
  const effort = (['low', 'medium', 'high'] as const).find((e) => e === env.CLAUDE_EFFORT) ?? 'low';
  const { model, family } = resolveVoiceModel(provider, env.CLAUDE_MODEL);
  const config: ClaudeBrainConfig = { provider, model, family, effort, maxTokens: 4096 };
  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('BRAIN=claude-api needs ANTHROPIC_API_KEY');
    return { client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }), config };
  }
  const region = env.BEDROCK_REGION || 'us-east-1';
  const keys = env.BEDROCK_AWS_ACCESS_KEY_ID && env.BEDROCK_AWS_SECRET_ACCESS_KEY
    ? { access: env.BEDROCK_AWS_ACCESS_KEY_ID, secret: env.BEDROCK_AWS_SECRET_ACCESS_KEY, session: env.BEDROCK_AWS_SESSION_TOKEN || null }
    : null;
  if (!env.BEDROCK_API_KEY && !keys) throw new Error('BRAIN=claude-bedrock needs BEDROCK_AWS_ACCESS_KEY_ID + BEDROCK_AWS_SECRET_ACCESS_KEY (or BEDROCK_API_KEY)');
  if (bedrockEndpointFor(model) === 'mantle') {
    const auth = env.BEDROCK_API_KEY
      ? { apiKey: env.BEDROCK_API_KEY }
      : { awsAccessKey: keys!.access, awsSecretAccessKey: keys!.secret, ...(keys!.session ? { awsSessionToken: keys!.session } : {}) };
    return { client: new AnthropicBedrockMantle({ awsRegion: region, ...auth }) as unknown as MessagesClient, config };
  }
  const client = env.BEDROCK_API_KEY
    ? new AnthropicBedrock({ awsRegion: region, apiKey: env.BEDROCK_API_KEY })
    : new AnthropicBedrock({ awsRegion: region, awsAccessKey: keys!.access, awsSecretKey: keys!.secret, awsSessionToken: keys!.session });
  return { client: client as unknown as MessagesClient, config };
}

const isNative = (b: Block): b is Block & { type: string } => typeof (b as { type?: unknown }).type === 'string';

/** Converse-shaped history -> Messages API params. Native Claude blocks (thinking, text, tool_use) pass through untouched. */
export function toClaudeMessages(messages: readonly ChatMessage[]): Anthropic.MessageParam[] {
  return messages.map((m) => ({
    role: m.role,
    content: m.content.flatMap((b): Anthropic.ContentBlockParam[] => {
      if (isNative(b)) return [b as unknown as Anthropic.ContentBlockParam];
      if ('text' in b && typeof b.text === 'string') return b.text ? [{ type: 'text', text: b.text }] : [];
      if ('toolUse' in b) {
        const u = (b as { toolUse: { toolUseId: string; name: string; input: Record<string, unknown> } }).toolUse;
        return [{ type: 'tool_use', id: u.toolUseId, name: u.name, input: u.input }];
      }
      if ('toolResult' in b) {
        const r = (b as { toolResult: { toolUseId: string; content: ({ json: Record<string, unknown> } | { text: string })[]; status?: string } }).toolResult;
        const content = r.content.map((c): Anthropic.TextBlockParam => ({ type: 'text', text: 'text' in c ? c.text : JSON.stringify(c.json) }));
        return [{ type: 'tool_result', tool_use_id: r.toolUseId, content, ...(r.status === 'error' ? { is_error: true } : {}) }];
      }
      return [];
    })
  }));
}

/** Messages API response -> agent blocks: text and tool_use become {text}/{toolUse}; thinking stays native, in place. */
export function fromClaudeContent(content: readonly Anthropic.ContentBlock[]): Block[] {
  const out: Block[] = [];
  for (const block of content) {
    if (block.type === 'text') out.push({ text: block.text });
    else if (block.type === 'tool_use') out.push({ toolUse: { toolUseId: block.id, name: block.name, input: (block.input ?? {}) as Record<string, unknown> } });
    else if (block.type === 'thinking' || block.type === 'redacted_thinking') out.push(block as unknown as Block);
  }
  return out;
}

export class ClaudeBrain implements Brain {
  readonly kind = 'claude' as const;
  readonly model: string;

  constructor(private readonly client: MessagesClient, private readonly config: ClaudeBrainConfig) {
    this.model = config.model;
  }

  get provider(): 'bedrock' | 'anthropic' {
    return this.config.provider;
  }

  async converse(input: { system: string; messages: ChatMessage[]; tools: ToolSpec[] }): Promise<BrainResponse> {
    const started = performance.now();
    const tools: Anthropic.Tool[] = input.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.inputSchema as Anthropic.Tool.InputSchema
    }));
    const response = await this.client.messages.create({
      model: this.config.model,
      max_tokens: this.config.maxTokens,
      // Tools and system are the same every turn: one explicit cache breakpoint covers both
      // (Bedrock has no automatic caching).
      system: [{ type: 'text', text: input.system, cache_control: { type: 'ephemeral' } }],
      tools,
      messages: toClaudeMessages(input.messages),
      // Adaptive thinking (the default) at low effort keeps Sonnet 5.5 quick; Haiku 4.5 takes no effort setting.
      ...(this.config.family === 'sonnet' ? { output_config: { effort: this.config.effort } } : {})
    });
    const stop = response.stop_reason;
    return {
      content: fromClaudeContent(response.content),
      stopReason: stop === 'tool_use' ? 'tool_use' : stop === 'end_turn' ? 'end_turn' : stop === 'max_tokens' ? 'max_tokens' : 'other',
      latencyMs: performance.now() - started
    };
  }
}
