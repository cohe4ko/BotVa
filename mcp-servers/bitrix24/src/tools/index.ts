import { Tool } from '@modelcontextprotocol/sdk/types.js';
import { bitrix24Client, BitrixContact, BitrixDeal, BitrixTask, BitrixLead, BitrixCompany } from '../bitrix24/client.js';

// Contact Management Tools
export const createContactTool: Tool = {
  name: 'bitrix24_create_contact',
  description: 'Create a new contact in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string', description: 'First name' },
      lastName: { type: 'string', description: 'Last name' },
      phone: { type: 'string', description: 'Phone number' },
      email: { type: 'string', description: 'Email address' },
      company: { type: 'string', description: 'Company name' },
      position: { type: 'string', description: 'Job position' },
      comments: { type: 'string', description: 'Additional comments' }
    },
    required: ['name', 'lastName']
  }
};

export const getContactTool: Tool = {
  name: 'bitrix24_get_contact',
  description: 'Retrieve contact information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact ID' }
    },
    required: ['id']
  }
};

export const listContactsTool: Tool = {
  name: 'bitrix24_list_contacts',
  description: 'List contacts with optional filtering',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of contacts to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria (e.g., {"NAME": "John"})' }
    }
  }
};

export const getLatestContactsTool: Tool = {
  name: 'bitrix24_get_latest_contacts',
  description: 'Get the most recent contacts ordered by creation date',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of contacts to return', default: 20 }
    }
  }
};

export const updateContactTool: Tool = {
  name: 'bitrix24_update_contact',
  description: 'Update an existing contact in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Contact ID' },
      name: { type: 'string', description: 'First name' },
      lastName: { type: 'string', description: 'Last name' },
      phone: { type: 'string', description: 'Phone number' },
      email: { type: 'string', description: 'Email address' },
      company: { type: 'string', description: 'Company name' },
      position: { type: 'string', description: 'Job position' },
      comments: { type: 'string', description: 'Additional comments' }
    },
    required: ['id']
  }
};

// Deal Management Tools
export const createDealTool: Tool = {
  name: 'bitrix24_create_deal',
  description: 'Create a new deal in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Deal title' },
      amount: { type: 'string', description: 'Deal amount' },
      currency: { type: 'string', description: 'Currency code (e.g., EUR, USD)', default: 'EUR' },
      contactId: { type: 'string', description: 'Associated contact ID' },
      stageId: { type: 'string', description: 'Deal stage ID' },
      comments: { type: 'string', description: 'Deal comments' }
    },
    required: ['title']
  }
};

export const getDealTool: Tool = {
  name: 'bitrix24_get_deal',
  description: 'Retrieve deal information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Deal ID' }
    },
    required: ['id']
  }
};

export const listDealsTool: Tool = {
  name: 'bitrix24_list_deals',
  description: 'List deals with optional filtering and ordering',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of deals to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria (e.g., {"TITLE": "Project"})' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const updateDealTool: Tool = {
  name: 'bitrix24_update_deal',
  description: 'Update an existing deal in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Deal ID' },
      title: { type: 'string', description: 'Deal title' },
      amount: { type: 'string', description: 'Deal amount' },
      currency: { type: 'string', description: 'Currency code (e.g., EUR, USD)' },
      contactId: { type: 'string', description: 'Associated contact ID' },
      stageId: { type: 'string', description: 'Deal stage ID' },
      comments: { type: 'string', description: 'Deal comments' }
    },
    required: ['id']
  }
};

export const getLatestDealsTool: Tool = {
  name: 'bitrix24_get_latest_deals',
  description: 'Get the most recent deals ordered by creation date',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of deals to return', default: 20 }
    }
  }
};

export const getDealsFromDateRangeTool: Tool = {
  name: 'bitrix24_get_deals_from_date_range',
  description: 'Get deals created within a specific date range',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional)' },
      limit: { type: 'number', description: 'Maximum number of deals to return', default: 50 }
    },
    required: ['startDate']
  }
};

// Lead Management Tools
export const createLeadTool: Tool = {
  name: 'bitrix24_create_lead',
  description: 'Create a new lead in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Lead title' },
      name: { type: 'string', description: 'First name' },
      lastName: { type: 'string', description: 'Last name' },
      company: { type: 'string', description: 'Company name' },
      phone: { type: 'string', description: 'Phone number' },
      email: { type: 'string', description: 'Email address' },
      sourceId: { type: 'string', description: 'Lead source ID (e.g., CALL, EMAIL, WEB)' },
      statusId: { type: 'string', description: 'Lead status ID' },
      opportunity: { type: 'string', description: 'Expected deal amount' },
      currency: { type: 'string', description: 'Currency code (e.g., EUR, USD)', default: 'EUR' },
      comments: { type: 'string', description: 'Additional comments' }
    },
    required: ['title']
  }
};

export const getLeadTool: Tool = {
  name: 'bitrix24_get_lead',
  description: 'Retrieve lead information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Lead ID' }
    },
    required: ['id']
  }
};

export const listLeadsTool: Tool = {
  name: 'bitrix24_list_leads',
  description: 'List leads with optional filtering and ordering',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of leads to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria (e.g., {"STATUS_ID": "NEW"})' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const getLatestLeadsTool: Tool = {
  name: 'bitrix24_get_latest_leads',
  description: 'Get the most recent leads ordered by creation date',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of leads to return', default: 20 }
    }
  }
};

export const getLeadsFromDateRangeTool: Tool = {
  name: 'bitrix24_get_leads_from_date_range',
  description: 'Get leads created within a specific date range',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional)' },
      limit: { type: 'number', description: 'Maximum number of leads to return', default: 50 }
    },
    required: ['startDate']
  }
};

