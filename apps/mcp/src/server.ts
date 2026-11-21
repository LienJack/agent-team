import type { TeamClient } from '@agent-team/client';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { describeError } from './errors.js';
import { InputError, TOOLS, type ToolContext, type ToolDef } from './tools.js';

export type ClientProvider = () => Promise<TeamClient>;

/** Run one tool and turn the outcome (or any failure) into an MCP tool result. */
export async function runTool(
  def: ToolDef,
  getClient: ClientProvider,
  args: Record<string, unknown>,
  context: ToolContext = {},
): Promise<CallToolResult> {
  try {
    const out = await def.run(await getClient(), args, context);
    return {
      content: [{ type: 'text', text: out.text }],
      ...(out.data === undefined ? {} : { structuredContent: out.data }),
    };
  } catch (err) {
    const text = err instanceof InputError ? `bad_request: ${err.message}` : describeError(err);
    return { isError: true, content: [{ type: 'text', text }] };
  }
}

/** The MCP server: five thin tools over `@agent-team/client`. */
export function createServer(getClient: ClientProvider): McpServer {
  const server = new McpServer({ name: 'agent-team', version: '0.0.0' });
  for (const def of TOOLS) {
    server.registerTool(
      def.name,
      {
        title: def.title,
        description: def.description,
        inputSchema: def.shape,
        annotations: { readOnlyHint: def.readOnly, openWorldHint: false },
      },
      (args, extra) => {
        const token = extra['_meta']?.progressToken;
        let step = 0;
        const progress =
          token === undefined
            ? undefined
            : (message: string) =>
                void extra
                  .sendNotification({
                    method: 'notifications/progress',
                    params: { progressToken: token, progress: ++step, message },
                  })
                  .catch(() => {});
        return runTool(def, getClient, args as Record<string, unknown>, {
          signal: extra.signal,
          ...(progress ? { progress } : {}),
        });
      },
    );
  }
  return server;
}
