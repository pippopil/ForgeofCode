import { useMemo } from 'react';
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
  type IterationCostPoint,
} from '../../shared/projectAnalytics';
import type { AgentEventDTO } from '../types';

interface BudgetIterationChartProps {
  events: AgentEventDTO[];
  currentIteration: number;
  budgetRub: number;
  spentRub: number;
}

interface ChartTooltipProps {
  active?: boolean;
  payload?: Array<{ payload: IterationCostPoint }>;
}

function CustomBudgetTooltip({ active, payload }: ChartTooltipProps) {
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

export function BudgetIterationChart({
  events,
  currentIteration,
  budgetRub,
  spentRub,
}: BudgetIterationChartProps) {
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
        <ResponsiveContainer width="100%" height="100%">
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
