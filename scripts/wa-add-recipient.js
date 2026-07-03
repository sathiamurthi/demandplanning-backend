#!/usr/bin/env node
// ============================================================
// WhatsApp Dev Console — Automated Test Recipient Registration
// Automates adding a phone number to the Meta WA sandbox so it
// can receive test messages from your WhatsApp Business account.
//
// Usage:
//   node scripts/wa-add-recipient.js +919876543210
//   node scripts/wa-add-recipient.js +919876543210 --visible   (non-headless)
//
// Required .env / environment variables:
//   FB_EMAIL       — Your Meta/Facebook account email
//   FB_PASSWORD    — Your Meta/Facebook account password
//   WA_APP_ID      — Your Meta App ID (default: 1006915932319931)
//
// IMPORTANT: Enable 2FA bypass by using an App Password if your
// Facebook account has 2FA enabled, or use a trusted device session.
// ============================================================

require('dotenv').config({ path: require('path').resolve(__dirname, '../backend/.env') });
const puppeteer = require('puppeteer');

const FB_EMAIL   = process.env.FB_EMAIL   || process.env.SMTP_USER || '';
const FB_PASSWORD = process.env.FB_PASSWORD || '';
const APP_ID     = process.env.WA_APP_ID  || process.env.WHATSAPP_APP_ID || '1006915932319931';

const PHONE_ARG  = process.argv.find(a => a.startsWith('+') || /^\d{10,15}$/.test(a));
const HEADLESS   = !process.argv.includes('--visible');

const CONSOLE_URL = `https://developers.facebook.com/apps/${APP_ID}/whatsapp-business/wa-dev-console/`;

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function typeSlowly(page, selector, text) {
  await page.click(selector);
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.keyboard.press('Delete');
  for (const char of text) {
    await page.type(selector, char, { delay: 50 + Math.random() * 80 });
  }
}

async function login(page) {
  console.log('⏳ Navigating to Facebook login…');
  await page.goto('https://www.facebook.com/login', { waitUntil: 'networkidle2', timeout: 30000 });

  // Accept cookies if prompted
  try {
    const cookieBtn = await page.$('[data-cookiebanner="accept_button"], button[title*="Accept"]');
    if (cookieBtn) { await cookieBtn.click(); await sleep(1000); }
  } catch {}

  // Fill credentials
  await typeSlowly(page, '#email', FB_EMAIL);
  await sleep(500);
  await typeSlowly(page, '#pass', FB_PASSWORD);
  await sleep(300);
  await page.click('#loginbutton, [name="login"]');
  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 });

  const url = page.url();
  if (url.includes('checkpoint') || url.includes('two_step')) {
    console.error('❌ Facebook requires 2FA or checkpoint verification.');
    console.error('   Solutions:');
    console.error('   1. Run with --visible flag and complete 2FA manually');
    console.error('   2. Login from this machine first, save cookies, then re-run');
    console.error('   3. Use the Meta API approach (no browser needed)');
    throw new Error('Facebook 2FA checkpoint encountered');
  }

  if (!url.includes('facebook.com') || url.includes('login')) {
    throw new Error('Login failed — check FB_EMAIL and FB_PASSWORD');
  }

  console.log('✅ Logged into Facebook');
}

async function addRecipient(page, phone) {
  console.log(`⏳ Navigating to WA Dev Console…`);
  await page.goto(CONSOLE_URL, { waitUntil: 'networkidle2', timeout: 30000 });
  await sleep(3000);

  // Wait for "To" input field — the phone number field in the test console
  const TO_SELECTORS = [
    'input[placeholder*="phone"]',
    'input[placeholder*="Phone"]',
    'input[placeholder*="recipient"]',
    '[aria-label*="phone" i]',
    '[aria-label*="recipient" i]',
    'input[type="tel"]',
  ];

  let toInput = null;
  for (const sel of TO_SELECTORS) {
    try {
      await page.waitForSelector(sel, { timeout: 5000 });
      toInput = sel;
      break;
    } catch {}
  }

  if (!toInput) {
    // Try taking a screenshot for debugging
    await page.screenshot({ path: 'wa-console-debug.png' });
    throw new Error('Could not find the "To" phone input. See wa-console-debug.png for the page state.');
  }

  console.log(`📱 Found phone input, entering ${phone}…`);
  await typeSlowly(page, toInput, phone);
  await sleep(1000);

  // Look for "Send message" button (or "Add" button for recipient list)
  const SEND_SELECTORS = [
    'button[type="submit"]',
    'button:has-text("Send")',
    '[aria-label*="send" i]',
    'button:contains("Send")',
  ];

  let sent = false;
  for (const sel of SEND_SELECTORS) {
    try {
      const btn = await page.$(sel);
      if (btn) {
        const text = await page.evaluate(el => el.textContent, btn);
        console.log(`🔘 Clicking button: "${text?.trim()}"`);
        await btn.click();
        await sleep(2000);
        sent = true;
        break;
      }
    } catch {}
  }

  if (!sent) {
    await page.screenshot({ path: 'wa-console-debug.png' });
    throw new Error('Could not find Send button. See wa-console-debug.png');
  }

  console.log(`✅ Phone number ${phone} added as WA test recipient!`);
}

async function main() {
  if (!PHONE_ARG) {
    console.error('Usage: node scripts/wa-add-recipient.js +919876543210 [--visible]');
    process.exit(1);
  }
  if (!FB_EMAIL || !FB_PASSWORD) {
    console.error('❌ Set FB_EMAIL and FB_PASSWORD in .env (or environment)');
    process.exit(1);
  }

  const phone = PHONE_ARG.startsWith('+') ? PHONE_ARG : `+${PHONE_ARG}`;
  console.log(`\n🤖 WA Recipient Registration`);
  console.log(`   Phone : ${phone}`);
  console.log(`   App ID: ${APP_ID}`);
  console.log(`   Mode  : ${HEADLESS ? 'headless' : 'visible'}\n`);

  const browser = await puppeteer.launch({
    headless: HEADLESS,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-blink-features=AutomationControlled',
      '--disable-infobars',
      '--window-size=1280,900',
    ],
    defaultViewport: { width: 1280, height: 900 },
  });

  const page = await browser.newPage();

  // Mask puppeteer fingerprint
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });

  page.setDefaultTimeout(30000);

  try {
    await login(page);
    await addRecipient(page, phone);
    console.log('\n🎉 Done! The number can now receive WhatsApp test messages.');
  } catch (err) {
    console.error(`\n❌ Error: ${err.message}`);
    process.exit(1);
  } finally {
    await browser.close();
  }
}

main();
