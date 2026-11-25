import { useState, type FormEvent } from 'react';
import { AlertTriangle, Rocket } from 'lucide-react';
import { api } from '../api';
import { STACK_LABELS, type StackType, type SystemMetricsSnapshot } from '../types';

interface NewProjectViewProps {
  metrics: SystemMetricsSnapshot | null;
  defaultBudgetRub: number;
  defaultSkipReview: boolean;
  onCreated: (projectId: string) => void;
  onCancel: () => void;
}

const STACK_DESCRIPTIONS: Record<StackType, string> = {
  'ts-web': 'Vite + React + TypeScript + Vitest (сборка tsc + vite build)',
  'node-api': 'Node.js 22 + Express + TypeScript + Vitest',
  python: 'Python 3 venv + FastAPI/CLI + ruff + compileall + pytest',
  kotlin: 'Gradle JVM + Kotlin 2.1 + JUnit 5 (требует ≥ 3 ГБ ОЗУ)',
};

export function NewProjectView({
  metrics,
  defaultBudgetRub,
  defaultSkipReview,
  onCreated,
  onCancel,
}: NewProjectViewProps) {
  const [name, setName] = useState('');
  const [spec, setSpec] = useState('');
  const [stack, setStack] = useState<StackType>('ts-web');
  const [budgetRub, setBudgetRub] = useState(defaultBudgetRub || 50);
  const [skipReview, setSkipReview] = useState(defaultSkipReview);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const kotlinSupported = metrics ? metrics.kotlinSupported : true;

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const res = await api.createProject({
        name: name.trim(),
        spec: spec.trim(),
        stack,
        budget_rub: Number(budgetRub),
        skip_review: skipReview,
      });
      onCreated(res.project.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не удалось создать проект');
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div className="p-6 max-w-3xl mx-auto space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-[#F8FAFC] tracking-tight">Новый проект</h1>
        <p className="text-sm text-[#94A3B8] mt-1">
          Опишите техническое задание, выберите целевой стек и задайте лимит стоимости генерации
        </p>
      </div>

      <form onSubmit={handleSubmit} className="bg-[#111827] border border-[#1E293B] rounded-xl p-6 space-y-6">
        <div>
          <label htmlFor="project-name" className="block text-sm font-medium text-[#E2E8F0] mb-1.5">
            Название проекта
          </label>
          <input
            id="project-name"
            type="text"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            minLength={2}
            maxLength={120}
            placeholder="Например: Калькулятор смет и PDF-экспорт"
            className="w-full px-3.5 py-2.5 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
          />
        </div>

        <div>
          <span className="block text-sm font-medium text-[#E2E8F0] mb-2">Технологический стек</span>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {(['ts-web', 'node-api', 'python', 'kotlin'] as StackType[]).map((item) => {
              const disabled = item === 'kotlin' && !kotlinSupported;
              const selected = stack === item;
              return (
                <button
                  key={item}
                  type="button"
                  disabled={disabled}
                  onClick={() => setStack(item)}
                  className={`text-left p-4 rounded-lg border transition-colors ${
                    disabled
                      ? 'bg-[#0B0F17]/60 border-[#1E293B] opacity-50 cursor-not-allowed'
                      : selected
                        ? 'bg-[#2563EB]/10 border-[#2563EB] cursor-pointer'
                        : 'bg-[#0B0F17] border-[#1E293B] hover:border-[#334155] cursor-pointer'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="text-sm font-medium text-[#F8FAFC]">{STACK_LABELS[item]}</span>
                    <span className="text-xs font-mono text-[#64748B]">{item}</span>
                  </div>
                  <p className="text-xs text-[#94A3B8] mt-1">{STACK_DESCRIPTIONS[item]}</p>
                  {disabled && (
                    <p className="text-xs text-[#F87171] mt-1.5 inline-flex items-center gap-1">
                      <AlertTriangle className="w-3.5 h-3.5" />
                      <span>{metrics?.kotlinDisabledReason ?? 'Недостаточно ОЗУ (< 3 ГБ)'}</span>
                    </p>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        <div>
          <label htmlFor="project-spec" className="block text-sm font-medium text-[#E2E8F0] mb-1.5">
            Техническое задание (ТЗ)
          </label>
          <textarea
            id="project-spec"
            rows={7}
            value={spec}
            onChange={(e) => setSpec(e.target.value)}
            required
            minLength={10}
            placeholder="Подробно опишите требования к приложению, ключевые сценарии, API-эндпоинты и тесты..."
            className="w-full px-3.5 py-2.5 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
          />
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 items-end">
          <div>
            <label htmlFor="project-budget" className="block text-sm font-medium text-[#E2E8F0] mb-1.5">
              Бюджет проекта (₽)
            </label>
            <input
              id="project-budget"
              type="number"
              min={1}
              max={50000}
              step={1}
              value={budgetRub}
              onChange={(e) => setBudgetRub(Number(e.target.value))}
              className="w-full px-3.5 py-2.5 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm font-mono tabular-nums text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
            />
          </div>

          <label className="flex items-center gap-2.5 py-2.5 px-3 rounded-lg bg-[#0B0F17] border border-[#1E293B] cursor-pointer">
            <input
              type="checkbox"
              checked={skipReview}
              onChange={(e) => setSkipReview(e.target.checked)}
              className="rounded border-[#334155] bg-[#111827]"
            />
            <span className="text-xs text-[#CBD5E1]">Пропустить шаг ревью кода (SKIP_REVIEW)</span>
          </label>
        </div>

        {error && (
          <div role="alert" className="p-3 rounded-lg bg-[#450A0A]/60 border border-[#991B1B] text-xs text-[#FCA5A5]">
            {error}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 pt-2">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2.5 rounded-lg border border-[#1E293B] text-sm text-[#CBD5E1] hover:bg-[#1E293B] transition-colors cursor-pointer"
          >
            Отмена
          </button>
          <button
            type="submit"
            disabled={submitting}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-sm font-medium text-white transition-colors cursor-pointer whitespace-nowrap"
          >
            <Rocket className="w-4 h-4" />
            <span>{submitting ? 'Создание...' : 'Создать и запустить'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