export const updateLeadTool: Tool = {
  name: 'bitrix24_update_lead',
  description: 'Update an existing lead in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Lead ID' },
      title: { type: 'string', description: 'Lead title' },
      name: { type: 'string', description: 'First name' },
      lastName: { type: 'string', description: 'Last name' },
      company: { type: 'string', description: 'Company name' },
      phone: { type: 'string', description: 'Phone number' },
      email: { type: 'string', description: 'Email address' },
      sourceId: { type: 'string', description: 'Lead source ID' },
      statusId: { type: 'string', description: 'Lead status ID' },
      opportunity: { type: 'string', description: 'Expected deal amount' },
      currency: { type: 'string', description: 'Currency code' },
      comments: { type: 'string', description: 'Additional comments' }
    },
    required: ['id']
  }
};

// Company Management Tools
export const createCompanyTool: Tool = {
  name: 'bitrix24_create_company',
  description: 'Create a new company in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Company name' },
      companyType: { type: 'string', description: 'Company type (e.g., CLIENT, SUPPLIER, PARTNER)' },
      industry: { type: 'string', description: 'Industry sector' },
      phone: { type: 'string', description: 'Company phone number' },
      email: { type: 'string', description: 'Company email address' },
      website: { type: 'string', description: 'Company website URL' },
      address: { type: 'string', description: 'Company address' },
      employees: { type: 'string', description: 'Number of employees' },
      revenue: { type: 'string', description: 'Annual revenue' },
      comments: { type: 'string', description: 'Additional comments' },
      assignedById: { type: 'string', description: 'Assigned user ID' }
    },
    required: ['title']
  }
};

export const getCompanyTool: Tool = {
  name: 'bitrix24_get_company',
  description: 'Retrieve company information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Company ID' }
    },
    required: ['id']
  }
};

export const listCompaniesTool: Tool = {
  name: 'bitrix24_list_companies',
  description: 'List companies with optional filtering and ordering',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of companies to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria (e.g., {"TITLE": "Tech Corp"})' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const updateCompanyTool: Tool = {
  name: 'bitrix24_update_company',
  description: 'Update an existing company in Bitrix24 CRM',
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string', description: 'Company ID' },
      title: { type: 'string', description: 'Company name' },
      companyType: { type: 'string', description: 'Company type' },
      industry: { type: 'string', description: 'Industry sector' },
      phone: { type: 'string', description: 'Company phone number' },
      email: { type: 'string', description: 'Company email address' },
      website: { type: 'string', description: 'Company website URL' },
      address: { type: 'string', description: 'Company address' },
      employees: { type: 'string', description: 'Number of employees' },
      revenue: { type: 'string', description: 'Annual revenue' },
      comments: { type: 'string', description: 'Additional comments' },
      assignedById: { type: 'string', description: 'Assigned user ID' }
    },
    required: ['id']
  }
};

export const getLatestCompaniesTool: Tool = {
  name: 'bitrix24_get_latest_companies',
  description: 'Get the most recent companies ordered by creation date',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of companies to return', default: 20 }
    }
  }
};

export const getCompaniesFromDateRangeTool: Tool = {
  name: 'bitrix24_get_companies_from_date_range',
  description: 'Get companies created within a specific date range',
  inputSchema: {
    type: 'object',
    properties: {
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional)' },
      limit: { type: 'number', description: 'Maximum number of companies to return', default: 50 }
    },
    required: ['startDate']
  }
};

// Search and Utility Tools
export const searchCRMTool: Tool = {
  name: 'bitrix24_search_crm',
  description: 'Search across CRM entities (contacts, companies, deals, leads)',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (email, phone, name)' },
      entityTypes: {
        type: 'array',
        items: { type: 'string', enum: ['contact', 'company', 'deal', 'lead'] },
        description: 'Entity types to search',
        default: ['contact', 'company', 'deal', 'lead']
      }
    },
    required: ['query']
  }
};


