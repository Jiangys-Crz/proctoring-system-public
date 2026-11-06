function excerpt(content: string) {
  let end = Math.min(4500, content.length);
  // A character cut through an own-store image address creates a new,
  // nonexistent object key, which would then retry forever during sync.
  // Keep complete URL tokens; avoid a nested Markdown regex on user content.
  const tokens = /https?:\/\/[^\s<>"')]+|\/\/[^\s<>"')]+|(?<![A-Za-z0-9:/])\/api\/(?:uploads\/file|qa-assets)\/[^\s<>"')]+/g;
  for (const match of content.matchAll(tokens)) {
    if (match.index >= end) break;
    if (match.index + match[0].length > end) { end = match.index; break; }
  }
  // Avoid splitting an emoji's UTF-16 pair at the excerpt boundary as well.
  if (end > 0 && /[\uD800-\uDBFF]/.test(content[end - 1]) && /[\uDC00-\uDFFF]/.test(content[end] || '')) end--;
  return content.slice(0, end);
}

export function publicQuestionAnnouncement(question: {
  content: string; answer: string | null; problemIndex: string | null; problemTitle: string | null;
}) {
  const problem = question.problemIndex ? `题目 ${question.problemIndex} · ${question.problemTitle || ''}\n\n` : '';
  // Announcements use the same receipt and live-popup delivery as all notices.
  // Do not expose the asking candidate's name, exam number or private metadata.
  return `### 新的公开提问\n\n${problem}**提问**\n\n${excerpt(question.content)}${question.answer ? `\n\n**监考老师回复**\n\n${excerpt(question.answer)}` : ''}\n\n完整讨论请查看「赛时答疑 → 公开提问」。`;
}
