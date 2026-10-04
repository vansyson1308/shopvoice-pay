// MCP client side: connects to the ShopVoice MCP server over Streamable HTTP
// and exposes its tools to the brain (as Bedrock toolSpecs) and to the agent.
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { ToolSpec } from './brain.js';

export interface ToolCallResult {
  readonly spoken: string;
  readonly structured: Record<string, unknown> | null;
  readonly isError: boolean;
  readonly latencyMs: number;
}

export interface Toolbox {
  listTools(): Promise<ToolSpec[]>;
  callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult>;
  protocolVersion(): string | undefined;
  close(): Promise<void>;
}

export class McpToolbox implements Toolbox {
  private client: Client | null = null;
  private transport: StreamableHTTPClientTransport | null = null;
  private tools: ToolSpec[] | null = null;

  constructor(private readonly url: string, private readonly token: string, private readonly extraHeaders: Record<string, string> = {}) {}

  private async connect(): Promise<Client> {
    if (this.client) return this.client;
    const client = new Client({ name: 'shopvoice-sim', version: '0.1.0' });
    const transport = new StreamableHTTPClientTransport(new URL(this.url), {
      requestInit: { headers: { ...this.extraHeaders, authorization: `Bearer ${this.token}` } }
    });
    // Same exactOptionalPropertyTypes gap as the server transport (FRICTION_LOG F4).
    await client.connect(transport as unknown as Transport);
    this.client = client;
    this.transport = transport;
    return client;
  }

  private async withReconnect<T>(work: (client: Client) => Promise<T>): Promise<T> {
    try {
      return await work(await this.connect());
    } catch (error) {
      // Session expired or server restarted: reconnect once with a fresh session.
      await this.close();
      return work(await this.connect());
    }
  }

  async listTools(): Promise<ToolSpec[]> {
    if (this.tools) return this.tools;
    const { tools } = await this.withReconnect((c) => c.listTools());
    this.tools = tools.map((t) => ({
      name: t.name,
      description: t.description ?? t.title ?? t.name,
      inputSchema: t.inputSchema as Record<string, unknown>
    }));
    return this.tools;
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    const started = performance.now();
    const result = await this.withReconnect((c) => c.callTool({ name, arguments: args }));
    const content = Array.isArray(result.content) ? result.content : [];
    const first = content[0] as { type?: string; text?: string } | undefined;
    return {
      spoken: first?.type === 'text' ? first.text ?? '' : '',
      structured: (result.structuredContent as Record<string, unknown> | undefined) ?? null,
      isError: result.isError === true,
      latencyMs: performance.now() - started
    };
  }

  protocolVersion(): string | undefined {
    return this.transport?.protocolVersion;
  }

  async close(): Promise<void> {
    const client = this.client;
    this.client = null;
    this.transport = null;
    if (client) await client.close().catch(() => {});
  }
}
