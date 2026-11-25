import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express, { type NextFunction, type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import helmet from 'helmet';
import JSZip from 'jszip';
import {
  ClaimAdminInputSchema,
  CreateProjectInputSchema,
  LoginInputSchema,
  PingLlmInputSchema,
  RefineProjectInputSchema,
  StackSchema,
  UpdateSettingsInputSchema,
  type AgentRole,
} from './shared/contracts';
import { maskSecret } from './shared/pricing';
import {
  claimInitialAdmin,
  createWsTicket,
  getAuthStatus,
  requireAuth,
  verifyAdminCredentials,
  type AuthenticatedRequest,
} from './server/auth';
import { config } from './server/config';
import { redactSecretsInText } from './server/crypto';
import {
  db,
  getAgentSeeds,
  getDailySpentRub,
  getResolvedSettings,
  recoverStalledRunningProjects,
  saveEncryptedApiKey,
  setSetting,
  updateAgentPrompt,
  type AgentEventRecord,
  type CommandRunRecord,
  type ProjectRecord,
  type StackErrorLogRecord,
} from './server/db';
import { getLatestDiff, listProjectFiles, readProjectFile } from './server/gitHelper';
import { listAvailableModels, pingLlmGateway } from './server/llm';
import { initializeProjectWorkspace, pipeline } from './server/pipeline';
import { cancelAllLocalRuns } from './server/runner';
import { systemMonitor } from './server/systemMonitor';
import { wsHub } from './server/ws';

const isProduction = process.env.NODE_ENV === 'production';

async function bootstrap(): Promise<void> {
  const recovered = recoverStalledRunningProjects();
  if (recovered > 0) {
    console.log(`[db] Переведено в паузу незавершённых проектов после рестарта: ${recovered}`);
  }

  const app = express();
  app.set('trust proxy', 1);

  // Безопасность заголовков (CSP + frameguard отключён для совместимости с превью-iframe)
  app.use(
    helmet({
      frameguard: false,
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: isProduction ? ["'self'"] : ["'self'", "'unsafe-inline'", "'unsafe-eval'"],
          styleSrc: ["'self'", "'unsafe-inline'", 'https://fonts.googleapis.com'],
          fontSrc: ["'self'", 'https://fonts.gstatic.com', 'data:'],
          imgSrc: ["'self'", 'data:', 'blob:'],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          frameAncestors: ["'self'", 'https:', 'http:'],
        },
      },
    })
  );

  app.use(express.json({ limit: '512kb' }));

  // Ограничение частоты запросов: 60 req/min на /api/*
  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    max: 60,
    standardHeaders: true,
    legacyHeaders: false,
    message: { error: 'Превышен лимит запросов (60 в минуту). Повторите чуть позже.' },
  });
  app.use('/api', apiLimiter);

  // Публичный healthcheck
  app.get('/api/health', (_req, res) => {
    res.json({
      ok: true,
      appMode: config.appMode,
      runnerMode: config.runnerMode,
      uptimeSeconds: Math.floor(process.uptime()),
    });
  });

  // --- Авторизация ---
  app.get('/api/auth/status', (_req, res) => {
    res.json(getAuthStatus());
  });

  app.post('/api/auth/claim', async (req, res) => {
    const parsed = ClaimAdminInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные данные' });
      return;
    }
    try {
      const token = await claimInitialAdmin(parsed.data.username, parsed.data.password);
      res.json({ token, username: parsed.data.username });
    } catch (err) {
      res.status(409).json({ error: err instanceof Error ? err.message : 'Ошибка инициализации' });
    }
  });

  app.post('/api/auth/login', async (req, res) => {
    const parsed = LoginInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Укажите логин и пароль' });
      return;
    }
    try {
      const token = await verifyAdminCredentials(parsed.data.username, parsed.data.password);
      if (!token) {
        res.status(401).json({ error: 'Неверный логин или пароль' });
        return;
      }
      res.json({ token, username: parsed.data.username });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Ошибка входа' });
    }
  });

  // --- Защищённые маршруты ---
  app.post('/api/auth/ws-ticket', requireAuth, (req: AuthenticatedRequest, res) => {
    const ticket = createWsTicket(req.user?.sub ?? 'admin');
    res.json({ ticket });
  });

  app.get('/api/system/metrics', requireAuth, (_req, res) => {
    res.json(systemMonitor.getSnapshot());
  });

  app.get('/api/logs/errors', requireAuth, (req, res) => {
    const stackParam = typeof req.query.stack === 'string' ? req.query.stack : '';
    const limit = Math.min(100, Math.max(1, Number(req.query.limit ?? 50)));

    let rows: StackErrorLogRecord[];
    if (stackParam && StackSchema.safeParse(stackParam).success) {
      rows = db
        .prepare(`SELECT * FROM stack_error_logs WHERE stack = ? ORDER BY id DESC LIMIT ?`)
        .all(stackParam, limit) as StackErrorLogRecord[];
    } else {
      rows = db
        .prepare(`SELECT * FROM stack_error_logs ORDER BY id DESC LIMIT ?`)
        .all(limit) as StackErrorLogRecord[];
    }
    res.json({ logs: rows });
  });

  // --- LLM шлюз ---
  app.get('/api/llm/models', requireAuth, async (_req, res) => {
    try {
      const models = await listAvailableModels();
      res.json({ models });
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Ошибка получения моделей' });
    }
  });

  app.post('/api/llm/ping', requireAuth, async (req, res) => {
    const parsed = PingLlmInputSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({ error: 'Некорректные параметры проверки' });
      return;
    }
    try {
      const result = await pingLlmGateway(parsed.data.model);
      res.json(result);
    } catch (err) {
      res.status(502).json({ error: err instanceof Error ? err.message : 'Шлюз LLM недоступен' });
    }
  });

  // --- Настройки ---
  app.get('/api/settings', requireAuth, (_req, res) => {
    const settings = getResolvedSettings();
    const seeds = getAgentSeeds();
    res.json({
      llm_base_url: settings.llmBaseUrl,
      has_api_key: settings.hasApiKey,
      masked_api_key: maskSecret(settings.llmApiKey),
      api_key_source: settings.apiKeySource,
      has_env_master_key: config.hasEnvMasterKey,
      coder_model: settings.coderModel,
      architect_model: settings.architectModel,
      reviewer_model: settings.reviewerModel,
      default_project_budget_rub: settings.defaultProjectBudgetRub,
      daily_budget_rub: settings.dailyBudgetRub,
      daily_spent_rub: getDailySpentRub(),
      skip_review: settings.skipReview,
      allow_coder_fallback: settings.allowCoderFallback,
      context_window_tokens: settings.contextWindowTokens,
      pricing: settings.pricing,
      agents: seeds,
    });
  });

  app.put('/api/settings', requireAuth, (req, res) => {
    const parsed = UpdateSettingsInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные настройки' });
      return;
    }

    const d = parsed.data;
    if (d.llm_base_url !== undefined) setSetting('llm_base_url', d.llm_base_url);
    if (d.llm_api_key !== undefined && d.llm_api_key.trim().length > 0) {
      saveEncryptedApiKey(d.llm_api_key);
    }
    if (d.coder_model !== undefined) setSetting('coder_model', d.coder_model);
    if (d.architect_model !== undefined) setSetting('architect_model', d.architect_model);
    if (d.reviewer_model !== undefined) setSetting('reviewer_model', d.reviewer_model);
    if (d.default_project_budget_rub !== undefined) {
      setSetting('default_project_budget_rub', String(d.default_project_budget_rub));
    }
    if (d.daily_budget_rub !== undefined) {
      setSetting('daily_budget_rub', String(d.daily_budget_rub));
    }
    if (d.skip_review !== undefined) setSetting('skip_review', String(d.skip_review));
    if (d.allow_coder_fallback !== undefined) {
      setSetting('allow_coder_fallback', String(d.allow_coder_fallback));
    }
    if (d.context_window_tokens !== undefined) {
      setSetting('context_window_tokens', String(d.context_window_tokens));
    }
    if (d.pricing !== undefined) {
      setSetting('pricing_json', JSON.stringify(d.pricing));
    }
    if (d.agent_prompts !== undefined) {
      for (const role of ['architect', 'coder', 'reviewer'] as AgentRole[]) {
        const prompt = d.agent_prompts[role];
        if (prompt) updateAgentPrompt(role, prompt);
      }
    }

    wsHub.broadcastAll({ type: 'system:metrics', data: systemMonitor.getSnapshot() });
    res.json({ ok: true });
  });

  // --- Проекты ---
  app.get('/api/projects', requireAuth, (_req, res) => {
    const rows = db
      .prepare(`SELECT * FROM projects ORDER BY updated_at DESC`)
      .all() as ProjectRecord[];
    res.json({ projects: rows });
  });

  app.post('/api/projects', requireAuth, async (req, res) => {
    const parsed = CreateProjectInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Некорректные данные проекта' });
      return;
    }

    const snap = systemMonitor.getSnapshot();
    if (parsed.data.stack === 'kotlin' && !snap.kotlinSupported) {
      res.status(400).json({
        error: snap.kotlinDisabledReason ?? 'Стек Kotlin недоступен при объёме ОЗУ < 3 ГБ',
      });
      return;
    }

    const id = `proj_${crypto.randomBytes(5).toString('hex')}`;
    const now = new Date().toISOString();

    try {
      await initializeProjectWorkspace(id, parsed.data.stack);
      db.prepare(
        `INSERT INTO projects (
          id, name, spec, stack, status, stage, iteration, max_iterations,
          budget_rub, spent_rub, skip_review, created_at, updated_at
        ) VALUES (?, ?, ?, ?, 'queued', 'PLAN', 0, 3, ?, 0, ?, ?, ?)`
      ).run(
        id,
        parsed.data.name,
        parsed.data.spec,
        parsed.data.stack,
        parsed.data.budget_rub,
        parsed.data.skip_review ? 1 : 0,
        now,
        now
      );

      const created = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as ProjectRecord;
      wsHub.broadcastAll({ type: 'projects:list_updated', projectId: id });
      pipeline.enqueue(id);
      res.status(201).json({ project: created });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Ошибка создания проекта' });
    }
  });

  app.get('/api/projects/:id', requireAuth, async (req, res) => {
    const id = String(req.params.id || '');
    const project = db.prepare(`SELECT * FROM projects WHERE id = ?`).get(id) as
      | ProjectRecord
      | undefined;

    if (!project) {
      res.status(404).json({ error: 'Проект не найден' });
      return;
    }

    const events = db
      .prepare(`SELECT * FROM agent_events WHERE project_id = ? ORDER BY id ASC`)
      .all(id) as AgentEventRecord[];
    const commandRuns = db
      .prepare(`SELECT * FROM command_runs WHERE project_id = ? ORDER BY created_at ASC`)
      .all(id) as CommandRunRecord[];
    const stackErrors = db
      .prepare(`SELECT * FROM stack_error_logs WHERE project_id = ? ORDER BY id DESC LIMIT 30`)
      .all(id) as StackErrorLogRecord[];

    const projectDir = path.resolve(config.workDir, id);
    const files = listProjectFiles(projectDir);
    const diff = await getLatestDiff(projectDir);

    res.json({
      project,
      events,
      commandRuns,
      stackErrors,
      files,
      diff,
    });
  });

  app.get('/api/projects/:id/file', requireAuth, (req, res) => {
    const id = String(req.params.id || '');
    const relPath = typeof req.query.path === 'string' ? req.query.path : '';
    const projectDir = path.resolve(config.workDir, id);

    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Каталог проекта не найден' });
      return;
    }

    try {
      const content = readProjectFile(projectDir, relPath);
      res.json({ path: relPath, content });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка чтения файла' });
    }
  });

  app.post('/api/projects/:id/cancel', requireAuth, (req, res) => {
    const id = String(req.params.id || '');
    try {
      const cancelled = pipeline.cancel(id);
      res.json({ cancelled });
    } catch (err) {
      res.status(404).json({ error: err instanceof Error ? err.message : 'Проект не найден' });
    }
  });

  app.post('/api/projects/:id/resume', requireAuth, (req, res) => {
    const id = String(req.params.id || '');
    try {
      pipeline.resume(id);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Не удалось продолжить' });
    }
  });

  app.post('/api/projects/:id/refine', requireAuth, (req, res) => {
    const id = String(req.params.id || '');
    const parsed = RefineProjectInputSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.issues[0]?.message ?? 'Укажите инструкцию доработки' });
      return;
    }
    try {
      pipeline.refine(id, parsed.data.instruction);
      res.json({ ok: true });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : 'Ошибка запуска доработки' });
    }
  });

  app.get('/api/projects/:id/zip', requireAuth, async (req, res) => {
    const id = String(req.params.id || '');
    const project = db.prepare(`SELECT id, name FROM projects WHERE id = ?`).get(id) as
      | { id: string; name: string }
      | undefined;

    if (!project) {
      res.status(404).json({ error: 'Проект не найден' });
      return;
    }

    const projectDir = path.resolve(config.workDir, id);
    if (!fs.existsSync(projectDir)) {
      res.status(404).json({ error: 'Файлы проекта отсутствуют' });
      return;
    }

    try {
      const zip = new JSZip();
      const files = listProjectFiles(projectDir);
      for (const file of files) {
        const content = readProjectFile(projectDir, file.path);
        zip.file(file.path, content);
      }
      const buffer = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
      const safeName = project.id.replace(/[^a-zA-Z0-9_-]/g, '_');
      res.setHeader('Content-Type', 'application/zip');
      res.setHeader('Content-Disposition', `attachment; filename="${safeName}.zip"`);
      res.send(buffer);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Ошибка сборки ZIP-архива' });
    }
  });

  app.delete('/api/projects/:id', requireAuth, (req, res) => {
    const id = String(req.params.id || '');
    try {
      pipeline.cancel(id);
    } catch {
      // Может не существовать
    }
    const info = db.prepare(`DELETE FROM projects WHERE id = ?`).run(id);
    const projectDir = path.resolve(config.workDir, id);
    if (projectDir.startsWith(path.resolve(config.workDir) + path.sep) && fs.existsSync(projectDir)) {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
    wsHub.broadcastAll({ type: 'projects:list_updated', projectId: id });
    res.json({ deleted: info.changes > 0 });
  });

  // Глобальный обработчик ошибок API с маскировкой секретов
  app.use('/api', (err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const settings = getResolvedSettings();
    const rawMsg = err instanceof Error ? err.message : 'Внутренняя ошибка сервера';
    const safeMsg = redactSecretsInText(rawMsg, [settings.llmApiKey, config.jwtSecret, config.masterKey]);
    res.status(500).json({ error: safeMsg });
  });

  // Vite dev middleware или раздача статики dist/
  if (!isProduction) {
    const { createServer: createViteServer } = await import('vite');
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distDir, 'index.html'));
    });
  }

  const httpServer = http.createServer(app);
  wsHub.attach(httpServer);

  const shutdown = () => {
    cancelAllLocalRuns();
    systemMonitor.stop();
    db.close();
    httpServer.close(() => {
      process.exit(0);
    });
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);

  httpServer.listen(config.port, '0.0.0.0', () => {
    console.log(
      `[server] Запущено на http://0.0.0.0:${config.port} | APP_MODE=${config.appMode} | RUNNER_MODE=${config.runnerMode}`
    );
  });
}

bootstrap().catch((err) => {
  console.error('[server] Критическая ошибка запуска:', err);
  process.exit(1);
});
