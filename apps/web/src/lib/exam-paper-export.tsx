import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sanitizeStatementHtml as sanitizeSharedStatementHtml } from '@cwnupaa/proctor-shared';
import { pdfChromePath, renderIsolatedPdf } from './isolated-pdf';
import { claimPdfAsset, normalizePdfRaster, PdfAssetLimitError, readInlinePdfAsset, readPdfAsset, type PdfAssetBudget } from './pdf-assets';
import JSZip from 'jszip';
import katex from 'katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import remarkParse from 'remark-parse';
import { unified } from 'unified';
import * as XLSX from 'xlsx';
import { prisma } from '@/lib/db';
import { effectiveEnd, IGNORED_SUBMISSION_STATUS, isXcpcScoring, problemLabel, scaledSubmissionScore, scoreRows, type Rule, type ScoreRecord } from '@/lib/contest-rules';
import { requestHydroProblemAnswerKey, requestHydroProblemFile } from '@/lib/hydro-contest';

type ExportProblem = {
  id: string;
  order: number;
  hydroProblemId: string;
  title: string;
  content: string;
  html: boolean;
  problemType: string;
  config: unknown;
  hydroScore: number;
  score: number;
  files: unknown;
};

type ExportSubmission = ScoreRecord & {
  lang: string;
  code: string;
  statusText: string | null;
  testCases: unknown;
  subtasks: unknown;
};

type ExportCandidate = {
  id: string;
  examNumber: string;
  name: string | null;
  studentId: string | null;
  school: string | null;
  college: string | null;
  major: string | null;
  className: string | null;
  groupName: string | null;
  teamName: string | null;
  ranked: boolean;
  startedAt: Date | null;
  sessions: Array<{ endedAt: Date | null }>;
};

type ObjectiveQuestion = { id: string; kind: 'select' | 'multiselect' | 'input'; options: string[] };

const PENDING_STATUSES = new Set([0, 20, 21, 22]);
const ICPC_PENALTY_STATUSES = new Set([2, 3, 4, 5, 6]);

function safeName(value: string, fallback = '未命名') {
  return value.replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim().slice(0, 120) || fallback;
}

function number(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return '0';
  return Number(value.toFixed(2)).toString();
}

