import fetch from "node-fetch";
import { AuthManager } from "./utils/auth.js";
import { globalRateLimiter } from "./utils/rate-limiter.js";
import {
  MetaApiErrorHandler,
  retryWithBackoff,
} from "./utils/error-handler.js";
import {
  PaginationHelper,
  type PaginationParams,
  type PaginatedResult,
} from "./utils/pagination.js";
import type {
  Campaign,
  AdSet,
  Ad,
  AdCreative,
  AdInsights,
  CustomAudience,
  AdAccount,
  MetaApiResponse,
  BatchRequest,
  BatchResponse,
} from "./types/meta-api.js";

export class MetaApiClient {
  private auth: AuthManager;

  constructor(auth?: AuthManager) {
    this.auth = auth || AuthManager.fromEnvironment();
  }

  get authManager(): AuthManager {
    return this.auth;
  }

  private async makeRequest<T>(
    endpoint: string,
    method: "GET" | "POST" | "DELETE" = "GET",
    body?: any,
    accountId?: string,
    isWriteCall: boolean = false
  ): Promise<T> {
    const url = `${this.auth.getBaseUrl()}/${this.auth.getApiVersion()}/${endpoint}`;

    // Check rate limit if we have an account ID
    if (accountId) {
      await globalRateLimiter.checkRateLimit(accountId, isWriteCall);
    }

    return retryWithBackoff(async () => {
      const headers = this.auth.getAuthHeaders();

      const requestOptions: any = {
        method,
        headers,
      };

      if (body && method !== "GET") {
        if (typeof body === "string") {
          requestOptions.body = body;
          headers["Content-Type"] = "application/x-www-form-urlencoded";
        } else {
          requestOptions.body = JSON.stringify(body);
          headers["Content-Type"] = "application/json";
        }
      }

      const response = await fetch(url, requestOptions);
      return MetaApiErrorHandler.handleResponse(response as any);
    }, `${method} ${endpoint}`);
  }

