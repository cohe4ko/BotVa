# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

This is a Model Context Protocol (MCP) server that provides comprehensive integration with the Meta Marketing API for managing Facebook and Instagram advertising campaigns. It's written in TypeScript and designed to be used with Claude Desktop.

## Key Commands

### Development
- `npm run dev` - Start the development server with hot reloading (uses tsx)
- `npm run build` - Compile TypeScript to JavaScript (output in `build/`)
- `npm test` - Run the Jest test suite
- `npm run lint` - Run ESLint to check code quality
- `npm run prepare` - Automatically runs build on npm install

### Testing Individual Features
- To test a specific tool: `npm test -- tools/<tool-name>.test.ts`
- To run tests in watch mode: `npm test -- --watch`
- To run with coverage: `npm test -- --coverage`

## Architecture Overview

### Core Components

1. **Main Server** (`src/index.ts`)
   - Initializes the MCP server with StdioServerTransport
   - Registers all tools and resources
   - Handles authentication and configuration
   - Sets up error handling and graceful shutdown

2. **Meta Client** (`src/meta-client.ts`)
   - Centralized API client for all Meta Marketing API calls
   - Handles authentication, rate limiting, and error recovery
   - Provides typed methods for all API endpoints
   - Implements automatic retry with exponential backoff
   - Manages token validation and refresh

3. **Tools** (`src/tools/`)
   - Each file exports multiple related tools via register functions
   - Tools follow a consistent pattern with Zod schema validation
   - Categories: campaigns, analytics, audiences, creatives, oauth
   - All tools return structured responses with success/error states

4. **Resources** (`src/resources/`)
   - Provide contextual data for the LLM
   - Implement lazy loading and caching
   - Categories: campaigns, audiences, insights
   - Resources auto-refresh to maintain currency

5. **Utilities** (`src/utils/`)
   - Shared functionality across the codebase
   - Key utilities: authentication, error handling, pagination, rate limiting
   - TypeScript type guards and validation helpers

### Design Patterns

- **Modular Tool Organization**: Tools are grouped by functionality with consistent naming (e.g., `campaign_create`, `audience_list`)
- **Schema Validation**: All tool inputs are validated using Zod schemas with detailed error messages
- **Error Handling**: Comprehensive error handling with typed errors, retry logic, and user-friendly messages
- **Rate Limiting**: Built-in rate limiter with configurable tiers (Development: 60/5min, Standard: 9000/5min)
- **Pagination**: Automatic handling of paginated API responses with cursor-based navigation
- **Response Consistency**: All tools return standardized response objects with data/error fields

### Authentication & OAuth Implementation

The server provides comprehensive OAuth 2.0 support for Meta Marketing API authentication:

#### Environment Variables
```bash
# Required
META_ACCESS_TOKEN=your_access_token

# OAuth Configuration (for token refresh and full OAuth flow)
META_APP_ID=your_app_id
META_APP_SECRET=your_app_secret
META_REDIRECT_URI=your_redirect_uri

# Optional
META_AUTO_REFRESH=true               # Enable automatic token refresh
META_REFRESH_TOKEN=your_refresh_token
META_BUSINESS_ID=your_business_id
```

#### Authentication Methods Supported

1. **Static Access Token** (Basic)
   - Provide `META_ACCESS_TOKEN` only
   - Manual token management required

2. **Long-Lived Token with Auto-Refresh** (Recommended)
   - Set `META_APP_ID`, `META_APP_SECRET`, `META_AUTO_REFRESH=true`
   - Automatic refresh ~60 days before expiration
   - Background refresh process with error recovery

3. **Full OAuth Flow** (Web Applications)
   - Complete OAuth 2.0 authorization code flow
   - User consent and token exchange
   - PKCE support for enhanced security

4. **System User Tokens** (Enterprise)
   - Non-expiring tokens for server-to-server automation
   - Business Manager integration required
   - Supports multiple system users per business

#### OAuth Tools Available

- `generate_auth_url` - Create authorization URLs for user consent
- `exchange_code_for_token` - Exchange authorization code for access token
- `refresh_to_long_lived_token` - Convert short-lived to long-lived tokens
- `generate_system_user_token` - Create system user tokens
- `get_token_info` - Get detailed token information and validation
- `validate_token` - Validate current token status

#### Authentication Flow
1. Initial token provided via environment variable or OAuth flow
2. Automatic validation and refresh on startup
3. Background refresh when tokens near expiration
4. Multi-account support with account switching
5. Graceful degradation on auth failures

### API Version

- Currently using Meta Graph API v23.0 (latest version, released May 2025)
- Supports Outcome-Driven Ad Experience (ODAE) objectives
- Compatible with all latest Meta Marketing API features
- Automatic version migration warnings

### Testing Strategy

- Unit tests for individual tools and utilities
- Integration tests for Meta API interactions
- Mock Meta API responses for consistent testing
- Test fixtures in `__tests__/fixtures/` for realistic data
- Error scenario testing with edge cases

### TypeScript Configuration

- Strict mode enabled for type safety
- ES2022 target with module resolution
- Source maps enabled for debugging
- Declaration files generated for type exports
- No implicit any or unused variables

### Tool Registration Pattern

Tools are registered using a consistent pattern:
```typescript
export function registerToolName(server: Server, client: MetaApiClient) {
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name === "tool_name") {
      // Implementation
    }
  });
}
```

### Resource Implementation Pattern

Resources follow a lazy-loading pattern with caching:
```typescript
server.addResource({
  uri: "resource://type/name",
  name: "Resource Name",
  mimeType: "application/json",
  readMethod: async () => ({
    contents: [{
      uri: "resource://type/name",
      mimeType: "application/json",
      text: JSON.stringify(data, null, 2)
    }]
  })
});
```

## Important Considerations

- Always check Meta API documentation for endpoint changes
- Rate limits vary by endpoint - the rate limiter handles this automatically
- Some operations (like campaign creation) require specific permissions
- The server uses ES2022 modules - ensure Node.js 18+ compatibility
- All monetary values should be in cents (lowest denomination)
- Date ranges should use ISO 8601 format
- Targeting parameters require specific formatting per Meta's requirements