type LanguageConfig = { disabled?: boolean; display?: string };

/** Missing version commands/reports do not mean a configured language is disabled. */
export function judgeLanguageList(languages: Record<string, LanguageConfig>, reports: unknown[]) {
    const compilerReports = reports.filter((report): report is Record<string, unknown> => Boolean(report && typeof report === 'object' && !Array.isArray(report)));
    const unavailable = /(?:execve:|no such file|not found|cannot find|invalid language selection)/i;
    return Object.keys(languages)
        .filter(id => !languages[id]?.disabled && id !== '_')
        .filter(id => {
            const versions = compilerReports.map(report => report[id]).filter((version): version is string => typeof version === 'string' && Boolean(version.trim()));
            return !versions.length || versions.some(version => !unavailable.test(version));
        })
        .map(id => ({ id, name: languages[id]?.display || id }));
}
