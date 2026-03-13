export interface MetaApiConfig {
  accessToken: string;
  appId?: string;
  appSecret?: string;
  businessId?: string;
  apiVersion?: string;
  baseUrl?: string;
  // OAuth configuration
  redirectUri?: string;
  refreshToken?: string;
  tokenExpiration?: Date;
  autoRefresh?: boolean;
}

export interface AdAccount {
  id: string;
  name: string;
  account_status: number;
  balance: string;
  currency: string;
  timezone_name: string;
  business?: {
    id: string;
    name: string;
  };
}

export interface Campaign {
  id: string;
  name: string;
  objective: string;
  status: "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";
  effective_status: string;
  created_time: string;
  updated_time: string;
  start_time?: string;
  stop_time?: string;
  budget_remaining?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_strategy?: string;
  account_id: string;
}

export interface AdSet {
  id: string;
  name: string;
  campaign_id: string;
  status: "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";
  effective_status: string;
  created_time: string;
  updated_time: string;
  start_time?: string;
  end_time?: string;
  daily_budget?: string;
  lifetime_budget?: string;
  bid_amount?: string;
  billing_event?: string;
  optimization_goal?: string;
  targeting?: AdTargeting;
}

export interface Ad {
  id: string;
  name: string;
  adset_id: string;
  campaign_id: string;
  status: "ACTIVE" | "PAUSED" | "DELETED" | "ARCHIVED";
  effective_status: string;
  created_time: string;
  updated_time: string;
  creative?: AdCreative;
}

export interface AdCreative {
  id: string;
  name: string;
  title?: string;
  body?: string;
  image_url?: string;
  video_id?: string;
  call_to_action?: {
    type: string;
    value?: any;
  };
  object_story_spec?: any;
  url_tags?: string;
}

export interface AdTargeting {
  age_min?: number;
  age_max?: number;
  genders?: number[];
  geo_locations?: {
    countries?: string[];
    regions?: Array<{ key: string }>;
    cities?: Array<{ key: string; radius?: number; distance_unit?: string }>;
  };
  interests?: Array<{ id: string; name: string }>;
  behaviors?: Array<{ id: string; name: string }>;
  custom_audiences?: Array<{ id: string }>;
  excluded_custom_audiences?: Array<{ id: string }>;
  lookalike_audiences?: Array<{ id: string }>;
  device_platforms?: string[];
  publisher_platforms?: string[];
  facebook_positions?: string[];
  instagram_positions?: string[];
}

export interface AdInsights {
  impressions?: string;
  clicks?: string;
  spend?: string;
  reach?: string;
  frequency?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  cpp?: string;
  cost_per_action_type?: Array<{
    action_type: string;
    value: string;
  }>;
  actions?: Array<{
    action_type: string;
    value: string;
  }>;
  video_views?: string;
  video_view_time?: string;
  date_start?: string;
  date_stop?: string;
  account_id?: string;
  campaign_id?: string;
  adset_id?: string;
  ad_id?: string;
}

export interface CustomAudience {
  id: string;
  name: string;
  description?: string;
  subtype: string;
  approximate_count?: number;
  data_source?: {
    type: string;
    sub_type?: string;
  };
  retention_days?: number;
  rule?: any;
  creation_time: string;
  operation_status?: {
    code: number;
    description: string;
  };
}

export interface LookalikeAudience {
  id: string;
  name: string;
  description?: string;
  origin_audience_id: string;
  lookalike_spec: {
    ratio: number;
    country: string;
    type: string;
  };
  approximate_count?: number;
  creation_time: string;
  operation_status?: {
    code: number;
    description: string;
  };
}

export interface MetaApiError {
  error: {
    message: string;
    type: string;
    code: number;
    error_subcode?: number;
    error_user_title?: string;
    error_user_msg?: string;
    fbtrace_id?: string;
  };
}

export interface MetaApiResponse<T> {
  data: T[];
  paging?: {
    cursors?: {
      before?: string;
      after?: string;
    };
    next?: string;
    previous?: string;
  };
}

export interface BatchRequest {
  method: "GET" | "POST" | "DELETE";
  relative_url: string;
  body?: string;
}

export interface BatchResponse {
  code: number;
  headers: Array<{ name: string; value: string }>;
  body: string;
}

export type CampaignObjective =
  | "OUTCOME_APP_PROMOTION"
  | "OUTCOME_AWARENESS"
  | "OUTCOME_ENGAGEMENT"
  | "OUTCOME_LEADS"
  | "OUTCOME_SALES"
  | "OUTCOME_TRAFFIC";

export type OptimizationGoal =
  | "AD_RECALL_LIFT"
  | "APP_INSTALLS"
  | "BRAND_AWARENESS"
  | "CLICKS"
  | "CONVERSIONS"
  | "IMPRESSIONS"
  | "LANDING_PAGE_VIEWS"
  | "LEAD_GENERATION"
  | "LINK_CLICKS"
  | "NONE"
  | "OFFSITE_CONVERSIONS"
  | "PAGE_LIKES"
  | "POST_ENGAGEMENT"
  | "REACH"
  | "REPLIES"
  | "RETURN_ON_AD_SPEND"
  | "SOCIAL_IMPRESSIONS"
  | "THRUPLAY"
  | "TWO_SECOND_CONTINUOUS_VIDEO_VIEWS"
  | "VALUE"
  | "VIDEO_VIEWS";

export type BillingEvent =
  | "APP_INSTALLS"
  | "CLICKS"
  | "IMPRESSIONS"
  | "LINK_CLICKS"
  | "NONE"
  | "OFFER_CLAIMS"
  | "PAGE_LIKES"
  | "POST_ENGAGEMENT"
  | "THRUPLAY"
  | "PURCHASE"
  | "LISTING_INTERACTION";
