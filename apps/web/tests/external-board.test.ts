import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { normalizeExamSettings } from '../src/lib/exam-settings';
import { ExternalBoardCredentialError, externalBoardEndpoint, externalBoardFallbackKey, externalBoardProblem, externalBoardSubmission } from '../src/lib/external-board-payload';
import { ExternalBoardPatchSchema } from '../src/lib/external-board-settings';
import { appendExternalBoardLog, readExternalBoardLogs } from '../src/lib/external-board-log';

const base = CreateExamSchema.parse({ name: '外榜测试', startAt: '2026-10-11T08:00:00Z', latestStartAt: '2026-10-11T08:00:00Z', endAt: '2026-10-11T10:00:00Z', durationMinutes: 120, platform: 'HYDRO', contestType: 'INDIVIDUAL' });
const problem = { id: 'problem-1', order: 26, title: '测试题', score: 80, hydroScore: 200, timeLimitMs: 1000, memoryLimitMb: 256 };
const submission = { id: 'submission-1', status: 1, statusText: 'Accepted', judgeAt: new Date(), score: 100, manualScore: null, lang: 'cc.cc17o2', code: 'int main() {}', time: 12, memory: 4096, createdAt: new Date('2026-10-11T08:00:01.123Z') };

test('exam-controlled endpoints cannot receive the system external-login credential', () => {
  const settings = { apiBase: 'https://www.example.org/api', appKey: ' system-secret ' };
  assert.equal(externalBoardFallbackKey('https://www.example.org/api/', settings), 'system-secret');
  for (const target of ['https://attacker.test/api', 'http://www.example.org/api', 'https://www.example.org:8443/api', 'https://www.example.org.attacker.test/api', 'https://www.example.org@attacker.test/api', 'https://attacker@www.example.org/api', 'file:///api', 'invalid']) {
    assert.throws(() => externalBoardFallbackKey(target, settings), ExternalBoardCredentialError, target);
  }
});

test('live logs isolate exams, show newest results first and bound temporary history', () => {
  const examId = 'live-log-retention';
  for (let index = 0; index < 105; index++) appendExternalBoardLog({ examId, status: 'SUCCESS', message: `batch ${index}`, submissionCount: index });
  appendExternalBoardLog({ examId: 'another-live-exam', status: 'ERROR', message: 'receiver rejected' });
  const logs = readExternalBoardLogs(examId);
  assert.equal(logs.length, 100);
  assert.equal(logs[0].message, 'batch 104'); assert.equal(logs[0].submissionCount, 104);
  assert.equal(logs[99].message, 'batch 5');
  assert.equal(readExternalBoardLogs('another-live-exam')[0].status, 'ERROR');
  logs[0].message = 'mutated API result'; logs.pop();
  assert.equal(readExternalBoardLogs(examId).length, 100);
  assert.equal(readExternalBoardLogs(examId)[0].message, 'batch 104');
});

