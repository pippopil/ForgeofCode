import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  DebugSchema,
  FilePatchSchema,
  PlanSchema,
  ReviewSchema,
  type AgentRole,
  type DebugOutput,
  type FilePatchOutput,
  type PipelineStage,
  type PlanOutput,
  type ProjectStatus,
  type ReviewOutput,
  type StackType,
} from '../shared/contracts';
import { computeErrorHash, truncateTailBytes } from '../shared/jsonParser';
import { validateFilePatch } from '../shared/pathJail';
import { isBudgetExceeded } from '../shared/pricing';
import { config } from './config';
import {
  db,
  getAgentSeeds,
  getDailySpentRub,
  getResolvedSettings,
  recordStackError,
  type AgentEventRecord,
  type CommandRunRecord,
  type ProjectRecord,
} from './db';
import {
  buildRepoMap,
  commitAll,
  ensureGitRepo,
  getLatestDiff,
  readProjectFile,
} from './gitHelper';
import { callAgentStructured } from './llm';
import {
  computeDependencyManifestHash,
  hasInstalledArtifacts,
  runBuildStage,
  runInstallStage,
  runTestStage,
  type RunnerExecResult,
} from './runner';
import { wsHub } from './ws';

const LLM_TAIL_MAX_BYTES = 8 * 1024; // 8 КБ в контекст LLM

function getProjectDir(projectId: string): string {
  const dir = path.resolve(config.workDir, projectId);
  if (!dir.startsWith(path.resolve(config.workDir) + path.sep)) {
    throw new Error('Некорректный идентификатор рабочего каталога проекта');
  }
  return dir;
}

/** Инициализирует рабочий каталог проекта из шаблона выбранного стека */
export async function initializeProjectWorkspace(projectId: string, stack: StackType): Promise<void> {
  const projectDir = getProjectDir(projectId);
  const templateDir = path.resolve(config.templatesDir, stack);
  if (!fs.existsSync(templateDir)) {
    throw new Error(`Шаблон стека "${stack}" не найден`);
  }
  fs.mkdirSync(projectDir, { recursive: true });
  fs.cpSync(templateDir, projectDir, { recursive: true, force: true });
  await ensureGitRepo(projectDir);
}

function getProjectById(projectId: string): ProjectRecord {
  const row = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(projectId) as
    | ProjectRecord
    | undefined;
  if (!row) {
    throw new Error(`Проект "${projectId}" не найден`);
  }
  return row;
}

function updateProject(
  projectId: string,
  fields: Partial<{
    status: ProjectStatus;
    stage: PipelineStage;
    iteration: number;
    last_error: string | null;
    last_error_hash: string | null;
    repeat_error_count: number;
    last_install_hash: string | null;
    plan_json: string | null;
    review_json: string | null;
    refine_instruction: string | null;
  }>
): ProjectRecord {
  const keys = Object.keys(fields) as Array<keyof typeof fields>;
  if (keys.length === 0) return getProjectById(projectId);

  const now = new Date().toISOString();
  const sets = keys.map((k) => `${k} = ?`);
  sets.push('updated_at = ?');
  const values = keys.map((k) => fields[k] ?? null);
  values.push(now, projectId);

  db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  const updated = getProjectById(projectId);
  wsHub.broadcastProject(projectId, { type: 'project:updated', data: updated });
  wsHub.broadcastAll({ type: 'projects:list_updated', projectId });
  return updated;
}

function appendAgentEvent(params: {
  projectId: string;
  iteration: number;
  stage: PipelineStage | string;
  agentRole: AgentRole | 'system';
  model: string;
  summary: string;
  payload: unknown;
  promptTokens?: number;
  completionTokens?: number;
  costRub?: number;
}): AgentEventRecord {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO agent_events (project_id, iteration, stage, agent_role, model, summary, payload_json, prompt_tokens, completion_tokens, cost_rub, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.projectId,
      params.iteration,
      params.stage,
      params.agentRole,
      params.model,
      params.summary,
      JSON.stringify(params.payload),
      params.promptTokens ?? 0,
      params.completionTokens ?? 0,
      params.costRub ?? 0,
      now
    );

  const event = db
    .prepare(`SELECT * FROM agent_events WHERE id = ?`)
    .get(info.lastInsertRowid) as AgentEventRecord;

  wsHub.broadcastProject(params.projectId, { type: 'project:event', data: event });
  return event;
}

