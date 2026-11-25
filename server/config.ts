import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';

dotenv.config();

const inMemoryJwtSecret = crypto.randomBytes(32).toString('hex');
const inMemoryMasterKey = crypto.randomBytes(32).toString('hex');

export interface AppConfig {
  port: number;
  appMode: 'local' | 'public';
  runnerMode: 'docker' | 'process';
  runnerInstallUrl: string;
  runnerExecUrl: string;
  dataDir: string;
  workDir: string;
  templatesDir: string;
  jwtSecret: string;
  masterKey: string;
  hasEnvMasterKey: boolean;
  adminUsername: string;
  adminPassword: string;
  adminPasswordHash: string;
  envLlmBaseUrl: string;
  envLlmApiKey: string;
  envCoderModel: string;
  envArchitectModel: string;
  envReviewerModel: string;
  defaultProjectBudgetRub: number;
  dailyBudgetRub: number;
  skipReview: boolean;
  allowCoderFallback: boolean;
}

export function loadConfig(): AppConfig {
  const cwd = process.cwd();
  const dataDir = path.resolve(cwd, process.env.DATA_DIR || './data');
  const workDir = path.resolve(cwd, process.env.WORK_DIR || './work');
  const templatesDir = path.resolve(cwd, process.env.TEMPLATES_DIR || './templates');

  fs.mkdirSync(dataDir, { recursive: true });
  fs.mkdirSync(workDir, { recursive: true });

  const envMasterKey = (process.env.MASTER_KEY || '').trim();
  const envJwtSecret = (process.env.JWT_SECRET || '').trim();

  return {
    port: Number(process.env.PORT || 3000),
    appMode: process.env.APP_MODE === 'public' ? 'public' : 'local',
    runnerMode: process.env.RUNNER_MODE === 'docker' ? 'docker' : 'process',
    runnerInstallUrl: (process.env.RUNNER_INSTALL_URL || 'http://runner-install:4001').replace(/\/+$/, ''),
    runnerExecUrl: (process.env.RUNNER_EXEC_URL || 'http://runner-exec:4002').replace(/\/+$/, ''),
    dataDir,
    workDir,
    templatesDir,
    jwtSecret: envJwtSecret || inMemoryJwtSecret,
    masterKey: envMasterKey || inMemoryMasterKey,
    hasEnvMasterKey: envMasterKey.length > 0,
    adminUsername: (process.env.ADMIN_USERNAME || 'admin').trim(),
    adminPassword: process.env.ADMIN_PASSWORD || '',
    adminPasswordHash: (process.env.ADMIN_PASSWORD_HASH || '').trim(),
    envLlmBaseUrl: (process.env.LLM_BASE_URL || '').trim(),
    envLlmApiKey: (process.env.LLM_API_KEY || '').trim(),
    envCoderModel: (process.env.CODER_MODEL || '').trim(),
    envArchitectModel: (process.env.ARCHITECT_MODEL || '').trim(),
    envReviewerModel: (process.env.REVIEWER_MODEL || '').trim(),
    defaultProjectBudgetRub: Math.max(1, Number(process.env.DEFAULT_PROJECT_BUDGET_RUB || 50)),
    dailyBudgetRub: Math.max(1, Number(process.env.DAILY_BUDGET_RUB || 300)),
    skipReview: process.env.SKIP_REVIEW === 'true',
    allowCoderFallback: process.env.ALLOW_CODER_FALLBACK === 'true',
  };
}

export const config = loadConfig();
