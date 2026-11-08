'use client';

import { formatScore } from '@cwnupaa/proctor-shared';

import Link from 'next/link';
import { memo, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ArrowDown, ArrowUp, CheckCircle2, Code2, FileQuestion, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import { parseObjectiveContent } from '@cwnupaa/proctor-shared';
import { AUTHORING_LIMITS, objectiveQuestionMarkdown, programmingStatementTemplate, questionKindLabel, validateProblemDraft,
  type AuthoringIssue, type AuthoringQuestion, type AuthoringTest, type ProblemDraft, type QuestionKind } from '@/lib/problem-authoring';
import { MarkdownComposer, MarkdownContent } from './MarkdownComposer';
import { HydroProblemStatement } from './HydroProblemStatement';
import { api } from './api';
import styles from './ProblemCreateDialog.module.css';

type Result = { complete: boolean; id: string; domain?: string; ready?: number; files?: number; total?: number };
type Submission = { requestId: string; draft: ProblemDraft };
const id = () => {
  // Intranet HTTP pages may not expose randomUUID; getRandomValues also works there.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 15) | 64; bytes[8] = (bytes[8] & 63) | 128;
  const hex = Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};
const newTest = (): AuthoringTest => ({ id: id(), input: '', output: '', emptyInput: false, emptyOutput: false, score: 10 });
const newQuestion = (kind: QuestionKind): AuthoringQuestion => ({ id: id(), kind, content: '', score: 5, answers: [], answerText: '',
  options: ['single', 'multiple'].includes(kind) ? Array.from({ length: 4 }, () => ({ id: id(), content: '' })) : [] });

const ObjectivePreview = memo(function ObjectivePreview({ content }: { content: string }) {
  return <div className={styles.preview}>{parseObjectiveContent(content).blocks.map((block, i) => 'markdown' in block
    ? <MarkdownContent key={`m-${i}`} content={block.markdown} />
    : <div className={styles.previewControl} key={`q-${block.question.id}`}>{block.question.kind === 'input'
      ? <input aria-label={`小题 ${block.question.id} 作答预览`} placeholder="请输入答案（仅预览）" disabled />
      : block.question.options.map((option, j) => <div className={styles.previewOption} key={j}><input aria-label={`选项 ${String.fromCharCode(65 + j)}`} type={block.question.kind === 'multiselect' ? 'checkbox' : 'radio'} disabled /><b>{String.fromCharCode(65 + j)}.</b><MarkdownContent content={option} /></div>)}</div>)}</div>;
});

export function ProblemCreateDialog({ open, onClose, onSaved }: { open: boolean; onClose: () => void; onSaved: (id: string) => void }) {
  const [draft, setDraft] = useState<ProblemDraft | null>(null);
  const [issues, setIssues] = useState<AuthoringIssue[]>([]);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false), busyRef = useRef(false);
  const [frozen, setFrozen] = useState<Submission | null>(null);
  const [saved, setSaved] = useState<Result | null>(null);
  const [progress, setProgress] = useState('');
  const [adding, setAdding] = useState(false), [preview, setPreview] = useState(false);
  const [testDraft, setTestDraft] = useState<AuthoringTest | null>(null), [testIssues, setTestIssues] = useState<AuthoringIssue[]>([]);
  const testInitial = useRef('');
  const dialog = useRef<HTMLElement>(null);
  const testDialog = useRef<HTMLElement>(null);
  const dirty = !!draft && !saved;
  const locked = busy || !!frozen;
  const close = () => {
    if (busyRef.current) return;
    if (dirty && !window.confirm(frozen ? '保存尚未完成，创建内容及进度会保留，可重新打开后继续保存。确定关闭？' : '题目尚未保存，确定关闭创建窗口？输入内容会暂时保留。')) return;
    onClose();
  };
  useEffect(() => {
    if (!dirty) return;
    const leave = (event: BeforeUnloadEvent) => { event.preventDefault(); event.returnValue = ''; };
    window.addEventListener('beforeunload', leave); return () => window.removeEventListener('beforeunload', leave);
  }, [dirty]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => dialog.current?.focus());
    return () => { cancelAnimationFrame(frame); previous?.focus(); };
  }, [open]);
  useEffect(() => {
    if (!testDraft) return;
    const previous = document.activeElement as HTMLElement | null;
    const frame = requestAnimationFrame(() => testDialog.current?.focus());
    return () => { cancelAnimationFrame(frame); previous?.focus(); };
  }, [testDraft?.id]);
  const fieldError = (path: string, list = issues) => {
    const match = list.find(i => i.path === path || i.path.startsWith(path + '.'));
    return match ? <small className={styles.fieldError} role="alert">{match.message}</small> : null;
  };
  function choose(kind: ProblemDraft['kind']) {
    setDraft(kind === 'objective' ? { kind, title: '', questions: [] } : { kind, title: '', content: programmingStatementTemplate, timeMs: 1000, memoryMb: 256, tests: [] });
    setIssues([]); setError('');
  }
  function updateQuestion(key: string, patch: Partial<AuthoringQuestion>) {
    setDraft(current => current?.kind === 'objective' ? { ...current, questions: current.questions.map(q => q.id === key ? { ...q, ...patch } : q) } : current);
  }
  function moveQuestion(index: number, delta: number) {
    if (draft?.kind !== 'objective') return;
    const questions = [...draft.questions]; [questions[index], questions[index + delta]] = [questions[index + delta], questions[index]];
    setDraft({ ...draft, questions }); setIssues([]);
  }
  function openTest(test?: AuthoringTest) {
    const next = test ? { ...test } : newTest(); setTestDraft(next); testInitial.current = JSON.stringify(next); setTestIssues([]);
  }
  function closeTest() {
    if (testDraft && JSON.stringify(testDraft) !== testInitial.current && !window.confirm('测试点尚未加入题目，确定放弃本次测试点编辑？')) return;
    setTestDraft(null); setTestIssues([]);
  }
  function saveTest() {
    if (draft?.kind !== 'programming' || !testDraft) return;
    const number = draft.tests.some(t => t.id === testDraft.id) ? draft.tests.findIndex(t => t.id === testDraft.id) + 1 : draft.tests.length + 1;
    const errors = validateProblemDraft({ ...draft, tests: [testDraft] }).filter(i => i.path.startsWith('tests')).map(i => ({ ...i, message: i.message.replace('测试点 1', `测试点 ${number}`) }));
    if (errors.length) { setTestIssues(errors); return; }
    const exists = draft.tests.some(t => t.id === testDraft.id);
    setDraft({ ...draft, tests: exists ? draft.tests.map(t => t.id === testDraft.id ? testDraft : t) : [...draft.tests, testDraft] });
    setTestDraft(null); setTestIssues([]); setIssues([]);
  }
  async function save() {
    if (!draft || busyRef.current || saved) return;
    if (testDraft) { setError('请先保存或取消正在编辑的测试点'); return; }
    if (!frozen) {
      const errors = validateProblemDraft(draft);
      if (errors.length) { setIssues(errors); setError('请修改标出的字段、小题或测试点'); return; }
      if (new TextEncoder().encode(JSON.stringify(draft)).length > 6 * 1024 * 1024) { setError('题目及测试数据总量不能超过 6 MiB'); return; }
    }
    const submission = frozen || { requestId: id(), draft: structuredClone(draft) };
    setFrozen(submission); busyRef.current = true; setBusy(true); setError(''); setIssues([]);
    try {
      for (let step = 0; step < 500; step++) {
        const result = await api<Result>('/api/problems/create', { method: 'POST', timeoutMs: 45000,
          body: JSON.stringify(step === 0 ? submission : { requestId: submission.requestId }) });
        if (result.complete) { setSaved(result); setProgress(''); onSaved(result.id); return; }
        setProgress(`正在保存后台资料 ${result.ready ?? 0} / ${result.files ?? '…'}，请勿关闭窗口`);
      }
      throw new Error('本批保存尚未结束，进度已保留，请继续保存');
    } catch (cause) {
      setError(cause instanceof DOMException && cause.name === 'AbortError' ? '保存请求超时，内容和进度已保留，请点击“继续保存”'
        : cause instanceof Error ? cause.message : '保存未完成，内容和进度已保留，请重试');
    } finally { busyRef.current = false; setBusy(false); }
  }
  if (!open || typeof document === 'undefined') return null;
  const items = draft?.kind === 'objective' ? draft.questions : draft?.tests || [];
  const total = items.reduce((sum, item) => sum + (Number.isFinite(item.score) ? item.score : 0), 0);
  const previewContent = !preview ? '' : draft?.kind === 'objective' ? draft.questions.map(objectiveQuestionMarkdown).join('\n---\n\n') : draft?.content || '';
  return createPortal(<div className={`modal-backdrop management-dialog ${styles.backdrop}`} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
    <section ref={dialog} tabIndex={-1} className={`modal-panel ${styles.dialog}`} role="dialog" aria-modal="true" aria-labelledby="create-problem-title" onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (testDraft) closeTest(); else close(); }
      if (event.key === 'Tab') {
        const container = testDraft ? testDialog.current : dialog.current;
        const elements = Array.from(container?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary') || []).filter(e => e.getClientRects().length);
        const first = elements[0], last = elements.at(-1);
        if (event.shiftKey && (document.activeElement === first || document.activeElement === container)) { event.preventDefault(); last?.focus(); }
        else if (!event.shiftKey && (document.activeElement === last || document.activeElement === container)) { event.preventDefault(); first?.focus(); }
      }
    }}>
      <header className={styles.header}><h2 id="create-problem-title">{!draft ? '创建题目' : draft.kind === 'objective' ? '创建客观题' : '创建编程题'}</h2><button type="button" className="icon-button" aria-label="关闭创建窗口" disabled={busy} onClick={close}><X size={20} /></button></header>
      {saved ? <div className={styles.success}><CheckCircle2 size={34} /><h3>题目已完整创建</h3><p>HydroOJ ID：{saved.id} · {formatScore(saved.total)} 分</p><Link className="button" href={`/dashboard/problems/${saved.id}`}>查看已创建题目</Link><button className="button secondary" onClick={() => { setDraft(null); setFrozen(null); setSaved(null); setPreview(false); setError(''); }}>继续创建</button></div>
        : !draft ? <div className={styles.types}><button className="card" onClick={() => choose('objective')}><FileQuestion size={30} /><strong>创建客观题</strong><span>单选、多选、判断、填空组成一个题组</span></button><button className="card" onClick={() => choose('programming')}><Code2 size={30} /><strong>创建编程题</strong><span>Markdown 题面与独立计分的后台测试点</span></button></div>
        : <>
          <fieldset disabled={locked} className={styles.form}>
            <label className={styles.field}>{draft.kind === 'objective' ? '题组标题' : '题目名称'}<input value={draft.title} maxLength={200} onChange={event => setDraft({ ...draft, title: event.target.value })} placeholder={draft.kind === 'objective' ? '例如：2026年C语言程序设计单选题' : '请输入题目名称'} aria-invalid={issues.some(i => i.path === 'title')} />{fieldError('title')}</label>
            <div className={styles.summary}><strong>{draft.kind === 'objective' ? '小题' : '测试点'}数量：{items.length}</strong><strong>总分：{formatScore(total)} 分</strong><span>每项 1～100 整数分，总分直接求和，不自动缩放。</span></div>{fieldError('total')}
            {draft.kind === 'objective' ? <>
              {draft.questions.map((q, index) => <section className={`card ${styles.item}`} key={q.id}>
                <div className={styles.itemHeader}><h3>小题 {index + 1} · {questionKindLabel[q.kind]}</h3><div className={styles.actions}><button type="button" className="button secondary" aria-label={`上移小题 ${index + 1}`} disabled={!index} onClick={() => moveQuestion(index, -1)}><ArrowUp size={15} /></button><button type="button" className="button secondary" aria-label={`下移小题 ${index + 1}`} disabled={index === draft.questions.length - 1} onClick={() => moveQuestion(index, 1)}><ArrowDown size={15} /></button><button className="button secondary" onClick={() => { if (window.confirm(`确定删除小题 ${index + 1}？`)) { setDraft({ ...draft, questions: draft.questions.filter(item => item.id !== q.id) }); setIssues([]); } }}><Trash2 size={15} />删除</button></div></div>
                <label className={styles.score}>小题分值<input type="number" min={1} max={100} step={1} value={q.score} onChange={event => updateQuestion(q.id, { score: Number(event.target.value) })} /></label>{fieldError(`questions.${index}.score`)}
                {q.kind === 'multiple' ? <label className={styles.score}>多选计分<select value={q.partialCredit === false ? 'all' : 'partial'} onChange={event => updateQuestion(q.id, { partialCredit: event.target.value === 'partial' })}><option value="partial">有部分分</option><option value="all">无部分分</option></select>{fieldError(`questions.${index}.partialCredit`)}</label> : null}
                <div className={styles.field}><span>题目描述</span><MarkdownComposer value={q.content} maxLength={AUTHORING_LIMITS.text} onChange={content => updateQuestion(q.id, { content })} disabled={locked} rows={5} />{fieldError(`questions.${index}.content`)}</div>
                {q.kind === 'single' || q.kind === 'multiple' ? <div className={styles.options}>{q.options.map((option, j) => <div className={styles.option} key={option.id}><div className={styles.optionHeader}><label><input type={q.kind === 'single' ? 'radio' : 'checkbox'} name={`standard-${q.id}`} checked={q.answers.includes(option.id)} onChange={() => updateQuestion(q.id, { answers: q.kind === 'single' ? [option.id] : q.answers.includes(option.id) ? q.answers.filter(answer => answer !== option.id) : [...q.answers, option.id] })} /><strong>选项 {String.fromCharCode(65 + j)}</strong> · 标准答案</label><button type="button" className="button secondary" disabled={q.options.length <= 2} onClick={() => { updateQuestion(q.id, { options: q.options.filter(o => o.id !== option.id), answers: q.answers.filter(answer => answer !== option.id) }); setIssues([]); }}><Trash2 size={14} />删除选项</button></div><MarkdownComposer rows={3} value={option.content} maxLength={AUTHORING_LIMITS.optionText} disabled={locked} onChange={content => updateQuestion(q.id, { options: q.options.map(o => o.id === option.id ? { ...o, content } : o) })} />{fieldError(`questions.${index}.options.${j}`)}</div>)}<button className="button secondary" disabled={q.options.length >= AUTHORING_LIMITS.options} onClick={() => updateQuestion(q.id, { options: [...q.options, { id: id(), content: '' }] })}><Plus size={15} />添加选项</button>{fieldError(`questions.${index}.answers`)}</div>
                  : q.kind === 'boolean' ? <label className={styles.field}>标准答案<select value={q.answers[0] || ''} onChange={event => updateQuestion(q.id, { answers: event.target.value ? [event.target.value] : [] })}><option value="">请选择</option><option value="true">正确</option><option value="false">错误</option></select>{fieldError(`questions.${index}.answers`)}</label>
                  : <label className={styles.field}>标准答案<input value={q.answerText} maxLength={2000} onChange={event => updateQuestion(q.id, { answerText: event.target.value })} placeholder="单行精确匹配答案；不填写正则表达式" />{fieldError(`questions.${index}.answerText`)}</label>}
                <details className={styles.singlePreview}><summary>预览本小题（不显示标准答案）</summary><ObjectivePreview content={objectiveQuestionMarkdown(q, index)} /></details>
              </section>)}
              {fieldError('questions')}
              <div><button className="button secondary" disabled={draft.questions.length >= AUTHORING_LIMITS.items} onClick={() => setAdding(!adding)}><Plus size={16} />添加题型</button>{adding ? <div className={styles.addMenu}>{(['multiple', 'single', 'boolean', 'fill'] as const).map(kind => <button className="button secondary" key={kind} onClick={() => { setDraft({ ...draft, questions: [...draft.questions, newQuestion(kind)] }); setAdding(false); }}>{questionKindLabel[kind]}</button>)}</div> : null}</div>
            </> : <>
              <div className={styles.field}><span>题目描述</span><MarkdownComposer value={draft.content} maxLength={AUTHORING_LIMITS.text} disabled={locked} rows={15} onChange={content => setDraft({ ...draft, content })} />{fieldError('content')}<small>公开样例请写入题面，例如成对的 input1／output1 代码块；后台测试点不会自动添加到题面。</small></div>
              <div className={styles.parameters}><label>时间限制（ms）<input type="number" min={1} max={60000} value={draft.timeMs} onChange={event => setDraft({ ...draft, timeMs: Number(event.target.value) })} />{fieldError('timeMs')}</label><label>内存限制（MiB）<input type="number" min={1} max={4096} value={draft.memoryMb} onChange={event => setDraft({ ...draft, memoryMb: Number(event.target.value) })} />{fieldError('memoryMb')}</label></div>
              <section className={styles.tests}><div className={styles.itemHeader}><h3>后台测试数据</h3><button className="button secondary" disabled={draft.tests.length >= AUTHORING_LIMITS.items} onClick={() => openTest()}><Plus size={15} />添加测试点</button></div><p className={styles.note}>每个测试点对应一个独立子任务，单独计分并求和。采用当前 Hydro 默认比较器。测试数据及预期输出仅供管理者查看，不作为公开样例。空格、空行和缩进按原内容保存。</p>
                {draft.tests.map((test, i) => <div className={styles.testRow} key={test.id}><strong>测试点 {i + 1}</strong><span>{formatScore(test.score)} 分</span><span>输入 {test.input.length} 字符／输出 {test.output.length} 字符</span><button className="button secondary" onClick={() => openTest(test)}>编辑</button><button className="button secondary" onClick={() => { if (window.confirm(`确定删除测试点 ${i + 1}？`)) { setDraft({ ...draft, tests: draft.tests.filter(t => t.id !== test.id) }); setIssues([]); } }}><Trash2 size={14} />删除</button>{fieldError(`tests.${i}`)}</div>)}{!draft.tests.length ? <p className="muted">尚未添加测试点</p> : null}{fieldError('tests')}
              </section>
            </>}
          </fieldset>
          <div className={styles.previewActions}><button className="button secondary" onClick={() => setPreview(!preview)}>{preview ? '收起最终预览' : draft.kind === 'objective' ? '预览整个题组' : '预览最终题面'}</button></div>
          {preview ? <section className={`card ${styles.fullPreview}`}><h3>答题者看到的内容</h3><h2>{draft.title || '未命名题目'}</h2>{draft.kind === 'objective' ? <ObjectivePreview content={previewContent} /> : <HydroProblemStatement content={previewContent} html={false} problemId="preview" />}</section> : null}
          {frozen && !busy ? <p className={styles.note}>本次创建已进入保存阶段，内容已固定。失败时会保留输入和恢复进度，请点击“继续保存”；重试沿用同一编号。</p> : null}
          {error ? <p className={styles.error} role="alert">{error}</p> : null}
          <footer className={styles.footer}><span role="status">{busy ? progress || '正在创建并保存…' : '最多 200 个小题／测试点，全部内容合计不超过 6 MiB'}</span><button className="button secondary" disabled={busy} onClick={close}>关闭</button><button className="button" disabled={busy} onClick={() => void save()}>{busy ? <LoaderCircle className="spin" size={16} /> : null}{busy ? '保存中…' : frozen ? '继续保存' : '创建并保存'}</button></footer>
        </>}
      {testDraft && draft?.kind === 'programming' ? <div className={styles.testBackdrop} role="presentation"><section ref={testDialog} tabIndex={-1} className={`card ${styles.testDialog}`} role="dialog" aria-modal="true" aria-labelledby="test-point-title"><div className={styles.itemHeader}><h3 id="test-point-title">{draft.tests.some(t => t.id === testDraft.id) ? `编辑测试点 ${draft.tests.findIndex(t => t.id === testDraft.id) + 1}` : `添加测试点 ${draft.tests.length + 1}`}</h3><button className="icon-button" aria-label="关闭测试点编辑" onClick={closeTest}><X size={18} /></button></div>
        {(['input', 'output'] as const).map(key => { const flag = key === 'input' ? 'emptyInput' : 'emptyOutput'; return <div className={styles.field} key={key}><label>{key === 'input' ? '输入数据' : '预期输出'}<textarea rows={7} value={testDraft[key]} maxLength={AUTHORING_LIMITS.testText} disabled={testDraft[flag]} spellCheck={false} onChange={event => setTestDraft({ ...testDraft, [key]: event.target.value })} /></label><label className={styles.emptyConfirm}><input type="checkbox" checked={testDraft[flag]} onChange={event => { if (event.target.checked && testDraft[key] !== '' && !window.confirm('确认使用空内容会清除此字段已填写的数据，是否继续？')) return; setTestDraft({ ...testDraft, [flag]: event.target.checked, ...(event.target.checked ? { [key]: '' } : {}) }); }} />明确使用空{key === 'input' ? '输入' : '输出'}（0 字节）</label>{fieldError(`tests.0.${key}`, testIssues)}</div>; })}
        <label className={styles.score}>测试点分值<input type="number" min={1} max={100} step={1} value={testDraft.score} onChange={event => setTestDraft({ ...testDraft, score: Number(event.target.value) })} /></label>{fieldError('tests.0.score', testIssues)}<div className={styles.actions}><button className="button secondary" onClick={closeTest}>取消</button><button className="button" onClick={saveTest}>保存测试点</button></div>
      </section></div> : null}
    </section>
  </div>, document.body);
}
