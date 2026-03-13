import { bitrix24Client } from './build/bitrix24/client.js';

async function testContacts() {
  console.log('🔍 Testing Bitrix24 contacts functionality...');
  
  try {
    // Test 1: Get basic contacts list
    console.log('1. Testing basic contacts list...');
    const contacts = await bitrix24Client.listContacts({ start: 0 });
    console.log(`Found ${contacts.length} contacts in first batch`);
    
    // Test 2: Check if there are more contacts with pagination
    console.log('2. Checking for more contacts with pagination...');
    const moreContacts = await bitrix24Client.listContacts({ start: 50 });
    console.log(`Additional contacts found (starting from 51st): ${moreContacts.length}`);
    
    // Test 3: Get ALL contacts using pagination
    console.log('3. Getting ALL contacts using pagination...');
    let allContacts = [];
    let start = 0;
    let hasMore = true;
    const batchSize = 50;
    
    while (hasMore) {
      console.log(`Fetching contacts batch starting from ${start}...`);
      
      const batch = await bitrix24Client.listContacts({ start: start });
      
      if (batch.length === 0) {
        hasMore = false;
      } else {
        allContacts = allContacts.concat(batch);
        start += batchSize;
        console.log(`Found ${batch.length} contacts in this batch. Total so far: ${allContacts.length}`);
        
        // Safety check to avoid infinite loop
        if (start > 1000) {
          console.log('Safety limit reached (1000+ contacts). Stopping pagination.');
          break;
        }
      }
    }
    
    console.log(`\n📊 TOTAL CONTACTS FOUND: ${allContacts.length}`);
    
    // Test 4: Sort all contacts by creation date (newest first)
    const sortedContacts = allContacts.sort((a, b) => {
      const dateA = new Date(a.DATE_CREATE || '1970-01-01');
      const dateB = new Date(b.DATE_CREATE || '1970-01-01');
      return dateB.getTime() - dateA.getTime(); // DESC order (newest first)
    });
    
    console.log('\n📋 LATEST 10 CONTACTS (by creation date):');
    sortedContacts.slice(0, 10).forEach((contact, index) => {
      const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
      console.log(`${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
    });
    
    // Test 5: Check date range
    const allDates = allContacts.map(contact => new Date(contact.DATE_CREATE)).filter(date => !isNaN(date));
    if (allDates.length > 0) {
      const oldestDate = new Date(Math.min(...allDates));
      const newestDate = new Date(Math.max(...allDates));
      console.log(`\n📅 CONTACTS DATE RANGE: ${oldestDate.toISOString().split('T')[0]} to ${newestDate.toISOString().split('T')[0]}`);
    }
    
    // Test 6: Check for 2025 contacts
    const contacts2025 = allContacts.filter(contact => {
      const date = new Date(contact.DATE_CREATE);
      return date.getFullYear() === 2025;
    });
    
    console.log(`\n🎯 CONTACTS FROM 2025: ${contacts2025.length}`);
    if (contacts2025.length > 0) {
      console.log('📋 2025 contacts:');
      contacts2025.slice(0, 10).forEach((contact, index) => {
        const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
        console.log(`${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
      });
    }
    
    // Test 7: Compare first 10 from basic list vs actual latest 10
    console.log('\n🔍 COMPARISON:');
    console.log('First 10 from basic list (what you might be getting now):');
    contacts.slice(0, 10).forEach((contact, index) => {
      const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
      console.log(`${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
    });
    
  } catch (error) {
    console.error('❌ Error testing contacts:', error.message);
  }
}

testContacts().catch(console.error);
