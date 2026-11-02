interface SourceTime { id: string; submittedAt?: Date | string | number }

export function submissionTime(source: SourceTime): Date | null {
    if (source.submittedAt !== undefined && source.submittedAt !== null) {
        const saved = source.submittedAt instanceof Date ? source.submittedAt : new Date(source.submittedAt);
        if (Number.isFinite(saved.getTime())) return saved;
    }
    // Hydro's own record detail uses the submission ObjectId timestamp. This
    // fallback also works for older snapshots, even after records are deleted.
    if (!/^[a-f\d]{24}$/i.test(source.id)) return null;
    return new Date(parseInt(source.id.slice(0, 8), 16) * 1000);
}

export function submissionTiming(first: SourceTime, second: SourceTime) {
    const firstDate = submissionTime(first); const secondDate = submissionTime(second);
    if (!firstDate || !secondDate) return { firstDate, secondDate, earlier: null, differenceSeconds: null, differenceText: null };
    const difference = Math.floor(secondDate.getTime() / 1000) - Math.floor(firstDate.getTime() / 1000);
    const differenceSeconds = Math.abs(difference);
    let remaining = differenceSeconds;
    const parts: string[] = [];
    for (const [unit, label] of [[86400, '天'], [3600, '小时'], [60, '分钟'], [1, '秒']] as const) {
        const value = Math.floor(remaining / unit);
        if (value) parts.push(`${value} ${label}`);
        remaining %= unit;
    }
    return {
        firstDate, secondDate, earlier: difference > 0 ? 'first' : difference < 0 ? 'second' : 'same',
        differenceSeconds, differenceText: parts.join(' ') || '0 秒',
    };
}
