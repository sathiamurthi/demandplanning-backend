import { GoogleGenAI } from '@google/genai';

export const getGeminiModel = () => process.env.GEMINI_MODEL || 'gemini-2.5-flash';

export async function callGemini(params: {
  prompt: string;
  responseMimeType?: string;
  responseSchema?: any;
  maxTokens?: number;
  imageBase64?: string;
  mimeType?: string;
}) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not defined in the environment variables.');
  }

  const ai = new GoogleGenAI({ apiKey });
  const model = getGeminiModel();

  let retries = 3;
  let response;
  while (retries > 0) {
    try {
      response = await ai.models.generateContent({
        model: model,
        contents: params.imageBase64 && params.mimeType ? [
          params.prompt,
          { inlineData: { data: params.imageBase64, mimeType: params.mimeType } }
        ] : params.prompt,
        config: {
          maxOutputTokens: params.maxTokens,
          responseMimeType: params.responseMimeType,
          responseSchema: params.responseSchema,
          safetySettings: [
            { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_NONE' },
            { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_NONE' }
          ] as any
        },
      });
      break; // Success
    } catch (err: any) {
      if (err.status === 503 && retries > 1) {
        retries--;
        await new Promise(r => setTimeout(r, 2000)); // wait 2 seconds before retry
      } else {
        throw err;
      }
    }
  }

  if (!response) {
    throw new Error('Failed to generate content from Gemini');
  }

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
