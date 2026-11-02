import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { aggregateComparisons, analyzeGroup, checkEngine, codeLines, comparisonBatches, comparisonsForBatch, languageFor, type Comparison, type Submission } from '../src/lib/code-check/engine';
import { submissionTiming } from '../src/lib/code-check/submission-time';

const options = { parserPath: path.join(process.cwd(), 'vendor/contest-code-check/tokens'), workerPath: path.join(process.cwd(), 'vendor/contest-code-check/token-worker.cjs'), heapMb: 512, timeoutSeconds: 45, minTokens: 5 };
const code = 'int sum(int new){int class=0;for(int i=0;i<new;i++){class+=i*i;}return class;}';
const renamed = code.replace(/\bnew\b/g, 'count').replace(/\bclass\b/g, 'total').replace(/\bi\b/g, 'item');
const source = (id: string, uid: number, value = renamed, lang = 'cpp.17', pid = 1): Submission => ({ id, uid, code: value, lang, pid });

test('portable grammar worker compares renamed C/C++ with local CUID submission IDs', async () => {
  await checkEngine(options);
  const submissions = [source('cmcuidlocal1', 1, code, 'c.gcc'), source('cmcuidlocal2', 2, `// Comment\n${renamed.replace(/;/g, ';\n')}`)];
  const result = await analyzeGroup(submissions, options);
  assert.deepEqual(result.failed, []);
  assert.equal(result.comparisons.length, 1);
  assert.equal(result.comparisons[0].similarities.AVG, 1);
  assert.ok(result.comparisons[0].matches.length > 0);
  assert.ok(codeLines(code, result.comparisons[0].matches, 'First').some(line => line.blocks.length > 0));
});

test('function names, constants and operators remain significant syntax tokens', async () => {
  const result = await analyzeGroup([source('local-a', 1), source('local-b', 2, renamed.replace('sum(', 'average(').replace('+=item*item', '+=item+42'))], options);
  assert.deepEqual(result.failed, []);
  assert.ok(result.comparisons[0].similarities.AVG < 1);
});

test('small batches cover every historical submission pair once and retain each contestant maximum', async () => {
  const submissions = [source('a1', 1), source('b1', 2, renamed.replace('+=item*item', '+=item+42')), source('a2', 1, renamed.replace('return total', 'return total+3')), source('b2', 2), source('c1', 3)];
  const comparisons: Comparison[] = [];
  const seen = new Set<string>();
  for (const batch of comparisonBatches(submissions.map(item => item.id), 4)) {
    const result = await analyzeGroup(submissions.filter(item => batch.ids.includes(item.id)), options);
    for (const item of comparisonsForBatch(result.comparisons, batch)) {
      const key = [item.firstSubmissionId, item.secondSubmissionId].sort().join(':');
      assert.equal(seen.has(key), false); seen.add(key); comparisons.push(item);
    }
  }
  assert.equal(comparisons.length, 8);
  const pairs = aggregateComparisons(comparisons, submissions);
  assert.equal(pairs.length, 3);
  const strongest = pairs.find(pair => [pair.first.uid, pair.second.uid].sort().join(':') === '1:2')!;
  assert.equal(strongest.versions, 4);
  assert.equal(strongest.comparison.similarities.AVG, 1);
  assert.deepEqual(new Set([strongest.first.id, strongest.second.id]), new Set(['a1', 'b2']));
});

test('same contestant is never compared to itself and unsupported languages never fall back to text', async () => {
  assert.equal(languageFor('ruby'), null);
  const result = await analyzeGroup([source('a1', 1), source('a2', 1), source('b1', 2)], options);
  assert.equal(result.comparisons.length, 2);
  await assert.rejects(analyzeGroup([source('bad', 1, 'text', 'ruby')], options), /不支持/);
  await assert.rejects(analyzeGroup([source('a1', 1), source('b1', 2, renamed, 'java')], options), /无效/);
});

test('administrator cancellation actually terminates a live syntax worker', async () => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error('管理员停止')), 10);
  try { await assert.rejects(analyzeGroup([source('a1', 1), source('b1', 2)], { ...options, signal: controller.signal }), /管理员停止/); }
  finally { clearTimeout(timer); }
});

test('local snapshot timestamps determine order and exact time difference without external record IDs', () => {
  const result = submissionTiming({ id: 'local-first', submittedAt: '2026-10-07T06:00:00.000Z' }, { id: 'local-second', submittedAt: '2026-10-07T06:01:05.000Z' });
  assert.equal(result.earlier, 'first'); assert.equal(result.differenceSeconds, 65); assert.equal(result.differenceText, '1 分钟 5 秒');
  assert.equal(submissionTiming({ id: 'local-first' }, { id: 'local-second' }).earlier, null);
});
