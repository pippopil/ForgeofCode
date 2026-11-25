import OpenAI from 'openai';
import type { ZodType } from 'zod';
import type { AgentRole } from '../shared/contracts';
import { parseAndValidateJson } from '../shared/jsonParser';
import { calculateCostRub, fitContextWithinHalfWindow } from '../shared/pricing';
import { redactSecretsInText } from './crypto';
import { getResolvedSettings, recordCostUsage, type ResolvedSettings } from './db';

export interface AgentCallResult<T> {
  data: T;
  model: string;
  promptTokens: number;
  completionTokens: number;
  costRub: number;
  repaired: boolean;
  rawJson: string;
}

function createOpenAiClient(settings: ResolvedSettings): OpenAI {
  if (!settings.llmBaseUrl) {
    throw new Error('Не задан URL шлюза LLM (LLM_BASE_URL) в .env или настройках');
  }
  if (!settings.llmApiKey) {
    throw new Error('Не задан API-ключ LLM (LLM_API_KEY) в .env или настройках');
  }
  return new OpenAI({
    apiKey: settings.llmApiKey,
    baseURL: settings.llmBaseUrl,
    timeout: 120_000,
    maxRetries: 0, // Управляем ретраями вручную с поддержкой AbortSignal
  });
}

function getModelForRole(role: AgentRole, settings: ResolvedSettings): string {
  const model =
    role === 'architect'
      ? settings.architectModel
      : role === 'coder'
        ? settings.coderModel
        : settings.reviewerModel;

  if (!model) {
    const envName =
      role === 'architect'
        ? 'ARCHITECT_MODEL'
        : role === 'coder'
          ? 'CODER_MODEL'
          : 'REVIEWER_MODEL';
    throw new Error(`Не задана модель для роли "${role}" (${envName}) в .env или настройках`);
  }
  return model;
}

function isRetryableStatus(err: unknown): boolean {
  if (typeof err === 'object' && err !== null && 'status' in err) {
    const status = Number((err as { status?: unknown }).status);
    return status === 429 || (status >= 500 && status <= 599);
  }
  const msg = err instanceof Error ? err.message.toLowerCase() : '';
  return msg.includes('timeout') || msg.includes('econnreset') || msg.includes('429');
}

async function sleepWithAbort(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) {
    throw new Error('Операция отменена пользователем');
  }
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error('Операция отменена пользователем'));
    };
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function callCompletionWithRetry(params: {
  client: OpenAI;
  model: string;
  systemPrompt: string;
  userPrompt: string;
  signal?: AbortSignal;
}): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
  const maxAttempts = 4;
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (params.signal?.aborted) {
      throw new Error('Операция отменена пользователем');
    }
    try {
      const response = await params.client.chat.completions.create(
        {
          model: params.model,
          temperature: 0.15,
          messages: [
            { role: 'system', content: params.systemPrompt },
            { role: 'user', content: params.userPrompt },
          ],
        },
        { signal: params.signal }
      );

      const content = response.choices?.[0]?.message?.content ?? '';
      const promptTokens = response.usage?.prompt_tokens ?? 0;
      const completionTokens = response.usage?.completion_tokens ?? 0;
      return { content, promptTokens, completionTokens };
    } catch (err) {
      lastError = err;
      if (params.signal?.aborted) {
        throw new Error('Операция отменена пользователем');
      }
      if (attempt < maxAttempts && isRetryableStatus(err)) {
        const backoffMs = Math.min(12_000, 1000 * Math.pow(2, attempt - 1) + Math.floor(Math.random() * 400));
        await sleepWithAbort(backoffMs, params.signal);
        continue;
      }
      break;
    }
  }

  const message = lastError instanceof Error ? lastError.message : 'Неизвестная ошибка шлюза LLM';
  throw new Error(message);
}

/** Получает список доступных моделей от OpenAI-совместимого шлюза */
export async function listAvailableModels(): Promise<string[]> {
  const settings = getResolvedSettings();
  const client = createOpenAiClient(settings);
  try {
    const list = await client.models.list();
    const ids: string[] = [];
    for await (const item of list) {
      if (item.id) ids.push(item.id);
    }
    return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
  } catch (err) {
    const safeMsg = redactSecretsInText(
      err instanceof Error ? err.message : 'Ошибка запроса моделей',
      [settings.llmApiKey]
    );
    throw new Error(`Не удалось получить список моделей: ${safeMsg}`);
  }
}

