# GitHub Actions Azure Deployment Guide

This guide will help you set up continuous deployment from GitHub to Azure App Service for your Bitrix24 MCP Server.

## Prerequisites

1. **Azure Account** with an active subscription
2. **GitHub Repository** (already set up)
3. **Azure CLI** installed locally (optional, for manual setup)

## Step 1: Create Azure App Service

### Option A: Using Azure Portal (Recommended)

1. Go to [Azure Portal](https://portal.azure.com)
2. Click "Create a resource" → "Web App"
3. Fill in the details:
   - **Subscription**: Your Azure subscription
   - **Resource Group**: Create new or use existing (e.g., `bitrix24-rg`)
   - **Name**: `bitrix24-mcp-server` (must be globally unique)
   - **Publish**: Code
   - **Runtime stack**: Node 18 LTS
   - **Operating System**: Linux
   - **Region**: Choose closest to your users
   - **Pricing Plan**: B1 Basic (or higher for production)

4. Click "Review + create" → "Create"

### Option B: Using Azure CLI

```bash
# Login to Azure
az login

# Create resource group
az group create --name bitrix24-rg --location "East US"

# Create App Service plan
az appservice plan create --name bitrix24-plan --resource-group bitrix24-rg --sku B1 --is-linux

# Create web app
az webapp create --resource-group bitrix24-rg --plan bitrix24-plan --name bitrix24-mcp-server --runtime "NODE:18-lts"
```

## Step 2: Get Azure Publish Profile

1. In Azure Portal, go to your App Service
2. Click "Get publish profile" in the overview section
3. Download the `.publishsettings` file
4. Open the file and copy its entire contents

## Step 3: Configure GitHub Secrets

1. Go to your GitHub repository
2. Click "Settings" → "Secrets and variables" → "Actions"
3. Click "New repository secret"
4. Add the following secret:
   - **Name**: `AZURE_WEBAPP_PUBLISH_PROFILE`
   - **Value**: Paste the entire contents of the publish profile file

## Step 4: Configure Environment Variables in Azure

1. In Azure Portal, go to your App Service
2. Click "Configuration" → "Application settings"
3. Add your Bitrix24 credentials:
   - `BITRIX24_WEBHOOK_URL`: Your Bitrix24 webhook URL
   - `BITRIX24_ACCESS_TOKEN`: Your Bitrix24 access token
   - `NODE_ENV`: `production`

4. Click "Save"

## Step 5: Deploy

The GitHub Actions workflow is already configured in `.github/workflows/azure-deploy.yml`. 

### Automatic Deployment
- Push to the `main` branch will automatically trigger deployment
- The workflow will:
  1. Build your TypeScript code
  2. Run tests
  3. Create a deployment package
  4. Deploy to Azure
  5. Test the deployment

### Manual Deployment
You can also trigger deployment manually:
1. Go to your GitHub repository
2. Click "Actions" tab
3. Select "Deploy to Azure App Service"
4. Click "Run workflow"

## Step 6: Verify Deployment

After deployment, your app will be available at:
`https://bitrix24-mcp-server.azurewebsites.net`

Test endpoints:
- **Health Check**: `https://bitrix24-mcp-server.azurewebsites.net/health`
- **Main Page**: `https://bitrix24-mcp-server.azurewebsites.net/`

## Troubleshooting

### Common Issues

1. **Build Fails**
   - Check that all dependencies are in `package.json`
   - Ensure TypeScript compiles without errors locally

2. **Deployment Fails**
   - Verify the publish profile secret is correct
   - Check that the app name matches in the workflow file

3. **App Doesn't Start**
   - Check Azure logs: App Service → Monitoring → Log stream
   - Verify environment variables are set correctly

### Viewing Logs

```bash
# Using Azure CLI
az webapp log tail --name bitrix24-mcp-server --resource-group bitrix24-rg

# Or in Azure Portal
# Go to App Service → Monitoring → Log stream
```

### Updating the App Name

If you need to change the Azure app name:
1. Update `AZURE_WEBAPP_NAME` in `.github/workflows/azure-deploy.yml`
2. Create a new Azure App Service with the new name
3. Update the publish profile secret in GitHub

## Workflow Details

The GitHub Actions workflow:
- **Triggers**: Push to main branch, manual trigger
- **Node Version**: 18.x
- **Build Steps**: Install dependencies, build TypeScript, run tests
- **Deployment**: Creates clean package, deploys to Azure
- **Testing**: Verifies deployment with health check

## Security Notes

- Never commit secrets to your repository
- Use GitHub Secrets for sensitive information
- Regularly rotate your Bitrix24 access tokens
- Monitor Azure costs and usage

## Next Steps

- Set up staging environment for testing
- Configure custom domain if needed
- Set up monitoring and alerts
- Consider using Azure Application Insights for detailed monitoring
