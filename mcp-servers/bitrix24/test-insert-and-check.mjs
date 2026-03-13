import { bitrix24Client } from './build/bitrix24/client.js';

async function testInsertAndCheck() {
  console.log('🧪 Testing by inserting new deal and contact, then checking latest functions...\n');
  
  try {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Step 1: Insert a new contact
    console.log('1. Creating a new test contact...');
    const newContact = {
      NAME: 'Test',
      LAST_NAME: `Contact-${timestamp}`,
      EMAIL: [{ VALUE: `test-${timestamp}@example.com`, VALUE_TYPE: 'WORK' }],
      PHONE: [{ VALUE: '+1234567890', VALUE_TYPE: 'WORK' }],
      COMMENTS: 'Test contact created to verify latest functions'
    };
    
    const contactId = await bitrix24Client.createContact(newContact);
    console.log(`✅ Created contact with ID: ${contactId}`);
    
    // Step 2: Insert a new deal
    console.log('\n2. Creating a new test deal...');
    const newDeal = {
      TITLE: `Test Deal ${timestamp}`,
      OPPORTUNITY: '1000',
      CURRENCY_ID: 'EUR',
      CONTACT_ID: contactId,
      COMMENTS: 'Test deal created to verify latest functions'
    };
    
    const dealId = await bitrix24Client.createDeal(newDeal);
    console.log(`✅ Created deal with ID: ${dealId}`);
    
    // Step 3: Wait a moment for the data to be indexed
    console.log('\n3. Waiting 2 seconds for data to be indexed...');
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Step 4: Check latest contacts
    console.log('\n4. Checking if new contact appears in latest contacts...');
    const latestContacts = await bitrix24Client.getLatestContacts(5);
    const foundContact = latestContacts.find(c => c.ID === contactId);
    
    if (foundContact) {
      console.log(`✅ SUCCESS: New contact found in latest contacts!`);
      console.log(`   Contact: ${foundContact.NAME} ${foundContact.LAST_NAME} (ID: ${foundContact.ID})`);
      console.log(`   Created: ${foundContact.DATE_CREATE}`);
    } else {
      console.log(`❌ ISSUE: New contact NOT found in latest contacts`);
      console.log('Latest contacts:');
      latestContacts.forEach((contact, index) => {
        const name = [contact.NAME, contact.LAST_NAME].filter(Boolean).join(' ') || contact.COMPANY_TITLE || 'No name';
        console.log(`   ${index + 1}. ${name} (ID: ${contact.ID}) - Created: ${contact.DATE_CREATE}`);
      });
    }
    
    // Step 5: Check latest deals
    console.log('\n5. Checking if new deal appears in latest deals...');
    const latestDeals = await bitrix24Client.getLatestDeals(5);
    const foundDeal = latestDeals.find(d => d.ID === dealId);
    
    if (foundDeal) {
      console.log(`✅ SUCCESS: New deal found in latest deals!`);
      console.log(`   Deal: ${foundDeal.TITLE} (ID: ${foundDeal.ID})`);
      console.log(`   Created: ${foundDeal.DATE_CREATE}`);
    } else {
      console.log(`❌ ISSUE: New deal NOT found in latest deals`);
      console.log('Latest deals:');
      latestDeals.forEach((deal, index) => {
        const title = deal.TITLE || `Deal #${deal.ID}`;
        console.log(`   ${index + 1}. ${title} (ID: ${deal.ID}) - Created: ${deal.DATE_CREATE}`);
      });
    }
    
    // Step 6: Summary
    console.log('\n🎯 SUMMARY:');
    if (foundContact && foundDeal) {
      console.log('✅ PERFECT! Both new contact and deal appear in their respective latest functions.');
      console.log('✅ The fix is working correctly - newly inserted items are returned first.');
    } else if (foundContact || foundDeal) {
      console.log('⚠️  PARTIAL SUCCESS: One of the functions is working, but not both.');
    } else {
      console.log('❌ ISSUE: Neither new contact nor deal appear in latest results.');
      console.log('   This might indicate the functions still need adjustment.');
    }
    
    console.log(`\n📝 Test items created:`);
    console.log(`   Contact ID: ${contactId}`);
    console.log(`   Deal ID: ${dealId}`);
    console.log(`   You can manually verify these in your Bitrix24 system.`);
    
  } catch (error) {
    console.error('❌ Error during test:', error.message);
    console.error('Full error:', error);
  }
}

testInsertAndCheck().catch(console.error);
