import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { MetaApiClient } from "../meta-client.js";

export function registerInsightsResources(
  server: McpServer,
  metaClient: MetaApiClient
) {
  // Campaign Performance Resource
  server.resource(
    "campaign-performance",
    new ResourceTemplate("meta://insights/campaign/{campaign_id}", {
      list: undefined,
    }),
    async (uri, { campaign_id }) => {
      try {
        const [insights7d, insights30d, insights90d] = await Promise.all([
          metaClient.getInsights(campaign_id as string, {
            level: "campaign",
            date_preset: "last_7d",
            fields: [
              "impressions",
              "clicks",
              "spend",
              "reach",
              "frequency",
              "ctr",
              "cpc",
              "cpm",
              "actions",
              "cost_per_action_type",
            ],
          }),
          metaClient.getInsights(campaign_id as string, {
            level: "campaign",
            date_preset: "last_30d",
            fields: [
              "impressions",
              "clicks",
              "spend",
              "reach",
              "frequency",
              "ctr",
              "cpc",
              "cpm",
              "actions",
              "cost_per_action_type",
            ],
          }),
          metaClient.getInsights(campaign_id as string, {
            level: "campaign",
            date_preset: "last_90d",
            fields: [
              "impressions",
              "clicks",
              "spend",
              "reach",
              "frequency",
              "ctr",
              "cpc",
              "cpm",
              "actions",
              "cost_per_action_type",
            ],
          }),
        ]);

        const calculateMetrics = (data: any[]) => {
          if (!data || data.length === 0) return null;

          const totals = data.reduce(
            (acc, insight) => {
              acc.impressions += parseFloat(insight.impressions || "0");
              acc.clicks += parseFloat(insight.clicks || "0");
              acc.spend += parseFloat(insight.spend || "0");
              acc.reach += parseFloat(insight.reach || "0");
              return acc;
            },
            { impressions: 0, clicks: 0, spend: 0, reach: 0 }
          );

          return {
            impressions: totals.impressions,
            clicks: totals.clicks,
            spend: Math.round(totals.spend * 100) / 100,
            reach: totals.reach,
            ctr:
              totals.impressions > 0
                ? (totals.clicks / totals.impressions) * 100
                : 0,
            cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
            cpm:
              totals.impressions > 0
                ? (totals.spend / totals.impressions) * 1000
                : 0,
            frequency: totals.reach > 0 ? totals.impressions / totals.reach : 0,
          };
        };

        const performance = {
          campaign_id,
          performance_periods: {
            last_7_days: calculateMetrics(insights7d.data),
            last_30_days: calculateMetrics(insights30d.data),
            last_90_days: calculateMetrics(insights90d.data),
          },
          trends: {
            spend_trend: calculateTrend(
              insights7d.data,
              insights30d.data,
              "spend"
            ),
            ctr_trend: calculateTrend(insights7d.data, insights30d.data, "ctr"),
            cpc_trend: calculateTrend(insights7d.data, insights30d.data, "cpc"),
          },
          daily_breakdown_7d: insights7d.data.map((insight) => ({
            date: insight.date_start,
            impressions: parseFloat(insight.impressions || "0"),
            clicks: parseFloat(insight.clicks || "0"),
            spend: parseFloat(insight.spend || "0"),
            ctr: parseFloat(insight.ctr || "0"),
            cpc: parseFloat(insight.cpc || "0"),
          })),
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(performance, null, 2),
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
                  error: "Failed to fetch campaign performance data",
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

  // Account Performance Dashboard Resource
  server.resource(
    "account-dashboard",
    new ResourceTemplate("meta://insights/account/{account_id}", {
      list: undefined,
    }),
    async (uri, { account_id }) => {
      try {
        const [campaigns, accountInsights] = await Promise.all([
          metaClient.getCampaigns(account_id as string, { limit: 50 }),
          metaClient.getInsights(
            metaClient.authManager.getAccountId(account_id as string),
            {
              level: "account",
              date_preset: "last_30d",
              fields: [
                "impressions",
                "clicks",
                "spend",
                "reach",
                "frequency",
                "ctr",
                "cpc",
                "cpm",
              ],
            }
          ),
        ]);

        // Get performance for top campaigns
        const topCampaigns = campaigns.data.slice(0, 10);
        const campaignPerformance = await Promise.all(
          topCampaigns.map(async (campaign) => {
            try {
              const insights = await metaClient.getInsights(campaign.id, {
                level: "campaign",
                date_preset: "last_30d",
                fields: ["impressions", "clicks", "spend", "ctr", "cpc"],
              });

              const totals = insights.data.reduce(
                (acc, insight) => {
                  acc.impressions += parseFloat(insight.impressions || "0");
                  acc.clicks += parseFloat(insight.clicks || "0");
                  acc.spend += parseFloat(insight.spend || "0");
                  return acc;
                },
                { impressions: 0, clicks: 0, spend: 0 }
              );

              return {
                id: campaign.id,
                name: campaign.name,
                objective: campaign.objective,
                status: campaign.status,
                ...totals,
                ctr:
                  totals.impressions > 0
                    ? (totals.clicks / totals.impressions) * 100
                    : 0,
                cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
              };
            } catch {
              return {
                id: campaign.id,
                name: campaign.name,
                objective: campaign.objective,
                status: campaign.status,
                error: "Failed to fetch insights",
              };
            }
          })
        );

        const accountTotals = accountInsights.data.reduce(
          (acc, insight) => {
            acc.impressions += parseFloat(insight.impressions || "0");
            acc.clicks += parseFloat(insight.clicks || "0");
            acc.spend += parseFloat(insight.spend || "0");
            acc.reach += parseFloat(insight.reach || "0");
            return acc;
          },
          { impressions: 0, clicks: 0, spend: 0, reach: 0 }
        );

        const dashboard = {
          account_id,
          overview: {
            total_campaigns: campaigns.data.length,
            active_campaigns: campaigns.data.filter(
              (c) => c.status === "ACTIVE"
            ).length,
            paused_campaigns: campaigns.data.filter(
              (c) => c.status === "PAUSED"
            ).length,
            period: "Last 30 days",
          },
          account_performance: {
            impressions: accountTotals.impressions,
            clicks: accountTotals.clicks,
            spend: Math.round(accountTotals.spend * 100) / 100,
            reach: accountTotals.reach,
            ctr:
              accountTotals.impressions > 0
                ? (accountTotals.clicks / accountTotals.impressions) * 100
                : 0,
            cpc:
              accountTotals.clicks > 0
                ? accountTotals.spend / accountTotals.clicks
                : 0,
            frequency:
              accountTotals.reach > 0
                ? accountTotals.impressions / accountTotals.reach
                : 0,
          },
          top_campaigns: campaignPerformance.sort((a, b) => {
            const aSpend = "spend" in a ? a.spend : 0;
            const bSpend = "spend" in b ? b.spend : 0;
            return (bSpend || 0) - (aSpend || 0);
          }),
          objectives_breakdown: campaigns.data.reduce((acc, campaign) => {
            acc[campaign.objective] = (acc[campaign.objective] || 0) + 1;
            return acc;
          }, {} as any),
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(dashboard, null, 2),
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
                  error: "Failed to fetch account dashboard data",
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

  // Performance Comparison Resource
  server.resource(
    "performance-comparison",
    new ResourceTemplate("meta://insights/compare/{object_ids}", {
      list: undefined,
    }),
    async (uri, { object_ids }) => {
      try {
        const ids = (object_ids as string)
          .split(",")
          .map((id) => id.trim())
          .slice(0, 5); // Limit to 5 objects

        const comparisons = await Promise.all(
          ids.map(async (objectId) => {
            try {
              const insights = await metaClient.getInsights(objectId, {
                level: "campaign", // Assume campaigns for now
                date_preset: "last_30d",
                fields: [
                  "impressions",
                  "clicks",
                  "spend",
                  "reach",
                  "ctr",
                  "cpc",
                  "cpm",
                ],
              });

              const totals = insights.data.reduce(
                (acc, insight) => {
                  acc.impressions += parseFloat(insight.impressions || "0");
                  acc.clicks += parseFloat(insight.clicks || "0");
                  acc.spend += parseFloat(insight.spend || "0");
                  acc.reach += parseFloat(insight.reach || "0");
                  return acc;
                },
                { impressions: 0, clicks: 0, spend: 0, reach: 0 }
              );

              // Try to get campaign name
              let name = objectId;
              try {
                const campaign = await metaClient.getCampaign(objectId);
                name = campaign.name;
              } catch {
                // Use ID if name fetch fails
              }

              return {
                id: objectId,
                name,
                metrics: {
                  impressions: totals.impressions,
                  clicks: totals.clicks,
                  spend: Math.round(totals.spend * 100) / 100,
                  reach: totals.reach,
                  ctr:
                    totals.impressions > 0
                      ? (totals.clicks / totals.impressions) * 100
                      : 0,
                  cpc: totals.clicks > 0 ? totals.spend / totals.clicks : 0,
                  cpm:
                    totals.impressions > 0
                      ? (totals.spend / totals.impressions) * 1000
                      : 0,
                },
              };
            } catch (error) {
              return {
                id: objectId,
                name: objectId,
                error: error instanceof Error ? error.message : "Unknown error",
              };
            }
          })
        );

        // Calculate rankings
        const validComparisons = comparisons.filter((c) => !c.error);
        const rankings = {
          by_spend: [...validComparisons].sort(
            (a, b) => (b.metrics?.spend || 0) - (a.metrics?.spend || 0)
          ),
          by_ctr: [...validComparisons].sort(
            (a, b) => (b.metrics?.ctr || 0) - (a.metrics?.ctr || 0)
          ),
          by_cpc: [...validComparisons].sort(
            (a, b) =>
              (a.metrics?.cpc || Infinity) - (b.metrics?.cpc || Infinity)
          ),
          by_impressions: [...validComparisons].sort(
            (a, b) =>
              (b.metrics?.impressions || 0) - (a.metrics?.impressions || 0)
          ),
        };

        const comparison = {
          object_ids: ids,
          period: "Last 30 days",
          comparisons,
          rankings,
          summary: {
            total_objects: ids.length,
            successful_fetches: validComparisons.length,
            failed_fetches: comparisons.filter((c) => c.error).length,
          },
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(comparison, null, 2),
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
                  error: "Failed to fetch performance comparison data",
                  message: errorMessage,
                  object_ids,
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

  // Daily Performance Trends Resource
  server.resource(
    "daily-trends",
    new ResourceTemplate("meta://insights/trends/{object_id}/{days}", {
      list: undefined,
    }),
    async (uri, { object_id, days }) => {
      try {
        const numDays = Math.min(parseInt(days as string) || 7, 90); // Limit to 90 days
        const timeRange = {
          since: new Date(Date.now() - numDays * 24 * 60 * 60 * 1000)
            .toISOString()
            .split("T")[0],
          until: new Date().toISOString().split("T")[0],
        };

        const insights = await metaClient.getInsights(object_id as string, {
          level: "campaign",
          time_range: timeRange,
          fields: [
            "impressions",
            "clicks",
            "spend",
            "reach",
            "ctr",
            "cpc",
            "cpm",
          ],
          breakdowns: [], // Daily breakdown by default
        });

        const dailyData = insights.data
          .map((insight) => ({
            date: insight.date_start,
            impressions: parseFloat(insight.impressions || "0"),
            clicks: parseFloat(insight.clicks || "0"),
            spend: parseFloat(insight.spend || "0"),
            reach: parseFloat(insight.reach || "0"),
            ctr: parseFloat(insight.ctr || "0"),
            cpc: parseFloat(insight.cpc || "0"),
            cpm: parseFloat(insight.cpm || "0"),
          }))
          .sort(
            (a, b) =>
              new Date(a.date || "").getTime() -
              new Date(b.date || "").getTime()
          );

        // Calculate trends
        const trends = calculateTrends(dailyData);

        const trendsData = {
          object_id,
          period: `Last ${numDays} days`,
          daily_data: dailyData,
          trends,
          summary: {
            total_days: dailyData.length,
            date_range: {
              start: dailyData[0]?.date,
              end: dailyData[dailyData.length - 1]?.date,
            },
            totals: dailyData.reduce(
              (acc, day) => {
                acc.impressions += day.impressions;
                acc.clicks += day.clicks;
                acc.spend += day.spend;
                acc.reach += day.reach;
                return acc;
              },
              { impressions: 0, clicks: 0, spend: 0, reach: 0 }
            ),
          },
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(trendsData, null, 2),
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
                  error: "Failed to fetch daily trends data",
                  message: errorMessage,
                  object_id,
                  days,
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

// Helper Functions

function calculateTrend(
  recentData: any[],
  olderData: any[],
  metric: string
): string {
  if (
    !recentData ||
    !olderData ||
    recentData.length === 0 ||
    olderData.length === 0
  ) {
    return "insufficient_data";
  }

  const recentValue =
    recentData.reduce((sum, item) => sum + parseFloat(item[metric] || "0"), 0) /
    recentData.length;
  const olderValue =
    olderData.reduce((sum, item) => sum + parseFloat(item[metric] || "0"), 0) /
    olderData.length;

  if (olderValue === 0) return "no_baseline";

  const change = ((recentValue - olderValue) / olderValue) * 100;

  if (Math.abs(change) < 5) return "stable";
  return change > 0 ? "increasing" : "decreasing";
}

function calculateTrends(dailyData: any[]): any {
  if (dailyData.length < 2) return { insufficient_data: true };

  const calculateLinearTrend = (values: number[]) => {
    const n = values.length;
    const sumX = (n * (n - 1)) / 2; // Sum of indices 0,1,2...n-1
    const sumY = values.reduce((sum, val) => sum + val, 0);
    const sumXY = values.reduce((sum, val, index) => sum + index * val, 0);
    const sumXX = (n * (n - 1) * (2 * n - 1)) / 6; // Sum of squares of indices

    const slope = (n * sumXY - sumX * sumY) / (n * sumXX - sumX * sumX);
    return slope;
  };

  const impressions = dailyData.map((d) => d.impressions);
  const clicks = dailyData.map((d) => d.clicks);
  const spend = dailyData.map((d) => d.spend);
  const ctr = dailyData.map((d) => d.ctr);

  return {
    impressions: {
      slope: calculateLinearTrend(impressions),
      direction:
        calculateLinearTrend(impressions) > 0 ? "increasing" : "decreasing",
      strength:
        Math.abs(calculateLinearTrend(impressions)) > 100 ? "strong" : "weak",
    },
    clicks: {
      slope: calculateLinearTrend(clicks),
      direction: calculateLinearTrend(clicks) > 0 ? "increasing" : "decreasing",
      strength: Math.abs(calculateLinearTrend(clicks)) > 10 ? "strong" : "weak",
    },
    spend: {
      slope: calculateLinearTrend(spend),
      direction: calculateLinearTrend(spend) > 0 ? "increasing" : "decreasing",
      strength: Math.abs(calculateLinearTrend(spend)) > 1 ? "strong" : "weak",
    },
    ctr: {
      slope: calculateLinearTrend(ctr),
      direction: calculateLinearTrend(ctr) > 0 ? "increasing" : "decreasing",
      strength: Math.abs(calculateLinearTrend(ctr)) > 0.1 ? "strong" : "weak",
    },
  };
}
