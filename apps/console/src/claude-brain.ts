// Claude as the console's brain, through Claude in Amazon Bedrock (the
// AnthropicBedrockMantle client, `anthropic.`-prefixed model ids) or the
// Anthropic API. The agent loop keeps Converse-shaped history ({text},
// {toolUse}, {toolResult}); this class maps it to the Messages API and back.
// Claude's thinking blocks are kept verbatim in the assistant turns they came
// from, because a tool-use turn must send them back unchanged.
//
// The brain only proposes tool calls. The host (agent.ts) decides whether a
// call may run, fills in held tokens itself, and approves payments only from
// a spoken yes matched by its own code; nothing here can move money.
import Anthropic from '@anthropic-ai/sdk';
import { AnthropicBedrockMantle } from '@anthropic-ai/bedrock-sdk';
import type { Block, Brain, BrainResponse, ChatMessage, ToolSpec } from './brain.js';

type Effort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

/** The one SDK call the brain makes; real clients and test stubs both fit. */
export interface MessagesClient {
  readonly messages: { create(params: Anthropic.MessageCreateParamsNonStreaming): Promise<Anthropic.Message> };
}

export interface ClaudeBrainConfig {
  readonly provider: 'bedrock' | 'anthropic';
  readonly model: string;
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

export const DEFAULT_BEDROCK_MODEL = 'anthropic.claude-opus-5-5';
export const DEFAULT_ANTHROPIC_MODEL = 'claude-opus-5-5';

/** Builds the SDK client from env. Bedrock credentials are separate from any other AWS_* in the environment. */
export function claudeClientFromEnv(env: ClaudeEnv): { client: MessagesClient; config: ClaudeBrainConfig } {
  const provider = env.BRAIN === 'claude-api' ? 'anthropic' : 'bedrock';
  const effort = (['low', 'medium', 'high', 'xhigh', 'max'] as const).find((e) => e === env.CLAUDE_EFFORT) ?? 'low';
  if (provider === 'anthropic') {
    if (!env.ANTHROPIC_API_KEY) throw new Error('BRAIN=claude-api needs ANTHROPIC_API_KEY');
    return {
      client: new Anthropic({ apiKey: env.ANTHROPIC_API_KEY }),
      config: { provider, model: env.CLAUDE_MODEL || DEFAULT_ANTHROPIC_MODEL, effort, maxTokens: 4096 }
    };
  }
  const region = env.BEDROCK_REGION || 'us-east-1';
  const auth = env.BEDROCK_API_KEY
    ? { apiKey: env.BEDROCK_API_KEY }
    : env.BEDROCK_AWS_ACCESS_KEY_ID && env.BEDROCK_AWS_SECRET_ACCESS_KEY
      ? {
        awsAccessKey: env.BEDROCK_AWS_ACCESS_KEY_ID,
        awsSecretAccessKey: env.BEDROCK_AWS_SECRET_ACCESS_KEY,
        ...(env.BEDROCK_AWS_SESSION_TOKEN ? { awsSessionToken: env.BEDROCK_AWS_SESSION_TOKEN } : {})
      }
      : null;
  if (!auth) throw new Error('BRAIN=claude-bedrock needs BEDROCK_AWS_ACCESS_KEY_ID + BEDROCK_AWS_SECRET_ACCESS_KEY (or BEDROCK_API_KEY)');
  const model = env.CLAUDE_MODEL || DEFAULT_BEDROCK_MODEL;
  if (!model.startsWith('anthropic.')) throw new Error(`Claude in Amazon Bedrock model ids start with "anthropic." (got ${model})`);
  return {
    client: new AnthropicBedrockMantle({ awsRegion: region, ...auth }) as unknown as MessagesClient,
    config: { provider, model, effort, maxTokens: 4096 }
  };
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
      output_config: { effort: this.config.effort }
    });
    const stop = response.stop_reason;
    return {
      content: fromClaudeContent(response.content),
      stopReason: stop === 'tool_use' ? 'tool_use' : stop === 'end_turn' ? 'end_turn' : stop === 'max_tokens' ? 'max_tokens' : 'other',
      latencyMs: performance.now() - started
    };
  }
}
