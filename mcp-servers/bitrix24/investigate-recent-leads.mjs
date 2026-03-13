import { bitrix24Client } from './build/bitrix24/client.js';

async function investigateRecentLeads() {
  console.log('🔍 Investigating recent leads in Bitrix24...');
  
  try {
    // Test 1: Get ALL leads to see the full scope
    console.log('1. Getting all leads (no limit)...');
    const allLeads = await bitrix24Client.makeRequest('crm.lead.list', {
      start: 0,
      select: ['ID', 'TITLE', 'DATE_CREATE', 'DATE_MODIFY']
    });
    console.log(`Total leads found: ${allLeads.length}`);
    
    // Test 2: Check if there are more leads beyond the first batch
    console.log('2. Checking for more leads with pagination...');
    const moreLead = await bitrix24Client.makeRequest('crm.lead.list', {
      start: 50, // Start from the 51st lead
      select: ['ID', 'TITLE', 'DATE_CREATE', 'DATE_MODIFY']
    });
    console.log(`Additional leads found (starting from 51st): ${moreLead.length}`);
    
    // Test 3: Look for leads from 2025 specifically
    console.log('3. Searching for leads from 2025...');
    const leads2025 = await bitrix24Client.makeRequest('crm.lead.list', {
      start: 0,
      select: ['ID', 'TITLE', 'DATE_CREATE', 'DATE_MODIFY'],
      filter: {
        '>=DATE_CREATE': '2025-01-01'
      }
    });
    console.log(`Leads from 2025: ${leads2025.length}`);
    
    if (leads2025.length > 0) {
      console.log('📋 Recent 2025 leads:');
      leads2025.slice(0, 10).forEach((lead, index) => {
        console.log(`${index + 1}. ${lead.TITLE || 'No title'} (ID: ${lead.ID}) - Created: ${lead.DATE_CREATE}`);
      });
    }
    
    // Test 4: Look for leads from 2024
    console.log('4. Searching for leads from 2024...');
    const leads2024 = await bitrix24Client.makeRequest('crm.lead.list', {
      start: 0,
      select: ['ID', 'TITLE', 'DATE_CREATE', 'DATE_MODIFY'],
      filter: {
        '>=DATE_CREATE': '2024-01-01',
        '<DATE_CREATE': '2025-01-01'
      }
    });
    console.log(`Leads from 2024: ${leads2024.length}`);
    
    // Test 5: Get the actual latest leads by ID (highest ID numbers)
    console.log('5. Getting leads with highest IDs (most recent by ID)...');
    const latestByID = await bitrix24Client.makeRequest('crm.lead.list', {
      start: 0,
      select: ['ID', 'TITLE', 'DATE_CREATE', 'DATE_MODIFY']
    });
    
    // Sort by ID descending to get the highest ID numbers
    const sortedByID = latestByID.sort((a, b) => parseInt(b.ID) - parseInt(a.ID));
    console.log('📋 Latest leads by ID (highest ID numbers):');
    sortedByID.slice(0, 10).forEach((lead, index) => {
      console.log(`${index + 1}. ${lead.TITLE || 'No title'} (ID: ${lead.ID}) - Created: ${lead.DATE_CREATE}`);
    });
    
    // Test 6: Check date range of all leads
    console.log('6. Analyzing date range of all leads...');
    const allDates = allLeads.map(lead => new Date(lead.DATE_CREATE)).filter(date => !isNaN(date));
    if (allDates.length > 0) {
      const oldestDate = new Date(Math.min(...allDates));
      const newestDate = new Date(Math.max(...allDates));
      console.log(`Date range: ${oldestDate.toISOString()} to ${newestDate.toISOString()}`);
    }
    
  } catch (error) {
    console.error('❌ Error investigating leads:', error.message);
  }
}

investigateRecentLeads().catch(console.error);
