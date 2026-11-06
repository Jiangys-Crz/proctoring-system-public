type ReactionTeamNameInput = {
  examId: string;
  teamId: string;
  candidate?: { examId: string; examNumber: string; teamName: string | null } | null;
  teamEvent?: { examId: string; type: string; remoteId: string; payload: unknown } | null;
};

export type ReactionTeamIdentity = { teamName: string; source: 'CANDIDATE_TEAM_NAME' | 'CCS_TEAM_NAME' | 'TEAM_ID' };

/** Personal candidate names and old Reaction snapshots are never team-name fallbacks. */
export function resolveReactionTeamIdentity({ examId, teamId, candidate, teamEvent }: ReactionTeamNameInput): ReactionTeamIdentity {
  if (candidate?.examId === examId && candidate.examNumber === teamId) {
    const configuredName = candidate.teamName?.trim();
    if (configuredName) return { teamName: configuredName, source: 'CANDIDATE_TEAM_NAME' };
  }
  if (teamEvent?.examId === examId && teamEvent.type === 'teams' && teamEvent.remoteId === teamId) {
    const payload = teamEvent.payload;
    if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
      const team = payload as Record<string, unknown>;
      const id = typeof team.id === 'string' || typeof team.id === 'number' ? String(team.id) : '';
      if (id === teamId && !team.__reactionDeleted && typeof team.name === 'string' && team.name.trim()) {
        return { teamName: team.name.trim(), source: 'CCS_TEAM_NAME' };
      }
    }
  }
  return { teamName: teamId, source: 'TEAM_ID' };
}

export function resolveReactionTeamName(input: ReactionTeamNameInput): string {
  return resolveReactionTeamIdentity(input).teamName;
}
