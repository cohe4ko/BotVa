# Bitrix24 MCP Server - Installation Guide

This guide provides multiple installation options for the Bitrix24 MCP Server, from fully automated to manual setup.

## 🚀 Quick Start Options

### Option 1: Fully Automated Installation (Recommended)
```batch
# Run the complete setup script
install-complete-setup.bat
```

### Option 2: Simple Installation
```batch
# Run the basic installation script
install-simple.bat
```

### Option 3: Manual Installation
Follow the step-by-step instructions below.

## 📋 Prerequisites

Before installing, ensure you have:

- **Windows 10/11** (for batch file installation)
- **Node.js 18+** - Download from [nodejs.org](https://nodejs.org/)
- **Claude Desktop** - Download from [claude.ai](https://claude.ai/download)
- **Bitrix24 Account** with webhook access
- **Administrator privileges** (recommended for automatic installation)

## 🔧 Installation Methods

### Method 1: Fully Automated Installation

The `install-complete-setup.bat` script performs a complete installation and configuration:

**What it does:**
- ✅ Checks for Node.js installation
- ✅ Installs all project dependencies
- ✅ Builds the TypeScript project
- ✅ Creates environment configuration
- ✅ Sets up Claude Desktop integration
- ✅ Tests the installation
- ✅ Provides troubleshooting information

**How to use:**
1. Download or clone the project
2. Right-click `install-complete-setup.bat`
3. Select "Run as administrator" (recommended)
4. Follow the on-screen prompts
5. Configure your Bitrix24 webhook URL when prompted
6. Restart Claude Desktop

**Features:**
- Automatic prerequisite checking
- Error handling and recovery
- Claude Desktop configuration
- Integration testing
- Comprehensive status reporting

### Method 2: Simple Installation

The `install-simple.bat` script provides basic installation:

**What it does:**
- ✅ Checks for Node.js
- ✅ Installs dependencies
- ✅ Builds the project
- ✅ Creates environment file

**How to use:**
1. Double-click `install-simple.bat`
2. Configure the `.env` file when it opens
3. Manually configure Claude Desktop (see below)

### Method 3: Manual Installation

If you prefer manual control or the batch files don't work:

#### Step 1: Install Node.js
1. Download Node.js from [nodejs.org](https://nodejs.org/)
2. Install with default settings
3. Restart your computer
4. Verify installation:
   ```cmd
   node --version
   npm --version
   ```

#### Step 2: Install Project Dependencies
```cmd
cd c:\Dev\bitrix24
npm install
```

#### Step 3: Build the Project
```cmd
npm run build
```

#### Step 4: Configure Environment
```cmd
copy .env.example .env
notepad .env
```

Edit the `.env` file with your Bitrix24 webhook URL:
```env
BITRIX24_WEBHOOK_URL=https://your-domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/
NODE_ENV=development
LOG_LEVEL=info
```

#### Step 5: Configure Claude Desktop
1. Locate your Claude Desktop config file:
   - **Windows:** `%APPDATA%\Claude\claude_desktop_config.json`
   - **macOS:** `~/Library/Application Support/Claude/claude_desktop_config.json`

2. Add the MCP server configuration:
```json
{
  "mcpServers": {
    "bitrix24": {
      "command": "node",
      "args": ["C:/Dev/bitrix24/build/index.js"],
      "env": {
        "BITRIX24_WEBHOOK_URL": "https://your-domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/"
      }
    }
  }
}
```

3. Restart Claude Desktop

#### Step 6: Test Installation
```cmd
npm test
```

## 🔑 Bitrix24 Webhook Setup

### Creating a Webhook
1. Log into your Bitrix24 instance
2. Go to **Applications** → **Webhooks**
3. Click **Add Webhook**
4. Select **Incoming webhook**
5. Set permissions for:
   - **CRM** (contacts, deals, companies)
   - **Tasks** (task management)
   - **User** (user information)
6. Copy the generated webhook URL
7. Format: `https://domain.bitrix24.com/rest/USER_ID/WEBHOOK_CODE/`

### Required Permissions
- `crm` - For contact and deal management
- `task` - For task operations
- `user` - For user information
- `entity` - For custom entities (optional)

## 🧪 Testing Your Installation

### Quick Test
Ask Claude Desktop:
```
"What Bitrix24 tools do you have available?"
```

You should see 15 tools listed.

### Detailed Test
```cmd
# Test server startup
node build/index.js

# Run integration tests
npm test

# Test specific functionality
npm run dev
```

### Expected Results
- ✅ Server starts without errors
- ✅ Shows "Starting Bitrix24 MCP Server..." message
- ✅ Lists 15 available tools
- ✅ Claude Desktop shows Bitrix24 integration

## 🛠️ Troubleshooting

### Common Issues

#### "Node.js not found"
**Solution:**
1. Install Node.js from [nodejs.org](https://nodejs.org/)
2. Restart your computer
3. Run the installation script again

#### "npm install failed"
**Solutions:**
- Check internet connection
- Run as administrator
- Clear npm cache: `npm cache clean --force`
- Delete `node_modules` and run `npm install` again

#### "Build failed"
**Solutions:**
- Ensure all dependencies are installed
- Check for TypeScript errors in the code
- Run `npm run build` manually to see detailed errors

#### "Claude Desktop not showing tools"
**Solutions:**
- Verify config file path is correct
- Check JSON syntax in config file
- Restart Claude Desktop completely
- Ensure the server path in config matches your installation

#### "Webhook validation failed"
**Solutions:**
- Verify webhook URL is correct
- Check Bitrix24 permissions
- Test webhook URL in browser
- Ensure Bitrix24 instance is accessible

### Debug Mode
Enable detailed logging:
```env
NODE_ENV=development
LOG_LEVEL=debug
```

### Getting Help
1. Check `TROUBLESHOOTING_GUIDE.md`
2. Review error messages carefully
3. Test each component individually
4. Check GitHub issues for similar problems

## 📁 File Structure After Installation

```
bitrix24-mcp-server/
├── build/                     # Compiled JavaScript (auto-generated)
│   └── index.js              # Main MCP server executable
├── src/                      # TypeScript source code
├── test/                     # Integration tests
├── .env                      # Your environment configuration
├── install-complete-setup.bat # Full automated installer
├── install-simple.bat        # Basic installer
├── package.json              # Project configuration
└── README.md                 # Documentation
```

## 🎯 Next Steps After Installation

1. **Test Basic Operations**
   - Create a contact through Claude
   - List existing deals
   - Search CRM data

2. **Explore Advanced Features**
   - Use filtering and search capabilities
   - Create complex workflows
   - Integrate with other tools

3. **Customize for Your Needs**
   - Modify environment variables
   - Add custom fields mapping
   - Extend functionality

## 🔄 Updating the Installation

To update to a newer version:
```cmd
git pull origin main
npm install
npm run build
```

Or re-run the installation script:
```cmd
install-complete-setup.bat
```

## 🚨 Important Security Notes

- **Never commit `.env` files** to version control
- **Keep webhook URLs secret** and rotate them regularly
- **Use HTTPS** for all Bitrix24 connections
- **Limit webhook permissions** to only what's needed
- **Monitor API usage** to detect unusual activity

## 📞 Support

If you encounter issues:
1. Check this installation guide
2. Review the troubleshooting section
3. Check existing GitHub issues
4. Create a new issue with detailed error information

---

**Installation successful?** 🎉 You're ready to automate your Bitrix24 workflows with AI!
