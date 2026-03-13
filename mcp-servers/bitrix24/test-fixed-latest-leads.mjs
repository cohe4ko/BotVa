import { bitrix24Client } from './build/bitrix24/client.js';

async function testFixedLatestLeads() {
  console.log('🔍 Testing FIXED getLatestLeads method...');
  
  try {
    console.log('Getting latest 10 leads with the fixed method...');
    const latestLeads = await bitrix24Client.getLatestLeads(10);
    
    console.log(`✅ Successfully retrieved ${latestLeads.length} latest leads!`);
    
    console.log('\n📋 Your ACTUAL Latest 10 Leads:');
    latestLeads.forEach((lead, index) => {
      const name = [lead.NAME, lead.LAST_NAME].filter(Boolean).join(' ') || lead.COMPANY_TITLE || 'No name';
      const title = lead.TITLE || name || `Lead #${lead.ID}`;
      console.log(`${index + 1}. ${title} (ID: ${lead.ID}) - Created: ${lead.DATE_CREATE}`);
    });
    
    // Check if we have 2025 leads
    const leads2025 = latestLeads.filter(lead => {
      const date = new Date(lead.DATE_CREATE);
      return date.getFullYear() === 2025;
    });
    
    console.log(`\n🎯 Leads from 2025 in the latest 10: ${leads2025.length}`);
    
  } catch (error) {
    console.error('❌ Error testing fixed method:', error.message);
  }
}

testFixedLatestLeads().catch(console.error);
