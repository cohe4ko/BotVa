#!/usr/bin/env node

/**
 * Example MCP Client for Meta Marketing API Server
 *
 * This example demonstrates how to create a simple MCP client that connects
 * to the Meta Marketing API server and performs common operations.
 *
 * Usage: npx tsx client-example.ts
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import {
  CallToolResultSchema,
  ListToolsResultSchema,
} from "@modelcontextprotocol/sdk/types.js";

class MetaAdsClient {
  private client?: Client;
  private transport?: StdioClientTransport;

  async connect(): Promise<void> {
    console.log("Connecting to Meta Marketing API MCP Server...");

    // Create transport - adjust the command based on your setup
    this.transport = new StdioClientTransport({
      command: "npx",
      args: ["meta-ads-mcp"], // or path to your built server
    });

    // Create client
    this.client = new Client(
      {
        name: "meta-ads-example-client",
        version: "1.0.0",
      },
      {
        capabilities: {},
      }
    );

    // Connect
    await this.client.connect(this.transport);
    console.log("✅ Connected to Meta Marketing API MCP Server");
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      await this.client.close();
    }
    console.log("Disconnected from Meta Marketing API MCP Server");
  }

  async listAvailableTools(): Promise<void> {
    if (!this.client) throw new Error("Client not connected");

    console.log("\n📋 Available Tools:");
    const response = await this.client.request(
      { method: "tools/list" },
      ListToolsResultSchema
    );

    response.tools.forEach((tool, index) => {
      console.log(`${index + 1}. ${tool.name}`);
      if (tool.description) {
        console.log(`   ${tool.description}`);
      }
    });
  }

  async checkServerHealth(): Promise<void> {
    if (!this.client) throw new Error("Client not connected");

    console.log("\n🏥 Checking Server Health...");
    const result = await this.client.request(
      {
        method: "tools/call",
        params: {
          name: "health_check",
          arguments: {},
        },
      },
      CallToolResultSchema
    );

    const healthData = JSON.parse(result.content[0].text);
    console.log(`Status: ${healthData.status}`);
    console.log(`Server: ${healthData.server_name} v${healthData.version}`);
    console.log(`Meta API Connection: ${healthData.meta_api_connection}`);
    console.log(`Accessible Accounts: ${healthData.accessible_accounts}`);
  }

  async getAdAccounts(): Promise<any[]> {
    if (!this.client) throw new Error("Client not connected");

    console.log("\n🏢 Getting Ad Accounts...");
    const result = await this.client.request(
      {
        method: "tools/call",
        params: {
          name: "get_ad_accounts",
          arguments: {},
        },
      },
      CallToolResultSchema
    );

    const response = JSON.parse(result.content[0].text);
    if (response.success) {
      console.log(`Found ${response.total_accounts} ad accounts:`);
      response.accounts.forEach((account: any, index: number) => {
        console.log(`${index + 1}. ${account.name} (${account.id})`);
        console.log(
          `   Currency: ${account.currency}, Status: ${account.account_status}`
        );
      });
      return response.accounts;
    } else {
      throw new Error("Failed to get ad accounts");
    }
  }

  async getCampaigns(accountId: string): Promise<any[]> {
    if (!this.client) throw new Error("Client not connected");

    console.log(`\n📊 Getting Campaigns for Account ${accountId}...`);
    const result = await this.client.request(
      {
        method: "tools/call",
        params: {
          name: "list_campaigns",
          arguments: {
            account_id: accountId,
            limit: 10,
          },
        },
      },
      CallToolResultSchema
    );

    const response = JSON.parse(result.content[0].text);
    if (response.campaigns) {
      console.log(`Found ${response.total_count} campaigns:`);
      response.campaigns.forEach((campaign: any, index: number) => {
        console.log(`${index + 1}. ${campaign.name} (${campaign.id})`);
        console.log(
          `   Objective: ${campaign.objective}, Status: ${campaign.status}`
        );
        if (campaign.daily_budget) {
          console.log(
            `   Daily Budget: $${(
              parseInt(campaign.daily_budget) / 100
            ).toFixed(2)}`
          );
        }
      });
      return response.campaigns;
    } else {
      console.log("No campaigns found or error occurred");
      return [];
    }
  }

  async getCampaignPerformance(campaignId: string): Promise<void> {
    if (!this.client) throw new Error("Client not connected");

    console.log(`\n📈 Getting Performance for Campaign ${campaignId}...`);
    const result = await this.client.request(
      {
        method: "tools/call",
        params: {
          name: "get_campaign_performance",
          arguments: {
            object_id: campaignId,
            level: "campaign",
            date_preset: "last_7d",
          },
        },
      },
      CallToolResultSchema
    );

    const response = JSON.parse(result.content[0].text);
    if (response.campaign && response.performance) {
      console.log(`Campaign: ${response.campaign.name}`);
      console.log(`Objective: ${response.campaign.objective}`);
      console.log(`Status: ${response.campaign.status}`);
      console.log("\nLast 7 Days Performance:");
      console.log(
        `  Impressions: ${
          response.performance.total_impressions?.toLocaleString() || "N/A"
        }`
      );
      console.log(
        `  Clicks: ${
          response.performance.total_clicks?.toLocaleString() || "N/A"
        }`
      );
      console.log(
        `  Spend: $${response.performance.total_spend?.toFixed(2) || "N/A"}`
      );
      console.log(
        `  CTR: ${response.performance.average_ctr?.toFixed(2) || "N/A"}%`
      );
      console.log(
        `  CPC: $${response.performance.average_cpc?.toFixed(2) || "N/A"}`
      );
    } else {
      console.log("No performance data available or error occurred");
    }
  }

  async createTestCampaign(accountId: string): Promise<string | null> {
    if (!this.client) throw new Error("Client not connected");

    console.log(`\n🚀 Creating Test Campaign for Account ${accountId}...`);

    const campaignName = `Test Campaign - ${
      new Date().toISOString().split("T")[0]
    }`;

    try {
      const result = await this.client.request(
        {
          method: "tools/call",
          params: {
            name: "create_campaign",
            arguments: {
              account_id: accountId,
              name: campaignName,
              objective: "OUTCOME_TRAFFIC",
              status: "PAUSED",
              daily_budget: 1000, // $10.00 in cents
            },
          },
        },
        CallToolResultSchema
      );

      const response = JSON.parse(result.content[0].text);
      if (response.success) {
        console.log(`✅ Created campaign: ${response.campaign_id}`);
        console.log(`   Name: ${campaignName}`);
        console.log(`   Status: PAUSED (ready for setup)`);
        return response.campaign_id;
      } else {
        console.log("❌ Failed to create campaign");
        return null;
      }
    } catch (error) {
      console.log(`❌ Error creating campaign: ${error}`);
      return null;
    }
  }

  async getAudiences(accountId: string): Promise<void> {
    if (!this.client) throw new Error("Client not connected");

    console.log(`\n👥 Getting Audiences for Account ${accountId}...`);
    const result = await this.client.request(
      {
        method: "tools/call",
        params: {
          name: "list_audiences",
          arguments: {
            account_id: accountId,
            limit: 10,
          },
        },
      },
      CallToolResultSchema
    );

    const response = JSON.parse(result.content[0].text);
    if (response.audiences) {
      console.log(`Found ${response.total_count} audiences:`);
      response.audiences.forEach((audience: any, index: number) => {
        console.log(`${index + 1}. ${audience.name} (${audience.id})`);
        console.log(
          `   Type: ${audience.type}, Size: ${
            audience.approximate_count?.toLocaleString() || "N/A"
          }`
        );
      });
    } else {
      console.log("No audiences found or error occurred");
    }
  }

  async demonstrateResourceAccess(accountId: string): Promise<void> {
    if (!this.client) throw new Error("Client not connected");

    console.log(`\n📚 Accessing Campaign Resource for Account ${accountId}...`);

    try {
      const result = await this.client.request(
        {
          method: "resources/read",
          params: {
            uri: `meta://campaigns/${accountId}`,
          },
        },
        { type: "object" } // Generic schema for resource response
      );

      if (result.contents && result.contents.length > 0) {
        const resourceData = JSON.parse(result.contents[0].text);
        console.log(`✅ Resource Data Retrieved:`);
        console.log(`   Total Campaigns: ${resourceData.total_campaigns}`);
        console.log(`   Active Campaigns: ${resourceData.active_campaigns}`);
        console.log(`   Paused Campaigns: ${resourceData.paused_campaigns}`);
        console.log(`   Last Updated: ${resourceData.last_updated}`);
      }
    } catch (error) {
      console.log(`❌ Error accessing resource: ${error}`);
    }
  }
}

// Example usage
async function runExample() {
  const client = new MetaAdsClient();

  try {
    // Connect to the server
    await client.connect();

    // Check server health
    await client.checkServerHealth();

    // List available tools
    await client.listAvailableTools();

    // Get ad accounts
    const accounts = await client.getAdAccounts();

    if (accounts.length === 0) {
      console.log(
        "\n❌ No ad accounts found. Please check your Meta access token and permissions."
      );
      return;
    }

    // Use the first account for demonstration
    const accountId = accounts[0].id;
    console.log(`\n🎯 Using account: ${accounts[0].name} (${accountId})`);

    // Get campaigns
    const campaigns = await client.getCampaigns(accountId);

    // Get campaign performance if campaigns exist
    if (campaigns.length > 0) {
      await client.getCampaignPerformance(campaigns[0].id);
    }

    // Get audiences
    await client.getAudiences(accountId);

    // Demonstrate resource access
    await client.demonstrateResourceAccess(accountId);

    // Optionally create a test campaign (uncomment to try)
    // const newCampaignId = await client.createTestCampaign(accountId);
    // if (newCampaignId) {
    //   console.log(`\nTest campaign created with ID: ${newCampaignId}`);
    // }

    console.log("\n✅ Example completed successfully!");
  } catch (error) {
    console.error("❌ Example failed:", error);
  } finally {
    await client.disconnect();
  }
}

// Handle graceful shutdown
process.on("SIGINT", () => {
  console.log("\nReceived SIGINT, shutting down gracefully...");
  process.exit(0);
});

// Run the example
if (import.meta.url === `file://${process.argv[1]}`) {
  runExample().catch((error) => {
    console.error("Failed to run example:", error);
    process.exit(1);
  });
}

export { MetaAdsClient };
