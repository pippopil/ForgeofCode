import { AlertTriangle, Cpu, HardDrive, MemoryStick, Wifi, WifiOff } from 'lucide-react';
import type { SystemMetricsSnapshot } from '../types';

interface SystemBannerProps {
  metrics: SystemMetricsSnapshot | null;
  wsConnected: boolean;
}

function formatGb(bytes: number): string {
  return (bytes / (1024 * 1024 * 1024)).toFixed(1);
}

export function SystemBanner({ metrics, wsConnected }: SystemBannerProps) {
  if (!metrics) {
    return (
      <div className="border-b border-[#1E293B] bg-[#0F172A] px-6 py-2.5 text-xs text-[#94A3B8] flex items-center justify-between">
        <span>Загрузка системной телеметрии...</span>
      </div>
    );
  }

  const isProcessFallback = metrics.runnerMode === 'process';
  const ramPct =
    metrics.ramTotalBytes > 0
      ? Math.round((metrics.ramUsedBytes / metrics.ramTotalBytes) * 100)
      : 0;

  return (
    <div className="border-b border-[#1E293B] bg-[#0F172A] px-6 py-2.5 text-xs flex flex-wrap items-center justify-between gap-4">
      <div className="flex flex-wrap items-center gap-4 text-[#CBD5E1]">
        <span className="font-mono tabular-nums">
          Режим: <strong className="text-[#F8FAFC]">{metrics.appMode}</strong>
        </span>
        <span className="text-[#475569]" aria-hidden="true">·</span>
        <span className="font-mono tabular-nums">
          RUNNER_MODE: <strong className="text-[#F8FAFC]">{metrics.runnerMode}</strong>
        </span>

        {isProcessFallback && (
          <>
            <span className="text-[#475569]" aria-hidden="true">·</span>
            <span className="inline-flex items-center gap-1.5 text-[#FBBF24]">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>Сниженная изоляция (без Docker-песочницы)</span>
            </span>
          </>
        )}

        {!metrics.kotlinSupported && (
          <>
            <span className="text-[#475569]" aria-hidden="true">·</span>
            <span className="text-[#F87171]">
              Kotlin недоступен (ОЗУ &lt; 3 ГБ)
            </span>
          </>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-5 font-mono tabular-nums text-[#CBD5E1]">
        <span className="inline-flex items-center gap-1.5" title="Загрузка процессора">
          <Cpu className="w-3.5 h-3.5 text-[#60A5FA]" />
          CPU {metrics.cpuPercent.toFixed(0)}% ({metrics.cpuCores})
        </span>
        <span className="inline-flex items-center gap-1.5" title="Оперативная память">
          <MemoryStick className="w-3.5 h-3.5 text-[#60A5FA]" />
          ОЗУ {formatGb(metrics.ramUsedBytes)}/{formatGb(metrics.ramTotalBytes)} ГБ ({ramPct}%)
        </span>
        <span className="inline-flex items-center gap-1.5" title="Свободное место на диске">
          <HardDrive className="w-3.5 h-3.5 text-[#60A5FA]" />
          Диск своб. {formatGb(metrics.diskFreeBytes)} ГБ
        </span>
        <span className="text-[#94A3B8]">
          Сутки: <strong className="text-[#F8FAFC]">{metrics.dailySpentRub.toFixed(2)} ₽</strong> /{' '}
          {metrics.dailyBudgetRub} ₽
        </span>
        <span
          className={`inline-flex items-center gap-1.5 ${
            wsConnected ? 'text-[#4ADE80]' : 'text-[#FBBF24]'
          }`}
        >
          {wsConnected ? <Wifi className="w-3.5 h-3.5" /> : <WifiOff className="w-3.5 h-3.5" />}
          <span>{wsConnected ? 'WS онлайн' : 'WS реконнект'}</span>
        </span>
      </div>
    </div>
  );
}
