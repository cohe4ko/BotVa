import {
  McpServer,
  ResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import { MetaApiClient } from "../meta-client.js";

export function registerAudienceResources(
  server: McpServer,
  metaClient: MetaApiClient
) {
  // Audiences Overview Resource
  server.resource(
    "audiences",
    new ResourceTemplate("meta://audiences/{account_id}", { list: undefined }),
    async (uri, { account_id }) => {
      try {
        const result = await metaClient.getCustomAudiences(
          account_id as string,
          {
            limit: 100,
            fields: [
              "id",
              "name",
              "description",
              "subtype",
              "approximate_count",
              "data_source",
              "retention_days",
              "creation_time",
              "operation_status",
            ],
          }
        );

        const audiences = result.data;

        // Categorize audiences
        const customAudiences = audiences.filter(
          (a) => a.subtype !== "LOOKALIKE"
        );
        const lookalikeAudiences = audiences.filter(
          (a) => a.subtype === "LOOKALIKE"
        );

        // Group by subtype
        const audiencesByType = audiences.reduce((acc, audience) => {
          const type = audience.subtype;
          if (!acc[type]) {
            acc[type] = {
              count: 0,
              total_size: 0,
              audiences: [],
            };
          }
          acc[type].count++;
          acc[type].total_size += audience.approximate_count || 0;
          acc[type].audiences.push({
            id: audience.id,
            name: audience.name,
            approximate_count: audience.approximate_count,
            creation_time: audience.creation_time,
            operation_status: audience.operation_status,
          });
          return acc;
        }, {} as any);

        // Calculate health metrics
        const healthMetrics = {
          total_audiences: audiences.length,
          ready_audiences: audiences.filter(
            (a) => a.operation_status?.code === 200
          ).length,
          processing_audiences: audiences.filter(
            (a) =>
              a.operation_status?.code !== 200 &&
              a.operation_status?.code !== 400
          ).length,
          failed_audiences: audiences.filter(
            (a) => a.operation_status?.code === 400
          ).length,
          average_size:
            audiences.length > 0
              ? audiences.reduce(
                  (sum, a) => sum + (a.approximate_count || 0),
                  0
                ) / audiences.length
              : 0,
        };

        const overview = {
          account_id,
          summary: {
            total_audiences: audiences.length,
            custom_audiences: customAudiences.length,
            lookalike_audiences: lookalikeAudiences.length,
            total_reach: audiences.reduce(
              (sum, a) => sum + (a.approximate_count || 0),
              0
            ),
          },
          health_metrics: healthMetrics,
          audiences_by_type: audiencesByType,
          recent_audiences: audiences
            .sort(
              (a, b) =>
                new Date(b.creation_time).getTime() -
                new Date(a.creation_time).getTime()
            )
            .slice(0, 10)
            .map((audience) => ({
              id: audience.id,
              name: audience.name,
              subtype: audience.subtype,
              approximate_count: audience.approximate_count,
              creation_time: audience.creation_time,
              days_since_created: Math.floor(
                (Date.now() - new Date(audience.creation_time).getTime()) /
                  (1000 * 60 * 60 * 24)
              ),
            })),
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
                  error: "Failed to fetch audiences data",
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

  // Audience Performance Resource
  server.resource(
    "audience-performance",
    new ResourceTemplate("meta://audience-performance/{account_id}", {
      list: undefined,
    }),
    async (uri, { account_id }) => {
      try {
        // Note: This is a conceptual implementation as actual audience performance
        // would require analyzing campaigns that use these audiences
        const audiences = await metaClient.getCustomAudiences(
          account_id as string,
          {
            limit: 50,
            fields: [
              "id",
              "name",
              "subtype",
              "approximate_count",
              "creation_time",
            ],
          }
        );

        const audiencePerformance = {
          account_id,
          performance_note:
            "Audience performance analysis requires campaign-level insights",
          methodology:
            "To get actual performance data, analyze campaigns using each audience",
          audience_metrics: audiences.data.map((audience) => ({
            id: audience.id,
            name: audience.name,
            type: audience.subtype,
            size: audience.approximate_count,
            size_category: categorizeAudienceSize(
              audience.approximate_count || 0
            ),
            age_days: Math.floor(
              (Date.now() - new Date(audience.creation_time).getTime()) /
                (1000 * 60 * 60 * 24)
            ),
            estimated_targeting_efficiency: estimateTargetingEfficiency(
              audience.subtype,
              audience.approximate_count || 0
            ),
            recommendations: generateAudienceRecommendations(
              audience.subtype,
              audience.approximate_count || 0
            ),
          })),
          size_distribution: {
            small: audiences.data.filter(
              (a) => (a.approximate_count || 0) < 10000
            ).length,
            medium: audiences.data.filter(
              (a) =>
                (a.approximate_count || 0) >= 10000 &&
                (a.approximate_count || 0) < 100000
            ).length,
            large: audiences.data.filter(
              (a) =>
                (a.approximate_count || 0) >= 100000 &&
                (a.approximate_count || 0) < 1000000
            ).length,
            very_large: audiences.data.filter(
              (a) => (a.approximate_count || 0) >= 1000000
            ).length,
          },
          optimization_opportunities: generateOptimizationOpportunities(
            audiences.data
          ),
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(audiencePerformance, null, 2),
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
                  error: "Failed to fetch audience performance data",
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

  // Targeting Insights Resource
  server.resource(
    "targeting-insights",
    new ResourceTemplate("meta://targeting-insights/{account_id}", {
      list: undefined,
    }),
    async (uri, { account_id }) => {
      try {
        // This would typically analyze targeting used across campaigns
        // For now, we'll provide insights about audience usage patterns

        const insights = {
          account_id,
          targeting_analysis: {
            note: "Targeting insights require analyzing active campaigns and their performance",
            available_data: [
              "Audience overlap analysis",
              "Geographic targeting patterns",
              "Demographic performance breakdown",
              "Interest-based targeting effectiveness",
            ],
          },
          recommended_targeting_strategies: [
            {
              strategy: "Broad + Lookalike",
              description:
                "Combine broad targeting with lookalike audiences for scale",
              best_for: ["Brand awareness", "Reach campaigns"],
              implementation:
                "Use 1-3% lookalike audiences with interest expansion",
            },
            {
              strategy: "Layered Interest Targeting",
              description: "Combine multiple interest categories for precision",
              best_for: ["Conversion campaigns", "Niche products"],
              implementation: "Stack 2-3 complementary interest categories",
            },
            {
              strategy: "Custom + Exclusion",
              description: "Target custom audiences while excluding converters",
              best_for: ["Retargeting", "Customer acquisition"],
              implementation:
                "Use website visitors excluding recent purchasers",
            },
            {
              strategy: "Geographic + Demographic",
              description: "Combine location targeting with age/gender filters",
              best_for: ["Local businesses", "Event promotion"],
              implementation:
                "Target specific cities/regions with relevant demographics",
            },
          ],
          targeting_best_practices: [
            "Test broad vs. narrow targeting to find optimal balance",
            "Use audience insights to understand your customers better",
            "Regularly refresh custom audiences to maintain relevance",
            "Monitor frequency to avoid audience fatigue",
            "Create exclusion audiences to prevent overlap",
            "Use lookalike audiences to scale successful custom audiences",
          ],
          common_targeting_mistakes: [
            "Making audiences too narrow (under 1,000 people)",
            "Not using exclusion audiences",
            "Over-targeting with too many restrictions",
            "Not refreshing stale custom audiences",
            "Ignoring detailed targeting expansion",
            "Not testing different audience sizes",
          ],
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(insights, null, 2),
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
                  error: "Failed to fetch targeting insights",
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

  // Audience Health Report Resource
  server.resource(
    "audience-health",
    new ResourceTemplate("meta://audience-health/{account_id}", {
      list: undefined,
    }),
    async (uri, { account_id }) => {
      try {
        const audiences = await metaClient.getCustomAudiences(
          account_id as string,
          {
            limit: 100,
            fields: [
              "id",
              "name",
              "subtype",
              "approximate_count",
              "creation_time",
              "operation_status",
              "retention_days",
            ],
          }
        );

        const now = Date.now();
        const healthReport = {
          account_id,
          health_summary: {
            total_audiences: audiences.data.length,
            healthy_audiences: 0,
            warning_audiences: 0,
            critical_audiences: 0,
          },
          audience_health_details: audiences.data.map((audience) => {
            const ageDays = Math.floor(
              (now - new Date(audience.creation_time).getTime()) /
                (1000 * 60 * 60 * 24)
            );
            const size = audience.approximate_count || 0;
            const status = audience.operation_status?.code || 0;

            let healthStatus = "healthy";
            let healthScore = 100;
            const issues: string[] = [];
            const recommendations: string[] = [];

            // Check operation status
            if (status === 400) {
              healthStatus = "critical";
              healthScore -= 50;
              issues.push("Audience processing failed");
              recommendations.push(
                "Check audience data and recreate if necessary"
              );
            } else if (status !== 200) {
              healthStatus = "warning";
              healthScore -= 20;
              issues.push("Audience still processing");
              recommendations.push("Wait for processing to complete");
            }

            // Check audience size
            if (size < 1000) {
              if (healthStatus !== "critical") healthStatus = "warning";
              healthScore -= 30;
              issues.push("Audience size is very small");
              recommendations.push(
                "Consider broadening audience criteria or creating lookalike audiences"
              );
            } else if (size < 10000) {
              healthScore -= 10;
              issues.push("Audience size is small");
              recommendations.push(
                "Monitor performance closely due to limited reach"
              );
            }

            // Check audience age
            if (ageDays > 180) {
              healthScore -= 15;
              issues.push("Audience is getting stale");
              recommendations.push(
                "Consider refreshing audience data or creating new versions"
              );
            }

            // Check retention for custom audiences
            if (audience.retention_days && audience.retention_days < 30) {
              healthScore -= 10;
              issues.push("Short retention period");
              recommendations.push(
                "Consider extending retention period if appropriate"
              );
            }

            // Update summary counts
            if (healthStatus === "healthy")
              healthReport.health_summary.healthy_audiences++;
            else if (healthStatus === "warning")
              healthReport.health_summary.warning_audiences++;
            else healthReport.health_summary.critical_audiences++;

            return {
              id: audience.id,
              name: audience.name,
              type: audience.subtype,
              health_status: healthStatus,
              health_score: Math.max(0, healthScore),
              size: size,
              age_days: ageDays,
              operation_status: status,
              issues,
              recommendations,
            };
          }),
          recommendations: generateGlobalAudienceRecommendations(
            audiences.data
          ),
          last_updated: new Date().toISOString(),
        };

        return {
          contents: [
            {
              uri: uri.href,
              mimeType: "application/json",
              text: JSON.stringify(healthReport, null, 2),
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
                  error: "Failed to fetch audience health report",
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
}

// Helper Functions

function categorizeAudienceSize(size: number): string {
  if (size < 1000) return "very_small";
  if (size < 10000) return "small";
  if (size < 100000) return "medium";
  if (size < 1000000) return "large";
  return "very_large";
}

function estimateTargetingEfficiency(subtype: string, size: number): string {
  if (subtype === "LOOKALIKE") {
    if (size > 100000) return "high";
    if (size > 10000) return "medium";
    return "low";
  }

  if (subtype === "WEBSITE") {
    if (size > 50000) return "high";
    if (size > 5000) return "medium";
    return "low";
  }

  if (size > 100000) return "medium";
  if (size > 10000) return "low";
  return "very_low";
}

function generateAudienceRecommendations(
  subtype: string,
  size: number
): string[] {
  const recommendations: string[] = [];

  if (size < 1000) {
    recommendations.push("Audience is too small for effective targeting");
    recommendations.push(
      "Consider creating lookalike audiences to expand reach"
    );
  }

  if (subtype === "CUSTOM" && size > 10000) {
    recommendations.push("Good candidate for creating lookalike audiences");
  }

  if (subtype === "WEBSITE" && size < 5000) {
    recommendations.push(
      "Increase website traffic or extend pixel retention period"
    );
  }

  if (subtype === "LOOKALIKE" && size > 1000000) {
    recommendations.push(
      "Consider creating smaller, more targeted lookalike audiences"
    );
  }

  return recommendations;
}

function generateOptimizationOpportunities(audiences: any[]): string[] {
  const opportunities: string[] = [];

  const smallAudiences = audiences.filter(
    (a) => (a.approximate_count || 0) < 1000
  );
  if (smallAudiences.length > 0) {
    opportunities.push(
      `${smallAudiences.length} audiences are too small for effective targeting`
    );
  }

  const staleAudiences = audiences.filter((a) => {
    const ageDays = Math.floor(
      (Date.now() - new Date(a.creation_time).getTime()) / (1000 * 60 * 60 * 24)
    );
    return ageDays > 180;
  });
  if (staleAudiences.length > 0) {
    opportunities.push(
      `${staleAudiences.length} audiences are over 6 months old and may need refreshing`
    );
  }

  const websiteAudiences = audiences.filter(
    (a) => a.subtype === "WEBSITE" && (a.approximate_count || 0) > 10000
  );
  if (websiteAudiences.length > 0) {
    opportunities.push(
      `${websiteAudiences.length} website audiences are good candidates for lookalike creation`
    );
  }

  return opportunities;
}

function generateGlobalAudienceRecommendations(audiences: any[]): string[] {
  const recommendations: string[] = [];

  if (audiences.length < 5) {
    recommendations.push(
      "Consider creating more diverse audiences for better targeting options"
    );
  }

  const lookalikeCount = audiences.filter(
    (a) => a.subtype === "LOOKALIKE"
  ).length;
  const customCount = audiences.filter((a) => a.subtype !== "LOOKALIKE").length;

  if (customCount > 0 && lookalikeCount === 0) {
    recommendations.push(
      "Create lookalike audiences based on your best-performing custom audiences"
    );
  }

  if (lookalikeCount > customCount * 3) {
    recommendations.push(
      "You have many lookalike audiences; ensure they're based on high-quality source audiences"
    );
  }

  const largeAudiences = audiences.filter(
    (a) => (a.approximate_count || 0) > 1000000
  );
  if (largeAudiences.length > audiences.length * 0.5) {
    recommendations.push(
      "Most audiences are very large; consider creating more targeted segments"
    );
  }

  return recommendations;
}
