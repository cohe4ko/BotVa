# Bitrix24 MCP Server

A comprehensive Model Context Protocol (MCP) server for Bitrix24 CRM integration, enabling AI agents to seamlessly interact with your Bitrix24 instance through a powerful set of tools.

## 🚀 Features

- **Complete CRM Management**: Create, read, update, and list contacts, deals, and tasks
- **Advanced Search**: Search across all CRM entities with flexible filtering
- **Rate Limiting**: Built-in rate limiting to respect Bitrix24 API limits
- **Type Safety**: Full TypeScript implementation with comprehensive type definitions
- **Error Handling**: Robust error handling and validation
- **Easy Integration**: Simple setup with Claude Desktop and other MCP-compatible clients

## 📋 Available Tools

### Contact Management
- `bitrix24_create_contact` - Create new contacts
- `bitrix24_get_contact` - Retrieve contact by ID
- `bitrix24_list_contacts` - List contacts with filtering
- `bitrix24_update_contact` - Update existing contacts

### Deal Management
- `bitrix24_create_deal` - Create new deals
- `bitrix24_get_deal` - Retrieve deal by ID
- `bitrix24_list_deals` - List deals with filtering
- `bitrix24_update_deal` - Update existing deals

### Task Management
- `bitrix24_create_task` - Create new tasks
- `bitrix24_get_task` - Retrieve task by ID
- `bitrix24_list_tasks` - List tasks with filtering
- `bitrix24_update_task` - Update existing tasks

### User Management
- `bitrix24_get_user` - Get user information by ID
- `bitrix24_get_all_users` - Get all users in the system with names and details
- `bitrix24_resolve_user_names` - Resolve user IDs to user names
- `bitrix24_get_contacts_with_user_names` - Get contacts with user names resolved
- `bitrix24_get_deals_with_user_names` - Get deals with user names resolved
- `bitrix24_get_leads_with_user_names` - Get leads with user names resolved
- `bitrix24_get_companies_with_user_names` - Get companies with user names resolved

### Lead Management
- `bitrix24_create_lead` - Create new leads
- `bitrix24_get_lead` - Retrieve lead by ID
- `bitrix24_list_leads` - List leads with filtering
- `bitrix24_get_latest_leads` - Get most recent leads
- `bitrix24_get_leads_from_date_range` - Get leads from specific date range
- `bitrix24_update_lead` - Update existing leads

### Company Management
- `bitrix24_create_company` - Create new companies
- `bitrix24_get_company` - Retrieve company by ID
- `bitrix24_list_companies` - List companies with filtering
- `bitrix24_get_latest_companies` - Get most recent companies
- `bitrix24_get_companies_from_date_range` - Get companies from specific date range
- `bitrix24_update_company` - Update existing companies

### Enhanced Deal Filtering
- `bitrix24_get_deal_pipelines` - Get all deal pipelines/categories
- `bitrix24_get_deal_stages` - Get deal stages for pipelines
- `bitrix24_filter_deals_by_pipeline` - Filter deals by pipeline
- `bitrix24_filter_deals_by_budget` - Filter deals by budget range
- `bitrix24_filter_deals_by_status` - Filter deals by stage/status

### Utilities
- `bitrix24_search_crm` - Search across CRM entities
- `bitrix24_get_current_user` - Get current user info
- `bitrix24_validate_webhook` - Validate webhook connection
- `bitrix24_diagnose_permissions` - Diagnose webhook permissions
- `bitrix24_check_crm_settings` - Check CRM settings and configuration
- `bitrix24_test_leads_api` - Test leads API endpoints

### Sales Team Monitoring
- `bitrix24_monitor_user_activities` - Monitor user activities (calls, emails, timeline interactions, response times)
- `bitrix24_get_user_performance_summary` - Get comprehensive performance summary with deal metrics and conversion rates
- `bitrix24_analyze_account_performance` - Analyze performance for specific accounts (companies/contacts)
- `bitrix24_compare_user_performance` - Compare performance metrics between multiple users
- `bitrix24_track_deal_progression` - Track deal progression through pipeline stages with timing analysis
- `bitrix24_monitor_sales_activities` - Monitor sales-related activities (tasks, follow-ups, meetings)
- `bitrix24_generate_sales_report` - Generate comprehensive sales reports with customizable metrics
- `bitrix24_get_team_dashboard` - Get real-time team performance dashboard
- `bitrix24_analyze_customer_engagement` - Analyze customer engagement patterns and relationship health
- `bitrix24_forecast_performance` - Generate performance forecasts and predictive analytics

## 🛠️ Installation

### Prerequisites
- Node.js 18+ 
- npm or yarn
- Bitrix24 webhook URL

### Setup

1. **Clone and install dependencies:**
```bash
git clone <repository-url>
cd bitrix24-mcp-server
npm install
```

2. **Configure environment:**
```bash
cp .env.example .env
# Edit .env with your Bitrix24 webhook URL
```

3. **Build the project:**
```bash
npm run build
```

4. **Test the connection:**
```bash
npm test
```

## ⚙️ Configuration

### Environment Variables

Create a `.env` file with the following variables:

```env
BITRIX24_WEBHOOK_URL=https://your-domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/
NODE_ENV=development
LOG_LEVEL=info
```

