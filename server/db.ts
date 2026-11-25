import path from 'node:path';
import Database from 'better-sqlite3';
import { DEFAULT_PRICING, type PricingMap } from '../shared/pricing';
import type { AgentRole, PipelineStage, ProjectStatus, StackType } from '../shared/contracts';
import { config } from './config';
import { decryptSecret, encryptSecret } from './crypto';

export interface ProjectRecord {
  id: string;
  name: string;
  spec: string;
  stack: StackType;
  status: ProjectStatus;
  stage: PipelineStage;
  iteration: number;
  max_iterations: number;
  budget_rub: number;
  spent_rub: number;
  skip_review: number;
  last_error: string | null;
  last_error_hash: string | null;
  repeat_error_count: number;
  last_install_hash: string | null;
  plan_json: string | null;
  review_json: string | null;
  refine_instruction: string | null;
  created_at: string;
  updated_at: string;
}

export interface AgentEventRecord {
  id: number;
  project_id: string;
  iteration: number;
  stage: string;
  agent_role: string;
  model: string;
  summary: string;
  payload_json: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_rub: number;
  created_at: string;
}

export interface CommandRunRecord {
  id: string;
  project_id: string;
  iteration: number;
  stage: string;
  command: string;
  exit_code: number;
  timed_out: number;
  duration_ms: number;
  stdout: string;
  stderr: string;
  created_at: string;
}

export interface StackErrorLogRecord {
  id: number;
  project_id: string;
  stack: StackType;
  stage: string;
  error_hash: string;
  message: string;
  tail_output: string;
  created_at: string;
}

export interface AgentSeedRecord {
  role: AgentRole;
  name: string;
  system_prompt: string;
  updated_at: string;
}

export interface ResolvedSettings {
  llmBaseUrl: string;
  llmApiKey: string;
  hasApiKey: boolean;
  apiKeySource: 'env' | 'db' | 'none';
  coderModel: string;
  architectModel: string;
  reviewerModel: string;
  defaultProjectBudgetRub: number;
  dailyBudgetRub: number;
  skipReview: boolean;
  allowCoderFallback: boolean;
  contextWindowTokens: number;
  pricing: PricingMap;
}

export const SEED_AGENT_PROMPTS: Record<AgentRole, { name: string; prompt: string }> = {
  architect: {
    name: 'Архитектор',
    prompt:
      'Ты — Архитектор (read-only). Файлы не пишешь. При планировании верни Plan JSON в блоке ```json: стек, дерево файлов (files_tree), задачи с критерием готовности (tasks[{key,title,dod}]), команды install/build/test (commands). При отладке ошибки верни Debug JSON в блоке ```json с корневой причиной (root_cause) и точными инструкциями исправления (fix_instructions[{file,change}]). Отвечай на русском языке, строго валидным JSON без лишнего текста вне блока.',
  },
  coder: {
    name: 'Кодер',
    prompt:
      'Ты — Кодер (единственный агент, изменяющий файлы). Пиши рабочий код полными файлами, без заглушек и TODO, все зависимости добавляй в package.json/requirements.txt/build.gradle.kts, отвечай только FilePatch JSON в блоке ```json: {summary, files[{path, action: create|update|delete, content?}], tasks_completed}. Соблюдай ограничения: не более 40 файлов, до 150 КБ на файл, только UTF-8, пути строго относительные.',
  },
  reviewer: {
    name: 'Ревьюер',
    prompt:
      'Ты — Ревьюер (read-only). Файлы не пишешь. Анализируешь только git diff после успешных тестов. Верни Review JSON в блоке ```json: {verdict: "approve"|"changes_requested", findings[{severity: "blocker"|"major"|"minor", file, problem, fix_instruction}]}. Ставь blocker только за реально неработающий код, отсутствие обработки ошибок, утечки секретов или уязвимости; в остальных случаях ставь approve.',
  },
};

const dbPath = path.join(config.dataDir, 'orchestrator.db');
export const db = new Database(dbPath);

// Обязательный режим WAL для устойчивости при сбоях и конкурентном чтении
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('foreign_keys = ON');

