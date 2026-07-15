import { GoogleGenAI } from '@google/genai';

export const getGeminiModel = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export async function callGemini(params: {
  prompt: string;
  responseMimeType?: string;
  responseSchema?: any;
  maxTokens?: number;
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not defined in the environment variables.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = getGeminiModel();

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