### Bitrix24 Webhook Setup

1. Go to your Bitrix24 instance
2. Navigate to **Applications** → **Webhooks**
3. Create an **Incoming webhook**
4. Copy the webhook URL (format: `https://domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/`)
5. Set appropriate permissions for CRM and Tasks

## 🔧 Claude Desktop Integration

Add the following to your Claude Desktop configuration file:

**macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`
**Windows:** `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "node",
      "args": ["/path/to/your/bitrix24-mcp-server/build/index.js"],
      "env": {
        "BITRIX24_WEBHOOK_URL": "https://your-domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/"
      }
    }
  }
}
```

## 📖 Usage Examples

### Creating a Contact
```
Create a new contact named John Smith with email john@example.com and phone +39 123 456 789
```

### Creating a Deal with Contact
```
Create a new contact for Maria Rossi with email maria@company.com, then create a deal titled "Website Development Project" for €5000 and link it to this contact
```

### Managing Tasks
```
Create a task titled "Follow up with client" with high priority, deadline tomorrow, and link it to contact ID 123
```

### Searching CRM
```
Search for all contacts and deals related to "example.com"
```

## 🏗️ Development

### Project Structure
```
bitrix24-mcp-server/
├── src/
│   ├── bitrix24/
│   │   └── client.ts          # Bitrix24 API client
│   ├── tools/
│   │   └── index.ts           # MCP tools definitions
│   ├── utils/
│   │   └── logger.ts          # Logging utilities
│   ├── config/
│   │   └── index.ts           # Configuration management
│   └── index.ts               # Main MCP server
├── test/
│   └── integration.test.js    # Integration tests
├── build/                     # Compiled JavaScript
├── package.json
├── tsconfig.json
└── README.md
```

### Development Commands
```bash
# Install dependencies
npm install

# Build the project
npm run build

# Watch mode for development
npm run dev

# Run tests
npm test

# Start the server
npm start
```

### Adding New Tools

1. Define the tool in `src/tools/index.ts`:
```typescript
export const newTool: Tool = {
  name: 'bitrix24_new_action',
  description: 'Description of the new action',
  inputSchema: {
    type: 'object',
    properties: {
      // Define parameters
    },
    required: ['requiredParam']
  }
};
```

2. Add the execution handler:
```typescript
case 'bitrix24_new_action':
  // Implementation
  return { success: true, result: 'Action completed' };
```

3. Add to `allTools` array and rebuild.

## 🔒 Security Considerations

- **Webhook Security**: Keep your webhook URL secret and rotate it regularly
- **Environment Variables**: Never commit `.env` files to version control
- **Rate Limiting**: The client includes built-in rate limiting (2 requests/second)
- **Error Handling**: Sensitive information is not exposed in error messages

## 🐛 Troubleshooting

### Common Issues

**"Webhook validation failed"**
- Verify your webhook URL is correct
- Check that the webhook has appropriate permissions
- Ensure your Bitrix24 instance is accessible

**"Cannot find module" errors**
- Run `npm install` to install dependencies
- Ensure you've built the project with `npm run build`

**Rate limiting errors**
- The client automatically handles rate limiting
- If you see persistent rate limit errors, consider reducing request frequency

### Debug Mode
Set `NODE_ENV=development` and `LOG_LEVEL=debug` in your `.env` file for detailed logging.

## 📝 API Reference

### Bitrix24Client Methods

#### Contacts
- `createContact(contact: BitrixContact): Promise<string>`
- `getContact(id: string): Promise<BitrixContact>`
- `updateContact(id: string, contact: Partial<BitrixContact>): Promise<boolean>`
- `listContacts(params?: ListParams): Promise<BitrixContact[]>`

#### Deals
- `createDeal(deal: BitrixDeal): Promise<string>`
- `getDeal(id: string): Promise<BitrixDeal>`
- `updateDeal(id: string, deal: Partial<BitrixDeal>): Promise<boolean>`
- `listDeals(params?: ListParams): Promise<BitrixDeal[]>`

#### Tasks
- `createTask(task: BitrixTask): Promise<string>`
- `getTask(id: string): Promise<BitrixTask>`
- `updateTask(id: string, task: Partial<BitrixTask>): Promise<boolean>`
- `listTasks(params?: TaskListParams): Promise<BitrixTask[]>`

#### Users
- `getUser(userId: string): Promise<any>`
- `getAllUsers(): Promise<any[]>`
- `getUsersByIds(userIds: string[]): Promise<any[]>`
- `resolveUserNames(userIds: string[]): Promise<Record<string, string>>`
- `enhanceWithUserNames<T>(items: T[], userIdFields?: string[]): Promise<T[]>`

#### Utilities
- `getCurrentUser(): Promise<any>`
- `searchCRM(query: string, entityTypes?: string[]): Promise<any>`
- `validateWebhook(): Promise<boolean>`

## 🤝 Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Add tests if applicable
5. Submit a pull request

## 📄 License

MIT License - see LICENSE file for details.

## 🆘 Support

For issues and questions:
1. Check the troubleshooting section
2. Review Bitrix24 API documentation
3. Open an issue on GitHub

---

**Built with ❤️ for the AI automation community**
