'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Bell, Eye, EyeOff, LoaderCircle, MessageCircleQuestion, RefreshCw, Send } from 'lucide-react';
import { api } from './api';
import { MarkdownComposer, MarkdownContent } from './MarkdownComposer';

type Person = { id: string; realName: string | null; nickname: string | null; username: string | null };
type Question = {
  id: string; content: string; answer: string | null; answeredAt: string | null; createdAt: string;
  isPublished: boolean; messages: Array<{ id: string; sender: 'CANDIDATE' | 'ADMIN'; content: string; createdAt: string; createdBy: Person | null }>;
  problemPid: string | null; problemIndex: string | null; problemTitle: string | null;
  candidate: { id: string; examNumber: string; name: string | null; teamName: string | null; seatNo: string };
  answeredBy: Person | null;
};
type Candidate = { id: string; examNumber: string; name: string | null; teamName: string | null; seatNo: string };
type Announcement = { id: string; content: string; createdAt: string; createdBy: Person | null; candidateId: string | null; candidate: Pick<Candidate, 'id' | 'examNumber' | 'name' | 'teamName'> | null };
type QAData = { questions: Question[]; announcements: Announcement[]; candidates: Candidate[] };

function personName(person: Person | null) {
  return person?.realName || person?.nickname || person?.username || '监考老师';
}

