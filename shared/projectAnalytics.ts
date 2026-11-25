export interface IterationCostPoint {
  iteration: number;
  label: string;
  architectRub: number;
  coderRub: number;
  reviewerRub: number;
  iterationCostRub: number;
  cumulativeRub: number;
  budgetRub: number;
  tokensTotal: number;
}

export interface CostEventInput {
  iteration: number;
  agent_role: string;
  cost_rub: number;
  prompt_tokens: number;
  completion_tokens: number;
}

export interface LogCommandRunInput {
  id: string;
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

function roundRub(value: number): number {
  return Math.round(value * 10000) / 10000;
}

/** Агрегирует расходы по итерациям для графика Recharts */
export function buildIterationBudgetSeries(
  events: CostEventInput[],
  projectIteration: number,
  budgetRub: number
): IterationCostPoint[] {
  const maxEventIter = events.reduce((max, ev) => Math.max(max, ev.iteration), 0);
  const maxIter = Math.max(0, projectIteration, maxEventIter);

  const buckets = new Map<
    number,
    { architect: number; coder: number; reviewer: number; other: number; tokens: number }
  >();

  for (let i = 0; i <= maxIter; i++) {
    buckets.set(i, { architect: 0, coder: 0, reviewer: 0, other: 0, tokens: 0 });
  }

  for (const ev of events) {
    const iter = Math.max(0, ev.iteration);
    const bucket = buckets.get(iter) ?? {
      architect: 0,
      coder: 0,
      reviewer: 0,
      other: 0,
      tokens: 0,
    };
    const cost = Math.max(0, ev.cost_rub || 0);
    if (ev.agent_role === 'architect') bucket.architect += cost;
    else if (ev.agent_role === 'coder') bucket.coder += cost;
    else if (ev.agent_role === 'reviewer') bucket.reviewer += cost;
    else bucket.other += cost;

    bucket.tokens += Math.max(0, (ev.prompt_tokens || 0) + (ev.completion_tokens || 0));
    buckets.set(iter, bucket);
  }

  const points: IterationCostPoint[] = [];
  let cumulative = 0;

  for (let i = 0; i <= maxIter; i++) {
    const b = buckets.get(i)!;
    const iterTotal = roundRub(b.architect + b.coder + b.reviewer + b.other);
    cumulative = roundRub(cumulative + iterTotal);
    points.push({
      iteration: i,
      label: `Итер. ${i}`,
      architectRub: roundRub(b.architect),
      coderRub: roundRub(b.coder),
      reviewerRub: roundRub(b.reviewer),
      iterationCostRub: iterTotal,
      cumulativeRub: cumulative,
      budgetRub,
      tokensTotal: b.tokens,
    });
  }

  return points;
}

/** Возвращает доступные итерации и число запусков INSTALL/BUILD/TEST в каждой */
export function getIterationLogSummaries(
  commandRuns: LogCommandRunInput[],
  currentIteration: number
): Array<{ iteration: number; count: number }> {
  const counts = new Map<number, number>();
  for (let i = 0; i <= Math.max(0, currentIteration); i++) {
    counts.set(i, 0);
  }
  for (const run of commandRuns) {
    if (run.stage === 'INSTALL' || run.stage === 'BUILD' || run.stage === 'TEST') {
      counts.set(run.iteration, (counts.get(run.iteration) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([iteration, count]) => ({ iteration, count }));
}

/** Форматирует логи сборки и тестов конкретной итерации в .txt для отладки */
export function formatIterationLogsTxt(params: {
  project: { id: string; name: string; stack: string; status: string; stage: string };
  iteration: number;
  commandRuns: LogCommandRunInput[];
  exportedAt?: string;
}): string {
  const runs = params.commandRuns.filter(
    (r) =>
      r.iteration === params.iteration &&
      (r.stage === 'INSTALL' || r.stage === 'BUILD' || r.stage === 'TEST')
  );

  const lines: string[] = [
    '====================================================================',
    `ЛОГ СБОРКИ И ТЕСТОВ — ИТЕРАЦИЯ ${params.iteration}`,
    '====================================================================',
    `Проект:   ${params.project.name} (${params.project.id})`,
    `Стек:     ${params.project.stack}`,
    `Статус:   ${params.project.status} | Стадия: ${params.project.stage}`,
    `Запусков: ${runs.length}`,
    `Выгрузка: ${params.exportedAt ?? new Date().toISOString()}`,
    '====================================================================',
    '',
  ];

  if (runs.length === 0) {
    lines.push(`Запуски установки, сборки и тестов для итерации ${params.iteration} отсутствуют.`);
    return lines.join('\n');
  }

  for (let idx = 0; idx < runs.length; idx++) {
    const run = runs[idx];
    lines.push(`--- [${idx + 1}/${runs.length}] ${run.stage} | ${run.command} ---`);
    lines.push(
      `Время: ${run.created_at} | Код выхода: ${run.exit_code} | Таймаут: ${
        run.timed_out ? 'да' : 'нет'
      } | Длительность: ${(run.duration_ms / 1000).toFixed(2)} с`
    );
    lines.push('');
    if (run.stdout.trim()) {
      lines.push('[STDOUT]');
      lines.push(run.stdout.trimEnd());
      lines.push('');
    }
    if (run.stderr.trim()) {
      lines.push('[STDERR]');
      lines.push(run.stderr.trimEnd());
      lines.push('');
    }
    if (!run.stdout.trim() && !run.stderr.trim()) {
      lines.push('(вывод команды пуст)');
      lines.push('');
    }
  }

  return lines.join('\n');
}

/** Применяет новое WebSocket-событие project:event к состоянию projectDetail без дублирования и двойного учёта расхода */
export function mergeProjectEventIntoState<
  TEvent extends { id: number; iteration: number; cost_rub: number },
  TDetail extends { project: { spent_rub: number; iteration: number }; events: TEvent[] }
>(prev: TDetail, event: TEvent): TDetail {
  if (prev.events.some((e) => e.id === event.id)) {
    return prev;
  }
  const nextEvents = [...prev.events, event];
  const eventsTotal = roundRub(
    nextEvents.reduce((sum, item) => sum + Math.max(0, item.cost_rub || 0), 0)
  );
  return {
    ...prev,
    project: {
      ...prev.project,
      spent_rub: Math.max(prev.project.spent_rub, eventsTotal),
      iteration: Math.max(prev.project.iteration, Math.max(0, event.iteration)),
    },
    events: nextEvents,
  };
}

