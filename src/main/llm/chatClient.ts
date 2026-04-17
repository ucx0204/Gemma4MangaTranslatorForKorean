import { extractMessagePayload } from "../../shared/json";
import { logError } from "../logger";

export type ChatCompletionResponse = {
  choices?: Array<{
    finish_reason?: string;
    index?: number;
    message?: unknown;
  }>;
  timings?: Partial<{
    prompt_n: number;
    cache_n: number;
    predicted_n: number;
  }>;
};

type ChatCompletionRequest = {
  apiKey: string;
  baseUrl: string;
  signal: AbortSignal;
  model: string;
  maxTokens: number;
  messages: unknown[];
  stop: string[];
  temperature: number;
  topP: number;
  topK?: number;
  presencePenalty: number;
  frequencyPenalty: number;
  reasoningBudget?: number;
  enableThinking?: boolean;
};

export async function postChatCompletion(request: ChatCompletionRequest): Promise<ChatCompletionResponse> {
  const response = await fetch(`${request.baseUrl}/chat/completions`, {
    method: "POST",
    signal: request.signal,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${request.apiKey}`
    },
    body: JSON.stringify({
      model: request.model,
      temperature: request.temperature,
      top_p: request.topP,
      ...(typeof request.topK === "number" && Number.isFinite(request.topK) ? { top_k: request.topK } : {}),
      presence_penalty: request.presencePenalty,
      frequency_penalty: request.frequencyPenalty,
      max_tokens: request.maxTokens,
      reasoning_budget: request.reasoningBudget ?? 0,
      enable_thinking: request.enableThinking ?? false,
      ...(request.stop.length > 0 ? { stop: request.stop } : {}),
      messages: request.messages
    })
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    logError("Gemma request failed", { status: response.status, body: body.slice(0, 1000) });
    throw new Error(`Gemma request failed (${response.status}): ${body.slice(0, 500)}`);
  }

  return (await response.json()) as ChatCompletionResponse;
}

export function extractPayloadFromResponse(json: ChatCompletionResponse): string {
  const rawPayload = extractMessagePayload(json.choices?.[0]?.message);
  if (!rawPayload) {
    logError("Gemma returned empty response", {
      choice: json.choices?.[0] ?? null
    });
    throw new Error("Gemma returned an empty response");
  }
  return rawPayload;
}
