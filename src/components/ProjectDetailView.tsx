import { useEffect, useMemo, useState, type FormEvent } from 'react';
import {
  Archive,
  Bot,
  Download,
  FileCode2,
  GitCompare,
  Play,
  RefreshCw,
  Square,
  Wand2,
} from 'lucide-react';
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import {
  buildIterationBudgetSeries,
  formatIterationLogsTxt,
  getIterationLogSummaries,
  type IterationCostPoint,
} from '../../shared/projectAnalytics';
import { api } from '../api';
import {
  STACK_LABELS,
  STATUS_LABELS,
  type AgentEventDTO,
  type PlanOutput,
  type ProjectDetailResponse,
  type ReviewOutput,
} from '../types';
import { CodeViewer } from './CodeViewer';

interface ProjectDetailViewProps {
  projectId: string;
  projectDetail: ProjectDetailResponse | null;
  loading: boolean;
  onRefresh: () => Promise<void>;
}

type BottomTab = 'build' | 'tests' | 'review' | 'errors' | 'plan';

const ROLE_LABELS: Record<string, string> = {
  architect: 'Архитектор',
  coder: 'Кодер',
  reviewer: 'Ревьюер',
  system: 'Система',
};

function getRoleAccent(role: string): string {
  switch (role) {
    case 'architect':
      return 'text-[#60A5FA]';
    case 'coder':
      return 'text-[#4ADE80]';
    case 'reviewer':
      return 'text-[#FBBF24]';
    default:
      return 'text-[#94A3B8]';
  }
}

