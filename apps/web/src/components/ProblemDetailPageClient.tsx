'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import ReactMarkdown, { defaultUrlTransform } from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import { ArrowLeft, CheckCircle2, ChevronRight, FileEdit, LoaderCircle, RotateCcw, Send, XCircle } from 'lucide-react';
import { api } from './api';
import { CodePreview } from './CodeHighlight';
import { hydroStatusIsAwaiting } from '@/lib/hydro-status';
import { sanitizeStatementHtml, statementAttachmentHref, problemTypeLabel } from '@cwnupaa/proctor-shared';

type Problem = { id: string; pid: string; title: string; content: string | Record<string, string>; html: boolean; config: Record<string, any>; tags: string[]; difficulty: number; score?: number };
type RecordData = { id: string; lang: string; code?: string; status?: number; statusText: string; score: number; time: number; memory: number; testCases: unknown[]; judgeAt?: string | null; createdAt?: string };
type ObjectiveQuestion = { id: string; kind: 'select' | 'multiselect' | 'input'; options: string[] };
const languageNames: Record<string, string> = { cc: 'C++', cpp: 'C++', 'cpp.gcc': 'C++ (GCC)', 'cpp.g++17': 'C++17', c: 'C', py: 'Python 3', python: 'Python', java: 'Java', js: 'JavaScript', ts: 'TypeScript', go: 'Go', rs: 'Rust', php: 'PHP', kt: 'Kotlin', swift: 'Swift', hs: 'Haskell', rb: 'Ruby', pas: 'Pascal', _: '提交答案' };
const languageLabel = (value: string) => languageNames[value] || value.replace(/\./g, ' · ');
function limitLabel(value: unknown, unit: string) { if (typeof value === 'string' && value.trim()) return value.trim(); const number = Number(value); return Number.isFinite(number) && number > 0 ? `${number} ${unit}` : '—'; }
const isPending = (record: RecordData) => hydroStatusIsAwaiting(record.statusText, record.status, record.judgeAt);
function submissionDateTime(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const datePart = [date.getFullYear(), date.getMonth() + 1, date.getDate()].map(part => String(part).padStart(2, '0')).join('-');
  const timePart = [date.getHours(), date.getMinutes(), date.getSeconds()].map(part => String(part).padStart(2, '0')).join(':');
  return `${datePart} ${timePart}`;
}
function markdownContent(content: Problem['content']) { if (typeof content === 'string') { try { const parsed = JSON.parse(content); if (parsed && typeof parsed === 'object') return String(parsed.zh || parsed['zh-CN'] || parsed.en || Object.values(parsed)[0] || ''); } catch { /* plain Markdown */ } return content; } return String(content.zh || content['zh-CN'] || content.en || Object.values(content)[0] || ''); }
function parseObjective(content: string): { blocks: Array<{ markdown: string } | { question: ObjectiveQuestion }>; questions: ObjectiveQuestion[] } {
  const blocks: Array<{ markdown: string } | { question: ObjectiveQuestion }> = []; const questions: ObjectiveQuestion[] = []; const pattern = /\{\{\s*(select|multiselect|input)\((\d+)\)\s*\}\}/g; let cursor = 0; let match: RegExpExecArray | null;
  while ((match = pattern.exec(content))) {
    if (match.index > cursor) blocks.push({ markdown: content.slice(cursor, match.index) });
    const options: string[] = []; let pos = pattern.lastIndex; const after = content.slice(pos); const lines = after.split(/\n/); let consumed = 0;
    for (const line of lines) { if (!line.trim()) { consumed += line.length + 1; continue; } const option = line.match(/^\s*[-*+]\s+(.*)$/); if (!option) break; options.push(option[1]); consumed += line.length + 1; }
    const question: ObjectiveQuestion = { id: match[2], kind: match[1] as ObjectiveQuestion['kind'], options }; questions.push(question); blocks.push({ question }); cursor = pos + consumed; pattern.lastIndex = cursor;
  }
  if (cursor < content.length) blocks.push({ markdown: content.slice(cursor) });
  return { blocks, questions };
}
function yamlAnswer(answers: Record<string, string | string[]>) { return Object.entries(answers).map(([key, value]) => { if (Array.isArray(value)) return `${key}:\n${value.map(item => `  - ${item}`).join('\n')}`; return `${key}: ${value || ''}`; }).join('\n'); }
type HydroSample = { input?: string; output?: string };
function parseHydroSamples(content: string) {
  const samples: Record<string, HydroSample> = {}; const tokenPattern = /```(input|output)(\d*)\s*\n([\s\S]*?)```/gi; const markdown = content.replace(tokenPattern, (_all, kind: string, index: string, value: string) => { const key = index || '1'; samples[key] ||= {}; samples[key][kind.toLowerCase() as 'input' | 'output'] = value.trimEnd(); return `\n\n[[HYDRO_SAMPLE_${key}]]\n\n`; });
  return { markdown, samples };
}
function MarkdownCode({ inline, className, children }: any) { const source = String(children); const language = className?.match(/language-([\w.+-]+)/)?.[1] || 'text'; const isInline = inline === true || (inline === undefined && !className && !source.endsWith('\n')); const code = source.replace(/\n$/, ''); return isInline ? <code className="hydro-inline-code">{children}</code> : <CodePreview code={code} language={language} showLineNumbers />; }
function imageProxyUrl(source: string, problemId: string, hydroBaseUrl: string) {
  if (!source || source.startsWith('data:') || source.startsWith('blob:') || source.startsWith('/api/problems/')) return source;
  // Hydro uses file://name.png for problem attachments. URL treats the name
  // after file:// as a hostname, so handle this scheme before normal parsing.
  if (/^file:\/\//i.test(source)) {
    const rawName = source.slice('file://'.length).split(/[?#]/, 1)[0];
    let fileName = rawName.split('/').filter(Boolean).at(-1) || '';
    try { fileName = decodeURIComponent(fileName); } catch { /* retain the original attachment name */ }
    return fileName ? `/api/problems/${encodeURIComponent(problemId)}/file/${encodeURIComponent(fileName)}` : source;
  }
  try {
    const target = new URL(source, `${hydroBaseUrl.replace(/\/$/, '')}/`);
    const hydroOrigin = new URL(hydroBaseUrl).origin;
    if (target.origin !== hydroOrigin && /^https?:/i.test(source)) return source;
    const fileName = decodeURIComponent(target.pathname.split('/').filter(Boolean).at(-1) || '');
    return fileName ? `/api/problems/${encodeURIComponent(problemId)}/file/${encodeURIComponent(fileName)}` : source;
  } catch { return source; }
}
function markdownUrlTransform(url: string, key: string, node: Readonly<{ tagName?: string }>, problemId: string, hydroBaseUrl: string) {
  const transformed = key === 'src' && node.tagName === 'img' ? imageProxyUrl(url, problemId, hydroBaseUrl) : key === 'href' ? statementAttachmentHref(url, problemId) : url;
  return defaultUrlTransform(transformed);
}
function normalizeHtmlImages(html: string, problemId: string, hydroBaseUrl: string) { return sanitizeStatementHtml(html, { rewriteImageUrl: source => imageProxyUrl(source, problemId, hydroBaseUrl), rewriteLinkUrl: source => statementAttachmentHref(source, problemId) }); }
function HydroMarkdownContent({ content, problemId, hydroBaseUrl }: { content: string; problemId: string; hydroBaseUrl: string }) { const parsed = parseHydroSamples(content); const chunks = parsed.markdown.split(/(\[\[HYDRO_SAMPLE_[^\]]+\]\])/g); return <>{chunks.map((chunk, index) => { const token = chunk.match(/^\[\[HYDRO_SAMPLE_(.+)\]\]$/); if (!token) return chunk ? <div className="hydro-markdown" key={index}><ReactMarkdown urlTransform={(url, key, node) => markdownUrlTransform(url, key, node, problemId, hydroBaseUrl)} components={{ code: MarkdownCode, img: ({ src, alt }: any) => <img src={String(src || '')} alt={alt || ''} loading="lazy" /> }} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{chunk}</ReactMarkdown></div> : null; const sample = parsed.samples[token[1]] || {}; return <div className="hydro-sample" key={index}><div className="hydro-sample-title">样例 {token[1]}</div><div className="hydro-sample-grid">{sample.input !== undefined ? <div><span>输入</span><CodePreview code={sample.input} language="text" copyable /></div> : null}{sample.output !== undefined ? <div><span>输出</span><CodePreview code={sample.output} language="text" copyable /></div> : null}</div></div>; })}</>; }

export function ProblemDetailPageClient({ problemId, hydroBaseUrl, problemDomainId = 'Problems', canManage = false, examId }: { problemId: string; hydroBaseUrl: string; problemDomainId?: string; canManage?: boolean; examId?: string }) {
  const [problem, setProblem] = useState<Problem | null>(null); const [code, setCode] = useState(''); const [lang, setLang] = useState(''); const [record, setRecord] = useState<RecordData | null>(null); const [answers, setAnswers] = useState<Record<string, string | string[]>>({}); const [error, setError] = useState(''); const [loading, setLoading] = useState(true); const [submitting, setSubmitting] = useState(false); const [showSubmit, setShowSubmit] = useState(false); const [rejudging, setRejudging] = useState(false); const [rejudgeMessage, setRejudgeMessage] = useState('');
  const contextQuery = examId ? `?examId=${encodeURIComponent(examId)}` : '';
  const submitPath = `/dashboard/problems/${problemId}/submit${contextQuery}`;
  const recordsPath = `/dashboard/problems/${problemId}/records${contextQuery}`;
  useEffect(() => { let mounted = true; api<Problem>(`/api/problems/${problemId}`).then(p => { if (!mounted) return; setProblem(p);  }).catch(e => mounted && setError(e instanceof Error ? e.message : '题目加载失败')).finally(() => mounted && setLoading(false)); return () => { mounted = false; }; }, [problemId]);
  const content = problem ? markdownContent(problem.content) : ''; const objective = useMemo(() => problem && problem.config?.type === 'objective' ? parseObjective(content) : { blocks: [{ markdown: content }], questions: [] }, [problem, content]); const isObjective = problem?.config?.type === 'objective';
  const languages = useMemo(() => ['objective', 'submit_answer'].includes(problem?.config?.type) ? ['_'] : [], [problem]);
  const answeredCount = objective.questions.filter(q => { const value = answers[q.id]; return Array.isArray(value) ? value.length > 0 : Boolean(value?.trim()); }).length;
  useEffect(() => { if (!record || !isPending(record)) return; const timer = window.setInterval(async () => { try { const next = await api<RecordData>(`/api/problems/records/${record.id}`); setRecord(next); if (!isPending(next)) window.clearInterval(timer); } catch { window.clearInterval(timer); } }, 1500); return () => window.clearInterval(timer); }, [record?.id, record?.statusText, record?.judgeAt]);
  function updateAnswer(id: string, value: string | string[]) { setAnswers(previous => ({ ...previous, [id]: value })); }
  async function rejudgeProblem() { if (!problem || rejudging) return; setRejudging(true); setRejudgeMessage('正在按提交顺序重新测评…'); try { const result = await api<{ total: number; completed: number; failed: number }>(`/api/problems/${problem.id}/rejudge`, { method: 'POST' }); setRejudgeMessage(result.failed ? `已完成 ${result.completed}/${result.total} 条，${result.failed} 条失败` : `已完成 ${result.completed} 条提交的重新测评`); } catch (e) { setRejudgeMessage(e instanceof Error ? e.message : '重测失败'); } finally { setRejudging(false); } }
  async function submit() { if (!problem) return; const submissionCode = isObjective ? yamlAnswer(answers) : code; if (!submissionCode.trim()) { setError(isObjective ? '请先完成至少一道客观题' : '请输入代码'); return; } setSubmitting(true); setError(''); try { const result = await api<RecordData>(`/api/problems/${problem.id}`, { method: 'POST', body: JSON.stringify({ lang: isObjective ? '_' : lang, code: submissionCode }) }); setShowSubmit(false); window.location.assign(`/dashboard/problems/${problem.id}/records/${result.id}${contextQuery}`); } catch (e) { setError(e instanceof Error ? e.message : '提交失败'); } finally { setSubmitting(false); } }
  if (loading) return <div className="problem-loading"><LoaderCircle className="spin" size={19} /> 正在加载数据…</div>;
  if (!problem) return <div className="card problem-error">{error || '题目不存在或暂时无法访问'}</div>;
  const type = String(problem.config?.type || 'default'); const typeLabel = problemTypeLabel(type); const timeLimit = problem.config?.timeMax ?? problem.config?.timeLimit ?? problem.config?.time; const memoryLimit = problem.config?.memoryMax ?? problem.config?.memoryLimit ?? problem.config?.memory; const hydroRoot = hydroBaseUrl.replace(/\/$/, ''); const problemUrl = `${hydroRoot}/d/${encodeURIComponent(problemDomainId)}/p/${problem.id}`; const editUrl = `${problemUrl}/edit`; const showJudge = Boolean(record); const isObjectiveType = type.toLowerCase() === 'objective';
  return <div className={`problem-detail-page${showJudge ? ' has-record' : ''}`} onCopy={event => { if (!(event.target as HTMLElement).closest('.hydro-sample')) event.preventDefault(); }}>
    <div className="problem-breadcrumb"><Link href={examId ? `/dashboard/exams/${examId}/problems` : '/dashboard/problems'}><ArrowLeft size={15} /> {examId ? '返回题目列表' : '返回题库'}</Link></div>
    <div className="problem-detail-heading card"><div className="problem-heading-main"><h1><span className="problem-heading-pid">#{problem.pid}</span><span>{problem.title}</span></h1><div className="problem-heading-meta"><span className="problem-info-badge">题型：{typeLabel}</span>{!isObjectiveType ? <><span className="problem-info-badge">时间限制：{limitLabel(timeLimit, 'ms')}</span><span className="problem-info-badge">空间限制：{limitLabel(memoryLimit, 'MiB')}</span></> : null}</div></div></div>
    {error ? <div className="card problem-error">{error}</div> : null}
    {showJudge ? <div className="hydro-record-page card"><div className="hydro-record-page-header"><div><span className="hydro-judge-eyebrow">SUBMISSION #{record!.id}</span><h2>提交记录</h2><p>{record!.createdAt ? submissionDateTime(record!.createdAt) : '刚刚提交'} · {languageLabel(record!.lang)}</p></div><div className={`hydro-record-status ${isPending(record!) ? 'pending' : record!.statusText === 'Accepted' ? 'accepted' : 'failed'}`}>{isPending(record!) ? <LoaderCircle className="spin" size={19} /> : record!.statusText === 'Accepted' ? <CheckCircle2 size={19} /> : <XCircle size={19} />}<strong>{isPending(record!) ? 'Waiting' : record!.statusText}</strong></div></div><div className="hydro-record-metrics"><div><span>状态</span><strong>{isPending(record!) ? 'Waiting' : record!.statusText}</strong></div><div><span>得分</span><strong>{record!.score}</strong></div><div><span>耗时</span><strong>{record!.time} ms</strong></div><div><span>内存</span><strong>{record!.memory} KB</strong></div></div><section className="hydro-record-code-section"><div className="hydro-record-section-title"><h3>提交内容</h3><span>{languageLabel(record!.lang)}</span></div><CodePreview code={record!.code || code} language={record!.lang} /></section><details className="hydro-record-tests"><summary>查看测试点详情</summary><pre>{JSON.stringify(record!.testCases, null, 2)}</pre></details><div className="hydro-record-actions"><Link className="button" href={recordsPath}>查看我的提交</Link>{isObjective ? <button className="button" onClick={() => { setRecord(null); setShowSubmit(true); }}><Send size={15} /> 再次提交</button> : <Link className="button" href={submitPath}><Send size={15} /> 再次提交</Link>}</div></div> : null}
    <div className="problem-detail-layout"><article className="card hydro-problem-card"><div className="hydro-problem-content">{problem.html ? <div className="problem-content" dangerouslySetInnerHTML={{ __html: normalizeHtmlImages(content, problem.id, hydroBaseUrl) }} /> : isObjective ? objective.blocks.map((block, index) => 'markdown' in block ? <HydroMarkdownContent key={`m-${index}`} content={block.markdown} problemId={problem.id} hydroBaseUrl={hydroBaseUrl} /> : <ObjectiveControl key={`q-${block.question.id}`} question={block.question} answer={answers[block.question.id]} problemId={problem.id} hydroBaseUrl={hydroBaseUrl} onChange={value => updateAnswer(block.question.id, value)} />) : <HydroMarkdownContent content={content} problemId={problem.id} hydroBaseUrl={hydroBaseUrl} />}</div></article>
      <aside className="problem-action-column">{isObjective ? <ObjectiveProgress questions={objective.questions} answeredCount={answeredCount} onJump={id => document.getElementById(`objective-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })} /> : null}<div className="card problem-action-menu"><h2>题目操作</h2>{canManage ? <><a className="problem-action-menu-item" href={editUrl} target="_blank" rel="noreferrer"><FileEdit size={15} /> 编辑题目</a><button className="problem-action-menu-item" type="button" onClick={() => void rejudgeProblem()} disabled={rejudging}><RotateCcw size={15} className={rejudging ? 'spin' : ''} /> {rejudging ? '重测中…' : '重测整题'}</button></> : null}<Link className="problem-action-menu-item" href={submitPath}><Send size={15} /> 提交代码</Link><Link className="problem-action-menu-item" href={recordsPath}><ChevronRight size={15} /> 提交记录</Link>{rejudgeMessage ? <p className="problem-rejudge-message">{rejudgeMessage}</p> : null}</div>{!showJudge ? <div className={`card problem-submit-card hydro-submit-closed ${isObjective ? '' : 'problem-submit-legacy'}`}><div className="hydro-submit-icon"><Send size={20} /></div><div><h2>{isObjective ? '提交答案' : '提交测评'}</h2><p>{isObjective ? '完成选择和填空后即可提交答案。' : '提交代码后可查看测评结果和提交记录。'}</p></div>{isObjective ? <button className="button hydro-open-submit" onClick={() => setShowSubmit(true)}>提交答案</button> : <Link className="button hydro-open-submit" href={submitPath}>提交代码</Link>}<Link className="hydro-record-link" href={recordsPath}>查看我的提交记录 <ChevronRight size={14} /></Link></div> : <div className="card hydro-judge-card"><div className="hydro-judge-header"><div><span className="hydro-judge-eyebrow">JUDGE RESULT</span><h2>测评结果</h2></div><button className="icon-button" onClick={() => setRecord(null)} aria-label="关闭测评结果"><XCircle size={18} /></button></div><div className={`judge-status ${isPending(record!) ? 'pending' : record!.statusText === 'Accepted' ? 'accepted' : 'failed'}`}><strong>{isPending(record!) ? 'Waiting' : record!.statusText}</strong><span>{isPending(record!) ? '答案已提交，正在等待测评结果…' : '本次测评已完成'}</span></div><div className="judge-metrics"><div><span>得分</span><strong>{record!.score}</strong></div><div><span>耗时</span><strong>{record!.time} ms</strong></div><div><span>内存</span><strong>{record!.memory} KB</strong></div></div><CodePreview code={record!.code || code} language={record!.lang} className="judge-record-code" /><Link className="button secondary" href={submitPath}>再次提交</Link></div>}
        {showSubmit && !showJudge && isObjective ? <div className="card problem-submit-card hydro-submit-editor"><div className="hydro-submit-editor-head"><div><span className="hydro-judge-eyebrow">SUBMIT SOLUTION</span><h2>提交答案</h2></div><button className="icon-button" onClick={() => setShowSubmit(false)} aria-label="关闭提交框"><XCircle size={18} /></button></div><p className="objective-submit-note">已完成 {answeredCount} / {objective.questions.length} 小题，可随时提交；未作答的小题记为未答。</p><div className="hydro-submit-editor-foot"><span>答案将自动整理后提交</span><button className="button" onClick={() => void submit()} disabled={submitting || answeredCount === 0}><Send size={15} /> {submitting ? '提交中…' : '提交测评'}</button></div></div> : null}</aside>
    </div>
  </div>;
}

function ObjectiveOptionMarkdown({ content, problemId, hydroBaseUrl }: { content: string; problemId: string; hydroBaseUrl: string }) {
  return <span className="objective-option-markdown"><ReactMarkdown urlTransform={(url, key, node) => markdownUrlTransform(url, key, node, problemId, hydroBaseUrl)} components={{ p: ({ children }) => <span>{children}</span>, code: MarkdownCode, img: ({ src, alt }: any) => <img src={String(src || '')} alt={alt || ''} loading="lazy" /> }} remarkPlugins={[remarkGfm, remarkMath]} rehypePlugins={[rehypeKatex]}>{content}</ReactMarkdown></span>;
}

function ObjectiveControl({ question, answer, problemId, hydroBaseUrl, onChange }: { question: ObjectiveQuestion; answer?: string | string[]; problemId: string; hydroBaseUrl: string; onChange: (value: string | string[]) => void }) {
  return <section className="objective-question" id={`objective-${question.id}`}>{question.kind === 'input' ? <input className="objective-fill-input" value={typeof answer === 'string' ? answer : ''} onChange={e => onChange(e.target.value)} placeholder="请输入答案" /> : <div className="objective-options">{question.options.map((option, index) => { const letter = String.fromCharCode(65 + index); const text = option.replace(/^\s*(?:[（(]?[A-Za-z][.、)）．]\s*)/, ''); const checked = Array.isArray(answer) ? answer.includes(letter) : answer === letter; return <label className="objective-option" key={`${question.id}-${letter}`}><input type={question.kind === 'multiselect' ? 'checkbox' : 'radio'} name={`objective-${question.id}`} checked={checked} onChange={() => { if (question.kind !== 'multiselect') onChange(letter); else { const current = Array.isArray(answer) ? answer : []; onChange(current.includes(letter) ? current.filter(item => item !== letter) : [...current, letter]); } }} /><span className="objective-option-letter">{letter}</span><ObjectiveOptionMarkdown content={text} problemId={problemId} hydroBaseUrl={hydroBaseUrl} /></label>; })}</div>}</section>;
}

function ObjectiveProgress({ questions, answeredCount, onJump }: { questions: ObjectiveQuestion[]; answeredCount: number; onJump: (id: string) => void }) {
  return <div className="card objective-progress"><div className="objective-progress-head"><strong>答题进度</strong><span>{answeredCount} / {questions.length}</span></div><div className="objective-progress-bar"><span style={{ width: `${questions.length ? answeredCount / questions.length * 100 : 0}%` }} /></div><div className="objective-progress-list">{questions.map(question => <button key={question.id} className="objective-progress-item" onClick={() => onJump(question.id)}>{question.id}<span>{question.kind === 'input' ? '填空' : question.kind === 'multiselect' ? '多选' : '选择'}</span></button>)}</div></div>;
}
