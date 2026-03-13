import { bitrix24Client } from './build/bitrix24/client.js';

async function getAllLeads() {
  console.log('🔍 Getting ALL leads from Bitrix24...');
  
  try {
    let allLeads = [];
    let start = 0;
    let hasMore = true;
    const batchSize = 50;
    
    // Get all leads using pagination
    while (hasMore) {
      console.log(`Fetching leads batch starting from ${start}...`);
      
      const batch = await bitrix24Client.makeRequest('crm.lead.list', {
        start: start,
        select: ['ID', 'TITLE', 'DATE_CREATE', 'DATE_MODIFY', 'NAME', 'LAST_NAME', 'COMPANY_TITLE']
      });
      
      if (batch.length === 0) {
        hasMore = false;
      } else {
        allLeads = allLeads.concat(batch);
        start += batchSize;
        console.log(`Found ${batch.length} leads in this batch. Total so far: ${allLeads.length}`);
        
        // Safety check to avoid infinite loop
        if (start > 1000) {
          console.log('Safety limit reached (1000+ leads). Stopping pagination.');
          break;
        }
      }
    }
    
    console.log(`\n📊 TOTAL LEADS FOUND: ${allLeads.length}`);
    
    // Sort all leads by creation date (newest first)
    const sortedLeads = allLeads.sort((a, b) => {
      const dateA = new Date(a.DATE_CREATE || '1970-01-01');
      const dateB = new Date(b.DATE_CREATE || '1970-01-01');
      return dateB.getTime() - dateA.getTime(); // DESC order (newest first)
    });
    
    console.log('\n📋 LATEST 10 LEADS (by creation date):');
    sortedLeads.slice(0, 10).forEach((lead, index) => {
      const name = [lead.NAME, lead.LAST_NAME].filter(Boolean).join(' ') || lead.COMPANY_TITLE || 'No name';
      console.log(`${index + 1}. ${lead.TITLE || name} (ID: ${lead.ID}) - Created: ${lead.DATE_CREATE}`);
    });
    
    // Also sort by ID (highest ID numbers, which are usually most recent)
    const sortedByID = allLeads.sort((a, b) => parseInt(b.ID) - parseInt(a.ID));
    
    console.log('\n📋 LATEST 10 LEADS (by ID - highest numbers):');
    sortedByID.slice(0, 10).forEach((lead, index) => {
      const name = [lead.NAME, lead.LAST_NAME].filter(Boolean).join(' ') || lead.COMPANY_TITLE || 'No name';
      console.log(`${index + 1}. ${lead.TITLE || name} (ID: ${lead.ID}) - Created: ${lead.DATE_CREATE}`);
    });
    
    // Check date range
    const allDates = allLeads.map(lead => new Date(lead.DATE_CREATE)).filter(date => !isNaN(date));
    if (allDates.length > 0) {
      const oldestDate = new Date(Math.min(...allDates));
      const newestDate = new Date(Math.max(...allDates));
      console.log(`\n📅 DATE RANGE: ${oldestDate.toISOString().split('T')[0]} to ${newestDate.toISOString().split('T')[0]}`);
    }
    
    // Check for 2025 leads
    const leads2025 = allLeads.filter(lead => {
      const date = new Date(lead.DATE_CREATE);
      return date.getFullYear() === 2025;
    });
    
    console.log(`\n🎯 LEADS FROM 2025: ${leads2025.length}`);
    if (leads2025.length > 0) {
      console.log('📋 2025 leads:');
      leads2025.forEach((lead, index) => {
        const name = [lead.NAME, lead.LAST_NAME].filter(Boolean).join(' ') || lead.COMPANY_TITLE || 'No name';
        console.log(`${index + 1}. ${lead.TITLE || name} (ID: ${lead.ID}) - Created: ${lead.DATE_CREATE}`);
      });
    }
    
  } catch (error) {
    console.error('❌ Error getting all leads:', error.message);
  }
}

getAllLeads().catch(console.error);
