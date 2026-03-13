import { bitrix24Client } from './build/bitrix24/client.js';

async function testLeads() {
  console.log('🔍 Testing Bitrix24 leads API...');
  
  try {
    // Test basic webhook first
    console.log('1. Testing webhook validation...');
    const isValid = await bitrix24Client.validateWebhook();
    console.log('Webhook valid:', isValid);
    
    // Test leads API step by step
    console.log('2. Testing leads fields...');
    const fields = await bitrix24Client.makeRequest('crm.lead.fields');
    console.log('Lead fields available:', Object.keys(fields).length > 0);
    
    console.log('3. Testing basic leads list...');
    const leads = await bitrix24Client.makeRequest('crm.lead.list', { start: 0 });
    console.log('Leads found:', Array.isArray(leads) ? leads.length : 'Not an array');
    
    if (Array.isArray(leads) && leads.length > 0) {
      console.log('📋 First few leads:');
      leads.slice(0, 3).forEach((lead, index) => {
        console.log(`${index + 1}. ${lead.TITLE || 'No title'} (ID: ${lead.ID}) - Created: ${lead.DATE_CREATE}`);
      });
    }
    
    // Test the helper methods
    console.log('4. Testing getLatestLeads method...');
    const latestLeads = await bitrix24Client.getLatestLeads(10);
    console.log('Latest leads found:', latestLeads.length);
    
    if (latestLeads.length > 0) {
      console.log('📋 Latest 10 leads:');
      latestLeads.forEach((lead, index) => {
        console.log(`${index + 1}. ${lead.TITLE || 'No title'} (ID: ${lead.ID}) - Created: ${lead.DATE_CREATE}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error:', error.message);
    
    // Run full diagnostic
    console.log('🔧 Running full diagnostic...');
    try {
      const diagnosis = await bitrix24Client.diagnosePermissions();
      console.log('Permissions diagnosis:', JSON.stringify(diagnosis, null, 2));
    } catch (diagError) {
      console.error('Diagnostic failed:', diagError.message);
    }
  }
}

testLeads().catch(console.error);
