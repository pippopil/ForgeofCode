import type {
  AgentRole,
  PipelineStage,
  PlanOutput,
  ProjectStatus,
  ReviewOutput,
  StackType,
  SystemMetricsSnapshot,
} from '../shared/contracts';
import type { PricingMap } from '../shared/pricing';

export type {
  AgentRole,
  PipelineStage,
  PlanOutput,
  ProjectStatus,
  ReviewOutput,
  StackType,
  SystemMetricsSnapshot,
  PricingMap,
};

export interface AuthStatusResponse {
  needsSetup: boolean;
  username: string;
  source: 'env_hash' | 'env_plain' | 'db' | 'unclaimed';
}

export interface ProjectDTO {
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

export interface AgentEventDTO {
  id: number;
  project_id: string;
  iteration: number;
  stage: string;
  agent_role: AgentRole | 'system';
  model: string;
  summary: string;
  payload_json: string;
  prompt_tokens: number;
  completion_tokens: number;
  cost_rub: number;
  created_at: string;
}

export interface CommandRunDTO {
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

export interface StackErrorLogDTO {
  id: number;
  project_id: string;
  stack: StackType;
  stage: string;
  error_hash: string;
  message: string;
  tail_output: string;
  created_at: string;
}

export interface ProjectFileDTO {
  path: string;
  size: number;
}

export interface ProjectDetailResponse {
  project: ProjectDTO;
  events: AgentEventDTO[];
  commandRuns: CommandRunDTO[];
  stackErrors: StackErrorLogDTO[];
  files: ProjectFileDTO[];
  diff: string;
}

export interface AgentSeedDTO {
  role: AgentRole;
  name: string;
  system_prompt: string;
  updated_at: string;
}

export interface SettingsResponse {
  llm_base_url: string;
  has_api_key: boolean;
  masked_api_key: string;
  api_key_source: 'env' | 'db' | 'none';
  has_env_master_key: boolean;
  coder_model: string;
  architect_model: string;
  reviewer_model: string;
  default_project_budget_rub: number;
  daily_budget_rub: number;
  daily_spent_rub: number;
  skip_review: boolean;
  allow_coder_fallback: boolean;
  context_window_tokens: number;
  pricing: PricingMap;
  agents: AgentSeedDTO[];
}

export const STACK_LABELS: Record<StackType, string> = {
  'ts-web': 'TypeScript Web (Vite + React)',
  'node-api': 'Node.js API (Express + TS)',
  python: 'Python (FastAPI / CLI + pytest)',
  kotlin: 'Kotlin (Gradle JVM + JUnit)',
};

export const STATUS_LABELS: Record<ProjectStatus, string> = {
  queued: 'В очереди',
  running: 'Выполняется',
  paused: 'Пауза',
  done: 'Готово',
  failed: 'Ошибка',
  cancelled: 'Отменено',
  budget_exceeded: 'Бюджет исчерпан',
};
