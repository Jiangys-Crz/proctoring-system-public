import { parentPort, workerData } from 'node:worker_threads';
import { languageFor, Submission, Comparison } from '../lib/engine';
import { tokenize, Token } from '../lib/tokenizer';
import { compare } from '../lib/matcher';

async function run() {
    const { submissions, parserPath, minTokens } = workerData as { submissions: Submission[], parserPath: string, minTokens: number };
    const parsed: { submission: Submission, tokens: Token[] }[] = [];
    const failed: string[] = [];
    for (const submission of submissions) {
        try {
            // Group by family, but parse each source with its actual language:
            // valid C can use identifiers or syntax not accepted by C++.
            const tokens = await tokenize(submission.code, languageFor(submission.lang)!.id, parserPath);
            if (tokens.length < minTokens) throw new Error('有效代码不足');
            parsed.push({ submission, tokens });
        } catch { failed.push(submission.id); }
    }
    const comparisons: Comparison[] = [];
    for (let i = 0; i < parsed.length; i++) {
        for (let j = i + 1; j < parsed.length; j++) {
            const a = parsed[i]; const b = parsed[j];
            if (a.submission.uid === b.submission.uid) continue;
            comparisons.push(compare(a.submission, b.submission, a.tokens, b.tokens, minTokens));
        }
    }
    parentPort!.postMessage({ comparisons, failed });
}
run().catch((error) => { throw error; });
