'use client';

import {
  AlertTriangle,
  ArrowLeft,
  Bell,
  CalendarClock,
  Check,
  ChevronRight,
  Clock3,
  Code2,
  Download,
  ExternalLink,
  FileCode2,
  FileText,
  History,
  LayoutDashboard,
  ListChecks,
  LoaderCircle,
  Medal,
  MessageCircleQuestion,
  PlayCircle,
  Printer,
  RefreshCw,
  Send,
  Trophy,
  User,
  Users,
  X,
  Zap
} from 'lucide-react';
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import { parentRoutePath, sanitizeStatementHtml, groupJudgeLanguages, statementDownloadTarget, problemTypeLabel } from '@cwnupaa/proctor-shared';
import { saveDownloadBlob } from '@/lib/file-download';
import { startSerialPolling, submissionPollDelay, readWithDeadline } from '@/lib/contest-polling';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import { ClientApi, ClientApiError, absoluteMediaUrl, defaultApiBase, trustedApiBase, restoreBoundSession, isExpiredClientSessionError } from '@/lib/api';
import { LeaderboardTable } from '@cwnupaa/proctor-shared/leaderboard-table';
import type { LeaderboardData } from '@cwnupaa/proctor-shared/leaderboard';
import { CodeEditor as HighlightCodeEditor, CodePreview } from './CodeHighlight';
import { MarkdownComposer, MarkdownContent } from './MarkdownComposer';

type ContestRule = 'acm' | 'oi' | 'ioi' | 'ks';
type ContestPage = 'overview' | 'problems' | 'problem' | 'problemSubmissions' | 'submit' | 'submissions' | 'leaderboard' | 'qa' | 'print';

type ContestRoute = {
  page: ContestPage;
  pid?: number;
  submissionId?: string;
};

function contestRouteFromPathname(pathname: string): ContestRoute {
  const segments = pathname.replace(/^\/contest\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  if (!segments.length || segments[0] === 'overview') return { page: 'overview' };
  if (segments[0] === 'problems') {
    const pid = Number(segments[1]);
    if (!Number.isSafeInteger(pid)) return { page: 'problems' };
    if (segments[2] === 'submit') return { page: 'submit', pid };
    if (segments[2] === 'submissions') return { page: 'problemSubmissions', pid, submissionId: segments[3] };
    return { page: 'problem', pid };
  }
  if (segments[0] === 'submissions') {
    return { page: 'submissions', submissionId: segments[1] };
  }
  if (segments[0] === 'leaderboard') return { page: 'leaderboard' };
  if (segments[0] === 'qa') return { page: 'qa' };
  if (segments[0] === 'print') return { page: 'print' };
  return { page: 'overview' };
}

function contestPath(route: ContestRoute) {
  if (route.page === 'overview') return '/contest/overview';
  if (route.page === 'problems') return '/contest/problems';
  if (route.page === 'problem') return `/contest/problems/${route.pid}`;
  if (route.page === 'problemSubmissions') {
    const base = `/contest/problems/${route.pid}/submissions`;
    return route.submissionId ? `${base}/${encodeURIComponent(route.submissionId)}` : base;
  }
  if (route.page === 'submit') return `/contest/problems/${route.pid}/submit`;
  if (route.page === 'submissions') return route.submissionId ? `/contest/submissions/${encodeURIComponent(route.submissionId)}` : '/contest/submissions';
  return `/contest/${route.page}`;
}

interface ContestProblem {
  index: string;
  pid: number;
  problemId?: string;
  title: string;
  score: number;
  content: string;
  html?: boolean;
  problemType?: string;
  config?: Record<string, unknown>;
  timeLimit?: number;
  memoryLimit?: number;
  languages: string[];
}

type ObjectiveQuestion = { id: string; kind: 'select' | 'multiselect' | 'input'; options: string[] };
type ObjectiveAnswer = string | string[];

interface ContestFile {
  name: string;
  size?: number;
  type: 'public' | 'private';
  problemId?: string;
  problemIndex?: string;
}

interface Submission {
  id: string;
  problemIndex: string;
  problemTitle: string;
  status: number;
  statusText: string;
  score: number | null;
  resultHidden?: boolean;
  scoreVisible?: boolean;
  passedTestCases?: number | null;
  totalTestCases?: number | null;
  time: number;
  memory: number;
  lang: string;
  code: string;
  submittedBy?: { username: string; displayName?: string };
  testCases: Array<{ id?: number; subtaskId?: number; status?: number; score?: number; time?: number; memory?: number; message?: string }>;
  subtasks?: Record<string, { score?: number; status?: number }>;
  createdAt: string;
  canViewDetail?: boolean;
  isOwn?: boolean;
  detailsLoaded?: boolean;
  updatedAt?: string;
}

interface ContestData {
  revision?: string;
  contest: {
    id: string;
    title: string;
    rule: ContestRule;
    sourceRule?: string;
    content: string;
    beginAt: string;
    endAt: string;
    flexible?: boolean;
    allowPrint?: boolean;
    printMode?: 'DISABLED' | 'VIRTUAL' | 'PHYSICAL';
    allowTeamSubmissionView?: boolean;
    leaderOnlySubmission?: boolean;
    contestType?: 'INDIVIDUAL' | 'TEAM';
    showTestCaseCount?: boolean;
    showObjectiveScore?: boolean;
    latestStartAt?: string;
    durationMinutes?: number;
    candidateCount?: number;
    langs: Array<{ id: string; name: string }>;
    languagesError?: string;
  };
  problems: ContestProblem[];
  files: Array<ContestFile & { downloadUrl?: string }>;
  user: {
    uid: number | string; username: string; displayName?: string; examNumber?: string; name?: string; school?: string; college?: string;
    major?: string; groupName?: string; roomName?: string; seatNo?: string; teamName?: string; teamMembers?: string[]; studentId?: string; isTeamLeader?: boolean;
  };
  submissions: Submission[];
  session: { status: string; startedAt?: string | null; latestStartAt?: string | null; effectiveEndAt?: string | null; canSubmit?: boolean; canViewSubmissions?: boolean; lockdown?: boolean; lockdownReason?: string | null };
}

function LeaderboardTables({ leaderboard, contest, problems, onRefresh, refreshing = false, onTimeChange }: { leaderboard: LeaderboardData; contest: ContestData['contest']; problems: ContestProblem[]; onRefresh?: () => void; refreshing?: boolean; onTimeChange?: (timePoint: number | null) => void }) {
  return <LeaderboardTable leaderboard={leaderboard} rule={(contest.sourceRule || contest.rule).toUpperCase()} title={contest.title}
    exportScope="visible" onDownload={saveDownloadBlob}
    startAt={contest.beginAt} endAt={contest.endAt} onRefresh={onRefresh} refreshing={refreshing} onTimeChange={onTimeChange}
    problems={problems.map(problem => ({ id: String(problem.pid), label: problem.index, title: problem.title, score: problem.score }))} />;
}

interface ConfirmSubmission {
  problem: ContestProblem;
  lang: string;
  languageName: string;
  code: string;
}

interface ExamQAData {
  questions: Array<{ id: string; candidateId: string; owned: boolean; isPublished: boolean; problemPid: string | null; problemIndex: string | null; problemTitle: string | null; content: string; answer: string | null; answeredAt: string | null; createdAt: string; messages: Array<{ id: string; sender: 'CANDIDATE' | 'ADMIN'; content: string; acknowledgedAt: string | null; createdAt: string }> }>;
  announcements: Array<{ id: string; candidateId: string | null; content: string; createdAt: string; acknowledged: boolean }>;
}

type CandidateNotification = { id: string; kind: 'announcement' | 'reply'; content: string; createdAt: string; candidateId?: string | null; questionId?: string };
const notificationKey = (item: CandidateNotification) => `${item.kind}:${item.id}`;

function createMockContestData(rule: ContestRule = 'ioi', running = false): ContestData {
  const beginAt = new Date(Date.now() + (running ? -30 * 60_000 : 5 * 60_000));
  const endAt = new Date(beginAt.getTime() + 2 * 60 * 60 * 1000);
  const langs = [
    { id: 'cpp', name: 'C++ 17' },
    { id: 'python', name: 'Python 3' },
    { id: 'java', name: 'Java 17' }
  ];
  return {
    contest: {
      id: 'mock-contest',
      title: '比赛页面预览',
      rule,
      sourceRule: `mock-${rule}`,
      content: '# 比赛规则\n\n这是比赛页面预览。正式比赛的规则、时间和测评结果由考试系统提供。\n\n- 请独立完成题目\n- 比赛结束后以最终成绩为准',
      beginAt: beginAt.toISOString(),
      endAt: endAt.toISOString(),
      flexible: rule !== 'acm',
      allowPrint: true,
      printMode: 'PHYSICAL',
      allowTeamSubmissionView: true,
      leaderOnlySubmission: false,
      contestType: 'INDIVIDUAL',
      showObjectiveScore: true,
      latestStartAt: endAt.toISOString(),
      durationMinutes: 120,
      candidateCount: 1,
      langs
    },
    problems: [
      {
        index: 'A',
        pid: 1001,
        title: '数组之和',
        score: 40,
        content: '# 题目描述\n\n给定一个长度为 $n$ 的整数数组，求所有元素之和。\n\n## 输入格式\n\n第一行一个整数 $n$。第二行包含 $n$ 个整数。\n\n## 输出格式\n\n输出数组元素之和。\n\n```\n5\n1 2 3 4 5\n```',
        timeLimit: 1000,
        memoryLimit: 256,
        languages: langs.map((language) => language.id)
      },
      {
        index: 'B',
        pid: 1002,
        title: '最短路径',
        score: 60,
        content: '# 题目描述\n\n给定一张带非负边权的图，求指定起点到终点的最短距离。\n\n请根据题目约束选择合适的算法。',
        timeLimit: 2000,
        memoryLimit: 256,
        languages: langs.map((language) => language.id)
      }
    ],
    files: [
      { name: 'contest-notes.txt', size: 1024, type: 'public' },
      { name: 'template.cpp', size: 2048, type: 'private' }
    ],
    user: { uid: 1, username: 'demo-user', displayName: '本地演示考生', school: '本地开发环境', studentId: 'DEMO-001' },
    submissions: [],
    session: { status: running ? 'IN_EXAM' : 'APPROVED', startedAt: running ? new Date().toISOString() : null, latestStartAt: endAt.toISOString(), canSubmit: true, canViewSubmissions: true, lockdown: false, lockdownReason: null }
  };
}

function formatDurationLabel(minutes: number) {
  const days = Math.floor(minutes / 1440);
  const hours = Math.floor((minutes % 1440) / 60);
  const rest = minutes % 60;
  return [days ? `${days} 天` : '', hours ? `${hours} 小时` : '', rest ? `${rest} 分钟` : ''].filter(Boolean).join(' ') || '0 分钟';
}

function formatCountdown(value: number) {
  const total = Math.max(0, Math.floor(value / 1000));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function formatFileSize(size?: number) {
  if (!size) return '';
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function formatDate(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map((part) => String(part).padStart(2, '0')).join('-');
  const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()].map((part) => String(part).padStart(2, '0')).join(':');
  return `${datePart} ${timePart}`;
}

function ruleName(rule: ContestRule, sourceRule?: string) {
  if (sourceRule === 'GPLT') return 'GPLT 赛制';
  if (sourceRule === 'LANQIAO') return 'LANQIAO 赛制';
  if (sourceRule === 'XCPC') return 'XCPC 赛制';
  if (rule === 'acm') return 'XCPC 赛制';
  if (rule === 'ks') return 'KS 赛制';
  if (rule === 'oi') return 'IO 赛制';
  if (rule === 'ioi') return 'IOI 赛制';
  return 'OI 赛制';
}

function sanitizeHydroHtml(content: string) {
  return sanitizeStatementHtml(content);
}

function parseHydroSamples(content: string) {
  const samples: Record<string, { input?: string; output?: string }> = {};
  const emitted = new Set<string>();
  const markdown = content.replace(/```(input|output)(\d*)\s*\n([\s\S]*?)```/gi, (_all, kind: string, index: string, value: string) => {
    const key = index || '1';
    samples[key] ||= {};
    samples[key][kind.toLowerCase() as 'input' | 'output'] = value.replace(/\r?\n$/, '');
    if (emitted.has(key)) return '';
    emitted.add(key);
    return `\n\n[[HYDRO_SAMPLE_${key}]]\n\n`;
  });
  return { markdown, samples };
}

function localizedProblemContent(content: string) {
  const source = content.trim();
  if (!source.startsWith('{') && !source.startsWith('[') && !source.startsWith('"')) return content;
  try {
    const parsed = JSON.parse(source) as unknown;
    if (typeof parsed === 'string') return parsed;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const translations = parsed as Record<string, unknown>;
      const preferred = ['zh-CN', 'zh_CN', 'zh', 'cn', 'default', 'en'];
      for (const key of preferred) if (typeof translations[key] === 'string') return translations[key] as string;
      const first = Object.values(translations).find((value): value is string => typeof value === 'string');
      if (first) return first;
    }
  } catch {
    // Ordinary problem statements may begin with JSON-like examples; keep them unchanged.
  }
  return content;
}

function parseObjectiveProblem(content: string) {
  content = localizedProblemContent(content).replace(/\\n/g, '\n');
  const blocks: Array<{ markdown: string } | { question: ObjectiveQuestion }> = [];
  const questions: ObjectiveQuestion[] = [];
  const pattern = /\{\{\s*(select|multiselect|input)\(([A-Za-z0-9_.-]+)\)\s*\}\}/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match.index > cursor) blocks.push({ markdown: content.slice(cursor, match.index) });
    const options: string[] = [];
    const remainder = content.slice(pattern.lastIndex);
    const htmlList = remainder.match(/^(\s*)<(ul|ol)\b[^>]*>([\s\S]*?)<\/\2>\s*/i);
    if (htmlList) {
      for (const item of htmlList[3].matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)) options.push(item[1].trim());
    }
    const lines = remainder.split(/\n/);
    let consumed = 0;
    if (htmlList && options.length) {
      consumed = htmlList[0].length;
    } else {
      for (const line of lines) {
        if (!line.trim()) { consumed += line.length + 1; continue; }
        const option = line.match(/^\s*[-*+]\s+(.*)$/);
        if (!option) break;
        options.push(option[1]);
        consumed += line.length + 1;
      }
    }
    const question: ObjectiveQuestion = { id: match[2], kind: match[1] as ObjectiveQuestion['kind'], options };
    questions.push(question);
    blocks.push({ question });
    cursor = pattern.lastIndex + consumed;
    pattern.lastIndex = cursor;
  }
  if (cursor < content.length) blocks.push({ markdown: content.slice(cursor) });
  return { blocks, questions };
}

