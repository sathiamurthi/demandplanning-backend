"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getGeminiModel = void 0;
exports.callGemini = callGemini;
exports.callGeminiVision = callGeminiVision;
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
        contents: params.prompt,
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
// Same as callGemini, but sends an image inline alongside the prompt —
// Gemini reads the image directly (no OCR step), which is what makes this
// usable on stylized/graphic documents that break classic OCR engines.
async function callGeminiVision(params) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
        throw new Error('GEMINI_API_KEY is not defined in the environment variables.');
    }
    const ai = new genai_1.GoogleGenAI({ apiKey });
    const model = (0, exports.getGeminiModel)();
    const response = await ai.models.generateContent({
        model: model,
        contents: [
            {
                role: 'user',
                parts: [
                    { inlineData: { mimeType: params.mimeType, data: params.imageBase64 } },
                    { text: params.prompt },
                ],
            },
        ],
        config: {
            maxOutputTokens: params.maxTokens,
            responseMimeType: params.responseMimeType,
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
