// ============================================================
// aiService.ts — shared, provider-agnostic AI calling component with
// automatic fallback across configured providers.
//
// Why this exists: Data360's extraction endpoints (and, previously,
// ai.service.ts's forecast/suggest features) each hand-rolled their own
// Anthropic-vs-Gemini branching inline. That meant a single provider outage
// (e.g. an Anthropic account running out of credits) broke every caller at
// once, with no shared retry/fallback logic anywhere. This module gives one
// place to add a provider and one call site (`callAI`) that everything else
// uses.
//
// Providers tried in order, skipping any without credentials configured:
//   1. anthropic     — ANTHROPIC_API_KEY / CLAUDE_API_KEY
//   2. gemini        — GEMINI_API_KEY
//   3. azure_openai  — AZURE_OPENAI_ENDPOINT + AZURE_OPENAI_KEY
//                       (+ optional AZURE_OPENAI_DEPLOYMENT, defaults 'gpt-4o')
// Override the order with AI_PROVIDER_ORDER="gemini,azure_openai,anthropic".
// A provider that throws (rate limit, out of credits, transient 5xx) is
// logged and the next configured provider is tried — callers only see an
// error once every configured provider has failed.
// ============================================================
import Anthropic from '@anthropic-ai/sdk';
import { GoogleGenAI } from '@google/genai';
import { logger } from './logger';

export type AiProviderName = 'anthropic' | 'gemini' | 'azure_openai';

export interface AiCallParams {
  /** The text prompt / instructions sent to the model. */
  prompt: string;
  /** Optional image to read alongside the prompt (vision call). */
  imageBase64?: string;
  mimeType?: string;
  maxTokens?: number;
  /** Ask the provider to constrain output to a JSON object where supported. */
  jsonResponse?: boolean;
}

export interface AiCallResult {
  text: string;
  provider: AiProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  /** Estimated USD cost of this one call, based on PRICING below. Labeled
   *  "estimated" everywhere it surfaces — provider list prices change, and
   *  this is not read from a billing API, just multiplied from token counts. */
  estimatedCostUsd: number;
}

// Approximate public list prices (USD per 1M tokens) as of this integration —
// NOT fetched from each provider's billing API, so treat every cost figure
// this produces as an estimate to sanity-check against the provider's own
// current pricing page, not an invoice-grade number. Override via env vars
// if a rate here is stale.
const PRICING: Record<string, { inputPer1M: number; outputPer1M: number }> = {
  'claude-haiku-4-5-20251001': {
    inputPer1M: Number(process.env.PRICE_ANTHROPIC_INPUT_PER_1M) || 1.00,
    outputPer1M: Number(process.env.PRICE_ANTHROPIC_OUTPUT_PER_1M) || 5.00,
  },
  'gemini-2.5-flash': {
    inputPer1M: Number(process.env.PRICE_GEMINI_INPUT_PER_1M) || 0.30,
    outputPer1M: Number(process.env.PRICE_GEMINI_OUTPUT_PER_1M) || 2.50,
  },
  'gpt-4o': {
    inputPer1M: Number(process.env.PRICE_AZURE_INPUT_PER_1M) || 2.50,
    outputPer1M: Number(process.env.PRICE_AZURE_OUTPUT_PER_1M) || 10.00,
  },
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const rate = PRICING[model];
  if (!rate) return 0;
  return (inputTokens / 1_000_000) * rate.inputPer1M + (outputTokens / 1_000_000) * rate.outputPer1M;
}

const DEFAULT_ORDER: AiProviderName[] = ['anthropic', 'gemini', 'azure_openai'];

function providerOrder(): AiProviderName[] {
  const raw = process.env.AI_PROVIDER_ORDER;
  if (raw?.trim()) {
    const names = raw.split(',').map(s => s.trim()).filter(Boolean) as AiProviderName[];
    if (names.length) return names;
  }
  // Respect the existing AI_PROVIDER preference already used elsewhere in
  // this backend (ai.service.ts) as a hint for which provider to try
  // first — e.g. it's currently set to "gemini" because the Anthropic
  // account has been out of credits, without needing a second env var to
  // express the same intent.
  const preferred = process.env.AI_PROVIDER as AiProviderName | undefined;
  if (preferred && DEFAULT_ORDER.includes(preferred)) {
    return [preferred, ...DEFAULT_ORDER.filter(p => p !== preferred)];
  }
  return DEFAULT_ORDER;
}

function isConfigured(p: AiProviderName): boolean {
  if (p === 'anthropic') return !!(process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY);
  if (p === 'gemini') return !!process.env.GEMINI_API_KEY;
  if (p === 'azure_openai') return !!(process.env.AZURE_OPENAI_ENDPOINT && process.env.AZURE_OPENAI_KEY);
  return false;
}

