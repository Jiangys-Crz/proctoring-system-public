import { access } from 'node:fs/promises';
import path from 'node:path';
import { Worker } from 'node:worker_threads';

export interface Submission {
    id: string;
    uid: number;
    pid: number;
    lang: string;
    code: string;
}

export interface Match {
    startInFirst: { line: number, column: number };
    endInFirst: { line: number, column: number };
    startInSecond: { line: number, column: number };
    endInSecond: { line: number, column: number };
    lengthOfFirst: number;
    lengthOfSecond: number;
}

export interface Comparison {
    firstSubmissionId: string;
    secondSubmissionId: string;
    firstSimilarity: number;
    secondSimilarity: number;
    similarities: { AVG: number, MAX: number };
    matches: Match[];
}

export interface EngineOptions {
    parserPath: string;
    workerPath: string;
    heapMb: number;
    timeoutSeconds: number;
    minTokens: number;
    signal?: AbortSignal;
}

// Match Hydro language IDs by family, including version/compiler suffixes.
// Never fall back to text mode for unsupported languages.
export function languageFor(lang: string): { id: string, suffix: string, family: string } | null {
    const name = lang.toLowerCase();
    const language = (id: string, suffix: string) => ({ id, suffix, family: ['c', 'cpp'].includes(id) ? 'c-cpp' : id });
    if (/^(cpp|c\+\+|g\+\+|cc)([.\d-]|$)/.test(name)) return language('cpp', 'cpp');
    if (/^c([.\d-]|$)/.test(name)) return language('c', 'c');
    if (/^(python|py|pypy)([.\d-]|$)/.test(name)) return language('python3', 'py');
    if (/^java([.\d-]|$)/.test(name)) return language('java', 'java');
    if (/^(javascript|js|node)([.\d-]|$)/.test(name)) return language('javascript', 'js');
    if (/^(typescript|ts)([.\d-]|$)/.test(name)) return language('typescript', 'ts');
    if (/^(go|golang)([.\d-]|$)/.test(name)) return language('golang', 'go');
    if (/^(rust|rs)([.\d-]|$)/.test(name)) return language('rust', 'rs');
    if (/^(csharp|cs|c#)([.\d-]|$)/.test(name)) return language('csharp', 'cs');
    if (/^(kotlin|kt)([.\d-]|$)/.test(name)) return language('kotlin', 'kt');
    return null;
}

export function languageLabel(family: string): string {
    return family === 'c-cpp' ? 'C/C++' : family;
}

export function severity(similarity: number): 'high' | 'medium' | 'low' {
    return similarity >= 0.8 ? 'high' : similarity >= 0.5 ? 'medium' : 'low';
}

export function percent(similarity: number): string {
    // Reserve 100.0% for actual full coverage, even on very large programs.
    return (similarity >= 1 ? 100 : Math.min(99.9, Math.max(0, similarity) * 100)).toFixed(1);
}

export interface ComparisonBatch {
    ids: string[];
    left: Set<string>;
    right: Set<string> | null;
}

// Cross each chunk with every other chunk. In a cross-chunk run, discard
// internal comparisons already covered by each chunk's own run. This covers
// each historical submission pair exactly once without loading an entire
// large contest into one analysis worker.
export function* comparisonBatches(ids: string[], maxSize: number): Generator<ComparisonBatch> {
    if (ids.length <= maxSize) { yield { ids, left: new Set(ids), right: null }; return; }
    const size = Math.max(1, Math.floor(maxSize / 2));
    const chunks: string[][] = [];
    for (let offset = 0; offset < ids.length; offset += size) chunks.push(ids.slice(offset, offset + size));
    for (let i = 0; i < chunks.length; i++) {
        for (let j = i; j < chunks.length; j++) {
            yield {
                ids: i === j ? chunks[i] : [...chunks[i], ...chunks[j]],
                left: new Set(chunks[i]), right: i === j ? null : new Set(chunks[j]),
            };
        }
    }
}

export function comparisonsForBatch(comparisons: Comparison[], batch: ComparisonBatch) {
    if (!batch.right) return comparisons;
    return comparisons.filter((comparison) => (
        (batch.left.has(comparison.firstSubmissionId) && batch.right!.has(comparison.secondSubmissionId))
        || (batch.right!.has(comparison.firstSubmissionId) && batch.left.has(comparison.secondSubmissionId))
    ));
}

// One result per problem, language family and pair of users; retain the strongest
// pair of historical submissions, rather than only comparing latest/AC code.
export function aggregateComparisons(comparisons: Comparison[], submissions: Submission[]) {
    const byId = new Map(submissions.map((s) => [s.id, s]));
    const pairs = new Map<string, {
        first: Submission, second: Submission, comparison: Comparison, versions: number,
    }>();
    for (const comparison of comparisons) {
        const first = byId.get(comparison.firstSubmissionId);
        const second = byId.get(comparison.secondSubmissionId);
        if (!first || !second || first.uid === second.uid || first.pid !== second.pid) continue;
        const firstLanguage = languageFor(first.lang); const secondLanguage = languageFor(second.lang);
        if (!firstLanguage || !secondLanguage || firstLanguage.family !== secondLanguage.family) continue;
        const key = [first.pid, firstLanguage.family, ...[first.uid, second.uid].sort((a, b) => a - b)].join(':');
        const previous = pairs.get(key);
        const versions = (previous?.versions || 0) + 1;
        if (!previous || comparison.similarities.AVG > previous.comparison.similarities.AVG) {
            pairs.set(key, { first, second, comparison, versions });
        } else previous.versions = versions;
    }
    return [...pairs.values()].sort((a, b) => b.comparison.similarities.AVG - a.comparison.similarities.AVG);
}

const grammarNames = ['c', 'cpp', 'python', 'java', 'javascript', 'typescript', 'go', 'rust', 'c-sharp', 'kotlin'];

export async function checkEngine(options: EngineOptions) {
    options.signal?.throwIfAborted();
    try {
        await Promise.all([options.workerPath, path.join(options.parserPath, 'web-tree-sitter.wasm'),
            ...grammarNames.map((name) => path.join(options.parserPath, `tree-sitter-${name}.wasm`))].map((file) => access(file)));
    } catch { throw new Error('未找到语法查重引擎，请确认服务器包含 vendor/contest-code-check 的 worker 与 WASM 文件。'); }
}

export async function analyzeGroup(submissions: Submission[], options: EngineOptions): Promise<{ comparisons: Comparison[], failed: string[] }> {
    options.signal?.throwIfAborted();
    const language = languageFor(submissions[0]?.lang || '');
    if (!language) throw new Error('不支持的代码语言');
    if (submissions.some((s) => !/^[a-z\d:_-]{1,160}$/i.test(s.id) || languageFor(s.lang)?.family !== language.family || s.pid !== submissions[0].pid)) {
        throw new Error('无效的提交分组');
    }
    return new Promise((resolve, reject) => {
        const worker = new Worker(options.workerPath, {
            workerData: { submissions, minTokens: options.minTokens, parserPath: options.parserPath },
            resourceLimits: { maxOldGenerationSizeMb: options.heapMb },
        });
        let result: { comparisons: Comparison[], failed: string[] } | undefined;
        let failure: Error | undefined;
        const terminate = (error: Error) => { failure ||= error; void worker.terminate(); };
        const timer = setTimeout(() => terminate(new Error('该题查重超时，请调整 timeoutSeconds 或分批处理较大比赛。')), options.timeoutSeconds * 1000);
        const abort = () => terminate(options.signal?.reason || new Error('已停止查重'));
        options.signal?.addEventListener('abort', abort, { once: true });
        if (options.signal?.aborted) abort();
        worker.on('message', (value) => { result = value; });
        worker.on('error', (error) => { failure ||= error; });
        // Wait for actual worker exit before releasing the database engine lease.
        worker.on('exit', (code) => {
            clearTimeout(timer); options.signal?.removeEventListener('abort', abort);
            if (failure) reject(failure);
            else if (code || !result) reject(new Error(`语法查重引擎未完成分析（退出码 ${code}）。`));
            else resolve(result);
        });
    });
}

export function codeLines(code: string, matches: Match[], side: 'First' | 'Second') {
    return code.split(/\r?\n/).map((text, index) => ({
        number: index + 1,
        text,
        blocks: matches.flatMap((match, block) => (
            index + 1 >= match[`startIn${side}`].line && index + 1 <= match[`endIn${side}`].line ? [block + 1] : []
        )),
    }));
}
