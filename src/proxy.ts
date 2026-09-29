import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  GetPromptRequestSchema,
  ListPromptsRequestSchema,
  ListResourcesRequestSchema,
  ListResourceTemplatesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
  type ServerCapabilities,
} from "@modelcontextprotocol/sdk/types.js";

import { endpointFromDiscovery } from "./api.js";
import { loadCredential } from "./credentials.js";

export async function serveSecureProxy(version: string): Promise<void> {
  const stored = loadCredential();
  const apiKey = process.env.PROBLEE_API_KEY ?? stored?.apiKey;
  const endpoint =
    process.env.PROBLEE_MCP_ENDPOINT ?? stored?.endpoint ?? endpointFromDiscovery(null);

  const upstream = new Client({
    name: "@probleeprotocol/mcp-secure-proxy",
    version,
  });
  // Without a key the server lists and runs only its public reads.
  const upstreamTransport = new StreamableHTTPClientTransport(
    new URL(endpoint),
    apiKey ? { requestInit: { headers: { Authorization: `Bearer ${apiKey}` } } } : undefined,
  );
  await upstream.connect(upstreamTransport);

  const advertised = upstream.getServerCapabilities() ?? {};
  const capabilities: ServerCapabilities = {};
  if (advertised.tools) capabilities.tools = { listChanged: false };
  if (advertised.resources) {
    capabilities.resources = { listChanged: false, subscribe: false };
  }
  if (advertised.prompts) capabilities.prompts = { listChanged: false };

  const downstream = new Server(
    { name: "@probleeprotocol/mcp", version },
    {
      capabilities,
      instructions: upstream.getInstructions(),
    },
  );

  if (advertised.tools) {
    downstream.setRequestHandler(ListToolsRequestSchema, (request) =>
      upstream.listTools(request.params),
    );
    downstream.setRequestHandler(CallToolRequestSchema, (request) =>
      upstream.callTool(request.params),
    );
  }
  if (advertised.resources) {
    downstream.setRequestHandler(ListResourcesRequestSchema, (request) =>
      upstream.listResources(request.params),
    );
    downstream.setRequestHandler(ListResourceTemplatesRequestSchema, (request) =>
      upstream.listResourceTemplates(request.params),
    );
    downstream.setRequestHandler(ReadResourceRequestSchema, (request) =>
      upstream.readResource(request.params),
    );
  }
  if (advertised.prompts) {
    downstream.setRequestHandler(ListPromptsRequestSchema, (request) =>
      upstream.listPrompts(request.params),
    );
    downstream.setRequestHandler(GetPromptRequestSchema, (request) =>
      upstream.getPrompt(request.params),
    );
  }

  const downstreamTransport = new StdioServerTransport();
  let closing = false;
  const close = async (): Promise<void> => {
    if (closing) return;
    closing = true;
    await Promise.allSettled([downstream.close(), upstream.close()]);
  };
  downstream.onclose = () => void close();
  upstream.onclose = () => void close();
  downstream.onerror = (error) => {
    process.stderr.write(`Problee MCP local bridge error: ${error.message}\n`);
  };
  upstream.onerror = (error) => {
    process.stderr.write(`Problee MCP upstream error: ${error.message}\n`);
  };
  process.once("SIGINT", () => void close());
  process.once("SIGTERM", () => void close());
  await downstream.connect(downstreamTransport);
}
