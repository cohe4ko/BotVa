# Meta Marketing API MCP Server - Tools & Resources Reference

This document provides a comprehensive reference for all tools and resources available in the Meta Marketing API MCP Server.

## Table of Contents

- [Campaign Management Tools](#campaign-management-tools)
- [Analytics & Reporting Tools](#analytics--reporting-tools)
- [Audience Management Tools](#audience-management-tools)
- [Creative Management Tools](#creative-management-tools)
- [Utility Tools](#utility-tools)
- [MCP Resources](#mcp-resources)
- [Common Workflows](#common-workflows)

## Campaign Management Tools

### `list_campaigns`
List all campaigns in an ad account with filtering options.

**Parameters:**
- `account_id` (required): Meta Ad Account ID
- `status` (optional): Filter by campaign status ('ACTIVE', 'PAUSED', 'DELETED', 'ARCHIVED')
- `limit` (optional): Number of campaigns to return (1-100, default: 25)
- `after` (optional): Pagination cursor for next page

**Example:**
```
List all active campaigns for account act_123456789
```

### `create_campaign`
Create a new advertising campaign.

**Parameters:**
- `account_id` (required): Meta Ad Account ID
- `name` (required): Campaign name
- `objective` (required): Campaign objective (e.g., 'OUTCOME_TRAFFIC', 'OUTCOME_CONVERSIONS')
- `status` (optional): Initial status ('ACTIVE', 'PAUSED', default: 'PAUSED')
- `daily_budget` (optional): Daily budget in account currency cents
- `lifetime_budget` (optional): Lifetime budget in account currency cents
- `start_time` (optional): Campaign start time (ISO 8601 format)
- `stop_time` (optional): Campaign stop time (ISO 8601 format)

**Example:**
```
Create a new traffic campaign named "Summer Sale 2024" for account act_123456789 with a daily budget of $50
```

### `update_campaign`
Update an existing campaign's settings.

**Parameters:**
- `campaign_id` (required): Campaign ID to update
- `name` (optional): New campaign name
- `status` (optional): New status ('ACTIVE', 'PAUSED', 'ARCHIVED')
- `daily_budget` (optional): New daily budget in cents
- `lifetime_budget` (optional): New lifetime budget in cents
- `start_time` (optional): New start time
- `stop_time` (optional): New stop time

**Example:**
```
Update campaign 120212345678901234 to increase daily budget to $100
```

### `pause_campaign` / `resume_campaign`
Pause or resume a campaign.

**Parameters:**
- `campaign_id` (required): Campaign ID

**Example:**
```
Pause campaign 120212345678901234
Resume campaign 120212345678901234
```

### `delete_campaign`
Delete a campaign permanently.

**Parameters:**
- `campaign_id` (required): Campaign ID to delete

**Example:**
```
Delete campaign 120212345678901234
```

### `get_campaign`
Get detailed information about a specific campaign.

**Parameters:**
- `campaign_id` (required): Campaign ID

**Example:**
```
Get details for campaign 120212345678901234
```

### `list_ad_sets`
List ad sets within campaigns or accounts.

**Parameters:**
- `campaign_id` (optional): Filter by campaign ID
- `account_id` (optional): Filter by account ID
- `status` (optional): Filter by status
- `limit` (optional): Number of ad sets to return
- `after` (optional): Pagination cursor

**Example:**
```
List all ad sets for campaign 120212345678901234
```

### `create_ad_set`
Create a new ad set within a campaign.

**Parameters:**
- `campaign_id` (required): Parent campaign ID
- `name` (required): Ad set name
- `daily_budget` or `lifetime_budget` (required): Budget settings
- `optimization_goal` (required): Optimization goal (e.g., 'LINK_CLICKS', 'CONVERSIONS')
- `billing_event` (required): Billing event (e.g., 'LINK_CLICKS', 'IMPRESSIONS')
- `targeting` (optional): Targeting parameters
- `start_time` (optional): Start time
- `end_time` (optional): End time

**Example:**
```
Create an ad set for campaign 120212345678901234 targeting US adults aged 25-45 interested in fitness
```

### `list_ads`
List individual ads within ad sets, campaigns, or accounts.

**Parameters:**
- `adset_id` (optional): Filter by ad set ID
- `campaign_id` (optional): Filter by campaign ID  
- `account_id` (optional): Filter by account ID
- `status` (optional): Filter by status
- `limit` (optional): Number of ads to return

**Example:**
```
List all ads in ad set 120212345678901234
```

## Analytics & Reporting Tools

### `get_insights`
Get performance insights for campaigns, ad sets, or ads.

**Parameters:**
- `object_id` (required): ID of object to get insights for
- `level` (required): Level of insights ('account', 'campaign', 'adset', 'ad')
- `date_preset` (optional): Date preset ('today', 'yesterday', 'last_7d', 'last_30d', etc.)
- `time_range` (optional): Custom date range with 'since' and 'until'
- `fields` (optional): Specific metrics to retrieve
- `breakdowns` (optional): Breakdown dimensions
- `limit` (optional): Number of results

**Example:**
```
Get last 30 days performance insights for campaign 120212345678901234
```

### `compare_performance`
Compare performance metrics across multiple campaigns, ad sets, or ads.

**Parameters:**
- `object_ids` (required): Array of object IDs to compare (2-10 items)
- `level` (required): Level of objects ('campaign', 'adset', 'ad')
- `date_preset` (optional): Date preset for comparison
- `time_range` (optional): Custom date range
- `metrics` (optional): Metrics to compare

**Example:**
```
Compare performance of campaigns 120212345678901234 and 120212345678901235 for the last 7 days
```

### `export_insights`
Export performance data in CSV or JSON format.

**Parameters:**
- `object_id` (required): ID of object to export insights for
- `level` (required): Level of insights
- `format` (optional): Export format ('csv', 'json', default: 'csv')
- `date_preset` (optional): Date preset
- `time_range` (optional): Custom date range
- `fields` (optional): Fields to export
- `breakdowns` (optional): Breakdowns to include

**Example:**
```
Export last 30 days campaign performance data as CSV for campaign 120212345678901234
```

### `get_campaign_performance`
Get simplified performance overview for a campaign.

**Parameters:**
- Same as `get_insights` but automatically sets level to 'campaign'

**Example:**
```
Get performance overview for campaign 120212345678901234
```

### `get_attribution_data`
Get attribution modeling data showing conversion paths.

**Parameters:**
- `object_id` (required): Campaign, ad set, or ad ID
- `level` (required): Analysis level
- `date_preset` (optional): Date preset
- `time_range` (optional): Custom date range

**Example:**
```
Get attribution data for campaign 120212345678901234 showing conversion paths
```

## Audience Management Tools

### `list_audiences`
List custom and lookalike audiences in an ad account.

**Parameters:**
- `account_id` (required): Meta Ad Account ID
- `type` (optional): Filter by audience type ('custom', 'lookalike', 'saved')
- `limit` (optional): Number of audiences to return
- `after` (optional): Pagination cursor

**Example:**
```
List all custom audiences for account act_123456789
```

### `create_custom_audience`
Create a new custom audience.

**Parameters:**
- `account_id` (required): Meta Ad Account ID
- `name` (required): Audience name
- `description` (optional): Audience description
- `subtype` (required): Audience subtype ('CUSTOM', 'WEBSITE', 'APP', etc.)
- `customer_file_source` (optional): Customer file source
- `retention_days` (optional): Data retention period
- `rule` (optional): Audience rule definition

**Example:**
```
Create a website custom audience named "Website Visitors - Last 30 Days" for account act_123456789
```

### `create_lookalike_audience`
Create a lookalike audience based on an existing custom audience.

**Parameters:**
- `account_id` (required): Meta Ad Account ID
- `name` (required): Lookalike audience name
- `origin_audience_id` (required): Source custom audience ID
- `country` (required): Target country code
- `ratio` (required): Similarity ratio (0.01-0.2, i.e., 1%-20%)
- `description` (optional): Audience description

**Example:**
```
Create a 3% lookalike audience based on custom audience 12345 for the United States
```

### `estimate_audience_size`
Estimate the reach of targeting parameters.

**Parameters:**
- `account_id` (required): Meta Ad Account ID
- `targeting` (required): Targeting parameters object
- `optimization_goal` (required): Optimization goal for the estimate

**Example:**
```
Estimate audience size for US adults aged 25-45 interested in fitness
```

## Creative Management Tools

### `list_creatives`
List ad creatives in an ad account.

**Parameters:**
- `account_id` (required): Meta Ad Account ID
- `limit` (optional): Number of creatives to return
- `after` (optional): Pagination cursor

**Example:**
```
List all ad creatives for account act_123456789
```

### `create_ad_creative`
Create a new ad creative.

**Parameters:**
- `account_id` (required): Meta Ad Account ID
- `name` (required): Creative name
- `title` (optional): Ad title
- `body` (optional): Ad body text
- `image_url` (optional): Image URL
- `video_id` (optional): Video ID
- `call_to_action` (optional): Call-to-action configuration
- `link_url` (optional): Destination URL
- `display_link` (optional): Display link text

**Example:**
```
Create an ad creative with title "Summer Sale" and image URL https://example.com/image.jpg
```

### `preview_ad`
Generate a preview of how an ad creative will appear.

**Parameters:**
- `creative_id` (required): Creative ID to preview
- `ad_format` (required): Ad format for preview
- `product_item_ids` (optional): Product item IDs for dynamic ads

**Example:**
```
Preview creative 12345 in mobile feed format
```

### `setup_ab_test`
Get guidance on setting up A/B tests for creatives.

**Parameters:**
- `account_id` (required): Meta Ad Account ID
- `name` (required): Test name

**Example:**
```
Set up A/B test for comparing different headlines in account act_123456789
```

## Utility Tools

### `get_ad_accounts`
List all accessible ad accounts.

**Parameters:** None

**Example:**
```
Show me all my Meta ad accounts
```

### `health_check`
Check the server health and connection status.

**Parameters:** None

**Example:**
```
Check the health of the Meta Marketing API server
```

### `get_capabilities`
Get detailed information about server capabilities and features.

**Parameters:** None

**Example:**
```
What are the capabilities of the Meta Marketing API server?
```

## MCP Resources

Resources provide structured data access through URI patterns:

### Campaign Resources
- `meta://campaigns/{account_id}` - Campaign overview for an account
- `meta://campaign/{campaign_id}` - Detailed campaign information
- `meta://campaign-status/{account_id}` - Campaign status breakdown
- `meta://adsets/{campaign_id}` - Ad sets within a campaign

### Insights Resources
- `meta://insights/campaign/{campaign_id}` - Campaign performance data
- `meta://insights/account/{account_id}` - Account performance dashboard
- `meta://insights/compare/{object_ids}` - Performance comparison
- `meta://insights/trends/{object_id}/{days}` - Daily performance trends

### Audience Resources
- `meta://audiences/{account_id}` - Audience overview
- `meta://audience-performance/{account_id}` - Audience performance analysis
- `meta://targeting-insights/{account_id}` - Targeting recommendations
- `meta://audience-health/{account_id}` - Audience health report

## Common Workflows

### Campaign Creation Workflow
1. `get_ad_accounts` - Find your account ID
2. `create_campaign` - Create the campaign
3. `create_ad_set` - Add targeting and budget
4. `create_ad_creative` - Design your ad
5. `get_insights` - Monitor performance

### Performance Analysis Workflow
1. `list_campaigns` - Find campaigns to analyze
2. `get_insights` - Get performance data
3. `compare_performance` - Compare multiple campaigns
4. `export_insights` - Export data for further analysis

### Audience Building Workflow
1. `list_audiences` - Review existing audiences
2. `create_custom_audience` - Create source audience
3. `create_lookalike_audience` - Scale with lookalikes
4. `estimate_audience_size` - Validate targeting reach

### Optimization Workflow
1. Access `meta://insights/account/{account_id}` - Review dashboard
2. `compare_performance` - Identify top performers
3. `update_campaign` - Adjust budgets based on performance
4. `pause_campaign` - Stop underperforming campaigns

## Error Handling

All tools provide structured error responses with:
- Error type and message
- Suggested solutions
- Relevant documentation links
- Rate limit information when applicable

Common error types:
- **Authentication errors**: Invalid or expired access tokens
- **Permission errors**: Insufficient permissions for the operation
- **Rate limit errors**: API quota exceeded
- **Validation errors**: Invalid parameters or data
- **Not found errors**: Requested resource doesn't exist

## Rate Limits

The server automatically handles Meta's rate limiting:
- **Development tier**: 60 points per account per 5 minutes
- **Standard tier**: 9000 points per account per 5 minutes
- **Read operations**: 1 point each
- **Write operations**: 3 points each

The server will automatically retry with exponential backoff when rate limits are hit.