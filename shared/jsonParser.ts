import crypto from 'node:crypto';
import type { ZodType } from 'zod';

/** Извлекает JSON из блока ```json ... ``` или из первого валидного JSON-объекта в тексте */
export function extractJsonBlock(rawText: string): string {
  const trimmed = rawText.trim();

  // Ищем fenced-блок ```json ... ```
  const fencedJsonMatch = trimmed.match(/```(?:json)?\s*\r?\n([\s\S]*?)\r?\n```/i);
  if (fencedJsonMatch && fencedJsonMatch[1]) {
    return fencedJsonMatch[1].trim();
  }

  // Если текст сам начинается с { или [, возвращаем диапазон от первой { до последней }
  const firstBrace = trimmed.indexOf('{');
  const lastBrace = trimmed.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    return trimmed.slice(firstBrace, lastBrace + 1).trim();
  }

  return trimmed;
}

export type ParseResult<T> =
  | { ok: true; data: T; rawJson: string }
  | { ok: false; error: string; rawJson: string };

/** Парсит JSON-блок и проверяет по Zod-схеме */
export function parseAndValidateJson<T>(rawText: string, schema: ZodType<T>): ParseResult<T> {
  const rawJson = extractJsonBlock(rawText);
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    const msg = err instanceof Error ? err.message : 'Ошибка синтаксиса JSON';
    return { ok: false, error: `Невалидный JSON: ${msg}`, rawJson };
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((i) => `${i.path.join('.') || 'root'}: ${i.message}`)
      .join('; ');
    return { ok: false, error: `Ошибка схемы Zod: ${issues}`, rawJson };
  }

  return { ok: true, data: result.data, rawJson };
}

/** Ограничивает размер вывода команд по байтам с сохранением хвоста */
export function truncateTailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, 'utf8');
  if (buf.byteLength <= maxBytes) {
    return text;
  }
  const sliced = buf.subarray(buf.byteLength - maxBytes);
  // Корректно декодируем UTF-8 и отбрасываем возможную обрезанную первую строку
  const decoded = sliced.toString('utf8');
  const firstNewline = decoded.indexOf('\n');
  const cleanTail = firstNewline >= 0 && firstNewline < 160 ? decoded.slice(firstNewline + 1) : decoded;
  return `...[обрезано, показаны последние ${Math.round(maxBytes / 1024)} КБ]...\n${cleanTail}`;
}

/** Вычисляет детерминированный хэш «нормализованная ошибка + затронутые файлы» для защиты от зацикливания */
export function computeErrorHash(errorOutput: string, files: string[]): string {
  const normalizedError = errorOutput
    .toLowerCase()
    .replace(/\d{4}-\d{2}-\d{2}t[\d:.]+z/gi, '') // убрать ISO даты
    .replace(/\b\d+ms\b|\b\d+\.\d+s\b/gi, '') // убрать тайминги
    .replace(/:\d+:\d+/g, ':L:C') // унифицировать номера строк/колонок для точного матчинга похожих падений
    .replace(/\s+/g, ' ')
    .trim()
    .slice(-2000);

  const normalizedFiles = [...new Set(files.map((f) => f.replace(/\\/g, '/').trim()))].sort();

  return crypto
    .createHash('sha256')
    .update(`${normalizedError}::${normalizedFiles.join(',')}`)
    .digest('hex')
    .slice(0, 16);
}
