#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MetaApiClient } from "./meta-client.js";
import { AuthManager } from "./utils/auth.js";
import { registerCampaignTools } from "./tools/campaigns.js";
import { registerAnalyticsTools } from "./tools/analytics.js";
import { registerAudienceTools } from "./tools/audiences.js";
import { registerCreativeTools } from "./tools/creatives.js";
import { registerOAuthTools } from "./tools/oauth.js";
import { registerCampaignResources } from "./resources/campaigns.js";
import { registerInsightsResources } from "./resources/insights.js";
import { registerAudienceResources } from "./resources/audiences.js";

async function main() {
  try {
    console.error("🚀 Starting Meta Marketing API MCP Server...");
    console.error("📋 Environment check:");
    console.error(`   NODE_VERSION: ${process.version}`);
    console.error(
      `   META_ACCESS_TOKEN: ${
        process.env.META_ACCESS_TOKEN ? "Present" : "Missing"
      }`
    );
    console.error(
      `   MCP_SERVER_NAME: ${process.env.MCP_SERVER_NAME || "Not set"}`
    );

    // Initialize authentication
    console.error("🔐 Initializing authentication...");
    const auth = AuthManager.fromEnvironment();
    console.error("✅ Auth manager created successfully");

    // Validate and refresh token if needed
    console.error("🔍 Validating Meta access token...");
    try {
      const currentToken = await auth.refreshTokenIfNeeded();
      console.error("✅ Token validation and refresh successful");
      console.error(`🔑 Token ready: ${currentToken.substring(0, 20)}...`);
      
      // Log OAuth configuration status
      const hasOAuthConfig = !!(process.env.META_APP_ID && process.env.META_APP_SECRET);
      console.error(`🔧 OAuth configuration: ${hasOAuthConfig ? "Available" : "Not configured"}`);
      console.error(`🔄 Auto-refresh: ${process.env.META_AUTO_REFRESH === "true" ? "Enabled" : "Disabled"}`);
    } catch (error) {
      console.error("❌ Token validation failed:", error);
      console.error("💡 Use OAuth tools to obtain a new token or check configuration");
      process.exit(1);
    }

    // Initialize Meta API client
    console.error("🌐 Initializing Meta API client...");
    const metaClient = new MetaApiClient(auth);
    console.error("✅ Meta API client created successfully");

    // Initialize MCP Server
    console.error("🔧 Initializing MCP Server...");
    const server = new McpServer({
      name: process.env.MCP_SERVER_NAME || "Meta Marketing API Server",
      version: process.env.MCP_SERVER_VERSION || "1.0.0",
    });
    console.error("✅ MCP Server instance created");

    // Register all tools
    console.error("🛠️  Registering tools...");
    registerCampaignTools(server, metaClient);
    console.error("   ✅ Campaign tools registered");
    registerAnalyticsTools(server, metaClient);
    console.error("   ✅ Analytics tools registered");
    registerAudienceTools(server, metaClient);
    console.error("   ✅ Audience tools registered");
    registerCreativeTools(server, metaClient);
    console.error("   ✅ Creative tools registered");
    registerOAuthTools(server, auth);
    console.error("   ✅ OAuth tools registered");

    // Register all resources
    console.error("📚 Registering resources...");
    registerCampaignResources(server, metaClient);
    console.error("   ✅ Campaign resources registered");
    registerInsightsResources(server, metaClient);
    console.error("   ✅ Insights resources registered");
    registerAudienceResources(server, metaClient);
    console.error("   ✅ Audience resources registered");

    // Add account discovery tool
    server.tool("get_ad_accounts", {}, async () => {
      try {
        const accounts = await metaClient.getAdAccounts();

        const accountsData = accounts.map((account) => ({
          id: account.id,
          name: account.name,
          account_status: account.account_status,
          currency: account.currency,
          timezone_name: account.timezone_name,
          balance: account.balance,
          business: account.business
            ? {
                id: account.business.id,
                name: account.business.name,
              }
            : null,
        }));

        const response = {
          success: true,
          accounts: accountsData,
          total_accounts: accountsData.length,
          message: "Ad accounts retrieved successfully",
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          content: [
            {
              type: "text",
              text: `Error getting ad accounts: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    });

    // Add server health check tool
    server.tool("health_check", {}, async () => {
      try {
        const accounts = await metaClient.getAdAccounts();
        const response = {
          status: "healthy",
          server_name: "Meta Marketing API Server",
          version: "1.0.0",
          timestamp: new Date().toISOString(),
          meta_api_connection: "connected",
          accessible_accounts: accounts.length,
          rate_limit_status: "operational",
          features: {
            campaign_management: true,
            analytics_reporting: true,
            audience_management: true,
            creative_management: true,
            real_time_insights: true,
          },
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        const response = {
          status: "unhealthy",
          server_name: "Meta Marketing API Server",
          version: "1.0.0",
          timestamp: new Date().toISOString(),
          error: errorMessage,
          meta_api_connection: "failed",
        };

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(response, null, 2),
            },
          ],
          isError: true,
        };
      }
    });

    // Add server capabilities info
    server.tool("get_capabilities", {}, async () => {
      const capabilities = {
        server_info: {
          name: "Meta Marketing API Server",
          version: "1.0.0",
          description:
            "MCP server providing access to Meta Marketing API for campaign management, analytics, and audience targeting",
        },
        api_coverage: {
          campaigns: {
            description: "Full campaign lifecycle management",
            operations: [
              "create",
              "read",
              "update",
              "delete",
              "pause",
              "resume",
            ],
            supported_objectives: [
              "OUTCOME_APP_PROMOTION",
              "OUTCOME_AWARENESS",
              "OUTCOME_ENGAGEMENT",
              "OUTCOME_LEADS",
              "OUTCOME_SALES",
              "OUTCOME_TRAFFIC",
            ],
          },
          ad_sets: {
            description: "Ad set management and targeting",
            operations: ["create", "read", "update", "list"],
            targeting_options: [
              "demographics",
              "interests",
              "behaviors",
              "custom_audiences",
              "lookalike_audiences",
              "geographic",
            ],
          },
          ads: {
            description: "Individual ad management",
            operations: ["create", "read", "update", "list"],
            supported_formats: [
              "single_image",
              "carousel",
              "video",
              "collection",
            ],
          },
          insights: {
            description: "Performance analytics and reporting",
            metrics: [
              "impressions",
              "clicks",
              "spend",
              "reach",
              "frequency",
              "ctr",
              "cpc",
              "cpm",
              "conversions",
            ],
            breakdowns: ["age", "gender", "placement", "device", "country"],
            date_ranges: [
              "today",
              "yesterday",
              "last_7d",
              "last_30d",
              "last_90d",
              "custom",
            ],
          },
          audiences: {
            description: "Custom and lookalike audience management",
            types: ["custom", "lookalike", "website", "app", "offline"],
            operations: ["create", "read", "update", "delete", "estimate_size"],
          },
          creatives: {
            description: "Ad creative management and testing",
            operations: ["create", "read", "preview", "ab_test_setup"],
            formats: ["image", "video", "carousel", "collection"],
          },
        },
        tools_available: [
          // Campaign tools
          "list_campaigns",
          "create_campaign",
          "update_campaign",
          "delete_campaign",
          "pause_campaign",
          "resume_campaign",
          "get_campaign",
          // Ad set tools
          "list_ad_sets",
          "create_ad_set",
          // Ad tools
          "list_ads",
          // Analytics tools
          "get_insights",
          "compare_performance",
          "export_insights",
          "get_campaign_performance",
          "get_attribution_data",
          // Audience tools
          "list_audiences",
          "create_custom_audience",
          "create_lookalike_audience",
          "estimate_audience_size",
          // Creative tools
          "list_creatives",
          "create_ad_creative",
          "preview_ad",
          "setup_ab_test",
          // OAuth tools
          "generate_auth_url",
          "exchange_code_for_token",
          "refresh_to_long_lived_token",
          "generate_system_user_token",
          "get_token_info",
          "validate_token",
          // Utility tools
          "get_ad_accounts",
          "health_check",
          "get_capabilities",
        ],
        resources_available: [
          "meta://campaigns/{account_id}",
          "meta://campaign/{campaign_id}",
          "meta://campaign-status/{account_id}",
          "meta://adsets/{campaign_id}",
          "meta://insights/campaign/{campaign_id}",
          "meta://insights/account/{account_id}",
          "meta://insights/compare/{object_ids}",
          "meta://insights/trends/{object_id}/{days}",
          "meta://audiences/{account_id}",
          "meta://audience-performance/{account_id}",
          "meta://targeting-insights/{account_id}",
          "meta://audience-health/{account_id}",
        ],
        rate_limits: {
          development_tier: {
            max_score: 60,
            decay_time: "5 minutes",
            block_time: "5 minutes",
          },
          standard_tier: {
            max_score: 9000,
            decay_time: "5 minutes",
            block_time: "1 minute",
          },
          scoring: {
            read_calls: 1,
            write_calls: 3,
          },
        },
        authentication: {
          required: ["META_ACCESS_TOKEN"],
          optional: ["META_APP_ID", "META_APP_SECRET", "META_BUSINESS_ID", "META_REDIRECT_URI", "META_REFRESH_TOKEN", "META_AUTO_REFRESH"],
          token_validation: "automatic_on_startup",
          oauth_support: {
            authorization_flow: "supported",
            token_refresh: "automatic_with_configuration",
            system_user_tokens: "supported",
            long_lived_tokens: "supported",
          },
        },
      };

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(capabilities, null, 2),
          },
        ],
      };
    });

    console.error("🔗 Connecting to MCP transport...");
    console.error(
      `📊 Server: ${
        process.env.MCP_SERVER_NAME || "Meta Marketing API Server"
      } v${process.env.MCP_SERVER_VERSION || "1.0.0"}`
    );
    console.error(`🔧 Meta API Version: ${auth.getApiVersion()}`);

    // Connect to transport
    console.error("🚀 Attempting server connection...");
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error("✅ Transport connection established");

    console.error("✅ Meta Marketing API MCP Server started successfully");
    console.error("🎯 Ready to receive requests from MCP clients");
    console.error("🔄 Server is now running and listening...");
  } catch (error) {
    console.error("❌ Failed to start Meta Marketing API MCP Server:", error);
    process.exit(1);
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.error("Received SIGINT, shutting down gracefully...");
  process.exit(0);
});

process.on("SIGTERM", () => {
  console.error("Received SIGTERM, shutting down gracefully...");
  process.exit(0);
});

// Handle uncaught errors
process.on("uncaughtException", (error) => {
  console.error("Uncaught Exception:", error);
  process.exit(1);
});

process.on("unhandledRejection", (reason, promise) => {
  console.error("Unhandled Rejection at:", promise, "reason:", reason);
  process.exit(1);
});

// Start the server automatically (this is a CLI tool)
main().catch((error) => {
  console.error("Failed to start server:", error);
  process.exit(1);
});