function objectiveAnswerCode(answers: Record<string, ObjectiveAnswer>) {
  return Object.entries(answers).map(([id, answer]) => Array.isArray(answer)
    ? `${id}:\n${answer.map(item => `  - ${item}`).join('\n')}`
    : `${id}: ${answer}`).join('\n');
}

function parseObjectiveAnswerCode(code: string): Record<string, ObjectiveAnswer> {
  const answers: Record<string, ObjectiveAnswer> = {};
  let currentId = '';
  for (const line of code.replace(/\r\n?/g, '\n').split('\n')) {
    const heading = line.match(/^([A-Za-z0-9_.-]+):(?:[ \t]*(.*))?$/);
    if (heading) {
      currentId = heading[1];
      answers[currentId] = heading[2] ? heading[2] : [];
      continue;
    }
    if (!currentId) continue;
    const option = line.match(/^\s*-\s*(.*)$/);
    if (option) {
      const current = answers[currentId];
      answers[currentId] = Array.isArray(current) ? [...current, option[1]] : [option[1]];
      continue;
    }
    const current = answers[currentId];
    if (!Array.isArray(current)) answers[currentId] = `${current}\n${line}`;
  }
  return answers;
}

const problemImageUrls = new Map<string, string>();
const pendingProblemImages = new Map<string, Promise<string>>();

function cachedProblemImage(api: ClientApi, sessionId: string, problemId: string, fileName: string) {
  const key = `${api.base}\0${sessionId}\0${problemId}\0${fileName}`;
  const cached = problemImageUrls.get(key);
  if (cached) return Promise.resolve(cached);
  const pending = pendingProblemImages.get(key);
  if (pending) return pending;
  const request = api.download('/api/client/contest/file', { method: 'POST', body: JSON.stringify({ sessionId, type: 'public', name: fileName, problemId }) })
    .then(blob => {
      const objectUrl = URL.createObjectURL(blob);
      problemImageUrls.set(key, objectUrl);
      return objectUrl;
    })
    .finally(() => pendingProblemImages.delete(key));
  pendingProblemImages.set(key, request);
  return request;
}

function ProblemStatementImage({ src, alt, api, sessionId, problemId }: { src?: string | Blob; alt?: string; api: ClientApi; sessionId: string; problemId: string }) {
  const raw = typeof src === 'string' ? src : '';
  const direct = /^(https?:|data:|blob:)/i.test(raw);
  const [resolved, setResolved] = useState(direct ? raw : '');
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!raw) { setResolved(''); setFailed(true); return; }
    if (direct) { setResolved(raw); setFailed(false); return; }
    if (!sessionId || !problemId) { setResolved(''); setFailed(true); return; }
    let active = true;
    let fileName = raw.replace(/^file:\/\//i, '').split(/[?#]/)[0].split('/').pop() || '';
    try { fileName = decodeURIComponent(fileName); } catch { setFailed(true); return; }
    if (!fileName) { setFailed(true); return; }
    cachedProblemImage(api, sessionId, problemId, fileName)
      .then(objectUrl => { if (!active) return; setResolved(objectUrl); setFailed(false); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [api, direct, problemId, raw, sessionId]);
  if (failed) return <span className="problem-image-error">图片加载失败：{alt || raw}</span>;
  if (!resolved) return <span className="problem-image-loading"><LoaderCircle className="spin" size={16} />正在加载图片</span>;
  return <img className="problem-statement-image" src={resolved} alt={alt || '题目图片'} loading="lazy" />;
}

async function downloadStatementLink(api: ClientApi, sessionId: string, problemId: string, href: string) {
  const target = statementDownloadTarget(href);
  if (!target) throw new Error('题目下载链接无效');
  if (target.url) {
    // Remote references are opened by the desktop's isolated link handler.
    // Do not send arbitrary websites through the judge's file proxy.
    window.open(target.url, '_blank', 'noopener,noreferrer');
    return;
  }
  const blob = await api.download('/api/client/contest/file', {
    method: 'POST', body: JSON.stringify({ sessionId, problemId, type: 'public', ...target }),
  });
  saveDownloadBlob(blob, target.name);
}

function StatementLink({ href = '', children, api, sessionId, problemId }: { href?: string; children?: ReactNode; api: ClientApi; sessionId: string; problemId: string }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const target = statementDownloadTarget(href);
  if (!target || target.url) return <a href={href} target="_blank" rel="noreferrer noopener">{children}{target ? <Download size={12} /> : <ExternalLink size={12} />}</a>;
  return <><a href={href} aria-disabled={busy} onClick={event => {
    event.preventDefault(); event.stopPropagation();
    if (busy) return;
    setBusy(true); setError('');
    void downloadStatementLink(api, sessionId, problemId, href).catch(cause => setError(cause instanceof Error ? cause.message : '文件下载失败')).finally(() => setBusy(false));
  }}>{children}{busy ? <LoaderCircle className="spin" size={12} /> : <Download size={12} />}</a>{error ? <span role="alert">{error}</span> : null}</>;
}

const HydroMarkdownSegment = memo(function HydroMarkdownSegment({ content, api, sessionId, problemId }: { content: string; api: ClientApi; sessionId: string; problemId: string }) {
  const parsed = parseHydroSamples(content);
  return <>{parsed.markdown.split(/(\[\[HYDRO_SAMPLE_[^\]]+\]\])/g).map((chunk, index) => {
    const token = chunk.match(/^\[\[HYDRO_SAMPLE_(.+)\]\]$/);
    if (token) {
      const sample = parsed.samples[token[1]] || {};
      return <section className="candidate-hydro-sample" key={`sample-${token[1]}-${index}`}><strong>样例 {token[1]}</strong><div>{sample.input !== undefined ? <article><span>输入</span><CodePreview code={sample.input} language="text" copyable /></article> : null}{sample.output !== undefined ? <article><span>输出</span><CodePreview code={sample.output} language="text" copyable /></article> : null}</div></section>;
    }
    if (!chunk) return null;
    return <div className="statement-markdown candidate-hydro-markdown" key={`markdown-${index}`}><ReactMarkdown urlTransform={(url, key, node) => key === 'src' && node.tagName === 'img' || key === 'href' && statementDownloadTarget(url) ? url : defaultUrlTransform(url)} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]} components={{ a: ({ href, children }) => <StatementLink href={href} api={api} sessionId={sessionId} problemId={problemId}>{children}</StatementLink>, img: ({ src, alt }) => <ProblemStatementImage src={src} alt={alt} api={api} sessionId={sessionId} problemId={problemId} />, code: ({ className, children }: any) => { const source = String(children).replace(/\n$/, ''); const language = className?.match(/language-([\w.+-]+)/)?.[1] || 'text'; return className || String(children).includes('\n') ? <CodePreview code={source} language={language} copyable showLineNumbers /> : <code className="hydro-inline-code">{children}</code>; }, pre: ({ children }) => <>{children}</> }}>{chunk}</ReactMarkdown></div>;
  })}</>;
});

function htmlAttachmentName(source: string) {
  if (!source || /^(https?:|data:|blob:)/i.test(source)) return '';
  const name = source.replace(/^file:\/\//i, '').split(/[?#]/)[0].split('/').pop() || '';
  try { return decodeURIComponent(name); } catch { return ''; }
}

function HtmlStatementSegment({ content, api, sessionId, problemId }: { content: string; api: ClientApi; sessionId: string; problemId: string }) {
  const [downloadMessage, setDownloadMessage] = useState('');
  const assetKey = `${api.base}\0${sessionId}\0${problemId}\0${content}`;
  const [resolved, setResolved] = useState<{ key: string; images: Map<string, string> }>({ key: '', images: new Map() });
  const names = useMemo(() => {
    const attachments = new Set<string>();
    // The shared HTML parser extracts attributes; malformed markup never bypasses its allowlist.
    sanitizeStatementHtml(content, { rewriteImageUrl: source => { const name = htmlAttachmentName(source); if (name) attachments.add(name); return ''; } });
    return [...attachments];
  }, [content]);
  useEffect(() => {
    let active = true;
    if (!sessionId || !problemId || !names.length) return;
    void Promise.all(names.map(async name => {
      try { return [name, await cachedProblemImage(api, sessionId, problemId, name)] as const; }
      catch { return [name, ''] as const; }
    })).then(images => { if (active) setResolved({ key: assetKey, images: new Map(images) }); });
    return () => { active = false; };
  }, [api, assetKey, names, problemId, sessionId]);
  const html = sanitizeStatementHtml(content, { rewriteLinkUrl: href => statementDownloadTarget(href) ? `#statement-download=${encodeURIComponent(href)}` : href, rewriteImageUrl: source => {
    const name = htmlAttachmentName(source);
    return name ? resolved.key === assetKey ? resolved.images.get(name) || '' : '' : source;
  } });
  return <><div className="statement-html" dangerouslySetInnerHTML={{ __html: html }} onClick={event => {
    const anchor = event.target instanceof Element ? event.target.closest('a') : null;
    const href = anchor?.getAttribute('href') || '';
    if (!href.startsWith('#statement-download=')) return;
    event.preventDefault(); event.stopPropagation();
    setDownloadMessage('正在下载附件…');
    void downloadStatementLink(api, sessionId, problemId, decodeURIComponent(href.slice('#statement-download='.length)))
      .then(() => setDownloadMessage('已发起文件保存'))
      .catch(cause => setDownloadMessage(cause instanceof Error ? cause.message : '文件下载失败'));
  }} />{downloadMessage ? <p role="status">{downloadMessage}</p> : null}</>;
}

function ObjectiveControl({ question, answer, onChange, api, sessionId, problemId }: { question: ObjectiveQuestion; answer?: ObjectiveAnswer; onChange: (value: ObjectiveAnswer) => void; api: ClientApi; sessionId: string; problemId: string }) {
  return <section className="candidate-objective-question" id={`candidate-objective-${question.id}`}>
    {question.kind === 'input' ? <input value={typeof answer === 'string' ? answer : ''} onChange={event => onChange(event.target.value)} placeholder="请输入答案" /> : <div className="candidate-objective-options">{question.options.map((raw, index) => {
      const letter = String.fromCharCode(65 + index);
      const content = raw.replace(/^\s*(?:[（(]?[A-Za-z][.、)）．]\s*)/, '');
      const checked = Array.isArray(answer) ? answer.includes(letter) : answer === letter;
      return <label className={checked ? 'selected' : ''} key={`${question.id}-${letter}`}><input type={question.kind === 'multiselect' ? 'checkbox' : 'radio'} name={`candidate-objective-${question.id}`} checked={checked} onChange={() => { if (question.kind !== 'multiselect') onChange(letter); else { const current = Array.isArray(answer) ? answer : []; onChange(current.includes(letter) ? current.filter(item => item !== letter) : [...current, letter]); } }} /><span>{letter}</span>{/<[A-Za-z][\s\S]*>/.test(content) ? <HtmlStatementSegment content={content} api={api} sessionId={sessionId} problemId={problemId} /> : <HydroMarkdownSegment content={content} api={api} sessionId={sessionId} problemId={problemId} />}</label>;
    })}{!question.options.length ? <div className="candidate-objective-empty">未能读取本题选项，请刷新页面后重试。</div> : null}</div>}
  </section>;
}

function HydroProblemContent({ problem, answers, onAnswer, api, sessionId }: { problem: ContestProblem; answers: Record<string, ObjectiveAnswer>; onAnswer: (id: string, value: ObjectiveAnswer) => void; api: ClientApi; sessionId: string }) {
  const content = localizedProblemContent(problem.content);
  const problemId = problem.problemId || String(problem.pid);
  if (problem.problemType !== 'objective') return problem.html ? <HtmlStatementSegment content={content} api={api} sessionId={sessionId} problemId={problemId} /> : <HydroMarkdownSegment content={content} api={api} sessionId={sessionId} problemId={problemId} />;
  const objective = parseObjectiveProblem(content);
  return <>{objective.blocks.map((block, index) => 'markdown' in block
    ? <div key={`objective-markdown-${index}`}>{problem.html ? <HtmlStatementSegment content={block.markdown} api={api} sessionId={sessionId} problemId={problemId} /> : <HydroMarkdownSegment content={block.markdown} api={api} sessionId={sessionId} problemId={problemId} />}</div>
    : <ObjectiveControl key={`objective-question-${block.question.id}`} question={block.question} answer={answers[block.question.id]} onChange={value => onAnswer(block.question.id, value)} api={api} sessionId={sessionId} problemId={problemId} />)}</>;
}

function isPendingStatus(status: number) {
  return status === 0 || [20, 21, 22].includes(status);
}

function statusName(submission: Pick<Submission, 'status' | 'statusText'>) {
  const names: Record<number, string> = {
    0: 'Waiting', 1: 'Accepted', 2: 'Wrong Answer', 3: 'Time Limit Exceeded', 4: 'Memory Limit Exceeded', 5: 'Output Limit Exceeded',
    6: 'Runtime Error', 7: 'Compile Error', 8: 'System Error', 9: 'Canceled', 10: 'Unknown Error', 11: 'Hacked',
    20: 'Judging', 21: 'Compiling', 22: 'Fetched', 30: 'Ignored', 31: 'Format Error', 32: 'Hack Successful', 33: 'Hack Failed'
  };
  return names[submission.status] || submission.statusText || 'Unknown';
}

function testcaseStatus(status = 0) {
  if (status === 1) return { className: 'submission-accepted', text: 'Accepted' };
  if (isPendingStatus(status)) return { className: 'submission-pending', text: status === 21 ? 'Compiling' : status === 22 ? 'Fetched' : status === 20 ? 'Judging' : 'Waiting' };
  return { className: 'submission-failed', text: statusName({ status, statusText: '' }) };
}

function countedSubmission(problem: ContestProblem, submissions: Submission[], rule: ContestRule) {
  const rows = submissions.filter(submission => submission.canViewDetail !== false && submission.problemIndex === problem.index);
  if (!rows.length) return null;
  if (rule === 'ks') return [...rows].sort((a, b) => +new Date(b.createdAt) - +new Date(a.createdAt))[0];
  if (rule === 'ioi') return [...rows].sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || +new Date(b.createdAt) - +new Date(a.createdAt))[0];
  if (rule === 'acm') return rows.find(submission => submission.status === 1) || rows[0];
  return rows[0];
}

