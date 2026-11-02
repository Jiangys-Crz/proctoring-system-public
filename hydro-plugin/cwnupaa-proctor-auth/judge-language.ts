// Old monitoring clients used display aliases rather than Hydro's configured IDs.
export function resolveJudgeLanguage(requested: string, available: string[], allowed?: string[]) {
    const enabled = available.filter(id => !allowed?.length || allowed.includes(id));
    if (enabled.includes(requested)) return requested;
    const aliases: Record<string, RegExp> = {
        python: /^(?:py\.py3|py3|python3|python\.python3)(?:$|[._-])/i,
        py: /^(?:py\.py3|py3|python3|python\.python3)(?:$|[._-])/i,
        python3: /^(?:py\.py3|py3)(?:$|[._-])/i,
        py3: /^py\.py3(?:$|[._-])/i,
        'py.py3': /^(?:py3|python3)(?:$|[._-])/i,
        pypy3: /^py\.pypy3(?:$|[._-])/i,
        'py.pypy3': /^pypy3(?:$|[._-])/i,
        cpp: /^(?:cc|cpp)(?:$|[._-])/i,
        cc: /^(?:cc|cpp)(?:$|[._-])/i,
    };
    const pattern = aliases[requested.toLowerCase()];
    return pattern ? enabled.find(id => pattern.test(id)) || null : null;
}
