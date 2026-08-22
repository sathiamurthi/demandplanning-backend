const puppeteer = require('puppeteer');

(async () => {
  console.log('Launching browser...');
  const browser = await puppeteer.launch({ headless: true });
  const page = await browser.newPage();
  
  try {
    console.log('Navigating to login page...');
    await page.goto('https://www.demandgeniusai.com/login', { waitUntil: 'networkidle2' });
    
    console.log('Filling login form...');
    // Type email
    await page.waitForSelector('input[type="email"]');
    await page.type('input[type="email"]', 'owner@medcare.com');
    // Type password
    await page.waitForSelector('input[type="password"]');
    await page.type('input[type="password"]', 'Admin@123');
    // Click submit
    await page.click('button[type="submit"]');
    
    console.log('Waiting for navigation after login...');
    await page.waitForNavigation({ waitUntil: 'networkidle2' });
    
    console.log('Navigating to items page...');
    await page.goto('https://www.demandgeniusai.com/admin/dynamic/items', { waitUntil: 'networkidle2' });
    
    console.log('Looking for AI Import button...');
    const hasAIImportButton = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      return buttons.some(btn => btn.innerText.includes('AI Import'));
    });
    
    if (hasAIImportButton) {
      console.log('SUCCESS: AI Import button is present on the page!');
    } else {
      console.log('FAILED: AI Import button was NOT found on the page.');
    }
    
  } catch (err) {
    console.error('Error during test:', err);
  } finally {
    await browser.close();
  }
})();
