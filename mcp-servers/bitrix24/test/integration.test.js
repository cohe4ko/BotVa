import { bitrix24Client } from '../build/bitrix24/client.js';

async function testIntegration() {
  try {
    console.log('🚀 Testing Bitrix24 MCP Server Integration...\n');
    
    console.log('1. Testing webhook validation...');
    const isValid = await bitrix24Client.validateWebhook();
    if (isValid) {
      console.log('✅ Webhook validation successful');
    } else {
      console.log('❌ Webhook validation failed');
      return;
    }
    
    console.log('\n2. Testing current user retrieval...');
    const user = await bitrix24Client.getCurrentUser();
    console.log('✅ Current user:', user.NAME || user.LAST_NAME || 'Unknown');
    
    console.log('\n3. Testing contact creation...');
    const contactId = await bitrix24Client.createContact({
      NAME: 'Test',
      LAST_NAME: 'Contact',
      EMAIL: [{ VALUE: 'test@example.com', VALUE_TYPE: 'WORK' }],
      PHONE: [{ VALUE: '+39 123 456 789', VALUE_TYPE: 'WORK' }],
      COMMENTS: 'Created by MCP Server test'
    });
    console.log('✅ Contact created with ID:', contactId);
    
    console.log('\n4. Testing contact retrieval...');
    const contact = await bitrix24Client.getContact(contactId);
    console.log('✅ Contact retrieved:', contact.NAME, contact.LAST_NAME);
    
    console.log('\n5. Testing contact list...');
    const contacts = await bitrix24Client.listContacts({ start: 0 });
    console.log('✅ Found', contacts.length, 'contacts');
    
    console.log('\n6. Testing deal creation...');
    const dealId = await bitrix24Client.createDeal({
      TITLE: 'Test Deal - MCP Server',
      OPPORTUNITY: '1000',
      CURRENCY_ID: 'EUR',
      CONTACT_ID: contactId,
      COMMENTS: 'Created by MCP Server test'
    });
    console.log('✅ Deal created with ID:', dealId);
    
    console.log('\n7. Testing task creation...');
    const taskId = await bitrix24Client.createTask({
      TITLE: 'Test Task - MCP Server',
      DESCRIPTION: 'This is a test task created by the MCP server',
      PRIORITY: '1',
      UF_CRM_TASK: [`C_${contactId}`, `D_${dealId}`]
    });
    console.log('✅ Task created with ID:', taskId);
    
    console.log('\n🎉 All tests passed! Bitrix24 MCP Server is working correctly.');
    
  } catch (error) {
    console.error('\n❌ Test failed:', error.message);
    console.error('Full error:', error);
  }
}

// Run the test if this file is executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  testIntegration();
}

export { testIntegration };
