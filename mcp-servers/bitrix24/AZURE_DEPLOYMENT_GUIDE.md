# Azure Deployment Guide - Simple Approaches

## Method 1: Direct Git Deployment (Recommended - Simplest)

This is the easiest method that avoids zip file issues entirely.

### Prerequisites
- Azure CLI installed: `az --version`
- Git repository (you already have this)

### Steps

1. **Create Azure App Service**
   ```bash
   # Login to Azure
   az login
   
   # Create resource group (if you don't have one)
   az group create --name bitrix24-rg --location "East US"
   
   # Create App Service plan
   az appservice plan create --name bitrix24-plan --resource-group bitrix24-rg --sku B1 --is-linux
   
   # Create web app with Node.js runtime
   az webapp create --resource-group bitrix24-rg --plan bitrix24-plan --name bitrix24-mcp-server --runtime "NODE:18-lts"
   ```

2. **Configure Git Deployment**
   ```bash
   # Enable local git deployment
   az webapp deployment source config-local-git --name bitrix24-mcp-server --resource-group bitrix24-rg
   
   # Get deployment credentials (note the URL returned)
   az webapp deployment list-publishing-credentials --name bitrix24-mcp-server --resource-group bitrix24-rg
   ```

3. **Deploy Your Code**
   ```bash
   # Add Azure as a git remote (replace with your actual URL from step 2)
   git remote add azure https://bitrix24-mcp-server.scm.azurewebsites.net:443/bitrix24-mcp-server.git
   
   # Commit your deployment files
   git add .
   git commit -m "Add Azure deployment configuration"
   
   # Push to Azure (this will trigger deployment)
   git push azure main
   ```

## Method 2: VS Code Azure Extension (Even Simpler)

1. **Install VS Code Extension**
   - Install "Azure App Service" extension in VS Code

2. **Deploy**
   - Right-click your project folder
   - Select "Deploy to Web App..."
   - Follow the prompts to create/select your Azure resources
   - VS Code handles everything automatically

## Method 3: Azure CLI Direct Deploy

If you want to use your existing deployment.zip:

```bash
# Deploy the zip file directly
az webapp deployment source config-zip --resource-group bitrix24-rg --name bitrix24-mcp-server --src deployment.zip
```

## Environment Variables

Set your Bitrix24 credentials in Azure:

```bash
az webapp config appsettings set --resource-group bitrix24-rg --name bitrix24-mcp-server --settings BITRIX24_WEBHOOK_URL="your_webhook_url" BITRIX24_ACCESS_TOKEN="your_token"
```

## Troubleshooting

1. **Build Issues**: The deploy.cmd script will automatically run `npm install` and `npm run build`
2. **Port Issues**: Azure automatically sets the PORT environment variable
3. **Logs**: View logs with `az webapp log tail --name bitrix24-mcp-server --resource-group bitrix24-rg`

## What We've Set Up

- `web.config`: IIS configuration for Node.js on Windows App Service
- `.deployment`: Tells Azure to use our custom deploy.cmd
- `deploy.cmd`: Custom deployment script that builds TypeScript
- Updated `package.json`: Added azure:start script

The deployment script will:
1. Install dependencies
2. Build TypeScript to JavaScript
3. Start your application

Choose Method 1 (Git deployment) for the most reliable and simple approach!
