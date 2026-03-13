import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MetaApiClient } from "../meta-client.js";
import {
  ListCampaignsSchema,
  CreateCampaignSchema,
  UpdateCampaignSchema,
  DeleteCampaignSchema,
  ListAdSetsSchema,
  CreateAdSetSchema,
} from "../types/mcp-tools.js";

export function registerCampaignTools(
  server: McpServer,
  metaClient: MetaApiClient
) {
  // List Campaigns Tool
  server.tool(
    "list_campaigns",
    ListCampaignsSchema.shape,
    async ({ account_id, status, limit, after }) => {
      try {
        const result = await metaClient.getCampaigns(account_id, {
          status,
          limit,
          after,
        });

        const campaigns = result.data.map((campaign) => ({
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
        }));

        const response = {
          campaigns,
          pagination: {
            has_next_page: result.hasNextPage,
            has_previous_page: result.hasPreviousPage,
            next_cursor: result.paging?.cursors?.after,
            previous_cursor: result.paging?.cursors?.before,
          },
          total_count: campaigns.length,
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
              text: `Error listing campaigns: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Create Campaign Tool
  server.tool(
    "create_campaign",
    CreateCampaignSchema.shape,
    async ({
      account_id,
      name,
      objective,
      status,
      daily_budget,
      lifetime_budget,
      start_time,
      stop_time,
      special_ad_categories,
      bid_strategy,
      bid_cap,
      budget_optimization,
    }) => {
      try {
        if (daily_budget && lifetime_budget) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Cannot set both daily_budget and lifetime_budget. Choose one.",
              },
            ],
            isError: true,
          };
        }

        const campaignData: any = {
          name,
          objective,
          status: status || "PAUSED",
          special_ad_categories: special_ad_categories || [],
          is_adset_budget_sharing_enabled: false,
        };

        if (daily_budget) campaignData.daily_budget = daily_budget;
        if (lifetime_budget) campaignData.lifetime_budget = lifetime_budget;
        if (start_time) campaignData.start_time = start_time;
        if (stop_time) campaignData.stop_time = stop_time;
        if (bid_strategy) campaignData.bid_strategy = bid_strategy;
        if (bid_cap) campaignData.bid_cap = bid_cap;
        if (budget_optimization !== undefined)
          campaignData.is_budget_optimization_enabled = budget_optimization;

        const result = await metaClient.createCampaign(
          account_id,
          campaignData
        );

        const response = {
          success: true,
          campaign_id: result.id,
          message: `Campaign "${name}" created successfully`,
          details: {
            id: result.id,
            name,
            objective,
            status: status || "PAUSED",
            account_id,
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
        return {
          content: [
            {
              type: "text",
              text: `Error creating campaign: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Update Campaign Tool
  server.tool(
    "update_campaign",
    UpdateCampaignSchema.shape,
    async ({
      campaign_id,
      name,
      status,
      daily_budget,
      lifetime_budget,
      start_time,
      stop_time,
    }) => {
      try {
        const updates: Record<string, string | number> = {};

        if (name) updates.name = name;
        if (status) updates.status = status;
        if (daily_budget) updates.daily_budget = daily_budget;
        if (lifetime_budget) updates.lifetime_budget = lifetime_budget;
        if (start_time) updates.start_time = start_time;
        if (stop_time) updates.stop_time = stop_time;

        if (Object.keys(updates).length === 0) {
          return {
            content: [
              {
                type: "text",
                text: "Error: No updates provided. Please specify at least one field to update.",
              },
            ],
            isError: true,
          };
        }

        await metaClient.updateCampaign(campaign_id, updates);

        const response = {
          success: true,
          campaign_id,
          message: `Campaign ${campaign_id} updated successfully`,
          updates_applied: updates,
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
              text: `Error updating campaign: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Pause Campaign Tool
  server.tool(
    "pause_campaign",
    DeleteCampaignSchema.shape,
    async ({ campaign_id }) => {
      try {
        await metaClient.updateCampaign(campaign_id, { status: "PAUSED" });

        const response = {
          success: true,
          campaign_id,
          message: `Campaign ${campaign_id} paused successfully`,
          new_status: "PAUSED",
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
              text: `Error pausing campaign: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Resume Campaign Tool
  server.tool(
    "resume_campaign",
    DeleteCampaignSchema.shape,
    async ({ campaign_id }) => {
      try {
        await metaClient.updateCampaign(campaign_id, { status: "ACTIVE" });

        const response = {
          success: true,
          campaign_id,
          message: `Campaign ${campaign_id} resumed successfully`,
          new_status: "ACTIVE",
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
              text: `Error resuming campaign: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Delete Campaign Tool
  server.tool(
    "delete_campaign",
    DeleteCampaignSchema.shape,
    async ({ campaign_id }) => {
      try {
        await metaClient.deleteCampaign(campaign_id);

        const response = {
          success: true,
          campaign_id,
          message: `Campaign ${campaign_id} deleted successfully`,
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
              text: `Error deleting campaign: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // List Ad Sets Tool
  server.tool(
    "list_ad_sets",
    ListAdSetsSchema.shape,
    async ({ campaign_id, account_id, status, limit, after }) => {
      try {
        if (!campaign_id && !account_id) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Either campaign_id or account_id must be provided",
              },
            ],
            isError: true,
          };
        }

        const result = await metaClient.getAdSets({
          campaignId: campaign_id,
          accountId: account_id,
          status,
          limit,
          after,
        });

        const adSets = result.data.map((adSet) => ({
          id: adSet.id,
          name: adSet.name,
          campaign_id: adSet.campaign_id,
          status: adSet.status,
          effective_status: adSet.effective_status,
          created_time: adSet.created_time,
          updated_time: adSet.updated_time,
          start_time: adSet.start_time,
          end_time: adSet.end_time,
          daily_budget: adSet.daily_budget,
          lifetime_budget: adSet.lifetime_budget,
          bid_amount: adSet.bid_amount,
          billing_event: adSet.billing_event,
          optimization_goal: adSet.optimization_goal,
        }));

        const response = {
          ad_sets: adSets,
          pagination: {
            has_next_page: result.hasNextPage,
            has_previous_page: result.hasPreviousPage,
            next_cursor: result.paging?.cursors?.after,
            previous_cursor: result.paging?.cursors?.before,
          },
          total_count: adSets.length,
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
              text: `Error listing ad sets: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Create Ad Set Tool
  server.tool(
    "create_ad_set",
    CreateAdSetSchema.shape,
    async ({
      campaign_id,
      name,
      daily_budget,
      lifetime_budget,
      optimization_goal,
      billing_event,
      bid_amount,
      start_time,
      end_time,
      targeting,
      status,
      promoted_object,
      attribution_spec,
      destination_type,
      is_dynamic_creative,
      use_new_app_click,
      configured_status,
      optimization_sub_event,
      recurring_budget_semantics,
    }) => {
      try {
        if (daily_budget && lifetime_budget) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Cannot set both daily_budget and lifetime_budget. Choose one.",
              },
            ],
            isError: true,
          };
        }

        if (!daily_budget && !lifetime_budget) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Either daily_budget or lifetime_budget must be provided.",
              },
            ],
            isError: true,
          };
        }

        // Validate optimization_goal and billing_event combination
        const validCombinations = [
          { optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS" },
          { optimization_goal: "LINK_CLICKS", billing_event: "LINK_CLICKS" },
          {
            optimization_goal: "LANDING_PAGE_VIEWS",
            billing_event: "IMPRESSIONS",
          },
          { optimization_goal: "IMPRESSIONS", billing_event: "IMPRESSIONS" },
          { optimization_goal: "REACH", billing_event: "IMPRESSIONS" },
          {
            optimization_goal: "POST_ENGAGEMENT",
            billing_event: "IMPRESSIONS",
          },
          { optimization_goal: "PAGE_LIKES", billing_event: "IMPRESSIONS" },
          { optimization_goal: "PAGE_LIKES", billing_event: "PAGE_LIKES" },
          { optimization_goal: "VIDEO_VIEWS", billing_event: "IMPRESSIONS" },
          { optimization_goal: "VIDEO_VIEWS", billing_event: "VIDEO_VIEWS" },
          { optimization_goal: "CONVERSIONS", billing_event: "IMPRESSIONS" },
          { optimization_goal: "APP_INSTALLS", billing_event: "IMPRESSIONS" },
        ];

        const isValidCombination = validCombinations.some(
          (combo) =>
            combo.optimization_goal === optimization_goal &&
            combo.billing_event === billing_event
        );

        if (!isValidCombination) {
          console.error(
            `Invalid combination: optimization_goal=${optimization_goal}, billing_event=${billing_event}`
          );
          return {
            content: [
              {
                type: "text",
                text:
                  `Error: Invalid optimization_goal (${optimization_goal}) and billing_event (${billing_event}) combination. Common valid combinations include:\n` +
                  `- LINK_CLICKS + IMPRESSIONS\n` +
                  `- LANDING_PAGE_VIEWS + IMPRESSIONS\n` +
                  `- REACH + IMPRESSIONS\n` +
                  `- CONVERSIONS + IMPRESSIONS`,
              },
            ],
            isError: true,
          };
        }

        // Ensure budget is an integer (Meta API expects cents)
        const formatBudget = (budget: number) => Math.round(budget);

        interface AdSetData {
          name: string;
          optimization_goal: string;
          billing_event: string;
          status: string;
          daily_budget?: number;
          lifetime_budget?: number;
          bid_amount?: number;
          start_time?: string;
          end_time?: string;
          targeting?: Record<string, unknown>;
          promoted_object?: {
            page_id?: string;
            pixel_id?: string;
            application_id?: string;
            object_store_url?: string;
            custom_event_type?: string;
          };
          attribution_spec?: Array<{
            event_type: string;
            window_days: number;
          }>;
          destination_type?: string;
          is_dynamic_creative?: boolean;
          use_new_app_click?: boolean;
          configured_status?: string;
          optimization_sub_event?: string;
          recurring_budget_semantics?: boolean;
        }

        const adSetData: AdSetData = {
          name,
          optimization_goal,
          billing_event,
          status: status || "PAUSED",
        };

        // Add budgets
        if (daily_budget) {
          adSetData.daily_budget = formatBudget(daily_budget);
        }
        if (lifetime_budget) {
          adSetData.lifetime_budget = formatBudget(lifetime_budget);
          // Lifetime budget requires start_time and end_time
          if (!start_time || !end_time) {
            const now = new Date();
            const endDate = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000); // 7 days from now
            adSetData.start_time = start_time || now.toISOString();
            adSetData.end_time = end_time || endDate.toISOString();
          }
        }

        if (bid_amount) adSetData.bid_amount = bid_amount;
        if (start_time) adSetData.start_time = start_time;
        if (end_time) adSetData.end_time = end_time;

        // Set initial targeting
        if (targeting) {
          adSetData.targeting = targeting;
        }

        // Handle promoted_object - check if it's required for this campaign
        let campaign;
        try {
          campaign = await metaClient.getCampaign(campaign_id);
        } catch (error) {
          console.error("Failed to fetch campaign details:", error);
          return {
            content: [
              {
                type: "text",
                text: `Error: Unable to fetch campaign details for campaign_id ${campaign_id}. Please verify the campaign exists and you have permission to access it.`,
              },
            ],
            isError: true,
          };
        }

        // Enhanced validation for promoted_object based on campaign objective
        const requiresPromotedObject = [
          "OUTCOME_TRAFFIC",
          "OUTCOME_ENGAGEMENT",
          "OUTCOME_APP_PROMOTION",
          "OUTCOME_LEADS",
          "OUTCOME_SALES",
        ].includes(campaign.objective);

        if (requiresPromotedObject && !promoted_object) {
          console.error(
            `Campaign objective ${campaign.objective} requires promoted_object`
          );

          let objectiveHelp = "";
          switch (campaign.objective) {
            case "OUTCOME_TRAFFIC":
              objectiveHelp = `For OUTCOME_TRAFFIC campaigns, provide:\n- page_id: Facebook Page ID to drive traffic to\n- pixel_id: Facebook Pixel ID for website tracking`;
              break;
            case "OUTCOME_ENGAGEMENT":
              objectiveHelp = `For OUTCOME_ENGAGEMENT campaigns, provide:\n- page_id: Facebook Page ID to promote`;
              break;
            case "OUTCOME_APP_PROMOTION":
              objectiveHelp = `For OUTCOME_APP_PROMOTION campaigns, provide:\n- application_id: App ID to promote\n- object_store_url: App store URL`;
              break;
            case "OUTCOME_LEADS":
            case "OUTCOME_SALES":
              objectiveHelp = `For ${campaign.objective} campaigns, provide:\n- pixel_id: Facebook Pixel ID for conversion tracking\n- custom_event_type: Custom conversion event type`;
              break;
          }

          return {
            content: [
              {
                type: "text",
                text: `Error: Campaign with objective "${campaign.objective}" requires a promoted_object parameter.\n\n${objectiveHelp}\n\nExample: {"promoted_object": {"page_id": "your_page_id"}}`,
              },
            ],
            isError: true,
          };
        }

        if (promoted_object) {
          adSetData.promoted_object = promoted_object;
        }

        // Add required Meta API fields with defaults and validation
        adSetData.attribution_spec = attribution_spec || [
          { event_type: "CLICK_THROUGH", window_days: 1 },
        ];

        // Set destination_type - use "UNDEFINED" as default per working SDK example
        adSetData.destination_type = destination_type || "UNDEFINED";

        adSetData.is_dynamic_creative = is_dynamic_creative ?? false;
        adSetData.use_new_app_click = use_new_app_click ?? false;

        // Add the critical missing fields from GitHub issue #162
        adSetData.configured_status = configured_status || status || "PAUSED";
        adSetData.optimization_sub_event = optimization_sub_event || "NONE";
        adSetData.recurring_budget_semantics =
          recurring_budget_semantics ?? false;

        // Validate attribution_spec format
        if (
          adSetData.attribution_spec &&
          Array.isArray(adSetData.attribution_spec)
        ) {
          adSetData.attribution_spec = adSetData.attribution_spec.map(
            (spec) => ({
              event_type: spec.event_type || "CLICK_THROUGH",
              window_days: spec.window_days || 1,
            })
          );
        }

        // Ensure targeting has required fields
        if (adSetData.targeting) {
          if (!adSetData.targeting.targeting_optimization) {
            adSetData.targeting.targeting_optimization = "none";
          }
          if (!adSetData.targeting.brand_safety_content_filter_levels) {
            adSetData.targeting.brand_safety_content_filter_levels = [
              "FACEBOOK_STANDARD",
            ];
          }
          if (
            adSetData.targeting.geo_locations &&
            !(adSetData.targeting.geo_locations as any).location_types
          ) {
            (adSetData.targeting.geo_locations as any).location_types = [
              "home",
              "recent",
            ];
          }
        } else {
          // Provide complete default targeting with all required fields per GitHub issue #162
          adSetData.targeting = {
            age_min: 18,
            age_max: 65,
            geo_locations: {
              countries: ["US"],
              location_types: ["home", "recent"],
            },
            targeting_optimization: "none",
            brand_safety_content_filter_levels: ["FACEBOOK_STANDARD"],
          };
        }

        // Ensure age fields are set even when targeting is provided
        if (adSetData.targeting && typeof adSetData.targeting === "object") {
          if (!(adSetData.targeting as any).age_min) {
            (adSetData.targeting as any).age_min = 18;
          }
          if (!(adSetData.targeting as any).age_max) {
            (adSetData.targeting as any).age_max = 65;
          }
        }

        // Log the request for debugging
        console.error(
          "Creating ad set with data:",
          JSON.stringify(adSetData, null, 2)
        );
        console.error("For campaign ID:", campaign_id);
        console.error("Campaign objective:", campaign.objective);

        const result = await metaClient.createAdSet(campaign_id, adSetData);

        const response = {
          success: true,
          ad_set_id: result.id,
          message: `Ad set "${name}" created successfully`,
          details: {
            id: result.id,
            name,
            campaign_id,
            optimization_goal,
            billing_event,
            status: status || "PAUSED",
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
        // Enhanced error handling for Meta API errors
        console.error("=== AD SET CREATION TOOL ERROR ===");
        console.error("Error object:", error);

        let errorMessage = "Unknown error occurred";
        let errorDetails = "";
        let specificErrorInfo = "";

        if (error instanceof Error) {
          errorMessage = error.message;
          console.error("Error message:", error.message);

          // Try to parse Meta API error details if available
          try {
            const errorObj = JSON.parse(error.message);
            console.error(
              "Parsed error object:",
              JSON.stringify(errorObj, null, 2)
            );

            if (errorObj.error) {
              errorMessage = errorObj.error.message || errorMessage;
              errorDetails =
                errorObj.error.error_user_title ||
                errorObj.error.error_user_msg ||
                "";

              // Log detailed error information for debugging
              console.error("Meta API Error Details:", {
                message: errorObj.error.message,
                code: errorObj.error.code,
                error_subcode: errorObj.error.error_subcode,
                fbtrace_id: errorObj.error.fbtrace_id,
                type: errorObj.error.type,
                error_data: errorObj.error.error_data,
              });

              // Provide specific guidance based on error codes
              if (errorObj.error.code === 100) {
                specificErrorInfo =
                  "\n\nThis is usually caused by missing required fields or invalid field values.";

                if (errorObj.error.error_data) {
                  specificErrorInfo += `\nError data: ${JSON.stringify(
                    errorObj.error.error_data
                  )}`;
                }
              } else if (errorObj.error.code === 190) {
                specificErrorInfo =
                  "\n\nThis indicates an access token issue. Please check your authentication.";
              } else if (errorObj.error.code === 200) {
                specificErrorInfo =
                  "\n\nThis indicates insufficient permissions for the operation.";
              }
            }
          } catch (parseError) {
            // Error message is not JSON, use as is
            console.error("Raw error message (not JSON):", error.message);
          }
        }

        console.error("================================");

        const fullErrorMessage = errorDetails
          ? `${errorMessage}\n\nAdditional details: ${errorDetails}${specificErrorInfo}`
          : `${errorMessage}${specificErrorInfo}`;

        return {
          content: [
            {
              type: "text",
              text: `Error creating ad set: ${fullErrorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // List Ads Tool
  server.tool(
    "list_ads",
    ListAdSetsSchema.shape,
    async ({ campaign_id, account_id, status, limit, after }) => {
      try {
        if (!campaign_id && !account_id) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Either campaign_id or account_id must be provided",
              },
            ],
            isError: true,
          };
        }

        const result = await metaClient.getAds({
          campaignId: campaign_id,
          accountId: account_id,
          status,
          limit,
          after,
        });

        const ads = result.data.map((ad) => ({
          id: ad.id,
          name: ad.name,
          adset_id: ad.adset_id,
          campaign_id: ad.campaign_id,
          status: ad.status,
          effective_status: ad.effective_status,
          created_time: ad.created_time,
          updated_time: ad.updated_time,
          creative: ad.creative,
        }));

        const response = {
          ads,
          pagination: {
            has_next_page: result.hasNextPage,
            has_previous_page: result.hasPreviousPage,
            next_cursor: result.paging?.cursors?.after,
            previous_cursor: result.paging?.cursors?.before,
          },
          total_count: ads.length,
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
              text: `Error listing ads: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Get Campaign Details Tool
  server.tool(
    "get_campaign",
    DeleteCampaignSchema.shape,
    async ({ campaign_id }) => {
      try {
        const campaign = await metaClient.getCampaign(campaign_id);

        const response = {
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
              text: `Error getting campaign details: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );
}
