# Claude Desktop Remote MCP Server Setup

Now that your Bitrix24 MCP Server is deployed to Azure, you can configure Claude Desktop to use the remote server instead of running it locally.

## Option 1: HTTP-based Remote Connection (Recommended)

### Step 1: Install MCP Fetch Server
First, install the MCP fetch server globally:

```bash
npm install -g @modelcontextprotocol/server-fetch
```

### Step 2: Update Claude Desktop Configuration

Replace your current `claude_desktop_config.json` with this configuration:

```json
{
  "mcpServers": {
    "bitrix24-remote": {
      "command": "npx",
      "args": [
        "@modelcontextprotocol/server-fetch",
        "https://bitrix24-mcp-server.azurewebsites.net/mcp"
      ],
      "env": {}
    }
  }
}
```

### Step 3: Restart Claude Desktop
- Close Claude Desktop completely
- Restart the application
- The remote MCP server should now be available

## Option 2: Direct HTTP Connection (Alternative)

If Option 1 doesn't work, you can try this alternative configuration:

```json
{
  "mcpServers": {
    "bitrix24-remote": {
      "command": "curl",
      "args": [
        "-X", "POST",
        "-H", "Content-Type: application/json",
        "-d", "@-",
        "https://bitrix24-mcp-server.azurewebsites.net/mcp"
      ],
      "env": {}
    }
  }
}
```

## Configuration File Locations

### Windows
```
%APPDATA%\Claude\claude_desktop_config.json
```

### macOS
```
~/Library/Application Support/Claude/claude_desktop_config.json
```

### Linux
```
~/.config/Claude/claude_desktop_config.json
```

## Verification Steps

1. **Check Server Status**: Visit https://bitrix24-mcp-server.azurewebsites.net/health
2. **Restart Claude Desktop**: Completely close and reopen the application
3. **Test MCP Tools**: Try using Bitrix24 tools in Claude Desktop
4. **Check Logs**: Look for any connection errors in Claude Desktop

## Benefits of Remote MCP Server

✅ **Always Available**: Server runs 24/7 on Azure
✅ **No Local Dependencies**: No need to run Node.js locally
✅ **Automatic Updates**: Server updates automatically via GitHub Actions
✅ **Better Performance**: Dedicated server resources
✅ **Shared Access**: Multiple users can use the same server

## Troubleshooting

### Issue: MCP Server Not Connecting
- Verify the server is running: https://bitrix24-mcp-server.azurewebsites.net/health
- Check your internet connection
- Ensure Claude Desktop is completely restarted

### Issue: Tools Not Available
- Verify the configuration file syntax is correct
- Check that the server URL is accessible
- Try the alternative configuration method

### Issue: Authentication Errors
- The Bitrix24 credentials are configured on the server side
- No local environment variables needed

## Backup Your Current Configuration

Before making changes, backup your current configuration:

```bash
# Windows
copy "%APPDATA%\Claude\claude_desktop_config.json" "%APPDATA%\Claude\claude_desktop_config_backup.json"

# macOS/Linux
cp "~/Library/Application Support/Claude/claude_desktop_config.json" "~/Library/Application Support/Claude/claude_desktop_config_backup.json"
```

## Server Endpoints

- **Main Page**: https://bitrix24-mcp-server.azurewebsites.net/
- **Health Check**: https://bitrix24-mcp-server.azurewebsites.net/health
- **MCP Endpoint**: https://bitrix24-mcp-server.azurewebsites.net/mcp

Your remote MCP server is ready to use!
