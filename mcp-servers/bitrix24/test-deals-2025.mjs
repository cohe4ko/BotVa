import { bitrix24Client } from './build/bitrix24/client.js';

async function testDeals2025() {
  console.log('Testing Deals API for 2025...\n');

  try {
    // Test 1: Get all deals (to see what dates we have)
    console.log('1. Getting all deals to check date ranges:');
    const allDeals = await bitrix24Client.listDeals({ 
      start: 0, 
      select: ['ID', 'TITLE', 'DATE_CREATE', 'BEGINDATE', 'CLOSEDATE'],
      order: { 'DATE_CREATE': 'DESC' }
    });
    
    console.log(`Found ${allDeals.length} total deals`);
    if (allDeals.length > 0) {
      console.log('Sample deal dates:');
      allDeals.slice(0, 5).forEach(deal => {
        console.log(`  Deal ${deal.ID}: Created=${deal.DATE_CREATE}, Begin=${deal.BEGINDATE}`);
      });
    }
    console.log('');

    // Test 2: Try to get deals from 2025 using date range filter
    console.log('2. Testing deals from 2025 using date range filter:');
    const deals2025 = await bitrix24Client.getDealsFromDateRange('2025-01-01', '2025-12-31', 50);
    console.log(`Found ${deals2025.length} deals from 2025`);
    
    if (deals2025.length > 0) {
      console.log('2025 deals:');
      deals2025.forEach(deal => {
        console.log(`  Deal ${deal.ID}: ${deal.TITLE} (Created: ${deal.DATE_CREATE})`);
      });
    } else {
      console.log('No deals found for 2025');
    }
    console.log('');

    // Test 3: Try to get deals from 2024 to see if filtering works
    console.log('3. Testing deals from 2024 for comparison:');
    const deals2024 = await bitrix24Client.getDealsFromDateRange('2024-01-01', '2024-12-31', 50);
    console.log(`Found ${deals2024.length} deals from 2024`);
    console.log('');

    // Test 4: Try to get deals from 2020 (we know these exist)
    console.log('4. Testing deals from 2020 (should have results):');
    const deals2020 = await bitrix24Client.getDealsFromDateRange('2020-01-01', '2020-12-31', 50);
    console.log(`Found ${deals2020.length} deals from 2020`);
    
    if (deals2020.length > 0) {
      console.log('Sample 2020 deals:');
      deals2020.slice(0, 3).forEach(deal => {
        console.log(`  Deal ${deal.ID}: ${deal.TITLE} (Created: ${deal.DATE_CREATE})`);
      });
    }
    console.log('');

    // Test 5: Test latest deals method
    console.log('5. Testing getLatestDeals method:');
    const latestDeals = await bitrix24Client.getLatestDeals(10);
    console.log(`Found ${latestDeals.length} latest deals`);
    
    if (latestDeals.length > 0) {
      console.log('Latest deals:');
      latestDeals.slice(0, 5).forEach(deal => {
        console.log(`  Deal ${deal.ID}: ${deal.TITLE} (Created: ${deal.DATE_CREATE})`);
      });
    }

  } catch (error) {
    console.error('Error testing deals:', error.message);
  }
}

testDeals2025();
