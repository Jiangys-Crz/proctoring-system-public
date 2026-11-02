import type { Comparison, Submission, Match } from './engine';
import type { Token } from './tokenizer';

// Greedy String Tiling over syntax tokens. Hashes only locate candidates;
// every candidate is checked token by token, so hash collisions cannot match.
export function compare(first: Submission, second: Submission, a: Token[], b: Token[], minTokens: number): Comparison {
    const matchedA = new Uint8Array(a.length); const matchedB = new Uint8Array(b.length);
    const dictionary = new Map<string, number>();
    const encode = (tokens: Token[]) => tokens.map((token) => {
        if (!dictionary.has(token.key)) dictionary.set(token.key, dictionary.size + 1);
        return dictionary.get(token.key)!;
    });
    const left = encode(a); const right = encode(b);
    const hashes = (values: number[]) => {
        const result = new Uint32Array(Math.max(0, values.length - minTokens + 1));
        let power = 1; let hash = 0;
        for (let i = 0; i < minTokens; i++) { hash = (Math.imul(hash, 16777619) + (values[i] || 0)) >>> 0; if (i) power = Math.imul(power, 16777619) >>> 0; }
        if (result.length) result[0] = hash;
        for (let i = 1; i < result.length; i++) {
            hash = (Math.imul((hash - Math.imul(values[i - 1], power)) >>> 0, 16777619) + values[i + minTokens - 1]) >>> 0;
            result[i] = hash;
        }
        return result;
    };
    const ha = hashes(left); const hb = hashes(right);
    const unused = (mask: Uint8Array, start: number, size: number) => {
        for (let i = start; i < start + size; i++) if (mask[i]) return false;
        return true;
    };
    const blocks: { i: number, j: number, length: number }[] = [];
    // Common in contests: many historical submissions differ only in names or
    // formatting. Avoid quadratic candidate expansion for identical streams.
    if (a.length === b.length && a.length >= minTokens && left.every((value, i) => value === right[i])) {
        blocks.push({ i: 0, j: 0, length: a.length });
        matchedA.fill(1); matchedB.fill(1);
    }
    for (; blocks.length === 0 || matchedA.some((value) => !value);) {
        const index = new Map<number, number[]>();
        for (let j = 0; j < hb.length; j++) {
            if (!unused(matchedB, j, minTokens)) continue;
            const entries = index.get(hb[j]) || []; entries.push(j); index.set(hb[j], entries);
        }
        let longest = minTokens; const candidates: typeof blocks = [];
        for (let i = 0; i < ha.length; i++) {
            if (!unused(matchedA, i, minTokens)) continue;
            for (const j of index.get(ha[i]) || []) {
                let length = 0;
                while (i + length < a.length && j + length < b.length && !matchedA[i + length]
                    && !matchedB[j + length] && left[i + length] === right[j + length]) length++;
                if (length < longest) continue;
                if (length > longest) { longest = length; candidates.length = 0; }
                candidates.push({ i, j, length });
            }
        }
        if (!candidates.length) break;
        let added = false;
        for (const block of candidates) {
            if (!unused(matchedA, block.i, block.length) || !unused(matchedB, block.j, block.length)) continue;
            matchedA.fill(1, block.i, block.i + block.length); matchedB.fill(1, block.j, block.j + block.length);
            blocks.push(block); added = true;
        }
        if (!added) break;
    }
    blocks.sort((x, y) => x.i - y.i);
    const covered = blocks.reduce((total, block) => total + block.length, 0);
    const matches: Match[] = blocks.map(({ i, j, length }) => ({
        startInFirst: { line: a[i].line, column: a[i].column },
        endInFirst: { line: a[i + length - 1].endLine, column: a[i + length - 1].endColumn },
        startInSecond: { line: b[j].line, column: b[j].column },
        endInSecond: { line: b[j + length - 1].endLine, column: b[j + length - 1].endColumn },
        lengthOfFirst: length, lengthOfSecond: length,
    }));
    const firstSimilarity = a.length ? covered / a.length : 0;
    const secondSimilarity = b.length ? covered / b.length : 0;
    return {
        firstSubmissionId: first.id, secondSubmissionId: second.id, firstSimilarity, secondSimilarity,
        similarities: { AVG: a.length + b.length ? 2 * covered / (a.length + b.length) : 0, MAX: Math.max(firstSimilarity, secondSimilarity) },
        matches,
    };
}
