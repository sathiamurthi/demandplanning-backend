require('dotenv').config();
const { GoogleGenAI } = require('@google/genai');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
async function test() {
  const prompt = `You are a medical supply planner.
Analyze each item and forecast demand for the next 30 days.
Consider: current stock levels, monthly usage, reorder levels, lead times, and seasonal factors.

Respond ONLY with a valid JSON array — no markdown, no preamble, no extra text:
[{
  "id": "<exact item id>",
  "item": "<item name>",
  "predicted_qty_30d": <positive integer — units needed next 30 days>,
  "confidence_pct": <integer 0-100>,
  "order_needed": <true if current_stock < predicted_qty_30d>,
  "order_qty": <integer — recommended order quantity>,
  "risk_level": "<Low|Medium|High|Critical>",
  "reasoning": "<one concise sentence, max 150 chars>"
}]

Items to analyze:
[
  {
    "id": "item1",
    "name": "Paracetamol",
    "current_stock": 50,
    "unit": "Strip",
    "monthly_usage": 100,
    "reorder_level": 40,
    "lead_time_days": 2,
    "season": "fever",
    "expiry_date": null
  }
]`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash',
    contents: prompt,
    config: {
      maxOutputTokens: 2000,
      responseMimeType: 'application/json',
    },
  });
  console.log(response.text);
}
test().catch(console.error);
