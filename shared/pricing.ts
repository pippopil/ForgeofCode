import type { AgentRole } from './contracts';

export interface AgentPricing {
  input_rub_per_1m: number;
  output_rub_per_1m: number;
}

export type PricingMap = Record<AgentRole, AgentPricing>;

export const DEFAULT_PRICING: PricingMap = {
  architect: { input_rub_per_1m: 25, output_rub_per_1m: 100 },
  coder: { input_rub_per_1m: 120, output_rub_per_1m: 480 },
  reviewer: { input_rub_per_1m: 20, output_rub_per_1m: 80 },
};

/** Рассчитывает стоимость запроса в рублях (с точностью до 4 знаков) */
export function calculateCostRub(
  promptTokens: number,
  completionTokens: number,
  pricing: AgentPricing
): number {
  const safePrompt = Math.max(0, promptTokens);
  const safeCompletion = Math.max(0, completionTokens);
  const inputCost = (safePrompt / 1_000_000) * Math.max(0, pricing.input_rub_per_1m);
  const outputCost = (safeCompletion / 1_000_000) * Math.max(0, pricing.output_rub_per_1m);
  return Math.round((inputCost + outputCost) * 10000) / 10000;
}

/** Приблизительная оценка числа токенов (1 токен ~ 3.5 символа для смешанного кода/RU) */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 3.5);
}

/** Обрезает контекст так, чтобы не превышать 50% окна модели */
export function fitContextWithinHalfWindow(
  systemPrompt: string,
  sections: Array<{ label: string; content: string; required?: boolean }>,
  contextWindowTokens: number
): string {
  const maxPromptTokens = Math.max(2048, Math.floor(contextWindowTokens * 0.5));
  const reservedSystem = estimateTokens(systemPrompt) + 512;
  let remainingTokens = Math.max(1024, maxPromptTokens - reservedSystem);

  const outputParts: string[] = [];
  for (const section of sections) {
    const header = `### ${section.label}\n`;
    const headerTokens = estimateTokens(header);
    const contentTokens = estimateTokens(section.content);

    if (headerTokens + contentTokens <= remainingTokens) {
      outputParts.push(`${header}${section.content}`);
      remainingTokens -= headerTokens + contentTokens;
    } else if (remainingTokens > headerTokens + 120) {
      const maxChars = Math.floor((remainingTokens - headerTokens - 40) * 3.5);
      const clipped = section.content.slice(0, Math.max(200, maxChars));
      outputParts.push(`${header}${clipped}\n...[контекст сокращён для соблюдения лимита ≤50% окна модели]...`);
      remainingTokens = 0;
      break;
    } else if (section.required) {
      outputParts.push(`${header}${section.content.slice(0, 600)}`);
      remainingTokens = 0;
      break;
    }
  }

  return outputParts.join('\n\n');
}

/** Проверяет достижение 100% лимита бюджета проекта или суточного бюджета */
export function isBudgetExceeded(params: {
  projectSpentRub: number;
  projectBudgetRub: number;
  dailySpentRub: number;
  dailyBudgetRub: number;
}): { exceeded: boolean; reason: string | null } {
  if (params.projectSpentRub >= params.projectBudgetRub) {
    return {
      exceeded: true,
      reason: `Превышен бюджет проекта (${params.projectSpentRub.toFixed(2)} ₽ из ${params.projectBudgetRub.toFixed(2)} ₽)`,
    };
  }
  if (params.dailySpentRub >= params.dailyBudgetRub) {
    return {
      exceeded: true,
      reason: `Превышен суточный бюджет (${params.dailySpentRub.toFixed(2)} ₽ из ${params.dailyBudgetRub.toFixed(2)} ₽)`,
    };
  }
  return { exceeded: false, reason: null };
}

/** Маскирует секретные ключи в тексте и ответах API */
export function maskSecret(secret: string | undefined | null): string {
  if (!secret || secret.trim().length === 0) {
    return '';
  }
  const clean = secret.trim();
  if (clean.length <= 8) {
    return '••••';
  }
  return `${clean.slice(0, 3)}••••${clean.slice(-4)}`;
}
