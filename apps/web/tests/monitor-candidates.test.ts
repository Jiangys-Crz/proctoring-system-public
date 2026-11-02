import assert from 'node:assert/strict';
import { test } from 'node:test';
import { monitorCandidatePage, monitorCandidates } from '../src/components/monitor-candidates';

function candidate(id: string, extra: Record<string, string | null> = {}) {
  return { id, name: `考生${id}`, studentId: `student-${id}`, status: 'ONLINE_NORMAL', ...extra };
}
function sessions(ids: string[]) {
  return new Map(ids.map(id => [id, { id: `session-${id}`, status: 'IN_EXAM' }]));
}
const search = { field: 'name' as const, query: '' };

test('all ready active candidates precede missing feeds and finished sessions before pagination', () => {
  const candidates = Array.from({ length: 20 }, (_, index) => candidate(String(index)));
  candidates[3].status = 'FINISHED';
  const byCandidate = sessions(candidates.map(item => item.id));
  byCandidate.get('7')!.status = 'FINISHED';
  const ready = new Set(['3', '7', '9', '12', '13', '15', '16', '17', '18', '19'].map(id => `session-${id}`));
  const sorted = monitorCandidates(candidates, byCandidate, ready, search);
  assert.deepEqual(sorted.slice(0, 8).map(item => item.id), ['9', '12', '13', '15', '16', '17', '18', '19']);
  assert.deepEqual(sorted.slice(-2).map(item => item.id), ['3', '7']);
  assert.deepEqual(monitorCandidatePage(sorted, 1, 4).candidates.map(item => item.id), ['16', '17', '18', '19']);
  assert.deepEqual(candidates.map(item => item.id), Array.from({ length: 20 }, (_, index) => String(index)), 'do not mutate the status/login source list');
});

test('name and student ID search match only the selected field, trim whitespace and include team/session members', () => {
  const candidates = [candidate('a', { name: '李明', studentId: '2026001' }), candidate('b', { name: '2026001', studentId: 'AbC-88', teamMembers: '张三、王五' })];
  const byCandidate = new Map([
    ['a', { id: 'session-a', status: 'IN_EXAM', memberName: '赵六', memberStudentId: 'member-90' }],
    ['b', { id: 'session-b', status: 'IN_EXAM' }]
  ]);
  const ids = (field: 'name' | 'studentId', query: string) => monitorCandidates(candidates, byCandidate, new Set(), { field, query }).map(item => item.id);
  assert.deepEqual(ids('name', ' 2026001 '), ['b']);
  assert.deepEqual(ids('studentId', ' 2026001 '), ['a']);
  assert.deepEqual(ids('name', '张三'), ['b']);
  assert.deepEqual(ids('name', '赵六'), ['a']);
  assert.deepEqual(ids('studentId', ' MEMBER-90 '), ['a']);
  assert.deepEqual(ids('studentId', 'abc-88'), ['b']);
  assert.deepEqual(ids('studentId', '李明'), []);
});

test('search filters the entire authorized list before sorting and paging, including unavailable candidates', () => {
  const candidates = Array.from({ length: 20 }, (_, index) => candidate(String(index)));
  const byCandidate = sessions(candidates.map(item => item.id));
  const sorted = monitorCandidates(candidates, byCandidate, new Set(['session-19']), { field: 'name', query: '考生1' });
  assert.equal(sorted.length, 11);
  assert.equal(sorted[0].id, '19');
  assert.deepEqual(monitorCandidatePage(sorted, 0, 4).candidates.map(item => item.id), ['19', '1', '10', '11']);
  assert.equal(monitorCandidates(candidates.slice(0, 5), byCandidate, new Set(['session-19']), { field: 'name', query: '考生19' }).length, 0, 'search must never expand the room/permission scope');
});

test('only the latest chosen session and ready status count, with stable seat order within availability groups', () => {
  const candidates = [candidate('a'), candidate('b'), candidate('c')];
  const byCandidate = sessions(['a', 'b', 'c']);
  const sorted = monitorCandidates(candidates, byCandidate, new Set(['old-session-a', 'session-c', 'session-b']), search);
  assert.deepEqual(sorted.map(item => item.id), ['b', 'c', 'a']);
});

test('unknown media service uses current online status, while a confirmed empty ready set does not', () => {
  const candidates = [candidate('a', { status: 'NOT_REQUESTED' }), candidate('b'), candidate('c', { status: 'FINISHED' })];
  assert.deepEqual(monitorCandidates(candidates, sessions(['b', 'c']), null, search).map(item => item.id), ['b', 'a', 'c']);
  assert.deepEqual(monitorCandidates(candidates, sessions(['b', 'c']), new Set(), search).map(item => item.id), ['a', 'b', 'c']);
});

test('page boundaries retain full groups, clamp after removals and show accurate empty/single-page counts', () => {
  const candidates = Array.from({ length: 10 }, (_, index) => candidate(String(index)));
  assert.deepEqual(monitorCandidatePage(candidates, 2, 4).candidates.map(item => item.id), ['8', '9']);
  assert.equal(monitorCandidatePage(candidates, 99, 4).label, '3 / 3');
  assert.equal(monitorCandidatePage(candidates.slice(0, 2), 2, 4).label, '1 / 1');
  assert.equal(monitorCandidatePage([], 4, 1).label, '0 / 0');
  assert.equal(monitorCandidatePage(candidates, -1, 1).label, '1 / 10');
});
