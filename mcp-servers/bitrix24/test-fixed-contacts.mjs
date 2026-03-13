import { bitrix24Client } from './build/bitrix24/client.js';

async function testFixedContacts() {
  console.log('🔍 Testing FIXED getLatestContacts method...');
  
  try {
    console.log('Getting latest 10 contacts with the fixed method...');
    const latestContacts = await bitrix24Client.getLatestContacts(10);
    
    console.log(`✅ Successfully retrieved ${latestContacts.length} latest contacts!`);
    
    console.log('\n📋 Your ACTUAL Latest 10 Contacts:');
    latestContacts.forEach((contact, index) => {
      const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
      console.log(`${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
    });
    
    // Check if we have recent contacts (2022+)
    const recentContacts = latestContacts.filter(contact => {
      const date = new Date(contact.DATE_CREATE);
      return date.getFullYear() >= 2022;
    });
    
    console.log(`\n🎯 Contacts from 2022+ in the latest 10: ${recentContacts.length}`);
    
    // Compare with basic list
    console.log('\n🔍 COMPARISON:');
    console.log('Basic list (first 10 - what you were getting before):');
    const basicContacts = await bitrix24Client.listContacts({ start: 0 });
    basicContacts.slice(0, 10).forEach((contact, index) => {
      const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
      console.log(`${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
    });
    
  } catch (error) {
    console.error('❌ Error testing fixed contacts method:', error.message);
  }
}

testFixedContacts().catch(console.error);
