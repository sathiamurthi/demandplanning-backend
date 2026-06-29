const dotenv = require('dotenv');
const path = require('path');

dotenv.config({
  path: path.resolve(__dirname, 'backend/.env'),
});

const { aiQuickSearch } = require('./dist/modules/public/background.service');

async function run() {
  try {
    console.log('AI_PROVIDER:', process.env.AI_PROVIDER);
    console.log('GEMINI_API_KEY exists:', !!process.env.GEMINI_API_KEY);
    console.log('CLAUDE_API_KEY exists:', !!(process.env.CLAUDE_API_KEY || process.env.ANTHROPIC_API_KEY));
    
    const res = await aiQuickSearch(13.0130, 77.6675, "best bar near 2km");
    console.log('Result:', JSON.stringify(res, null, 2));
  } catch (err) {
    console.error('ERROR:', err);
  }
}

run();