export const validateWebhookTool: Tool = {
  name: 'bitrix24_validate_webhook',
  description: 'Validate the Bitrix24 webhook connection',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

// Diagnostic Tools
export const diagnosePermissionsTool: Tool = {
  name: 'bitrix24_diagnose_permissions',
  description: 'Diagnose webhook permissions and access to different CRM entities',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export const checkCRMSettingsTool: Tool = {
  name: 'bitrix24_check_crm_settings',
  description: 'Check CRM settings including lead fields, statuses, and mode',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export const testLeadsAPITool: Tool = {
  name: 'bitrix24_test_leads_api',
  description: 'Test various leads API endpoints to identify specific issues',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

// Enhanced Deal Filtering Tools (Phase 1)
export const getDealPipelinesTool: Tool = {
  name: 'bitrix24_get_deal_pipelines',
  description: 'Get all available deal pipelines/categories with their IDs and names',
  inputSchema: {
    type: 'object',
    properties: {}
  }
};

export const getDealStagesTool: Tool = {
  name: 'bitrix24_get_deal_stages',
  description: 'Get all deal stages for a specific pipeline or all pipelines',
  inputSchema: {
    type: 'object',
    properties: {
      pipelineId: { 
        type: 'string', 
        description: 'Pipeline ID to get stages for (optional - if not provided, gets all stages)' 
      }
    }
  }
};

export const filterDealsByPipelineTool: Tool = {
  name: 'bitrix24_filter_deals_by_pipeline',
  description: 'Filter deals by specific pipeline/category ID',
  inputSchema: {
    type: 'object',
    properties: {
      pipelineId: { 
        type: 'string', 
        description: 'Pipeline/Category ID to filter by' 
      },
      limit: { 
        type: 'number', 
        description: 'Maximum number of deals to return', 
        default: 50 
      },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE', 'OPPORTUNITY'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    },
    required: ['pipelineId']
  }
};

export const filterDealsByBudgetTool: Tool = {
  name: 'bitrix24_filter_deals_by_budget',
  description: 'Filter deals by budget/opportunity amount range',
  inputSchema: {
    type: 'object',
    properties: {
      minBudget: { 
        type: 'number', 
        description: 'Minimum budget amount' 
      },
      maxBudget: { 
        type: 'number', 
        description: 'Maximum budget amount (optional)' 
      },
      currency: { 
        type: 'string', 
        description: 'Currency code (e.g., EUR, USD)', 
        default: 'EUR' 
      },
      limit: { 
        type: 'number', 
        description: 'Maximum number of deals to return', 
        default: 50 
      },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE', 'OPPORTUNITY'],
        description: 'Field to order by',
        default: 'OPPORTUNITY'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    },
    required: ['minBudget']
  }
};

export const filterDealsByStatusTool: Tool = {
  name: 'bitrix24_filter_deals_by_status',
  description: 'Filter deals by stage/status IDs',
  inputSchema: {
    type: 'object',
    properties: {
      stageIds: { 
        type: 'array',
        items: { type: 'string' },
        description: 'Array of stage IDs to filter by' 
      },
      pipelineId: { 
        type: 'string', 
        description: 'Pipeline ID to limit search to (optional)' 
      },
      limit: { 
        type: 'number', 
        description: 'Maximum number of deals to return', 
        default: 50 
      },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE', 'OPPORTUNITY'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    },
    required: ['stageIds']
  }
};

// Sales Team Monitoring Tools
export const monitorUserActivitiesTool: Tool = {
  name: 'bitrix24_monitor_user_activities',
  description: 'Monitor user activities including calls, emails, timeline interactions, and response times',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User ID to monitor (optional - if not provided, monitors all users)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeCallVolume: { type: 'boolean', description: 'Include call volume metrics', default: true },
      includeEmailActivity: { type: 'boolean', description: 'Include email activity metrics', default: true },
      includeTimelineActivity: { type: 'boolean', description: 'Include timeline interactions', default: true },
      includeResponseTimes: { type: 'boolean', description: 'Calculate response times', default: true }
    },
    required: ['startDate']
  }
};

export const getUserPerformanceSummaryTool: Tool = {
  name: 'bitrix24_get_user_performance_summary',
  description: 'Get comprehensive performance summary for users including deal metrics and conversion rates',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User ID to analyze (optional - if not provided, analyzes all users)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeDealMetrics: { type: 'boolean', description: 'Include deal creation/conversion metrics', default: true },
      includeActivityRatios: { type: 'boolean', description: 'Include activity type ratios', default: true },
      includeConversionRates: { type: 'boolean', description: 'Calculate conversion rates', default: true }
    },
    required: ['startDate']
  }
};

export const analyzeAccountPerformanceTool: Tool = {
  name: 'bitrix24_analyze_account_performance',
  description: 'Analyze performance and activities for specific accounts (companies/contacts)',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'Account ID (company or contact ID)' },
      accountType: { type: 'string', enum: ['company', 'contact'], description: 'Type of account to analyze' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeAllInteractions: { type: 'boolean', description: 'Include all user interactions with this account', default: true },
      includeDealProgression: { type: 'boolean', description: 'Include deal progression analysis', default: true },
      includeTimelineHistory: { type: 'boolean', description: 'Include complete timeline history', default: true }
    },
    required: ['accountId', 'accountType', 'startDate']
  }
};

export const compareUserPerformanceTool: Tool = {
  name: 'bitrix24_compare_user_performance',
  description: 'Compare performance metrics between multiple users',
  inputSchema: {
    type: 'object',
    properties: {
      userIds: { type: 'array', items: { type: 'string' }, description: 'Array of user IDs to compare (optional - if not provided, compares all users)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      metrics: { 
        type: 'array', 
        items: { type: 'string', enum: ['activities', 'deals', 'conversions', 'response_times', 'timeline_engagement'] },
        description: 'Specific metrics to compare',
        default: ['activities', 'deals', 'conversions']
      },
      includeRankings: { type: 'boolean', description: 'Include performance rankings', default: true },
      includeTrends: { type: 'boolean', description: 'Include trend analysis', default: true }
    },
    required: ['startDate']
  }
};

export const trackDealProgressionTool: Tool = {
  name: 'bitrix24_track_deal_progression',
  description: 'Track deal progression through pipeline stages with timing analysis',
  inputSchema: {
    type: 'object',
    properties: {
      dealId: { type: 'string', description: 'Specific deal ID to track (optional - if not provided, tracks all deals)' },
      userId: { type: 'string', description: 'User ID to filter deals (optional)' },
      pipelineId: { type: 'string', description: 'Pipeline ID to filter deals (optional)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeStageDuration: { type: 'boolean', description: 'Calculate time spent in each stage', default: true },
      identifyStalled: { type: 'boolean', description: 'Identify stalled deals', default: true },
      calculateVelocity: { type: 'boolean', description: 'Calculate pipeline velocity', default: true }
    },
    required: ['startDate']
  }
};

export const monitorSalesActivitiesTool: Tool = {
  name: 'bitrix24_monitor_sales_activities',
  description: 'Monitor sales-related activities including tasks, follow-ups, and meetings',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User ID to monitor (optional - if not provided, monitors all users)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeTaskCompletion: { type: 'boolean', description: 'Include task completion rates', default: true },
      includeFollowUpTracking: { type: 'boolean', description: 'Include follow-up tracking', default: true },
      includeMeetingTracking: { type: 'boolean', description: 'Include meeting tracking', default: true },
      includeQuoteActivity: { type: 'boolean', description: 'Include quote/proposal activity', default: true }
    },
    required: ['startDate']
  }
};