function saveCommandRun(
  projectId: string,
  iteration: number,
  stage: PipelineStage,
  res: RunnerExecResult
): CommandRunRecord {
  const now = new Date().toISOString();
  const id = res.runId || `cmd_${crypto.randomBytes(6).toString('hex')}`;
  db.prepare(
    `INSERT INTO command_runs (id, project_id, iteration, stage, command, exit_code, timed_out, duration_ms, stdout, stderr, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    projectId,
    iteration,
    stage,
    res.commandLabel,
    res.exitCode,
    res.timedOut ? 1 : 0,
    res.durationMs,
    res.stdout,
    res.stderr,
    now
  );

  const saved = db.prepare(`SELECT * FROM command_runs WHERE id = ?`).get(id) as CommandRunRecord;
  wsHub.broadcastProject(projectId, { type: 'project:command', data: saved });
  return saved;
}

function applyFilePatchToWorkspace(projectDir: string, patch: FilePatchOutput): string[] {
  const validated = validateFilePatch(projectDir, patch);
  const touched: string[] = [];

  for (const item of validated.resolvedFiles) {
    touched.push(item.relativePath);
    if (item.action === 'delete') {
      if (fs.existsSync(item.absolutePath)) {
        fs.unlinkSync(item.absolutePath);
      }
    } else {
      fs.mkdirSync(path.dirname(item.absolutePath), { recursive: true });
      fs.writeFileSync(item.absolutePath, item.content ?? '', 'utf8');
    }
  }

  return touched;
}

function getAgentPromptMap(): Record<AgentRole, string> {
  const rows = getAgentSeeds();
  const map: Record<AgentRole, string> = {
    architect: '',
    coder: '',
    reviewer: '',
  };
  for (const r of rows) {
    map[r.role] = r.system_prompt;
  }
  return map;
}

class PipelineOrchestrator {
  private currentProjectId: string | null = null;
  private currentAbort: AbortController | null = null;
  private isProcessing = false;

  public getActiveProjectId(): string | null {
    return this.currentProjectId;
  }

  public enqueue(projectId: string): void {
    const project = getProjectById(projectId);
    if (project.status !== 'queued' && project.status !== 'running') {
      updateProject(projectId, { status: 'queued', last_error: null });
    }
    this.processNext();
  }

  public cancel(projectId: string): boolean {
    const project = getProjectById(projectId);
    if (this.currentProjectId === projectId && this.currentAbort) {
      this.currentAbort.abort();
      updateProject(projectId, { status: 'cancelled', last_error: 'Отменено пользователем' });
      appendAgentEvent({
        projectId,
        iteration: project.iteration,
        stage: project.stage,
        agentRole: 'system',
        model: 'orchestrator',
        summary: 'Выполнение немедленно остановлено пользователем',
        payload: { cancelled: true },
      });
      return true;
    }

    if (project.status === 'queued' || project.status === 'running' || project.status === 'paused') {
      updateProject(projectId, { status: 'cancelled', last_error: 'Отменено пользователем' });
      appendAgentEvent({
        projectId,
        iteration: project.iteration,
        stage: project.stage,
        agentRole: 'system',
        model: 'orchestrator',
        summary: 'Проект снят с очереди и отменён',
        payload: { cancelled: true },
      });
      return true;
    }
    return false;
  }

  public resume(projectId: string): void {
    const project = getProjectById(projectId);
    if (project.status === 'running') return;

    updateProject(projectId, {
      status: 'queued',
      last_error: null,
      repeat_error_count: 0,
    });
    appendAgentEvent({
      projectId,
      iteration: project.iteration,
      stage: project.stage,
      agentRole: 'system',
      model: 'orchestrator',
      summary: `Возобновление конвейера со стадии ${project.stage} (итерация ${project.iteration})`,
      payload: { resumed: true, stage: project.stage },
    });
    this.processNext();
  }

  public refine(projectId: string, instruction: string): void {
    const project = getProjectById(projectId);
    if (project.status === 'running' || project.status === 'queued') {
      throw new Error('Нельзя запустить доработку, пока проект выполняется или в очереди');
    }

    updateProject(projectId, {
      status: 'queued',
      stage: 'CODE',
      iteration: 0,
      repeat_error_count: 0,
      last_error: null,
      last_error_hash: null,
      refine_instruction: instruction,
    });
    appendAgentEvent({
      projectId,
      iteration: 0,
      stage: 'CODE',
      agentRole: 'system',
      model: 'orchestrator',
      summary: 'Запущена доработка проекта по новой инструкции пользователя',
      payload: { instruction },
    });
    this.processNext();
  }

  private processNext(): void {
    if (this.isProcessing) return;

    const next = db
      .prepare(`SELECT id FROM projects WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1`)
      .get() as { id: string } | undefined;

    if (!next) return;

    this.isProcessing = true;
    this.currentProjectId = next.id;
    this.currentAbort = new AbortController();

    this.runProjectPipeline(next.id, this.currentAbort.signal)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        const latest = getProjectById(next.id);
        if (latest.status === 'running') {
          updateProject(next.id, { status: 'failed', last_error: msg });
          appendAgentEvent({
            projectId: next.id,
            iteration: latest.iteration,
            stage: latest.stage,
            agentRole: 'system',
            model: 'orchestrator',
            summary: `Аварийная остановка: ${msg}`,
            payload: { error: msg },
          });
        }
      })
      .finally(() => {
        this.isProcessing = false;
        this.currentProjectId = null;
        this.currentAbort = null;
        setImmediate(() => this.processNext());
      });
  }

  private checkBudgetOrStop(projectId: string): boolean {
    const project = getProjectById(projectId);
    const settings = getResolvedSettings();
    const dailySpentRub = getDailySpentRub();
    const check = isBudgetExceeded({
      projectSpentRub: project.spent_rub,
      projectBudgetRub: project.budget_rub,
      dailySpentRub,
      dailyBudgetRub: settings.dailyBudgetRub,
    });

    if (check.exceeded) {
      updateProject(projectId, {
        status: 'budget_exceeded',
        last_error: check.reason,
      });
      appendAgentEvent({
        projectId,
        iteration: project.iteration,
        stage: project.stage,
        agentRole: 'system',
        model: 'orchestrator',
        summary: check.reason ?? 'Лимит бюджета исчерпан (100%)',
        payload: {
          projectSpentRub: project.spent_rub,
          projectBudgetRub: project.budget_rub,
          dailySpentRub,
          dailyBudgetRub: settings.dailyBudgetRub,
        },
      });
      return false;
    }
    return true;
  }

  private async runProjectPipeline(projectId: string, signal: AbortSignal): Promise<void> {
    let project = updateProject(projectId, { status: 'running', last_error: null });
    const projectDir = getProjectDir(projectId);
    await ensureGitRepo(projectDir);

    let pendingDebug: DebugOutput | null = null;
    let pendingErrorTail = '';
    let pendingFiles: string[] = [];

    while (!signal.aborted) {
      project = getProjectById(projectId);
      if (project.status !== 'running') break;

      const prompts = getAgentPromptMap();

      if (project.stage === 'PLAN') {
        if (!this.checkBudgetOrStop(projectId)) return;

        const repoMap = buildRepoMap(projectDir);
        const planResult = await callAgentStructured({
          projectId,
          role: 'architect',
          systemPrompt: prompts.architect,
          contextSections: [
            { label: 'Техническое задание (ТЗ)', content: project.spec, required: true },
            { label: 'Целевой стек', content: project.stack, required: true },
            { label: 'Карта стартового шаблона (repo_map)', content: repoMap },
          ],
          schema: PlanSchema,
          schemaHint: '{stack, files_tree: string[], tasks: [{key, title, dod}], commands: {install, build, test}}',
          abortSignal: signal,
        });

        if (signal.aborted) break;

        appendAgentEvent({
          projectId,
          iteration: project.iteration,
          stage: 'PLAN',
          agentRole: 'architect',
          model: planResult.model,
          summary: `Сформирован план из ${planResult.data.tasks.length} задач (${planResult.data.files_tree.length} файлов)`,
          payload: planResult.data,
          promptTokens: planResult.promptTokens,
          completionTokens: planResult.completionTokens,
          costRub: planResult.costRub,
        });

        project = updateProject(projectId, {
          plan_json: JSON.stringify(planResult.data),
          stage: 'CODE',
        });
        continue;
      }

      if (project.stage === 'CODE') {
        if (!this.checkBudgetOrStop(projectId)) return;

        const repoMap = buildRepoMap(projectDir);
        const planText = project.plan_json ?? '{}';
        const templateContextFiles = this.collectKeyFilesContent(projectDir, project.stack);

        const sections: Array<{ label: string; content: string; required?: boolean }> = [
          { label: 'Техническое задание (ТЗ)', content: project.spec, required: true },
          { label: 'План Архитектора (Plan JSON)', content: planText, required: true },
        ];

        if (project.refine_instruction) {
          sections.push({
            label: 'Инструкция доработки от пользователя',
            content: project.refine_instruction,
            required: true,
          });
        }

        sections.push({ label: 'Карта репозитория (repo_map)', content: repoMap });
        if (templateContextFiles) {
          sections.push({ label: 'Ключевые текущие файлы шаблона', content: templateContextFiles });
        }

        const codeResult = await callAgentStructured({
          projectId,
          role: 'coder',
          systemPrompt: prompts.coder,
          contextSections: sections,
          schema: FilePatchSchema,
          schemaHint: '{summary, files: [{path, action: "create"|"update"|"delete", content?}], tasks_completed: string[]}',
          abortSignal: signal,
        });

        if (signal.aborted) break;

        const touchedFiles = applyFilePatchToWorkspace(projectDir, codeResult.data);
        await commitAll(projectDir, `feat(iter-${project.iteration}): ${codeResult.data.summary.slice(0, 72)}`);

        appendAgentEvent({
          projectId,
          iteration: project.iteration,
          stage: 'CODE',
          agentRole: 'coder',
          model: codeResult.model,
          summary: `${codeResult.data.summary} (файлов: ${touchedFiles.length})`,
          payload: {
            summary: codeResult.data.summary,
            files: codeResult.data.files.map((f) => ({ path: f.path, action: f.action })),
            tasks_completed: codeResult.data.tasks_completed,
          },
          promptTokens: codeResult.promptTokens,
          completionTokens: codeResult.completionTokens,
          costRub: codeResult.costRub,
        });

        pendingFiles = touchedFiles;
        project = updateProject(projectId, {
          stage: 'INSTALL',
          refine_instruction: null,
        });
        continue;
      }

      if (project.stage === 'INSTALL') {
        const currentHash = computeDependencyManifestHash(projectDir, project.stack);
        const canSkipInstall =
          project.last_install_hash === currentHash &&
          hasInstalledArtifacts(projectDir, project.stack);

        if (canSkipInstall) {
          appendAgentEvent({
            projectId,
            iteration: project.iteration,
            stage: 'INSTALL',
            agentRole: 'system',
            model: 'runner',
            summary: 'Зависимости не изменились — шаг установки пропущен (кэш актуален)',
            payload: { skipped: true, hash: currentHash },
          });
          project = updateProject(projectId, { stage: 'BUILD' });
          continue;
        }

        const installRes = await runInstallStage({
          projectId,
          projectDir,
          stack: project.stack,
          abortSignal: signal,
        });

        if (signal.aborted || installRes.cancelled) break;
        saveCommandRun(projectId, project.iteration, 'INSTALL', installRes);

        if (installRes.exitCode !== 0) {
          const tail = truncateTailBytes(`${installRes.stdout}\n${installRes.stderr}`.trim(), LLM_TAIL_MAX_BYTES);
          const errHash = computeErrorHash(tail, pendingFiles);
          recordStackError({
            projectId,
            stack: project.stack,
            stage: 'INSTALL',
            errorHash: errHash,
            message: `Ошибка установки зависимостей (${installRes.commandLabel})`,
            tailOutput: tail,
          });
          const canContinue = this.registerErrorAndCheckStop(projectId, errHash, tail);
          if (!canContinue) return;
          pendingErrorTail = tail;
          project = updateProject(projectId, { stage: 'FIX' });
          continue;
        }

        appendAgentEvent({
          projectId,
          iteration: project.iteration,
          stage: 'INSTALL',
          agentRole: 'system',
          model: 'runner',
          summary: `Зависимости установлены за ${(installRes.durationMs / 1000).toFixed(1)} с`,
          payload: { command: installRes.commandLabel, durationMs: installRes.durationMs },
        });

        project = updateProject(projectId, {
          last_install_hash: currentHash,
          stage: 'BUILD',
        });
        continue;
      }

      if (project.stage === 'BUILD') {
        const buildRuns = await runBuildStage({
          projectId,
          projectDir,
          stack: project.stack,
          abortSignal: signal,
        });

        if (signal.aborted) break;
        for (const run of buildRuns) {
          saveCommandRun(projectId, project.iteration, 'BUILD', run);
          if (run.cancelled) return;
        }

        const lastRun = buildRuns[buildRuns.length - 1];
        if (!lastRun || lastRun.exitCode !== 0) {
          const tail = truncateTailBytes(
            `${lastRun?.stdout ?? ''}\n${lastRun?.stderr ?? ''}`.trim(),
            LLM_TAIL_MAX_BYTES
          );
          const errHash = computeErrorHash(tail, pendingFiles);
          recordStackError({
            projectId,
            stack: project.stack,
            stage: 'BUILD',
            errorHash: errHash,
            message: `Ошибка сборки/проверки типов (${lastRun?.commandLabel ?? 'build'})`,
            tailOutput: tail,
          });
          const canContinue = this.registerErrorAndCheckStop(projectId, errHash, tail);
          if (!canContinue) return;
          pendingErrorTail = tail;
          project = updateProject(projectId, { stage: 'FIX' });
          continue;
        }

        appendAgentEvent({
          projectId,
          iteration: project.iteration,
          stage: 'BUILD',
          agentRole: 'system',
          model: 'runner',
          summary: 'Сборка и статическая проверка прошли успешно',
          payload: { commands: buildRuns.map((r) => r.commandLabel) },
        });

        project = updateProject(projectId, { stage: 'TEST' });
        continue;
      }

      if (project.stage === 'TEST') {
        const testRuns = await runTestStage({
          projectId,
          projectDir,
          stack: project.stack,
          abortSignal: signal,
        });

        if (signal.aborted) break;
        for (const run of testRuns) {
          saveCommandRun(projectId, project.iteration, 'TEST', run);
          if (run.cancelled) return;
        }

        const lastRun = testRuns[testRuns.length - 1];
        if (!lastRun || lastRun.exitCode !== 0) {
          const tail = truncateTailBytes(
            `${lastRun?.stdout ?? ''}\n${lastRun?.stderr ?? ''}`.trim(),
            LLM_TAIL_MAX_BYTES
          );
          const errHash = computeErrorHash(tail, pendingFiles);
          recordStackError({
            projectId,
            stack: project.stack,
            stage: 'TEST',
            errorHash: errHash,
            message: `Тесты завершились с ошибкой (${lastRun?.commandLabel ?? 'test'})`,
            tailOutput: tail,
          });
          const canContinue = this.registerErrorAndCheckStop(projectId, errHash, tail);
          if (!canContinue) return;
          pendingErrorTail = tail;
          project = updateProject(projectId, { stage: 'FIX' });
          continue;
        }

        appendAgentEvent({
          projectId,
          iteration: project.iteration,
          stage: 'TEST',
          agentRole: 'system',
          model: 'runner',
          summary: 'Все тесты успешно пройдены',
          payload: { commands: testRuns.map((r) => r.commandLabel) },
        });

        const settings = getResolvedSettings();
        if (project.skip_review === 1 || settings.skipReview) {
          appendAgentEvent({
            projectId,
            iteration: project.iteration,
            stage: 'REVIEW',
            agentRole: 'system',
            model: 'orchestrator',
            summary: 'Ревью пропущено согласно настройке SKIP_REVIEW',
            payload: { skipped: true },
          });
          updateProject(projectId, { status: 'done', stage: 'DONE', last_error: null });
          return;
        }

        project = updateProject(projectId, { stage: 'REVIEW' });
        continue;
      }

      if (project.stage === 'REVIEW') {
        if (!this.checkBudgetOrStop(projectId)) return;

        const diffText = await getLatestDiff(projectDir);
        const reviewResult = await callAgentStructured({
          projectId,
          role: 'reviewer',
          systemPrompt: prompts.reviewer,
          contextSections: [
            { label: 'Техническое задание (ТЗ)', content: project.spec, required: true },
            { label: 'Изменения кода (git diff)', content: diffText || '(изменения отсутствуют)', required: true },
          ],
          schema: ReviewSchema,
          schemaHint: '{verdict: "approve"|"changes_requested", findings: [{severity: "blocker"|"major"|"minor", file, problem, fix_instruction}]}',
          abortSignal: signal,
        });

        if (signal.aborted) break;

        const blockers = reviewResult.data.findings.filter((f) => f.severity === 'blocker');
        const approved = reviewResult.data.verdict === 'approve' || blockers.length === 0;

        appendAgentEvent({
          projectId,
          iteration: project.iteration,
          stage: 'REVIEW',
          agentRole: 'reviewer',
          model: reviewResult.model,
          summary: approved
            ? `Ревью пройдено (замечаний: ${reviewResult.data.findings.length}, блокеров: 0)`
            : `Ревью выявило блокеры (${blockers.length})`,
          payload: reviewResult.data,
          promptTokens: reviewResult.promptTokens,
          completionTokens: reviewResult.completionTokens,
          costRub: reviewResult.costRub,
        });

        project = updateProject(projectId, {
          review_json: JSON.stringify(reviewResult.data),
        });

        if (approved) {
          updateProject(projectId, { status: 'done', stage: 'DONE', last_error: null });
          return;
        }

        // Есть блокеры ревью -> формируем Debug-инструкцию и переходим к FIX
        const reviewTail = blockers
          .map((b) => `[${b.file}] ${b.problem} -> ${b.fix_instruction}`)
          .join('\n');
        const errHash = computeErrorHash(reviewTail, blockers.map((b) => b.file));
        const canContinue = this.registerErrorAndCheckStop(projectId, errHash, reviewTail);
        if (!canContinue) return;

        pendingDebug = {
          root_cause: 'Ревьюер обнаружил критические замечания (blocker)',
          fix_instructions: blockers.map((b) => ({
            file: b.file,
            change: `${b.problem}. Исправление: ${b.fix_instruction}`,
          })),
        };
        pendingErrorTail = reviewTail;
        pendingFiles = blockers.map((b) => b.file);
        project = updateProject(projectId, { stage: 'FIX' });
        continue;
      }

      if (project.stage === 'FIX') {
        if (project.iteration >= project.max_iterations) {
          const msg = `Достигнут предел итераций исправлений (${project.max_iterations})`;
          updateProject(projectId, { status: 'failed', last_error: msg });
          appendAgentEvent({
            projectId,
            iteration: project.iteration,
            stage: 'FIX',
            agentRole: 'system',
            model: 'orchestrator',
            summary: msg,
            payload: { maxIterations: project.max_iterations },
          });
          return;
        }

        if (!this.checkBudgetOrStop(projectId)) return;

        const repoMap = buildRepoMap(projectDir);
        const errorText = pendingErrorTail || project.last_error || 'Неизвестная ошибка сборки/тестов';

        // 1. Сначала Архитектор ставит диагноз (Debug JSON), если это не блокеры ревью
        let debugData: DebugOutput;
        if (pendingDebug) {
          debugData = pendingDebug;
          pendingDebug = null;
        } else {
          const debugResult = await callAgentStructured({
            projectId,
            role: 'architect',
            systemPrompt: prompts.architect,
            contextSections: [
              { label: 'Хвост лога ошибки (≤8 КБ)', content: errorText, required: true },
              { label: 'Карта репозитория (repo_map)', content: repoMap },
              {
                label: 'Содержимое затронутых файлов',
                content: this.readMultipleSafe(projectDir, pendingFiles),
              },
            ],
            schema: DebugSchema,
            schemaHint: '{root_cause: string, fix_instructions: [{file: string, change: string}]}',
            abortSignal: signal,
          });

          if (signal.aborted) break;
          debugData = debugResult.data;

          appendAgentEvent({
            projectId,
            iteration: project.iteration,
            stage: 'FIX',
            agentRole: 'architect',
            model: debugResult.model,
            summary: `Диагноз: ${debugData.root_cause.slice(0, 120)}`,
            payload: debugData,
            promptTokens: debugResult.promptTokens,
            completionTokens: debugResult.completionTokens,
            costRub: debugResult.costRub,
          });
        }

        if (!this.checkBudgetOrStop(projectId)) return;

        // 2. Затем Кодер применяет точечный FilePatch
        const targetFiles = [...new Set([...pendingFiles, ...debugData.fix_instructions.map((f) => f.file)])];
        const fixPatchResult = await callAgentStructured({
          projectId,
          role: 'coder',
          systemPrompt: prompts.coder,
          contextSections: [
            { label: 'ТЗ проекта', content: project.spec, required: true },
            { label: 'Инструкция отладки (Debug JSON)', content: JSON.stringify(debugData, null, 2), required: true },
            { label: 'Хвост ошибки', content: errorText },
            { label: 'Текущие файлы для исправления', content: this.readMultipleSafe(projectDir, targetFiles) },
          ],
          schema: FilePatchSchema,
          schemaHint: '{summary, files: [{path, action: "create"|"update"|"delete", content?}], tasks_completed: string[]}',
          abortSignal: signal,
        });

        if (signal.aborted) break;

        const touched = applyFilePatchToWorkspace(projectDir, fixPatchResult.data);
        const nextIter = project.iteration + 1;
        await commitAll(projectDir, `fix(iter-${nextIter}): ${fixPatchResult.data.summary.slice(0, 72)}`);

        appendAgentEvent({
          projectId,
          iteration: nextIter,
          stage: 'FIX',
          agentRole: 'coder',
          model: fixPatchResult.model,
          summary: `Исправление (итерация ${nextIter}/${project.max_iterations}): ${fixPatchResult.data.summary}`,
          payload: {
            summary: fixPatchResult.data.summary,
            files: fixPatchResult.data.files.map((f) => ({ path: f.path, action: f.action })),
          },
          promptTokens: fixPatchResult.promptTokens,
          completionTokens: fixPatchResult.completionTokens,
          costRub: fixPatchResult.costRub,
        });

        pendingFiles = touched;
        pendingErrorTail = '';
        project = updateProject(projectId, {
          iteration: nextIter,
          stage: 'INSTALL',
        });
        continue;
      }

      if (project.stage === 'DONE') {
        updateProject(projectId, { status: 'done' });
        return;
      }
    }

    // Если вышли из цикла по сигналу отмены
    if (signal.aborted) {
      updateProject(projectId, { status: 'cancelled', last_error: 'Отменено пользователем' });
    }
  }

  private registerErrorAndCheckStop(projectId: string, errHash: string, errorTail: string): boolean {
    const project = getProjectById(projectId);
    const sameRepeat = project.last_error_hash === errHash ? project.repeat_error_count + 1 : 1;

    updateProject(projectId, {
      last_error: errorTail.slice(0, 1200),
      last_error_hash: errHash,
      repeat_error_count: sameRepeat,
    });

    if (sameRepeat >= 2) {
      const msg = `Остановка конвейера: одинаковая ошибка повторилась ${sameRepeat} раза подряд (хэш ${errHash})`;
      updateProject(projectId, { status: 'failed', last_error: msg });
      appendAgentEvent({
        projectId,
        iteration: project.iteration,
        stage: project.stage,
        agentRole: 'system',
        model: 'orchestrator',
        summary: msg,
        payload: { errorHash: errHash, repeatCount: sameRepeat },
      });
      return false;
    }

    if (project.iteration >= project.max_iterations) {
      const msg = `Достигнут лимит итераций (${project.max_iterations})`;
      updateProject(projectId, { status: 'failed', last_error: msg });
      appendAgentEvent({
        projectId,
        iteration: project.iteration,
        stage: project.stage,
        agentRole: 'system',
        model: 'orchestrator',
        summary: msg,
        payload: { maxIterations: project.max_iterations },
      });
      return false;
    }

    return true;
  }

  private collectKeyFilesContent(projectDir: string, stack: StackType): string {
    const candidates =
      stack === 'ts-web'
        ? ['package.json', 'tsconfig.json', 'index.html', 'src/App.tsx']
        : stack === 'node-api'
          ? ['package.json', 'tsconfig.json', 'src/app.ts', 'src/server.ts']
          : stack === 'python'
            ? ['requirements.txt', 'pyproject.toml', 'app/main.py']
            : ['build.gradle.kts', 'gradle.properties', 'src/main/kotlin/com/app/Main.kt'];

    return this.readMultipleSafe(projectDir, candidates);
  }

  private readMultipleSafe(projectDir: string, relPaths: string[]): string {
    const parts: string[] = [];
    for (const rel of relPaths.slice(0, 10)) {
      try {
        const content = readProjectFile(projectDir, rel);
        parts.push(`--- ${rel} ---\n${content.slice(0, 8000)}`);
      } catch {
        // Файл может отсутствовать или быть удалённым
      }
    }
    return parts.join('\n\n');
  }
}

export const pipeline = new PipelineOrchestrator();
