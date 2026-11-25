import { z } from 'zod';

/** Поддерживаемые технологические стеки проектов */
export const StackSchema = z.enum(['ts-web', 'node-api', 'python', 'kotlin']);
export type StackType = z.infer<typeof StackSchema>;

/** Статусы выполнения проекта в конвейере */
export const ProjectStatusSchema = z.enum([
  'queued',
  'running',
  'paused',
  'done',
  'failed',
  'cancelled',
  'budget_exceeded',
]);
export type ProjectStatus = z.infer<typeof ProjectStatusSchema>;

/** Роли ИИ-агентов */
export const AgentRoleSchema = z.enum(['architect', 'coder', 'reviewer']);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

/** Стадии детерминированного пайплайна */
export const PipelineStageSchema = z.enum([
  'PLAN',
  'CODE',
  'INSTALL',
  'BUILD',
  'TEST',
  'REVIEW',
  'FIX',
  'DONE',
]);
export type PipelineStage = z.infer<typeof PipelineStageSchema>;

/** Контракт Архитектора (планирование) */
export const PlanTaskSchema = z.object({
  key: z.string().min(1).max(40),
  title: z.string().min(1).max(200),
  dod: z.string().min(1).max(500),
});

export const PlanSchema = z.object({
  stack: StackSchema,
  files_tree: z.array(z.string().min(1).max(260)).min(1).max(120),
  tasks: z.array(PlanTaskSchema).min(1).max(30),
  commands: z.object({
    install: z.string().min(1).max(300),
    build: z.string().min(1).max(300),
    test: z.string().min(1).max(300),
  }),
});
export type PlanOutput = z.infer<typeof PlanSchema>;

/** Контракт Кодера (патч файлов) */
export const FileActionSchema = z.enum(['create', 'update', 'delete']);

export const FilePatchItemSchema = z
  .object({
    path: z.string().min(1).max(260),
    action: FileActionSchema,
    content: z.string().optional(),
  })
  .superRefine((item, ctx) => {
    if ((item.action === 'create' || item.action === 'update') && typeof item.content !== 'string') {
      ctx.addIssue({
        code: 'custom',
        message: `Поле content обязательно для действия ${item.action} (${item.path})`,
      });
    }
  });

export const FilePatchSchema = z.object({
  summary: z.string().min(1).max(2000),
  files: z.array(FilePatchItemSchema).min(1).max(40),
  tasks_completed: z.array(z.string().min(1).max(40)).max(30),
});
export type FilePatchOutput = z.infer<typeof FilePatchSchema>;

/** Контракт Ревьюера */
export const ReviewSeveritySchema = z.enum(['blocker', 'major', 'minor']);

export const ReviewFindingSchema = z.object({
  severity: ReviewSeveritySchema,
  file: z.string().min(1).max(260),
  problem: z.string().min(1).max(2000),
  fix_instruction: z.string().min(1).max(2000),
});

export const ReviewSchema = z.object({
  verdict: z.enum(['approve', 'changes_requested']),
  findings: z.array(ReviewFindingSchema).max(50),
});
export type ReviewOutput = z.infer<typeof ReviewSchema>;

/** Контракт Архитектора (отладка ошибок) */
export const DebugFixInstructionSchema = z.object({
  file: z.string().min(1).max(260),
  change: z.string().min(1).max(3000),
});

export const DebugSchema = z.object({
  root_cause: z.string().min(1).max(3000),
  fix_instructions: z.array(DebugFixInstructionSchema).min(1).max(30),
});
export type DebugOutput = z.infer<typeof DebugSchema>;

/** Входные API-схемы */
export const LoginInputSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(4).max(256),
});

export const ClaimAdminInputSchema = z.object({
  username: z.string().trim().min(1).max(64).default('admin'),
  password: z.string().min(6, 'Пароль должен быть не короче 6 символов').max(256),
});

export const CreateProjectInputSchema = z.object({
  name: z.string().trim().min(2).max(120),
  spec: z.string().trim().min(10).max(20000),
  stack: StackSchema,
  budget_rub: z.number().min(1).max(50000).default(50),
  skip_review: z.boolean().optional(),
});

export const RefineProjectInputSchema = z.object({
  instruction: z.string().trim().min(5).max(10000),
});

export const AgentPricingSchema = z.object({
  input_rub_per_1m: z.number().min(0).max(100000),
  output_rub_per_1m: z.number().min(0).max(100000),
});

export const UpdateSettingsInputSchema = z.object({
  llm_base_url: z.string().trim().max(500).optional(),
  llm_api_key: z.string().max(500).optional(),
  coder_model: z.string().trim().max(200).optional(),
  architect_model: z.string().trim().max(200).optional(),
  reviewer_model: z.string().trim().max(200).optional(),
  default_project_budget_rub: z.number().min(1).max(50000).optional(),
  daily_budget_rub: z.number().min(1).max(500000).optional(),
  skip_review: z.boolean().optional(),
  allow_coder_fallback: z.boolean().optional(),
  context_window_tokens: z.number().int().min(4096).max(2000000).optional(),
  pricing: z
    .object({
      architect: AgentPricingSchema,
      coder: AgentPricingSchema,
      reviewer: AgentPricingSchema,
    })
    .optional(),
  agent_prompts: z
    .object({
      architect: z.string().min(10).max(8000).optional(),
      coder: z.string().min(10).max(8000).optional(),
      reviewer: z.string().min(10).max(8000).optional(),
    })
    .optional(),
});

export const PingLlmInputSchema = z.object({
  model: z.string().trim().max(200).optional(),
});

/** WebSocket-сообщения от клиента к серверу */
export const WsClientMessageSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('subscribe'),
    projectId: z.string().min(1).max(80),
  }),
  z.object({
    type: z.literal('unsubscribe'),
    projectId: z.string().min(1).max(80),
  }),
  z.object({
    type: z.literal('ping'),
  }),
]);
export type WsClientMessage = z.infer<typeof WsClientMessageSchema>;

/** Системные метрики реального времени */
export interface SystemMetricsSnapshot {
  timestamp: string;
  appMode: 'local' | 'public';
  runnerMode: 'docker' | 'process';
  cpuPercent: number;
  cpuCores: number;
  ramTotalBytes: number;
  ramUsedBytes: number;
  ramFreeBytes: number;
  diskTotalBytes: number;
  diskFreeBytes: number;
  kotlinSupported: boolean;
  kotlinDisabledReason: string | null;
  activeProjectId: string | null;
  queueLength: number;
  wsClients: number;
  dailySpentRub: number;
  dailyBudgetRub: number;
  uptimeSeconds: number;
}