/** Проверяет подключение к шлюзу LLM (и тестовый запрос к указанной модели) */
export async function pingLlmGateway(explicitModel?: string): Promise<{
  ok: boolean;
  latencyMs: number;
  modelChecked: string | null;
  modelsCount: number;
  replyPreview?: string;
}> {
  const settings = getResolvedSettings();
  const client = createOpenAiClient(settings);
  const start = Date.now();

  try {
    const modelIds = await listAvailableModels();
    const modelToTest =
      explicitModel?.trim() ||
      settings.architectModel ||
      settings.coderModel ||
      settings.reviewerModel ||
      modelIds[0] ||
      '';

    if (!modelToTest) {
      return {
        ok: true,
        latencyMs: Date.now() - start,
        modelChecked: null,
        modelsCount: modelIds.length,
      };
    }

    const res = await client.chat.completions.create({
      model: modelToTest,
      max_tokens: 16,
      temperature: 0,
      messages: [{ role: 'user', content: 'Ответь одним словом: OK' }],
    });

    return {
      ok: true,
      latencyMs: Date.now() - start,
      modelChecked: modelToTest,
      modelsCount: modelIds.length,
      replyPreview: (res.choices?.[0]?.message?.content ?? '').slice(0, 80),
    };
  } catch (err) {
    const safeMsg = redactSecretsInText(
      err instanceof Error ? err.message : 'Ошибка проверки шлюза',
      [settings.llmApiKey]
    );
    throw new Error(safeMsg);
  }
}

/**
 * Вызывает агента без tool-calling: 1 запрос -> JSON в ```json -> парсинг + Zod.
 * При битом JSON выполняет ровно 1 repair-запрос.
 */
export async function callAgentStructured<T>(params: {
  projectId: string;
  role: AgentRole;
  systemPrompt: string;
  contextSections: Array<{ label: string; content: string; required?: boolean }>;
  schema: ZodType<T>;
  schemaHint: string;
  abortSignal?: AbortSignal;
}): Promise<AgentCallResult<T>> {
  const settings = getResolvedSettings();
  const client = createOpenAiClient(settings);
  let activeModel = getModelForRole(params.role, settings);

  // Никогда не передаём API-ключи в контекст LLM
  const sanitizedSections = params.contextSections.map((sec) => ({
    ...sec,
    content: redactSecretsInText(sec.content, [settings.llmApiKey]),
  }));

  const boundedPrompt = fitContextWithinHalfWindow(
    params.systemPrompt,
    sanitizedSections,
    settings.contextWindowTokens
  );

  let completion: { content: string; promptTokens: number; completionTokens: number };
  try {
    completion = await callCompletionWithRetry({
      client,
      model: activeModel,
      systemPrompt: params.systemPrompt,
      userPrompt: boundedPrompt,
      signal: params.abortSignal,
    });
  } catch (primaryErr) {
    // Автозамена кодера допускается ТОЛЬКО при явном ALLOW_CODER_FALLBACK=true
    if (
      params.role === 'coder' &&
      settings.allowCoderFallback &&
      settings.architectModel &&
      settings.architectModel !== activeModel &&
      !params.abortSignal?.aborted
    ) {
      activeModel = settings.architectModel;
      completion = await callCompletionWithRetry({
        client,
        model: activeModel,
        systemPrompt: params.systemPrompt,
        userPrompt: boundedPrompt,
        signal: params.abortSignal,
      });
    } else {
      throw primaryErr;
    }
  }

  let totalPromptTokens = completion.promptTokens;
  let totalCompletionTokens = completion.completionTokens;

  const firstAttempt = parseAndValidateJson(completion.content, params.schema);
  if (firstAttempt.ok) {
    const costRub = calculateCostRub(
      totalPromptTokens,
      totalCompletionTokens,
      settings.pricing[params.role]
    );
    recordCostUsage(params.projectId, costRub, totalPromptTokens + totalCompletionTokens);
    return {
      data: firstAttempt.data,
      model: activeModel,
      promptTokens: totalPromptTokens,
      completionTokens: totalCompletionTokens,
      costRub,
      repaired: false,
      rawJson: firstAttempt.rawJson,
    };
  }

  // Ровно 1 repair-запрос при битом JSON или несоответствии Zod-схеме
  const repairPrompt = [
    `Твой предыдущий ответ не прошёл проверку JSON/Zod.`,
    `Ошибка: ${firstAttempt.error}`,
    `Ожидаемая структура: ${params.schemaHint}`,
    `Исправь ответ и верни ТОЛЬКО валидный JSON внутри блока \`\`\`json ... \`\`\`.`,
    `Предыдущий ответ:\n${completion.content.slice(0, 6000)}`,
  ].join('\n\n');

  const repairCompletion = await callCompletionWithRetry({
    client,
    model: activeModel,
    systemPrompt: params.systemPrompt,
    userPrompt: repairPrompt,
    signal: params.abortSignal,
  });

  totalPromptTokens += repairCompletion.promptTokens;
  totalCompletionTokens += repairCompletion.completionTokens;

  const costRub = calculateCostRub(
    totalPromptTokens,
    totalCompletionTokens,
    settings.pricing[params.role]
  );
  recordCostUsage(params.projectId, costRub, totalPromptTokens + totalCompletionTokens);

  const secondAttempt = parseAndValidateJson(repairCompletion.content, params.schema);
  if (!secondAttempt.ok) {
    throw new Error(`Агент "${params.role}" вернул невалидный JSON после repair-попытки: ${secondAttempt.error}`);
  }

  return {
    data: secondAttempt.data,
    model: activeModel,
    promptTokens: totalPromptTokens,
    completionTokens: totalCompletionTokens,
    costRub,
    repaired: true,
    rawJson: secondAttempt.rawJson,
  };
}