  private buildQueryString(params: Record<string, any>): string {
    const urlParams = new URLSearchParams();

    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== null) {
        if (Array.isArray(value)) {
          urlParams.set(key, JSON.stringify(value));
        } else if (typeof value === "object") {
          urlParams.set(key, JSON.stringify(value));
        } else {
          urlParams.set(key, String(value));
        }
      }
    }

    return urlParams.toString();
  }

  // Account Methods
  async getAdAccounts(): Promise<AdAccount[]> {
    const response = await this.makeRequest<MetaApiResponse<AdAccount>>(
      "me/adaccounts?fields=id,name,account_status,balance,currency,timezone_name,business"
    );
    return response.data;
  }

  async getAdAccount(accountId: string): Promise<AdAccount> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    return this.makeRequest<AdAccount>(
      `${formattedAccountId}?fields=id,name,account_status,balance,currency,timezone_name,business`
    );
  }

  // Campaign Methods
  async getCampaigns(
    accountId: string,
    params: PaginationParams & { status?: string; fields?: string[] } = {}
  ): Promise<PaginatedResult<Campaign>> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const { status, fields, ...paginationParams } = params;

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,objective,status,effective_status,created_time,updated_time,start_time,stop_time,budget_remaining,daily_budget,lifetime_budget",
      ...paginationParams,
    };

    if (status) {
      queryParams.effective_status = JSON.stringify([status]);
    }

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<Campaign>>(
      `${formattedAccountId}/campaigns?${query}`,
      "GET",
      null,
      formattedAccountId
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  async getCampaign(campaignId: string): Promise<Campaign> {
    return this.makeRequest<Campaign>(
      `${campaignId}?fields=id,name,objective,status,effective_status,created_time,updated_time,start_time,stop_time,budget_remaining,daily_budget,lifetime_budget,account_id`
    );
  }

  async createCampaign(
    accountId: string,
    campaignData: {
      name: string;
      objective: string;
      status?: string;
      daily_budget?: number;
      lifetime_budget?: number;
      start_time?: string;
      stop_time?: string;
      special_ad_categories?: string[];
      bid_strategy?: string;
      bid_cap?: number;
      is_budget_optimization_enabled?: boolean;
    }
  ): Promise<{ id: string }> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const body = this.buildQueryString(campaignData);

    return this.makeRequest<{ id: string }>(
      `${formattedAccountId}/campaigns`,
      "POST",
      body,
      formattedAccountId,
      true
    );
  }

  async updateCampaign(
    campaignId: string,
    updates: {
      name?: string;
      status?: string;
      daily_budget?: number;
      lifetime_budget?: number;
      start_time?: string;
      stop_time?: string;
    }
  ): Promise<{ success: boolean }> {
    const body = this.buildQueryString(updates);

    return this.makeRequest<{ success: boolean }>(
      campaignId,
      "POST",
      body,
      undefined,
      true
    );
  }

  async deleteCampaign(campaignId: string): Promise<{ success: boolean }> {
    return this.makeRequest<{ success: boolean }>(
      campaignId,
      "DELETE",
      null,
      undefined,
      true
    );
  }

  // Ad Set Methods
  async getAdSets(
    params: PaginationParams & {
      campaignId?: string;
      accountId?: string;
      status?: string;
      fields?: string[];
    } = {}
  ): Promise<PaginatedResult<AdSet>> {
    const { campaignId, accountId, status, fields, ...paginationParams } =
      params;

    let endpoint: string;
    if (campaignId) {
      endpoint = `${campaignId}/adsets`;
    } else if (accountId) {
      const formattedAccountId = this.auth.getAccountId(accountId);
      endpoint = `${formattedAccountId}/adsets`;
    } else {
      throw new Error("Either campaignId or accountId must be provided");
    }

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,campaign_id,status,effective_status,created_time,updated_time,start_time,end_time,daily_budget,lifetime_budget,bid_amount,billing_event,optimization_goal",
      ...paginationParams,
    };

    if (status) {
      queryParams.effective_status = JSON.stringify([status]);
    }

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<AdSet>>(
      `${endpoint}?${query}`,
      "GET",
      null,
      accountId ? this.auth.getAccountId(accountId) : undefined
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  async createAdSet(
    campaignId: string,
    adSetData: {
      name: string;
      daily_budget?: number;
      lifetime_budget?: number;
      optimization_goal: string;
      billing_event: string;
      bid_amount?: number;
      start_time?: string;
      end_time?: string;
      targeting?: any;
      status?: string;
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
  ): Promise<{ id: string }> {
    // First, get the campaign to find its account_id
    const campaign = await this.getCampaign(campaignId);
    const accountId = campaign.account_id;

    if (!accountId) {
      throw new Error("Unable to determine account ID from campaign");
    }

    const formattedAccountId = this.auth.getAccountId(accountId);

    // Ensure campaign_id is included in the request body
    const requestData = {
      ...adSetData,
      campaign_id: campaignId,
    };

    const body = this.buildQueryString(requestData);

    // Enhanced debugging for ad set creation
    console.error("=== AD SET CREATION DEBUG ===");
    console.error("Campaign ID:", campaignId);
    console.error("Account ID:", accountId);
    console.error("Formatted Account ID:", formattedAccountId);
    console.error("Request Data Object:", JSON.stringify(requestData, null, 2));
    console.error("Request Body (URL-encoded):", body);
    console.error("API Endpoint:", `${formattedAccountId}/adsets`);
    console.error("===========================");

    try {
      const result = await this.makeRequest<{ id: string }>(
        `${formattedAccountId}/adsets`,
        "POST",
        body,
        formattedAccountId,
        true
      );

      console.error("=== AD SET CREATION SUCCESS ===");
      console.error("Created Ad Set ID:", result.id);
      console.error("==============================");

      return result;
    } catch (error) {
      console.error("=== AD SET CREATION ERROR ===");
      console.error("Error object:", error);

      if (error instanceof Error) {
        console.error("Error message:", error.message);

        // Try to parse error response if it's JSON
        try {
          const errorData = JSON.parse(error.message);
          console.error("Parsed error data:", JSON.stringify(errorData, null, 2));

          if (errorData.error) {
            console.error("Meta API Error Details:");
            console.error("- Message:", errorData.error.message);
            console.error("- Code:", errorData.error.code);
            console.error("- Type:", errorData.error.type);
            console.error("- Error Subcode:", errorData.error.error_subcode);
            console.error("- FBTrace ID:", errorData.error.fbtrace_id);

            if (errorData.error.error_data) {
              console.error(
                "- Error Data:",
                JSON.stringify(errorData.error.error_data, null, 2)
              );
            }

            if (errorData.error.error_user_title) {
              console.error("- User Title:", errorData.error.error_user_title);
            }

            if (errorData.error.error_user_msg) {
              console.error("- User Message:", errorData.error.error_user_msg);
            }
          }
        } catch (parseError) {
          console.error(
            "Could not parse error as JSON, raw message:",
            error.message
          );
        }
      }
      console.error("============================");

      throw error;
    }
  }

  // Ad Methods
  async getAds(
    params: PaginationParams & {
      adsetId?: string;
      campaignId?: string;
      accountId?: string;
      status?: string;
      fields?: string[];
    } = {}
  ): Promise<PaginatedResult<Ad>> {
    const {
      adsetId,
      campaignId,
      accountId,
      status,
      fields,
      ...paginationParams
    } = params;

    let endpoint: string;
    if (adsetId) {
      endpoint = `${adsetId}/ads`;
    } else if (campaignId) {
      endpoint = `${campaignId}/ads`;
    } else if (accountId) {
      const formattedAccountId = this.auth.getAccountId(accountId);
      endpoint = `${formattedAccountId}/ads`;
    } else {
      throw new Error(
        "Either adsetId, campaignId, or accountId must be provided"
      );
    }

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,adset_id,campaign_id,status,effective_status,created_time,updated_time,creative",
      ...paginationParams,
    };

    if (status) {
      queryParams.effective_status = JSON.stringify([status]);
    }

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<Ad>>(
      `${endpoint}?${query}`,
      "GET",
      null,
      accountId ? this.auth.getAccountId(accountId) : undefined
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  // Insights Methods
  async getInsights(
    objectId: string,
    params: {
      level?: "account" | "campaign" | "adset" | "ad";
      date_preset?: string;
      time_range?: { since: string; until: string };
      fields?: string[];
      breakdowns?: string[];
      limit?: number;
      after?: string;
    } = {}
  ): Promise<PaginatedResult<AdInsights>> {
    const queryParams: Record<string, any> = {
      fields:
        params.fields?.join(",") ||
        "impressions,clicks,spend,reach,frequency,ctr,cpc,cpm,actions,cost_per_action_type",
      ...params,
    };

    if (params.time_range) {
      queryParams.time_range = params.time_range;
    }

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<AdInsights>>(
      `${objectId}/insights?${query}`
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  // Custom Audience Methods
  async getCustomAudiences(
    accountId: string,
    params: PaginationParams & { fields?: string[] } = {}
  ): Promise<PaginatedResult<CustomAudience>> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const { fields, ...paginationParams } = params;

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,description,subtype,approximate_count,data_source,retention_days,creation_time,operation_status",
      ...paginationParams,
    };

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<CustomAudience>>(
      `${formattedAccountId}/customaudiences?${query}`,
      "GET",
      null,
      formattedAccountId
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  async createCustomAudience(
    accountId: string,
    audienceData: {
      name: string;
      description?: string;
      subtype: string;
      customer_file_source?: string;
      retention_days?: number;
      rule?: any;
    }
  ): Promise<{ id: string }> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const body = this.buildQueryString(audienceData);

    return this.makeRequest<{ id: string }>(
      `${formattedAccountId}/customaudiences`,
      "POST",
      body,
      formattedAccountId,
      true
    );
  }

  async createLookalikeAudience(
    accountId: string,
    audienceData: {
      name: string;
      origin_audience_id: string;
      country: string;
      ratio: number;
      description?: string;
    }
  ): Promise<{ id: string }> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const body = this.buildQueryString({
      ...audienceData,
      subtype: "LOOKALIKE",
      lookalike_spec: {
        ratio: audienceData.ratio,
        country: audienceData.country,
        type: "similarity",
      },
    });

    return this.makeRequest<{ id: string }>(
      `${formattedAccountId}/customaudiences`,
      "POST",
      body,
      formattedAccountId,
      true
    );
  }

  // Creative Methods
  async getAdCreatives(
    accountId: string,
    params: PaginationParams & { fields?: string[] } = {}
  ): Promise<PaginatedResult<AdCreative>> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const { fields, ...paginationParams } = params;

    const queryParams: Record<string, any> = {
      fields:
        fields?.join(",") ||
        "id,name,title,body,image_url,video_id,call_to_action,object_story_spec",
      ...paginationParams,
    };

    const query = this.buildQueryString(queryParams);
    const response = await this.makeRequest<MetaApiResponse<AdCreative>>(
      `${formattedAccountId}/adcreatives?${query}`,
      "GET",
      null,
      formattedAccountId
    );

    return PaginationHelper.parsePaginatedResponse(response);
  }

  async uploadAdImage(
    accountId: string,
    imageUrl: string
  ): Promise<{ hash: string; url: string }> {
    const formattedAccountId = this.auth.getAccountId(accountId);

    // Download the image first
    const imageResponse = await fetch(imageUrl);
    if (!imageResponse.ok) {
      throw new Error(`Failed to download image from ${imageUrl}: ${imageResponse.status}`);
    }
    const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
    const base64Image = imageBuffer.toString("base64");

    // Upload via bytes parameter
    const body = this.buildQueryString({ bytes: base64Image });

    const result = await this.makeRequest<{ images: Record<string, { hash: string; url: string }> }>(
      `${formattedAccountId}/adimages`,
      "POST",
      body,
      formattedAccountId,
      true
    );

    // Extract hash from response (key is filename)
    const imageData = Object.values(result.images)[0];
    if (!imageData) {
      throw new Error("No image data returned from upload");
    }
    return { hash: imageData.hash, url: imageData.url };
  }

  async createAdCreative(
    accountId: string,
    creativeData: {
      name: string;
      page_id: string;
      title?: string;
      body?: string;
      image_hash?: string;
      video_id?: string;
      call_to_action_type?: string;
      link_url?: string;
      display_link?: string;
    }
  ): Promise<{ id: string }> {
    const formattedAccountId = this.auth.getAccountId(accountId);

    // Build object_story_spec (required by Meta API)
    const linkData: any = {};
    if (creativeData.body) linkData.message = creativeData.body;
    if (creativeData.link_url) linkData.link = creativeData.link_url;
    if (creativeData.title) linkData.name = creativeData.title;
    if (creativeData.image_hash) linkData.image_hash = creativeData.image_hash;
    if (creativeData.display_link) linkData.caption = creativeData.display_link;
    if (creativeData.call_to_action_type) {
      linkData.call_to_action = { type: creativeData.call_to_action_type };
    }

    const objectStorySpec: any = {
      page_id: creativeData.page_id,
      link_data: linkData,
    };

    const params: any = {
      name: creativeData.name,
      object_story_spec: JSON.stringify(objectStorySpec),
    };

    const body = this.buildQueryString(params);

    return this.makeRequest<{ id: string }>(
      `${formattedAccountId}/adcreatives`,
      "POST",
      body,
      formattedAccountId,
      true
    );
  }

  // Batch Operations
  async batchRequest(requests: BatchRequest[]): Promise<BatchResponse[]> {
    const body = this.buildQueryString({
      batch: JSON.stringify(requests),
    });

    return this.makeRequest<BatchResponse[]>("", "POST", body, undefined, true);
  }

  // Utility Methods
  async estimateAudienceSize(
    accountId: string,
    targeting: any,
    optimizationGoal: string
  ): Promise<{ estimate_mau: number; estimate_dau?: number }> {
    const formattedAccountId = this.auth.getAccountId(accountId);
    const queryParams = {
      targeting_spec: targeting,
      optimization_goal: optimizationGoal,
    };

    const query = this.buildQueryString(queryParams);
    return this.makeRequest<{ estimate_mau: number; estimate_dau?: number }>(
      `${formattedAccountId}/delivery_estimate?${query}`,
      "GET",
      null,
      formattedAccountId
    );
  }

  async generateAdPreview(
    creativeId: string,
    adFormat: string,
    productItemIds?: string[]
  ): Promise<{ body: string }> {
    const queryParams: Record<string, any> = {
      ad_format: adFormat,
    };

    if (productItemIds && productItemIds.length > 0) {
      queryParams.product_item_ids = productItemIds;
    }

    const query = this.buildQueryString(queryParams);
    return this.makeRequest<{ body: string }>(
      `${creativeId}/previews?${query}`
    );
  }

  // Helper method to get account ID for rate limiting
  extractAccountIdFromObjectId(objectId: string): string | undefined {
    // Try to extract account ID from campaign/adset/ad ID patterns
    const campaign = objectId.match(/^(\d+)$/);
    if (campaign) {
      // For direct campaign/adset/ad IDs, we can't determine the account
      // This would need to be provided by the caller or cached
      return undefined;
    }

    // If it's already a formatted account ID
    if (objectId.startsWith("act_")) {
      return objectId;
    }

    return undefined;
  }
}
