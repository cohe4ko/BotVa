import fetch from 'node-fetch';
import { z } from 'zod';

// Environment configuration
const BITRIX24_WEBHOOK_URL = process.env.BITRIX24_WEBHOOK_URL || 
  'https://sviluppofranchising.bitrix24.it/rest/27/wwugdez6m774803q/';

// Validation schemas
const BitrixResponseSchema = z.object({
  result: z.any(),
  error: z.optional(z.object({
    error: z.string(),
    error_description: z.string()
  })),
  total: z.optional(z.number()),
  next: z.optional(z.number()),
  time: z.optional(z.object({
    start: z.number(),
    finish: z.number(),
    duration: z.number()
  }))
});

export interface BitrixContact {
  ID?: string;
  NAME?: string;
  LAST_NAME?: string;
  PHONE?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  EMAIL?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  COMPANY_TITLE?: string;
  POST?: string;
  COMMENTS?: string;
  DATE_CREATE?: string;
  DATE_MODIFY?: string;
}

export interface BitrixDeal {
  ID?: string;
  TITLE?: string;
  STAGE_ID?: string;
  OPPORTUNITY?: string;
  CURRENCY_ID?: string;
  CONTACT_ID?: string;
  COMPANY_ID?: string;
  BEGINDATE?: string;
  CLOSEDATE?: string;
  COMMENTS?: string;
  DATE_CREATE?: string;
  DATE_MODIFY?: string;
  ASSIGNED_BY_ID?: string;
  CREATED_BY_ID?: string;
  MODIFY_BY_ID?: string;
}

export interface BitrixLead {
  ID?: string;
  TITLE?: string;
  NAME?: string;
  LAST_NAME?: string;
  SECOND_NAME?: string;
  COMPANY_TITLE?: string;
  SOURCE_ID?: string;
  STATUS_ID?: string;
  STATUS_SEMANTIC_ID?: string;
  OPPORTUNITY?: string;
  CURRENCY_ID?: string;
  PHONE?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  EMAIL?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  ASSIGNED_BY_ID?: string;
  CREATED_BY_ID?: string;
  MODIFY_BY_ID?: string;
  DATE_CREATE?: string;
  DATE_MODIFY?: string;
  DATE_CLOSED?: string;
  COMMENTS?: string;
  OPENED?: string;
}

export interface BitrixTask {
  ID?: string;
  TITLE?: string;
  DESCRIPTION?: string;
  RESPONSIBLE_ID?: string;
  DEADLINE?: string;
  PRIORITY?: '0' | '1' | '2'; // 0=Low, 1=Normal, 2=High
  STATUS?: '1' | '2' | '3' | '4' | '5'; // 1=New, 2=Pending, 3=In Progress, 4=Completed, 5=Deferred
  STAGE?: string;
  UF_CRM_TASK?: string[]; // CRM entities linked to task
}

export interface BitrixCompany {
  ID?: string;
  TITLE?: string;
  COMPANY_TYPE?: string;
  INDUSTRY?: string;
  PHONE?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  EMAIL?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  WEB?: Array<{ VALUE: string; VALUE_TYPE: string }>;
  ADDRESS?: string;
  EMPLOYEES?: string;
  REVENUE?: string;
  COMMENTS?: string;
  ASSIGNED_BY_ID?: string;
  CREATED_BY_ID?: string;
  MODIFY_BY_ID?: string;
  DATE_CREATE?: string;
  DATE_MODIFY?: string;
}

export class Bitrix24Client {
  private baseUrl: string;
  private requestCount = 0;
  private lastRequestTime = 0;
  private readonly RATE_LIMIT_DELAY = 500; // 500ms between requests (2 requests/second)

  constructor(webhookUrl: string = BITRIX24_WEBHOOK_URL) {
    this.baseUrl = webhookUrl.replace(/\/$/, ''); // Remove trailing slash
  }

  private async enforceRateLimit(): Promise<void> {
    const now = Date.now();
    const timeSinceLastRequest = now - this.lastRequestTime;
    
    if (timeSinceLastRequest < this.RATE_LIMIT_DELAY) {
      await new Promise(resolve => 
        setTimeout(resolve, this.RATE_LIMIT_DELAY - timeSinceLastRequest)
      );
    }
    
    this.lastRequestTime = Date.now();
    this.requestCount++;
  }

