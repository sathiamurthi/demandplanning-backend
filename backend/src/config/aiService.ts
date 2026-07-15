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
  /**
   * Static instructions shared verbatim across many calls (extraction rules,
   * the auto-extract format spec) — placed BEFORE `prompt`/the image so
   * providers can cache it instead of reprocessing it on every call:
   *  - Anthropic: marked with `cache_control: { type: 'ephemeral' }` — an
   *    explicit cache write/read, ~10% of input price on a hit.
   *  - Gemini 2.5 models: "implicit caching" is automatic for a repeated
   *    leading prefix — no API call needed, just keep it first.
   *  - Azure/OpenAI: automatic prompt caching for identical prefixes
   *    >=1024 tokens — same requirement, keep it first.
   * If this text changes on a later deploy, every provider just treats it as
   * a fresh, uncached prefix — nothing to invalidate manually. Note: our
   * current extraction-rules/auto-extract prompts may be under each
   * provider's minimum cacheable-prefix length (Anthropic needs ~1024-2048
   * tokens depending on model), so real savings may be small today and grow
   * as prompts/field lists grow — this is still correct to set regardless.
   */
  cacheablePrompt?: string;
  /** Optional image to read alongside the prompt (vision call). */
  imageBase64?: string;
  mimeType?: string;
  /**
   * Multiple images in one call (e.g. every page of a textbook chapter) so
   * the model can synthesize across all of them in a single response instead
   * of one independent call per page. Takes precedence over
   * imageBase64/mimeType when both are set.
   */
  images?: { base64: string; mimeType: string }[];
  maxTokens?: number;
  /** Ask the provider to constrain output to a JSON object where supported. */
  jsonResponse?: boolean;
  /**
   * Overrides the provider order for this call only (still filtered down to
   * configured providers) — e.g. `costEffectiveOrder()` for a caller that
   * wants the cheapest provider tried first regardless of the global
   * AI_PROVIDER_ORDER/AI_PROVIDER hint used elsewhere.
   */
  preferredOrder?: AiProviderName[];
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

// The model each provider will actually be called with (mirrors the model
// selection in each callX function below) — used only to rank providers by
// price, not to make the call itself.
function modelFor(provider: AiProviderName): string {
  if (provider === 'anthropic') return 'claude-haiku-4-5-20251001';
  if (provider === 'gemini') return process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  return process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4o';
}

// A representative extraction call's shape (a few pages of document text in,
// a JSON object out) — just for ranking providers by price, not billing.
const REFERENCE_INPUT_TOKENS = 2000;
const REFERENCE_OUTPUT_TOKENS = 500;

/**
 * Ranks all three providers cheapest-first using the live PRICING table
 * (respects PRICE_*_PER_1M env overrides), for callers that want to always
 * use the cheapest available model rather than a fixed/quality-ordered
 * preference — e.g. Data360's extraction endpoints, where every provider
 * produces materially the same structured-JSON result, so cost should
 * decide the order. Filtered down to configured providers by `callAI`.
 */
export function costEffectiveOrder(): AiProviderName[] {
  return [...DEFAULT_ORDER].sort(
    (a, b) => estimateCost(modelFor(a), REFERENCE_INPUT_TOKENS, REFERENCE_OUTPUT_TOKENS)
      - estimateCost(modelFor(b), REFERENCE_INPUT_TOKENS, REFERENCE_OUTPUT_TOKENS)
  );
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
  // Static instructions go first as their own content block with
  // cache_control, so repeated calls sharing this exact text hit Anthropic's
  // prompt cache instead of being billed/processed at full price.
  const content: any[] = [];
  if (params.cacheablePrompt) {
    content.push({ type: 'text', text: params.cacheablePrompt, cache_control: { type: 'ephemeral' } });
  }
  if (params.images?.length) {
    for (const img of params.images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.mimeType || 'image/png', data: img.base64 } });
    }
  } else if (params.imageBase64) {
    content.push({ type: 'image', source: { type: 'base64', media_type: params.mimeType || 'image/png', data: params.imageBase64 } });
  }
  content.push({ type: 'text', text: params.prompt });
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
  // Keep the static instructions as the leading prefix (before the image or
  // the dynamic document text) — Gemini 2.5 models apply "implicit caching"
  // automatically to a repeated leading prefix, no explicit cache API needed.
  let contents: any;
  if (params.images?.length || params.imageBase64) {
    const parts: any[] = [];
    if (params.cacheablePrompt) parts.push({ text: params.cacheablePrompt });
    if (params.images?.length) {
      for (const img of params.images) parts.push({ inlineData: { mimeType: img.mimeType || 'image/png', data: img.base64 } });
    } else {
      parts.push({ inlineData: { mimeType: params.mimeType || 'image/png', data: params.imageBase64 } });
    }
    parts.push({ text: params.prompt });
    contents = [{ role: 'user', parts }];
  } else {
    contents = params.cacheablePrompt ? `${params.cacheablePrompt}\n\n${params.prompt}` : params.prompt;
  }
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

  // Static instructions lead the content array (before the image and the
  // dynamic prompt text) — Azure/OpenAI apply automatic prompt caching to a
  // repeated identical prefix >=1024 tokens, no explicit cache API needed.
  let userContent: any;
  if (params.images?.length || params.imageBase64) {
    const parts: any[] = [];
    if (params.cacheablePrompt) parts.push({ type: 'text', text: params.cacheablePrompt });
    if (params.images?.length) {
      for (const img of params.images) parts.push({ type: 'image_url', image_url: { url: `data:${img.mimeType || 'image/png'};base64,${img.base64}` } });
    } else {
      parts.push({ type: 'image_url', image_url: { url: `data:${params.mimeType || 'image/png'};base64,${params.imageBase64}` } });
    }
    parts.push({ type: 'text', text: params.prompt });
    userContent = parts;
  } else {
    userContent = params.cacheablePrompt ? `${params.cacheablePrompt}\n\n${params.prompt}` : params.prompt;
  }

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
  const order = (params.preferredOrder ?? providerOrder()).filter(isConfigured);
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
