import { bitrix24Client } from './build/bitrix24/client.js';

async function testDirectAPIOrdering() {
  console.log('🔍 Testing direct API ordering to understand the issue...\n');
  
  try {
    // Test 1: Try using Bitrix24's built-in ordering for contacts
    console.log('1. Testing direct API ordering for contacts:');
    
    console.log('   a) Using order by ID DESC:');
    const contactsByIdDesc = await bitrix24Client.listContacts({
      start: 0,
      order: { 'ID': 'DESC' }
    });
    console.log(`   Found ${contactsByIdDesc.length} contacts`);
    if (contactsByIdDesc.length > 0) {
      contactsByIdDesc.slice(0, 5).forEach((contact, index) => {
        const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
        console.log(`   ${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
      });
      
      // Check if our new contact is there
      const foundContact = contactsByIdDesc.find(c => c.ID === '31224');
      if (foundContact) {
        console.log(`   ✅ Found new contact in ID DESC order!`);
      } else {
        console.log(`   ❌ New contact not found in ID DESC order`);
      }
    }
    
    console.log('\n   b) Using order by DATE_CREATE DESC:');
    try {
      const contactsByDateDesc = await bitrix24Client.listContacts({
        start: 0,
        order: { 'DATE_CREATE': 'DESC' }
      });
      console.log(`   Found ${contactsByDateDesc.length} contacts`);
      if (contactsByDateDesc.length > 0) {
        contactsByDateDesc.slice(0, 5).forEach((contact, index) => {
          const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
          console.log(`   ${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
        });
        
        // Check if our new contact is there
        const foundContact = contactsByDateDesc.find(c => c.ID === '31224');
        if (foundContact) {
          console.log(`   ✅ Found new contact in DATE_CREATE DESC order!`);
        } else {
          console.log(`   ❌ New contact not found in DATE_CREATE DESC order`);
        }
      }
    } catch (error) {
      console.log(`   ❌ DATE_CREATE ordering failed: ${error.message}`);
    }
    
    // Test 2: Try using Bitrix24's built-in ordering for deals
    console.log('\n2. Testing direct API ordering for deals:');
    
    console.log('   a) Using order by ID DESC:');
    const dealsByIdDesc = await bitrix24Client.listDeals({
      start: 0,
      order: { 'ID': 'DESC' },
      select: ['*']
    });
    console.log(`   Found ${dealsByIdDesc.length} deals`);
    if (dealsByIdDesc.length > 0) {
      dealsByIdDesc.slice(0, 5).forEach((deal, index) => {
        const title = deal.TITLE || `Deal #${deal.ID}`;
        console.log(`   ${index + 1}. ${title} (ID: ${deal.ID}) - Created: ${deal.DATE_CREATE}`);
      });
      
      // Check if our new deal is there
      const foundDeal = dealsByIdDesc.find(d => d.ID === '38402');
      if (foundDeal) {
        console.log(`   ✅ Found new deal in ID DESC order!`);
      } else {
        console.log(`   ❌ New deal not found in ID DESC order`);
      }
    }
    
    console.log('\n   b) Using order by DATE_CREATE DESC:');
    try {
      const dealsByDateDesc = await bitrix24Client.listDeals({
        start: 0,
        order: { 'DATE_CREATE': 'DESC' },
        select: ['*']
      });
      console.log(`   Found ${dealsByDateDesc.length} deals`);
      if (dealsByDateDesc.length > 0) {
        dealsByDateDesc.slice(0, 5).forEach((deal, index) => {
          const title = deal.TITLE || `Deal #${deal.ID}`;
          console.log(`   ${index + 1}. ${title} (ID: ${deal.ID}) - Created: ${deal.DATE_CREATE}`);
        });
        
        // Check if our new deal is there
        const foundDeal = dealsByDateDesc.find(d => d.ID === '38402');
        if (foundDeal) {
          console.log(`   ✅ Found new deal in DATE_CREATE DESC order!`);
        } else {
          console.log(`   ❌ New deal not found in DATE_CREATE DESC order`);
        }
      }
    } catch (error) {
      console.log(`   ❌ DATE_CREATE ordering failed: ${error.message}`);
    }
    
    // Test 3: Try with a filter for today's date
    console.log('\n3. Testing with date filter for today:');
    const today = new Date().toISOString().split('T')[0]; // YYYY-MM-DD format
    
    console.log(`   Filtering contacts created today (${today}):`)
    try {
      const todayContacts = await bitrix24Client.listContacts({
        start: 0,
        filter: { '>=DATE_CREATE': today }
      });
      console.log(`   Found ${todayContacts.length} contacts created today`);
      todayContacts.forEach((contact, index) => {
        const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
        console.log(`   ${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
      });
    } catch (error) {
      console.log(`   ❌ Date filter failed: ${error.message}`);
    }
    
    console.log(`\n   Filtering deals created today (${today}):`)
    try {
      const todayDeals = await bitrix24Client.listDeals({
        start: 0,
        filter: { '>=DATE_CREATE': today },
        select: ['*']
      });
      console.log(`   Found ${todayDeals.length} deals created today`);
      todayDeals.forEach((deal, index) => {
        const title = deal.TITLE || `Deal #${deal.ID}`;
        console.log(`   ${index + 1}. ${title} (ID: ${deal.ID}) - Created: ${deal.DATE_CREATE}`);
      });
    } catch (error) {
      console.log(`   ❌ Date filter failed: ${error.message}`);
    }
    
  } catch (error) {
    console.error('❌ Error testing API ordering:', error.message);
  }
}

testDirectAPIOrdering().catch(console.error);
