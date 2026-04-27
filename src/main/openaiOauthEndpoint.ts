import type { TranslationOptions } from "./appSettings";
import { logInfo, logWarn } from "./logger";

type OpenAIOAuthModule = {
  startOpenAIOAuthServer: (options?: {
    host?: string;
    port?: number;
    requestLogger?: (event: unknown) => void;
  }) => Promise<RunningOpenAIOAuthServer>;
};

type RunningOpenAIOAuthServer = {
  host: string;
  port: number;
  url: string;
  close: () => Promise<void>;
};

export type OpenAIOAuthEndpoint = {
  baseUrl: string;
  child: null;
  startedByScript: true;
  provider: "openai-codex";
  oauthServer: RunningOpenAIOAuthServer;
  closed?: boolean;
};

const dynamicImport = new Function("specifier", "return import(specifier)") as (
  specifier: string
) => Promise<OpenAIOAuthModule>;

export async function startOpenAIOAuthEndpoint(options: TranslationOptions): Promise<OpenAIOAuthEndpoint> {
  let module: OpenAIOAuthModule;
  try {
    module = await dynamicImport("openai-oauth");
  } catch (error) {
    throw createDetailedError(
      "openai-oauth 패키지를 불러오지 못했습니다. npm install 후 다시 시도하세요.",
      { packageName: "openai-oauth" },
      error
    );
  }

  const oauthServer = await module.startOpenAIOAuthServer({
    host: "127.0.0.1",
    port: options.codexOauthPort,
    requestLogger: (event) => {
      logInfo("openai-oauth request", { label: options.label, event });
    }
  });

  try {
    await verifyEndpoint(oauthServer.url, options);
  } catch (error) {
    await oauthServer.close().catch((closeError) => {
      logWarn("Failed to close openai-oauth endpoint after startup failure", { closeError });
    });
    throw error;
  }

  logInfo("openai-oauth endpoint ready", {
    label: options.label,
    baseUrl: oauthServer.url,
    model: options.codexModel,
    reasoningEffort: options.codexReasoningEffort
  });

  return {
    baseUrl: oauthServer.url,
    child: null,
    startedByScript: true,
    provider: "openai-codex",
    oauthServer
  };
}

export async function stopOpenAIOAuthEndpoint(endpoint: OpenAIOAuthEndpoint | null | undefined): Promise<void> {
  if (!endpoint || endpoint.closed) {
    return;
  }
  endpoint.closed = true;
  try {
    await endpoint.oauthServer.close();
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ERR_SERVER_NOT_RUNNING") {
      return;
    }
    throw error;
  }
}

async function verifyEndpoint(baseUrl: string, options: TranslationOptions): Promise<void> {
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/models`, {
      signal: AbortSignal.timeout(30000)
    });
  } catch (error) {
    throw createDetailedError(
      "openai-oauth 엔드포인트에 연결하지 못했습니다. 먼저 Codex 로그인이 되어 있는지 확인하세요.",
      { baseUrl, model: options.codexModel },
      error
    );
  }

  const rawText = await response.text();
  if (!response.ok) {
    throw createDetailedError("openai-oauth 모델 목록을 확인하지 못했습니다. Codex 로그인이 필요할 수 있습니다.", {
      baseUrl,
      status: response.status,
      statusText: response.statusText,
      rawTextPreview: truncateText(rawText)
    });
  }

  const availableModels = parseModelIds(rawText);
  if (availableModels.length > 0 && !availableModels.includes(options.codexModel)) {
    logWarn("Selected Codex model was not advertised by openai-oauth", {
      selectedModel: options.codexModel,
      availableModels
    });
  }
}

function parseModelIds(rawText: string): string[] {
  try {
    const parsed = JSON.parse(rawText);
    if (!Array.isArray(parsed?.data)) {
      return [];
    }
    return parsed.data.map((item: { id?: unknown }) => item.id).filter((id: unknown): id is string => typeof id === "string");
  } catch {
    return [];
  }
}

function truncateText(value: string, maxLength = 4000): string {
  return value.length <= maxLength ? value : `${value.slice(0, maxLength)}... [truncated ${value.length - maxLength} chars]`;
}

function createDetailedError(message: string, detail: Record<string, unknown> = {}, cause?: unknown): Error {
  const error = new Error(message);
  if (cause !== undefined) {
    error.cause = cause;
  }
  Object.assign(error, detail);
  return error;
}