export function initDatabase(): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS admin_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      username TEXT NOT NULL,
      password_hash TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agents (
      role TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      system_prompt TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      spec TEXT NOT NULL,
      stack TEXT NOT NULL,
      status TEXT NOT NULL,
      stage TEXT NOT NULL,
      iteration INTEGER NOT NULL DEFAULT 0,
      max_iterations INTEGER NOT NULL DEFAULT 3,
      budget_rub REAL NOT NULL,
      spent_rub REAL NOT NULL DEFAULT 0,
      skip_review INTEGER NOT NULL DEFAULT 0,
      last_error TEXT,
      last_error_hash TEXT,
      repeat_error_count INTEGER NOT NULL DEFAULT 0,
      last_install_hash TEXT,
      plan_json TEXT,
      review_json TEXT,
      refine_instruction TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS agent_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      stage TEXT NOT NULL,
      agent_role TEXT NOT NULL,
      model TEXT NOT NULL,
      summary TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0,
      completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost_rub REAL NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS command_runs (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      iteration INTEGER NOT NULL,
      stage TEXT NOT NULL,
      command TEXT NOT NULL,
      exit_code INTEGER NOT NULL,
      timed_out INTEGER NOT NULL DEFAULT 0,
      duration_ms INTEGER NOT NULL DEFAULT 0,
      stdout TEXT NOT NULL,
      stderr TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS stack_error_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      stack TEXT NOT NULL,
      stage TEXT NOT NULL,
      error_hash TEXT NOT NULL,
      message TEXT NOT NULL,
      tail_output TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS daily_usage (
      day TEXT PRIMARY KEY,
      spent_rub REAL NOT NULL DEFAULT 0,
      tokens_total INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_events_project ON agent_events(project_id, id);
    CREATE INDEX IF NOT EXISTS idx_runs_project ON command_runs(project_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_stack_errors_stack ON stack_error_logs(stack, id DESC);
  `);

  const now = new Date().toISOString();
  const insertAgent = db.prepare(`
    INSERT OR IGNORE INTO agents (role, name, system_prompt, updated_at)
    VALUES (?, ?, ?, ?)
  `);
  for (const role of ['architect', 'coder', 'reviewer'] as const) {
    insertAgent.run(role, SEED_AGENT_PROMPTS[role].name, SEED_AGENT_PROMPTS[role].prompt, now);
  }
}

export function recoverStalledRunningProjects(): number {
  const now = new Date().toISOString();
  const runningProjects = db
    .prepare(`SELECT id, iteration, stage FROM projects WHERE status = 'running'`)
    .all() as Array<{ id: string; iteration: number; stage: string }>;

  if (runningProjects.length === 0) return 0;

  const pauseStmt = db.prepare(`
    UPDATE projects SET status = 'paused', updated_at = ? WHERE id = ?
  `);
  const eventStmt = db.prepare(`
    INSERT INTO agent_events (project_id, iteration, stage, agent_role, model, summary, payload_json, prompt_tokens, completion_tokens, cost_rub, created_at)
    VALUES (?, ?, ?, 'system', 'orchestrator', ?, ?, 0, 0, 0, ?)
  `);

  const tx = db.transaction(() => {
    for (const proj of runningProjects) {
      pauseStmt.run(now, proj.id);
      eventStmt.run(
        proj.id,
        proj.iteration,
        proj.stage,
        'Контейнер или сервер был перезапущен: выполнение переведено в паузу',
        JSON.stringify({ reason: 'server_restart', resumable: true }),
        now
      );
    }
  });
  tx();

  return runningProjects.length;
}

export function getSetting(key: string): string | null {
  const row = db.prepare(`SELECT value FROM settings WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
  `).run(key, value, now);
}

export function getResolvedSettings(): ResolvedSettings {
  const dbBaseUrl = getSetting('llm_base_url');
  const dbEncryptedKey = getSetting('llm_api_key_enc');
  const decryptedDbKey = dbEncryptedKey ? decryptSecret(dbEncryptedKey, config.masterKey) : '';

  const llmApiKey = decryptedDbKey || config.envLlmApiKey;
  const apiKeySource: ResolvedSettings['apiKeySource'] = decryptedDbKey
    ? 'db'
    : config.envLlmApiKey
      ? 'env'
      : 'none';

  const pricingRaw = getSetting('pricing_json');
  let pricing: PricingMap = DEFAULT_PRICING;
  if (pricingRaw) {
    try {
      const parsed = JSON.parse(pricingRaw) as Partial<PricingMap>;
      pricing = {
        architect: parsed.architect ?? DEFAULT_PRICING.architect,
        coder: parsed.coder ?? DEFAULT_PRICING.coder,
        reviewer: parsed.reviewer ?? DEFAULT_PRICING.reviewer,
      };
    } catch {
      pricing = DEFAULT_PRICING;
    }
  }

  return {
    llmBaseUrl: dbBaseUrl ?? config.envLlmBaseUrl,
    llmApiKey,
    hasApiKey: llmApiKey.trim().length > 0,
    apiKeySource,
    coderModel: getSetting('coder_model') ?? config.envCoderModel,
    architectModel: getSetting('architect_model') ?? config.envArchitectModel,
    reviewerModel: getSetting('reviewer_model') ?? config.envReviewerModel,
    defaultProjectBudgetRub: Number(getSetting('default_project_budget_rub') ?? config.defaultProjectBudgetRub),
    dailyBudgetRub: Number(getSetting('daily_budget_rub') ?? config.dailyBudgetRub),
    skipReview: (getSetting('skip_review') ?? String(config.skipReview)) === 'true',
    allowCoderFallback: (getSetting('allow_coder_fallback') ?? String(config.allowCoderFallback)) === 'true',
    contextWindowTokens: Number(getSetting('context_window_tokens') ?? 64000),
    pricing,
  };
}

export function saveEncryptedApiKey(plainApiKey: string): void {
  const trimmed = plainApiKey.trim();
  if (!trimmed) {
    db.prepare(`DELETE FROM settings WHERE key = 'llm_api_key_enc'`).run();
    return;
  }
  const encrypted = encryptSecret(trimmed, config.masterKey);
  setSetting('llm_api_key_enc', encrypted);
}

export function getAgentSeeds(): AgentSeedRecord[] {
  return db.prepare(`SELECT role, name, system_prompt, updated_at FROM agents ORDER BY role`).all() as AgentSeedRecord[];
}

export function updateAgentPrompt(role: AgentRole, systemPrompt: string): void {
  db.prepare(`UPDATE agents SET system_prompt = ?, updated_at = ? WHERE role = ?`).run(
    systemPrompt,
    new Date().toISOString(),
    role
  );
}

export function getTodayDayKey(): string {
  return new Date().toISOString().slice(0, 10);
}

export function getDailySpentRub(day = getTodayDayKey()): number {
  const row = db.prepare(`SELECT spent_rub FROM daily_usage WHERE day = ?`).get(day) as
    | { spent_rub: number }
    | undefined;
  return row?.spent_rub ?? 0;
}

export function recordCostUsage(projectId: string, costRub: number, tokens: number): void {
  const day = getTodayDayKey();
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare(`UPDATE projects SET spent_rub = ROUND(spent_rub + ?, 4), updated_at = ? WHERE id = ?`).run(
      costRub,
      now,
      projectId
    );
    db.prepare(`
      INSERT INTO daily_usage (day, spent_rub, tokens_total) VALUES (?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        spent_rub = ROUND(daily_usage.spent_rub + excluded.spent_rub, 4),
        tokens_total = daily_usage.tokens_total + excluded.tokens_total
    `).run(day, costRub, tokens);
  });
  tx();
}

export function recordStackError(params: {
  projectId: string;
  stack: StackType;
  stage: string;
  errorHash: string;
  message: string;
  tailOutput: string;
}): StackErrorLogRecord {
  const now = new Date().toISOString();
  const info = db
    .prepare(
      `INSERT INTO stack_error_logs (project_id, stack, stage, error_hash, message, tail_output, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      params.projectId,
      params.stack,
      params.stage,
      params.errorHash,
      params.message,
      params.tailOutput,
      now
    );

  return db
    .prepare(`SELECT * FROM stack_error_logs WHERE id = ?`)
    .get(info.lastInsertRowid) as StackErrorLogRecord;
}

initDatabase();
