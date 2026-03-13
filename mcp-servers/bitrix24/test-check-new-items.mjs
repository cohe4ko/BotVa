import { bitrix24Client } from './build/bitrix24/client.js';

async function checkNewItems() {
  console.log('🔍 Checking the newly created items...\n');
  
  try {
    const contactId = '31224';
    const dealId = '38402';
    
    // Check the specific contact
    console.log('1. Checking the new contact details:');
    const contact = await bitrix24Client.getContact(contactId);
    console.log(`   Contact: ${contact.NAME} ${contact.LAST_NAME} (ID: ${contact.ID})`);
    console.log(`   Created: ${contact.DATE_CREATE}`);
    console.log(`   Modified: ${contact.DATE_MODIFY}`);
    
    // Check the specific deal
    console.log('\n2. Checking the new deal details:');
    const deal = await bitrix24Client.getDeal(dealId);
    console.log(`   Deal: ${deal.TITLE} (ID: ${deal.ID})`);
    console.log(`   Created: ${deal.DATE_CREATE}`);
    console.log(`   Modified: ${deal.DATE_MODIFY}`);
    console.log(`   Begin Date: ${deal.BEGINDATE}`);
    
    // Try a different approach - get contacts with a higher limit
    console.log('\n3. Trying to get more contacts (limit 50) to see if new contact appears:');
    const moreContacts = await bitrix24Client.getLatestContacts(50);
    const foundContact = moreContacts.find(c => c.ID === contactId);
    
    if (foundContact) {
      console.log(`✅ Found new contact in top 50!`);
      const position = moreContacts.findIndex(c => c.ID === contactId) + 1;
      console.log(`   Position: ${position}/50`);
    } else {
      console.log(`❌ New contact not found even in top 50`);
      console.log('   First 10 contacts:');
      moreContacts.slice(0, 10).forEach((contact, index) => {
        const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
        console.log(`   ${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
      });
    }
    
    // Try a different approach - get deals with a higher limit
    console.log('\n4. Trying to get more deals (limit 50) to see if new deal appears:');
    const moreDeals = await bitrix24Client.getLatestDeals(50);
    const foundDeal = moreDeals.find(d => d.ID === dealId);
    
    if (foundDeal) {
      console.log(`✅ Found new deal in top 50!`);
      const position = moreDeals.findIndex(d => d.ID === dealId) + 1;
      console.log(`   Position: ${position}/50`);
    } else {
      console.log(`❌ New deal not found even in top 50`);
      console.log('   First 10 deals:');
      moreDeals.slice(0, 10).forEach((deal, index) => {
        const title = deal.TITLE || `Deal #${deal.ID}`;
        console.log(`   ${index + 1}. ${title} (ID: ${deal.ID}) - Created: ${deal.DATE_CREATE}`);
      });
    }
    
    // Try using the basic list method to see if the items appear there
    console.log('\n5. Checking basic list methods (first 10 items):');
    
    console.log('   Basic contact list:');
    const basicContacts = await bitrix24Client.listContacts({ start: 0 });
    const basicFoundContact = basicContacts.find(c => c.ID === contactId);
    if (basicFoundContact) {
      const position = basicContacts.findIndex(c => c.ID === contactId) + 1;
      console.log(`   ✅ Found new contact in basic list at position ${position}`);
    } else {
      console.log(`   ❌ New contact not found in basic list`);
    }
    
    console.log('   Basic deal list:');
    const basicDeals = await bitrix24Client.listDeals({ start: 0 });
    const basicFoundDeal = basicDeals.find(d => d.ID === dealId);
    if (basicFoundDeal) {
      const position = basicDeals.findIndex(d => d.ID === dealId) + 1;
      console.log(`   ✅ Found new deal in basic list at position ${position}`);
    } else {
      console.log(`   ❌ New deal not found in basic list`);
    }
    
  } catch (error) {
    console.error('❌ Error checking items:', error.message);
  }
}

checkNewItems().catch(console.error);