export const generateSalesReportTool: Tool = {
  name: 'bitrix24_generate_sales_report',
  description: 'Generate comprehensive sales report with customizable metrics and date ranges',
  inputSchema: {
    type: 'object',
    properties: {
      reportType: { 
        type: 'string', 
        enum: ['user_performance', 'account_analysis', 'team_summary', 'pipeline_analysis', 'activity_report'],
        description: 'Type of report to generate'
      },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      userIds: { type: 'array', items: { type: 'string' }, description: 'Specific user IDs to include (optional)' },
      includeMetrics: { 
        type: 'array', 
        items: { type: 'string', enum: ['revenue', 'conversion_rates', 'activity_volumes', 'response_times', 'deal_progression'] },
        description: 'Specific metrics to include in report',
        default: ['revenue', 'conversion_rates', 'activity_volumes']
      },
      includeTrendAnalysis: { type: 'boolean', description: 'Include trend analysis', default: true },
      includeComparisons: { type: 'boolean', description: 'Include performance comparisons', default: true }
    },
    required: ['reportType', 'startDate']
  }
};

export const getTeamDashboardTool: Tool = {
  name: 'bitrix24_get_team_dashboard',
  description: 'Get real-time team performance dashboard with key metrics and alerts',
  inputSchema: {
    type: 'object',
    properties: {
      includeRealTimeMetrics: { type: 'boolean', description: 'Include real-time performance metrics', default: true },
      includeTopPerformers: { type: 'boolean', description: 'Include top performers identification', default: true },
      includeAttentionNeeded: { type: 'boolean', description: 'Include accounts/deals needing attention', default: true },
      includeWorkloadDistribution: { type: 'boolean', description: 'Include workload distribution analysis', default: true },
      timeframe: { 
        type: 'string', 
        enum: ['today', 'week', 'month', 'quarter'],
        description: 'Timeframe for dashboard metrics',
        default: 'today'
      }
    }
  }
};

export const analyzeCustomerEngagementTool: Tool = {
  name: 'bitrix24_analyze_customer_engagement',
  description: 'Analyze customer engagement patterns and relationship health',
  inputSchema: {
    type: 'object',
    properties: {
      accountId: { type: 'string', description: 'Account ID (company or contact ID) - optional' },
      accountType: { type: 'string', enum: ['company', 'contact'], description: 'Type of account' },
      userId: { type: 'string', description: 'User ID to filter analysis (optional)' },
      startDate: { type: 'string', description: 'Start date in YYYY-MM-DD format' },
      endDate: { type: 'string', description: 'End date in YYYY-MM-DD format (optional - defaults to today)' },
      includeCommunicationPatterns: { type: 'boolean', description: 'Include communication pattern analysis', default: true },
      includeResponseQuality: { type: 'boolean', description: 'Include response quality metrics', default: true },
      includeEngagementScores: { type: 'boolean', description: 'Calculate engagement scores', default: true },
      includeRelationshipHealth: { type: 'boolean', description: 'Assess relationship health', default: true }
    },
    required: ['startDate']
  }
};

export const forecastPerformanceTool: Tool = {
  name: 'bitrix24_forecast_performance',
  description: 'Generate performance forecasts and predictive analytics',
  inputSchema: {
    type: 'object',
    properties: {
      forecastType: { 
        type: 'string', 
        enum: ['pipeline_forecast', 'user_performance', 'revenue_prediction', 'goal_achievement'],
        description: 'Type of forecast to generate'
      },
      userId: { type: 'string', description: 'User ID to forecast (optional - if not provided, forecasts for all users)' },
      historicalPeriod: { 
        type: 'string', 
        enum: ['3_months', '6_months', '1_year'],
        description: 'Historical period to use for forecasting',
        default: '6_months'
      },
      forecastPeriod: { 
        type: 'string', 
        enum: ['1_month', '3_months', '6_months'],
        description: 'Period to forecast into the future',
        default: '1_month'
      },
      includePipelineAnalysis: { type: 'boolean', description: 'Include pipeline forecasting', default: true },
      includeRiskAssessment: { type: 'boolean', description: 'Include risk assessment', default: true },
      includeGoalTracking: { type: 'boolean', description: 'Include goal achievement tracking', default: true }
    },
    required: ['forecastType']
  }
};

// User Management Tools
export const getUserTool: Tool = {
  name: 'bitrix24_get_user',
  description: 'Get user information by ID',
  inputSchema: {
    type: 'object',
    properties: {
      userId: { type: 'string', description: 'User ID to retrieve' }
    },
    required: ['userId']
  }
};

export const getAllUsersTool: Tool = {
  name: 'bitrix24_get_all_users',
  description: 'Get all users in the system with their names and details',
  inputSchema: {
    type: 'object',
    properties: {
      includeInactive: { type: 'boolean', description: 'Include inactive users', default: false }
    }
  }
};

export const resolveUserNamesTool: Tool = {
  name: 'bitrix24_resolve_user_names',
  description: 'Resolve user IDs to user names',
  inputSchema: {
    type: 'object',
    properties: {
      userIds: { 
        type: 'array', 
        items: { type: 'string' },
        description: 'Array of user IDs to resolve to names' 
      }
    },
    required: ['userIds']
  }
};

export const getContactsWithUserNamesTool: Tool = {
  name: 'bitrix24_get_contacts_with_user_names',
  description: 'Get contacts with user names resolved (assigned, created, modified by)',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of contacts to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria' }
    }
  }
};