async function callAnthropic(params: AiCallParams): Promise<AiCallResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY || process.env.CLAUDE_API_KEY;
  const anthropic = new Anthropic({ apiKey });
  const model = 'claude-haiku-4-5-20251001';
  const content: any = params.imageBase64
    ? [
        { type: 'image', source: { type: 'base64', media_type: params.mimeType || 'image/png', data: params.imageBase64 } },
        { type: 'text', text: params.prompt },
      ]
    : params.prompt;
  const msg = await anthropic.messages.create({
    model,
    max_tokens: params.maxTokens || 1500,
    messages: [{ role: 'user', content }],
  });
  const text = (msg.content[0] as any).text as string;
  const inputTokens = msg.usage?.input_tokens || 0;
  const outputTokens = msg.usage?.output_tokens || 0;
  return { text, provider: 'anthropic', model, inputTokens, outputTokens, estimatedCostUsd: estimateCost(model, inputTokens, outputTokens) };
}

async function callGeminiProvider(params: AiCallParams): Promise<AiCallResult> {
  const apiKey = process.env.GEMINI_API_KEY!;
  const ai = new GoogleGenAI({ apiKey });
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const contents: any = params.imageBase64
    ? [{ role: 'user', parts: [{ inlineData: { mimeType: params.mimeType || 'image/png', data: params.imageBase64 } }, { text: params.prompt }] }]
    : params.prompt;
  const response = await ai.models.generateContent({
    model,
    contents,
    config: {
      maxOutputTokens: params.maxTokens || 1500,
      responseMimeType: params.jsonResponse ? 'application/json' : undefined,
    },
  });
  const inputTokens = response.usageMetadata?.promptTokenCount || 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount || 0;
  return { text: response.text || '', provider: 'gemini', model, inputTokens, outputTokens, estimatedCostUsd: estimateCost(model, inputTokens, outputTokens) };
}

async function callAzureOpenAI(params: AiCallParams): Promise<AiCallResult> {
  const endpoint = (process.env.AZURE_OPENAI_ENDPOINT as string).replace(/\/+$/, '');
  const key = process.env.AZURE_OPENAI_KEY as string;
  const deployment = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2024-08-01-preview';
  const url = `${endpoint}/openai/deployments/${deployment}/chat/completions?api-version=${apiVersion}`;

  const userContent: any = params.imageBase64
    ? [
        { type: 'text', text: params.prompt },
        { type: 'image_url', image_url: { url: `data:${params.mimeType || 'image/png'};base64,${params.imageBase64}` } },
      ]
    : params.prompt;

  const body: any = {
    messages: [{ role: 'user', content: userContent }],
    max_tokens: params.maxTokens || 1500,
  };
  if (params.jsonResponse) body.response_format = { type: 'json_object' };

  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'api-key': key },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`Azure OpenAI ${res.status}: ${errText.slice(0, 300)}`);
  }
  const json: any = await res.json();
  const text = json.choices?.[0]?.message?.content || '';
  const inputTokens = json.usage?.prompt_tokens || 0;
  const outputTokens = json.usage?.completion_tokens || 0;
  return { text, provider: 'azure_openai', model: deployment, inputTokens, outputTokens, estimatedCostUsd: estimateCost(deployment, inputTokens, outputTokens) };
}

const CALLERS: Record<AiProviderName, (p: AiCallParams) => Promise<AiCallResult>> = {
  anthropic: callAnthropic,
  gemini: callGeminiProvider,
  azure_openai: callAzureOpenAI,
};

/**
 * Calls the first configured, working provider in the fallback chain.
 * Logs and moves to the next provider on failure — only throws once every
 * configured provider has been tried and failed.
 */
export async function callAI(params: AiCallParams): Promise<AiCallResult> {
  const order = providerOrder().filter(isConfigured);
  if (order.length === 0) {
    throw new Error(
      'No AI provider is configured (need ANTHROPIC_API_KEY/CLAUDE_API_KEY, GEMINI_API_KEY, or AZURE_OPENAI_ENDPOINT+AZURE_OPENAI_KEY).'
    );
  }
  const errors: string[] = [];
  for (const name of order) {
    try {
      return await CALLERS[name](params);
    } catch (e: any) {
      logger.warn(`AI provider "${name}" failed, trying next in chain: ${e.message}`);
      errors.push(`${name}: ${e.message}`);
    }
  }
  throw new Error(`All configured AI providers failed — ${errors.join(' | ')}`);
}