export function ExamQAPanel({ examId, canManage = false }: { examId: string; canManage?: boolean }) {
  const [data, setData] = useState<QAData>({ questions: [], announcements: [], candidates: [] });
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [announcement, setAnnouncement] = useState('');
  const [announcementTarget, setAnnouncementTarget] = useState('');
  const [busy, setBusy] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      setData(await api<QAData>(`/api/exams/${examId}/qa`));
      setError('');
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '赛时答疑加载失败');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [examId]);
  useEffect(() => {
    void load();
    const timer = window.setInterval(() => void load(true), 4000);
    return () => window.clearInterval(timer);
  }, [load]);
  const pending = useMemo(() => data.questions.filter(question => !question.messages.length ? !question.answeredAt : question.messages.at(-1)?.sender === 'CANDIDATE').length, [data.questions]);

  async function publishAnnouncement() {
    const content = announcement.trim();
    if (!content) return;
    if (!canManage && !announcementTarget) return;
    setBusy('announcement');
    try {
      await api(`/api/exams/${examId}/qa`, { method: 'POST', body: JSON.stringify({ action: 'announce', content, candidateId: announcementTarget || null }) });
      setAnnouncement('');
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公告发布失败');
    } finally { setBusy(''); }
  }

  async function uploadImage(file: File) {
    const form = new FormData();
    form.append('file', file, file.name || 'qa-image.png');
    const result = await api<{ url: string }>(`/api/exams/${examId}/qa/image`, { method: 'POST', body: form });
    return result.url;
  }

  async function reply(questionId: string) {
    const content = (answers[questionId] || '').trim();
    if (!content) return;
    setBusy(`reply-${questionId}`);
    try {
      await api(`/api/exams/${examId}/qa`, { method: 'POST', body: JSON.stringify({ action: 'reply', questionId, content }) });
      setAnswers(current => ({ ...current, [questionId]: '' }));
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '回复失败');
    } finally { setBusy(''); }
  }

  async function setPublished(questionId: string, published: boolean) {
    setBusy(`publish-${questionId}`);
    try {
      await api(`/api/exams/${examId}/qa`, { method: 'POST', body: JSON.stringify({ action: 'publish', questionId, published }) });
      await load(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '公布状态修改失败');
    } finally { setBusy(''); }
  }

  return <div className="exam-qa-panel grid">
    <section className="card exam-announcement-compose">
      <div className="exam-panel-heading"><div><h2>发布公告</h2><p>{canManage ? '通过服务端实时推送，可发送给全体考生或指定考生。' : '通过服务端实时推送，可发送给负责考室的指定考生。'}</p></div><Bell size={21} /></div>
      <label className="exam-announcement-target">接收考生<select value={announcementTarget} onChange={event => setAnnouncementTarget(event.target.value)}><option value="">{canManage ? '全体考生' : '请选择负责考室的考生'}</option>{data.candidates.map(candidate => <option key={candidate.id} value={candidate.id}>{candidate.examNumber} · {candidate.teamName || candidate.name || '未命名考生'}{candidate.seatNo ? ` · ${candidate.seatNo}` : ''}</option>)}</select></label>
      <MarkdownComposer value={announcement} onChange={setAnnouncement} onUploadImage={uploadImage} placeholder="使用 Markdown 编写公告，可直接粘贴截图或图片" maxLength={10000} rows={6} />
      <div className="exam-qa-actions"><span>{announcementTarget ? '仅向指定考生推送' : canManage ? '向全体考生推送' : '请选择负责考室的考生'}</span><button className="button" onClick={() => void publishAnnouncement()} disabled={!announcement.trim() || (!canManage && !announcementTarget) || busy === 'announcement'}>{busy === 'announcement' ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}{busy === 'announcement' ? '发布中' : '发布公告'}</button></div>
    </section>
    {error ? <div className="exam-editor-error" role="alert">{error}</div> : null}
    <section className="card exam-qa-section">
      <div className="exam-panel-heading"><div><h2>考生提问</h2><p>待回复 {pending} 条，共 {data.questions.length} 条。</p></div><button className="button secondary compact-button" onClick={() => void load()} disabled={loading}><RefreshCw size={15} className={loading ? 'spin' : ''} />刷新</button></div>
      {data.questions.map(question => { const messages = question.messages.length ? question.messages : [{ id: `${question.id}-question`, sender: 'CANDIDATE' as const, content: question.content, createdAt: question.createdAt, createdBy: null }, ...(question.answer ? [{ id: `${question.id}-answer`, sender: 'ADMIN' as const, content: question.answer, createdAt: question.answeredAt || question.createdAt, createdBy: question.answeredBy }] : [])]; const waiting = messages.at(-1)?.sender === 'CANDIDATE'; return <article className={`exam-question-card ${waiting ? 'pending' : 'answered'} ${question.isPublished ? 'published' : ''}`} key={question.id}>
        <header><div><strong>{question.candidate.teamName || question.candidate.name || question.candidate.examNumber}</strong><span>考号 {question.candidate.examNumber} · 座位 {question.candidate.seatNo || '-'}</span></div><div className="exam-question-header-actions"><time>{new Date(question.createdAt).toLocaleString('zh-CN')}</time><button className="button secondary compact-button" onClick={() => void setPublished(question.id, !question.isPublished)} disabled={busy === `publish-${question.id}`}>{question.isPublished ? <EyeOff size={14} /> : <Eye size={14} />}{question.isPublished ? '取消公布' : '公布完整会话'}</button></div></header>
        {question.problemIndex ? <div className="exam-question-problem">题目 {question.problemIndex} · {question.problemTitle || question.problemPid}</div> : <div className="exam-question-problem">综合提问</div>}
        <div className="exam-question-thread">{messages.map(message => <div className={`exam-question-message ${message.sender === 'ADMIN' ? 'admin' : 'candidate'}`} key={message.id}><div><strong>{message.sender === 'ADMIN' ? personName(message.createdBy || question.answeredBy) : question.candidate.name || question.candidate.examNumber}</strong><time>{new Date(message.createdAt).toLocaleString('zh-CN')}</time></div><MarkdownContent content={message.content} /></div>)}</div>
        <div className="exam-question-reply markdown-reply"><MarkdownComposer value={answers[question.id] || ''} onChange={value => setAnswers(current => ({ ...current, [question.id]: value }))} onUploadImage={uploadImage} placeholder="继续回复该问题会话，可使用 Markdown 和粘贴图片" maxLength={10000} rows={4} /><button className="button" onClick={() => void reply(question.id)} disabled={!answers[question.id]?.trim() || busy === `reply-${question.id}`}>{busy === `reply-${question.id}` ? <LoaderCircle size={16} className="spin" /> : <Send size={16} />}发送回复</button></div>
      </article>; })}
      {!data.questions.length && !loading ? <div className="exam-qa-empty"><MessageCircleQuestion size={26} /><strong>暂无考生提问</strong><span>新问题会自动出现在这里。</span></div> : null}
      {loading && !data.questions.length ? <div className="problem-loading"><LoaderCircle size={18} className="spin" />正在加载答疑</div> : null}
    </section>
    <section className="card exam-qa-section">
      <div className="exam-panel-heading"><div><h2>已发布公告</h2><p>按发布时间倒序显示。</p></div><Bell size={20} /></div>
      {data.announcements.map(item => <article className="exam-announcement-card" key={item.id}><div className="exam-announcement-target-badge">{item.candidate ? `指定：${item.candidate.examNumber} · ${item.candidate.teamName || item.candidate.name || '未命名考生'}` : '全体考生'}</div><MarkdownContent content={item.content} /><span>{personName(item.createdBy)} · {new Date(item.createdAt).toLocaleString('zh-CN')}</span></article>)}
      {!data.announcements.length ? <div className="muted">暂无公告</div> : null}
    </section>
  </div>;
}