export const getDealsWithUserNamesTool: Tool = {
  name: 'bitrix24_get_deals_with_user_names',
  description: 'Get deals with user names resolved (assigned, created, modified by)',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of deals to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE', 'OPPORTUNITY'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const getLeadsWithUserNamesTool: Tool = {
  name: 'bitrix24_get_leads_with_user_names',
  description: 'Get leads with user names resolved (assigned, created, modified by)',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of leads to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

export const getCompaniesWithUserNamesTool: Tool = {
  name: 'bitrix24_get_companies_with_user_names',
  description: 'Get companies with user names resolved (assigned, created, modified by)',
  inputSchema: {
    type: 'object',
    properties: {
      limit: { type: 'number', description: 'Maximum number of companies to return', default: 20 },
      filter: { type: 'object', description: 'Filter criteria' },
      orderBy: { 
        type: 'string', 
        enum: ['DATE_CREATE', 'DATE_MODIFY', 'ID', 'TITLE'],
        description: 'Field to order by',
        default: 'DATE_CREATE'
      },
      orderDirection: {
        type: 'string',
        enum: ['ASC', 'DESC'],
        description: 'Order direction',
        default: 'DESC'
      }
    }
  }
};

// Export all tools
export const allTools = [
  createContactTool,
  getContactTool,
  listContactsTool,
  getLatestContactsTool,
  updateContactTool,
  createDealTool,
  getDealTool,
  listDealsTool,
  getLatestDealsTool,
  getDealsFromDateRangeTool,
  updateDealTool,
  createLeadTool,
  getLeadTool,
  listLeadsTool,
  getLatestLeadsTool,
  getLeadsFromDateRangeTool,
  updateLeadTool,
  createCompanyTool,
  getCompanyTool,
  listCompaniesTool,
  updateCompanyTool,
  getLatestCompaniesTool,
  getCompaniesFromDateRangeTool,
  searchCRMTool,
  validateWebhookTool,
  diagnosePermissionsTool,
  checkCRMSettingsTool,
  testLeadsAPITool,
  // Phase 1: Enhanced Deal Filtering Tools
  getDealPipelinesTool,
  getDealStagesTool,
  filterDealsByPipelineTool,
  filterDealsByBudgetTool,
  filterDealsByStatusTool,
  // Sales Team Monitoring Tools
  monitorUserActivitiesTool,
  getUserPerformanceSummaryTool,
  analyzeAccountPerformanceTool,
  compareUserPerformanceTool,
  trackDealProgressionTool,
  monitorSalesActivitiesTool,
  generateSalesReportTool,
  getTeamDashboardTool,
  analyzeCustomerEngagementTool,
  forecastPerformanceTool,
  // User Management Tools
  getUserTool,
  getAllUsersTool,
  resolveUserNamesTool,
  getContactsWithUserNamesTool,
  getDealsWithUserNamesTool,
  getLeadsWithUserNamesTool,
  getCompaniesWithUserNamesTool
];

// Tool execution handlers
export async function executeToolCall(name: string, args: any): Promise<any> {
  try {
    switch (name) {
      case 'bitrix24_create_contact':
        const contact: BitrixContact = {
          NAME: args.name,
          LAST_NAME: args.lastName,
          PHONE: args.phone ? [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }] : undefined,
          EMAIL: args.email ? [{ VALUE: args.email, VALUE_TYPE: 'WORK' }] : undefined,
          COMPANY_TITLE: args.company,
          POST: args.position,
          COMMENTS: args.comments
        };
        const contactId = await bitrix24Client.createContact(contact);
        return { success: true, contactId, message: `Contact created with ID: ${contactId}` };

      case 'bitrix24_get_contact':
        const contactData = await bitrix24Client.getContact(args.id);
        return { success: true, contact: contactData };

      case 'bitrix24_list_contacts':
        const contacts = await bitrix24Client.listContacts({
          start: 0,
          filter: args.filter
        });
        return { success: true, contacts: contacts.slice(0, args.limit || 20) };

      case 'bitrix24_get_latest_contacts':
        const latestContacts = await bitrix24Client.getLatestContacts(args.limit || 20);
        return { success: true, contacts: latestContacts };

      case 'bitrix24_update_contact':
        const updateContact: Partial<BitrixContact> = {};
        if (args.name) updateContact.NAME = args.name;
        if (args.lastName) updateContact.LAST_NAME = args.lastName;
        if (args.phone) updateContact.PHONE = [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }];
        if (args.email) updateContact.EMAIL = [{ VALUE: args.email, VALUE_TYPE: 'WORK' }];
        if (args.company) updateContact.COMPANY_TITLE = args.company;
        if (args.position) updateContact.POST = args.position;
        if (args.comments) updateContact.COMMENTS = args.comments;
        
        const contactUpdated = await bitrix24Client.updateContact(args.id, updateContact);
        return { success: true, updated: contactUpdated, message: `Contact ${args.id} updated successfully` };

      case 'bitrix24_create_deal':
        const deal: BitrixDeal = {
          TITLE: args.title,
          OPPORTUNITY: args.amount,
          CURRENCY_ID: args.currency || 'EUR',
          CONTACT_ID: args.contactId,
          STAGE_ID: args.stageId,
          COMMENTS: args.comments
        };
        const dealId = await bitrix24Client.createDeal(deal);
        return { success: true, dealId, message: `Deal created with ID: ${dealId}` };

      case 'bitrix24_get_deal':
        const dealData = await bitrix24Client.getDeal(args.id);
        return { success: true, deal: dealData };

      case 'bitrix24_list_deals':
        const dealOrder: Record<string, string> = {};
        dealOrder[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const deals = await bitrix24Client.listDeals({
          start: 0,
          filter: args.filter,
          order: dealOrder,
          select: ['*']
        });
        return { success: true, deals: deals.slice(0, args.limit || 20) };

      case 'bitrix24_get_latest_deals':
        const latestDeals = await bitrix24Client.getLatestDeals(args.limit || 20);
        return { success: true, deals: latestDeals };

      case 'bitrix24_get_deals_from_date_range':
        const dateRangeDeals = await bitrix24Client.getDealsFromDateRange(
          args.startDate,
          args.endDate,
          args.limit || 50
        );
        return { success: true, deals: dateRangeDeals };

      case 'bitrix24_update_deal':
        const updateDeal: Partial<BitrixDeal> = {};
        if (args.title) updateDeal.TITLE = args.title;
        if (args.amount) updateDeal.OPPORTUNITY = args.amount;
        if (args.currency) updateDeal.CURRENCY_ID = args.currency;
        if (args.contactId) updateDeal.CONTACT_ID = args.contactId;
        if (args.stageId) updateDeal.STAGE_ID = args.stageId;
        if (args.comments) updateDeal.COMMENTS = args.comments;
        
        const dealUpdated = await bitrix24Client.updateDeal(args.id, updateDeal);
        return { success: true, updated: dealUpdated, message: `Deal ${args.id} updated successfully` };

      case 'bitrix24_create_lead':
        const lead: BitrixLead = {
          TITLE: args.title,
          NAME: args.name,
          LAST_NAME: args.lastName,
          COMPANY_TITLE: args.company,
          PHONE: args.phone ? [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }] : undefined,
          EMAIL: args.email ? [{ VALUE: args.email, VALUE_TYPE: 'WORK' }] : undefined,
          SOURCE_ID: args.sourceId,
          STATUS_ID: args.statusId,
          OPPORTUNITY: args.opportunity,
          CURRENCY_ID: args.currency || 'EUR',
          COMMENTS: args.comments
        };
        const leadId = await bitrix24Client.createLead(lead);
        return { success: true, leadId, message: `Lead created with ID: ${leadId}` };

      case 'bitrix24_get_lead':
        const leadData = await bitrix24Client.getLead(args.id);
        return { success: true, lead: leadData };

      case 'bitrix24_list_leads':
        const leadOrder: Record<string, string> = {};
        leadOrder[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const leads = await bitrix24Client.listLeads({
          start: 0,
          filter: args.filter,
          order: leadOrder,
          select: ['*']
        });
        return { success: true, leads: leads.slice(0, args.limit || 20) };

      case 'bitrix24_get_latest_leads':
        const latestLeads = await bitrix24Client.getLatestLeads(args.limit || 20);
        return { success: true, leads: latestLeads };

      case 'bitrix24_get_leads_from_date_range':
        const dateRangeLeads = await bitrix24Client.getLeadsFromDateRange(
          args.startDate,
          args.endDate,
          args.limit || 50
        );
        return { success: true, leads: dateRangeLeads };

      case 'bitrix24_update_lead':
        const updateLead: Partial<BitrixLead> = {};
        if (args.title) updateLead.TITLE = args.title;
        if (args.name) updateLead.NAME = args.name;
        if (args.lastName) updateLead.LAST_NAME = args.lastName;
        if (args.company) updateLead.COMPANY_TITLE = args.company;
        if (args.phone) updateLead.PHONE = [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }];
        if (args.email) updateLead.EMAIL = [{ VALUE: args.email, VALUE_TYPE: 'WORK' }];
        if (args.sourceId) updateLead.SOURCE_ID = args.sourceId;
        if (args.statusId) updateLead.STATUS_ID = args.statusId;
        if (args.opportunity) updateLead.OPPORTUNITY = args.opportunity;
        if (args.currency) updateLead.CURRENCY_ID = args.currency;
        if (args.comments) updateLead.COMMENTS = args.comments;
        
        const leadUpdated = await bitrix24Client.updateLead(args.id, updateLead);
        return { success: true, updated: leadUpdated, message: `Lead ${args.id} updated successfully` };

      case 'bitrix24_create_company':
        const company: BitrixCompany = {
          TITLE: args.title,
          COMPANY_TYPE: args.companyType,
          INDUSTRY: args.industry,
          PHONE: args.phone ? [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }] : undefined,
          EMAIL: args.email ? [{ VALUE: args.email, VALUE_TYPE: 'WORK' }] : undefined,
          WEB: args.website ? [{ VALUE: args.website, VALUE_TYPE: 'WORK' }] : undefined,
          ADDRESS: args.address,
          EMPLOYEES: args.employees,
          REVENUE: args.revenue,
          COMMENTS: args.comments,
          ASSIGNED_BY_ID: args.assignedById
        };
        const companyId = await bitrix24Client.createCompany(company);
        return { success: true, companyId, message: `Company created with ID: ${companyId}` };

      case 'bitrix24_get_company':
        const companyData = await bitrix24Client.getCompany(args.id);
        return { success: true, company: companyData };

      case 'bitrix24_list_companies':
        const companyOrder: Record<string, string> = {};
        companyOrder[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const companies = await bitrix24Client.listCompanies({
          start: 0,
          filter: args.filter,
          order: companyOrder,
          select: ['*']
        });
        return { success: true, companies: companies.slice(0, args.limit || 20) };

      case 'bitrix24_update_company':
        const updateCompany: Partial<BitrixCompany> = {};
        if (args.title) updateCompany.TITLE = args.title;
        if (args.companyType) updateCompany.COMPANY_TYPE = args.companyType;
        if (args.industry) updateCompany.INDUSTRY = args.industry;
        if (args.phone) updateCompany.PHONE = [{ VALUE: args.phone, VALUE_TYPE: 'WORK' }];
        if (args.email) updateCompany.EMAIL = [{ VALUE: args.email, VALUE_TYPE: 'WORK' }];
        if (args.website) updateCompany.WEB = [{ VALUE: args.website, VALUE_TYPE: 'WORK' }];
        if (args.address) updateCompany.ADDRESS = args.address;
        if (args.employees) updateCompany.EMPLOYEES = args.employees;
        if (args.revenue) updateCompany.REVENUE = args.revenue;
        if (args.comments) updateCompany.COMMENTS = args.comments;
        if (args.assignedById) updateCompany.ASSIGNED_BY_ID = args.assignedById;
        
        const companyUpdated = await bitrix24Client.updateCompany(args.id, updateCompany);
        return { success: true, updated: companyUpdated, message: `Company ${args.id} updated successfully` };

      case 'bitrix24_get_latest_companies':
        const latestCompanies = await bitrix24Client.getLatestCompanies(args.limit || 20);
        return { success: true, companies: latestCompanies };

      case 'bitrix24_get_companies_from_date_range':
        const dateRangeCompanies = await bitrix24Client.getCompaniesFromDateRange(
          args.startDate,
          args.endDate,
          args.limit || 50
        );
        return { success: true, companies: dateRangeCompanies };

      case 'bitrix24_search_crm':
        const searchResults = await bitrix24Client.searchCRM(args.query, args.entityTypes);
        return { success: true, results: searchResults };

      case 'bitrix24_validate_webhook':
        const isValid = await bitrix24Client.validateWebhook();
        return { success: true, valid: isValid, message: isValid ? 'Webhook is valid' : 'Webhook validation failed' };

      case 'bitrix24_diagnose_permissions':
        const permissionResults = await bitrix24Client.diagnosePermissions();
        return { success: true, diagnosis: permissionResults };

      case 'bitrix24_check_crm_settings':
        const crmSettings = await bitrix24Client.checkCRMSettings();
        return { success: true, settings: crmSettings };

      case 'bitrix24_test_leads_api':
        const leadsTest = await bitrix24Client.testLeadsAPI();
        return { success: true, tests: leadsTest };

      // Phase 1: Enhanced Deal Filtering Tools
      case 'bitrix24_get_deal_pipelines':
        const pipelines = await bitrix24Client.getDealPipelines();
        return { success: true, pipelines, message: `Found ${pipelines.length} deal pipelines` };

      case 'bitrix24_get_deal_stages':
        const stages = await bitrix24Client.getDealStages(args.pipelineId);
        return { success: true, stages, message: `Found ${stages.length} deal stages` };

      case 'bitrix24_filter_deals_by_pipeline':
        const pipelineDeals = await bitrix24Client.filterDealsByPipeline(args.pipelineId, {
          limit: args.limit,
          orderBy: args.orderBy,
          orderDirection: args.orderDirection
        });
        return { 
          success: true, 
          deals: pipelineDeals, 
          count: pipelineDeals.length,
          message: `Found ${pipelineDeals.length} deals in pipeline ${args.pipelineId}` 
        };

      case 'bitrix24_filter_deals_by_budget':
        const budgetDeals = await bitrix24Client.filterDealsByBudget(
          args.minBudget, 
          args.maxBudget, 
          args.currency || 'EUR',
          {
            limit: args.limit,
            orderBy: args.orderBy,
            orderDirection: args.orderDirection
          }
        );
        const budgetMessage = args.maxBudget 
          ? `Found ${budgetDeals.length} deals with budget between ${args.minBudget} and ${args.maxBudget} ${args.currency || 'EUR'}`
          : `Found ${budgetDeals.length} deals with budget ≥ ${args.minBudget} ${args.currency || 'EUR'}`;
        return { 
          success: true, 
          deals: budgetDeals, 
          count: budgetDeals.length,
          message: budgetMessage
        };

      case 'bitrix24_filter_deals_by_status':
        const statusDeals = await bitrix24Client.filterDealsByStatus(
          args.stageIds, 
          args.pipelineId,
          {
            limit: args.limit,
            orderBy: args.orderBy,
            orderDirection: args.orderDirection
          }
        );
        const statusMessage = args.pipelineId
          ? `Found ${statusDeals.length} deals with stages [${args.stageIds.join(', ')}] in pipeline ${args.pipelineId}`
          : `Found ${statusDeals.length} deals with stages [${args.stageIds.join(', ')}]`;
        return { 
          success: true, 
          deals: statusDeals, 
          count: statusDeals.length,
          message: statusMessage
        };

      // Sales Team Monitoring Tools
      case 'bitrix24_monitor_user_activities':
        const userActivities = await bitrix24Client.monitorUserActivities(
          args.userId,
          args.startDate,
          args.endDate,
          {
            includeCallVolume: args.includeCallVolume,
            includeEmailActivity: args.includeEmailActivity,
            includeTimelineActivity: args.includeTimelineActivity,
            includeResponseTimes: args.includeResponseTimes
          }
        );
        return { 
          success: true, 
          activities: userActivities,
          message: `User activity monitoring completed for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_get_user_performance_summary':
        const performanceSummary = await bitrix24Client.getUserPerformanceSummary(
          args.userId,
          args.startDate,
          args.endDate,
          {
            includeDealMetrics: args.includeDealMetrics,
            includeActivityRatios: args.includeActivityRatios,
            includeConversionRates: args.includeConversionRates
          }
        );
        return { 
          success: true, 
          performance: performanceSummary,
          message: `Performance summary generated for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_analyze_account_performance':
        const accountPerformance = await bitrix24Client.analyzeAccountPerformance(
          args.accountId,
          args.accountType,
          args.startDate,
          args.endDate,
          {
            includeAllInteractions: args.includeAllInteractions,
            includeDealProgression: args.includeDealProgression,
            includeTimelineHistory: args.includeTimelineHistory
          }
        );
        return { 
          success: true, 
          accountAnalysis: accountPerformance,
          message: `Account performance analysis completed for ${args.accountType} ${args.accountId}`
        };

      case 'bitrix24_compare_user_performance':
        const userComparison = await bitrix24Client.compareUserPerformance(
          args.userIds,
          args.startDate,
          args.endDate,
          {
            metrics: args.metrics,
            includeRankings: args.includeRankings,
            includeTrends: args.includeTrends
          }
        );
        return { 
          success: true, 
          comparison: userComparison,
          message: `User performance comparison completed for ${args.userIds?.length || 'all'} users`
        };

      case 'bitrix24_track_deal_progression':
        const dealProgression = await bitrix24Client.trackDealProgression(
          args.dealId,
          args.userId,
          args.pipelineId,
          args.startDate,
          args.endDate,
          {
            includeStageDuration: args.includeStageDuration,
            identifyStalled: args.identifyStalled,
            calculateVelocity: args.calculateVelocity
          }
        );
        return { 
          success: true, 
          progression: dealProgression,
          message: `Deal progression tracking completed for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_monitor_sales_activities':
        const salesActivities = await bitrix24Client.monitorSalesActivities(
          args.userId,
          args.startDate,
          args.endDate,
          {
            includeTaskCompletion: args.includeTaskCompletion,
            includeFollowUpTracking: args.includeFollowUpTracking,
            includeMeetingTracking: args.includeMeetingTracking,
            includeQuoteActivity: args.includeQuoteActivity
          }
        );
        return { 
          success: true, 
          salesActivities: salesActivities,
          message: `Sales activities monitoring completed for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_generate_sales_report':
        const salesReport = await bitrix24Client.generateSalesReport(
          args.reportType,
          args.startDate,
          args.endDate,
          {
            userIds: args.userIds,
            includeMetrics: args.includeMetrics,
            includeTrendAnalysis: args.includeTrendAnalysis,
            includeComparisons: args.includeComparisons
          }
        );
        return { 
          success: true, 
          report: salesReport,
          message: `${args.reportType} report generated for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_get_team_dashboard':
        const teamDashboard = await bitrix24Client.getTeamDashboard({
          includeRealTimeMetrics: args.includeRealTimeMetrics,
          includeTopPerformers: args.includeTopPerformers,
          includeAttentionNeeded: args.includeAttentionNeeded,
          includeWorkloadDistribution: args.includeWorkloadDistribution,
          timeframe: args.timeframe
        });
        return { 
          success: true, 
          dashboard: teamDashboard,
          message: `Team dashboard generated for timeframe: ${args.timeframe || 'today'}`
        };

      case 'bitrix24_analyze_customer_engagement':
        const customerEngagement = await bitrix24Client.analyzeCustomerEngagement(
          args.accountId,
          args.accountType,
          args.userId,
          args.startDate,
          args.endDate,
          {
            includeCommunicationPatterns: args.includeCommunicationPatterns,
            includeResponseQuality: args.includeResponseQuality,
            includeEngagementScores: args.includeEngagementScores,
            includeRelationshipHealth: args.includeRelationshipHealth
          }
        );
        return { 
          success: true, 
          engagement: customerEngagement,
          message: `Customer engagement analysis completed for period ${args.startDate} to ${args.endDate || 'today'}`
        };

      case 'bitrix24_forecast_performance':
        const performanceForecast = await bitrix24Client.forecastPerformance(
          args.forecastType,
          args.userId,
          {
            historicalPeriod: args.historicalPeriod,
            forecastPeriod: args.forecastPeriod,
            includePipelineAnalysis: args.includePipelineAnalysis,
            includeRiskAssessment: args.includeRiskAssessment,
            includeGoalTracking: args.includeGoalTracking
          }
        );
        return { 
          success: true, 
          forecast: performanceForecast,
          message: `${args.forecastType} forecast generated using ${args.historicalPeriod || '6_months'} of historical data`
        };

      // User Management Tools
      case 'bitrix24_get_user':
        const userData = await bitrix24Client.getUser(args.userId);
        return { success: true, user: userData };

      case 'bitrix24_get_all_users':
        const allUsers = await bitrix24Client.getAllUsers();
        return { success: true, users: allUsers, message: `Found ${allUsers.length} users` };

      case 'bitrix24_resolve_user_names':
        const userNames = await bitrix24Client.resolveUserNames(args.userIds);
        return { success: true, userNames, message: `Resolved ${Object.keys(userNames).length} user names` };

      case 'bitrix24_get_contacts_with_user_names':
        const contactsRaw = await bitrix24Client.listContacts({
          start: 0,
          filter: args.filter
        });
        const contactsWithNames = await bitrix24Client.enhanceWithUserNames(contactsRaw.slice(0, args.limit || 20));
        return { success: true, contacts: contactsWithNames, message: `Retrieved ${contactsWithNames.length} contacts with user names resolved` };

      case 'bitrix24_get_deals_with_user_names':
        const dealOrderWithNames: Record<string, string> = {};
        dealOrderWithNames[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const dealsRaw = await bitrix24Client.listDeals({
          start: 0,
          filter: args.filter,
          order: dealOrderWithNames,
          select: ['*']
        });
        const dealsWithNames = await bitrix24Client.enhanceWithUserNames(dealsRaw.slice(0, args.limit || 20));
        return { success: true, deals: dealsWithNames, message: `Retrieved ${dealsWithNames.length} deals with user names resolved` };

      case 'bitrix24_get_leads_with_user_names':
        const leadOrderWithNames: Record<string, string> = {};
        leadOrderWithNames[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const leadsRaw = await bitrix24Client.listLeads({
          start: 0,
          filter: args.filter,
          order: leadOrderWithNames,
          select: ['*']
        });
        const leadsWithNames = await bitrix24Client.enhanceWithUserNames(leadsRaw.slice(0, args.limit || 20));
        return { success: true, leads: leadsWithNames, message: `Retrieved ${leadsWithNames.length} leads with user names resolved` };

      case 'bitrix24_get_companies_with_user_names':
        const companyOrderWithNames: Record<string, string> = {};
        companyOrderWithNames[args.orderBy || 'DATE_CREATE'] = args.orderDirection || 'DESC';
        
        const companiesRaw = await bitrix24Client.listCompanies({
          start: 0,
          filter: args.filter,
          order: companyOrderWithNames,
          select: ['*']
        });
        const companiesWithNames = await bitrix24Client.enhanceWithUserNames(companiesRaw.slice(0, args.limit || 20));
        return { success: true, companies: companiesWithNames, message: `Retrieved ${companiesWithNames.length} companies with user names resolved` };

      default:
        throw new Error(`Unknown tool: ${name}`);
    }
  } catch (error) {
    console.error(`Tool execution error [${name}]:`, error);
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}
