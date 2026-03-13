# Bitrix24 CRM Desktop Extension

This is a Desktop Extension (.dxt) package for the Bitrix24 MCP Server, making installation as simple as a single click.

## 🚀 Quick Installation

1. **Download the Extension**: Get the `bitrix24-mcp-server-1.0.0.dxt` file
2. **Install in Claude Desktop**: 
   - Double-click the .dxt file, or
   - Drag and drop it into Claude Desktop's Settings → Extensions
3. **Configure**: Enter your Bitrix24 webhook URL when prompted
4. **Start Using**: The extension is now ready to use!

## 📋 What's Included

This extension provides 33 powerful tools for Bitrix24 CRM integration:

### Contact Management (5 tools)
- Create, read, update, and list contacts
- Get latest contacts by creation date

### Deal Management (6 tools)
- Create, read, update, and list deals
- Get latest deals and filter by date range
- Advanced deal filtering by pipeline, budget, and status

### Lead Management (6 tools)
- Create, read, update, and list leads
- Get latest leads and filter by date range

### Company Management (6 tools)
- Create, read, update, and list companies
- Get latest companies and filter by date range

### Advanced Features (10 tools)
- CRM-wide search across all entities
- Deal pipeline and stage management
- Budget-based deal filtering
- Webhook validation and diagnostics
- Permission analysis
- CRM settings inspection

## ⚙️ Configuration

The extension requires only one configuration parameter:

- **Bitrix24 Webhook URL**: Your Bitrix24 webhook URL in the format:
  `https://your-domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/`

### Getting Your Webhook URL

1. Log into your Bitrix24 instance
2. Go to **Applications** → **Webhooks**
3. Create an **Incoming webhook**
4. Set permissions for CRM entities (contacts, deals, leads, companies)
5. Copy the generated webhook URL

## 🔧 Usage Examples

Once installed, you can use natural language commands like:

- "Create a new contact for John Smith with email john@example.com"
- "Show me all deals created this month"
- "Find all contacts from company 'Tech Corp'"
- "Create a deal for €5000 and link it to contact ID 123"
- "Get all deals in the 'New Business' pipeline"
- "Show me deals with budget over €10,000"

## 🛠️ Technical Details

- **Package Size**: 5.6MB
- **Node.js Version**: Requires Node.js 18+
- **Platforms**: Windows, macOS, Linux
- **Dependencies**: All bundled (no external installations needed)

## 🔒 Security

- Webhook URL is stored securely in your OS keychain
- All communication is direct between Claude and your Bitrix24 instance
- No data is sent to third parties

## 📞 Support

- **Documentation**: [GitHub Repository](https://github.com/gunnit/bitrix24-mcp-server)
- **Issues**: [Report Issues](https://github.com/gunnit/bitrix24-mcp-server/issues)
- **License**: MIT

## 🆕 Version History

### v1.0.0
- Initial release with full CRM functionality
- 33 tools covering contacts, deals, leads, and companies
- Advanced filtering and search capabilities
- Comprehensive diagnostics and validation tools

---

**Ready to supercharge your Bitrix24 workflow with AI? Install the extension and start automating!**
