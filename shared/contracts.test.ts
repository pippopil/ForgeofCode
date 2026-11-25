import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { PlanSchema, FilePatchSchema, ReviewSchema, DebugSchema } from './contracts';
import { resolveInProjectJail, validateFilePatch, isValidUtf8Text } from './pathJail';
import { extractJsonBlock, parseAndValidateJson, truncateTailBytes, computeErrorHash } from './jsonParser';
import { calculateCostRub, fitContextWithinHalfWindow, isBudgetExceeded, maskSecret } from './pricing';

test('PlanSchema validates valid plan and rejects invalid stack', () => {
  const valid = PlanSchema.safeParse({
    stack: 'ts-web',
    files_tree: ['package.json', 'src/App.tsx'],
    tasks: [{ key: 'T1', title: 'Создать интерфейс', dod: 'Сборка проходит без ошибок' }],
    commands: {
      install: 'npm install --ignore-scripts --no-audit --no-fund',
      build: 'npx tsc --noEmit && npm run build',
      test: 'npx vitest run',
    },
  });
  assert.equal(valid.success, true);

  const invalid = PlanSchema.safeParse({ stack: 'ruby', files_tree: [], tasks: [] });
  assert.equal(invalid.success, false);
});

test('FilePatchSchema requires content on create/update and allows delete without content', () => {
  const okDelete = FilePatchSchema.safeParse({
    summary: 'Удалён устаревший файл',
    files: [{ path: 'src/old.ts', action: 'delete' }],
    tasks_completed: ['T1'],
  });
  assert.equal(okDelete.success, true);

  const badCreate = FilePatchSchema.safeParse({
    summary: 'Создание без контента',
    files: [{ path: 'src/new.ts', action: 'create' }],
    tasks_completed: [],
  });
  assert.equal(badCreate.success, false);
});

test('ReviewSchema & DebugSchema validate properly', () => {
  const review = ReviewSchema.safeParse({
    verdict: 'changes_requested',
    findings: [
      {
        severity: 'blocker',
        file: 'src/api.ts',
        problem: 'Отсутствует обработка ошибок fetch',
        fix_instruction: 'Добавить try/catch и возврат 502 при сбое',
      },
    ],
  });
  assert.equal(review.success, true);

  const debug = DebugSchema.safeParse({
    root_cause: 'Неверный импорт модуля',
    fix_instructions: [{ file: 'src/main.ts', change: 'Заменить путь импорта на ./app' }],
  });
  assert.equal(debug.success, true);
});

test('pathJail blocks traversal, absolute paths, .git writes, and allows safe paths', () => {
  const root = path.resolve('/tmp/work/proj-1');
  const safe = resolveInProjectJail(root, 'src/components/Button.tsx');
  assert.equal(safe, path.resolve(root, 'src', 'components', 'Button.tsx'));

  assert.throws(() => resolveInProjectJail(root, '../etc/passwd'));
  assert.throws(() => resolveInProjectJail(root, '/etc/passwd'));
  assert.throws(() => resolveInProjectJail(root, '.git/config'));
  assert.throws(() => resolveInProjectJail(root, 'src/../../outside.ts'));
  assert.throws(() => resolveInProjectJail(root, 'bad\u0000file.ts'));
});

test('validateFilePatch enforces file count, file size, total size, and UTF-8', () => {
  const root = path.resolve('/tmp/work/proj-2');
  assert.equal(isValidUtf8Text('Привет, мир!'), true);
  assert.equal(isValidUtf8Text('bad\u0000text'), false);

  const bigContent = 'a'.repeat(160 * 1024);
  assert.throws(() =>
    validateFilePatch(root, {
      summary: 'Слишком большой файл',
      files: [{ path: 'big.txt', action: 'create', content: bigContent }],
      tasks_completed: [],
    })
  );

  const manyFiles = Array.from({ length: 41 }, (_, i) => ({
    path: `src/f${i}.ts`,
    action: 'create' as const,
    content: 'export const x = 1;',
  }));
  assert.throws(() =>
    validateFilePatch(root, {
      summary: 'Слишком много файлов',
      files: manyFiles,
      tasks_completed: [],
    })
  );

  const ok = validateFilePatch(root, {
    summary: 'Валидный патч',
    files: [{ path: 'src/index.ts', action: 'create', content: 'export const ok = true;\n' }],
    tasks_completed: ['T1'],
  });
  assert.equal(ok.resolvedFiles.length, 1);
  assert.ok(ok.totalBytes > 0);
});

test('extractJsonBlock and parseAndValidateJson parse fenced JSON blocks', () => {
  const llmReply = `Вот результат анализа:\n\`\`\`json\n{"root_cause":"Missing type","fix_instructions":[{"file":"a.ts","change":"add type"}]}\n\`\`\``;
  const extracted = extractJsonBlock(llmReply);
  assert.ok(extracted.startsWith('{'));
  const parsed = parseAndValidateJson(llmReply, DebugSchema);
  assert.equal(parsed.ok, true);
});

test('truncateTailBytes keeps tail within byte limit and computeErrorHash detects repeats', () => {
  const longText = Array.from({ length: 500 }, (_, i) => `Line ${i}: error TS2322`).join('\n');
  const tail = truncateTailBytes(longText, 1024);
  assert.ok(Buffer.byteLength(tail, 'utf8') <= 1200);
  assert.ok(tail.includes('Line 499'));

  const h1 = computeErrorHash('2026-11-25T10:00:00Z Error at src/a.ts:12:4 in 15ms', ['src/a.ts']);
  const h2 = computeErrorHash('2026-11-25T10:05:00Z Error at src/a.ts:19:8 in 42ms', ['src/a.ts']);
  assert.equal(h1, h2);
});

test('pricing, budget, 50% context window, and secret masking work accurately', () => {
  const cost = calculateCostRub(500_000, 100_000, {
    input_rub_per_1m: 100,
    output_rub_per_1m: 400,
  });
  assert.equal(cost, 90);

  assert.equal(
    isBudgetExceeded({
      projectSpentRub: 50,
      projectBudgetRub: 50,
      dailySpentRub: 50,
      dailyBudgetRub: 300,
    }).exceeded,
    true
  );

  assert.equal(
    isBudgetExceeded({
      projectSpentRub: 10,
      projectBudgetRub: 50,
      dailySpentRub: 300,
      dailyBudgetRub: 300,
    }).exceeded,
    true
  );

  const clipped = fitContextWithinHalfWindow(
    'System prompt',
    [{ label: 'Diff', content: 'x'.repeat(50000) }],
    8192
  );
  assert.ok(clipped.length < 25000);
  assert.equal(maskSecret('sk-secret-1234567890abcd'), 'sk-••••abcd');
});
