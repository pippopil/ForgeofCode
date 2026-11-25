import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { StackType } from '../shared/contracts';
import { truncateTailBytes } from '../shared/jsonParser';
import { config } from './config';

export interface RunnerExecResult {
  runId: string;
  commandLabel: string;
  exitCode: number;
  timedOut: boolean;
  cancelled: boolean;
  durationMs: number;
  stdout: string;
  stderr: string;
}

const MAX_OUTPUT_BYTES = 128 * 1024; // 128 КБ
const INSTALL_TIMEOUT_MS = 600_000;
const KOTLIN_TIMEOUT_MS = 600_000;
const EXEC_TIMEOUT_MS = 240_000;

const activeLocalProcesses = new Map<string, ChildProcess>();

function isWindows(): boolean {
  return process.platform === 'win32';
}

function killLocalProcessTree(child: ChildProcess): void {
  if (!child.pid) return;
  try {
    if (isWindows()) {
      spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { shell: false, stdio: 'ignore' });
    } else {
      process.kill(-child.pid, 'SIGTERM');
      setTimeout(() => {
        try {
          if (child.pid) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // Процесс уже завершён
        }
      }, 600);
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      // Игнорируем
    }
  }
}

async function runViaProcess(params: {
  runId: string;
  projectDir: string;
  command: string;
  args: string[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<RunnerExecResult> {
  const start = Date.now();
  const cmdLabel = `${params.command} ${params.args.join(' ')}`.trim();

  if (params.abortSignal?.aborted) {
    return {
      runId: params.runId,
      commandLabel: cmdLabel,
      exitCode: 130,
      timedOut: false,
      cancelled: true,
      durationMs: 0,
      stdout: '',
      stderr: 'Выполнение отменено пользователем',
    };
  }

  return await new Promise<RunnerExecResult>((resolve) => {
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let totalBytes = 0;
    let timedOut = false;
    let cancelled = false;
    let settled = false;

    const resolvedCmd =
      params.command.startsWith('.venv') ? path.join(params.projectDir, params.command) : params.command;

    // Для Windows .cmd/.bat (npm.cmd, npx.cmd, gradlew.bat) используем корректное имя без shell:true если возможно,
    // или cmd /c только для фиксированных внутренних команд
    let spawnBin = resolvedCmd;
    let spawnArgs = params.args;
    if (isWindows() && (resolvedCmd === 'npm' || resolvedCmd === 'npx')) {
      spawnBin = `${resolvedCmd}.cmd`;
    }

    const child = spawn(spawnBin, spawnArgs, {
      cwd: params.projectDir,
      shell: false,
      detached: !isWindows(),
      env: {
        PATH: process.env.PATH ?? '',
        HOME: process.env.HOME ?? process.env.USERPROFILE ?? '',
        USERPROFILE: process.env.USERPROFILE ?? '',
        SYSTEMROOT: process.env.SYSTEMROOT ?? '',
        LANG: 'C.UTF-8',
        CI: 'true',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    activeLocalProcesses.set(params.runId, child);

    const onAbort = () => {
      cancelled = true;
      killLocalProcessTree(child);
    };
    params.abortSignal?.addEventListener('abort', onAbort, { once: true });

    const timer = setTimeout(() => {
      timedOut = true;
      killLocalProcessTree(child);
    }, params.timeoutMs);

    const pushChunk = (target: Buffer[], chunk: Buffer) => {
      if (totalBytes < MAX_OUTPUT_BYTES * 2) {
        target.push(chunk);
        totalBytes += chunk.byteLength;
      }
    };

    child.stdout?.on('data', (c: Buffer) => pushChunk(stdoutChunks, c));
    child.stderr?.on('data', (c: Buffer) => pushChunk(stderrChunks, c));

    const finish = (code: number, extraErr = '') => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      params.abortSignal?.removeEventListener('abort', onAbort);
      activeLocalProcesses.delete(params.runId);
      const rawOut = Buffer.concat(stdoutChunks).toString('utf8');
      const rawErr = Buffer.concat(stderrChunks).toString('utf8') + (extraErr ? `\n${extraErr}` : '');
      resolve({
        runId: params.runId,
        commandLabel: cmdLabel,
        exitCode: code,
        timedOut,
        cancelled,
        durationMs: Date.now() - start,
        stdout: truncateTailBytes(rawOut, MAX_OUTPUT_BYTES),
        stderr: truncateTailBytes(rawErr.trim(), MAX_OUTPUT_BYTES),
      });
    };

    child.on('error', (err) => {
      finish(1, `Не удалось запустить "${params.command}": ${err.message}`);
    });

    child.on('close', (code) => {
      finish(code ?? (timedOut ? 124 : cancelled ? 130 : 1));
    });
  });
}

async function runViaDocker(params: {
  runId: string;
  projectId: string;
  role: 'install' | 'exec';
  command: string;
  args: string[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<RunnerExecResult> {
  const baseUrl = params.role === 'install' ? config.runnerInstallUrl : config.runnerExecUrl;
  const cmdLabel = `${params.command} ${params.args.join(' ')}`.trim();

  const controller = new AbortController();
  const onAbort = () => {
    controller.abort();
    fetch(`${baseUrl}/cancel/${encodeURIComponent(params.runId)}`, { method: 'POST' }).catch(() => {});
  };
  params.abortSignal?.addEventListener('abort', onAbort, { once: true });

  const start = Date.now();
  try {
    const res = await fetch(`${baseUrl}/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        runId: params.runId,
        projectId: params.projectId,
        command: params.command,
        args: params.args,
        timeoutMs: params.timeoutMs,
      }),
      signal: controller.signal,
    });

    const data = (await res.json()) as {
      exitCode?: number;
      timedOut?: boolean;
      cancelled?: boolean;
      durationMs?: number;
      stdout?: string;
      stderr?: string;
      error?: string;
    };

    if (!res.ok) {
      return {
        runId: params.runId,
        commandLabel: cmdLabel,
        exitCode: 1,
        timedOut: false,
        cancelled: false,
        durationMs: Date.now() - start,
        stdout: '',
        stderr: data.error ?? `HTTP ${res.status} от раннера`,
      };
    }

    return {
      runId: params.runId,
      commandLabel: cmdLabel,
      exitCode: data.exitCode ?? 1,
      timedOut: Boolean(data.timedOut),
      cancelled: Boolean(data.cancelled),
      durationMs: data.durationMs ?? Date.now() - start,
      stdout: truncateTailBytes(data.stdout ?? '', MAX_OUTPUT_BYTES),
      stderr: truncateTailBytes(data.stderr ?? '', MAX_OUTPUT_BYTES),
    };
  } catch (err) {
    const aborted = Boolean(params.abortSignal?.aborted);
    return {
      runId: params.runId,
      commandLabel: cmdLabel,
      exitCode: aborted ? 130 : 1,
      timedOut: false,
      cancelled: aborted,
      durationMs: Date.now() - start,
      stdout: '',
      stderr: aborted
        ? 'Выполнение отменено пользователем'
        : `Ошибка связи с Docker-раннером (${baseUrl}): ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    params.abortSignal?.removeEventListener('abort', onAbort);
  }
}

async function execCommand(params: {
  projectId: string;
  projectDir: string;
  role: 'install' | 'exec';
  command: string;
  args: string[];
  timeoutMs: number;
  abortSignal?: AbortSignal;
}): Promise<RunnerExecResult> {
  const runId = `run_${crypto.randomBytes(6).toString('hex')}`;
  if (config.runnerMode === 'docker') {
    return runViaDocker({ ...params, runId });
  }
  return runViaProcess({
    runId,
    projectDir: params.projectDir,
    command: params.command,
    args: params.args,
    timeoutMs: params.timeoutMs,
    abortSignal: params.abortSignal,
  });
}

/** Вычисляет хэш файлов зависимостей для пропуска повторного install */
export function computeDependencyManifestHash(projectDir: string, stack: StackType): string {
  const filesToHash =
    stack === 'ts-web' || stack === 'node-api'
      ? ['package-lock.json', 'package.json']
      : stack === 'python'
        ? ['requirements.txt', 'pyproject.toml']
        : ['build.gradle.kts', 'settings.gradle.kts', 'gradle.properties'];

  const hash = crypto.createHash('sha256');
  for (const rel of filesToHash) {
    const full = path.join(projectDir, rel);
    if (fs.existsSync(full)) {
      hash.update(rel);
      hash.update(fs.readFileSync(full));
    }
  }
  return hash.digest('hex').slice(0, 16);
}

export function hasInstalledArtifacts(projectDir: string, stack: StackType): boolean {
  if (stack === 'ts-web' || stack === 'node-api') {
    return fs.existsSync(path.join(projectDir, 'node_modules'));
  }
  if (stack === 'python') {
    return fs.existsSync(path.join(projectDir, '.venv'));
  }
  return fs.existsSync(path.join(projectDir, '.gradle')) || fs.existsSync(path.join(projectDir, 'build'));
}

function getVenvExecutable(name: 'python' | 'pip' | 'ruff' | 'pytest'): string {
  if (config.runnerMode === 'process' && isWindows()) {
    return path.join('.venv', 'Scripts', `${name}.exe`);
  }
  return `.venv/bin/${name}`;
}

function getGradleCommand(projectDir: string): string {
  if (config.runnerMode === 'process' && isWindows()) {
    if (fs.existsSync(path.join(projectDir, 'gradlew.bat'))) return 'gradlew.bat';
    return 'gradle';
  }
  if (fs.existsSync(path.join(projectDir, 'gradlew'))) return './gradlew';
  return 'gradle';
}

export async function runInstallStage(params: {
  projectId: string;
  projectDir: string;
  stack: StackType;
  abortSignal?: AbortSignal;
}): Promise<RunnerExecResult> {
  if (params.stack === 'ts-web' || params.stack === 'node-api') {
    const hasLock = fs.existsSync(path.join(params.projectDir, 'package-lock.json'));
    const args = hasLock
      ? ['ci', '--ignore-scripts']
      : ['install', '--ignore-scripts', '--no-audit', '--no-fund'];
    return execCommand({
      projectId: params.projectId,
      projectDir: params.projectDir,
      role: 'install',
      command: 'npm',
      args,
      timeoutMs: INSTALL_TIMEOUT_MS,
      abortSignal: params.abortSignal,
    });
  }

  if (params.stack === 'python') {
    const venvDir = path.join(params.projectDir, '.venv');
    if (!fs.existsSync(venvDir)) {
      const pyBin = config.runnerMode === 'process' && isWindows() ? 'python' : 'python3';
      const venvRes = await execCommand({
        projectId: params.projectId,
        projectDir: params.projectDir,
        role: 'install',
        command: pyBin,
        args: ['-m', 'venv', '.venv'],
        timeoutMs: INSTALL_TIMEOUT_MS,
        abortSignal: params.abortSignal,
      });
      if (venvRes.exitCode !== 0) return venvRes;
    }

    return execCommand({
      projectId: params.projectId,
      projectDir: params.projectDir,
      role: 'install',
      command: getVenvExecutable('pip'),
      args: ['install', '-r', 'requirements.txt'],
      timeoutMs: INSTALL_TIMEOUT_MS,
      abortSignal: params.abortSignal,
    });
  }

  // Kotlin: gradle --no-daemon dependencies
  const gradleCmd = getGradleCommand(params.projectDir);
  return execCommand({
    projectId: params.projectId,
    projectDir: params.projectDir,
    role: 'install',
    command: gradleCmd,
    args: ['--no-daemon', 'dependencies'],
    timeoutMs: KOTLIN_TIMEOUT_MS,
    abortSignal: params.abortSignal,
  });
}

export async function runBuildStage(params: {
  projectId: string;
  projectDir: string;
  stack: StackType;
  abortSignal?: AbortSignal;
}): Promise<RunnerExecResult[]> {
  if (params.stack === 'ts-web' || params.stack === 'node-api') {
    const tscRes = await execCommand({
      projectId: params.projectId,
      projectDir: params.projectDir,
      role: 'exec',
      command: 'npx',
      args: ['tsc', '--noEmit'],
      timeoutMs: EXEC_TIMEOUT_MS,
      abortSignal: params.abortSignal,
    });
    if (tscRes.exitCode !== 0) return [tscRes];

    const buildRes = await execCommand({
      projectId: params.projectId,
      projectDir: params.projectDir,
      role: 'exec',
      command: 'npm',
      args: ['run', 'build'],
      timeoutMs: EXEC_TIMEOUT_MS,
      abortSignal: params.abortSignal,
    });
    return [tscRes, buildRes];
  }

  if (params.stack === 'python') {
    const ruffRes = await execCommand({
      projectId: params.projectId,
      projectDir: params.projectDir,
      role: 'exec',
      command: getVenvExecutable('ruff'),
      args: ['check', '.'],
      timeoutMs: EXEC_TIMEOUT_MS,
      abortSignal: params.abortSignal,
    });
    if (ruffRes.exitCode !== 0) return [ruffRes];

    const compileRes = await execCommand({
      projectId: params.projectId,
      projectDir: params.projectDir,
      role: 'exec',
      command: getVenvExecutable('python'),
      args: ['-m', 'compileall', '-q', '.'],
      timeoutMs: EXEC_TIMEOUT_MS,
      abortSignal: params.abortSignal,
    });
    return [ruffRes, compileRes];
  }

  // Kotlin: build -x test --offline; при нехватке зависимостей один повтор без --offline
  const gradleCmd = getGradleCommand(params.projectDir);
  const offlineRes = await execCommand({
    projectId: params.projectId,
    projectDir: params.projectDir,
    role: 'exec',
    command: gradleCmd,
    args: ['--no-daemon', 'build', '-x', 'test', '--offline'],
    timeoutMs: KOTLIN_TIMEOUT_MS,
    abortSignal: params.abortSignal,
  });

  if (offlineRes.exitCode === 0 || offlineRes.cancelled) {
    return [offlineRes];
  }

  const combinedErr = `${offlineRes.stdout}\n${offlineRes.stderr}`.toLowerCase();
  const missingCache =
    combinedErr.includes('no cached version') ||
    combinedErr.includes('not available in offline mode') ||
    combinedErr.includes('could not resolve');

  if (!missingCache) {
    return [offlineRes];
  }

  const onlineRetry = await execCommand({
    projectId: params.projectId,
    projectDir: params.projectDir,
    role: 'install',
    command: gradleCmd,
    args: ['--no-daemon', 'build', '-x', 'test'],
    timeoutMs: KOTLIN_TIMEOUT_MS,
    abortSignal: params.abortSignal,
  });
  return [offlineRes, onlineRetry];
}

export async function runTestStage(params: {
  projectId: string;
  projectDir: string;
  stack: StackType;
  abortSignal?: AbortSignal;
}): Promise<RunnerExecResult[]> {
  if (params.stack === 'ts-web' || params.stack === 'node-api') {
    const testRes = await execCommand({
      projectId: params.projectId,
      projectDir: params.projectDir,
      role: 'exec',
      command: 'npx',
      args: ['vitest', 'run'],
      timeoutMs: EXEC_TIMEOUT_MS,
      abortSignal: params.abortSignal,
    });
    return [testRes];
  }

  if (params.stack === 'python') {
    const testRes = await execCommand({
      projectId: params.projectId,
      projectDir: params.projectDir,
      role: 'exec',
      command: getVenvExecutable('pytest'),
      args: ['-q'],
      timeoutMs: EXEC_TIMEOUT_MS,
      abortSignal: params.abortSignal,
    });
    return [testRes];
  }

  // Kotlin: test --offline с одним повтором без --offline при нехватке зависимостей
  const gradleCmd = getGradleCommand(params.projectDir);
  const offlineRes = await execCommand({
    projectId: params.projectId,
    projectDir: params.projectDir,
    role: 'exec',
    command: gradleCmd,
    args: ['--no-daemon', 'test', '--offline'],
    timeoutMs: KOTLIN_TIMEOUT_MS,
    abortSignal: params.abortSignal,
  });

  if (offlineRes.exitCode === 0 || offlineRes.cancelled) {
    return [offlineRes];
  }

  const combinedErr = `${offlineRes.stdout}\n${offlineRes.stderr}`.toLowerCase();
  const missingCache =
    combinedErr.includes('no cached version') ||
    combinedErr.includes('not available in offline mode') ||
    combinedErr.includes('could not resolve');

  if (!missingCache) {
    return [offlineRes];
  }

  const onlineRetry = await execCommand({
    projectId: params.projectId,
    projectDir: params.projectDir,
    role: 'install',
    command: gradleCmd,
    args: ['--no-daemon', 'test'],
    timeoutMs: KOTLIN_TIMEOUT_MS,
    abortSignal: params.abortSignal,
  });
  return [offlineRes, onlineRetry];
}

export function cancelAllLocalRuns(): void {
  for (const [, child] of activeLocalProcesses.entries()) {
    killLocalProcessTree(child);
  }
  activeLocalProcesses.clear();
}
