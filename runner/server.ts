import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { z } from 'zod';

const PORT = Number(process.env.RUNNER_PORT ?? 4001);
const WORK_BASE = path.resolve(process.env.WORK_DIR ?? '/work');
const MAX_OUTPUT_BYTES = 128 * 1024; // 128 КБ

const RunRequestSchema = z.object({
  runId: z.string().regex(/^[a-zA-Z0-9_-]{4,80}$/),
  projectId: z.string().regex(/^[a-zA-Z0-9_-]{4,64}$/),
  command: z.string().min(1).max(200),
  args: z.array(z.string().max(300)).max(40).default([]),
  timeoutMs: z.number().int().min(1000).max(600_000).default(240_000),
  env: z.record(z.string(), z.string()).optional(),
});

// Разрешённые исполняемые бинарники внутри песочницы раннера
const ALLOWED_COMMANDS = new Set([
  'npm',
  'npx',
  'node',
  'python3',
  'python',
  'pip',
  'ruff',
  'pytest',
  'gradle',
  './gradlew',
  '.venv/bin/python',
  '.venv/bin/pip',
  '.venv/bin/ruff',
  '.venv/bin/pytest',
]);

const activeProcesses = new Map<string, ChildProcess>();

function truncateTail(bufs: Buffer[]): string {
  const combined = Buffer.concat(bufs);
  if (combined.byteLength <= MAX_OUTPUT_BYTES) {
    return combined.toString('utf8');
  }
  const tail = combined.subarray(combined.byteLength - MAX_OUTPUT_BYTES).toString('utf8');
  return `...[вывод обрезан до последних 128 КБ]...\n${tail}`;
}

function killProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
    setTimeout(() => {
      try {
        if (child.pid) process.kill(-child.pid, 'SIGKILL');
      } catch {
        // Процесс уже завершён
      }
    }, 800);
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Игнорируем если уже завершён
    }
  }
}

const app = express();
app.use(express.json({ limit: '256kb' }));

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    mode: process.env.RUNNER_ROLE ?? 'exec',
    workBase: WORK_BASE,
    activeRuns: activeProcesses.size,
  });
});

app.post('/cancel/:runId', (req, res) => {
  const runId = req.params.runId;
  const child = activeProcesses.get(runId);
  if (child) {
    killProcessTree(child);
    activeProcesses.delete(runId);
    res.json({ cancelled: true });
    return;
  }
  res.json({ cancelled: false });
});

app.post('/run', (req, res) => {
  const parsed = RunRequestSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: 'Некорректные параметры запуска', issues: parsed.error.issues });
    return;
  }

  const { runId, projectId, command, args, timeoutMs, env } = parsed.data;

  if (!ALLOWED_COMMANDS.has(command)) {
    res.status(403).json({ error: `Команда "${command}" не входит в белый список раннера` });
    return;
  }

  const cwd = path.resolve(WORK_BASE, projectId);
  if (!cwd.startsWith(WORK_BASE + path.sep) || !fs.existsSync(cwd)) {
    res.status(404).json({ error: 'Рабочий каталог проекта не найден' });
    return;
  }

  // Запрещаем передачу потенциально опасных переменных окружения
  const safeEnv: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
    HOME: process.env.HOME ?? '/home/runner',
    NPM_CONFIG_CACHE: process.env.NPM_CONFIG_CACHE ?? '/cache/npm',
    PIP_CACHE_DIR: process.env.PIP_CACHE_DIR ?? '/cache/pip',
    GRADLE_USER_HOME: process.env.GRADLE_USER_HOME ?? '/cache/gradle',
    LANG: 'C.UTF-8',
    CI: 'true',
  };

  if (env) {
    for (const [k, v] of Object.entries(env)) {
      if (!/key|secret|token|password|auth/i.test(k)) {
        safeEnv[k] = v;
      }
    }
  }

  const start = Date.now();
  const stdoutChunks: Buffer[] = [];
  const stderrChunks: Buffer[] = [];
  let timedOut = false;
  let cancelled = false;

  // Если запускаем команду из .venv, разрешаем путь внутри cwd
  const resolvedCommand = command.startsWith('.venv/') ? path.join(cwd, command) : command;

  const child = spawn(resolvedCommand, args, {
    cwd,
    env: safeEnv,
    shell: false,
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  activeProcesses.set(runId, child);

  const timer = setTimeout(() => {
    timedOut = true;
    killProcessTree(child);
  }, timeoutMs);

  let totalCollected = 0;
  const maxCollect = MAX_OUTPUT_BYTES * 2;

  child.stdout?.on('data', (chunk: Buffer) => {
    if (totalCollected < maxCollect) {
      stdoutChunks.push(chunk);
      totalCollected += chunk.byteLength;
    }
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    if (totalCollected < maxCollect) {
      stderrChunks.push(chunk);
      totalCollected += chunk.byteLength;
    }
  });

  req.on('close', () => {
    if (!res.writableEnded && activeProcesses.has(runId)) {
      cancelled = true;
      killProcessTree(child);
    }
  });

  child.on('error', (err) => {
    clearTimeout(timer);
    activeProcesses.delete(runId);
    res.status(500).json({
      exitCode: -1,
      timedOut: false,
      cancelled: false,
      durationMs: Date.now() - start,
      stdout: truncateTail(stdoutChunks),
      stderr: `Ошибка запуска процесса: ${err.message}`,
    });
  });

  child.on('close', (code) => {
    clearTimeout(timer);
    activeProcesses.delete(runId);
    if (res.writableEnded) return;
    res.json({
      exitCode: code ?? (timedOut ? 124 : 1),
      timedOut,
      cancelled,
      durationMs: Date.now() - start,
      stdout: truncateTail(stdoutChunks),
      stderr: truncateTail(stderrChunks),
    });
  });
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Раннер запущен на порту ${PORT}, рабочий каталог: ${WORK_BASE}`);
});
