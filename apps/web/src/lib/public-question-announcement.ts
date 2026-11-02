export function publicQuestionAnnouncement(question: {
  content: string; answer: string | null; problemIndex: string | null; problemTitle: string | null;
}) {
  const problem = question.problemIndex ? `题目 ${question.problemIndex} · ${question.problemTitle || ''}\n\n` : '';
  // Announcements use the same receipt and live-popup delivery as all notices.
  // Do not expose the asking candidate's name, exam number or private metadata.
  return `### 新的公开提问\n\n${problem}**提问**\n\n${question.content.slice(0, 4500)}${question.answer ? `\n\n**监考老师回复**\n\n${question.answer.slice(0, 4500)}` : ''}\n\n完整讨论请查看「赛时答疑 → 公开提问」。`;
}
