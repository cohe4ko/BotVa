#!/usr/bin/env node

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js';
import { allTools, executeToolCall } from './tools/index.js';

// Initialize the MCP server
const server = new Server({
  name: 'bitrix24-mcp-server',
  version: '1.0.0',
  capabilities: {
    tools: {}
  }
});

// Handle tool listing
server.setRequestHandler(ListToolsRequestSchema, async () => {
  console.error('Listing available Bitrix24 tools...');
  return {
    tools: allTools
  };
});

// Handle tool execution
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  
  console.error(`Executing tool: ${name} with args:`, JSON.stringify(args, null, 2));
  
  try {
    const result = await executeToolCall(name, args || {});
    
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify(result, null, 2)
        }
      ]
    };
  } catch (error) {
    console.error(`Tool execution failed [${name}]:`, error);
    
    if (error instanceof McpError) {
      throw error;
    }
    
    throw new McpError(
      ErrorCode.InternalError,
      `Tool execution failed: ${error instanceof Error ? error.message : String(error)}`
    );
  }
});

// Start the server
async function main() {
  console.error('Starting Bitrix24 MCP Server...');
  console.error('Available tools:', allTools.map(t => t.name).join(', '));
  
  const transport = new StdioServerTransport();
  await server.connect(transport);
  
  console.error('Bitrix24 MCP Server running on stdio transport');
}

main().catch((error) => {
  console.error('Fatal error:', error);
  process.exit(1);
});