function problemNavigationState(problem: ContestProblem, submissions: Submission[], rule: ContestRule) {
  const submission = countedSubmission(problem, submissions, rule);
  if (!submission) return '';
  if (submission.resultHidden || rule === 'oi') return 'nav-submitted';
  if (rule === 'acm') return submission.status === 1 ? 'nav-passed' : 'nav-failed';
  const score = submission.score ?? 0;
  if (score >= problem.score || (submission.score === null && submission.status === 1)) return 'nav-passed';
  if (score > 0) return 'nav-partial';
  return 'nav-failed';
}

function SubmissionTable({ submissions, contest, problems, onOpen, fixedProblem = '' }: {
  submissions: Submission[]; contest: ContestData['contest']; problems: ContestProblem[];
  onOpen: (submission: Submission) => void; fixedProblem?: string;
}) {
  const [problemIndex, setProblemIndex] = useState(fixedProblem);
  const [status, setStatus] = useState('');
  const [keyword, setKeyword] = useState('');
  const xcpc = contest.rule === 'acm' || ['ACM', 'XCPC'].includes((contest.sourceRule || '').toUpperCase());
  const scoreColumn = !xcpc && (contest.sourceRule?.toUpperCase() === 'GPLT' || submissions.some(submission => submission.scoreVisible !== false && submission.score !== null));
  const testCaseColumn = Boolean(contest.showTestCaseCount) || submissions.some(submission => typeof submission.passedTestCases === 'number');
  const filtered = useMemo(() => submissions.filter(submission => {
    const visibleStatus = submission.resultHidden ? 'Submitted' : statusName(submission);
    const searchText = `${submission.id} ${submission.problemIndex} ${submission.problemTitle} ${submission.submittedBy?.displayName || ''} ${submission.submittedBy?.username || ''}`.toLowerCase();
    return (!problemIndex || submission.problemIndex === problemIndex)
      && (!status || visibleStatus === status)
      && (!keyword.trim() || searchText.includes(keyword.trim().toLowerCase()));
  }), [keyword, problemIndex, status, submissions]);
  const statuses = [...new Set(submissions.map(submission => submission.resultHidden ? 'Submitted' : statusName(submission)))];
  return <div className="candidate-submissions-panel">
    <div className="candidate-submission-filters">
      {!fixedProblem ? <select aria-label="按题目筛选" value={problemIndex} onChange={event => setProblemIndex(event.target.value)}><option value="">全部题目</option>{problems.map(problem => <option value={problem.index} key={problem.pid}>{problem.index}. {problem.title}</option>)}</select> : null}
      <select aria-label="按状态筛选" value={status} onChange={event => setStatus(event.target.value)}><option value="">全部状态</option>{statuses.map(item => <option value={item} key={item}>{item}</option>)}</select>
      <input aria-label="搜索提交记录" value={keyword} onChange={event => setKeyword(event.target.value)} placeholder="搜索 ID、题目、考生或队伍" />
      <span>{filtered.length} 条记录 · 实时更新</span>
    </div>
    <div className="candidate-submission-table-wrap"><table className="candidate-submission-table"><thead><tr><th>ID</th><th>Problem</th><th>Status</th>{scoreColumn ? <th>Score</th> : null}{testCaseColumn ? <th>Tests</th> : null}<th>User / Team</th><th>Time</th><th>Memory</th><th>Language</th><th>Date</th><th>Code</th></tr></thead><tbody>{filtered.map(submission => {
      const hidden = Boolean(submission.resultHidden);
      const pending = isPendingStatus(submission.status);
      const statusText = hidden ? 'Submitted' : statusName(submission);
      const problem = problems.find(item => item.index === submission.problemIndex);
      const languageName = submission.lang === '_'
        ? '提交答案'
        : contest.langs.find(language => language.id === submission.lang)?.name || submission.lang;
      const canOpen = submission.canViewDetail !== false;
      return <tr className={canOpen ? 'submission-row-clickable' : ''} key={submission.id} role={canOpen ? 'link' : undefined} tabIndex={canOpen ? 0 : undefined} aria-label={canOpen ? `查看提交 ${submission.id}` : undefined} onClick={canOpen ? () => onOpen(submission) : undefined} onKeyDown={canOpen ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onOpen(submission); } } : undefined}><td className="submission-id" title={submission.id}>{submission.id}</td><td><strong>{submission.problemIndex} - {submission.problemTitle}</strong></td><td><span className={`submission-status-tag ${hidden ? 'submitted' : pending ? 'pending' : submission.status === 1 ? 'accepted' : 'failed'}`}>{statusText}</span></td>{scoreColumn ? <td className="submission-score">{submission.scoreVisible === false || submission.score === null ? '—' : `${Number(submission.score.toFixed(2))} / ${problem?.score ?? '—'}`}</td> : null}{testCaseColumn ? <td>{typeof submission.passedTestCases === 'number' ? `${submission.passedTestCases} / ${submission.totalTestCases ?? 0}` : '—'}</td> : null}<td className="submission-owner"><strong>{submission.submittedBy?.displayName || submission.submittedBy?.username || '—'}</strong><small>{submission.submittedBy?.username || ''}</small></td><td>{hidden || pending ? '—' : `${submission.time || 0} ms`}</td><td>{hidden || pending ? '—' : `${submission.memory || 0} KB`}</td><td className="submission-language"><strong>{languageName}</strong><small>{submission.lang}</small></td><td>{formatDate(submission.createdAt)}</td><td>{canOpen ? <span className="submission-row-open-label">查看详情</span> : <span className="private-submission-label">仅本人</span>}</td></tr>;
    })}</tbody></table>{!filtered.length ? <div className="contest-empty">没有符合条件的提交记录</div> : null}</div>
  </div>;
}

function SubmissionDetail({ submission, contest, user, maximumScore, resultVisible, scoreVisible, onBack }: {
  submission: Submission;
  contest: ContestData['contest'];
  user: ContestData['user'];
  maximumScore: number | null;
  resultVisible: boolean;
  scoreVisible: boolean;
  onBack: () => void;
}) {
  const pending = resultVisible && isPendingStatus(submission.status);
  const tone = !resultVisible ? 'submitted' : pending ? 'pending' : submission.status === 1 ? 'accepted' : 'failed';
  const submitterName = submission.submittedBy?.displayName || submission.submittedBy?.username || user.displayName || user.username;
  const submitterUsername = submission.submittedBy?.username || user.username;
  const languageName = submission.lang === '_' ? '提交答案' : contest.langs.find(language => language.id === submission.lang)?.name || submission.lang;
  const ksVerdictOnly = contest.sourceRule?.toUpperCase() === 'KS' || contest.rule === 'ks';
  return <div className="contest-submission-page"><section className="contest-submission-modal" role="dialog" aria-modal="true">
    <div className="candidate-page-back-row"><button className="back-link" type="button" onClick={onBack}><ArrowLeft size={16} />返回上级</button></div>
    <header>
      <div><span className="contest-eyebrow"><FileCode2 size={14} />SUBMISSION DETAIL</span><h2>提交 #{submission.id}</h2><p>{submission.problemIndex} · {submission.problemTitle}</p></div>
    </header>
    <div className={`submission-result-inline ${tone}`}><strong>{resultVisible ? statusName(submission) : 'Submitted'}</strong>{scoreVisible && submission.score !== null && maximumScore !== null ? <em>得分 {Number(submission.score.toFixed(2))} / {maximumScore}</em> : null}{resultVisible && typeof submission.passedTestCases === 'number' ? <span>通过测试点 {submission.passedTestCases}/{submission.totalTestCases}</span> : null}</div>
    <div className="submission-detail-meta"><div><span>提交用户</span><strong>{submitterName}</strong><small>{submitterUsername}</small></div><div><span>提交语言</span><strong>{languageName}</strong><small>{submission.lang}</small></div><div><span>提交时间</span><strong>{formatDate(submission.createdAt)}</strong></div></div>
    {resultVisible && submission.testCases.length > 0 ? <div className="submission-detail-tests"><div className="section-heading"><div><span className="contest-eyebrow">TEST CASES</span><h3>测试点判题结果</h3></div><span>{submission.testCases.length} 个测试点</span></div><div className={`testcase-grid detail${ksVerdictOnly ? ' verdict-only' : ''}`}>{submission.testCases.map((testCase, index) => <div className="testcase" key={`${submission.id}-detail-${index}`}><span>测试点 {index + 1}</span><strong className={testcaseStatus(testCase.status).className}>{testcaseStatus(testCase.status).text}</strong>{!ksVerdictOnly ? <><em>{typeof testCase.time === 'number' ? `${testCase.time} ms` : '—'}{typeof testCase.memory === 'number' ? ` · ${Math.ceil(testCase.memory / 1024)} MB` : ''}</em>{testCase.message ? <small>{testCase.message}</small> : null}</> : null}</div>)}</div></div> : null}
    <div className="submission-source"><div className="section-heading"><div><span className="contest-eyebrow">SOURCE CODE</span><h3>{submission.lang === '_' ? '提交答案' : '提交代码'}</h3></div><span>{submission.code.length.toLocaleString()} 字符</span></div><CodePreview code={submission.detailsLoaded === false ? '正在加载提交详情…' : submission.code || '暂未返回代码内容'} language={submission.lang} toolbarLabel={submission.lang === '_' ? '提交答案' : 'Source Code'} languageLabel={languageName} showLineNumbers className="submission-detail-code" /></div>
  </section></div>;
}

