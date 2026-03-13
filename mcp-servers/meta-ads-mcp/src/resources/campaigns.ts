import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { MetaApiClient } from "../meta-client.js";

export function registerCampaignResources(
  server: McpServer,
  metaClient: MetaApiClient
) {
  // Campaign Data Resource
  server.resource(
    "campaigns",
    new ResourceTemplate("meta://campaigns/{account_id}", { list: undefined }),
    async (uri, { account_id }) => {
      try {
        const result = await metaClient.getCampaigns(account_id as string, {
          limit: 100,
          fields: [
            "id",
            "name",
            "objective",
            "status",
            "effective_status",
            "created_time",
            "updated_time",
            "daily_budget",
            "lifetime_budget",
            "budget_remaining",
          ],
        });

        const campaignSummary = {
          account_id,
          total_campaigns: result.data.length,
          active_campaigns: result.data.filter((c) => c.status === "ACTIVE")
            .length,
          paused_campaigns: result.data.filter((c) => c.status === "PAUSED")
            .length,
          campaigns: result.data.map((campaign) => ({
            id: campaign.id,
            name: campaign.name,
            objective: campaign.objective,
            status: campaign.status,
            effective_status: campaign.effective_status,
            created_time: campaign.created_time,
            daily_budget: campaign.daily_budget,
            lifetime_budget: campaign.lifetime_budget,
            budget_remaining: campaign.budget_remaining,
          })),
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(campaignSummary, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  error: "Failed to fetch campaign data",
                  message: errorMessage,
                  account_id,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // Individual Campaign Resource
  server.resource(
    "campaign-details",
    new ResourceTemplate("meta://campaign/{campaign_id}", { list: undefined }),
    async (uri, { campaign_id }) => {
      try {
        const [campaign, adSets] = await Promise.all([
          metaClient.getCampaign(campaign_id as string),
          metaClient.getAdSets({
            campaignId: campaign_id as string,
            limit: 50,
          }),
        ]);

        const campaignDetails = {
          campaign: {
            id: campaign.id,
            name: campaign.name,
            objective: campaign.objective,
            status: campaign.status,
            effective_status: campaign.effective_status,
            created_time: campaign.created_time,
            updated_time: campaign.updated_time,
            start_time: campaign.start_time,
            stop_time: campaign.stop_time,
            daily_budget: campaign.daily_budget,
            lifetime_budget: campaign.lifetime_budget,
            budget_remaining: campaign.budget_remaining,
            account_id: campaign.account_id,
          },
          ad_sets: {
            total_count: adSets.data.length,
            active_count: adSets.data.filter((as) => as.status === "ACTIVE")
              .length,
            paused_count: adSets.data.filter((as) => as.status === "PAUSED")
              .length,
            list: adSets.data.map((adSet) => ({
              id: adSet.id,
              name: adSet.name,
              status: adSet.status,
              effective_status: adSet.effective_status,
              daily_budget: adSet.daily_budget,
              lifetime_budget: adSet.lifetime_budget,
              optimization_goal: adSet.optimization_goal,
              billing_event: adSet.billing_event,
            })),
          },
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(campaignDetails, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  error: "Failed to fetch campaign details",
                  message: errorMessage,
                  campaign_id,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // Campaign Status Overview Resource
  server.resource(
    "campaign-status",
    new ResourceTemplate("meta://campaign-status/{account_id}", {
      list: undefined,
    }),
    async (uri, { account_id }) => {
      try {
        const result = await metaClient.getCampaigns(account_id as string, {
          limit: 200,
          fields: [
            "id",
            "name",
            "status",
            "effective_status",
            "objective",
            "daily_budget",
            "lifetime_budget",
          ],
        });

        const statusBreakdown = result.data.reduce((acc, campaign) => {
          const status = campaign.effective_status || campaign.status;
          if (!acc[status]) {
            acc[status] = {
              count: 0,
              campaigns: [],
              total_daily_budget: 0,
              total_lifetime_budget: 0,
            };
          }
          acc[status].count++;
          acc[status].campaigns.push({
            id: campaign.id,
            name: campaign.name,
            objective: campaign.objective,
          });

          if (campaign.daily_budget) {
            acc[status].total_daily_budget += parseFloat(campaign.daily_budget);
          }
          if (campaign.lifetime_budget) {
            acc[status].total_lifetime_budget += parseFloat(
              campaign.lifetime_budget
            );
          }

          return acc;
        }, {} as any);

        const overview = {
          account_id,
          total_campaigns: result.data.length,
          status_breakdown: statusBreakdown,
          objectives_breakdown: result.data.reduce((acc, campaign) => {
            acc[campaign.objective] = (acc[campaign.objective] || 0) + 1;
            return acc;
          }, {} as any),
          budget_summary: {
            total_daily_budget: result.data.reduce(
              (sum, c) => sum + parseFloat(c.daily_budget || "0"),
              0
            ),
            total_lifetime_budget: result.data.reduce(
              (sum, c) => sum + parseFloat(c.lifetime_budget || "0"),
              0
            ),
          },
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(overview, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  error: "Failed to fetch campaign status overview",
                  message: errorMessage,
                  account_id,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );

  // Ad Sets Resource
  server.resource(
    "adsets",
    new ResourceTemplate("meta://adsets/{campaign_id}", { list: undefined }),
    async (uri, { campaign_id }) => {
      try {
        const result = await metaClient.getAdSets({
          campaignId: campaign_id as string,
          limit: 100,
          fields: [
            "id",
            "name",
            "status",
            "effective_status",
            "daily_budget",
            "lifetime_budget",
            "optimization_goal",
            "billing_event",
            "targeting",
          ],
        });

        const adSetSummary = {
          campaign_id,
          total_ad_sets: result.data.length,
          active_ad_sets: result.data.filter((as) => as.status === "ACTIVE")
            .length,
          paused_ad_sets: result.data.filter((as) => as.status === "PAUSED")
            .length,
          ad_sets: result.data.map((adSet) => ({
            id: adSet.id,
            name: adSet.name,
            status: adSet.status,
            effective_status: adSet.effective_status,
            daily_budget: adSet.daily_budget,
            lifetime_budget: adSet.lifetime_budget,
            optimization_goal: adSet.optimization_goal,
            billing_event: adSet.billing_event,
            targeting_summary: adSet.targeting
              ? {
                  age_range:
                    adSet.targeting.age_min && adSet.targeting.age_max
                      ? `${adSet.targeting.age_min}-${adSet.targeting.age_max}`
                      : "Not specified",
                  genders: adSet.targeting.genders || "All",
                  locations:
                    adSet.targeting.geo_locations?.countries?.length || 0,
                  interests: adSet.targeting.interests?.length || 0,
                  behaviors: adSet.targeting.behaviors?.length || 0,
                }
              : null,
          })),
          budget_breakdown: {
            total_daily_budget: result.data.reduce(
              (sum, as) => sum + parseFloat(as.daily_budget || "0"),
              0
            ),
            total_lifetime_budget: result.data.reduce(
              (sum, as) => sum + parseFloat(as.lifetime_budget || "0"),
              0
            ),
          },
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(adSetSummary, null, 2),
            },
          ],
        };
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : "Unknown error occurred";
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(
                {
                  error: "Failed to fetch ad set data",
                  message: errorMessage,
                  campaign_id,
                },
                null,
                2
              ),
            },
          ],
        };
      }
    }
  );
}
