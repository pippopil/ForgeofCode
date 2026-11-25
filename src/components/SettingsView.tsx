import { useEffect, useState, type FormEvent } from 'react';
import { CheckCircle2, KeyRound, RefreshCw, Save, Zap } from 'lucide-react';
import { api } from '../api';
import type { PricingMap, SettingsResponse } from '../types';

interface SettingsViewProps {
  onSaved: () => void;
}

export function SettingsView({ onSaved }: SettingsViewProps) {
  const [settings, setSettings] = useState<SettingsResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [llmBaseUrl, setLlmBaseUrl] = useState('');
  const [newApiKey, setNewApiKey] = useState('');
  const [coderModel, setCoderModel] = useState('');
  const [architectModel, setArchitectModel] = useState('');
  const [reviewerModel, setReviewerModel] = useState('');
  const [defaultBudgetRub, setDefaultBudgetRub] = useState(50);
  const [dailyBudgetRub, setDailyBudgetRub] = useState(300);
  const [contextWindowTokens, setContextWindowTokens] = useState(64000);
  const [skipReview, setSkipReview] = useState(false);
  const [allowCoderFallback, setAllowCoderFallback] = useState(false);
  const [pricing, setPricing] = useState<PricingMap>({
    architect: { input_rub_per_1m: 25, output_rub_per_1m: 100 },
    coder: { input_rub_per_1m: 120, output_rub_per_1m: 480 },
    reviewer: { input_rub_per_1m: 20, output_rub_per_1m: 80 },
  });
  const [prompts, setPrompts] = useState({
    architect: '',
    coder: '',
    reviewer: '',
  });

  const [modelsList, setModelsList] = useState<string[]>([]);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [pingResult, setPingResult] = useState<string | null>(null);
  const [pingError, setPingError] = useState<string | null>(null);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  async function loadSettings() {
    setLoading(true);
    try {
      const s = await api.getSettings();
      setSettings(s);
      setLlmBaseUrl(s.llm_base_url);
      setCoderModel(s.coder_model);
      setArchitectModel(s.architect_model);
      setReviewerModel(s.reviewer_model);
      setDefaultBudgetRub(s.default_project_budget_rub);
      setDailyBudgetRub(s.daily_budget_rub);
      setContextWindowTokens(s.context_window_tokens);
      setSkipReview(s.skip_review);
      setAllowCoderFallback(s.allow_coder_fallback);
      setPricing(s.pricing);
      const pMap = { architect: '', coder: '', reviewer: '' };
      for (const a of s.agents) {
        pMap[a.role] = a.system_prompt;
      }
      setPrompts(pMap);
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ошибка загрузки настроек');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    loadSettings();
  }, []);

  async function handleSave(e: FormEvent) {
    e.preventDefault();
    setSaving(true);
    setSaveMessage(null);
    setErrorMessage(null);

    try {
      await api.updateSettings({
        llm_base_url: llmBaseUrl.trim(),
        ...(newApiKey.trim() ? { llm_api_key: newApiKey.trim() } : {}),
        coder_model: coderModel.trim(),
        architect_model: architectModel.trim(),
        reviewer_model: reviewerModel.trim(),
        default_project_budget_rub: Number(defaultBudgetRub),
        daily_budget_rub: Number(dailyBudgetRub),
        context_window_tokens: Number(contextWindowTokens),
        skip_review: skipReview,
        allow_coder_fallback: allowCoderFallback,
        pricing,
        agent_prompts: prompts,
      });
      setNewApiKey('');
      setSaveMessage('Настройки сохранены (ключ зашифрован на сервере)');
      await loadSettings();
      onSaved();
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : 'Ошибка сохранения настроек');
    } finally {
      setSaving(false);
    }
  }

  async function handleFetchModels() {
    setModelsLoading(true);
    setPingError(null);
    try {
      const res = await api.getLlmModels();
      setModelsList(res.models);
    } catch (err) {
      setPingError(err instanceof Error ? err.message : 'Не удалось загрузить модели');
    } finally {
      setModelsLoading(false);
    }
  }

  async function handlePing() {
    setPingResult(null);
    setPingError(null);
    try {
      const res = await api.pingLlm(architectModel || coderModel || reviewerModel || undefined);
      setPingResult(
        `Шлюз доступен (${res.latencyMs} мс). Найдено моделей: ${res.modelsCount}.` +
          (res.modelChecked ? ` Проверена: ${res.modelChecked}` : '')
      );
    } catch (err) {
      setPingError(err instanceof Error ? err.message : 'Проверка шлюза не пройдена');
    }
  }

  if (loading) {
    return <div className="p-6 text-sm text-[#94A3B8]">Загрузка настроек...</div>;
  }

  return (
    <div className="p-6 max-w-4xl mx-auto space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-[#F8FAFC] tracking-tight">Настройки</h1>
          <p className="text-sm text-[#94A3B8] mt-1">
            OpenAI-совместимый шлюз в рублях, три модели агентов, тарифы и лимиты бюджета
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={handleFetchModels}
            disabled={modelsLoading}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg border border-[#1E293B] bg-[#111827] hover:bg-[#1E293B] text-xs font-medium text-[#E2E8F0] cursor-pointer whitespace-nowrap"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${modelsLoading ? 'animate-spin' : ''}`} />
            <span>Загрузить модели</span>
          </button>
          <button
            type="button"
            onClick={handlePing}
            className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-lg bg-[#1E293B] hover:bg-[#334155] text-xs font-medium text-[#F8FAFC] cursor-pointer whitespace-nowrap"
          >
            <Zap className="w-3.5 h-3.5 text-[#FBBF24]" />
            <span>Проверить</span>
          </button>
        </div>
      </div>

      {pingResult && (
        <div className="p-3 rounded-lg bg-[#052E16]/60 border border-[#166534] text-xs text-[#86EFAC] flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span>{pingResult}</span>
        </div>
      )}
      {pingError && (
        <div role="alert" className="p-3 rounded-lg bg-[#450A0A]/60 border border-[#991B1B] text-xs text-[#FCA5A5]">
          {pingError}
        </div>
      )}

      <form onSubmit={handleSave} className="space-y-6">
        {/* Подключение к шлюзу */}
        <section className="bg-[#111827] border border-[#1E293B] rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-[#F8FAFC] flex items-center gap-2">
            <KeyRound className="w-4 h-4 text-[#60A5FA]" />
            <span>Подключение к единому LLM-шлюзу</span>
          </h2>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label htmlFor="llm-base-url" className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
                LLM_BASE_URL
              </label>
              <input
                id="llm-base-url"
                type="url"
                value={llmBaseUrl}
                onChange={(e) => setLlmBaseUrl(e.target.value)}
                placeholder="https://api.example.ru/v1"
                className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm font-mono text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
              />
            </div>

            <div>
              <label htmlFor="llm-api-key" className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
                LLM_API_KEY (только запись, в браузер не отдаётся)
              </label>
              <input
                id="llm-api-key"
                type="password"
                value={newApiKey}
                onChange={(e) => setNewApiKey(e.target.value)}
                autoComplete="off"
                placeholder={
                  settings?.has_api_key
                    ? `Сохранён (${settings.masked_api_key}, источник: ${settings.api_key_source})`
                    : 'Введите новый API-ключ...'
                }
                className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm font-mono text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
              />
              {settings && !settings.has_env_master_key && (
                <p className="text-[11px] text-[#FBBF24] mt-1">
                  Внимание: MASTER_KEY не задан в .env — при перезапуске ключ из БД сбросится.
                </p>
              )}
            </div>
          </div>

          <datalist id="gateway-models-list">
            {modelsList.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2 items-end">
            <div>
              <label htmlFor="architect-model" className="block text-xs font-medium text-[#CBD5E1] mb-1.5 whitespace-nowrap truncate">
                ARCHITECT_MODEL (план и отладка)
              </label>
              <input
                id="architect-model"
                type="text"
                list="gateway-models-list"
                value={architectModel}
                onChange={(e) => setArchitectModel(e.target.value)}
                placeholder="Например: deepseek-reasoner"
                className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm font-mono text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
              />
            </div>

            <div>
              <label htmlFor="coder-model" className="block text-xs font-medium text-[#CBD5E1] mb-1.5 whitespace-nowrap truncate">
                CODER_MODEL (запись файлов)
              </label>
              <input
                id="coder-model"
                type="text"
                list="gateway-models-list"
                value={coderModel}
                onChange={(e) => setCoderModel(e.target.value)}
                placeholder="Например: gemini-2.5-pro"
                className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm font-mono text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
              />
            </div>

            <div>
              <label htmlFor="reviewer-model" className="block text-xs font-medium text-[#CBD5E1] mb-1.5 whitespace-nowrap truncate">
                REVIEWER_MODEL (ревью git diff)
              </label>
              <input
                id="reviewer-model"
                type="text"
                list="gateway-models-list"
                value={reviewerModel}
                onChange={(e) => setReviewerModel(e.target.value)}
                placeholder="Например: qwen-2.5-coder-32b"
                className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm font-mono text-[#F8FAFC] focus:outline-none focus:border-[#2563EB]"
              />
            </div>
          </div>
        </section>

        {/* Цены ₽/1M и лимиты */}
        <section className="bg-[#111827] border border-[#1E293B] rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-[#F8FAFC]">Тарифы (₽ / 1M токенов) и лимиты бюджета</h2>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse text-xs">
              <thead>
                <tr className="border-b border-[#1E293B] text-[#94A3B8]">
                  <th className="py-2 pr-4">Агент</th>
                  <th className="py-2 pr-4">Вход (₽ / 1M токенов)</th>
                  <th className="py-2">Выход (₽ / 1M токенов)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1E293B]">
                {(
                  [
                    ['architect', 'Архитектор'],
                    ['coder', 'Кодер'],
                    ['reviewer', 'Ревьюер'],
                  ] as const
                ).map(([role, title]) => (
                  <tr key={role}>
                    <td className="py-2.5 pr-4 font-medium text-[#E2E8F0]">{title}</td>
                    <td className="py-2.5 pr-4">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`Цена входа ${title}`}
                        value={pricing[role].input_rub_per_1m}
                        onChange={(e) =>
                          setPricing((prev) => ({
                            ...prev,
                            [role]: { ...prev[role], input_rub_per_1m: Number(e.target.value) },
                          }))
                        }
                        className="w-36 px-2.5 py-1.5 bg-[#0B0F17] border border-[#1E293B] rounded font-mono tabular-nums text-[#F8FAFC]"
                      />
                    </td>
                    <td className="py-2.5">
                      <input
                        type="number"
                        min={0}
                        step="0.01"
                        aria-label={`Цена выхода ${title}`}
                        value={pricing[role].output_rub_per_1m}
                        onChange={(e) =>
                          setPricing((prev) => ({
                            ...prev,
                            [role]: { ...prev[role], output_rub_per_1m: Number(e.target.value) },
                          }))
                        }
                        className="w-36 px-2.5 py-1.5 bg-[#0B0F17] border border-[#1E293B] rounded font-mono tabular-nums text-[#F8FAFC]"
                      />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 pt-2">
            <div>
              <label htmlFor="default-budget" className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
                Бюджет проекта по умолчанию (₽)
              </label>
              <input
                id="default-budget"
                type="number"
                min={1}
                value={defaultBudgetRub}
                onChange={(e) => setDefaultBudgetRub(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm font-mono tabular-nums text-[#F8FAFC]"
              />
            </div>

            <div>
              <label htmlFor="daily-budget" className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
                Суточный бюджет (₽)
              </label>
              <input
                id="daily-budget"
                type="number"
                min={1}
                value={dailyBudgetRub}
                onChange={(e) => setDailyBudgetRub(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm font-mono tabular-nums text-[#F8FAFC]"
              />
            </div>

            <div>
              <label htmlFor="context-window" className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
                Окно контекста модели (токены, лимит ≤50%)
              </label>
              <input
                id="context-window"
                type="number"
                min={4096}
                step={1024}
                value={contextWindowTokens}
                onChange={(e) => setContextWindowTokens(Number(e.target.value))}
                className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-sm font-mono tabular-nums text-[#F8FAFC]"
              />
            </div>
          </div>

          <div className="flex flex-wrap gap-5 pt-2">
            <label className="inline-flex items-center gap-2 text-xs text-[#CBD5E1] cursor-pointer">
              <input
                type="checkbox"
                checked={skipReview}
                onChange={(e) => setSkipReview(e.target.checked)}
              />
              <span>SKIP_REVIEW (пропускать ревью для экономии)</span>
            </label>

            <label className="inline-flex items-center gap-2 text-xs text-[#CBD5E1] cursor-pointer">
              <input
                type="checkbox"
                checked={allowCoderFallback}
                onChange={(e) => setAllowCoderFallback(e.target.checked)}
              />
              <span>ALLOW_CODER_FALLBACK (автозамена Кодера на Архитектора при сбое)</span>
            </label>
          </div>
        </section>

        {/* Системные промпты агентов (Seed) */}
        <section className="bg-[#111827] border border-[#1E293B] rounded-xl p-5 space-y-4">
          <h2 className="text-sm font-semibold text-[#F8FAFC]">Системные промпты агентов</h2>
          {(
            [
              ['architect', 'Архитектор (план и отладка)'],
              ['coder', 'Кодер (FilePatch JSON)'],
              ['reviewer', 'Ревьюер (Review JSON)'],
            ] as const
          ).map(([role, label]) => (
            <div key={role}>
              <label htmlFor={`prompt-${role}`} className="block text-xs font-medium text-[#CBD5E1] mb-1.5">
                {label}
              </label>
              <textarea
                id={`prompt-${role}`}
                rows={3}
                value={prompts[role]}
                onChange={(e) =>
                  setPrompts((prev) => ({ ...prev, [role]: e.target.value }))
                }
                className="w-full px-3 py-2 bg-[#0B0F17] border border-[#1E293B] rounded-lg text-xs font-mono text-[#E2E8F0] focus:outline-none focus:border-[#2563EB]"
              />
            </div>
          ))}
        </section>

        {saveMessage && (
          <div className="p-3 rounded-lg bg-[#052E16]/60 border border-[#166534] text-xs text-[#86EFAC]">
            {saveMessage}
          </div>
        )}
        {errorMessage && (
          <div role="alert" className="p-3 rounded-lg bg-[#450A0A]/60 border border-[#991B1B] text-xs text-[#FCA5A5]">
            {errorMessage}
          </div>
        )}

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-5 py-2.5 rounded-lg bg-[#2563EB] hover:bg-[#1D4ED8] disabled:opacity-50 text-sm font-medium text-white cursor-pointer"
          >
            <Save className="w-4 h-4" />
            <span>{saving ? 'Сохранение...' : 'Сохранить настройки'}</span>
          </button>
        </div>
      </form>
    </div>
  );
}
