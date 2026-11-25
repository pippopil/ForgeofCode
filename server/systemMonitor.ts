import fs from 'node:fs';
import os from 'node:os';
import type { SystemMetricsSnapshot } from '../shared/contracts';
import { config } from './config';
import { db, getDailySpentRub, getResolvedSettings } from './db';

const KOTLIN_MIN_RAM_BYTES = 3 * 1024 * 1024 * 1024; // 3 ГБ

interface CpuSnapshot {
  idle: number;
  total: number;
}

function readCpuTimes(): CpuSnapshot {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total +=
      cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }
  return { idle, total };
}

function readDiskStats(targetDir: string): { total: number; free: number } {
  try {
    const stat = fs.statfsSync(targetDir);
    const total = Number(stat.blocks) * Number(stat.bsize);
    const free = Number(stat.bavail) * Number(stat.bsize);
    return { total, free };
  } catch {
    return { total: 0, free: 0 };
  }
}

export class SystemMonitor {
  private prevCpu: CpuSnapshot = readCpuTimes();
  private lastCpuPercent = 0;
  private startTime = Date.now();
  private timer: NodeJS.Timeout | null = null;
  private wsClientCounter: () => number = () => 0;
  private onMetricsCallback: ((snapshot: SystemMetricsSnapshot) => void) | null = null;

  public configure(opts: {
    getWsClientCount: () => number;
    onMetrics: (snapshot: SystemMetricsSnapshot) => void;
  }): void {
    this.wsClientCounter = opts.getWsClientCount;
    this.onMetricsCallback = opts.onMetrics;
  }

  public start(intervalMs = 2000): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      const snapshot = this.getSnapshot();
      this.onMetricsCallback?.(snapshot);
    }, intervalMs);
    this.timer.unref();
  }

  public stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  public getSnapshot(): SystemMetricsSnapshot {
    const currentCpu = readCpuTimes();
    const totalDiff = currentCpu.total - this.prevCpu.total;
    const idleDiff = currentCpu.idle - this.prevCpu.idle;
    if (totalDiff > 0) {
      const usage = ((totalDiff - idleDiff) / totalDiff) * 100;
      this.lastCpuPercent = Math.max(0, Math.min(100, Math.round(usage * 10) / 10));
      this.prevCpu = currentCpu;
    }

    const ramTotalBytes = os.totalmem();
    const ramFreeBytes = os.freemem();
    const ramUsedBytes = Math.max(0, ramTotalBytes - ramFreeBytes);
    const disk = readDiskStats(config.workDir);

    const kotlinSupported = ramTotalBytes >= KOTLIN_MIN_RAM_BYTES;
    const kotlinDisabledReason = kotlinSupported
      ? null
      : `Недостаточно ОЗУ (${(ramTotalBytes / (1024 * 1024 * 1024)).toFixed(1)} ГБ < 3.0 ГБ для Gradle JVM)`;

    const activeRow = db
      .prepare(`SELECT id FROM projects WHERE status = 'running' LIMIT 1`)
      .get() as { id: string } | undefined;
    const queueRow = db
      .prepare(`SELECT COUNT(*) AS cnt FROM projects WHERE status = 'queued'`)
      .get() as { cnt: number };

    const settings = getResolvedSettings();

    return {
      timestamp: new Date().toISOString(),
      appMode: config.appMode,
      runnerMode: config.runnerMode,
      cpuPercent: this.lastCpuPercent,
      cpuCores: os.cpus().length,
      ramTotalBytes,
      ramUsedBytes,
      ramFreeBytes,
      diskTotalBytes: disk.total,
      diskFreeBytes: disk.free,
      kotlinSupported,
      kotlinDisabledReason,
      activeProjectId: activeRow?.id ?? null,
      queueLength: queueRow.cnt,
      wsClients: this.wsClientCounter(),
      dailySpentRub: getDailySpentRub(),
      dailyBudgetRub: settings.dailyBudgetRub,
      uptimeSeconds: Math.floor((Date.now() - this.startTime) / 1000),
    };
  }
}

export const systemMonitor = new SystemMonitor();
