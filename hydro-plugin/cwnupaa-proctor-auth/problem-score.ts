type ProblemScoreSource = { score?: unknown; config?: Record<string, unknown> | null };

function nonNegativeNumber(value: unknown) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const number = Number(value);
    return Number.isFinite(number) && number >= 0 ? number : null;
}

/** Hydro's generic problem score may be 100 while the judge uses subtask points. */
export function problemFullScore(problem: ProblemScoreSource): number | null {
    const config = problem.config || {};
    if (String(config.type || '').toLowerCase() === 'objective' && config.answers && typeof config.answers === 'object') {
        const total = Object.values(config.answers).reduce<number>((sum, answer) => {
            if (Array.isArray(answer)) return sum + (nonNegativeNumber(answer[1]) ?? 0);
            if (answer && typeof answer === 'object') {
                const scores = Object.values(answer).map(nonNegativeNumber).filter((score): score is number => score !== null);
                return sum + (scores.length ? Math.max(...scores) : 0);
            }
            return sum;
        }, 0);
        if (total > 0) return total;
    }
    if (Array.isArray(config.subtasks) && config.subtasks.length) {
        const scores = config.subtasks.map(subtask => subtask && typeof subtask === 'object'
            ? nonNegativeNumber(subtask.score) : null);
        if (scores.every((score): score is number => score !== null)) {
            const total = scores.reduce((sum, score) => sum + score, 0);
            if (total > 0) return total;
        }
    }
    return nonNegativeNumber(config.score) || nonNegativeNumber(problem.score) || null;
}
