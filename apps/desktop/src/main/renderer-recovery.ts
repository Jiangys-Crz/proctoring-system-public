import type { RendererRecoveryState } from '../shared/types';

function recoveryFields(source: Record<string, unknown>, names: readonly string[]) {
  return Object.fromEntries(names.filter(name => source[name] !== undefined).map(name => [name, source[name]]));
}

/** Credentials stay in this main process only, never in a renderer storage file.
 * A recovered page must authenticate the original session with the server. */
export class RendererRecoveryStore {
  private value: string | null = null;
  private recovering = false;
  private failures: number[] = [];
  constructor(private readonly now = Date.now) {}

  save(input: RendererRecoveryState | null) {
    if (input === null) { this.value = null; this.recovering = false; return; }
    // Never leave another session's credentials as the fallback if saving the
    // current login fails. Only the complete, current snapshot may be recovered.
    this.value = null;
    const origin = new URL(input.serverUrl).origin;
    if (origin !== input.sessionServerOrigin || !input.sessionToken || input.sessionToken.length > 8192 ||
        /[\r\n]/.test(input.sessionToken) || !/^[A-Za-z0-9_-]{1,128}$/.test(input.session?.id) ||
        input.session.examId !== input.exam?.id || input.session.candidateId !== input.candidate?.id ||
        input.session.status === 'FINISHED') throw new Error('无效的考试恢复状态');
    const value = JSON.stringify({
      serverUrl: origin, sessionServerOrigin: origin, sessionToken: input.sessionToken,
      session: { id: input.session.id, examId: input.session.examId, candidateId: input.session.candidateId, status: input.session.status,
        ...recoveryFields(input.session, ['approvedAt', 'startedAt', 'effectiveEndAt', 'endedAt', 'revokedAt', 'lockdown', 'lockdownReason',
          'memberName', 'miniProgramOfflineAt', 'peripheralsBaselineFingerprint', 'lastPeripheralsFingerprint', 'updatedAt']) },
      candidate: { id: input.candidate.id, ...recoveryFields(input.candidate, ['name', 'examNumber', 'teamName', 'teamMembers', 'seatNo']) },
      exam: { id: input.exam.id, ...recoveryFields(input.exam, ['name', 'platform', 'platformBaseUrl', 'platformContestId',
        'rules', 'startAt', 'endAt', 'durationMinutes', 'contestRule', 'flexible']) },
      requirements: input.requirements && recoveryFields(input.requirements, ['roomName', 'requireFrontCamera', 'requireSecondCamera',
        'isPublicTest', 'saveFullRecording', 'saveIncidentRecording']), baselineFingerprint: input.baselineFingerprint,
      pairCode: input.pairCode, pairPollToken: input.pairPollToken
    }, (key, item) => /password|tokenHash|apiKey|cookie|secret/i.test(key) ? undefined : item);
    // Keep complete rules and lock reasons, including JSON escaping of TEXT
    // columns, without caching unrelated account/exam metadata or relations.
    if (Buffer.byteLength(value) > 1024 * 1024) throw new Error('考试恢复状态过大');
    this.value = value;
  }

  begin(active: boolean) {
    const cutoff = this.now() - 120_000;
    this.failures = this.failures.filter(at => at > cutoff);
    if (this.failures.length >= (active ? 3 : 1) || (active && !this.value)) return false;
    this.failures.push(this.now());
    this.recovering = Boolean(this.value);
    return true;
  }

  read(): RendererRecoveryState | null {
    return this.recovering && this.value ? JSON.parse(this.value) : null;
  }
  restored() { this.recovering = false; }
}
