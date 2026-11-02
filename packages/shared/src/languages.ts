export type JudgeLanguage = { id: string; name: string };

export function languageFamily(id: string): string | null {
  const value = id.toLowerCase();
  if (!value || value === '_') return null;
  if (/^(cpp|cc|c\+\+)(?:$|[.\d_-])/.test(value)) return 'cpp';
  if (/^c(?:$|[.\d_-])/.test(value)) return 'c';
  if (/^(python|py|pypy)(?:$|[.\d_-])/.test(value)) return 'python';
  const root = value.split('.')[0].replace(/[\d_-].*$/, '');
  return ({ rs: 'rust', rust: 'rust', js: 'javascript', node: 'javascript', javascript: 'javascript',
    ts: 'typescript', kt: 'kotlin', hs: 'haskell', rb: 'ruby', pas: 'pascal', cs: 'csharp', csharp: 'csharp',
    vb: 'visualbasic', sh: 'shell', bash: 'shell', pl: 'perl', f: 'fortran' } as Record<string, string>)[root] || root;
}

export function languageFamilyName(family: string) {
  return ({ c: 'C', cpp: 'C++', python: 'Python', java: 'Java', rust: 'Rust', javascript: 'JavaScript',
    typescript: 'TypeScript', go: 'Go', kotlin: 'Kotlin', haskell: 'Haskell', ruby: 'Ruby', pascal: 'Pascal',
    csharp: 'C#', visualbasic: 'Visual Basic', shell: 'Shell', perl: 'Perl', fortran: 'Fortran',
    php: 'PHP', swift: 'Swift', lua: 'Lua', r: 'R', scala: 'Scala', dart: 'Dart', ocaml: 'OCaml' } as Record<string, string>)[family] || family;
}

export function groupJudgeLanguages(languages: JudgeLanguage[]) {
  const groups = new Map<string, JudgeLanguage[]>();
  for (const language of languages) {
    const family = languageFamily(language.id) || '_';
    groups.set(family, [...(groups.get(family) || []), language]);
  }
  return [...groups].map(([id, versions]) => ({ id, name: id === '_' ? '提交答案' : languageFamilyName(id), versions }));
}

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
