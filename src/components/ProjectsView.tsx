import { useMemo, useState } from 'react';
import { Play, Plus, Search, Trash2, AlertCircle, Activity } from 'lucide-react';
import {
  STACK_LABELS,
  STATUS_LABELS,
  type ProjectDTO,
  type ProjectStatus,
  type StackErrorLogDTO,
  type StackType,
  type SystemMetricsSnapshot,
} from '../types';

interface ProjectsViewProps {
  projects: ProjectDTO[];
  stackErrors: StackErrorLogDTO[];
  metrics: SystemMetricsSnapshot | null;
  loading: boolean;
  onOpenProject: (id: string) => void;
  onNewProject: () => void;
  onResumeProject: (id: string) => Promise<void>;
  onDeleteProject: (id: string) => Promise<void>;
  onFilterStackErrors: (stack: StackType | '') => void;
  selectedErrorStack: StackType | '';
}

function getStatusTextClass(status: ProjectStatus): string {
  switch (status) {
    case 'done':
      return 'text-[#4ADE80]';
    case 'running':
      return 'text-[#60A5FA]';
    case 'paused':
    case 'queued':
      return 'text-[#FBBF24]';
    case 'failed':
    case 'budget_exceeded':
    case 'cancelled':
      return 'text-[#F87171]';
  }
}

function formatGb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