function dateTime(value: Date | null | undefined) {
  if (!value || Number.isNaN(value.getTime())) return '—';
  const parts = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(value).reduce<Record<string, string>>((result, part) => ({ ...result, [part.type]: part.value }), {});
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second}`;
}

function localizedContent(content: string) {
  const source = content.trim();
  if (!source.startsWith('{') && !source.startsWith('[') && !source.startsWith('"')) return content;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const translations = parsed as Record<string, unknown>;
      for (const key of ['zh-CN', 'zh_CN', 'zh', 'cn', 'default', 'en']) if (typeof translations[key] === 'string') return translations[key] as string;
      const first = Object.values(translations).find((value): value is string => typeof value === 'string');
      if (first) return first;
    }
  } catch { /* Plain statement. */ }
  return content;
}

function parseObjective(content: string) {
  const blocks: Array<{ markdown: string } | { question: ObjectiveQuestion }> = [];
  const questions: ObjectiveQuestion[] = [];
  const pattern = /\{\{\s*(select|multiselect|input)\((\d+)\)\s*\}\}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match.index > cursor) blocks.push({ markdown: content.slice(cursor, match.index) });
    const options: string[] = [];
    const position = pattern.lastIndex;
    const lines = content.slice(position).split(/\n/);
    let consumed = 0;
    for (const line of lines) {
      if (!line.trim()) { consumed += line.length + 1; continue; }
      const option = line.match(/^\s*[-*+]\s+(.*)$/);
      if (!option) break;
      options.push(option[1]);
      consumed += line.length + 1;
    }
    const question = { id: match[2], kind: match[1] as ObjectiveQuestion['kind'], options };
    questions.push(question);
    blocks.push({ question });
    cursor = position + consumed;
    pattern.lastIndex = cursor;
  }
  if (cursor < content.length) blocks.push({ markdown: content.slice(cursor) });
  return { blocks, questions };
}

function parseObjectiveAnswers(code: string) {
  const answers: Record<string, string | string[]> = {};
  let current = '';
  for (const rawLine of code.replace(/\r\n?/g, '\n').split('\n')) {
    const item = rawLine.match(/^\s*(\d+)\s*:\s*(.*)$/);
    if (item) {
      current = item[1];
      const value = item[2].trim().replace(/^['"]|['"]$/g, '');
      if (/^\[.*\]$/.test(value)) answers[current] = value.slice(1, -1).split(',').map(part => part.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
      else answers[current] = value;
      continue;
    }
    const list = rawLine.match(/^\s*-\s*(.+?)\s*$/);
    if (current && list) {
      const value = list[1].replace(/^['"]|['"]$/g, '');
      answers[current] = [...(Array.isArray(answers[current]) ? answers[current] as string[] : answers[current] ? [String(answers[current])] : []), value];
    }
  }
  return answers;
}

function objectiveMaxScore(config: unknown, questionId: string) {
  if (!config || typeof config !== 'object') return 0;
  const answers = (config as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object') return 0;
  const raw = (answers as Record<string, unknown>)[questionId];
  if (Array.isArray(raw)) {
    const value = Number(raw[1]);
    return Number.isFinite(value) ? value : 0;
  }
  if (raw && typeof raw === 'object') {
    const scores = Object.values(raw as Record<string, unknown>).map(Number).filter(Number.isFinite);
    return scores.length ? Math.max(...scores) : 0;
  }
  return 0;
}

function objectiveCorrectAnswer(config: unknown, questionId: string) {
  if (!config || typeof config !== 'object') return '—';
  const answers = (config as Record<string, unknown>).answers;
  if (!answers || typeof answers !== 'object') return '—';
  const raw = (answers as Record<string, unknown>)[questionId];
  const display = (value: unknown): string => Array.isArray(value) ? value.map(display).filter(Boolean).join('、') : value === null || value === undefined ? '' : String(value);
  if (Array.isArray(raw)) return display(raw[0]) || '—';
  if (raw && typeof raw === 'object') {
    const entries = Object.entries(raw as Record<string, unknown>).map(([answer, score]) => ({ answer, score: Number(score) })).filter(item => Number.isFinite(item.score));
    if (entries.length) {
      const maximum = Math.max(...entries.map(item => item.score));
      return entries.filter(item => item.score === maximum).map(item => item.answer).join(' / ') || '—';
    }
  }
  return display(raw) || '—';
}

function objectiveQuestionScore(problem: ExportProblem, submission: ExportSubmission, questionId: string, index: number) {
  const cases = Array.isArray(submission.testCases) ? submission.testCases : [];
  const caseValue = cases.find((item) => item && typeof item === 'object' && String((item as Record<string, unknown>).subtaskId ?? '') === questionId)
    || cases[index];
  const subtasks = submission.subtasks && typeof submission.subtasks === 'object' ? submission.subtasks as Record<string, unknown> : {};
  const subtask = subtasks[questionId];
  const rawScore = Number(caseValue && typeof caseValue === 'object' ? (caseValue as Record<string, unknown>).score : undefined);
  const subtaskScore = Number(subtask && typeof subtask === 'object' ? (subtask as Record<string, unknown>).score : subtask);
  const maximum = objectiveMaxScore(problem.config, questionId);
  let raw = Number.isFinite(rawScore) ? rawScore : Number.isFinite(subtaskScore) ? subtaskScore : 0;
  if (!raw && maximum && caseValue && typeof caseValue === 'object') {
    const value = caseValue as Record<string, unknown>;
    if (value.status === 1 || value.status === 'Accepted' || value.statusText === 'Accepted' || value.accepted === true || value.passed === true) raw = maximum;
  }
  return raw * problem.score / (problem.hydroScore || 100);
}

function selectedSubmission(rule: Rule, submissions: ExportSubmission[]) {
  const ordered = [...submissions].filter(item => item.status !== IGNORED_SUBMISSION_STATUS).sort((a, b) => +a.createdAt - +b.createdAt || a.id.localeCompare(b.id));
  let chosen: ExportSubmission | undefined;
  for (const record of ordered) {
    if (isXcpcScoring(rule) && chosen?.status === 1) break;
    if (PENDING_STATUSES.has(record.status)) {
      if (rule === 'KS') chosen = record;
      continue;
    }
    if (isXcpcScoring(rule)) {
      if (record.status === 1 || ICPC_PENALTY_STATUSES.has(record.status)) chosen = record;
    } else if (rule === 'GPLT') {
      if (record.status !== 7 && (!chosen || record.score > chosen.score || (record.score === chosen.score && record.createdAt < chosen.createdAt))) chosen = record;
    } else if (rule === 'OI' || rule === 'KS' || !chosen || record.score > chosen.score) chosen = record;
  }
  return chosen;
}

function verdict(submission: ExportSubmission) {
  if (submission.statusText?.trim()) return submission.statusText.trim();
  const labels: Record<number, string> = { 0: 'Waiting', 1: 'Accepted', 2: 'Wrong Answer', 3: 'Time Limit Exceeded', 4: 'Memory Limit Exceeded', 5: 'Output Limit Exceeded', 6: 'Runtime Error', 7: 'Compile Error', 20: 'Waiting', 21: 'Judging', 22: 'Judging' };
  return labels[submission.status] || `状态 ${submission.status}`;
}

function languageLabel(language: string) {
  const values: Record<string, string> = { c: 'C', cc: 'C++', cpp: 'C++', py: 'Python 3', python: 'Python', java: 'Java' };
  const key = language.toLowerCase().split('.')[0];
  return values[key] || language.replaceAll('.', ' · ');
}

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const keywordGroups: Record<string, string> = {
  c: 'auto break case char const continue default do double else enum extern float for goto if int long register return short signed sizeof static struct switch typedef union unsigned void volatile while include define',
  cpp: 'alignas alignof auto bool break case catch char class const constexpr continue default delete do double else enum explicit export extern float for friend if inline int long namespace new noexcept nullptr operator private protected public register reinterpret_cast return short signed sizeof static struct switch template this throw try typedef typename union unsigned using virtual void volatile while include define',
  python: 'and as assert async await break case class continue def del elif else except finally for from global if import in is lambda match nonlocal not or pass raise return try while with yield True False None',
  java: 'abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null',
};

function languageKey(language: string) {
  const key = language.toLowerCase().split('.')[0];
  if (['c++', 'cpp', 'cxx', 'cc'].includes(key)) return 'cpp';
  if (key === 'py' || key.startsWith('python')) return 'python';
  return key;
}

function highlightCode(source: string, language = '') {
  const keywords = new Set((keywordGroups[languageKey(language)] || '').split(/\s+/));
  const token = /(\/\/[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`|\b\d+(?:\.\d+)?\b|\b[A-Za-z_$][\w$]*\b)/g;
  let html = '', cursor = 0, match: RegExpExecArray | null;
  while ((match = token.exec(source))) {
    html += escapeHtml(source.slice(cursor, match.index));
    const value = match[0], escaped = escapeHtml(value);
    let className = '';
    if (/^(\/\/|#|\/\*)/.test(value)) className = 'token-comment';
    else if (/^["'`]/.test(value)) className = 'token-string';
    else if (/^\d/.test(value)) className = 'token-number';
    else if (keywords.has(value)) className = 'token-keyword';
    else if (/^[A-Z][A-Za-z0-9_$]*$/.test(value)) className = 'token-type';
    html += className ? `<span class="${className}">${escaped}</span>` : escaped;
    cursor = match.index + value.length;
  }
  return html + escapeHtml(source.slice(cursor));
}

function codeBlock(code: string, language = 'text', toolbar = '', showLineNumbers = true) {
  const lineNumbers = code.split('\n').map((_, index) => `${index + 1}\n`).join('');
  return `<div class="code-shell">${toolbar ? `<div class="code-toolbar">${toolbar}</div>` : ''}<div class="code-grid${showLineNumbers ? '' : ' no-line-numbers'}">${showLineNumbers ? `<pre class="line-numbers">${lineNumbers}</pre>` : ''}<pre class="code-content"><code>${highlightCode(code, language) || '&nbsp;'}</code></pre></div></div>`;
}

function parseSamples(content: string) {
  const samples: Record<string, { input?: string; output?: string }> = {};
  const emitted = new Set<string>();
  const markdown = content.replace(/```(input|output)(\d*)\s*\n([\s\S]*?)```/gi, (_all, kind: string, index: string, value: string) => {
    const key = index || '1';
    samples[key] ||= {};
    samples[key][kind.toLowerCase() as 'input' | 'output'] = value.trimEnd();
    if (emitted.has(key)) return '';
    emitted.add(key);
    return `\n\n[[HYDRO_SAMPLE_${key}]]\n\n`;
  });
  return { markdown, samples };
}

function assetName(source: string) {
  let name = source.replace(/^file:\/\//i, '').split(/[?#]/, 1)[0].split('/').filter(Boolean).at(-1) || '';
  try { name = decodeURIComponent(name); } catch { /* Keep original. */ }
  return name;
}

function assetUrl(source: string, assets: Map<string, string>) {
  if (!source) return '';
  return assets.get(source) || assets.get(assetName(source)) || '';
}

type MarkdownNode = {
  type: string;
  value?: string;
  depth?: number;
  ordered?: boolean;
  start?: number | null;
  checked?: boolean | null;
  url?: string;
  title?: string | null;
  alt?: string | null;
  lang?: string | null;
  align?: Array<'left' | 'right' | 'center' | null>;
  children?: MarkdownNode[];
};

const markdownParser = unified().use(remarkParse).use(remarkGfm).use(remarkMath);

function safeLink(source: string) {
  if (/^(?:https?:|mailto:|#|\/)/i.test(source)) return source;
  return '#';
}

function renderMarkdownNode(node: MarkdownNode, assets: Map<string, string>): string {
  const children = () => (node.children || []).map(child => renderMarkdownNode(child, assets)).join('');
  switch (node.type) {
    case 'root': return children();
    case 'text': return escapeHtml(node.value || '');
    case 'paragraph': return `<p>${children()}</p>`;
    case 'heading': return `<h${Math.min(6, Math.max(1, node.depth || 1))}>${children()}</h${Math.min(6, Math.max(1, node.depth || 1))}>`;
    case 'strong': return `<strong>${children()}</strong>`;
    case 'emphasis': return `<em>${children()}</em>`;
    case 'delete': return `<del>${children()}</del>`;
    case 'inlineCode': return `<code class="inline-code">${escapeHtml(node.value || '')}</code>`;
    case 'code': return codeBlock(node.value || '', node.lang || 'text');
    case 'blockquote': return `<blockquote>${children()}</blockquote>`;
    case 'thematicBreak': return '<hr>';
    case 'break': return '<br>';
    case 'link': return `<a href="${escapeHtml(safeLink(node.url || ''))}">${children()}</a>`;
    case 'image': {
      const source = assetUrl(node.url || '', assets);
      if (!/^data:image\/webp;base64,[a-z\d+/=]+$/i.test(source)) return '';
      return `<img src="${escapeHtml(source)}" alt="${escapeHtml(node.alt || '')}">`;
    }
    case 'list': {
      const tag = node.ordered ? 'ol' : 'ul';
      const start = node.ordered && node.start && node.start !== 1 ? ` start="${node.start}"` : '';
      return `<${tag}${start}>${children()}</${tag}>`;
    }
    case 'listItem': return `<li>${node.checked === true ? '<span class="task-mark">☑</span>' : node.checked === false ? '<span class="task-mark">☐</span>' : ''}${children()}</li>`;
    case 'table': return `<table><tbody>${children()}</tbody></table>`;
    case 'tableRow': return `<tr>${children()}</tr>`;
    case 'tableCell': return `<td>${children()}</td>`;
    case 'inlineMath':
    case 'math': {
      try { return katex.renderToString(node.value || '', { displayMode: node.type === 'math', throwOnError: false, output: 'html' }); }
      catch { return `<code class="inline-code">${escapeHtml(node.value || '')}</code>`; }
    }
    case 'html': return sanitizeStatementHtml(node.value || '', assets);
    default: return children();
  }
}

function markdownContent(content: string, assets: Map<string, string>) {
  const parsed = parseSamples(content);
  return parsed.markdown.split(/(\[\[HYDRO_SAMPLE_[^\]]+\]\])/g).map(chunk => {
    const token = chunk.match(/^\[\[HYDRO_SAMPLE_(.+)\]\]$/);
    if (token) {
      const sample = parsed.samples[token[1]] || {};
      return `<section class="sample"><h4>样例 ${escapeHtml(token[1])}</h4><div class="sample-grid">${sample.input !== undefined ? `<div><strong>输入</strong>${codeBlock(sample.input, 'text', '', false)}</div>` : ''}${sample.output !== undefined ? `<div><strong>输出</strong>${codeBlock(sample.output, 'text', '', false)}</div>` : ''}</div></section>`;
    }
    if (!chunk) return '';
    const tree = markdownParser.parse(chunk) as MarkdownNode;
    return `<div class="markdown">${renderMarkdownNode(tree, assets)}</div>`;
  }).join('');
}

function sanitizeStatementHtml(content: string, assets: Map<string, string>) {
  return sanitizeSharedStatementHtml(content, { rewriteImageUrl: source => assetUrl(source, assets), embeddedImagesOnly: true });
}

function objectiveAnswer(question: ObjectiveQuestion, answer: string | string[] | undefined, correctAnswer: string, score: number, assets: Map<string, string>, submitted: boolean) {
  const values = Array.isArray(answer) ? answer : answer ? [answer] : [];
  const control = question.kind === 'input' ? `<div class="fill-answer">${escapeHtml(values[0] || (submitted ? '未作答' : '未提交'))}</div>` : `<div class="objective-options">${question.options.map((option, index) => {
      const letter = String.fromCharCode(65 + index);
      const text = option.replace(/^\s*(?:[（(]?[A-Za-z][.、)）．]\s*)/, '');
      return `<div class="objective-option"><span>${letter}.</span>${markdownContent(text, assets)}</div>`;
    }).join('')}</div>`;
  return `<section class="objective-question">${control}<div class="answer-score"><span>考生答案：<strong>${escapeHtml(values.length ? values.join('、') : submitted ? '未作答' : '未提交')}</strong></span><span class="correct-answer">正确答案：<strong>${escapeHtml(correctAnswer)}</strong></span><span>得分：<b>${number(score)} 分</b></span></div></section>`;
}

function objectiveStatement({ parsed, problem, submission, answers, assets }: {
  parsed: ReturnType<typeof parseObjective>;
  problem: ExportProblem;
  submission?: ExportSubmission;
  answers: Record<string, string | string[]>;
  assets: Map<string, string>;
}) {
  const rendered: string[] = [];
  for (let index = 0; index < parsed.blocks.length; index += 1) {
    const block = parsed.blocks[index];
    const next = parsed.blocks[index + 1];
    if ('markdown' in block && next && 'question' in next) {
      const questionIndex = parsed.questions.indexOf(next.question);
      rendered.push(`<section class="objective-item">${markdownContent(block.markdown, assets)}${objectiveAnswer(next.question, answers[next.question.id], objectiveCorrectAnswer(problem.config, next.question.id), submission ? objectiveQuestionScore(problem, submission, next.question.id, questionIndex) : 0, assets, Boolean(submission))}</section>`);
      index += 1;
      continue;
    }
    if ('markdown' in block) rendered.push(markdownContent(block.markdown, assets));
    else {
      const questionIndex = parsed.questions.indexOf(block.question);
      rendered.push(`<section class="objective-item">${objectiveAnswer(block.question, answers[block.question.id], objectiveCorrectAnswer(problem.config, block.question.id), submission ? objectiveQuestionScore(problem, submission, block.question.id, questionIndex) : 0, assets, Boolean(submission))}</section>`);
    }
  }
  return rendered.join('');
}

function problemPaper(problem: ExportProblem, submission: ExportSubmission | undefined, assets: Map<string, string>, rule: Rule) {
  const content = localizedContent(problem.content).replace(/\r\n?/g, '\n');
  const objective = ['objective', 'submit_answer'].includes(problem.problemType.toLowerCase());
  const finalScore = submission ? submission.manualScore ?? scaledSubmissionScore(rule, submission.score, problem.score, problem.hydroScore) : 0;
  const parsed = objective ? parseObjective(content) : null;
  const answers = submission ? parseObjectiveAnswers(submission.code) : {};
  const statement = problem.html ? `<div class="statement-html">${sanitizeStatementHtml(content, assets)}</div>` : objective && parsed
    ? objectiveStatement({ parsed, problem, submission, answers, assets }) : markdownContent(content, assets);
  const toolbar = submission && !objective ? `<strong class="verdict">评测结果：${escapeHtml(verdict(submission))}</strong><span>${escapeHtml(languageLabel(submission.lang))}</span><b>得分：${number(finalScore)} 分</b>` : '';
  const submittedCode = submission && !objective ? `<section class="submission-code">${codeBlock(submission.code, submission.lang, toolbar)}</section>` : '';
  const fallback = submission && objective && parsed && !parsed.questions.length ? `<div class="objective-fallback"><span>考生答案：<strong>${escapeHtml(submission.code || '未作答')}</strong></span><span></span><span>得分：<b>${number(finalScore)} 分</b></span></div>` : '';
  const unsubmittedProgramming = !submission && !objective
    ? `<div class="not-submitted"><strong>未提交</strong><b>得分：0 分</b></div>`
    : '';
  return `<section class="problem"><header class="problem-heading"><h2>${problemLabel(problem.order)} - ${escapeHtml(problem.title)}</h2><strong>${number(finalScore)} / ${number(problem.score)} 分</strong></header><div class="statement">${statement}</div>${submittedCode}${fallback}${unsubmittedProgramming}</section>`;
}

const PAPER_CSS = String.raw`
  @page { size: A4; margin: 12mm 11mm 14mm; }
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; color: #111; background: #fff; font-family: "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", Arial, sans-serif; font-size: 9.5pt; line-height: 1.58; }
  body { print-color-adjust: exact; -webkit-print-color-adjust: exact; }
  .paper { width: 100%; overflow-wrap: anywhere; }
  .paper-title { margin: 0 0 4mm; text-align: center; font-size: 18pt; color: #000; font-weight: 700; }
  .candidate-table { width: 100%; border-collapse: collapse; margin-bottom: 7mm; table-layout: fixed; }
  .candidate-table th, .candidate-table td { border: .25mm solid #8d8d8d; padding: 2.2mm 2.5mm; vertical-align: middle; word-break: break-word; font-size: 12pt; }
  .candidate-table th { width: 13%; color: #111; background: #fff; font-weight: 700; }
  .candidate-table td { width: 20%; }
  .score-emphasis, .problem-heading > strong, .answer-score b, .objective-fallback b, .code-toolbar b { color: #000; font-size: 11pt; font-weight: 800; }
  .problem { margin: 0 0 8mm; padding-top: 1mm; break-inside: auto; page-break-inside: auto; }
  .problem + .problem { border-top: .35mm solid #555; padding-top: 6mm; }
  .problem-heading { display: flex; align-items: center; justify-content: space-between; gap: 5mm; margin-bottom: 3mm; break-after: avoid; }
  .problem-heading h2 { min-width: 0; margin: 0; font-size: 15pt; color: #111; }
  .problem-heading > strong { white-space: nowrap; }
  .not-submitted { display: flex; align-items: center; justify-content: space-between; gap: 4mm; margin: 4mm 0 0; padding: 2.2mm 3mm; border-left: 1mm solid #333; color: #111; background: #eeeeee; font-size: 12pt; break-inside: avoid; }
  .not-submitted strong, .not-submitted b { font-weight: 800; }
  .statement { font-size: 12pt; line-height: 1.62; }
  .statement img { display: block; width: auto; height: auto; max-width: 100%; max-height: 238mm; margin: 2mm auto; object-fit: contain; break-inside: avoid; }
  .statement table { width: 100%; border-collapse: collapse; table-layout: fixed; }
  .statement th, .statement td { border: .25mm solid #aaa; padding: 1.8mm; overflow-wrap: anywhere; }
  .statement h1, .statement h2, .statement h3, .statement h4 { color: #111; break-after: avoid; }
  .statement h1 { font-size: 15pt; } .statement h2, .statement h3, .statement h4 { font-size: 12pt; }
  .statement p { margin: 1.8mm 0; orphans: 3; widows: 3; }
  .statement blockquote { margin: 2mm 0; padding: 1.5mm 3mm; border-left: 1mm solid #555; background: #f3f3f3; }
  .inline-code { padding: .2mm 1mm; border-radius: .8mm; color: #111; background: #eeeeee; font-family: Menlo, Consolas, monospace; }
  .sample { margin: 4mm 0; break-inside: avoid; }
  .sample h4 { margin: 0 0 1.5mm; color: #222; font-size: 10pt; }
  .sample-grid { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 3mm; }
  .sample-grid > div > strong { display: block; margin-bottom: 1mm; color: #222; }
  .code-shell { width: 100%; overflow: hidden; border: .25mm solid #aaa; border-radius: 1.5mm; background: #f7f7f7; break-inside: auto; }
  .code-toolbar { display: grid; grid-template-columns: 1fr auto auto; align-items: center; gap: 4mm; min-height: 9mm; padding: 1.8mm 3mm; border-bottom: .25mm solid #aaa; color: #222; background: #e8e8e8; break-after: avoid; }
  .code-toolbar .verdict { color: #111; font-size: 9.5pt; }
  .code-toolbar b { white-space: nowrap; }
  .code-grid { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: stretch; }
  .code-grid.no-line-numbers { grid-template-columns: minmax(0, 1fr); }
  .code-grid pre { margin: 0; padding: 2.5mm; white-space: pre-wrap; word-break: break-all; overflow-wrap: anywhere; font-family: Menlo, Consolas, "Liberation Mono", monospace; font-size: 8.1pt; line-height: 1.5; tab-size: 4; }
  .line-numbers { min-width: 10mm; color: #888; text-align: right; user-select: none; border-right: .25mm solid #bbb; background: #ededed; }
  .token-comment { color: #777; font-style: italic; } .token-string { color: #444; } .token-number { color: #555; } .token-keyword { color: #000; font-weight: 750; } .token-type { color: #222; text-decoration: underline; text-decoration-color: #aaa; }
  .submission-code { margin-top: 4mm; }
  .objective-item { break-inside: avoid-page; page-break-inside: avoid; }
  .objective-question { margin: 2.5mm 0 5mm; break-inside: avoid; }
  .objective-options { display: grid; gap: .8mm; }
  .objective-option { display: grid; grid-template-columns: 7mm minmax(0, 1fr); align-items: start; gap: 1mm; color: #222; font-size: 12pt; line-height: 1.5; }
  .objective-option > span { color: #222; font-size: 12pt; font-weight: 400; }
  .objective-option .markdown p { margin: 0; }
  .fill-answer { min-height: 10mm; padding: 2.5mm; border: .25mm solid #bbb; border-radius: 1.2mm; background: #fafafa; }
  .answer-score, .objective-fallback { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto; align-items: center; gap: 4mm; margin-top: 2mm; padding: 2.2mm 3mm; border-left: 1mm solid #333; color: #111; background: #eeeeee; }
  .answer-score .correct-answer { text-align: center; }
  .answer-score > span:last-child { text-align: right; white-space: nowrap; }
  .answer-score b, .objective-fallback b { margin-left: 1mm; }
  .objective-fallback { white-space: pre-wrap; }
  .katex-display { overflow: hidden; }
  a { color: #111; text-decoration: underline; }
`;

function paperHtml({ examName, candidate, startAt, endAt, totalScore, totalMaximum, problems, submissions, assets, rule }: {
  examName: string;
  candidate: ExportCandidate;
  startAt: Date;
  endAt: Date;
  totalScore: number;
  totalMaximum: number;
  problems: ExportProblem[];
  submissions: Map<string, ExportSubmission>;
  assets: Map<string, Map<string, string>>;
  rule: Rule;
}) {
  const value = (text: string | null | undefined) => escapeHtml(text || '—');
  const problemMarkup = problems.map(problem => problemPaper(problem, submissions.get(problem.id), assets.get(problem.id) || new Map(), rule)).join('');
  const markup = `<main class="paper">
    <h1 class="paper-title">${escapeHtml(examName)}</h1>
    <table class="candidate-table"><tbody>
      <tr><th>姓名</th><td>${value(candidate.name)}</td><th>学号</th><td>${value(candidate.studentId || candidate.examNumber)}</td><th>学院</th><td>${value(candidate.college)}</td></tr>
      <tr><th>专业</th><td>${value(candidate.major)}</td><th>班级</th><td>${value(candidate.className)}</td><th>得分/总分</th><td><strong class="score-emphasis">${number(totalScore)} 分/${number(totalMaximum)} 分</strong></td></tr>
      <tr><th>开始考试时间</th><td colspan="2">${dateTime(startAt)}</td><th>结束考试时间</th><td colspan="2">${dateTime(endAt)}</td></tr>
    </tbody></table>
    ${problemMarkup}
  </main>`;
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${escapeHtml(candidate.studentId || candidate.examNumber)}${escapeHtml(candidate.name || '')}</title><style>${PAPER_CSS}</style></head><body>${markup}</body></html>`;
}

async function printPdf(chrome: string, html: string, pdfPath: string) {
  await renderIsolatedPdf(html, pdfPath, chrome);
}

async function runPool<T>(items: T[], limit: number, task: (item: T, index: number) => Promise<void>) {
  let index = 0;
  const workers = Array.from({ length: Math.min(limit, Math.max(1, items.length)) }, async () => {
    while (index < items.length) {
      const current = index++;
      await task(items[current], current);
    }
  });
  await Promise.all(workers);
}

function fileNames(files: unknown) {
  if (!Array.isArray(files)) return [];
  return files.map(item => typeof item === 'string' ? item : item && typeof item === 'object' ? String((item as Record<string, unknown>).name || '') : '').filter(Boolean);
}

async function problemAssets(exam: { platformBaseUrl: string }, problem: ExportProblem, budget: PdfAssetBudget) {
  const content = localizedContent(problem.content);
  const names = new Set(fileNames(problem.files));
  for (const match of content.matchAll(/file:\/\/([^\s)'"<>]+)/gi)) names.add(assetName(match[0]));
  const assets = new Map<string, string>();
  await runPool([...names], 4, async name => {
    claimPdfAsset(budget);
    try {
      const response = await requestHydroProblemFile(exam, problem.hydroProblemId, name);
      assets.set(name, await normalizePdfRaster(await readPdfAsset(response, budget)));
    } catch (error) {
      if (error instanceof PdfAssetLimitError) throw error;
      // Non-image and unavailable attachments are omitted rather than becoming browser requests.
    }
  });
  const inline = new Set(content.match(/data:image\/(?:png|jpeg|webp|gif);base64,[a-z\d+/=]+/gi) || []);
  for (const source of inline) {
    claimPdfAsset(budget);
    try { assets.set(source, await normalizePdfRaster(readInlinePdfAsset(source, budget))); }
    catch (error) { if (error instanceof PdfAssetLimitError) throw error; }
  }
  return assets;
}

async function workbookBytes(examName: string, problems: ExportProblem[], candidates: ExportCandidate[], rows: ReturnType<typeof scoreRows>['rows']) {
  const byExamNumber = new Map(candidates.map(candidate => [candidate.examNumber, candidate]));
  const header = ['排名', '姓名', '学号', '学院', '专业', '班级', '总得分', ...problems.map(problem => `${problemLabel(problem.order)}-${problem.title}`)];
  const values: Array<Array<string | number>> = [header];
  for (const row of rows) {
    const candidate = byExamNumber.get(row.username);
    if (!candidate) continue;
    values.push([
      row.rank,
      candidate.name || '',
      `\u200B${candidate.studentId || candidate.examNumber}`,
      candidate.college || '',
      candidate.major || '',
      candidate.className || '',
      Number(row.score.toFixed(2)),
      ...row.cells.map(cell => cell.score === null ? 0 : Number(cell.score.toFixed(2))),
    ]);
  }
  const sheet = XLSX.utils.aoa_to_sheet(values);
  sheet['!cols'] = header.map((_, index) => ({ wch: index === 0 ? 8 : index === 1 ? 14 : index === 2 ? 18 : index < 6 ? 20 : index === 6 ? 12 : 24 }));
  sheet['!autofilter'] = { ref: `A1:${XLSX.utils.encode_col(header.length - 1)}${Math.max(1, values.length)}` };
  const workbook = XLSX.utils.book_new();
  workbook.Props = { Title: `${examName} 最终成绩`, Subject: '考试最终成绩', Author: '监考平台' };
  XLSX.utils.book_append_sheet(workbook, sheet, '最终成绩');
  const raw = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx', compression: true }) as Buffer;
  const archive = await JSZip.loadAsync(raw);
  const styleEntry = archive.file('xl/styles.xml');
  const sheetEntry = archive.file('xl/worksheets/sheet1.xml');
  if (styleEntry && sheetEntry) {
    const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <numFmts count="0"/>
  <fonts count="3">
    <font><sz val="12"/><color rgb="FF111111"/><name val="Arial"/></font>
    <font><b/><sz val="12"/><color rgb="FF111111"/><name val="Arial"/></font>
    <font><b/><sz val="12"/><color rgb="FF000000"/><name val="Arial"/></font>
  </fonts>
  <fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>
  <borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left style="thin"><color rgb="FFB7B7B7"/></left><right style="thin"><color rgb="FFB7B7B7"/></right><top style="thin"><color rgb="FFB7B7B7"/></top><bottom style="thin"><color rgb="FFB7B7B7"/></bottom><diagonal/></border></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="5">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
    <xf numFmtId="0" fontId="2" fillId="0" borderId="1" xfId="0" applyFont="1" applyBorder="1" applyAlignment="1"><alignment horizontal="right" vertical="center"/></xf>
    <xf numFmtId="49" fontId="0" fillId="0" borderId="1" xfId="0" applyNumberFormat="1" applyFont="1" applyBorder="1" applyAlignment="1"><alignment vertical="center"/></xf>
  </cellXfs>
  <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles><dxfs count="0"/><tableStyles count="0" defaultTableStyle="TableStyleMedium2" defaultPivotStyle="PivotStyleMedium4"/>
</styleSheet>`;
    let worksheet = await sheetEntry.async('string');
    worksheet = worksheet.replace(/<sheetViews>[\s\S]*?<\/sheetViews>/, '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>');
    worksheet = worksheet.replace(/<sheetData>([\s\S]*?)<\/sheetData>/, (_all, rowsXml: string) => {
      const styledRows = rowsXml.replace(/<row r="(\d+)"([^>]*)>([\s\S]*?)<\/row>/g, (_row, rowNumber: string, attributes: string, cells: string) => {
        const header = rowNumber === '1';
        const styledCells = cells.replace(/<c r="([A-Z]+)\d+"/g, (cell, column: string) => {
          const index = XLSX.utils.decode_col(column);
          const style = header ? 1 : column === 'C' ? 4 : index >= 6 ? 3 : 2;
          return `${cell} s="${style}"`;
        });
        return `<row r="${rowNumber}"${attributes} ht="${header ? 38 : 28}" customHeight="1">${styledCells}</row>`;
      });
      return `<sheetData>${styledRows}</sheetData>`;
    });
    archive.file('xl/styles.xml', styles);
    archive.file('xl/worksheets/sheet1.xml', worksheet);
  }
  return Buffer.from(await archive.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } }));
}

export async function buildExamPaperArchive(examId: string, options: { candidateLimit?: number; keepFirstPdfAt?: string } = {}) {
  const exam = await prisma.exam.findUnique({
    where: { id: examId },
    include: {
      problems: { orderBy: { order: 'asc' } },
      candidates: {
        orderBy: [{ seatNo: 'asc' }, { examNumber: 'asc' }],
        include: { sessions: { select: { endedAt: true }, orderBy: { createdAt: 'asc' } } },
      },
    },
  });
  if (!exam) throw new Error('考试不存在');
  const allCandidates = exam.candidates as ExportCandidate[];
  const candidates = options.candidateLimit ? allCandidates.slice(0, options.candidateLimit) : allCandidates;
  const submissions = await prisma.contestSubmission.findMany({
    where: { examId, status: { not: IGNORED_SUBMISSION_STATUS } },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true, candidateId: true, problemId: true, status: true, statusText: true, score: true, manualScore: true, createdAt: true, lang: true, code: true, testCases: true, subtasks: true },
  }) as ExportSubmission[];
  const problems = await Promise.all((exam.problems as ExportProblem[]).map(async problem => {
    if (!['objective', 'submit_answer'].includes(problem.problemType.toLowerCase())) return problem;
    try {
      const answers = await requestHydroProblemAnswerKey(exam, problem.hydroProblemId);
      const config = problem.config && typeof problem.config === 'object' ? problem.config as Record<string, unknown> : {};
      return { ...problem, config: { ...config, answers } };
    } catch {
      // Older Hydro bridge versions do not expose the protected answer-key
      // endpoint. The PDF remains exportable and uses a dash until upgraded.
      return problem;
    }
  }));
  const ranking = scoreRows(exam, problems, allCandidates.filter(candidate => candidate.ranked), submissions, new Date(Math.max(Date.now(), exam.endAt.getTime())), true);
  const rankingByCandidate = new Map(ranking.rows.map(row => [allCandidates.find(candidate => candidate.examNumber === row.username)?.id || '', row]));
  const assets = new Map<string, Map<string, string>>();
  const assetBudget: PdfAssetBudget = { bytes: 0, count: 0 };
  await runPool(problems, 2, async problem => { assets.set(problem.id, await problemAssets(exam, problem, assetBudget)); });
  const temporary = await mkdtemp(join(tmpdir(), 'proctor-papers-'));
  const chrome = await pdfChromePath();
  const generated: Array<{ candidate: ExportCandidate; path: string; fileName: string }> = [];
  try {
    await runPool(candidates, 3, async (candidate, index) => {
      const chosen = new Map<string, ExportSubmission>();
      for (const problem of problems) {
        const submission = selectedSubmission(exam.contestRule, submissions.filter(item => item.candidateId === candidate.id && item.problemId === problem.id));
        if (submission) chosen.set(problem.id, submission);
      }
      const totalScore = rankingByCandidate.get(candidate.id)?.score ?? [...chosen.entries()].reduce((sum, [problemId, submission]) => {
        const problem = problems.find(item => item.id === problemId)!;
        return sum + (submission.manualScore ?? scaledSubmissionScore(exam.contestRule, submission.score, problem.score, problem.hydroScore));
      }, 0);
      const startAt = candidate.startedAt || exam.startAt;
      const endAt = effectiveEnd(exam, candidate.startedAt);
      const html = paperHtml({ examName: exam.name, candidate, startAt, endAt, totalScore, totalMaximum: problems.reduce((sum, problem) => sum + problem.score, 0), problems, submissions: chosen, assets, rule: exam.contestRule });
      const pdfPath = join(temporary, `${index}.pdf`);
      await printPdf(chrome, html, pdfPath);
      const fileName = `${safeName(candidate.studentId || candidate.examNumber, '无学号')}${safeName(candidate.name || '', '')}.pdf`;
      generated.push({ candidate, path: pdfPath, fileName });
    });
    generated.sort((left, right) => candidates.indexOf(left.candidate) - candidates.indexOf(right.candidate));
    if (options.keepFirstPdfAt && generated[0]) await writeFile(options.keepFirstPdfAt, await readFile(generated[0].path));
    const zip = new JSZip();
    for (const item of generated) zip.file(item.fileName, await readFile(item.path));
    zip.file('最终成绩.xlsx', await workbookBytes(exam.name, problems, allCandidates, ranking.rows));
    const body = await zip.generateAsync({ type: 'uint8array', compression: 'DEFLATE', compressionOptions: { level: 6 } });
    return { body, fileName: `${safeName(exam.name)}-试卷.zip`, candidateCount: generated.length };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}