test('a new service process starts with no previous logs', () => {
  const examId = 'restart-log-fixture';
  appendExternalBoardLog({ examId, status: 'INFO', message: 'before restart' });
  assert.equal(readExternalBoardLogs(examId).length, 1);
  const moduleUrl = new URL('../src/lib/external-board-log.ts', import.meta.url).href;
  const source = `import { readExternalBoardLogs } from ${JSON.stringify(moduleUrl)}; process.stdout.write(JSON.stringify(readExternalBoardLogs(${JSON.stringify(examId)})));`;
  const result = execFileSync(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', source], { encoding: 'utf8' });
  assert.deepEqual(JSON.parse(result), []);
});

test('live configuration patches preserve omitted switch, key and target fields and reject ordinary exam settings', () => {
  assert.deepEqual(ExternalBoardPatchSchema.parse({ externalBoardEnabled: false }), { externalBoardEnabled: false });
  assert.deepEqual(ExternalBoardPatchSchema.parse({ externalBoardEventId: '123' }), { externalBoardEventId: '123' });
  assert.deepEqual(ExternalBoardPatchSchema.parse({ externalBoardApiKey: '' }), { externalBoardApiKey: '' });
  assert.deepEqual(ExternalBoardPatchSchema.parse({ externalBoardBaseUrl: 'www.example.org' }), { externalBoardBaseUrl: 'https://www.example.org/api' });
  assert.equal(ExternalBoardPatchSchema.safeParse({ name: 'must not change' }).success, false);
  assert.equal(ExternalBoardPatchSchema.safeParse({}).success, false);
  assert.deepEqual(ExternalBoardPatchSchema.parse({ externalBoardIntervalSeconds: 60 }), { externalBoardIntervalSeconds: 60 });
});

test('push intervals default to ten seconds and accept only whole seconds from one to one day', () => {
  assert.equal(base.externalBoardIntervalSeconds, 10);
  for (const value of [1, 30, 86400]) assert.equal(ExternalBoardPatchSchema.parse({ externalBoardIntervalSeconds: value }).externalBoardIntervalSeconds, value);
  for (const value of [0, -1, 1.5, 86401, '10', null]) assert.equal(ExternalBoardPatchSchema.safeParse({ externalBoardIntervalSeconds: value }).success, false);
});

test('external push is opt-in; enabling requires a China website event ID without changing exam rules', () => {
  assert.equal(base.externalBoardEnabled, false);
  assert.equal(normalizeExamSettings(base).externalBoardEventId, null);
  assert.equal(normalizeExamSettings(base).externalBoardBaseUrl, 'https://www.example.org/api');
  assert.equal(normalizeExamSettings({ ...base, externalBoardBaseUrl: '' }).externalBoardBaseUrl, 'https://www.example.org/api');
  assert.throws(() => normalizeExamSettings({ ...base, externalBoardEnabled: true }), /官网赛事 ID/);
  assert.throws(() => normalizeExamSettings({ ...base, externalBoardEnabled: true, externalBoardBaseUrl: 'https://www.example.org/api' }), /官网赛事 ID/);
  const enabled = normalizeExamSettings({ ...base, externalBoardEnabled: true, externalBoardBaseUrl: 'https://www.example.org/api', externalBoardEventId: ' 123 ' });
  assert.equal(enabled.externalBoardEventId, '123');
  assert.equal(enabled.contestRule, base.contestRule);
  assert.equal(normalizeExamSettings({ ...base, externalBoardApiKey: '  custom-key  ' }).externalBoardApiKey, 'custom-key');
  assert.equal(normalizeExamSettings({ ...base, externalBoardApiKey: '' }).externalBoardApiKey, null);
  for (const id of ['0', '-1', '1/2', '1.2', '1e3', '9223372036854775808']) {
    assert.equal(CreateExamSchema.safeParse({ ...base, externalBoardEventId: id }).success, false);
  }
  assert.equal(CreateExamSchema.parse({ ...base, externalBoardEventId: '9223372036854775807' }).externalBoardEventId, '9223372036854775807');
  assert.equal(CreateExamSchema.parse({ ...base, externalBoardBaseUrl: 'www.example.org' }).externalBoardBaseUrl, 'https://www.example.org/api');
  assert.equal(CreateExamSchema.parse({ ...base, externalBoardBaseUrl: 'https://www.example.org/api/' }).externalBoardBaseUrl, 'https://www.example.org/api');
  for (const domain of ['https://example.com/other', 'javascript:alert(1)', 'https://example.com/api?key=a', 'https://a:b@example.com']) {
    assert.equal(CreateExamSchema.safeParse({ ...base, externalBoardBaseUrl: domain }).success, false);
  }
});

test('payload matches receiver identifiers, China-local millisecond timestamp, integer score percentages and KB', () => {
  assert.deepEqual(externalBoardProblem(problem), { display_id: 'AA', title: '测试题', score: 80, time_limit: 1000, memory_limit: 256 });
  const payload = externalBoardSubmission(submission, problem, { examNumber: '0000123' });
  assert.deepEqual(payload, { rid: 'proctor:submission-1', username: '0000123', problem: 'AA', status: 'Accepted', score: 50, language: 'cc.cc17o2', code: 'int main() {}', runtime: '12', memory: '4096', submit_time: '2026-10-11 16:00:01.123' });
  assert.equal(externalBoardSubmission({ ...submission, manualScore: 60 }, problem, { examNumber: '1' }).score, 75);
  assert.equal(externalBoardSubmission({ ...submission, status: 7, statusText: null, score: 0 }, problem, { examNumber: '1' }).status, 'Compile Error');
});

test('ignored records retract earlier accepted scores using the receiver neutral verdict and stable rid', () => {
  const payload = externalBoardSubmission({ ...submission, status: 30 }, problem, { examNumber: '1' });
  assert.equal(payload.status, 'Compile Error');
  assert.equal(payload.score, 0);
  assert.equal(payload.rid, externalBoardSubmission(submission, problem, { examNumber: '1' }).rid);
});

test('endpoint honors the external-login API base without redirecting or adding another /api', () => {
  assert.equal(externalBoardEndpoint('https://www.example.org/api///', '123', 'problems'), 'https://www.example.org/api/external/board/123/problems');
  assert.equal(externalBoardEndpoint('http://localhost:8080', '123', 'submissions'), 'http://localhost:8080/external/board/123/submissions');
  for (const base of ['ftp://localhost/api', 'https://user:password@localhost/api', 'https://localhost/api?key=test', 'https://localhost/api#test']) {
    assert.throws(() => externalBoardEndpoint(base, '123', 'problems'), /官网域名/);
  }
});
