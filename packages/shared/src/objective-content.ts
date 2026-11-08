export type ObjectiveQuestion = { id: string; kind: 'select' | 'multiselect' | 'input'; options: string[] };
/** Hydro controls followed by Markdown lists, including indented multiline options. */
export function parseObjectiveContent(source: string) {
  const content = source.replace(/\r\n?/g, '\n');
  const blocks: Array<{ markdown: string } | { question: ObjectiveQuestion }> = [], questions: ObjectiveQuestion[] = [];
  const pattern = /\{\{\s*(select|multiselect|input)\(([A-Za-z0-9_.-]+)\)\s*\}\}/g;
  const codeRanges: Array<[number, number]> = [];
  let offset = 0, fence: { marker: string; start: number } | undefined;
  for (const line of content.split('\n')) {
    const marker = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (marker && !fence) fence = { marker: marker[1], start: offset };
    else if (marker && fence && marker[1][0] === fence.marker[0] && marker[1].length >= fence.marker.length) { codeRanges.push([fence.start, offset + line.length]); fence = undefined; }
    offset += line.length + 1;
  }
  if (fence) codeRanges.push([fence.start, content.length]);
  let cursor = 0, match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (codeRanges.some(([from, to]) => match!.index >= from && match!.index < to)) continue;
    if (match.index > cursor) blocks.push({ markdown: content.slice(cursor, match.index) });
    const options: string[] = [], remainder = content.slice(pattern.lastIndex);
    let consumed = 0;
    if (match[1] !== 'input') {
      const html = remainder.match(/^\s*<(ul|ol)\b[^>]*>([\s\S]*?)<\/\1>\s*/i);
      if (html) {
        for (const item of html[2].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) options.push(item[1]);
        consumed = html[0].length;
      } else {
        let current: string[] | undefined, indent = 2, baseIndent = 0;
        for (const raw of remainder.match(/[^\n]*(?:\n|$)/g) || []) {
          if (!raw) break;
          const line = raw.replace(/\n$/, ''), option = line.match(/^( {0,3})([-*+]\s)(.*)$/);
          if (option && (!current || option[1].length === baseIndent)) {
            if (current) options.push(current.join('\n'));
            current = [option[3]]; baseIndent = option[1].length; indent = option[1].length + option[2].length;
          } else if (!line.trim()) { if (current) current.push(''); }
          else if (current && line.startsWith(' '.repeat(indent))) current.push(line.slice(indent));
          else break;
          consumed += raw.length;
        }
        if (current) options.push(current.join('\n'));
      }
    }
    const question = { id: match[2], kind: match[1] as ObjectiveQuestion['kind'], options };
    questions.push(question); blocks.push({ question });
    cursor = pattern.lastIndex + consumed; pattern.lastIndex = cursor;
  }
  if (cursor < content.length) blocks.push({ markdown: content.slice(cursor) });
  return { blocks, questions };
}

/** JSON is valid YAML and preserves strings, arrays and punctuation exactly. */
export function serializeObjectiveAnswers(answers: Record<string, string | string[]>) {
  const ordered = Object.entries(answers).map(([id, answer]) => [id, Array.isArray(answer) ? [...answer].sort() : answer]);
  return JSON.stringify(Object.fromEntries(ordered));
}
