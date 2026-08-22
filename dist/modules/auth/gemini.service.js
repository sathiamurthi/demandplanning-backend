"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGeminiModel = void 0;
exports.callGemini = callGemini;
const genai_1 = require("@google/genai");
const getGeminiModel = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';
exports.getGeminiModel = getGeminiModel;
async function callGemini(params) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not defined in the environment variables.');
    }
    const ai = new genai_1.GoogleGenAI({ apiKey });
    const model = (0, exports.getGeminiModel)();
    const response = await ai.models.generateContent({
        model: model,
        contents: params.imageBase64 && params.mimeType ? [
            params.prompt,
            { inlineData: { data: params.imageBase64, mimeType: params.mimeType } }
        ] : params.prompt,
        config: {
            maxOutputTokens: params.maxTokens,
            responseMimeType: params.responseMimeType,
            responseSchema: params.responseSchema,
        },
    });
    const text = response.text || '';
    const inputTokens = response.usageMetadata?.promptTokenCount || 0;
    const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
    return {
        text,
        inputTokens,
        outputTokens,
        model,
    };
}