type PrintJob = { id: string; title: string; content: string; status: 'SAVED' | 'PENDING' | 'PRINTED' | 'REJECTED'; rejectedReason?: string | null; candidateName?: string | null; examNumber: string; createdAt: string };
function PrintPage({ api, sessionId, mode }: { api: ClientApi; sessionId: string; mode: 'VIRTUAL' | 'PHYSICAL' }) {
  const [jobs, setJobs] = useState<PrintJob[]>([]); const [content, setContent] = useState(''); const [selected, setSelected] = useState<PrintJob | null>(null); const [creating, setCreating] = useState(false); const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const readVersion = useRef(0);
  const load = useCallback(async (signal?: AbortSignal) => {
    const version = ++readVersion.current;
    try {
      const next = await api.request<PrintJob[]>(`/api/client/print-jobs?sessionId=${encodeURIComponent(sessionId)}`, { signal });
      if (!signal?.aborted && version === readVersion.current) { setJobs(next); setError(''); }
    } catch (cause) {
      if (!signal?.aborted && version === readVersion.current) setError(cause instanceof Error ? cause.message : '打印记录加载失败，将稍后重试');
    }
  }, [api, sessionId]);
  useEffect(() => startSerialPolling(load, () => 3000), [load]);
  async function create() {
    if (!content.trim() || busy) return;
    setBusy(true); setError('');
    try {
      const job = await api.request<PrintJob>('/api/client/print-jobs', { method: 'POST', body: JSON.stringify({ sessionId, content }) });
      ++readVersion.current;
      setJobs(current => [job, ...current.filter(item => item.id !== job.id)]);
      setContent(''); setCreating(false); await load();
    } catch (cause) { setError(cause instanceof Error ? cause.message : '打印提交失败，请重试'); }
    finally { setBusy(false); }
  }
  const status = (job: PrintJob) => job.status === 'PENDING' ? '打印中' : job.status === 'PRINTED' ? '已打印' : job.status === 'REJECTED' ? `已驳回：${job.rejectedReason || ''}` : '已保存';
  const statusClass = (job: PrintJob) => job.status === 'PENDING' ? 'pending' : job.status === 'PRINTED' ? 'printed' : job.status === 'REJECTED' ? 'rejected' : 'saved';
  return <div className="exam-page-card print-page">
    <header className="exam-page-heading print-page-heading"><div><span>PRINT</span><h1>{mode === 'VIRTUAL' ? '虚拟打印' : '打印'}</h1></div><button className="contest-button print-create-button" type="button" onClick={() => setCreating(true)}><Printer size={17} />新建打印</button></header>
    {error ? <p role="status">{error}</p> : null}
    <div className="candidate-submission-table-wrap print-record-list"><table className="candidate-submission-table print-record-table"><thead><tr><th>打印名称</th><th>打印者</th><th>状态</th><th>提交时间</th><th aria-label="操作" /></tr></thead><tbody>{jobs.map(job => <tr className="submission-row-clickable" key={job.id} onClick={() => setSelected(job)}><td><span className="print-record-name"><i><FileText size={18} /></i><span><strong>{job.title}</strong><small>点击查看打印详情</small></span></span></td><td><span className="print-record-owner"><User size={15} />{job.candidateName || job.examNumber}</span></td><td><span className={`candidate-print-status ${statusClass(job)}`}>{status(job)}</span></td><td><time dateTime={job.createdAt}>{formatDate(job.createdAt)}</time></td><td><ChevronRight className="print-record-open" size={18} /></td></tr>)}</tbody></table>{!jobs.length ? <div className="print-record-empty"><Printer size={30} /><strong>暂无打印记录</strong><span>点击右上角“新建打印”提交打印内容</span></div> : null}</div>
    {creating ? <div className="contest-modal-backdrop" onMouseDown={event => { if (event.target === event.currentTarget && !busy) setCreating(false); }}><section className="contest-confirm-modal print-create-modal" role="dialog" aria-modal="true" aria-label="新建打印"><header><div><span className="contest-eyebrow">NEW PRINT</span><h2>新建打印</h2></div></header><div className="candidate-print-compose"><textarea autoFocus value={content} onChange={event => setContent(event.target.value)} placeholder="请粘贴或输入打印内容" rows={14} /></div><footer><button className="contest-button secondary" type="button" onClick={() => { setContent(''); setCreating(false); }} disabled={busy}>取消</button><button className="contest-button submit-code-button" type="button" onClick={() => void create()} disabled={!content.trim() || busy}>{busy ? '正在提交…' : mode === 'VIRTUAL' ? '保存打印内容' : '提交打印'}</button></footer></section></div> : null}
    {selected ? <div className="contest-modal-backdrop print-detail-backdrop"><section className="contest-confirm-modal print-detail-modal" role="dialog" aria-modal="true"><header><div><span className="contest-eyebrow">PRINT DETAIL</span><h2>{selected.title}</h2></div><button className="icon-button" type="button" aria-label="关闭打印详情" onClick={() => setSelected(null)}><X size={20} /></button></header><pre className="print-content-protected" onCopy={event => event.preventDefault()} onCut={event => event.preventDefault()} onContextMenu={event => event.preventDefault()}>{selected.content}</pre><footer><button className="contest-button secondary" onClick={() => setSelected(null)}>关闭</button></footer></section></div> : null}
  </div>;
}

