import path from 'node:path';
import type { FilePatchOutput } from './contracts';

/** Жёсткие ограничения патча Кодера */
export const MAX_PATCH_FILES = 40;
export const MAX_SINGLE_FILE_BYTES = 150 * 1024; // 150 КБ
export const MAX_TOTAL_PATCH_BYTES = 1536 * 1024; // 1.5 МБ

/** Проверка корректности UTF-8 без битых суррогатов и управляющих NUL-байтов */
export function isValidUtf8Text(content: string): boolean {
  if (content.includes('\u0000')) {
    return false;
  }
  // Проверка на непарные суррогаты UTF-16
  for (let i = 0; i < content.length; i++) {
    const code = content.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = content.charCodeAt(i + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        return false;
      }
      i++;
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false;
    }
  }
  return true;
}

/**
 * Разрешает относительный путь строго внутри projectRoot (path-jail).
 * Блокирует абсолютные пути, выход через `..`, запись в `.git` и NUL-байты.
 */
export function resolveInProjectJail(projectRoot: string, relativePath: string): string {
  const normalizedInput = relativePath.replace(/\\/g, '/').trim();

  if (!normalizedInput || normalizedInput.includes('\u0000')) {
    throw new Error(`Некорректный путь файла: "${relativePath}"`);
  }

  if (path.posix.isAbsolute(normalizedInput) || path.win32.isAbsolute(normalizedInput)) {
    throw new Error(`Абсолютные пути запрещены: "${relativePath}"`);
  }

  const segments = normalizedInput.split('/').filter(Boolean);
  if (segments.length === 0) {
    throw new Error(`Пустой путь файла: "${relativePath}"`);
  }

  if (segments.some((seg) => seg === '.' || seg === '..')) {
    throw new Error(`Запрещённый переход по каталогам в пути: "${relativePath}"`);
  }

  if (segments[0] === '.git' || segments.includes('.git')) {
    throw new Error(`Запись в служебный каталог .git запрещена: "${relativePath}"`);
  }

  const baseDir = path.resolve(projectRoot);
  const resolved = path.resolve(baseDir, ...segments);

  if (resolved !== baseDir && !resolved.startsWith(baseDir + path.sep)) {
    throw new Error(`Путь выходит за пределы песочницы проекта: "${relativePath}"`);
  }

  return resolved;
}

export interface PatchValidationResult {
  totalBytes: number;
  resolvedFiles: Array<{
    relativePath: string;
    absolutePath: string;
    action: 'create' | 'update' | 'delete';
    content?: string;
    bytes: number;
  }>;
}

/** Проверяет лимиты патча (<=40 файлов, <=150 КБ/файл, <=1.5 МБ суммарно, UTF-8, path-jail) */
export function validateFilePatch(projectRoot: string, patch: FilePatchOutput): PatchValidationResult {
  if (patch.files.length > MAX_PATCH_FILES) {
    throw new Error(`Превышен лимит файлов в патче: ${patch.files.length} > ${MAX_PATCH_FILES}`);
  }

  let totalBytes = 0;
  const seenPaths = new Set<string>();
  const resolvedFiles: PatchValidationResult['resolvedFiles'] = [];

  for (const file of patch.files) {
    const cleanRel = file.path.replace(/\\/g, '/').replace(/^\/+/, '');
    if (seenPaths.has(cleanRel)) {
      throw new Error(`Дублирующийся путь в одном патче: "${cleanRel}"`);
    }
    seenPaths.add(cleanRel);

    const absolutePath = resolveInProjectJail(projectRoot, cleanRel);
    let bytes = 0;

    if (file.action === 'create' || file.action === 'update') {
      const content = file.content ?? '';
      if (!isValidUtf8Text(content)) {
        throw new Error(`Файл "${cleanRel}" содержит недопустимые символы или NUL-байты`);
      }
      bytes = Buffer.byteLength(content, 'utf8');
      if (bytes > MAX_SINGLE_FILE_BYTES) {
        throw new Error(
          `Файл "${cleanRel}" превышает лимит ${Math.round(MAX_SINGLE_FILE_BYTES / 1024)} КБ (${bytes} байт)`
        );
      }
      totalBytes += bytes;
      resolvedFiles.push({
        relativePath: cleanRel,
        absolutePath,
        action: file.action,
        content,
        bytes,
      });
    } else {
      resolvedFiles.push({
        relativePath: cleanRel,
        absolutePath,
        action: 'delete',
        bytes: 0,
      });
    }
  }

  if (totalBytes > MAX_TOTAL_PATCH_BYTES) {
    throw new Error(
      `Суммарный объём патча превышает лимит 1.5 МБ (${(totalBytes / (1024 * 1024)).toFixed(2)} МБ)`
    );
  }

  return { totalBytes, resolvedFiles };
}
