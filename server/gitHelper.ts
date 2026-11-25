import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { resolveInProjectJail } from '../shared/pathJail';

const execFileAsync = promisify(execFile);

const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.venv',
  'venv',
  'dist',
  'build',
  '.gradle',
  '__pycache__',
  '.pytest_cache',
  '.ruff_cache',
]);

async function runGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: 15_000,
      maxBuffer: 2 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Ошибка git (${args[0]}): ${msg}`);
  }
}

/** Инициализирует git-репозиторий проекта и делает первый коммит шаблона */
export async function ensureGitRepo(projectDir: string): Promise<void> {
  const gitDir = path.join(projectDir, '.git');
  if (!fs.existsSync(gitDir)) {
    await runGit(projectDir, ['init']);
    await runGit(projectDir, ['config', 'user.name', 'CodeForge Bot']);
    await runGit(projectDir, ['config', 'user.email', 'bot@codeforge.local']);
    await commitAll(projectDir, 'chore: инициализация шаблона проекта');
  }
}

/** Фиксирует изменения в git (если изменений нет — пропускает без ошибки) */
export async function commitAll(projectDir: string, message: string): Promise<boolean> {
  await runGit(projectDir, ['add', '-A']);
  const status = await runGit(projectDir, ['status', '--porcelain']);
  if (!status.trim()) {
    return false;
  }
  await runGit(projectDir, ['commit', '-m', message]);
  return true;
}

/** Возвращает git diff последнего коммита (или рабочего дерева) для ревьюера и UI */
export async function getLatestDiff(projectDir: string, maxChars = 60_000): Promise<string> {
  try {
    const logOut = await runGit(projectDir, ['rev-list', '--count', 'HEAD']);
    const commitCount = Number(logOut.trim() || '0');
    let diff = '';
    if (commitCount >= 2) {
      diff = await runGit(projectDir, ['diff', 'HEAD~1', 'HEAD', '--', '.', ':!package-lock.json']);
    } else if (commitCount === 1) {
      diff = await runGit(projectDir, ['show', '--format=', 'HEAD']);
    }
    if (!diff.trim()) {
      diff = await runGit(projectDir, ['diff']);
    }
    if (diff.length > maxChars) {
      return `${diff.slice(0, maxChars)}\n...[diff сокращён для экономии контекста]...`;
    }
    return diff;
  } catch {
    return '';
  }
}

export interface ProjectFileEntry {
  path: string;
  size: number;
}

/** Рекурсивно перечисляет файлы проекта внутри path-jail */
export function listProjectFiles(projectDir: string): ProjectFileEntry[] {
  const results: ProjectFileEntry[] = [];
  const base = path.resolve(projectDir);

  function walk(dir: string): void {
    if (!fs.existsSync(dir)) return;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      if (!fullPath.startsWith(base + path.sep)) continue;
      if (entry.isDirectory()) {
        walk(fullPath);
      } else if (entry.isFile()) {
        const stat = fs.statSync(fullPath);
        const rel = path.relative(base, fullPath).replace(/\\/g, '/');
        results.push({ path: rel, size: stat.size });
      }
    }
  }

  walk(base);
  return results;
}

/** Безопасно читает файл из рабочей папки проекта */
export function readProjectFile(projectDir: string, relativePath: string): string {
  const safePath = resolveInProjectJail(projectDir, relativePath);
  if (!fs.existsSync(safePath)) {
    throw new Error(`Файл не найден: ${relativePath}`);
  }
  const stat = fs.statSync(safePath);
  if (stat.size > 512 * 1024) {
    throw new Error(`Файл слишком велик для просмотра (${Math.round(stat.size / 1024)} КБ)`);
  }
  return fs.readFileSync(safePath, 'utf8');
}

/** Строит компактную карту репозитория (repo_map) вместо полного дампа кода */
export function buildRepoMap(projectDir: string, maxFiles = 100): string {
  const files = listProjectFiles(projectDir).slice(0, maxFiles);
  if (files.length === 0) return '(проект пуст)';

  const lines: string[] = [];
  for (const file of files) {
    let symbolsSummary = '';
    if (file.size <= 64 * 1024 && /\.(ts|tsx|js|jsx|py|kt|kts)$/.test(file.path)) {
      try {
        const content = readProjectFile(projectDir, file.path);
        const matches = content
          .split('\n')
          .map((l) => l.trim())
          .filter((l) =>
            /^(export\s+(async\s+)?(function|const|class|interface|type)|def\s+|class\s+|fun\s+|app\.(get|post|put|delete)|@app\.)/.test(
              l
            )
          )
          .slice(0, 8)
          .map((l) => l.slice(0, 72));
        if (matches.length > 0) {
          symbolsSummary = ` -> [${matches.join(' | ')}]`;
        }
      } catch {
        // Пропускаем нечитаемый файл
      }
    }
    lines.push(`- ${file.path} (${file.size} B)${symbolsSummary}`);
  }

  return lines.join('\n');
}
