import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildIterationBudgetSeries,
  formatIterationLogsTxt,
  getIterationLogSummaries,
} from './projectAnalytics';

test('buildIterationBudgetSeries aggregates per-iteration and cumulative ruble spend', () => {
  const series = buildIterationBudgetSeries(
    [
      { iteration: 0, agent_role: 'architect', cost_rub: 1.5, prompt_tokens: 1000, completion_tokens: 500 },
      { iteration: 0, agent_role: 'coder', cost_rub: 8.25, prompt_tokens: 2000, completion_tokens: 1000 },
      { iteration: 1, agent_role: 'reviewer', cost_rub: 0.75, prompt_tokens: 800, completion_tokens: 200 },
      { iteration: 1, agent_role: 'coder', cost_rub: 4.5, prompt_tokens: 1500, completion_tokens: 800 },
    ],
    1,
    50
  );

  assert.equal(series.length, 2);
  assert.equal(series[0].iterationCostRub, 9.75);
  assert.equal(series[0].cumulativeRub, 9.75);
  assert.equal(series[0].architectRub, 1.5);
  assert.equal(series[0].coderRub, 8.25);

  assert.equal(series[1].iterationCostRub, 5.25);
  assert.equal(series[1].cumulativeRub, 15);
  assert.equal(series[1].reviewerRub, 0.75);
  assert.equal(series[1].budgetRub, 50);
});

test('buildIterationBudgetSeries handles empty events gracefully', () => {
  const series = buildIterationBudgetSeries([], 0, 50);
  assert.equal(series.length, 1);
  assert.equal(series[0].label, 'Итер. 0');
  assert.equal(series[0].cumulativeRub, 0);
  assert.equal(series[0].budgetRub, 50);
});

test('formatIterationLogsTxt filters runs by iteration and formats stdout/stderr cleanly', () => {
  const runs = [
    {
      id: 'r1',
      iteration: 0,
      stage: 'BUILD',
      command: 'npx tsc --noEmit',
      exit_code: 2,
      timed_out: 0,
      duration_ms: 1420,
      stdout: '',
      stderr: 'src/App.tsx(3,5): error TS2322',
      created_at: '2026-11-25T10:00:00Z',
    },
    {
      id: 'r2',
      iteration: 0,
      stage: 'TEST',
      command: 'npx vitest run',
      exit_code: 0,
      timed_out: 0,
      duration_ms: 890,
      stdout: '1 passed',
      stderr: '',
      created_at: '2026-11-25T10:01:00Z',
    },
    {
      id: 'r3',
      iteration: 1,
      stage: 'BUILD',
      command: 'npm run build',
      exit_code: 0,
      timed_out: 0,
      duration_ms: 2100,
      stdout: 'dist/index.html',
      stderr: '',
      created_at: '2026-11-25T10:02:00Z',
    },
  ];

  const summaries = getIterationLogSummaries(runs, 1);
  assert.deepEqual(summaries, [
    { iteration: 0, count: 2 },
    { iteration: 1, count: 1 },
  ]);

  const txtIter0 = formatIterationLogsTxt({
    project: { id: 'proj_abc', name: 'Demo', stack: 'ts-web', status: 'failed', stage: 'BUILD' },
    iteration: 0,
    commandRuns: runs,
    exportedAt: '2026-11-25T10:05:00Z',
  });

  assert.ok(txtIter0.includes('ИТЕРАЦИЯ 0'));
  assert.ok(txtIter0.includes('npx tsc --noEmit'));
  assert.ok(txtIter0.includes('error TS2322'));
  assert.ok(txtIter0.includes('npx vitest run'));
  assert.ok(!txtIter0.includes('dist/index.html'));
});