  private async makeRequest(method: string, params: Record<string, any> = {}): Promise<any> {
    await this.enforceRateLimit();

    const url = `${this.baseUrl}/${method}`;
    
    try {
      let response;
      
      if (Object.keys(params).length === 0) {
        // GET request for methods without parameters
        response = await fetch(url, {
          method: 'GET',
          headers: {
            'Accept': 'application/json',
          },
        });
      } else {
        // POST request with form data
        const body = new URLSearchParams();
        
        Object.entries(params).forEach(([key, value]) => {
          if (key === 'fields' && typeof value === 'object' && value !== null) {
            // For fields parameter, we need to send each field as a separate parameter
            Object.entries(value).forEach(([fieldKey, fieldValue]) => {
              if (Array.isArray(fieldValue)) {
                // Handle arrays (like phone/email arrays)
                fieldValue.forEach((item, index) => {
                  if (typeof item === 'object') {
                    Object.entries(item).forEach(([subKey, subValue]) => {
                      body.append(`fields[${fieldKey}][${index}][${subKey}]`, String(subValue));
                    });
                  } else {
                    body.append(`fields[${fieldKey}][${index}]`, String(item));
                  }
                });
              } else if (typeof fieldValue === 'object' && fieldValue !== null) {
                Object.entries(fieldValue).forEach(([subKey, subValue]) => {
                  body.append(`fields[${fieldKey}][${subKey}]`, String(subValue));
                });
              } else if (fieldValue !== undefined && fieldValue !== null) {
                body.append(`fields[${fieldKey}]`, String(fieldValue));
              }
            });
          } else if (key === 'order' && typeof value === 'object' && value !== null) {
            // Handle order parameter specially - Bitrix24 expects it as individual parameters
            Object.entries(value).forEach(([orderKey, orderValue]) => {
              body.append(`order[${orderKey}]`, String(orderValue));
            });
          } else if (key === 'filter' && typeof value === 'object' && value !== null) {
            // Handle filter parameter specially
            Object.entries(value).forEach(([filterKey, filterValue]) => {
              body.append(`filter[${filterKey}]`, String(filterValue));
            });
          } else if (typeof value === 'object' && value !== null) {
            body.append(key, JSON.stringify(value));
          } else if (value !== undefined && value !== null) {
            body.append(key, String(value));
          }
        });

        response = await fetch(url, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Accept': 'application/json',
          },
          body: body.toString(),
        });
      }

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`HTTP Error ${response.status}:`, errorText);
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      const parsed = BitrixResponseSchema.parse(data);
      
      if (parsed.error) {
        throw new Error(`Bitrix24 API Error: ${parsed.error.error} - ${parsed.error.error_description}`);
      }

      return parsed.result;
    } catch (error) {
      console.error(`Bitrix24 API Error [${method}]:`, error);
      throw error;
    }
  }

  // CRM Contact Methods
  async createContact(contact: BitrixContact): Promise<string> {
    const result = await this.makeRequest('crm.contact.add', { fields: contact });
    return result.toString();
  }

  async getContact(id: string): Promise<BitrixContact> {
    return await this.makeRequest('crm.contact.get', { id });
  }

  async updateContact(id: string, contact: Partial<BitrixContact>): Promise<boolean> {
    const result = await this.makeRequest('crm.contact.update', { id, fields: contact });
    return result === true;
  }

  async listContacts(params: { start?: number; filter?: Record<string, any> } = {}): Promise<BitrixContact[]> {
    return await this.makeRequest('crm.contact.list', params);
  }

  // Helper method to get latest contacts with proper ordering
  async getLatestContacts(limit: number = 20): Promise<BitrixContact[]> {
    // Use Bitrix24's built-in ordering which works correctly
    const contacts = await this.makeRequest('crm.contact.list', {
      start: 0,
      order: { 'DATE_CREATE': 'DESC' },
      select: ['*']
    });
    
    return contacts.slice(0, limit);
  }

  // CRM Deal Methods
  async createDeal(deal: BitrixDeal): Promise<string> {
    const result = await this.makeRequest('crm.deal.add', { fields: deal });
    return result.toString();
  }

  async getDeal(id: string): Promise<BitrixDeal> {
    return await this.makeRequest('crm.deal.get', { id });
  }

  async updateDeal(id: string, deal: Partial<BitrixDeal>): Promise<boolean> {
    const result = await this.makeRequest('crm.deal.update', { id, fields: deal });
    return result === true;
  }

  async listDeals(params: { 
    start?: number; 
    filter?: Record<string, any>;
    order?: Record<string, string>;
    select?: string[];
  } = {}): Promise<BitrixDeal[]> {
    return await this.makeRequest('crm.deal.list', params);
  }

  // Helper method to get latest deals with proper ordering
  async getLatestDeals(limit: number = 20): Promise<BitrixDeal[]> {
    // Use Bitrix24's built-in ordering which works correctly
    const deals = await this.makeRequest('crm.deal.list', {
      start: 0,
      order: { 'DATE_CREATE': 'DESC' },
      select: ['*']
    });
    
    return deals.slice(0, limit);
  }

  // Helper method to get deals from a specific date range
  async getDealsFromDateRange(startDate: string, endDate?: string, limit: number = 50): Promise<BitrixDeal[]> {
    const filter: Record<string, any> = {
      '>=DATE_CREATE': startDate
    };
    
    if (endDate) {
      filter['<=DATE_CREATE'] = endDate;
    }

    const deals = await this.makeRequest('crm.deal.list', {
      start: 0,
      select: ['*'],
      filter
    });
    
    // Sort by DATE_CREATE in JavaScript for consistency
    const sortedDeals = deals.sort((a: BitrixDeal, b: BitrixDeal) => {
      const dateA = new Date(a.DATE_CREATE || '1970-01-01');
      const dateB = new Date(b.DATE_CREATE || '1970-01-01');
      return dateB.getTime() - dateA.getTime(); // DESC order (newest first)
    });
    
    return sortedDeals.slice(0, limit);
  }

  // CRM Lead Methods
  async createLead(lead: BitrixLead): Promise<string> {
    const result = await this.makeRequest('crm.lead.add', { fields: lead });
    return result.toString();
  }

  async getLead(id: string): Promise<BitrixLead> {
    return await this.makeRequest('crm.lead.get', { id });
  }

  async updateLead(id: string, lead: Partial<BitrixLead>): Promise<boolean> {
    const result = await this.makeRequest('crm.lead.update', { id, fields: lead });
    return result === true;
  }

  async listLeads(params: { 
    start?: number; 
    filter?: Record<string, any>;
    order?: Record<string, string>;
    select?: string[];
  } = {}): Promise<BitrixLead[]> {
    return await this.makeRequest('crm.lead.list', params);
  }

  // Helper method to get latest leads with proper ordering
  async getLatestLeads(limit: number = 20): Promise<BitrixLead[]> {
    // Use Bitrix24's built-in ordering which works correctly
    const leads = await this.makeRequest('crm.lead.list', {
      start: 0,
      order: { 'DATE_CREATE': 'DESC' },
      select: ['*']
    });
    
    return leads.slice(0, limit);
  }

  // Helper method to get leads from a specific date range
  async getLeadsFromDateRange(startDate: string, endDate?: string, limit: number = 50): Promise<BitrixLead[]> {
    const filter: Record<string, any> = {
      '>=DATE_CREATE': startDate
    };
    
    if (endDate) {
      filter['<=DATE_CREATE'] = endDate;
    }

    const leads = await this.makeRequest('crm.lead.list', {
      start: 0,
      select: ['*'],
      filter
    });
    
    // Sort by DATE_CREATE in JavaScript
    const sortedLeads = leads.sort((a: BitrixLead, b: BitrixLead) => {
      const dateA = new Date(a.DATE_CREATE || '1970-01-01');
      const dateB = new Date(b.DATE_CREATE || '1970-01-01');
      return dateB.getTime() - dateA.getTime(); // DESC order (newest first)
    });
    
    return sortedLeads.slice(0, limit);
  }

  // CRM Company Methods
  async createCompany(company: BitrixCompany): Promise<string> {
    const result = await this.makeRequest('crm.company.add', { fields: company });
    return result.toString();
  }

  async getCompany(id: string): Promise<BitrixCompany> {
    return await this.makeRequest('crm.company.get', { id });
  }

  async updateCompany(id: string, company: Partial<BitrixCompany>): Promise<boolean> {
    const result = await this.makeRequest('crm.company.update', { id, fields: company });
    return result === true;
  }

  async listCompanies(params: { 
    start?: number; 
    filter?: Record<string, any>;
    order?: Record<string, string>;
    select?: string[];
  } = {}): Promise<BitrixCompany[]> {
    return await this.makeRequest('crm.company.list', params);
  }

  // Helper method to get latest companies with proper ordering
  async getLatestCompanies(limit: number = 20): Promise<BitrixCompany[]> {
    const companies = await this.makeRequest('crm.company.list', {
      start: 0,
      order: { 'DATE_CREATE': 'DESC' },
      select: ['*']
    });
    
    return companies.slice(0, limit);
  }

  // Helper method to get companies from a specific date range
  async getCompaniesFromDateRange(startDate: string, endDate?: string, limit: number = 50): Promise<BitrixCompany[]> {
    const filter: Record<string, any> = {
      '>=DATE_CREATE': startDate
    };
    
    if (endDate) {
      filter['<=DATE_CREATE'] = endDate;
    }

    const companies = await this.makeRequest('crm.company.list', {
      start: 0,
      select: ['*'],
      filter
    });
    
    // Sort by DATE_CREATE in JavaScript for consistency
    const sortedCompanies = companies.sort((a: BitrixCompany, b: BitrixCompany) => {
      const dateA = new Date(a.DATE_CREATE || '1970-01-01');
      const dateB = new Date(b.DATE_CREATE || '1970-01-01');
      return dateB.getTime() - dateA.getTime(); // DESC order (newest first)
    });
    
    return sortedCompanies.slice(0, limit);
  }

  // Deal Pipeline and Stage Methods
  async getDealPipelines(): Promise<any[]> {
    return await this.makeRequest('crm.dealcategory.list');
  }

  async getDealStages(pipelineId?: string): Promise<any[]> {
    const params: Record<string, any> = {};
    if (pipelineId) {
      params.id = pipelineId;
    }
    return await this.makeRequest('crm.dealcategory.stage.list', params);
  }

  // Enhanced Deal Filtering Methods
  async filterDealsByPipeline(pipelineId: string, options: {
    limit?: number;
    orderBy?: string;
    orderDirection?: string;
    select?: string[];
  } = {}): Promise<BitrixDeal[]> {
    const filter: Record<string, any> = {
      'CATEGORY_ID': pipelineId
    };

    const order: Record<string, string> = {};
    if (options.orderBy) {
      order[options.orderBy] = options.orderDirection || 'DESC';
    }

    const deals = await this.makeRequest('crm.deal.list', {
      start: 0,
      filter,
      order: Object.keys(order).length > 0 ? order : { 'DATE_CREATE': 'DESC' },
      select: options.select || ['*']
    });

    return deals.slice(0, options.limit || 50);
  }

  async filterDealsByBudget(minBudget: number, maxBudget?: number, currency: string = 'EUR', options: {
    limit?: number;
    orderBy?: string;
    orderDirection?: string;
    select?: string[];
  } = {}): Promise<BitrixDeal[]> {
    const filter: Record<string, any> = {
      '>=OPPORTUNITY': minBudget.toString()
    };

    if (maxBudget) {
      filter['<=OPPORTUNITY'] = maxBudget.toString();
    }

    // Add currency filter if specified
    if (currency) {
      filter['CURRENCY_ID'] = currency;
    }

    const order: Record<string, string> = {};
    if (options.orderBy) {
      order[options.orderBy] = options.orderDirection || 'DESC';
    }

    const deals = await this.makeRequest('crm.deal.list', {
      start: 0,
      filter,
      order: Object.keys(order).length > 0 ? order : { 'OPPORTUNITY': 'DESC' },
      select: options.select || ['*']
    });

    return deals.slice(0, options.limit || 50);
  }

  async filterDealsByStatus(stageIds: string[], pipelineId?: string, options: {
    limit?: number;
    orderBy?: string;
    orderDirection?: string;
    select?: string[];
  } = {}): Promise<BitrixDeal[]> {
    const filter: Record<string, any> = {};

    // Handle multiple stage IDs
    if (stageIds.length === 1) {
      filter['STAGE_ID'] = stageIds[0];
    } else {
      // For multiple stages, we need to use the @STAGE_ID syntax
      stageIds.forEach((stageId, index) => {
        filter[`@STAGE_ID[${index}]`] = stageId;
      });
    }

    // Add pipeline filter if specified
    if (pipelineId) {
      filter['CATEGORY_ID'] = pipelineId;
    }

    const order: Record<string, string> = {};
    if (options.orderBy) {
      order[options.orderBy] = options.orderDirection || 'DESC';
    }

    const deals = await this.makeRequest('crm.deal.list', {
      start: 0,
      filter,
      order: Object.keys(order).length > 0 ? order : { 'DATE_CREATE': 'DESC' },
      select: options.select || ['*']
    });

    return deals.slice(0, options.limit || 50);
  }

  // Task Methods
  async createTask(task: BitrixTask): Promise<string> {
    const result = await this.makeRequest('tasks.task.add', { fields: task });
    return result.task.id.toString();
  }

  async getTask(id: string): Promise<BitrixTask> {
    const result = await this.makeRequest('tasks.task.get', { taskId: id });
    return result.task;
  }

  async updateTask(id: string, task: Partial<BitrixTask>): Promise<boolean> {
    const result = await this.makeRequest('tasks.task.update', { taskId: id, fields: task });
    return result === true;
  }

  async listTasks(params: { 
    select?: string[];
    filter?: Record<string, any>;
    order?: Record<string, string>;
    start?: number;
  } = {}): Promise<BitrixTask[]> {
    const result = await this.makeRequest('tasks.task.list', params);
    return result.tasks || [];
  }

  // Utility Methods
  async getCurrentUser(): Promise<any> {
    return await this.makeRequest('user.current');
  }

  // User Management Methods
  async getUser(userId: string): Promise<any> {
    return await this.makeRequest('user.get', { ID: userId });
  }

  async getAllUsers(): Promise<any[]> {
    return await this.makeRequest('user.get');
  }

  async getUsersByIds(userIds: string[]): Promise<any[]> {
    const results = [];
    for (const userId of userIds) {
      try {
        const user = await this.getUser(userId);
        results.push(user);
      } catch (error) {
        console.error(`Error fetching user ${userId}:`, error);
        results.push({ ID: userId, NAME: 'Unknown', LAST_NAME: 'User', ERROR: error instanceof Error ? error.message : String(error) });
      }
    }
    return results;
  }

  async resolveUserNames(userIds: string[]): Promise<Record<string, string>> {
    const userMap: Record<string, string> = {};
    
    try {
      const users = await this.getUsersByIds(userIds);
      for (const user of users) {
        const fullName = `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim();
        userMap[user.ID] = fullName || `User ${user.ID}`;
      }
    } catch (error) {
      console.error('Error resolving user names:', error);
      // Fallback: return IDs as names
      userIds.forEach(id => {
        userMap[id] = `User ${id}`;
      });
    }
    
    return userMap;
  }

  async enhanceWithUserNames<T extends Record<string, any>>(
    items: T[],
    userIdFields: string[] = ['ASSIGNED_BY_ID', 'CREATED_BY_ID', 'MODIFY_BY_ID']
  ): Promise<T[]> {
    // Collect all unique user IDs
    const allUserIds = new Set<string>();
    
    items.forEach(item => {
      userIdFields.forEach(field => {
        if (item[field] && typeof item[field] === 'string') {
          allUserIds.add(item[field]);
        }
      });
    });

    // Resolve user names
    const userNames = await this.resolveUserNames(Array.from(allUserIds));

    // Enhance items with user names
    return items.map(item => {
      const enhanced = { ...item } as any;
      
      userIdFields.forEach(field => {
        if (item[field] && userNames[item[field]]) {
          enhanced[`${field}_NAME`] = userNames[item[field]];
        }
      });
      
      return enhanced as T;
    });
  }

  async searchCRM(query: string, entityTypes: string[] = ['contact', 'company', 'deal', 'lead']): Promise<any> {
    return await this.makeRequest('crm.duplicate.findbycomm', {
      entity_type: entityTypes.join(','),
      type: 'EMAIL',
      values: [query]
    });
  }

  async validateWebhook(): Promise<boolean> {
    try {
      // Try a simple method that requires minimal permissions
      await this.makeRequest('app.info');
      return true;
    } catch (error) {
      console.error('Webhook validation failed:', error);
      // Try alternative validation methods
      try {
        await this.listContacts({ start: 0 });
        return true;
      } catch (secondError) {
        console.error('Alternative validation also failed:', secondError);
        return false;
      }
    }
  }

  // Diagnostic Methods
  async diagnosePermissions(): Promise<any> {
    const results = {
      webhook_valid: false,
      app_info: null,
      permissions: null,
      crm_access: false,
      leads_access: false,
      contacts_access: false,
      deals_access: false,
      error_details: [] as string[]
    };

    try {
      // Test basic webhook
      results.app_info = await this.makeRequest('app.info');
      results.webhook_valid = true;
    } catch (error) {
      results.error_details.push(`app.info failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // Test permissions endpoint
      results.permissions = await this.makeRequest('user.access');
    } catch (error) {
      results.error_details.push(`user.access failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test CRM access
    try {
      await this.listContacts({ start: 0 });
      results.contacts_access = true;
      results.crm_access = true;
    } catch (error) {
      results.error_details.push(`contacts access failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      await this.listDeals({ start: 0 });
      results.deals_access = true;
    } catch (error) {
      results.error_details.push(`deals access failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test leads access specifically
    try {
      await this.makeRequest('crm.lead.list', { start: 0 });
      results.leads_access = true;
    } catch (error) {
      results.error_details.push(`leads access failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return results;
  }

  async checkCRMSettings(): Promise<any> {
    const results = {
      lead_fields: null,
      lead_statuses: null,
      crm_mode: null,
      error_details: [] as string[]
    };

    try {
      // Get lead fields to check if leads are available
      results.lead_fields = await this.makeRequest('crm.lead.fields');
    } catch (error) {
      results.error_details.push(`crm.lead.fields failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // Try to get lead statuses
      results.lead_statuses = await this.makeRequest('crm.status.list', { filter: { ENTITY_ID: 'STATUS' } });
    } catch (error) {
      results.error_details.push(`lead statuses failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    try {
      // Try to get CRM settings (might not be available via API)
      results.crm_mode = await this.makeRequest('crm.settings.mode.get');
    } catch (error) {
      results.error_details.push(`CRM mode check failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return results;
  }

  async testLeadsAPI(): Promise<any> {
    const results = {
      list_test: null,
      fields_test: null,
      count_test: null as number | string | null,
      simple_list: null,
      error_details: [] as string[]
    };

    // Test 1: Basic list with minimal parameters
    try {
      results.simple_list = await this.makeRequest('crm.lead.list', { start: 0 });
    } catch (error) {
      results.error_details.push(`simple list failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 2: Get lead fields
    try {
      results.fields_test = await this.makeRequest('crm.lead.fields');
    } catch (error) {
      results.error_details.push(`fields test failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 3: List with specific parameters
    try {
      results.list_test = await this.makeRequest('crm.lead.list', {
        select: ['ID', 'TITLE', 'DATE_CREATE'],
        start: 0,
        order: { 'ID': 'DESC' }
      });
    } catch (error) {
      results.error_details.push(`parameterized list failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    // Test 4: Try to get count
    try {
      const countResult = await this.makeRequest('crm.lead.list', {
        select: ['ID'],
        start: 0,
        filter: {}
      });
      results.count_test = Array.isArray(countResult) ? countResult.length : 'Not an array';
    } catch (error) {
      results.error_details.push(`count test failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    return results;
  }

  private async batchRequest(requests: Array<{ method: string; params: any }>): Promise<any[]> {
    // Implement batch processing for multiple operations
    const results = [];
    for (const req of requests) {
      const result = await this.makeRequest(req.method, req.params);
      results.push(result);
    }
    return results;
  }

  // Sales Team Monitoring Methods
  async monitorUserActivities(
    userId?: string,
    startDate?: string,
    endDate?: string,
    options: {
      includeCallVolume?: boolean;
      includeEmailActivity?: boolean;
      includeTimelineActivity?: boolean;
      includeResponseTimes?: boolean;
    } = {}
  ): Promise<any> {
    const endDateToUse = endDate || new Date().toISOString().split('T')[0];
    const results: any = {
      userId: userId || 'all_users',
      period: { startDate, endDate: endDateToUse },
      metrics: {}
    };

    try {
      // Get users to monitor
      const users = userId ? [{ ID: userId }] : await this.makeRequest('user.get');
      
      for (const user of users) {
        const userMetrics: any = {
          userId: user.ID,
          userName: `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim(),
          activities: {}
        };

        // Monitor call volume
        if (options.includeCallVolume) {
          try {
            const callActivities = await this.makeRequest('crm.activity.list', {
              filter: {
                TYPE_ID: 2, // Call activities
                RESPONSIBLE_ID: user.ID,
                '>=DATE_CREATE': startDate,
                '<=DATE_CREATE': endDateToUse
              },
              select: ['ID', 'DATE_CREATE', 'DIRECTION', 'SUBJECT']
            });
            
            userMetrics.activities.calls = {
              total: callActivities.length,
              incoming: callActivities.filter((a: any) => a.DIRECTION === '1').length,
              outgoing: callActivities.filter((a: any) => a.DIRECTION === '2').length,
              details: callActivities
            };
          } catch (error) {
            userMetrics.activities.calls = { error: `Failed to get call data: ${error}` };
          }
        }

        // Monitor email activity
        if (options.includeEmailActivity) {
          try {
            const emailActivities = await this.makeRequest('crm.activity.list', {
              filter: {
                TYPE_ID: 4, // Email activities
                RESPONSIBLE_ID: user.ID,
                '>=DATE_CREATE': startDate,
                '<=DATE_CREATE': endDateToUse
              },
              select: ['ID', 'DATE_CREATE', 'DIRECTION', 'SUBJECT']
            });
            
            userMetrics.activities.emails = {
              total: emailActivities.length,
              incoming: emailActivities.filter((a: any) => a.DIRECTION === '1').length,
              outgoing: emailActivities.filter((a: any) => a.DIRECTION === '2').length,
              details: emailActivities
            };
          } catch (error) {
            userMetrics.activities.emails = { error: `Failed to get email data: ${error}` };
          }
        }

        // Monitor timeline activity
        if (options.includeTimelineActivity) {
          try {
            const timelineEntries = await this.makeRequest('crm.timeline.comment.list', {
              filter: {
                AUTHOR_ID: user.ID,
                '>=DATE_CREATE': startDate,
                '<=DATE_CREATE': endDateToUse
              }
            });
            
            userMetrics.activities.timeline = {
              total: timelineEntries.length,
              details: timelineEntries
            };
          } catch (error) {
            userMetrics.activities.timeline = { error: `Failed to get timeline data: ${error}` };
          }
        }

        // Calculate response times
        if (options.includeResponseTimes) {
          try {
            const allActivities = await this.makeRequest('crm.activity.list', {
              filter: {
                RESPONSIBLE_ID: user.ID,
                '>=DATE_CREATE': startDate,
                '<=DATE_CREATE': endDateToUse
              },
              select: ['ID', 'DATE_CREATE', 'DIRECTION', 'TYPE_ID'],
              order: { DATE_CREATE: 'ASC' }
            });

            const responseTimes = this.calculateResponseTimes(allActivities);
            userMetrics.activities.responseTimes = responseTimes;
          } catch (error) {
            userMetrics.activities.responseTimes = { error: `Failed to calculate response times: ${error}` };
          }
        }

        results.metrics[user.ID] = userMetrics;
      }

      return results;
    } catch (error) {
      console.error('Error monitoring user activities:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async getUserPerformanceSummary(
    userId?: string,
    startDate?: string,
    endDate?: string,
    options: {
      includeDealMetrics?: boolean;
      includeActivityRatios?: boolean;
      includeConversionRates?: boolean;
    } = {}
  ): Promise<any> {
    const endDateToUse = endDate || new Date().toISOString().split('T')[0];
    const results: any = {
      userId: userId || 'all_users',
      period: { startDate, endDate: endDateToUse },
      performance: {}
    };

    try {
      const users = userId ? [{ ID: userId }] : await this.makeRequest('user.get');
      
      for (const user of users) {
        const userPerformance: any = {
          userId: user.ID,
          userName: `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim(),
          metrics: {}
        };

        // Deal metrics
        if (options.includeDealMetrics) {
          try {
            const deals = await this.makeRequest('crm.deal.list', {
              filter: {
                ASSIGNED_BY_ID: user.ID,
                '>=DATE_CREATE': startDate,
                '<=DATE_CREATE': endDateToUse
              },
              select: ['ID', 'TITLE', 'OPPORTUNITY', 'STAGE_ID', 'DATE_CREATE', 'CLOSEDATE']
            });

            const wonDeals = deals.filter((d: any) => d.STAGE_ID?.includes('WON') || d.STAGE_ID?.includes('SUCCESS'));
            const lostDeals = deals.filter((d: any) => d.STAGE_ID?.includes('LOST') || d.STAGE_ID?.includes('FAIL'));

            userPerformance.metrics.deals = {
              total: deals.length,
              won: wonDeals.length,
              lost: lostDeals.length,
              inProgress: deals.length - wonDeals.length - lostDeals.length,
              totalValue: deals.reduce((sum: number, d: any) => sum + (parseFloat(d.OPPORTUNITY) || 0), 0),
              wonValue: wonDeals.reduce((sum: number, d: any) => sum + (parseFloat(d.OPPORTUNITY) || 0), 0),
              winRate: deals.length > 0 ? (wonDeals.length / deals.length * 100).toFixed(2) : '0'
            };
          } catch (error) {
            userPerformance.metrics.deals = { error: `Failed to get deal metrics: ${error}` };
          }
        }

        // Activity ratios
        if (options.includeActivityRatios) {
          try {
            const activities = await this.makeRequest('crm.activity.list', {
              filter: {
                RESPONSIBLE_ID: user.ID,
                '>=DATE_CREATE': startDate,
                '<=DATE_CREATE': endDateToUse
              },
              select: ['ID', 'TYPE_ID', 'DIRECTION']
            });

            const activityCounts = activities.reduce((acc: any, activity: any) => {
              const type = activity.TYPE_ID;
              acc[type] = (acc[type] || 0) + 1;
              return acc;
            }, {});

            userPerformance.metrics.activityRatios = {
              total: activities.length,
              breakdown: activityCounts,
              callsToEmails: activityCounts['2'] && activityCounts['4'] ? 
                (activityCounts['2'] / activityCounts['4']).toFixed(2) : 'N/A'
            };
          } catch (error) {
            userPerformance.metrics.activityRatios = { error: `Failed to get activity ratios: ${error}` };
          }
        }

        // Conversion rates
        if (options.includeConversionRates) {
          try {
            const leads = await this.makeRequest('crm.lead.list', {
              filter: {
                ASSIGNED_BY_ID: user.ID,
                '>=DATE_CREATE': startDate,
                '<=DATE_CREATE': endDateToUse
              },
              select: ['ID', 'STATUS_ID']
            });

            const deals = await this.makeRequest('crm.deal.list', {
              filter: {
                ASSIGNED_BY_ID: user.ID,
                '>=DATE_CREATE': startDate,
                '<=DATE_CREATE': endDateToUse
              },
              select: ['ID', 'STAGE_ID']
            });

            const convertedLeads = leads.filter((l: any) => l.STATUS_ID === 'CONVERTED').length;
            const leadToDealConversion = leads.length > 0 ? 
              (convertedLeads / leads.length * 100).toFixed(2) : '0';

            userPerformance.metrics.conversionRates = {
              totalLeads: leads.length,
              convertedLeads: convertedLeads,
              leadToDealConversion: leadToDealConversion + '%',
              totalDeals: deals.length
            };
          } catch (error) {
            userPerformance.metrics.conversionRates = { error: `Failed to get conversion rates: ${error}` };
          }
        }

        results.performance[user.ID] = userPerformance;
      }

      return results;
    } catch (error) {
      console.error('Error getting user performance summary:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async analyzeAccountPerformance(
    accountId: string,
    accountType: 'company' | 'contact',
    startDate?: string,
    endDate?: string,
    options: {
      includeAllInteractions?: boolean;
      includeDealProgression?: boolean;
      includeTimelineHistory?: boolean;
    } = {}
  ): Promise<any> {
    const endDateToUse = endDate || new Date().toISOString().split('T')[0];
    const results: any = {
      accountId,
      accountType,
      period: { startDate, endDate: endDateToUse },
      analysis: {}
    };

    try {
      // Get account details
      const accountData = accountType === 'company' 
        ? await this.getCompany(accountId)
        : await this.getContact(accountId);
      
      results.accountDetails = accountData;

      // Get all interactions
      if (options.includeAllInteractions) {
        const filterKey = accountType === 'company' ? 'COMPANY_ID' : 'CONTACT_ID';
        
        const activities = await this.makeRequest('crm.activity.list', {
          filter: {
            [filterKey]: accountId,
            '>=DATE_CREATE': startDate,
            '<=DATE_CREATE': endDateToUse
          },
          select: ['ID', 'TYPE_ID', 'SUBJECT', 'DATE_CREATE', 'RESPONSIBLE_ID', 'DIRECTION']
        });

        results.analysis.interactions = {
          total: activities.length,
          byType: activities.reduce((acc: any, activity: any) => {
            const type = activity.TYPE_ID;
            acc[type] = (acc[type] || 0) + 1;
            return acc;
          }, {}),
          byUser: activities.reduce((acc: any, activity: any) => {
            const userId = activity.RESPONSIBLE_ID;
            acc[userId] = (acc[userId] || 0) + 1;
            return acc;
          }, {}),
          details: activities
        };
      }

      // Deal progression
      if (options.includeDealProgression) {
        const filterKey = accountType === 'company' ? 'COMPANY_ID' : 'CONTACT_ID';
        
        const deals = await this.makeRequest('crm.deal.list', {
          filter: {
            [filterKey]: accountId,
            '>=DATE_CREATE': startDate,
            '<=DATE_CREATE': endDateToUse
          },
          select: ['ID', 'TITLE', 'STAGE_ID', 'OPPORTUNITY', 'DATE_CREATE', 'CLOSEDATE', 'ASSIGNED_BY_ID']
        });

        results.analysis.dealProgression = {
          total: deals.length,
          totalValue: deals.reduce((sum: number, d: any) => sum + (parseFloat(d.OPPORTUNITY) || 0), 0),
          byStage: deals.reduce((acc: any, deal: any) => {
            const stage = deal.STAGE_ID;
            acc[stage] = (acc[stage] || 0) + 1;
            return acc;
          }, {}),
          details: deals
        };
      }

      // Timeline history
      if (options.includeTimelineHistory) {
        const entityType = accountType === 'company' ? 'COMPANY' : 'CONTACT';
        
        try {
          const timelineEntries = await this.makeRequest('crm.timeline.comment.list', {
            filter: {
              ENTITY_TYPE: entityType,
              ENTITY_ID: accountId,
              '>=DATE_CREATE': startDate,
              '<=DATE_CREATE': endDateToUse
            }
          });

          results.analysis.timelineHistory = {
            total: timelineEntries.length,
            details: timelineEntries
          };
        } catch (error) {
          results.analysis.timelineHistory = { error: `Failed to get timeline: ${error}` };
        }
      }

      return results;
    } catch (error) {
      console.error('Error analyzing account performance:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  async compareUserPerformance(
    userIds?: string[],
    startDate?: string,
    endDate?: string,
    options: {
      metrics?: string[];
      includeRankings?: boolean;
      includeTrends?: boolean;
    } = {}
  ): Promise<any> {
    const endDateToUse = endDate || new Date().toISOString().split('T')[0];
    const results: any = {
      period: { startDate, endDate: endDateToUse },
      comparison: {},
      rankings: {}
    };

    try {
      const users = userIds?.length ? 
        userIds.map(id => ({ ID: id })) : 
        await this.makeRequest('user.get');

      const metricsToCompare = options.metrics || ['activities', 'deals', 'conversions'];

      for (const user of users) {
        const userComparison: any = {
          userId: user.ID,
          userName: `${user.NAME || ''} ${user.LAST_NAME || ''}`.trim(),
          metrics: {}
        };

        // Activities comparison
        if (metricsToCompare.includes('activities')) {
          const activities = await this.makeRequest('crm.activity.list', {
            filter: {
              RESPONSIBLE_ID: user.ID,
              '>=DATE_CREATE': startDate,
              '<=DATE_CREATE': endDateToUse
            },
            select: ['ID', 'TYPE_ID']
          });

          userComparison.metrics.activities = {
            total: activities.length,
            calls: activities.filter((a: any) => a.TYPE_ID === '2').length,
            emails: activities.filter((a: any) => a.TYPE_ID === '4').length,
            meetings: activities.filter((a: any) => a.TYPE_ID === '1').length
          };
        }

        // Deals comparison
        if (metricsToCompare.includes('deals')) {
          const deals = await this.makeRequest('crm.deal.list', {
            filter: {
              ASSIGNED_BY_ID: user.ID,
              '>=DATE_CREATE': startDate,
              '<=DATE_CREATE': endDateToUse
            },
            select: ['ID', 'OPPORTUNITY', 'STAGE_ID']
          });

          const wonDeals = deals.filter((d: any) => d.STAGE_ID?.includes('WON') || d.STAGE_ID?.includes('SUCCESS'));
          
          userComparison.metrics.deals = {
            total: deals.length,
            won: wonDeals.length,
            totalValue: deals.reduce((sum: number, d: any) => sum + (parseFloat(d.OPPORTUNITY) || 0), 0),
            wonValue: wonDeals.reduce((sum: number, d: any) => sum + (parseFloat(d.OPPORTUNITY) || 0), 0),
            winRate: deals.length > 0 ? (wonDeals.length / deals.length * 100).toFixed(2) : '0'
          };
        }

        // Conversions comparison
        if (metricsToCompare.includes('conversions')) {
          const leads = await this.makeRequest('crm.lead.list', {
            filter: {
              ASSIGNED_BY_ID: user.ID,
              '>=DATE_CREATE': startDate,
              '<=DATE_CREATE': endDateToUse
            },
            select: ['ID', 'STATUS_ID']
          });

          const convertedLeads = leads.filter((l: any) => l.STATUS_ID === 'CONVERTED').length;
          
          userComparison.metrics.conversions = {
            totalLeads: leads.length,
            convertedLeads: convertedLeads,
            conversionRate: leads.length > 0 ? (convertedLeads / leads.length * 100).toFixed(2) : '0'
          };
        }

        results.comparison[user.ID] = userComparison;
      }

      // Generate rankings
      if (options.includeRankings) {
        results.rankings = this.generateUserRankings(results.comparison, metricsToCompare);
      }

      return results;
    } catch (error) {
      console.error('Error comparing user performance:', error);
      return { error: error instanceof Error ? error.message : String(error) };
    }
  }

  // Helper methods
  private calculateResponseTimes(activities: any[]): any {
    const incomingActivities = activities.filter(a => a.DIRECTION === '1');
    const outgoingActivities = activities.filter(a => a.DIRECTION === '2');
    
    const responseTimes: number[] = [];
    
    incomingActivities.forEach(incoming => {
      const nextOutgoing = outgoingActivities.find(outgoing => 
        new Date(outgoing.DATE_CREATE) > new Date(incoming.DATE_CREATE)
      );
      
      if (nextOutgoing) {
        const responseTime = new Date(nextOutgoing.DATE_CREATE).getTime() - new Date(incoming.DATE_CREATE).getTime();
        responseTimes.push(responseTime / (1000 * 60 * 60)); // Convert to hours
      }
    });

    return {
      averageResponseTime: responseTimes.length > 0 ? 
        (responseTimes.reduce((sum, time) => sum + time, 0) / responseTimes.length).toFixed(2) + ' hours' : 
        'N/A',
      totalResponses: responseTimes.length,
      fastestResponse: responseTimes.length > 0 ? Math.min(...responseTimes).toFixed(2) + ' hours' : 'N/A',
      slowestResponse: responseTimes.length > 0 ? Math.max(...responseTimes).toFixed(2) + ' hours' : 'N/A'
    };
  }

  private generateUserRankings(comparison: any, metrics: string[]): any {
    const rankings: any = {};
    
    metrics.forEach(metric => {
      const users = Object.values(comparison) as any[];
      
      switch (metric) {
        case 'activities':
          rankings.activities = users
            .sort((a, b) => (b.metrics.activities?.total || 0) - (a.metrics.activities?.total || 0))
            .map((user, index) => ({
              rank: index + 1,
              userId: user.userId,
              userName: user.userName,
              value: user.metrics.activities?.total || 0
            }));
          break;
        case 'deals':
          rankings.deals = users
            .sort((a, b) => (b.metrics.deals?.wonValue || 0) - (a.metrics.deals?.wonValue || 0))
            .map((user, index) => ({
              rank: index + 1,
              userId: user.userId,
              userName: user.userName,
              value: user.metrics.deals?.wonValue || 0
            }));
          break;
        case 'conversions':
          rankings.conversions = users
            .sort((a, b) => (parseFloat(b.metrics.conversions?.conversionRate) || 0) - (parseFloat(a.metrics.conversions?.conversionRate) || 0))
            .map((user, index) => ({
              rank: index + 1,
              userId: user.userId,
              userName: user.userName,
              value: user.metrics.conversions?.conversionRate || '0'
            }));
          break;
      }
    });

    return rankings;
  }

  // Placeholder methods for remaining monitoring tools
  async trackDealProgression(dealId?: string, userId?: string, pipelineId?: string, startDate?: string, endDate?: string, options: any = {}): Promise<any> {
    // Implementation for deal progression tracking
    return { message: 'Deal progression tracking - implementation in progress' };
  }

  async monitorSalesActivities(userId?: string, startDate?: string, endDate?: string, options: any = {}): Promise<any> {
    // Implementation for sales activities monitoring
    return { message: 'Sales activities monitoring - implementation in progress' };
  }

  async generateSalesReport(reportType: string, startDate?: string, endDate?: string, options: any = {}): Promise<any> {
    // Implementation for sales report generation
    return { message: 'Sales report generation - implementation in progress' };
  }

  async getTeamDashboard(options: any = {}): Promise<any> {
    // Implementation for team dashboard
    return { message: 'Team dashboard - implementation in progress' };
  }

  async analyzeCustomerEngagement(accountId?: string, accountType?: string, userId?: string, startDate?: string, endDate?: string, options: any = {}): Promise<any> {
    // Implementation for customer engagement analysis
    return { message: 'Customer engagement analysis - implementation in progress' };
  }

  async forecastPerformance(forecastType: string, userId?: string, options: any = {}): Promise<any> {
    // Implementation for performance forecasting
    return { message: 'Performance forecasting - implementation in progress' };
  }
}

export const bitrix24Client = new Bitrix24Client();
