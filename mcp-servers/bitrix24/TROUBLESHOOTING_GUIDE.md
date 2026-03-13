# Bitrix24 Leads API Troubleshooting Guide

## Common Issues and Solutions

### 1. Webhook Permissions
The webhook might not have sufficient permissions to access leads data.

#### Check Required Permissions
Your webhook needs these scopes:
- `crm` - Basic CRM access
- `crm.lead.read` - Read leads
- `crm.lead.write` - Create/update leads

#### How to Check/Fix Permissions
1. Go to your Bitrix24 admin panel
2. Navigate to **Applications** → **Webhooks**
3. Find your webhook and check the permissions
4. Ensure `CRM` permissions are enabled

### 2. Bitrix24 CRM Mode
Bitrix24 has different CRM modes that affect lead availability.

#### Simple CRM Mode
- In "Simple CRM" mode, leads might be disabled
- Check: **CRM** → **Settings** → **CRM Mode**
- Switch to "Classic CRM" if leads are needed

### 3. API Rate Limits
Bitrix24 has rate limits that might cause issues.

#### Current Implementation
- 500ms delay between requests (2 requests/second)
- This should be sufficient for most use cases

### 4. Authentication Issues
Even with a valid webhook, specific endpoints might have different requirements.

## Diagnostic Tools

I've added diagnostic methods to help identify the issue:

### 1. Permission Diagnosis Tool
**Tool**: `bitrix24_diagnose_permissions`

This tool tests:
- Basic webhook connectivity (`app.info`)
- User permissions (`user.access`)
- CRM access (contacts, deals, leads)
- Specific leads API access

**Usage**: Run this tool first to get a comprehensive overview of what's working and what's not.

### 2. CRM Settings Check Tool
**Tool**: `bitrix24_check_crm_settings`

This tool checks:
- Lead fields availability (`crm.lead.fields`)
- Lead statuses (`crm.status.list`)
- CRM mode settings (if accessible)

**Usage**: Use this to determine if leads are properly configured in your Bitrix24 instance.

### 3. Leads API Test Tool
**Tool**: `bitrix24_test_leads_api`

This tool performs multiple tests:
- Basic lead list (`crm.lead.list`)
- Lead fields retrieval
- Parameterized lead queries
- Lead count estimation

**Usage**: Use this for detailed testing of the leads API specifically.

## Step-by-Step Troubleshooting

### Step 1: Run Permission Diagnosis
```bash
# Use the diagnostic tool
bitrix24_diagnose_permissions
```

Look for:
- `webhook_valid: true`
- `crm_access: true`
- `leads_access: true`

### Step 2: Check CRM Settings
```bash
# Check CRM configuration
bitrix24_check_crm_settings
```

Look for:
- `lead_fields` should contain field definitions
- `lead_statuses` should contain status list
- Check `error_details` for specific issues

### Step 3: Test Leads API
```bash
# Test leads API endpoints
bitrix24_test_leads_api
```

Look for:
- `simple_list` should return lead data
- `fields_test` should return field definitions
- Check `error_details` for specific failures

## Common Solutions

### If Permission Diagnosis Fails
1. **Webhook Invalid**: Check webhook URL and regenerate if needed
2. **CRM Access Denied**: Ensure webhook has CRM permissions
3. **Leads Access Denied**: Check if leads are enabled in CRM mode

### If CRM Settings Check Fails
1. **Lead Fields Missing**: Leads might be disabled in Simple CRM mode
2. **Status Errors**: Lead statuses might not be properly configured
3. **Mode Issues**: Switch from Simple to Classic CRM mode

### If Leads API Test Fails
1. **Simple List Fails**: Basic API connectivity issue
2. **Fields Test Fails**: Lead entity might be disabled
3. **Parameterized Queries Fail**: Specific parameter formatting issues

## Manual Checks in Bitrix24 Admin

### 1. Check CRM Mode
1. Go to **CRM** → **Settings** → **CRM Settings**
2. Look for **CRM Mode** section
3. Ensure it's set to **Classic CRM** (not Simple CRM)
4. If in Simple CRM, leads might be disabled

### 2. Check Webhook Permissions
1. Go to **Applications** → **Webhooks**
2. Find your webhook
3. Ensure **CRM** permissions are enabled
4. Check for specific lead permissions if available

### 3. Check Lead Settings
1. Go to **CRM** → **Leads**
2. Verify leads are visible and accessible
3. Check if any leads exist in the system
4. Try creating a test lead manually

## Expected Diagnostic Results

### Healthy System
```json
{
  "webhook_valid": true,
  "crm_access": true,
  "leads_access": true,
  "contacts_access": true,
  "deals_access": true,
  "error_details": []
}
```

### Common Issues
```json
{
  "webhook_valid": true,
  "crm_access": true,
  "leads_access": false,
  "error_details": [
    "leads access failed: Access denied"
  ]
}
```

This indicates leads are specifically blocked, likely due to CRM mode or permissions.