export function ProjectDetailView({
  projectId,
  projectDetail,
  loading,
  onRefresh,
}: ProjectDetailViewProps) {
  const [selectedFile, setSelectedFile] = useState<string>('');
  const [fileContent, setFileContent] = useState<string>('');
  const [fileLoading, setFileLoading] = useState(false);
  const [viewerMode, setViewerMode] = useState<'code' | 'diff'>('code');
  const [bottomTab, setBottomTab] = useState<BottomTab>('build');
  const [refineOpen, setRefineOpen] = useState(false);
  const [refineText, setRefineText] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [expandedEventId, setExpandedEventId] = useState<number | null>(null);
  const [customLogIteration, setCustomLogIteration] = useState<number | null>(null);

  useEffect(() => {
    setCustomLogIteration(null);
  }, [projectId]);

  useEffect(() => {
    if (!projectDetail?.files.length) {
      setSelectedFile('');
      setFileContent('');
      return;
    }
    const stillExists = projectDetail.files.some((f) => f.path === selectedFile);
    if (!selectedFile || !stillExists) {
      const preferred =
        projectDetail.files.find((f) =>
          /src\/App\.tsx|src\/app\.ts|app\/main\.py|Main\.kt|package\.json/.test(f.path)
        ) ?? projectDetail.files[0];
      if (preferred) {
        setSelectedFile(preferred.path);
      }
    }
  }, [projectDetail?.files, selectedFile]);

  useEffect(() => {
    if (!selectedFile || viewerMode !== 'code') return;
    let active = true;
    setFileLoading(true);
    api
      .getProjectFile(projectId, selectedFile)
      .then((res) => {
        if (active) setFileContent(res.content);
      })
      .catch((err) => {
        if (active) {
          setFileContent(`// Не удалось прочитать файл: ${err instanceof Error ? err.message : String(err)}`);
        }
      })
      .finally(() => {
        if (active) setFileLoading(false);
      });
    return () => {
      active = false;
    };
  }, [projectId, selectedFile, viewerMode, projectDetail?.project.updated_at]);

  const parsedPlan = useMemo<PlanOutput | null>(() => {
    if (!projectDetail?.project.plan_json) return null;
    try {
      return JSON.parse(projectDetail.project.plan_json) as PlanOutput;
    } catch {
      return null;
    }
  }, [projectDetail?.project.plan_json]);

  const parsedReview = useMemo<ReviewOutput | null>(() => {
    if (!projectDetail?.project.review_json) return null;
    try {
      return JSON.parse(projectDetail.project.review_json) as ReviewOutput;
    } catch {
      return null;
    }
  }, [projectDetail?.project.review_json]);

  const iterationSummaries = useMemo(
    () =>
      projectDetail
        ? getIterationLogSummaries(projectDetail.commandRuns, projectDetail.project.iteration)
        : [{ iteration: 0, count: 0 }],
    [projectDetail]
  );

  const activeLogIteration = useMemo(() => {
    if (!projectDetail) return 0;
    if (
      customLogIteration !== null &&
      iterationSummaries.some((s) => s.iteration === customLogIteration)
    ) {
      return customLogIteration;
    }
    return projectDetail.project.iteration;
  }, [customLogIteration, projectDetail, iterationSummaries]);

  if (loading && !projectDetail) {
    return (
      <div className="p-8 text-sm text-[#94A3B8]">Загрузка рабочего пространства проекта...</div>
    );
  }

  if (!projectDetail) {
    return (
      <div className="p-8 text-sm text-[#F87171]">Проект не найден или был удалён.</div>
    );
  }

  const { project, events, commandRuns, stackErrors, files, diff } = projectDetail;
  const isRunningOrQueued = project.status === 'running' || project.status === 'queued';
  const canResume =
    project.status === 'paused' ||
    project.status === 'failed' ||
    project.status === 'cancelled';

  const buildRuns = commandRuns.filter((r) => r.stage === 'INSTALL' || r.stage === 'BUILD');
  const testRuns = commandRuns.filter((r) => r.stage === 'TEST');

  async function runAction(name: string, fn: () => Promise<void>) {
    setActionError(null);
    setBusyAction(name);
    try {
      await fn();
      await onRefresh();
    } catch (err) {
      setActionError(err instanceof Error ? err.message : 'Ошибка выполнения действия');
    } finally {
      setBusyAction(null);
    }
  }

  async function handleRefineSubmit(e: FormEvent) {
    e.preventDefault();
    if (!refineText.trim()) return;
    await runAction('refine', async () => {
      await api.refineProject(projectId, refineText.trim());
      setRefineText('');
      setRefineOpen(false);
    });
  }

  function handleDownloadLogs() {
    const content = formatIterationLogsTxt({
      project: {
        id: project.id,
        name: project.name,
        stack: project.stack,
        status: project.status,
        stage: project.stage,
      },
      iteration: activeLogIteration,
      commandRuns,
    });
    const blob = new Blob([content], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${project.id}-iter-${activeLogIteration}-logs.txt`;
    document.body.appendChild(link);
    link.click();
    link.remove();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="p-5 max-w-[1600px] mx-auto space-y-4">
      {/* Шапка проекта и кнопки управления */}
      <div className="bg-[#111827] border border-[#1E293B] rounded-xl p-4 flex flex-wrap items-center justify-between gap-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2.5">
            <h1 className="text-lg font-semibold text-[#F8FAFC] truncate">{project.name}</h1>
            <span className="text-xs font-mono text-[#64748B]">{project.id}</span>
          </div>
          <div className="flex flex-wrap items-center gap-3 mt-1 text-xs text-[#94A3B8] font-mono tabular-nums">
            <span>{STACK_LABELS[project.stack]}</span>
            <span aria-hidden="true">·</span>
            <span>Статус: <strong className="text-[#F8FAFC]">{STATUS_LABELS[project.status]}</strong></span>
            <span aria-hidden="true">·</span>
            <span>Стадия: <strong className="text-[#60A5FA]">{project.stage}</strong></span>
            <span aria-hidden="true">·</span>
            <span>Итерация: {project.iteration}/{project.max_iterations}</span>
            <span aria-hidden="true">·</span>
            <span>
              Бюджет: <strong className="text-[#F8FAFC]">{project.spent_rub.toFixed(2)} ₽</strong> /{' '}
              {project.budget_rub.toFixed(0)} ₽
            </span>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 shrink-0">
          {isRunningOrQueued && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => runAction('cancel', () => api.cancelProject(projectId).then(() => {}))}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#991B1B] hover:bg-[#B91C1C] text-xs font-medium text-white cursor-pointer whitespace-nowrap"
            >
              <Square className="w-3.5 h-3.5" />
              <span>Отмена</span>
            </button>
          )}

          {canResume && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => runAction('resume', () => api.resumeProject(projectId).then(() => {}))}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#16A34A] hover:bg-[#15803D] text-xs font-medium text-white cursor-pointer whitespace-nowrap"
            >
              <Play className="w-3.5 h-3.5" />
              <span>Продолжить</span>
            </button>
          )}

          {!isRunningOrQueued && (
            <button
              type="button"
              onClick={() => setRefineOpen((v) => !v)}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-xs font-medium text-white cursor-pointer whitespace-nowrap"
            >
              <Wand2 className="w-3.5 h-3.5" />
              <span>Доработать</span>
            </button>
          )}

          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => runAction('zip', () => api.downloadZip(projectId))}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[#1E293B] bg-[#0B0F17] hover:bg-[#1E293B] text-xs font-medium text-[#E2E8F0] cursor-pointer whitespace-nowrap"
          >
            <Archive className="w-3.5 h-3.5" />
            <span>ZIP</span>
          </button>

          <button
            type="button"
            onClick={() => onRefresh()}
            aria-label="Обновить данные проекта"
            className="p-2 rounded-lg border border-[#1E293B] bg-[#0B0F17] hover:bg-[#1E293B] text-[#94A3B8] hover:text-[#F8FAFC] cursor-pointer"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {project.last_error && (
        <div role="alert" className="p-3.5 rounded-xl bg-[#450A0A]/50 border border-[#991B1B] text-xs text-[#FCA5A5] font-mono whitespace-pre-wrap">
          {project.last_error}
        </div>
      )}

      {actionError && (
        <div role="alert" className="p-3 rounded-xl bg-[#450A0A]/50 border border-[#991B1B] text-xs text-[#FCA5A5]">
          {actionError}
        </div>
      )}

      {/* Форма доработки */}
      {refineOpen && (
        <form
          onSubmit={handleRefineSubmit}
          className="bg-[#111827] border border-[#2563EB]/50 rounded-xl p-4 space-y-3"
        >
          <label htmlFor="refine-input" className="block text-xs font-medium text-[#E2E8F0]">
            Инструкция для доработки (Кодер внесёт изменения и прогонит тесты и ревью заново)
          </label>
          <textarea
            id="refine-input"
            rows={3}
            required
            minLength={5}
            value={refineText}
            onChange={(e) => setRefineText(e.target.value)}
            placeholder="Например: Добавь валидацию отрицательных чисел и покрой это unit-тестом..."
            className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
          />
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setRefineOpen(false)}
              className="px-3 py-1.5 rounded-lg text-xs text-[#94A3B8] hover:text-[#F8FAFC] cursor-pointer"
            >
              Закрыть
            </button>
            <button
              type="submit"
              disabled={busyAction === 'refine'}
              className="px-4 py-1.5 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] text-xs font-medium text-white cursor-pointer"
            >
              Запустить доработку
            </button>
          </div>
        </form>
      )}

      {/* Основная 3-панельная сетка: Дерево файлов | Код / Diff | Лента трёх агентов */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-4 min-h-[480px]">
        {/* Дерево файлов */}
        <section
          aria-label="Дерево файлов проекта"
          className="lg:col-span-3 bg-[#111827] border border-[#1E293B] rounded-xl flex flex-col overflow-hidden max-h-[540px]"
        >
          <div className="px-4 py-2.5 border-b border-[#1E293B] bg-[#0F172A] text-xs font-medium text-[#CBD5E1] flex items-center justify-between">
            <span>Файлы ({files.length})</span>
            <span className="font-mono text-[#64748B]">work/{project.id}</span>
          </div>
          <div className="flex-1 overflow-y-auto p-2 space-y-0.5">
            {files.length === 0 ? (
              <div className="p-3 text-xs text-[#64748B]">Файлы отсутствуют</div>
            ) : (
              files.map((file) => {
                const isSelected = selectedFile === file.path && viewerMode === 'code';
                return (
                  <button
                    key={file.path}
                    type="button"
                    onClick={() => {
                      setViewerMode('code');
                      setSelectedFile(file.path);
                    }}
                    className={`w-full text-left px-2.5 py-1.5 rounded text-xs font-mono flex items-center justify-between gap-2 cursor-pointer transition-colors ${
                      isSelected
                        ? 'bg-[#2563EB]/20 text-[#60A5FA]'
                        : 'text-[#CBD5E1] hover:bg-[#1E293B]/60'
                    }`}
                  >
                    <span className="truncate">{file.path}</span>
                    <span className="text-[11px] text-[#64748B] shrink-0 tabular-nums">
                      {file.size > 1024 ? `${(file.size / 1024).toFixed(1)}K` : `${file.size}B`}
                    </span>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* Редактор просмотра кода / Diff с подсветкой PrismJS */}
        <section
          aria-label="Просмотр кода и Diff"
          className="lg:col-span-5 bg-[#111827] border border-[#1E293B] rounded-xl flex flex-col overflow-hidden max-h-[540px]"
        >
          <div className="px-4 py-2 border-b border-[#1E293B] bg-[#0F172A] flex items-center justify-between gap-2">
            <span className="text-xs font-mono text-[#CBD5E1] truncate">
              {viewerMode === 'diff' ? 'Последний git diff' : selectedFile || 'Выберите файл'}
            </span>
            <div className="flex items-center gap-1 p-0.5 bg-[#0B0F17] border border-[#1E293B] rounded-md shrink-0">
              <button
                type="button"
                onClick={() => setViewerMode('code')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs cursor-pointer ${
                  viewerMode === 'code'
                    ? 'bg-[#1E293B] text-[#F8FAFC]'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                }`}
              >
                <FileCode2 className="w-3.5 h-3.5" />
                <span>Код</span>
              </button>
              <button
                type="button"
                onClick={() => setViewerMode('diff')}
                className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-xs cursor-pointer ${
                  viewerMode === 'diff'
                    ? 'bg-[#1E293B] text-[#F8FAFC]'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                }`}
              >
                <GitCompare className="w-3.5 h-3.5" />
                <span>Diff</span>
              </button>
            </div>
          </div>

          <div className="flex-1 overflow-hidden">
            {viewerMode === 'diff' ? (
              <CodeViewer
                code={diff || 'Изменений в git пока нет.'}
                mode="diff"
              />
            ) : fileLoading ? (
              <div className="p-4 text-xs text-[#94A3B8]">Загрузка файла...</div>
            ) : (
              <CodeViewer code={fileContent} filePath={selectedFile} mode="code" />
            )}
          </div>
        </section>

        {/* Лента трёх агентов */}
        <section
          aria-label="Лента трёх агентов"
          className="lg:col-span-4 bg-[#111827] border border-[#1E293B] rounded-xl flex flex-col overflow-hidden max-h-[540px]"
        >
          <div className="px-4 py-2.5 border-b border-[#1E293B] bg-[#0F172A] text-xs font-medium text-[#CBD5E1] flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5">
              <Bot className="w-3.5 h-3.5 text-[#60A5FA]" />
              <span>Лента агентов ({events.length})</span>
            </span>
            <span className="text-[#64748B]">Архитектор · Кодер · Ревьюер</span>
          </div>

          <div className="flex-1 overflow-y-auto divide-y divide-[#1E293B]">
            {events.length === 0 ? (
              <div className="p-4 text-xs text-[#64748B]">События конвейера появятся здесь...</div>
            ) : (
              [...events].reverse().map((ev: AgentEventDTO) => (
                <div key={ev.id} className="p-3 space-y-1.5">
                  <div className="flex items-center justify-between gap-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className={`font-semibold ${getRoleAccent(ev.agent_role)}`}>
                        {ROLE_LABELS[ev.agent_role] ?? ev.agent_role}
                      </span>
                      <span className="text-[#475569]">·</span>
                      <span className="font-mono text-[#94A3B8]">{ev.stage}</span>
                    </div>
                    <span className="font-mono tabular-nums text-[11px] text-[#64748B]">
                      {ev.cost_rub > 0 ? `${ev.cost_rub.toFixed(2)} ₽ · ` : ''}
                      {new Date(ev.created_at).toLocaleTimeString('ru-RU')}
                    </span>
                  </div>
                  <p className="text-xs text-[#E2E8F0] leading-relaxed">{ev.summary}</p>
                  <div className="flex items-center justify-between text-[11px] font-mono text-[#64748B]">
                    <span className="truncate">{ev.model}</span>
                    <button
                      type="button"
                      onClick={() =>
                        setExpandedEventId(expandedEventId === ev.id ? null : ev.id)
                      }
                      className="text-[#60A5FA] hover:underline cursor-pointer shrink-0"
                    >
                      {expandedEventId === ev.id ? 'Скрыть JSON' : 'Детали'}
                    </button>
                  </div>
                  {expandedEventId === ev.id && (
                    <pre className="p-2.5 rounded bg-[#090D14] border border-[#1E293B] text-[11px] font-mono text-[#CBD5E1] overflow-x-auto max-h-44">
                      {ev.payload_json}
                    </pre>
                  )}
                </div>
              ))
            )}
          </div>
        </section>
      </div>

      {/* График расходования бюджета по итерациям в реальном времени */}
      <BudgetChart
        events={projectDetail.events}
        currentIteration={project.iteration}
        budgetRub={project.budget_rub}
        spentRub={project.spent_rub}
      />

      {/* Нижние вкладки: Build / Tests / Review / Ошибки стека / План */}
      <section className="bg-[#111827] border border-[#1E293B] rounded-xl overflow-hidden">
        <div className="px-4 py-2 border-b border-[#1E293B] bg-[#0F172A] flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-1">
            {(
              [
                ['build', `Build (${buildRuns.length})`],
                ['tests', `Tests (${testRuns.length})`],
                ['review', 'Review'],
                ['errors', `Ошибки стека (${stackErrors.length})`],
                ['plan', 'План'],
              ] as const
            ).map(([tab, label]) => (
              <button
                key={tab}
                type="button"
                onClick={() => setBottomTab(tab)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-colors cursor-pointer whitespace-nowrap ${
                  bottomTab === tab
                    ? 'bg-[#1E293B] text-[#F8FAFC]'
                    : 'text-[#94A3B8] hover:text-[#F8FAFC]'
                }`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="flex items-center gap-2 shrink-0">
            <label htmlFor="log-iteration-select" className="text-xs text-[#94A3B8] whitespace-nowrap">
              Итерация:
            </label>
            <select
              id="log-iteration-select"
              aria-label="Выбор итерации для скачивания логов"
              value={activeLogIteration}
              onChange={(e) => setCustomLogIteration(Number(e.target.value))}
              className="px-2.5 py-1.5 rounded-md bg-[#0B0F17] border border-[#1E293B] text-xs font-mono tabular-nums text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
            >
              {iterationSummaries.map((item) => (
                <option key={item.iteration} value={item.iteration}>
                  #{item.iteration} ({item.count} зап.)
                </option>
              ))}
            </select>
            <button
              type="button"
              onClick={handleDownloadLogs}
              aria-label="Скачать логи"
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border border-[#1E293B] bg-[#0B0F17] hover:bg-[#1E293B] text-xs font-medium text-[#E2E8F0] transition-colors cursor-pointer whitespace-nowrap shrink-0"
            >
              <Download className="w-3.5 h-3.5 text-[#60A5FA]" />
              <span>Скачать логи</span>
            </button>
          </div>
        </div>

        <div className="p-4 max-h-80 overflow-y-auto">
          {bottomTab === 'build' && (
            <CommandRunsList runs={buildRuns} emptyText="Запуски установки и сборки ещё не выполнялись." />
          )}

          {bottomTab === 'tests' && (
            <CommandRunsList runs={testRuns} emptyText="Запуски тестов ещё не выполнялись." />
          )}

          {bottomTab === 'review' && (
            <div>
              {!parsedReview ? (
                <p className="text-xs text-[#64748B]">Отчёт Ревьюера пока отсутствует.</p>
              ) : (
                <div className="space-y-3">
                  <div className="text-xs font-medium text-[#E2E8F0]">
                    Вердикт:{' '}
                    <span
                      className={
                        parsedReview.verdict === 'approve' ? 'text-[#4ADE80]' : 'text-[#F87171]'
                      }
                    >
                      {parsedReview.verdict === 'approve' ? 'Одобрено (approve)' : 'Требуются правки'}
                    </span>
                  </div>
                  {parsedReview.findings.length === 0 ? (
                    <p className="text-xs text-[#94A3B8]">Критических замечаний не обнаружено.</p>
                  ) : (
                    <div className="divide-y divide-[#1E293B]">
                      {parsedReview.findings.map((f, i) => (
                        <div key={i} className="py-2 text-xs space-y-1">
                          <div className="flex items-center gap-2 font-mono">
                            <span
                              className={
                                f.severity === 'blocker'
                                  ? 'text-[#F87171]'
                                  : f.severity === 'major'
                                    ? 'text-[#FBBF24]'
                                    : 'text-[#94A3B8]'
                              }
                            >
                              [{f.severity}]
                            </span>
                            <span className="text-[#60A5FA]">{f.file}</span>
                          </div>
                          <p className="text-[#E2E8F0]">{f.problem}</p>
                          <p className="text-[#94A3B8]">Исправление: {f.fix_instruction}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {bottomTab === 'errors' && (
            <div className="space-y-2">
              {stackErrors.length === 0 ? (
                <p className="text-xs text-[#64748B]">Ошибок стека в этом проекте нет.</p>
              ) : (
                stackErrors.map((err) => (
                  <div key={err.id} className="p-3 rounded-lg bg-[#090D14] border border-[#1E293B] space-y-1.5">
                    <div className="flex items-center justify-between text-xs font-mono">
                      <span className="text-[#FBBF24]">
                        {err.stack} · {err.stage} · {err.message}
                      </span>
                      <span className="text-[#64748B]">{err.error_hash}</span>
                    </div>
                    <pre className="text-xs font-mono text-[#FCA5A5] whitespace-pre-wrap">
                      {err.tail_output}
                    </pre>
                  </div>
                ))
              )}
            </div>
          )}

          {bottomTab === 'plan' && (
            <div>
              {!parsedPlan ? (
                <p className="text-xs text-[#64748B]">План Архитектора ещё не сформирован.</p>
              ) : (
                <div className="space-y-3 text-xs">
                  <div className="font-mono text-[#94A3B8]">
                    Команды: install=<code className="text-[#E2E8F0]">{parsedPlan.commands.install}</code> ·
                    build=<code className="text-[#E2E8F0]">{parsedPlan.commands.build}</code> · test=
                    <code className="text-[#E2E8F0]">{parsedPlan.commands.test}</code>
                  </div>
                  <div className="divide-y divide-[#1E293B]">
                    {parsedPlan.tasks.map((t) => (
                      <div key={t.key} className="py-2">
                        <div className="font-medium text-[#F8FAFC]">
                          <span className="font-mono text-[#60A5FA] mr-2">{t.key}</span>
                          {t.title}
                        </div>
                        <div className="text-[#94A3B8] mt-0.5">Критерий готовности: {t.dod}</div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </div>
  );
}

function CommandRunsList({
  runs,
  emptyText,
}: {
  runs: ProjectDetailResponse['commandRuns'];
  emptyText: string;
}) {
  if (runs.length === 0) {
    return <p className="text-xs text-[#64748B]">{emptyText}</p>;
  }
  return (
    <div className="space-y-3">
      {runs.map((run) => (
        <div key={run.id} className="p-3 rounded-lg bg-[#090D14] border border-[#1E293B] space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-2 text-xs font-mono">
            <span className="text-[#E2E8F0]">
              [{run.stage} · iter {run.iteration}] {run.command}
            </span>
            <span className="tabular-nums text-[#94A3B8]">
              код:{' '}
              <strong className={run.exit_code === 0 ? 'text-[#4ADE80]' : 'text-[#F87171]'}>
                {run.exit_code}
              </strong>{' '}
              · {(run.duration_ms / 1000).toFixed(2)} с
            </span>
          </div>
          {(run.stdout || run.stderr) && (
            <pre className="text-xs font-mono text-[#CBD5E1] whitespace-pre-wrap overflow-x-auto max-h-48">
              {[run.stdout, run.stderr].filter(Boolean).join('\n')}
            </pre>
          )}
        </div>
      ))}
    </div>
  );
}

interface BudgetChartProps {
  events: AgentEventDTO[];
  currentIteration: number;
  budgetRub: number;
  spentRub: number;
}

interface BudgetChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: IterationCostPoint }>;
}

function CustomBudgetTooltip({ active, payload }: BudgetChartTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;
  const point = payload[0].payload;
  return (
    <div className="bg-[#0F172A] border border-[#1E293B] rounded-lg px-3 py-2.5 text-xs space-y-1 shadow-lg">
      <div className="font-semibold text-[#F8FAFC]">{point.label}</div>
      <div className="font-mono tabular-nums text-[#38BDF8]">
        Накопительно: {point.cumulativeRub.toFixed(2)} ₽
      </div>
      <div className="font-mono tabular-nums text-[#4ADE80]">
        За итерацию: {point.iterationCostRub.toFixed(2)} ₽
      </div>
      <div className="border-t border-[#1E293B] pt-1 mt-1 space-y-0.5 text-[11px] font-mono tabular-nums text-[#94A3B8]">
        <div>Архитектор: {point.architectRub.toFixed(2)} ₽</div>
        <div>Кодер: {point.coderRub.toFixed(2)} ₽</div>
        <div>Ревьюер: {point.reviewerRub.toFixed(2)} ₽</div>
        <div>Токены: {point.tokensTotal.toLocaleString('ru-RU')}</div>
      </div>
    </div>
  );
}

export function BudgetChart({
  events,
  currentIteration,
  budgetRub,
  spentRub,
}: BudgetChartProps) {
  const data = useMemo(
    () => buildIterationBudgetSeries(events, currentIteration, budgetRub),
    [events, currentIteration, budgetRub]
  );

  const effectiveSpent = Math.max(
    spentRub,
    data.length > 0 ? data[data.length - 1].cumulativeRub : 0
  );
  const usedPct = budgetRub > 0 ? Math.min(100, Math.round((effectiveSpent / budgetRub) * 100)) : 0;
  const maxCumulative = data.reduce((m, d) => Math.max(m, d.cumulativeRub), 0);
  const yMax = Math.max(1, Math.ceil(Math.max(maxCumulative, budgetRub) * 1.1));

  return (
    <section
      aria-label="Линейный график расходования бюджета по итерациям"
      className="bg-[#111827] border border-[#1E293B] rounded-xl p-4 space-y-3"
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h2 className="text-xs font-semibold text-[#F8FAFC]">
            Расход бюджета проекта по итерациям (₽)
          </h2>
          <p className="text-[11px] text-[#94A3B8] mt-0.5">
            Линейный график накопительного и пошагового расхода в реальном времени по WebSocket
          </p>
        </div>
        <div className="text-xs font-mono tabular-nums text-[#CBD5E1]">
          Использовано: <strong className="text-[#F8FAFC]">{effectiveSpent.toFixed(2)} ₽</strong> /{' '}
          {budgetRub.toFixed(0)} ₽ ({usedPct}%)
        </div>
      </div>

      <div className="h-[220px] w-full" data-testid="budget-iteration-chart">
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={data} margin={{ top: 14, right: 16, left: 0, bottom: 0 }}>
            <CartesianGrid stroke="#1E293B" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="label"
              stroke="#64748B"
              tick={{ fill: '#94A3B8', fontSize: 11 }}
              axisLine={{ stroke: '#1E293B' }}
              tickLine={false}
            />
            <YAxis
              domain={[0, yMax]}
              stroke="#64748B"
              tick={{ fill: '#94A3B8', fontSize: 11 }}
              axisLine={{ stroke: '#1E293B' }}
              tickLine={false}
              tickFormatter={(v) => `${v} ₽`}
              width={56}
            />
            <Tooltip content={<CustomBudgetTooltip />} />
            <Legend
              wrapperStyle={{ fontSize: '11px', color: '#CBD5E1', paddingTop: '6px' }}
            />
            <ReferenceLine
              y={budgetRub}
              stroke="#DC2626"
              strokeDasharray="4 4"
              label={{
                value: `Лимит ${budgetRub} ₽`,
                position: 'insideTopRight',
                fill: '#FCA5A5',
                fontSize: 11,
              }}
            />
            <Line
              type="monotone"
              dataKey="cumulativeRub"
              name="Накопительный расход (₽)"
              stroke="#38BDF8"
              strokeWidth={2.5}
              dot={{ r: 4, fill: '#38BDF8', strokeWidth: 0 }}
              activeDot={{ r: 6, fill: '#F8FAFC' }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="iterationCostRub"
              name="Расход за итерацию (₽)"
              stroke="#4ADE80"
              strokeWidth={2}
              dot={{ r: 3.5, fill: '#4ADE80', strokeWidth: 0 }}
              activeDot={{ r: 5 }}
              isAnimationActive={false}
            />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </section>
  );
}