export default function ContestApp({ configuredApiBase, allowMock }: { configuredApiBase: string; allowMock?: boolean }) {
  const [apiBase, setApiBase] = useState(() => defaultApiBase(configuredApiBase));
  const [sessionId, setSessionId] = useState('');
  const [sessionToken, setSessionToken] = useState('');
  const [mockMode, setMockMode] = useState(false);
  const [data, setData] = useState<ContestData | null>(null);
  const [page, setPage] = useState<ContestPage>('overview');
  const [activePid, setActivePid] = useState<number | null>(null);
  const [codeByPid, setCodeByPid] = useState<Record<string, string>>({});
  const [langByPid, setLangByPid] = useState<Record<string, string>>({});
  const [objectiveAnswers, setObjectiveAnswers] = useState<Record<string, Record<string, ObjectiveAnswer>>>({});
  const [submissions, setSubmissions] = useState<Submission[]>([]);
  const [leaderboard, setLeaderboard] = useState<LeaderboardData | null>(null);
  const [leaderboardOpen, setLeaderboardOpen] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmSubmission | null>(null);
  const [selectedSubmission, setSelectedSubmission] = useState<Submission | null>(null);
  const [routeSubmissionId, setRouteSubmissionId] = useState<string | null>(null);
  const [detailRetry, setDetailRetry] = useState(0);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [qaData, setQaData] = useState<ExamQAData>({ questions: [], announcements: [] });
  const [qaQuestion, setQaQuestion] = useState('');
  const [qaReplies, setQaReplies] = useState<Record<string, string>>({});
  const [qaProblemPid, setQaProblemPid] = useState('');
  const [qaSection, setQaSection] = useState<'announcements' | 'mine' | 'public'>('announcements');
  const [qaBusy, setQaBusy] = useState(false);
  const [announcementQueue, setAnnouncementQueue] = useState<CandidateNotification[]>([]);
  const acknowledgedNotifications = useRef(new Set<string>());
  const notificationAckPending = useRef(false);
  const [notificationAckBusy, setNotificationAckBusy] = useState(false);
  const [notificationAckError, setNotificationAckError] = useState('');
  const [now, setNow] = useState(() => Date.now());
  const [hydrated, setHydrated] = useState(false);
  const contestReadPending = useRef(false);
  const submissionsReadPending = useRef(false);
  const submissionsReadVersion = useRef(0);
  const qaReadPending = useRef(false);
  const leaderboardReadPending = useRef(false);
  const contestRevision = useRef<string | undefined>(undefined);
  const qaLastEventAt = useRef(0);
  const currentPage = useRef(page);
  currentPage.current = page;
  const latestSubmissions = useRef(submissions);
  latestSubmissions.current = submissions;

  const expireSession = useCallback(() => {
    for (const key of ['sessionId', 'sessionToken', 'sessionApiBase']) localStorage.removeItem(`proctor.contest.${key}`);
    setSessionId('');
    setSessionToken('');
    setData(null);
    setError('考试会话已失效，请返回监考客户端重新登录');
  }, []);

  const api = useMemo(() => new ClientApi(apiBase, sessionToken), [apiBase, sessionToken]);
  const enqueueNotifications = useCallback((items: CandidateNotification[]) => {
    setAnnouncementQueue(current => {
      const queued = new Set(current.map(notificationKey));
      return [...current, ...items.filter(item => {
        const key = notificationKey(item);
        if (queued.has(key) || acknowledgedNotifications.current.has(key)) return false;
        queued.add(key); return true;
      })];
    });
  }, []);
  const dismissNotification = useCallback((notification: CandidateNotification) => {
    const key = notificationKey(notification);
    acknowledgedNotifications.current.add(key);
    // Only recent local acknowledgments are needed to reject delayed reads.
    if (acknowledgedNotifications.current.size > 4096) acknowledgedNotifications.current.delete(acknowledgedNotifications.current.values().next().value!);
    setAnnouncementQueue(current => current.filter(item => notificationKey(item) !== key));
  }, []);
  const activeProblem = useMemo(() => data?.problems.find((problem) => problem.pid === activePid) || data?.problems[0] || null, [activePid, data?.problems]);
  const activeObjective = useMemo(() => activeProblem?.problemType === 'objective' ? parseObjectiveProblem(activeProblem.content) : { blocks: [], questions: [] }, [activeProblem]);
  const activeCode = activeProblem ? codeByPid[String(activeProblem.pid)] || '' : '';
  const activeObjectiveAnswers = activeProblem ? objectiveAnswers[String(activeProblem.pid)] || {} : {};
  const effectiveLanguages = useMemo(() => {
    if (!activeProblem) return data?.contest.langs || [];
    const allowed = new Set(activeProblem.languages);
    return data?.contest.langs.filter(lang => allowed.has(lang.id)) || [];
  }, [activeProblem, data?.contest.langs]);
  const savedLang = activeProblem ? langByPid[String(activeProblem.pid)] : '';
  const activeLang = effectiveLanguages.some(language => language.id === savedLang) ? savedLang : effectiveLanguages[0]?.id || '';

  const applyRoute = useCallback((route: ContestRoute) => {
    setPage(route.page);
    if (route.pid !== undefined) setActivePid(route.pid);
    setRouteSubmissionId(route.submissionId || null);
    if (!route.submissionId) setSelectedSubmission(null);
  }, []);

  const navigate = useCallback((route: ContestRoute, replace = false) => {
    const nextUrl = `${contestPath(route)}${window.location.search}`;
    window.history[replace ? 'replaceState' : 'pushState'](null, '', nextUrl);
    applyRoute(route);
  }, [applyRoute]);

  const goPreviousPage = useCallback(() => {
    navigate(contestRouteFromPathname(parentRoutePath(window.location.pathname)), true);
  }, [navigate]);

  const openSubmission = useCallback((submission: Submission, problemPid?: number) => {
    if (submission.canViewDetail === false) {
      setNotice('只能查看自己的提交详情与代码');
      window.setTimeout(() => setNotice(''), 3000);
      return;
    }
    setDetailRetry(current => current + 1);
    navigate(problemPid
      ? { page: 'problemSubmissions', pid: problemPid, submissionId: submission.id }
      : { page: 'submissions', submissionId: submission.id });
  }, [navigate]);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    const requestedMock = params.get('mock') === '1' && (allowMock || process.env.NODE_ENV !== 'production');
    const requestedRule = (['acm', 'oi', 'ioi'].includes(params.get('rule') || '') ? params.get('rule') : 'ioi') as ContestRule;
    const nextBase = params.get('apiBase');
    const nextSessionId = params.get('sessionId') || '';
    const nextToken = params.get('sessionToken') || hashParams.get('sessionToken') || '';
    try {
      const resolvedBase = trustedApiBase(configuredApiBase, nextBase || localStorage.getItem('proctor.contest.apiBase'));
      const restored = restoreBoundSession(localStorage, 'proctor.contest', resolvedBase);
      const issued = Boolean(nextSessionId && nextToken);
      const id = issued ? nextSessionId : restored.id;
      const token = issued ? nextToken : restored.token;
      setApiBase(resolvedBase);
      setSessionId(id);
      setSessionToken(token);
      localStorage.setItem('proctor.contest.apiBase', resolvedBase);
      if (id && token) {
        localStorage.setItem('proctor.contest.sessionId', id);
        localStorage.setItem('proctor.contest.sessionToken', token);
        localStorage.setItem('proctor.contest.sessionApiBase', resolvedBase);
      }
    } catch (cause) {
      expireSession();
      setError(cause instanceof Error ? cause.message : '服务器地址不属于当前监考平台');
    }
    if (nextToken) {
      params.delete('sessionToken');
      hashParams.delete('sessionToken');
      const query = params.toString(); const hash = hashParams.toString();
      window.history.replaceState(null, '', `${window.location.pathname}${query ? `?${query}` : ''}${hash ? `#${hash}` : ''}`);
    }
    if (requestedMock) {
      setMockMode(true);
      setSessionId('mock-session');
      setSessionToken('mock-token');
      const mock = createMockContestData(requestedRule, params.get('phase') === 'running');
      setData(mock);
      setSubmissions(mock.submissions);
      setError('');
    }
    const initialRoute = contestRouteFromPathname(window.location.pathname);
    applyRoute(initialRoute);
    if (window.location.pathname === '/contest' || window.location.pathname === '/contest/') {
      window.history.replaceState(null, '', `${contestPath(initialRoute)}${window.location.search}`);
    }
    setHydrated(true);
  }, [allowMock, applyRoute, configuredApiBase, expireSession]);

  useEffect(() => {
    const onPopState = () => applyRoute(contestRouteFromPathname(window.location.pathname));
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, [applyRoute]);

  const loadContest = useCallback(async () => {
    if (mockMode) return;
    if (!sessionId || !sessionToken || contestReadPending.current) return;
    contestReadPending.current = true;
    const submissionsVersion = ++submissionsReadVersion.current;
    try {
      const next = await api.request<ContestData>(`/api/client/contest?sessionId=${encodeURIComponent(sessionId)}&summaryOnly=true`);
      contestRevision.current = next.revision;
      setData(next);
      if (submissionsVersion === submissionsReadVersion.current) setSubmissions(next.submissions || []);
      setActivePid((current) => current && next.problems.some((problem) => problem.pid === current) ? current : next.problems[0]?.pid || null);
      setError('');
    } catch (cause) {
      if (isExpiredClientSessionError(cause)) return expireSession();
      setError(cause instanceof Error ? cause.message : '比赛数据加载失败');
    } finally { contestReadPending.current = false; }
  }, [api, expireSession, mockMode, sessionId, sessionToken]);

  const loadQA = useCallback(async () => {
    if (mockMode || !sessionId || !sessionToken || qaReadPending.current) return;
    qaReadPending.current = true;
    try {
      const next = await api.request<ExamQAData>(`/api/client/qa?sessionId=${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(15_000) });
      setQaData(next);
      const pending: CandidateNotification[] = [
        ...next.announcements.filter(item => !item.acknowledged).map(item => ({ ...item, kind: 'announcement' as const })),
        ...next.questions.filter(item => item.owned).flatMap(item => item.messages.filter(message => message.sender === 'ADMIN' && !message.acknowledgedAt && !message.id.startsWith('legacy-')).map(message => ({ id: message.id, kind: 'reply' as const, questionId: item.id, content: message.content, createdAt: message.createdAt })))
      ];
      enqueueNotifications(pending);
    } catch (cause) {
      if (isExpiredClientSessionError(cause)) return expireSession();
      setNotice(cause instanceof Error ? cause.message : '赛时答疑加载失败');
    } finally { qaReadPending.current = false; }
  }, [api, enqueueNotifications, expireSession, mockMode, sessionId, sessionToken]);

  const uploadQAImage = useCallback(async (file: File) => {
    if (!sessionId) throw new Error('缺少有效考试会话');
    const result = await api.upload<{ url: string }>('/api/client/qa/image', file, file.name || 'question-image.png', { sessionId });
    return absoluteMediaUrl(apiBase, result.url);
  }, [api, apiBase, sessionId]);

  useEffect(() => {
    if (mockMode || !hydrated || !sessionId || !sessionToken) return;
    let initialized = false;
    return startSerialPolling(async () => {
      if (!initialized) {
        await loadContest();
        initialized = Boolean(contestRevision.current);
        return;
      }
      try {
        const state = await api.request<{ session: ContestData['session']; revision: string; requiresFullRefresh?: boolean }>(`/api/client/contest/state?sessionId=${encodeURIComponent(sessionId)}`, { signal: AbortSignal.timeout(15_000) });
        if (state.requiresFullRefresh) { await loadContest(); return; }
        setData(current => current ? { ...current, session: state.session } : current);
        if (state.revision !== contestRevision.current) await loadContest();
      } catch (cause) {
        if (isExpiredClientSessionError(cause)) expireSession();
      }
    }, () => 5000);
  }, [api, expireSession, hydrated, loadContest, mockMode, sessionId, sessionToken]);

  useEffect(() => {
    if (mockMode || !hydrated || !sessionId || !sessionToken) return;
    return startSerialPolling(loadQA, () => Date.now() - qaLastEventAt.current < 15_000 ? 30_000 : 5000);
  }, [hydrated, loadQA, mockMode, sessionId, sessionToken]);

  useEffect(() => {
    if (mockMode || !hydrated || !sessionId || !sessionToken) return;
    const controller = new AbortController();
    let reconnectTimer = 0;
    let since = new Date().toISOString();
    let reconnectDelay = 1000;
    const connect = async () => {
      try {
        const response = await fetch(`${apiBase}/api/client/qa/events?sessionId=${encodeURIComponent(sessionId)}&since=${encodeURIComponent(since)}`, {
          headers: { authorization: `Bearer ${sessionToken}`, 'x-proctor-session-token': sessionToken, 'x-proctor-client': 'browser' },
          signal: controller.signal,
          redirect: 'error',
        });
        if ([401, 410].includes(response.status)) { expireSession(); return; }
        if (!response.ok || !response.body) throw new Error(`公告推送连接失败（${response.status}）`);
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        while (!controller.signal.aborted) {
          const { value, done } = await reader.read();
          if (done) break;
          qaLastEventAt.current = Date.now();
          reconnectDelay = 1000;
          buffer += decoder.decode(value, { stream: true });
          const blocks = buffer.split(/\r?\n\r?\n/);
          buffer = blocks.pop() || '';
          for (const block of blocks) {
            let eventName = 'message';
            const dataLines: string[] = [];
            for (const line of block.split(/\r?\n/)) {
              if (line.startsWith('event:')) eventName = line.slice(6).trim();
              if (line.startsWith('data:')) dataLines.push(line.slice(5).trimStart());
            }
            if (!dataLines.length) continue;
            if (eventName === 'announcement') {
              const announcement = JSON.parse(dataLines.join('\n')) as CandidateNotification;
              since = new Date(new Date(announcement.createdAt).getTime() - 1).toISOString();
              setQaData(current => ({ ...current, announcements: [{ id: announcement.id, candidateId: announcement.candidateId || null, content: announcement.content, createdAt: announcement.createdAt, acknowledged: false }, ...current.announcements.filter(item => item.id !== announcement.id)] }));
              enqueueNotifications([{ ...announcement, kind: 'announcement' }]);
            } else if (eventName === 'reply') {
              const reply = JSON.parse(dataLines.join('\n')) as CandidateNotification;
              since = new Date(new Date(reply.createdAt).getTime() - 1).toISOString();
              enqueueNotifications([{ ...reply, kind: 'reply' }]);
              void loadQA();
            } else if (eventName === 'refresh') {
              void loadQA();
            }
          }
        }
      } catch {
        // The long-lived request reconnects below. Regular QA polling remains as a fallback.
      }
      qaLastEventAt.current = 0;
      if (!controller.signal.aborted) {
        reconnectTimer = window.setTimeout(() => void connect(), reconnectDelay + Math.random() * 500);
        reconnectDelay = Math.min(30_000, reconnectDelay * 2);
      }
    };
    void connect();
    return () => { controller.abort(); qaLastEventAt.current = 0; window.clearTimeout(reconnectTimer); };
  }, [apiBase, enqueueNotifications, expireSession, hydrated, loadQA, mockMode, sessionId, sessionToken]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(api.now()), 1000);
    return () => window.clearInterval(timer);
  }, [api]);

  useEffect(() => {
    if (!activeProblem || !sessionId) return;
    const saved = localStorage.getItem(`proctor.contest.code.${sessionId}.${activeProblem.pid}`);
    if (saved !== null) setCodeByPid((current) => ({ ...current, [String(activeProblem.pid)]: saved }));
    if (activeProblem.problemType === 'objective') {
      try {
        const savedAnswers = localStorage.getItem(`proctor.contest.objective.${sessionId}.${activeProblem.pid}`);
        const localAnswers = savedAnswers ? JSON.parse(savedAnswers) as Record<string, ObjectiveAnswer> : null;
        if (localAnswers && Object.keys(localAnswers).length) {
          setObjectiveAnswers((current) => ({ ...current, [String(activeProblem.pid)]: localAnswers }));
        } else {
          const latestSubmission = submissions
            .filter((submission) => submission.problemIndex === activeProblem.index && submission.lang === '_' && (submission.isOwn === true || (submission.isOwn === undefined && submission.submittedBy?.username === data?.user.username)) && submission.canViewDetail !== false && submission.code.trim())
            .sort((left, right) => +new Date(right.createdAt) - +new Date(left.createdAt))[0];
          if (latestSubmission) {
            const previousAnswers = parseObjectiveAnswerCode(latestSubmission.code);
            if (Object.keys(previousAnswers).length) {
              setObjectiveAnswers((current) => ({ ...current, [String(activeProblem.pid)]: previousAnswers }));
              localStorage.setItem(`proctor.contest.objective.${sessionId}.${activeProblem.pid}`, JSON.stringify(previousAnswers));
            }
          }
        }
      } catch {
        localStorage.removeItem(`proctor.contest.objective.${sessionId}.${activeProblem.pid}`);
      }
    }
    if (!langByPid[String(activeProblem.pid)]) {
      setLangByPid((current) => ({ ...current, [String(activeProblem.pid)]: activeProblem.languages[0] || data?.contest.langs[0]?.id || 'cpp' }));
    }
  }, [activeProblem, data?.contest.langs, data?.user.username, langByPid, sessionId, submissions]);

  const examStarted = Boolean(data && (data.session.status === 'IN_EXAM' || data.session.status === 'LOCKED' || data.session.status === 'FINISHED' || data.session.startedAt));
  const effectiveEndAt = data ? new Date(data.session.effectiveEndAt || data.contest.endAt).getTime() : 0;
  const examEnded = Boolean(data && (data.session.status === 'FINISHED' || now >= effectiveEndAt));
  const canSubmit = data?.session.status === 'IN_EXAM' && data.session.canSubmit !== false && !examEnded && !data?.session.lockdown;

  useEffect(() => {
    if (!examEnded) return;
    setLeaderboard(null);
    setLeaderboardOpen(false);
    setSelectedSubmission(null);
    setConfirm(null);
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, [examEnded]);

  useEffect(() => {
    if (data && !examStarted && page !== 'overview') navigate({ page: 'overview' }, true);
  }, [data, examStarted, navigate, page]);

  const readSubmissionDetail = useCallback(async (id: string, signal: AbortSignal) => {
    for (let attempt = 0; ; attempt++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      try {
        return await readWithDeadline(requestSignal => api.request<Submission>('/api/client/contest/submissions', {
          method: 'POST', body: JSON.stringify({ sessionId, submissionId: id }), signal: requestSignal,
        }), signal);
      } catch (cause) {
        if (signal.aborted || attempt >= 2 || (cause instanceof ClientApiError && cause.status >= 400 && cause.status < 500 && cause.status !== 429)) throw cause;
        await new Promise(resolve => window.setTimeout(resolve, 1000 * (attempt + 1)));
      }
    }
  }, [api, sessionId]);
  const detailSummary = submissions.find(item => item.id === routeSubmissionId);
  // A stable version avoids downloading source/test cases again on unchanged list polls.
  const detailVersion = detailSummary ? JSON.stringify([data?.revision, detailSummary.totalTestCases, detailSummary.passedTestCases, detailSummary.id, detailSummary.updatedAt, detailSummary.status, detailSummary.score, detailSummary.resultHidden, detailSummary.scoreVisible, detailSummary.canViewDetail, detailSummary.detailsLoaded]) : '';
  useEffect(() => {
    if (!detailSummary || detailSummary.canViewDetail === false || examEnded) { setSelectedSubmission(null); return; }
    if (detailSummary.detailsLoaded !== false) { setSelectedSubmission(detailSummary); return; }
    const controller = new AbortController();
    setSelectedSubmission(detailSummary);
    void readSubmissionDetail(detailSummary.id, controller.signal).then(detail => { if (!controller.signal.aborted) setSelectedSubmission(detail); }).catch(cause => {
      if (controller.signal.aborted) return;
      setSelectedSubmission(null);
      if (isExpiredClientSessionError(cause)) expireSession();
      else setNotice(cause instanceof Error ? cause.message : '提交详情加载失败，请点击记录重试');
    });
    return () => controller.abort();
    // detailVersion contains the permission, visibility and judge update fields.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detailRetry, detailVersion, examEnded, expireSession, readSubmissionDetail, routeSubmissionId]);

  const objectiveRestore = activeProblem?.problemType === 'objective'
    ? submissions.find(item => item.problemIndex === activeProblem.index && item.lang === '_' && item.isOwn === true)
    : undefined;
  useEffect(() => {
    if (!activeProblem || !objectiveRestore || objectiveRestore.detailsLoaded !== false) return;
    const key = `proctor.contest.objective.${sessionId}.${activeProblem.pid}`;
    if (localStorage.getItem(key)) return;
    const controller = new AbortController();
    void readSubmissionDetail(objectiveRestore.id, controller.signal).then(detail => {
      // Never overwrite answers entered while the recovery request was in flight.
      if (controller.signal.aborted || localStorage.getItem(key) || detail.isOwn !== true) return;
      const answers = parseObjectiveAnswerCode(detail.code);
      if (Object.keys(answers).length) {
        localStorage.setItem(key, JSON.stringify(answers));
        setObjectiveAnswers(current => ({ ...current, [String(activeProblem.pid)]: answers }));
      }
    }).catch(cause => {
      if (!controller.signal.aborted) setNotice(cause instanceof Error ? `上次答案恢复失败：${cause.message}，可重新进入题目重试` : '上次答案恢复失败，可重新进入题目重试');
    });
    return () => controller.abort();
  }, [activeProblem?.pid, readSubmissionDetail, objectiveRestore?.id, sessionId]);

  async function startContest() {
    if (!data || busy === 'start') return;
    if (!window.confirm('确认开始考试？开始后将正式计时，且不能重新选择开始时间。')) return;
    setBusy('start');
    try {
      if (mockMode) {
        setData(current => current ? { ...current, session: { ...current.session, status: 'IN_EXAM', startedAt: new Date().toISOString() } } : current);
      } else {
        const session = await api.request<ContestData['session']>('/api/client/session/start', {
          method: 'POST', body: JSON.stringify({ sessionId, confirm: true })
        });
        setData(current => current ? { ...current, session } : current);
        await loadContest();
      }
      setNotice('考试已开始');
      window.setTimeout(() => setNotice(''), 3000);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '开始考试失败');
    } finally {
      setBusy('');
    }
  }

  function updateCode(value: string) {
    if (!activeProblem) return;
    setCodeByPid((current) => ({ ...current, [String(activeProblem.pid)]: value }));
    localStorage.setItem(`proctor.contest.code.${sessionId}.${activeProblem.pid}`, value);
  }

  function updateObjectiveAnswer(id: string, value: ObjectiveAnswer) {
    if (!activeProblem) return;
    const pid = String(activeProblem.pid);
    setObjectiveAnswers((current) => {
      const nextAnswers = { ...(current[pid] || {}), [id]: value };
      localStorage.setItem(`proctor.contest.objective.${sessionId}.${pid}`, JSON.stringify(nextAnswers));
      return { ...current, [pid]: nextAnswers };
    });
  }

  const leaderboardTimePoint = useRef<number | null>(null);
  async function refreshLeaderboard(silent = false, timePoint?: number | null) {
    if (timePoint !== undefined) leaderboardTimePoint.current = timePoint;
    const selected = leaderboardTimePoint.current;
    if (!sessionId || examEnded) {
      setLeaderboard(null);
      return;
    }
    if (leaderboardReadPending.current) return;
    leaderboardReadPending.current = true;
    if (!silent) setBusy('leaderboard');
    try {
      if (mockMode) {
        setLeaderboard({
          available: true,
          rows: [
            { rank: 1, username: 'sample-user', displayName: '示例选手', score: 70, solved: 1, penalty: 1200, problemScores: [40, 30] },
            { rank: 2, username: 'demo-user', displayName: '本地演示考生', score: submissions.length ? 40 : 0, solved: submissions.length ? 1 : 0, penalty: 1800, problemScores: [submissions.length ? 40 : null, null] }
          ]
        });
        return;
      }
      const result = await api.request<LeaderboardData>('/api/client/contest/leaderboard', {
        method: 'POST',
        body: JSON.stringify({ sessionId, timePoint: selected ?? undefined }), signal: AbortSignal.timeout(15_000)
      });
      if (selected === leaderboardTimePoint.current) setLeaderboard(result);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '排行榜加载失败');
    } finally {
      leaderboardReadPending.current = false;
      if (!silent) setBusy('');
    }
  }

  useEffect(() => {
    if (page !== 'leaderboard' || !sessionId || examEnded) return;
    return startSerialPolling(() => refreshLeaderboard(true), () => document.visibilityState === 'visible' ? 3000 : 15_000);
    // Refresh continuously while the live board is visible.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examEnded, page, sessionId]);

  async function refreshSubmissions(manual = false) {
    if (!sessionId) return;
    if (mockMode || submissionsReadPending.current) return;
    submissionsReadPending.current = true;
    const version = ++submissionsReadVersion.current;
    if (manual) setBusy('submissions');
    try {
      const result = await api.request<Submission[]>('/api/client/contest/submissions', {
        method: 'POST',
        body: JSON.stringify({ sessionId, summaryOnly: true }), signal: AbortSignal.timeout(15_000)
      });
      if (version === submissionsReadVersion.current) setSubmissions(result);
    } catch (cause) {
      if (isExpiredClientSessionError(cause)) expireSession();
      // 主页面轮询失败时保留最近一次结果，下一次轮询再恢复。
    } finally {
      submissionsReadPending.current = false;
      if (manual) setBusy('');
    }
  }

  const hasPendingSubmissions = submissions.some(item => !item.resultHidden && isPendingStatus(item.status));
  useEffect(() => {
    if (mockMode || !examStarted || examEnded || !sessionId || !sessionToken) return;
    return startSerialPolling(() => refreshSubmissions(), () => submissionPollDelay(
      document.visibilityState === 'visible',
      ['submissions', 'problemSubmissions'].includes(currentPage.current),
      latestSubmissions.current.some(item => !item.resultHidden && isPendingStatus(item.status)),
    ));
    // Pending judgments remain responsive; settled/offscreen lists poll less often.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examEnded, examStarted, hasPendingSubmissions, mockMode, sessionId, sessionToken]);

  async function submitCode() {
    if (!confirm || !sessionId) return;
    setBusy('submit');
    try {
      if (mockMode) {
        const createdAt = new Date().toISOString();
        const mockSubmission: Submission = {
          id: `MOCK-${Date.now().toString(36).toUpperCase()}`,
          problemIndex: confirm.problem.index,
          problemTitle: confirm.problem.title,
          status: 1,
          statusText: 'Accepted',
          score: confirm.problem.score,
          time: 23,
          memory: 4096,
          lang: confirm.lang,
          code: confirm.code,
          submittedBy: data?.user,
          testCases: [
            { id: 1, status: 1, score: Math.round(confirm.problem.score / 2), time: 11, memory: 2048 },
            { id: 2, status: 1, score: confirm.problem.score - Math.round(confirm.problem.score / 2), time: 12, memory: 4096 }
          ],
          createdAt
        };
        setSubmissions((current) => [mockSubmission, ...current]);
        setConfirm(null);
        setSelectedSubmission(mockSubmission);
        navigate({ page: 'problemSubmissions', pid: confirm.problem.pid, submissionId: mockSubmission.id });
        setNotice(`本地 Mock 提交成功，提交 ID：${mockSubmission.id}`);
        window.setTimeout(() => setNotice(''), 5000);
        return;
      }
      const result = await api.request<Submission & { submissionId: string }>('/api/client/contest/submit', {
        method: 'POST',
        body: JSON.stringify({ sessionId, pid: confirm.problem.pid, lang: confirm.lang, code: confirm.code })
      });
      const submission = { ...result, id: result.submissionId, code: confirm.code };
      ++submissionsReadVersion.current;
      setSubmissions((current) => [submission, ...current.filter((item) => item.id !== submission.id)]);
      setConfirm(null);
      setSelectedSubmission(submission);
      navigate({ page: 'problemSubmissions', pid: confirm.problem.pid, submissionId: submission.id });
      setNotice(`提交成功，提交 ID：${result.submissionId}`);
      window.setTimeout(() => setNotice(''), 5000);
      void refreshSubmissions();
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '提交失败');
    } finally {
      setBusy('');
    }
  }

  async function submitQuestion(questionId?: string) {
    const content = (questionId ? qaReplies[questionId] : qaQuestion).trim();
    if (!content || !sessionId || mockMode) return;
    setQaBusy(true);
    try {
      const problem = data?.problems.find(item => String(item.pid) === qaProblemPid);
      await api.request('/api/client/qa', {
        method: 'POST',
        body: JSON.stringify({
          action: 'message',
          sessionId,
          questionId,
          content,
          problem: problem ? { pid: problem.pid, index: problem.index, title: problem.title } : null
        })
      });
      if (questionId) setQaReplies(current => ({ ...current, [questionId]: '' })); else setQaQuestion('');
      await loadQA();
      setNotice('问题已发送给监考老师');
      window.setTimeout(() => setNotice(''), 4000);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '提问发送失败');
    } finally { setQaBusy(false); }
  }

  async function acknowledgeNotification(notification: CandidateNotification) {
    if (notificationAckPending.current) return;
    notificationAckPending.current = true; setNotificationAckBusy(true); setNotificationAckError('');
    try {
      await api.request('/api/client/qa', { method: 'POST', body: JSON.stringify(notification.kind === 'reply' ? { action: 'ack-reply', sessionId, messageId: notification.id } : { action: 'ack-announcement', sessionId, announcementId: notification.id }) });
      dismissNotification(notification);
      void loadQA();
    } catch (cause) {
      if (isExpiredClientSessionError(cause)) expireSession();
      else if (cause instanceof ClientApiError && cause.status === 404 && ['公告不存在', '回复不存在'].includes(cause.message)) {
        // A removed record has nothing left to acknowledge. Do not trap the
        // page behind a notification that can never receive a receipt.
        dismissNotification(notification); void loadQA();
      } else setNotificationAckError(cause instanceof Error ? cause.message : '确认失败，请恢复网络后重试');
    } finally { notificationAckPending.current = false; setNotificationAckBusy(false); }
  }

  async function downloadFile(file: ContestFile) {
    if (!sessionId) return;
    setBusy(`file:${file.name}`);
    try {
      if (mockMode) {
        const mockContent = file.name.endsWith('.cpp') ? '#include <bits/stdc++.h>\nusing namespace std;\n\nint main() {\n    return 0;\n}\n' : `预览参考文件\n文件名：${file.name}\n`;
        const blob = new Blob([mockContent], { type: 'text/plain;charset=utf-8' });
        saveDownloadBlob(blob, file.name);
        return;
      }
      const blob = await api.download('/api/client/contest/file', {
        method: 'POST',
        body: JSON.stringify({ sessionId, type: file.type, name: file.name, problemId: file.problemId })
      });
      saveDownloadBlob(blob, file.name);
    } catch (cause) {
      setNotice(cause instanceof Error ? cause.message : '文件下载失败');
    } finally {
      setBusy('');
    }
  }

  if (!hydrated) return <main className="contest-loading"><LoaderCircle className="spin" />正在打开比赛页面</main>;
  if (!mockMode && (!sessionId || !sessionToken)) return <main className="contest-loading"><AlertTriangle />{error || '缺少有效考试会话，请返回监考客户端重新登录。'}</main>;
  if (!data) {
    return <main className="contest-loading"><LoaderCircle className="spin" /><span>{error || '正在加载数据…'}</span>{error ? <button className="contest-button secondary" onClick={() => void loadContest()}><RefreshCw size={16} />重试</button> : null}</main>;
  }

  const beginAt = new Date(data.contest.beginAt).getTime();
  const latestStartAt = new Date(data.contest.latestStartAt || data.session.latestStartAt || data.contest.beginAt).getTime();
  const canStart = data.session.status === 'APPROVED' && now >= beginAt && now <= latestStartAt;
  const examDurationMinutes = data.contest.durationMinutes || Math.max(0, Math.round((+new Date(data.contest.endAt) - beginAt) / 60000));
  const teamMode = data.contest.contestType === 'TEAM';
  const teamMembers = data.user.teamMembers?.length ? data.user.teamMembers : [data.user.name || data.user.displayName || data.user.username].filter(Boolean) as string[];
  const examFiles = data.files.filter((file) => !file.problemId);
  const activeSubmissions = submissions.filter((submission) => activeProblem && submission.problemIndex === activeProblem.index);
  const examStatus = examEnded || data.session.status === 'FINISHED' ? '已结束' : examStarted ? '进行中' : now < beginAt ? '未开始' : now > latestStartAt ? '已错过开考时间' : '等待确认开始';
  const submissionDisabledReason = data.session.canSubmit === false ? '本场团队赛仅允许队长提交' : examEnded ? '考试已结束' : data.session.lockdown ? '会话已锁定' : '等待确认开始';
  const showProblemScore = ['oi', 'ioi'].includes(data.contest.rule);
  const selectedResultVisible = Boolean(selectedSubmission) && data.contest.rule !== 'oi' && !selectedSubmission?.resultHidden;
  const selectedScoreVisible = selectedResultVisible && data.contest.rule !== 'acm' && selectedSubmission?.scoreVisible !== false;
  const activeObjectiveCode = activeProblem?.problemType === 'objective' ? objectiveAnswerCode(activeObjectiveAnswers) : '';
  const activeObjectiveAnsweredCount = activeObjective.questions.filter((question) => {
    const answer = activeObjectiveAnswers[question.id];
    return Array.isArray(answer) ? answer.length > 0 : Boolean(answer?.trim());
  }).length;
  const contestHeading = <header className="nova-contest-heading">
    <div className="nova-contest-heading-top">
      <div><h1>{data.contest.title}</h1><div className="nova-contest-heading-meta"><span>规则：<b>{ruleName(data.contest.rule, data.contest.sourceRule)}</b></span><span>状态：<b className="nova-running-status">{examStatus}</b></span></div></div>
      <div className="nova-contest-deadline"><span>结束时间</span><time>{formatDate(new Date(effectiveEndAt).toISOString())}</time></div>
    </div>
    <div className="nova-contest-timer"><span><Clock3 size={15} />剩余时间</span><strong>{formatCountdown(effectiveEndAt - now)}</strong></div>
    <progress className="nova-contest-progress" aria-label="考试进度" max={100} value={Math.max(0, Math.min(100, (now - new Date(data.session.startedAt || data.contest.beginAt).getTime()) / Math.max(1, effectiveEndAt - new Date(data.session.startedAt || data.contest.beginAt).getTime()) * 100))} />
  </header>;

  if (examEnded) return <main className="contest-ended-page"><section><Check size={42} /><h1>考试已结束</h1><p>本场考试已经结束，排行榜最终结果不对考生展示。</p></section></main>;

  return (
    <main className="contest-app exam-portal">
      <header className="exam-portal-sidebar">
        <div className="exam-portal-brand"><img src="/candidate-assets/brand/logo.png" alt="程序设计算法协会 Logo" /><div><strong>程序设计算法协会</strong><span>在线考试</span></div></div>
        <nav aria-label="考试导航">
          <button className={page === 'overview' ? 'active' : ''} onClick={() => navigate({ page: 'overview' })}><LayoutDashboard size={18} />概览</button>
          <button className={['problems', 'problem', 'problemSubmissions', 'submit'].includes(page) ? 'active' : ''} disabled={!examStarted} onClick={() => navigate({ page: 'problems' })}><ListChecks size={18} />题目列表</button>
          <button className={page === 'submissions' ? 'active' : ''} disabled={!examStarted} onClick={() => { navigate({ page: 'submissions' }); void refreshSubmissions(); }}><History size={18} />提交记录</button>
          {data.contest.rule !== 'ks' ? <button className={page === 'leaderboard' ? 'active' : ''} disabled={!examStarted} onClick={() => { navigate({ page: 'leaderboard' }); void refreshLeaderboard(); }}><Trophy size={18} />排行榜</button> : null}
          <button className={page === 'qa' ? 'active' : ''} disabled={!examStarted} onClick={() => navigate({ page: 'qa' })}><MessageCircleQuestion size={18} />答疑公告</button>
          {data.contest.allowPrint ? <button className={page === 'print' ? 'active' : ''} disabled={!examStarted} onClick={() => navigate({ page: 'print' })}><Printer size={18} />打印</button> : null}
        </nav>
        <div className="exam-portal-sidebar-foot">
          <div><User size={17} /><span>{data.user.displayName || data.user.username}<small>{data.user.username}</small></span></div>
        </div>
      </header>

      {data.session.lockdown ? <div className="contest-lock-banner"><AlertTriangle size={18} />{data.session.lockdownReason || '当前会话已锁定，请等待监考老师处理。'}</div> : null}
      {notice ? <div className="contest-toast" role="status"><Check size={16} />{notice}</div> : null}
      {error ? <div className="contest-inline-error"><AlertTriangle size={16} />{error}</div> : null}

      <section className="exam-portal-main">
        {page !== 'overview' ? contestHeading : null}
        {['problem', 'submit', 'problemSubmissions'].includes(page) ? <div className="candidate-page-back-row"><button className="back-link" type="button" onClick={goPreviousPage}><ArrowLeft size={16} />返回上级</button></div> : null}
        {page === 'overview' ? <div className="candidate-contest-overview">
          <div className="candidate-overview-main">
            <section className="candidate-overview-hero">
              <div className="candidate-overview-title">
                <h1>{data.contest.title}</h1>
              </div>
              <div className="candidate-overview-meta">
                <span className={`candidate-overview-status ${examStarted && !examEnded ? 'running' : ''}`}>{examStatus}</span>
                <span className="candidate-overview-rule"><Trophy size={17} />{ruleName(data.contest.rule, data.contest.sourceRule)}</span>
                <span><CalendarClock size={17} />开始于 {formatDate(data.contest.beginAt)}</span>
                {data.contest.flexible ? <span><CalendarClock size={17} />最晚开始 {formatDate(data.contest.latestStartAt || data.contest.beginAt)}</span> : null}
                <span><Clock3 size={17} />{formatDurationLabel(examDurationMinutes)}</span>
                <span><Users size={17} />{data.contest.candidateCount ?? '-'} 人</span>
              </div>
            </section>
            <section className="candidate-overview-description-card">
              <header><FileText size={20} /><h2>考试说明</h2></header>
              <div className="candidate-overview-description-body"><MarkdownContent className="statement-markdown" content={data.contest.content || '暂无考试说明。'} /></div>
              {examFiles.length ? <div className="candidate-overview-files"><h3><FileText size={18} />考试文件</h3><div>{examFiles.map(file => <button key={`${file.type}-${file.name}`} onClick={() => void downloadFile(file)} disabled={busy === `file:${file.name}`}><FileText size={16} /><span>{file.name}<small>{formatFileSize(file.size)}</small></span><Download size={15} /></button>)}</div></div> : null}
            </section>
          </div>
          <aside className="candidate-overview-sidebar">
            <section className="candidate-summary-card">
              <header><User size={20} /><div><span>{teamMode ? '团队信息' : '考生信息'}</span><strong>{teamMode ? data.user.teamName || '-' : data.user.name || data.user.displayName || '-'}</strong></div></header>
              <dl>
                <div><dt>考号</dt><dd>{data.user.examNumber || data.user.username || '-'}</dd></div>
                {teamMode ? <>
                  <div><dt>队伍名称</dt><dd>{data.user.teamName || '-'}</dd></div>
                  <div className="candidate-team-members"><dt>队伍成员</dt><dd>{teamMembers.map((member, index) => <span key={`${member}-${index}`}>{member}{index === 0 ? '（队长）' : ''}</span>)}</dd></div>
                </> : <>
                  <div><dt>姓名</dt><dd>{data.user.name || data.user.displayName || '-'}</dd></div>
                  <div><dt>学校</dt><dd>{data.user.school || '-'}</dd></div>
                  <div><dt>学院</dt><dd>{data.user.college || '-'}</dd></div>
                  <div><dt>专业</dt><dd>{data.user.major || '-'}</dd></div>
                </>}
                {teamMode ? <div><dt>学校</dt><dd>{data.user.school || '-'}</dd></div> : null}
                <div><dt>考室</dt><dd>{data.user.roomName || '-'}</dd></div>
                <div><dt>座位号</dt><dd>{data.user.seatNo || '-'}</dd></div>
              </dl>
            </section>
            {!examStarted ? <section className="candidate-start-panel">
              <div className="candidate-start-countdown"><span>考试开始倒计时</span><strong>{formatCountdown(beginAt - now)}</strong></div>
              <button className="contest-button submit-code-button candidate-start-button" onClick={() => void startContest()} disabled={!canStart || busy === 'start'}><PlayCircle size={18} />{busy === 'start' ? '正在开始…' : now < beginAt ? '尚未到开始时间' : now > latestStartAt ? '已超过最晚开始时间' : '确认开始考试'}</button>
            </section> : null}
            <section className="candidate-exam-facts">
              <h2>考试详情</h2>
              <dl>
                <div><dt>状态</dt><dd>{examStatus}</dd></div>
                <div><dt>规则</dt><dd>{ruleName(data.contest.rule, data.contest.sourceRule)}</dd></div>
                <div><dt>题目</dt><dd>{data.problems.length}</dd></div>
                <div><dt>考试时间</dt><dd className="candidate-time-range"><span>{formatDate(data.session.startedAt || data.contest.beginAt)}</span><em>至</em><span>{formatDate(new Date(effectiveEndAt).toISOString())}</span></dd></div>
                {data.contest.flexible ? <div><dt>最晚开始</dt><dd>{formatDate(data.contest.latestStartAt || data.contest.beginAt)}</dd></div> : null}
                <div><dt>持续时间</dt><dd>{formatDurationLabel(examDurationMinutes)}</dd></div>
                <div><dt>参与人数</dt><dd>{data.contest.candidateCount ?? '-'}</dd></div>
              </dl>
            </section>
          </aside>
        </div> : null}

        {page === 'problems' ? <div className="exam-page-card"><header className="exam-page-heading"><div><span>PROBLEMS</span><h1>题目列表</h1></div><small>{data.problems.length} 道题</small></header><div className="exam-table-wrap"><table className="exam-problem-table"><thead><tr><th>提交结果</th><th>题号</th><th>题目名称</th><th>题目类型</th>{showProblemScore ? <th>本场分数</th> : null}<th>时间限制</th><th>空间限制</th><th>查看题目</th><th>递交</th></tr></thead><tbody>{data.problems.map(problem => {
          const scored = countedSubmission(problem, submissions, data.contest.rule);
          const sourceRule = (data.contest.sourceRule || data.contest.rule).toUpperCase();
          const submittedOnly = ['OI', 'LANQIAO'].includes(sourceRule);
          const hidden = scored?.resultHidden || (sourceRule !== 'KS' && problem.problemType === 'objective' && !data.contest.showObjectiveScore);
          let resultText = scored ? 'Submitted' : 'Not Submitted';
          let resultClass = scored ? 'submitted' : 'empty';
          if (scored && !hidden && !submittedOnly) {
            const status = statusName(scored);
            const showScore = !['ACM', 'XCPC'].includes(sourceRule) && scored.scoreVisible !== false && scored.score !== null;
            resultText = showScore ? `${status} ${Number(scored.score!.toFixed(2))}/${problem.score}` : status;
            resultClass = scored.status === 1 ? 'accepted' : isPendingStatus(scored.status) ? 'pending' : (scored.score ?? 0) > 0 ? 'partial' : 'failed';
          }
          return <tr key={problem.pid} tabIndex={0} onClick={() => navigate({ page: 'problem', pid: problem.pid })} onKeyDown={event => { if (event.key === 'Enter' && event.target === event.currentTarget) navigate({ page: 'problem', pid: problem.pid }); }}><td>{scored ? <button className={`problem-result ${resultClass}`} onClick={event => { event.stopPropagation(); openSubmission(scored, problem.pid); }}>{resultText}</button> : <span className={`problem-result ${resultClass}`}>{resultText}</span>}</td><td><b className="problem-index">{problem.index}</b></td><td><strong>{problem.title}</strong></td><td>{problemTypeLabel(problem.problemType)}</td>{showProblemScore ? <td><strong>{problem.score} 分</strong></td> : null}<td>{problem.problemType === 'objective' ? '—' : problem.timeLimit ? `${problem.timeLimit} ms` : '—'}</td><td>{problem.problemType === 'objective' ? '—' : problem.memoryLimit ? `${problem.memoryLimit} MB` : '—'}</td><td><button className="table-action" onClick={event => { event.stopPropagation(); navigate({ page: 'problem', pid: problem.pid }); }}>查看题目</button></td><td><button className="table-action primary" disabled={!canSubmit} onClick={event => { event.stopPropagation(); navigate({ page: problem.problemType === 'objective' ? 'problem' : 'submit', pid: problem.pid }); }}>{problem.problemType === 'objective' ? '作答' : '递交'}</button></td></tr>;
        })}</tbody></table></div></div> : null}

        {page === 'problem' && activeProblem ? <div className="candidate-problem-detail">
          <article className="candidate-problem-card">
            <header className="candidate-problem-heading">
              <h1><span>{activeProblem.index} -</span>{activeProblem.title}</h1>
              <div className="candidate-problem-meta">
                <span>题型：{problemTypeLabel(activeProblem.problemType)}</span>
                {showProblemScore ? <span>本场分数：{activeProblem.score} 分</span> : null}
                {activeProblem.problemType !== 'objective' && activeProblem.timeLimit ? <span>时间限制：{activeProblem.timeLimit} ms</span> : null}
                {activeProblem.problemType !== 'objective' && activeProblem.memoryLimit ? <span>空间限制：{activeProblem.memoryLimit} MB</span> : null}
              </div>
            </header>
            <div className="candidate-problem-statement"><HydroProblemContent problem={activeProblem} answers={activeObjectiveAnswers} onAnswer={updateObjectiveAnswer} api={api} sessionId={sessionId} /></div>
          </article>
          <aside className="candidate-problem-subnav">
            <section className="nova-problem-info">
              <h2>题目信息</h2>
              <dl><div><dt>题号</dt><dd>{activeProblem.index}</dd></div><div><dt>题目类型</dt><dd>{problemTypeLabel(activeProblem.problemType)}</dd></div>{activeProblem.problemType !== 'objective' ? <><div><dt>时间限制</dt><dd>{activeProblem.timeLimit ? `${activeProblem.timeLimit} ms` : '—'}</dd></div><div><dt>空间限制</dt><dd>{activeProblem.memoryLimit ? `${activeProblem.memoryLimit} MB` : '—'}</dd></div></> : null}{showProblemScore ? <div><dt>本场分数</dt><dd>{activeProblem.score} 分</dd></div> : null}</dl>
            </section>
            {activeProblem.problemType === 'objective' ? <section className="candidate-objective-progress">
              <div className="candidate-subnav-title"><h2>本题小题</h2><span>{activeObjectiveAnsweredCount}/{activeObjective.questions.length}</span></div>
              <div className="candidate-objective-progress-bar"><span style={{ width: `${activeObjective.questions.length ? activeObjectiveAnsweredCount / activeObjective.questions.length * 100 : 0}%` }} /></div>
              <div className="candidate-objective-grid">{activeObjective.questions.map((question) => {
                const answer = activeObjectiveAnswers[question.id];
                const answered = Array.isArray(answer) ? answer.length > 0 : Boolean(answer?.trim());
                return <button key={question.id} className={answered ? 'answered' : ''} onClick={() => document.getElementById(`candidate-objective-${question.id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })}>{question.id}</button>;
              })}</div>
            </section> : null}
            <section>
              <div className="candidate-subnav-title"><h2>题目导航</h2><span>{data.problems.length} 题</span></div>
              <div className="candidate-problem-grid">{data.problems.map((problem) => {
                const state = problemNavigationState(problem, submissions, data.contest.rule);
                const active = problem.pid === activeProblem.pid;
                return <button key={problem.pid} className={[active ? 'active' : '', state].filter(Boolean).join(' ')} onClick={() => navigate({ page: 'problem', pid: problem.pid })} title={problem.title}>{problem.index}</button>;
              })}</div>
            </section>
            <section className="candidate-problem-actions">
              <button onClick={() => navigate({ page: 'problemSubmissions', pid: activeProblem.pid })}><History size={16} />提交记录</button>
              {activeProblem.problemType === 'objective'
                ? <button className="primary" disabled={!canSubmit || !activeObjectiveCode.trim()} onClick={() => setConfirm({ problem: activeProblem, lang: '_', languageName: '提交答案', code: activeObjectiveCode })}><Send size={16} />提交答案</button>
                : <button className="primary" disabled={!canSubmit} onClick={() => navigate({ page: 'submit', pid: activeProblem.pid })}><Send size={16} />提交代码</button>}
            </section>
          </aside>
        </div> : null}

        {page === 'submit' && activeProblem ? <div className="candidate-submit-page">
          <aside className="nova-submit-sidebar"><section className="nova-problem-info"><h2>题目信息</h2><dl><div><dt>题号</dt><dd>{activeProblem.index}</dd></div><div><dt>时间限制</dt><dd>{activeProblem.timeLimit ? `${activeProblem.timeLimit} ms` : '—'}</dd></div><div><dt>空间限制</dt><dd>{activeProblem.memoryLimit ? `${activeProblem.memoryLimit} MB` : '—'}</dd></div></dl><div className="candidate-problem-actions"><button className="primary" onClick={() => navigate({ page: 'problem', pid: activeProblem.pid })}><ArrowLeft size={16} />查看题目</button><button onClick={() => navigate({ page: 'problemSubmissions', pid: activeProblem.pid })}><History size={16} />提交记录</button></div></section></aside>
          <section className="candidate-submit-card">
            <div className="candidate-submit-title"><div><h2>递交代码</h2><p>{activeProblem.index} · {activeProblem.title}</p></div><Code2 size={22} /></div>
            <label className="candidate-language-field">语言<select value={activeLang} onChange={event => setLangByPid(current => ({ ...current, [String(activeProblem.pid)]: event.target.value }))}>{groupJudgeLanguages(effectiveLanguages).map(group => <optgroup key={group.id} label={group.name}>{group.versions.map(language => <option key={language.id} value={language.id}>{language.name} ({language.id})</option>)}</optgroup>)}</select></label>
            {!effectiveLanguages.length ? <p role="alert">{data.contest.languagesError || '暂未获取到本题可用语言，请重试；若仍不可用，请联系管理员检查评测服务及题目语言限制。'} <button className="contest-button secondary" type="button" onClick={() => void loadContest()}><RefreshCw size={16} />重新获取语言</button></p> : null}<label className="candidate-code-field">代码<HighlightCodeEditor value={activeCode} onChange={updateCode} language={activeLang} rows={25} placeholder="粘贴或编写你的代码" /></label>
            <div className="candidate-submit-actions"><button className="contest-button submit-code-button" disabled={!activeCode.trim() || !canSubmit || !activeLang} onClick={() => setConfirm({ problem: activeProblem, lang: activeLang, languageName: effectiveLanguages.find(language => language.id === activeLang)?.name || activeLang, code: activeCode })}><Send size={17} />{canSubmit ? '提交测评' : submissionDisabledReason}</button></div>
          </section>
        </div> : null}

        {page === 'problemSubmissions' && activeProblem ? <div className="exam-page-card"><header className="exam-page-heading"><div><span>PROBLEM SUBMISSIONS</span><h1>{activeProblem.index} · {activeProblem.title} 的提交记录</h1></div><button className="icon-text-button" disabled={busy === 'submissions'} onClick={() => void refreshSubmissions(true)}><RefreshCw className={busy === 'submissions' ? 'spin' : ''} size={15} />刷新</button></header>{busy === 'submissions' ? <div className="contest-loading"><LoaderCircle className="spin" />正在加载数据…</div> : <SubmissionTable submissions={activeSubmissions} contest={data.contest} problems={data.problems} fixedProblem={activeProblem.index} onOpen={submission => openSubmission(submission, activeProblem.pid)} />}</div> : null}

        {page === 'submissions' ? <div className="exam-page-card"><header className="exam-page-heading"><div><span>SUBMISSIONS</span><h1>提交记录</h1><p>{data.contest.allowTeamSubmissionView ? '显示本考试账号和同队成员的提交记录' : '仅显示本考试账号的提交记录'}</p></div><button className="icon-text-button" disabled={busy === 'submissions'} onClick={() => void refreshSubmissions(true)}><RefreshCw className={busy === 'submissions' ? 'spin' : ''} size={15} />刷新</button></header>{busy === 'submissions' ? <div className="contest-loading"><LoaderCircle className="spin" />正在加载数据…</div> : <SubmissionTable submissions={submissions} contest={data.contest} problems={data.problems} onOpen={submission => openSubmission(submission)} />}</div> : null}

        {page === 'leaderboard' ? <div className="exam-page-card">{busy === 'leaderboard' && !leaderboard ? <div className="contest-loading"><LoaderCircle className="spin" />正在加载数据…</div> : leaderboard?.available ? <LeaderboardTables leaderboard={leaderboard} contest={data.contest} problems={data.problems} onRefresh={() => void refreshLeaderboard()} refreshing={busy === 'leaderboard'} onTimeChange={timePoint => void refreshLeaderboard(true, timePoint)} /> : <div className="leaderboard-unavailable"><Trophy size={32} /><strong>{leaderboard?.frozen ? '排行榜已封榜，暂不显示实时结果' : '排行榜暂未开放'}</strong></div>}</div> : null}

        {page === 'qa' ? <div className="exam-page-card exam-qa-page">
          <header className="exam-page-heading"><div><span>Q&amp;A AND ANNOUNCEMENTS</span><h1>答疑公告</h1></div><button className="icon-text-button" onClick={() => void loadQA()}><RefreshCw size={15} />刷新</button></header>
          <div className="candidate-qa-layout">
            <div className="candidate-qa-tabs" role="tablist" aria-label="答疑公告分类">
              <button type="button" role="tab" aria-selected={qaSection === 'announcements'} className={qaSection === 'announcements' ? 'active' : ''} onClick={() => setQaSection('announcements')}><Bell size={18} /><span>公告</span><b>{qaData.announcements.length}</b></button>
              <button type="button" role="tab" aria-selected={qaSection === 'mine'} className={qaSection === 'mine' ? 'active' : ''} onClick={() => setQaSection('mine')}><MessageCircleQuestion size={18} /><span>我的提问</span><b>{qaData.questions.filter(item => item.owned).length}</b></button>
              <button type="button" role="tab" aria-selected={qaSection === 'public'} className={qaSection === 'public' ? 'active' : ''} onClick={() => setQaSection('public')}><Users size={18} /><span>公开提问</span><b>{qaData.questions.filter(item => item.isPublished && !item.owned).length}</b></button>
            </div>
            <section className="candidate-qa-content" role="tabpanel">
              {qaSection === 'announcements' ? <>{qaData.announcements.map(item => <article className="contest-qa-item announcement" key={item.id}>{item.candidateId ? <b className="qa-problem-tag targeted">发给你的公告</b> : <b className="qa-problem-tag general">全体公告</b>}<MarkdownContent content={item.content} /><time>{formatDate(item.createdAt)}</time></article>)}{!qaData.announcements.length ? <div className="contest-empty">暂无公告</div> : null}</> : null}
              {qaSection !== 'announcements' ? <>{qaData.questions.filter(item => qaSection === 'mine' ? item.owned : item.isPublished && !item.owned).map(item => <article className={`contest-qa-item candidate-qa-thread ${item.isPublished ? 'published' : 'private'}`} key={item.id}><div className="candidate-qa-thread-head"><b className={`qa-problem-tag ${item.problemIndex ? '' : 'general'}`}>{item.problemIndex ? `题目 ${item.problemIndex} · ${item.problemTitle || item.problemPid}` : '综合提问'}</b><span>{item.isPublished ? '已公开' : '仅你与管理员可见'}</span></div><div className="candidate-qa-message-list">{item.messages.map(message => <div className={`candidate-qa-message ${message.sender === 'ADMIN' ? 'admin' : 'candidate'}`} key={message.id}><strong>{message.sender === 'ADMIN' ? '监考老师' : item.owned ? '我' : '提问考生'}</strong><MarkdownContent content={message.content} /><time>{formatDate(message.createdAt)}</time></div>)}</div>{item.owned && !examEnded ? <div className="candidate-qa-followup"><MarkdownComposer value={qaReplies[item.id] || ''} onChange={value => setQaReplies(current => ({ ...current, [item.id]: value }))} onUploadImage={uploadQAImage} placeholder="继续追问此问题" maxLength={10000} /><button className="contest-button submit-code-button" onClick={() => void submitQuestion(item.id)} disabled={!qaReplies[item.id]?.trim() || qaBusy}><Send size={15} />继续询问</button></div> : null}</article>)}{!qaData.questions.some(item => qaSection === 'mine' ? item.owned : item.isPublished && !item.owned) ? <div className="contest-empty">{qaSection === 'mine' ? '还没有自己的提问' : '暂无公开提问'}</div> : null}</> : null}
            </section>
            <section className="exam-qa-compose-panel candidate-qa-compose"><div className="candidate-qa-section-title"><MessageCircleQuestion size={20} /><h2>发起新问题</h2></div><label className="candidate-qa-topic-field"><span>主题</span><select value={qaProblemPid} onChange={event => setQaProblemPid(event.target.value)}><option value="">一般问题</option>{data.problems.map(problem => <option key={problem.pid} value={String(problem.pid)}>{problem.index} · {problem.title}</option>)}</select></label><div className="qa-compose-field"><span>内容</span><MarkdownComposer value={qaQuestion} onChange={setQaQuestion} onUploadImage={uploadQAImage} placeholder="请输入问题内容" disabled={examEnded} maxLength={10000} /></div><div className="candidate-qa-submit-row"><button className="contest-button submit-code-button" type="button" onClick={() => void submitQuestion()} disabled={!qaQuestion.trim() || qaBusy || examEnded || mockMode}>{qaBusy ? <LoaderCircle className="spin" size={16} /> : <Send size={16} />}{examEnded ? '考试已结束' : mockMode ? '预览模式不可发送' : '递交'}</button></div></section>
          </div>
        </div> : null}

        {page === 'print' && data.contest.allowPrint && data.contest.printMode && data.contest.printMode !== 'DISABLED' ? <PrintPage api={api} sessionId={sessionId} mode={data.contest.printMode} /> : null}
      </section>

      <footer className="nova-contest-footer">程序设计算法协会 · 在线考试平台</footer>

      {confirm ? <div className="contest-modal-backdrop"><section className="contest-confirm-modal" role="dialog" aria-modal="true"><header><div className="return-only-row"><button className="modal-back-button" type="button" onClick={() => setConfirm(null)}><ArrowLeft size={16} />返回修改</button></div><div><span className="contest-eyebrow">CONFIRM SUBMISSION</span><h2>{confirm.problem.problemType === 'objective' ? '确认提交答案' : '确认提交代码'}</h2><p>{confirm.problem.index} · {confirm.problem.title}</p></div></header><div className="confirm-language"><span>提交类型</span><strong>{confirm.languageName}</strong><span>内容长度</span><strong>{confirm.code.length.toLocaleString()} 字符</strong></div><CodePreview code={confirm.code} language={confirm.lang} showLineNumbers className="confirm-code-preview" /><footer><button className="contest-button submit-code-button" type="button" onClick={() => void submitCode()} disabled={busy === 'submit'}>{busy === 'submit' ? <LoaderCircle className="spin" size={17} /> : <Send size={17} />}{busy === 'submit' ? '正在提交…' : '确认提交'}</button></footer></section></div> : null}

      {selectedSubmission ? <div className="nova-submission-workspace">{contestHeading}<SubmissionDetail submission={selectedSubmission} contest={data.contest} user={data.user} maximumScore={data.problems.find(problem => problem.index === selectedSubmission.problemIndex)?.score ?? null} resultVisible={selectedResultVisible} scoreVisible={selectedScoreVisible} onBack={goPreviousPage} /></div> : null}

      {leaderboardOpen ? <div className="contest-modal-backdrop"><section className="contest-leaderboard-modal" role="dialog" aria-modal="true"><button className="icon-button leaderboard-modal-close" type="button" onClick={() => setLeaderboardOpen(false)}><X size={18} /></button>{leaderboard?.available ? <LeaderboardTables leaderboard={leaderboard} contest={data.contest} problems={data.problems} /> : <div className="leaderboard-unavailable"><Trophy size={32} /><strong>排行榜暂未开放</strong></div>}<footer><button className="contest-button secondary" type="button" onClick={() => setLeaderboardOpen(false)}>关闭</button></footer></section></div> : null}
      {announcementQueue[0] ? <div className="contest-modal-backdrop"><section className="qa-announcement-popup" role="alertdialog" aria-modal="true"><header><div><span className="contest-eyebrow">{announcementQueue[0].kind === 'reply' ? 'QUESTION REPLY' : 'ANNOUNCEMENT'}</span><h2>{announcementQueue[0].kind === 'reply' ? '监考老师回复了你的问题' : announcementQueue[0].candidateId ? '发给你的公告' : '考试公告'}</h2></div>{announcementQueue[0].kind === 'reply' ? <MessageCircleQuestion size={22} /> : <Bell size={22} />}</header><MarkdownContent content={announcementQueue[0].content} />{notificationAckError ? <p role="alert">{notificationAckError}</p> : null}<footer><time>{formatDate(announcementQueue[0].createdAt)}</time><button className="contest-button submit-code-button" type="button" disabled={notificationAckBusy} onClick={() => void acknowledgeNotification(announcementQueue[0])}>{notificationAckBusy ? '正在确认…' : '确认已读'}</button></footer></section></div> : null}
    </main>
  );
}
