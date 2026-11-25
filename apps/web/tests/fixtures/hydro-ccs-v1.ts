import type { CcsEvent } from '../../src/lib/reaction-domain';

// HTTP contract samples for hydro-ccs-api 1.x. No imports of server addon code:
// these tests assert the consumer's behavior, not the producer's ranking algorithm.
const contestId = '691000000000000000000001';
const submissionId = '691000000000000000000002';
const at = (second: number) => new Date(Date.parse('2026-11-09T03:00:00.000Z') + second * 1000).toISOString();
const token = (revision: number, index: number) => `${'a'.repeat(24)}.${revision}.${index}`;
const event = (type: string, data: Record<string, unknown>, index: number): CcsEvent => ({ type, id: String(data.id), data, token: token(1, index) });

export const baseline: CcsEvent[] = [
  event('contest', { id: contestId, start_time: at(0), x_hydro_rules: 'HYDRO_ACM_V1' }, 0),
  event('teams', { id: 'team01', name: 'Hydro Team', x_hydro_username: 'team01', x_hydro_usernames: ['team01', 'member01'] }, 1),
  event('teams', { id: 'team02', name: 'Team 2', x_hydro_username: 'team02' }, 2),
  event('problems', { id: '1', label: 'A' }, 3),
  event('submissions', { id: submissionId, team_id: 'team01', problem_id: '1', time: at(10), x_hydro_order: 0, x_hydro_username: 'team01' }, 4),
  event('judgements', { id: `hydro-${submissionId}`, submission_id: submissionId, judgement_type_id: null, end_time: null, x_hydro_status: 0 }, 5),
];
export const ac: CcsEvent = {
  type: 'judgements', id: `hydro-${submissionId}`, token: token(2, 0),
  data: {
    id: `hydro-${submissionId}`, submission_id: submissionId, judgement_type_id: 'AC', end_time: at(30), x_hydro_status: 1,
    x_hydro_rank: {
      version: 1, source: 'HYDRO_CCS_OBSERVED_ORDER', status: 'AVAILABLE', beforeRank: 2, afterRank: 1, observedAt: at(31),
      provenance: {
        contestId, teamId: 'team01', ccsTeamId: 'team01', submissionId, judgementId: `hydro-${submissionId}`, verdict: 'AC',
        eventToken: token(2, 0), rules: 'HYDRO_ACM_V1', visibility: 'UNFROZEN_ADMIN', ordering: 'CCS_PERSISTED_OBSERVATION_ORDER',
        beforeStateHash: 'b'.repeat(64), afterStateHash: 'c'.repeat(64), caveat: 'CCS observation order, not database transaction order',
      },
    },
  },
};
export const rejudge: CcsEvent = {
  type: 'judgements', id: `hydro-${submissionId}`, token: token(3, 0),
  data: { id: `hydro-${submissionId}`, submission_id: submissionId, judgement_type_id: 'WA', end_time: at(40), x_hydro_status: 2 },
};
export const deleted: CcsEvent[] = [
  { type: 'teams', id: 'team01', data: null, token: token(4, 0) },
  { type: 'submissions', id: submissionId, data: null, token: token(4, 1) },
  { type: 'judgements', id: `hydro-${submissionId}`, data: null, token: token(4, 2) },
];