export function ProjectsView({
  projects,
  stackErrors,
  metrics,
  loading,
  onOpenProject,
  onNewProject,
  onResumeProject,
  onDeleteProject,
  onFilterStackErrors,
  selectedErrorStack,
}: ProjectsViewProps) {
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState<'all' | ProjectStatus>('all');
  const [expandedErrorId, setExpandedErrorId] = useState<number | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const filteredProjects = useMemo(() => {
    const q = search.trim().toLowerCase();
    return projects.filter((p) => {
      if (statusFilter !== 'all' && p.status !== statusFilter) return false;
      if (q && !p.name.toLowerCase().includes(q) && !p.spec.toLowerCase().includes(q)) {
        return false;
      }
      return true;
    });
  }, [projects, search, statusFilter]);

  const ramPercent =
    metrics && metrics.ramTotalBytes > 0
      ? Math.round((metrics.ramUsedBytes / metrics.ramTotalBytes) * 100)
      : 0;
  const diskUsedPercent =
    metrics && metrics.diskTotalBytes > 0
      ? Math.round(((metrics.diskTotalBytes - metrics.diskFreeBytes) / metrics.diskTotalBytes) * 100)
      : 0;
  const budgetPercent =
    metrics && metrics.dailyBudgetRub > 0
      ? Math.min(100, Math.round((metrics.dailySpentRub / metrics.dailyBudgetRub) * 100))
      : 0;

  return (
    <div className="p-6 max-w-[1400px] mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[#F8FAFC] tracking-tight">Проекты</h1>
          <p className="text-sm text-[#94A3B8] mt-1">
            Очередь автономной сборки, история запусков и контроль бюджета в рублях
          </p>
        </div>
        <button
          type="button"
          onClick={onNewProject}
          className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-sm font-medium text-white transition-colors cursor-pointer whitespace-nowrap shrink-0"
        >
          <Plus className="w-4 h-4" />
          <span>Новый проект</span>
        </button>
      </div>

      {/* Мониторинг системы в реальном времени */}
      {metrics && (
        <section aria-label="Мониторинг состояния системы" className="bg-[#111827] border border-[#1E293B] rounded-xl p-5">
          <div className="flex items-center justify-between gap-4 mb-4">
            <div className="flex items-center gap-2 text-sm font-medium text-[#F8FAFC]">
              <Activity className="w-4 h-4 text-[#60A5FA]" />
              <h2>Мониторинг системы в реальном времени</h2>
            </div>
            <span className="text-xs font-mono tabular-nums text-[#94A3B8]">
              Аптайм: {metrics.uptimeSeconds} с · Активный проект: {metrics.activeProjectId ?? 'нет'} · В очереди:{' '}
              {metrics.queueLength}
            </span>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-4 gap-5">
            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-[#94A3B8]">Процессор ({metrics.cpuCores} ядер)</span>
                <span className="font-mono tabular-nums text-[#F8FAFC]">{metrics.cpuPercent.toFixed(1)}%</span>
              </div>
              <div className="h-2 rounded bg-[#0B0F17] overflow-hidden">
                <div
                  className="h-full bg-[#2563EB] transition-all duration-300"
                  style={{ width: `${Math.min(100, metrics.cpuPercent)}%` }}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-[#94A3B8]">Память (ОЗУ)</span>
                <span className="font-mono tabular-nums text-[#F8FAFC]">
                  {formatGb(metrics.ramUsedBytes)} / {formatGb(metrics.ramTotalBytes)} ГБ
                </span>
              </div>
              <div className="h-2 rounded bg-[#0B0F17] overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    ramPercent > 85 ? 'bg-[#DC2626]' : 'bg-[#16A34A]'
                  }`}
                  style={{ width: `${ramPercent}%` }}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-[#94A3B8]">Диск (свободно {formatGb(metrics.diskFreeBytes)} ГБ)</span>
                <span className="font-mono tabular-nums text-[#F8FAFC]">{diskUsedPercent}% занято</span>
              </div>
              <div className="h-2 rounded bg-[#0B0F17] overflow-hidden">
                <div
                  className="h-full bg-[#60A5FA] transition-all duration-300"
                  style={{ width: `${diskUsedPercent}%` }}
                />
              </div>
            </div>

            <div className="space-y-1.5">
              <div className="flex justify-between text-xs">
                <span className="text-[#94A3B8]">Суточный бюджет</span>
                <span className="font-mono tabular-nums text-[#F8FAFC]">
                  {metrics.dailySpentRub.toFixed(2)} / {metrics.dailyBudgetRub} ₽
                </span>
              </div>
              <div className="h-2 rounded bg-[#0B0F17] overflow-hidden">
                <div
                  className={`h-full transition-all duration-300 ${
                    budgetPercent >= 90 ? 'bg-[#DC2626]' : budgetPercent >= 70 ? 'bg-[#D97706]' : 'bg-[#16A34A]'
                  }`}
                  style={{ width: `${budgetPercent}%` }}
                />
              </div>
            </div>
          </div>
        </section>
      )}

      {/* Фильтры списка проектов */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="relative flex-1 min-w-[240px] max-w-md">
          <Search className="w-4 h-4 text-[#64748B] absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="search"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Поиск по названию или ТЗ..."
            aria-label="Поиск проектов"
            className="w-full pl-9 pr-3 py-2 bg-[#111827] border border-[#1E293B] rounded-lg text-sm text-[#F8FAFC] placeholder:text-[#64748B] focus:outline-none focus:border-[#2563EB]"
          />
        </div>

        <div className="flex flex-wrap items-center gap-1 p-1 bg-[#111827] border border-[#1E293B] rounded-lg">
          {(
            [
              ['all', 'Все'],
              ['running', 'Выполняются'],
              ['paused', 'На паузе'],
              ['done', 'Готовые'],
              ['failed', 'С ошибкой'],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              onClick={() => setStatusFilter(key)}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors whitespace-nowrap shrink-0 cursor-pointer ${
                statusFilter === key
                  ? 'bg-[#1E293B] text-[#F8FAFC]'
                  : 'text-[#94A3B8] hover:text-[#F8FAFC]'
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      {/* Таблица проектов */}
      <div className="bg-[#111827] border border-[#1E293B] rounded-xl overflow-hidden">
        {loading ? (
          <div className="p-8 text-center text-sm text-[#94A3B8]">Загрузка списка проектов...</div>
        ) : filteredProjects.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <p className="text-sm text-[#94A3B8]">
              {projects.length === 0
                ? 'Проектов пока нет. Создайте первый проект, чтобы запустить конвейер агентов.'
                : 'По заданному фильтру проекты не найдены.'}
            </p>
            {projects.length === 0 && (
              <button
                type="button"
                onClick={onNewProject}
                className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-sm font-medium text-white cursor-pointer"
              >
                <Plus className="w-4 h-4" />
                <span>Создать первый проект</span>
              </button>
            )}
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-[#1E293B] text-xs font-medium text-[#94A3B8] bg-[#0F172A]">
                  <th className="py-3 px-4">Проект</th>
                  <th className="py-3 px-4">Стек</th>
                  <th className="py-3 px-4">Стадия</th>
                  <th className="py-3 px-4">Статус</th>
                  <th className="py-3 px-4 text-right">Итерация</th>
                  <th className="py-3 px-4 text-right">Расход / Бюджет</th>
                  <th className="py-3 px-4 text-right">Действия</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E293B] text-sm">
                {filteredProjects.map((project) => (
                  <tr key={project.id} className="hover:bg-[#182235]/60 transition-colors">
                    <td className="py-3 px-4">
                      <button
                        type="button"
                        onClick={() => onOpenProject(project.id)}
                        className="text-left font-medium text-[#F8FAFC] hover:text-[#60A5FA] transition-colors cursor-pointer"
                      >
                        {project.name}
                      </button>
                      <div className="text-xs text-[#64748B] truncate max-w-md mt-0.5">
                        {project.spec}
                      </div>
                    </td>
                    <td className="py-3 px-4 text-xs text-[#CBD5E1] whitespace-nowrap">
                      {STACK_LABELS[project.stack]}
                    </td>
                    <td className="py-3 px-4 font-mono text-xs text-[#CBD5E1] whitespace-nowrap">
                      {project.stage}
                    </td>
                    <td className={`py-3 px-4 text-xs font-medium whitespace-nowrap ${getStatusTextClass(project.status)}`}>
                      {STATUS_LABELS[project.status]}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-[#CBD5E1]">
                      {project.iteration}/{project.max_iterations}
                    </td>
                    <td className="py-3 px-4 text-right font-mono tabular-nums text-xs text-[#CBD5E1] whitespace-nowrap">
                      {project.spent_rub.toFixed(2)} / {project.budget_rub.toFixed(0)} ₽
                    </td>
                    <td className="py-3 px-4 text-right whitespace-nowrap">
                      <div className="inline-flex items-center gap-2">
                        {(project.status === 'paused' || project.status === 'failed' || project.status === 'cancelled') && (
                          <button
                            type="button"
                            disabled={busyId === project.id}
                            onClick={async () => {
                              setBusyId(project.id);
                              try {
                                await onResumeProject(project.id);
                              } finally {
                                setBusyId(null);
                              }
                            }}
                            aria-label={`Продолжить проект ${project.name}`}
                            className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded bg-[#1E293B] hover:bg-[#334155] text-xs text-[#F8FAFC] cursor-pointer"
                          >
                            <Play className="w-3 h-3" />
                            <span>Продолжить</span>
                          </button>
                        )}
                        <button
                          type="button"
                          onClick={() => onOpenProject(project.id)}
                          className="px-2.5 py-1.5 rounded bg-[#2563EB]/20 hover:bg-[#2563EB]/30 text-xs font-medium text-[#60A5FA] cursor-pointer"
                        >
                          Открыть
                        </button>
                        <button
                          type="button"
                          disabled={busyId === project.id}
                          onClick={async () => {
                            setBusyId(project.id);
                            try {
                              await onDeleteProject(project.id);
                            } finally {
                              setBusyId(null);
                            }
                          }}
                          aria-label={`Удалить проект ${project.name}`}
                          className="p-1.5 rounded text-[#94A3B8] hover:text-[#F87171] hover:bg-[#450A0A]/40 transition-colors cursor-pointer"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Журнал ошибок по стекам */}
      <section aria-label="Журнал ошибок по стекам" className="bg-[#111827] border border-[#1E293B] rounded-xl p-5">
        <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
          <div className="flex items-center gap-2 text-sm font-medium text-[#F8FAFC]">
            <AlertCircle className="w-4 h-4 text-[#FBBF24]" />
            <h2>Журнал ошибок сборки и тестов по стекам</h2>
          </div>

          <div className="flex flex-wrap items-center gap-1 p-1 bg-[#0B0F17] border border-[#1E293B] rounded-lg">
            {(
              [
                ['', 'Все стеки'],
                ['ts-web', 'ts-web'],
                ['node-api', 'node-api'],
                ['python', 'python'],
                ['kotlin', 'kotlin'],
              ] as const
            ).map(([val, label]) => (
              <button
                key={val || 'all'}
                type="button"
                onClick={() => onFilterStackErrors(val)}
                className={`px-2.5 py-1 rounded text-xs font-mono transition-colors cursor-pointer whitespace-nowrap ${
                  selectedErrorStack === val
                    ? 'bg-[#1E293B] text-[#F8FAFC]'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {stackErrors.length === 0 ? (
          <p className="text-xs text-[#64748B]">
            Ошибок сборки/тестов для выбранного фильтра не зафиксировано.
          </p>
        ) : (
          <div className="divide-y divide-[#1E293B]">
            {stackErrors.slice(0, 15).map((log) => (
              <div key={log.id} className="py-2.5">
                <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                  <div className="flex items-center gap-2 text-[#CBD5E1]">
                    <span className="font-mono text-[#FBBF24]">{log.stack}</span>
                    <span className="text-[#475569]">·</span>
                    <span className="font-mono text-[#94A3B8]">{log.stage}</span>
                    <span className="text-[#475569]">·</span>
                    <span className="text-[#F8FAFC]">{log.message}</span>
                  </div>
                  <div className="flex items-center gap-3 font-mono tabular-nums text-[#64748B]">
                    <span>хэш {log.error_hash}</span>
                    <span>{new Date(log.created_at).toLocaleTimeString('ru-RU')}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedErrorId(expandedErrorId === log.id ? null : log.id)
                      }
                      className="text-[#60A5FA] hover:underline cursor-pointer"
                    >
                      {expandedErrorId === log.id ? 'Скрыть' : 'Лог'}
                    </button>
                  </div>
                </div>
                {expandedErrorId === log.id && (
                  <pre className="mt-2 p-3 rounded-lg bg-[#090D14] border border-[#1E293B] text-xs font-mono text-[#FCA5A5] overflow-x-auto max-h-56">
                    {log.tail_output}
                  </pre>
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
