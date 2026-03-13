import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MetaApiClient } from "../meta-client.js";
import {
  ListCreativesSchema,
  CreateAdCreativeSchema,
  PreviewAdSchema,
} from "../types/mcp-tools.js";

export function registerCreativeTools(
  server: McpServer,
  metaClient: MetaApiClient
) {
  // List Creatives Tool
  server.tool(
    "list_creatives",
    ListCreativesSchema.shape,
    async ({ account_id, limit, after }) => {
      try {
        const result = await metaClient.getAdCreatives(account_id, {
          limit,
          after,
        });

        const creatives = result.data.map((creative) => ({
          id: creative.id,
          name: creative.name,
          title: creative.title,
          body: creative.body,
          image_url: creative.image_url,
          video_id: creative.video_id,
          call_to_action: creative.call_to_action,
          object_story_spec: creative.object_story_spec,
          url_tags: creative.url_tags,
        }));

        const response = {
          creatives,
          pagination: {
            has_next_page: result.hasNextPage,
            has_previous_page: result.hasPreviousPage,
            next_cursor: result.paging?.cursors?.after,
            previous_cursor: result.paging?.cursors?.before,
          },
          total_count: creatives.length,
          account_id,
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
              text: `Error listing creatives: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Create Ad Creative Tool
  server.tool(
    "create_ad_creative",
    CreateAdCreativeSchema.shape,
    async ({
      account_id,
      name,
      title,
      body,
      image_url,
      video_id,
      call_to_action,
      link_url,
      display_link,
    }) => {
      try {
        const creativeData: any = {
          name,
        };

        if (title) creativeData.title = title;
        if (body) creativeData.body = body;
        if (image_url) creativeData.image_url = image_url;
        if (video_id) creativeData.video_id = video_id;
        if (call_to_action) creativeData.call_to_action = call_to_action;
        if (link_url) creativeData.link_url = link_url;
        if (display_link) creativeData.display_link = display_link;

        // Validate that we have either an image or video
        if (!image_url && !video_id) {
          return {
            content: [
              {
                type: "text",
                text: "Error: Either image_url or video_id must be provided for the creative",
              },
            ],
            isError: true,
          };
        }

        const result = await metaClient.createAdCreative(
          account_id,
          creativeData
        );

        const response = {
          success: true,
          creative_id: result.id,
          message: `Ad creative "${name}" created successfully`,
          details: {
            id: result.id,
            name,
            title,
            body,
            image_url,
            video_id,
            call_to_action,
            link_url,
            account_id,
          },
          next_steps: [
            "Use this creative in ad creation",
            "Preview the creative across different placements",
            "Test different variations for A/B testing",
          ],
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
              text: `Error creating ad creative: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Preview Ad Tool
  server.tool(
    "preview_ad",
    PreviewAdSchema.shape,
    async ({ creative_id, ad_format, product_item_ids }) => {
      try {
        const result = await metaClient.generateAdPreview(
          creative_id,
          ad_format,
          product_item_ids
        );

        const response = {
          success: true,
          creative_id,
          ad_format,
          preview_html: result.body,
          product_item_ids,
          notes: [
            "The preview shows how the ad will appear in the selected format",
            "Different placements may render the creative differently",
            "Test across multiple formats to ensure optimal display",
          ],
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
              text: `Error generating ad preview: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Upload Creative Asset Tool (simplified - would need actual file upload)
  server.tool(
    "upload_creative_asset",
    CreateAdCreativeSchema.shape,
    async ({ account_id, name }) => {
      try {
        const response = {
          message: "Creative asset upload process",
          account_id,
          asset_name: name,
          upload_steps: [
            "1. Use Meta Business Manager to upload images/videos",
            "2. Get the asset URL or video ID",
            "3. Use create_ad_creative with the asset URL/ID",
            "4. Preview the creative before using in ads",
          ],
          supported_formats: {
            images: ["JPG", "PNG", "GIF"],
            videos: ["MP4", "MOV", "AVI"],
            requirements: {
              image_max_size: "30MB",
              video_max_size: "4GB",
              image_min_resolution: "600x600px",
              video_min_resolution: "720p",
            },
          },
          api_endpoints: {
            image_upload: "Use Graph API /adimages endpoint",
            video_upload: "Use Graph API /advideos endpoint",
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
              text: `Error with asset upload process: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Setup A/B Test Tool
  server.tool(
    "setup_ab_test",
    CreateAdCreativeSchema.shape,
    async ({ account_id, name }) => {
      try {
        const response = {
          message: "A/B testing setup for creatives",
          test_name: name,
          account_id,
          test_setup_steps: [
            "1. Create multiple creative variations",
            "2. Set up identical ad sets with different creatives",
            "3. Use the same targeting and budget for each variation",
            "4. Run the test for at least 3-7 days",
            "5. Analyze performance metrics to determine winner",
          ],
          recommended_test_variables: [
            "Headlines and ad copy",
            "Images or videos",
            "Call-to-action buttons",
            "Ad formats (single image vs carousel)",
            "Color schemes and visual elements",
          ],
          testing_best_practices: [
            "Test one variable at a time for clear results",
            "Ensure statistical significance before declaring a winner",
            "Account for day-of-week and time-of-day variations",
            "Use Facebook's built-in A/B testing tools when possible",
          ],
          metrics_to_track: [
            "Click-through rate (CTR)",
            "Cost per click (CPC)",
            "Conversion rate",
            "Cost per conversion",
            "Relevance score",
          ],
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
              text: `Error setting up A/B test: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Get Creative Performance Tool
  server.tool(
    "get_creative_performance",
    PreviewAdSchema.shape,
    async ({ creative_id }) => {
      try {
        // This would typically fetch insights for ads using this creative
        // For now, we'll provide a structure showing what performance data is available

        const response = {
          creative_id,
          performance_note:
            "Creative performance requires analyzing ads that use this creative",
          recommended_approach: [
            "1. Find ads using this creative with list_ads tool",
            "2. Get insights for those ads using get_insights tool",
            "3. Compare performance across different placements",
            "4. Analyze engagement metrics specific to the creative",
          ],
          key_metrics_to_analyze: [
            "Click-through rate (CTR) - indicates creative appeal",
            "Cost per click (CPC) - shows efficiency",
            "Engagement rate - measures audience interaction",
            "Conversion rate - tracks business impact",
            "Frequency - monitors ad fatigue",
          ],
          creative_optimization_tips: [
            "Monitor frequency to avoid ad fatigue",
            "Test different call-to-action buttons",
            "Analyze performance by placement",
            "Consider seasonal or trending content",
            "Use dynamic creative optimization when possible",
          ],
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
              text: `Error getting creative performance: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Update Creative Tool
  server.tool(
    "update_creative",
    CreateAdCreativeSchema.shape,
    async (_params) => {
      // Note: These variables would be used in actual implementation
      // const { name, title, body } = _params;
      try {
        const response = {
          message: "Creative update limitations",
          important_note:
            "Ad creatives cannot be modified once created in Meta's system",
          explanation:
            "This is by design to maintain ad performance data integrity",
          recommended_approach: [
            "1. Create a new creative with the desired changes",
            "2. Update existing ads to use the new creative",
            "3. Archive the old creative if no longer needed",
            "4. Compare performance between old and new creatives",
          ],
          updatable_elements: {
            ad_level: [
              "Link URL (in ad, not creative)",
              "Headline (in ad copy, not creative)",
              "Description (in ad copy, not creative)",
            ],
            campaign_level: [
              "Budget and schedule",
              "Targeting parameters",
              "Optimization goals",
            ],
          },
          creative_versioning_tip:
            "Use descriptive naming conventions to track creative versions",
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
              text: `Error updating creative: ${errorMessage}`,
            },
          ],
          isError: true,
        };
      }
    }
  );

  // Delete Creative Tool
  server.tool("delete_creative", PreviewAdSchema.shape, async (params) => {
    const { creative_id } = params;
    try {
      // Note: This would require actual deletion logic
      const response = {
        creative_id,
        warning: "Deleting a creative will affect all ads using it",
        pre_deletion_checks: [
          "Verify no active ads are using this creative",
          "Consider pausing ads instead of deleting creative",
          "Export performance data before deletion",
          "Archive creative for future reference",
        ],
        deletion_impact: [
          "All ads using this creative will stop serving",
          "Historical performance data will be preserved",
          "Creative cannot be recovered once deleted",
          "Campaign performance may be affected",
        ],
        safer_alternatives: [
          "Pause ads using the creative instead",
          "Create new creatives and migrate ads",
          "Use creative archiving for organization",
        ],
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
            text: `Error deleting creative: ${errorMessage}`,
          },
        ],
        isError: true,
      };
    }
  });
}
