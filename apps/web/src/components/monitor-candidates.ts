export type MonitorSearchField = 'name' | 'studentId';

type SearchableCandidate = {
  id: string;
  name: string | null;
  studentId: string | null;
  teamMembers?: string | null;
  teamMemberStudentIds?: string | null;
  status: string;
};
type MonitorSession = { id: string; status: string; memberName?: string | null; memberStudentId?: string | null };

/** Filter the authorized room list before sorting and paginating it. */
export function monitorCandidates<T extends SearchableCandidate>(
  candidates: readonly T[],
  sessions: ReadonlyMap<string, MonitorSession>,
  readySessions: ReadonlySet<string> | null,
  search: { field: MonitorSearchField; query: string }
): T[] {
  const keyword = search.query.trim().toLocaleLowerCase();
  return candidates
    .filter(candidate => {
      if (!keyword) return true;
      const session = sessions.get(candidate.id);
      const fields = search.field === 'name'
        ? [candidate.name, candidate.teamMembers, session?.memberName]
        : [candidate.studentId, candidate.teamMemberStudentIds, session?.memberStudentId];
      return fields.some(value => value?.toLocaleLowerCase().includes(keyword));
    })
    .map((candidate, index) => {
      const session = sessions.get(candidate.id);
      const finished = candidate.status === 'FINISHED' || session?.status === 'FINISHED';
      const live = session && (readySessions
        ? readySessions.has(session.id)
        : ['ONLINE_NORMAL', 'ONLINE_ABNORMAL'].includes(candidate.status));
      return { candidate, index, priority: finished ? 2 : live ? 0 : 1 };
    })
    // Keep the server's seat/exam-number order within each availability group.
    .sort((left, right) => left.priority - right.priority || left.index - right.index)
    .map(item => item.candidate);
}

export function monitorCandidatePage<T>(candidates: readonly T[], requestedPage: number, size: 1 | 4) {
  const total = Math.ceil(candidates.length / size);
  const index = Math.min(Math.max(0, requestedPage), Math.max(0, total - 1));
  return { index, total, candidates: candidates.slice(index * size, (index + 1) * size), label: `${total ? index + 1 : 0} / ${total}` };
}
