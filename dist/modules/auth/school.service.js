"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.schoolRouter = void 0;
const express_1 = require("express");
const gemini_service_1 = require("./gemini.service");
const auth_service_1 = require("./auth.service");
exports.schoolRouter = (0, express_1.Router)();
exports.schoolRouter.post('/generate-study-guide', auth_service_1.authMiddleware, async (req, res) => {
    try {
        const { subject, chapterName } = req.body;
        if (!subject || !chapterName) {
            return res.status(400).json({ success: false, error: 'subject and chapterName are required' });
        }
        const prompt = `You are an expert CBSE teacher. Generate a study guide for the subject "${subject}" and chapter "${chapterName}".
Return a JSON object with EXACTLY these keys:
- concept (string): A simple understanding or story-telling explanation of the main concepts in this chapter.
- questions (array of strings): Top 20 important questions for this chapter as per the CBSE question pattern. Include a brief one-sentence hint/answer for each.
- quickReference (array of strings): A bulleted list of 5-10 key takeaways or formulas for quick reference.

Do not wrap the response in markdown code blocks. Just return the raw JSON.`;
        const aiRes = await (0, gemini_service_1.callGemini)({
            prompt,
            responseMimeType: 'application/json'
        });
        let parsed;
        try {
            parsed = JSON.parse(aiRes.text);
        }
        catch (err) {
            // Fallback for markdown
            const match = aiRes.text.match(/\`\`\`(?:json)?([\s\S]*?)\`\`\`/);
            parsed = match ? JSON.parse(match[1]) : null;
        }
        if (!parsed) {
            throw new Error('Failed to parse AI response');
        }
        res.status(200).json({ success: true, data: parsed });
    }
    catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});
