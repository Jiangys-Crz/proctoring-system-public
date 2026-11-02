'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, Bold, Code, Heading2, List, LoaderCircle, Save } from 'lucide-react';
import { MarkdownContent } from './MarkdownComposer';
import { groupJudgeLanguages, type HydroLanguage } from '@/lib/exam-languages';
import { toDatetimeLocalValue } from '@/lib/datetime-local';
import { ExamSearchSelect, type SearchOption } from './ExamSearchSelect';
import { normalizeContestFormat } from '@/lib/contest-format';
import { TeamSubmissionViewSetting } from './TeamSubmissionViewSetting';

export type Rule = 'GPLT' | 'XCPC' | 'LANQIAO' | 'ACM' | 'OI' | 'IOI' | 'KS';
export const examRuleLabels: Record<Exclude<Rule, 'ACM'>, string> = { GPLT: 'GPLT', XCPC: 'XCPC', LANQIAO: 'LANQIAO', OI: 'OI', IOI: 'IOI', KS: 'KS' };
const isXcpc = (rule: Rule) => rule === 'XCPC' || rule === 'ACM';
type PrintMode = 'DISABLED' | 'VIRTUAL' | 'PHYSICAL';
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.message || '操作失败，请重试');
  return body.data;
}
const initialForm = { platform: 'HYDRO' as 'HYDRO' | 'NOVAJUDGE', platformBaseUrl: '', platformContestId: '', novaJudgeApiKey: '', novaJudgeTimezone: 'Asia/Shanghai', novaJudgeApiKeyConfigured: false, name: '', contestRule: 'IOI' as Rule, startDate: '', startTime: '', durationMinutes: 120, latestStartAt: '', freezeMinutes: 0, rules: '', allowedLanguages: [] as string[], showTestCaseCount: false, showObjectiveScore: false, allowPrint: false, printMode: 'DISABLED' as PrintMode, allowTeamSubmissionView: false, leaderOnlySubmission: false, contestType: 'INDIVIDUAL' as 'INDIVIDUAL' | 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS' as 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT', requireMiniProgram: true, requireFrontCamera: true, saveFullRecording: false, saveIncidentRecording: false };
type ExamData = {
  platform: 'HYDRO' | 'NOVAJUDGE'; platformBaseUrl: string; platformContestId: string; novaJudgeTimezone: string; novaJudgeApiKeyConfigured?: boolean;
  examCode: string; name: string; contestRule: Rule; startAt: string; latestStartAt: string; durationMinutes: number; flexible: boolean;
  freezeMinutes: number | null; scoreboardFrozenAt: string | null; endAt: string; rules: string;
  allowedLanguages: string[]; showTestCaseCount: boolean; showObjectiveScore: boolean; allowPrint: boolean; printMode: PrintMode; allowTeamSubmissionView: boolean; leaderOnlySubmission: boolean;
  contestType: 'INDIVIDUAL' | 'TEAM'; teamAccountMode: 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT'; requireMiniProgram: boolean; requireFrontCamera: boolean; saveFullRecording: boolean; saveIncidentRecording: boolean;
  problems: Array<{ hydroProblemId: string; title: string }>;
  administrators: Array<{ user: { id: string; username: string | null; realName: string | null; numberId: string | null } }>;
};
export function ExamEditor({ examId }: { examId?: string }) {
  const router = useRouter();
  const [examCode, setExamCode] = useState('');
  const [form, setForm] = useState(initialForm);
  const nova = form.platform === 'NOVAJUDGE';
  const [availableLanguages, setAvailableLanguages] = useState<HydroLanguage[]>([]);
  const [languageError, setLanguageError] = useState('');
  useEffect(() => {
    if (nova) return;
    const controller = new AbortController();
    request<HydroLanguage[]>('/api/hydro/languages', { signal: controller.signal })
      .then(setAvailableLanguages).catch(err => { if (!controller.signal.aborted) setLanguageError(err.message); });
    return () => controller.abort();
  }, [nova]);
  const languageOptions = groupJudgeLanguages(availableLanguages);
  for (const id of form.allowedLanguages) if (!languageOptions.some(item => item.id === id)) languageOptions.push({ id, name: `${id}（当前不可用）`, versions: [] });
  const [problems, setProblems] = useState<SearchOption[]>([]);
  const [admins, setAdmins] = useState<SearchOption[]>([]);
  const [loading, setLoading] = useState(Boolean(examId));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  useEffect(() => {
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, []);
  useEffect(() => {
    if (!examId) return;
    const controller = new AbortController();
    void request<ExamData>(`/api/exams/${examId}`, { signal: controller.signal }).then(exam => {
      setExamCode(exam.examCode);
      const start = toDatetimeLocalValue(exam.startAt).split('T');
      const printMode = exam.printMode === 'DISABLED' && exam.allowPrint ? 'PHYSICAL' : exam.printMode;
      setForm({ platform: exam.platform, platformBaseUrl: exam.platformBaseUrl, platformContestId: exam.platformContestId, novaJudgeApiKey: '', novaJudgeTimezone: exam.novaJudgeTimezone || 'Asia/Shanghai', novaJudgeApiKeyConfigured: exam.novaJudgeApiKeyConfigured ?? false, name: exam.name, contestRule: exam.contestRule === 'ACM' ? 'XCPC' : exam.contestRule, startDate: start[0], startTime: start[1], durationMinutes: exam.durationMinutes,
        latestStartAt: exam.flexible ? toDatetimeLocalValue(exam.latestStartAt) : '',
        freezeMinutes: exam.freezeMinutes ?? (exam.scoreboardFrozenAt ? Math.max(0, Math.round((+new Date(exam.endAt) - +new Date(exam.scoreboardFrozenAt)) / 60_000)) : 0),
        rules: exam.rules, allowedLanguages: exam.allowedLanguages || [], showTestCaseCount: exam.showTestCaseCount, showObjectiveScore: exam.showObjectiveScore, allowPrint: printMode !== 'DISABLED', printMode, allowTeamSubmissionView: exam.allowTeamSubmissionView, leaderOnlySubmission: exam.leaderOnlySubmission,
        contestType: exam.contestType, teamAccountMode: exam.teamAccountMode || 'MEMBER_ACCOUNTS', requireMiniProgram: exam.requireMiniProgram, requireFrontCamera: exam.requireFrontCamera, saveFullRecording: exam.saveFullRecording ?? false, saveIncidentRecording: exam.saveIncidentRecording ?? false });
      setProblems(exam.problems.map(problem => ({ id: problem.hydroProblemId, label: `${problem.hydroProblemId} · ${problem.title}` })));
      setAdmins(exam.administrators.map(({ user }) => ({ id: user.id, label: user.realName || user.username || user.numberId || user.id, description: [user.username, user.numberId].filter(Boolean).join(' · ') })));
    }).catch(err => { if (!controller.signal.aborted) { setError(err.message); setLoadFailed(true); } }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [examId]);
  const searchProblems = useCallback(async (query: string, signal: AbortSignal) => {
    const data = await request<Array<{ id: string; pid: string; title: string }>>('/api/hydro/problems', { method: 'POST', signal, body: JSON.stringify({ query, examId }) });
    return data.map(problem => ({ id: String(problem.id), label: `${problem.pid || problem.id} · ${problem.title}` }));
  }, [examId]);
  const searchUsers = useCallback(async (query: string, signal: AbortSignal) => {
    const data = await request<Array<{ id: string; username: string | null; realName: string | null; numberId: string | null }>>(`/api/exams/users?${new URLSearchParams({ query, ...(examId ? { examId } : {}) })}`, { signal });
    return data.map(user => ({ id: user.id, label: user.realName || user.username || user.numberId || user.id, description: [user.username, user.numberId].filter(Boolean).join(' · ') }));
  }, [examId]);
  const start = new Date(`${form.startDate}T${form.startTime}`);
  const flexible = !nova && !isXcpc(form.contestRule) && Boolean(form.latestStartAt);
  const latest = flexible ? new Date(form.latestStartAt) : start;
  const earliestEnd = new Date(+start + form.durationMinutes * 60_000);
  const latestEnd = new Date(+latest + form.durationMinutes * 60_000);
  const validTime = Number.isFinite(+earliestEnd) && Number.isFinite(+latestEnd) && form.durationMinutes > 0 && latest >= start;
  const timeText = (date: Date) => date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  function insertMarkdown(before: string, after = '') {
    const field = editor.current;
    const from = field?.selectionStart ?? form.rules.length;
    const to = field?.selectionEnd ?? from;
    setForm(current => ({ ...current, rules: current.rules.slice(0, from) + before + (current.rules.slice(from, to) || '文字') + after + current.rules.slice(to) }));
    requestAnimationFrame(() => editor.current?.focus());
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current) return;
    setError('');
    let message = '';
    if (!form.name.trim()) message = '请输入考试标题';
    else if (!validTime) message = '请检查开始时间、考试时长和最晚开始时间';
    else if (nova && (!form.platformBaseUrl.trim() || !/^[1-9]\d*$/.test(form.platformContestId))) message = '请填写有效的 NovaJudge 平台域名和比赛 ID';
    else if (nova && !form.novaJudgeApiKey.trim() && !form.novaJudgeApiKeyConfigured) message = '请填写 NovaJudge 外榜 API Key';
    else if (!nova && isXcpc(form.contestRule) && form.freezeMinutes >= form.durationMinutes) message = '封榜分钟数必须小于考试时长';
    else if (!nova && !problems.length) message = '请至少选择一道题目';
    if (message) { setError(message); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    savingRef.current = true; setSaving(true);
    try {
      await request(`/api/exams${examId ? `/${examId}` : ''}`, {
        method: examId ? 'PATCH' : 'POST',
        body: JSON.stringify({ name: form.name.trim(), contestRule: form.contestRule,
          startAt: start.toISOString(), latestStartAt: latest.toISOString(), endAt: latestEnd.toISOString(), durationMinutes: form.durationMinutes, flexible,
          freezeMinutes: nova ? 0 : isXcpc(form.contestRule) ? form.freezeMinutes : null, platform: form.platform,
          ...(nova ? { platformBaseUrl: form.platformBaseUrl.trim(), platformContestId: form.platformContestId, novaJudgeTimezone: form.novaJudgeTimezone, ...(form.novaJudgeApiKey.trim() ? { novaJudgeApiKey: form.novaJudgeApiKey.trim() } : {}) } : {}), contestType: form.contestType, teamAccountMode: form.teamAccountMode,
          rules: form.rules, ...(nova ? {} : { problemIds: problems.map(problem => problem.id) }), administratorIds: admins.map(user => user.id),
          allowedLanguages: form.allowedLanguages, showTestCaseCount: form.showTestCaseCount, showObjectiveScore: form.showObjectiveScore, allowPrint: form.printMode !== 'DISABLED', printMode: form.printMode, allowTeamSubmissionView: form.allowTeamSubmissionView, leaderOnlySubmission: form.leaderOnlySubmission,
          requireMiniProgram: form.requireMiniProgram, requireFrontCamera: form.requireFrontCamera, saveFullRecording: form.saveFullRecording, saveIncidentRecording: form.saveIncidentRecording })
      });
      router.push('/dashboard/exams'); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally { savingRef.current = false; setSaving(false); }
  }
  return <div className="exam-editor-page">
    <header className="exam-editor-header">
      <div className="return-only-row"><Link href={examId ? `/dashboard/exams/${examId}` : '/dashboard/exams'} className="exam-back"><ArrowLeft size={18} /> {examId ? '返回考试详情' : '返回考试列表'}</Link></div>
      <div className="exam-editor-title-row"><h1>{examId ? '编辑考试' : '发布考试'}</h1><button className="button" type="submit" form="exam-editor-form" disabled={saving || loading || loadFailed}>{saving ? <LoaderCircle size={17} className="spin" /> : <Save size={17} />}{saving ? '保存中…' : '保存考试'}</button></div>
    </header>
    <form id="exam-editor-form" className="exam-editor-form" onSubmit={save}>
      <nav className="exam-editor-subnav" aria-label="考试编辑章节"><a href="#exam-information">考试信息</a>{nova ? <a href="#exam-novajudge">NovaJudge 接入</a> : <a href="#exam-problems">题目选择</a>}<a href="#exam-description">考试说明</a><a href="#exam-permissions">权限控制</a><a href="#exam-settings">考试设置</a></nav>
      {error ? <div ref={errorRef} tabIndex={-1} className="exam-editor-error" role="alert">{error}</div> : null}
      {loading ? <div className="problem-loading"><LoaderCircle className="spin" size={20} /> 正在加载考试…</div> : <fieldset disabled={saving || loadFailed} className="exam-editor-fields">
        <section id="exam-information" className="exam-editor-section"><div className="exam-section-title"><h2>考试信息</h2><p>设置比赛规则与考试时间。</p></div><div className="exam-section-body">
          <label>考试类型<select aria-label="考试类型" value={form.platform} disabled={Boolean(examId)} onChange={event => setForm({ ...form, platform: event.target.value as 'HYDRO' | 'NOVAJUDGE', ...(event.target.value === 'NOVAJUDGE' ? { contestRule: 'XCPC', latestStartAt: '', freezeMinutes: 0 } : {}) })}><option value="HYDRO">本平台答题（Hydro 评测）</option><option value="NOVAJUDGE">NovaJudge（监考与浏览器）</option></select></label>
          <div className="exam-time-preview"><span>考试编号</span><strong>{examCode || (form.startDate ? `${form.startDate.replaceAll('-', '')}XX（保存后自动生成）` : '保存后自动生成 10 位唯一编号')}</strong><small>考试日期＋两位序号；生成后保持不变，用于与考生考号匹配。</small></div><div className="exam-form-columns"><label hidden={nova}>赛制<select aria-label="规则" value={form.contestRule} onChange={event => { const rule = event.target.value as Rule; setForm(normalizeContestFormat({ ...form, contestRule: rule })); }}>{Object.entries(examRuleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>比赛类型<select aria-label="比赛类型" value={form.contestType} disabled={form.contestRule === 'GPLT'} onChange={event => { const contestType = event.target.value as 'INDIVIDUAL' | 'TEAM'; setForm(normalizeContestFormat({ ...form, contestType })); }}><option value="INDIVIDUAL">个人赛</option><option value="TEAM">团队赛</option></select></label>{form.contestType === 'TEAM' ? <label>团队账号方式<select aria-label="团队账号方式" value={form.teamAccountMode} disabled={form.contestRule === 'GPLT'} onChange={event => { const teamAccountMode = event.target.value as 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT'; setForm(normalizeContestFormat({ ...form, teamAccountMode })); }}><option value="MEMBER_ACCOUNTS">每个成员一个账号</option><option value="TEAM_ACCOUNT">一个队伍一个账号</option></select></label> : null}</div>
          <p hidden={nova} className="exam-field-help">{form.contestRule === 'GPLT' ? 'GPLT：团队报名、成员独立账号与提交记录，同时生成按组别的个人榜和团队榜。' : isXcpc(form.contestRule) ? 'XCPC：可选个人赛或团队赛；团队多账号模式仅队长可提交，可在考试设置中配置同队提交共享。' : '提交默认仅本人可见，团队赛可在考试设置中开启同队共享。'}</p>
          <label>标题<input required maxLength={200} placeholder="输入考试名称" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
          <div className="exam-form-columns"><label>开始日期<input required type="date" value={form.startDate} onChange={event => setForm({ ...form, startDate: event.target.value })} /></label><label>开始时间<input required type="time" value={form.startTime} onChange={event => setForm({ ...form, startTime: event.target.value })} /></label><label>考试时长（分钟）<input required type="number" min={1} max={525600} step={1} value={form.durationMinutes || ''} onChange={event => setForm({ ...form, durationMinutes: Number(event.target.value) })} /></label></div>
          {nova ? <p className="exam-field-help">统一开始和结束；题目、判题、封榜与提交权限在 NovaJudge 中设置，请保持两边比赛时间一致。</p> : isXcpc(form.contestRule) ? <label>封榜时间（剩余分钟数）<input type="number" required min={0} max={Math.max(0, form.durationMinutes - 1)} step={1} value={form.freezeMinutes} onChange={event => setForm({ ...form, freezeMinutes: Number(event.target.value) })} /><small className="exam-field-help">距离比赛结束还有多少分钟时封榜，填写 0 表示不封榜。</small></label> : <label>最晚开始时间 <span className="exam-optional">可选</span><input type="datetime-local" min={form.startDate && form.startTime ? `${form.startDate}T${form.startTime}` : undefined} value={form.latestStartAt} onChange={event => setForm({ ...form, latestStartAt: event.target.value })} /><small className="exam-field-help">留空则统一计时、统一结束；未开始的考生仅可在开考后 15 分钟内登录并确认开始。设置后才启用灵活开考。</small></label>}
          <div className="exam-time-preview" aria-live="polite"><span>结束时间{flexible ? '范围' : ''}</span><strong>{validTime ? `${timeText(earliestEnd)}${flexible && +latest > +start ? ` — ${timeText(latestEnd)}` : ''}` : '填写有效的开始时间和考试时长后自动计算'}</strong>{validTime && isXcpc(form.contestRule) && form.freezeMinutes > 0 && form.freezeMinutes < form.durationMinutes ? <small>封榜时间：{timeText(new Date(+latestEnd - form.freezeMinutes * 60_000))}</small> : null}</div>
        </div></section>
        {nova ? <section id="exam-novajudge" className="exam-editor-section"><div className="exam-section-title"><h2>NovaJudge 接入</h2><p>自动登录指定比赛，浏览器仅允许本比赛页面与平台内的文件下载。</p></div><div className="exam-section-body">
          <label>NovaJudge 平台域名<input required placeholder="https://judge.example.org" maxLength={512} value={form.platformBaseUrl} onChange={event => setForm({ ...form, platformBaseUrl: event.target.value })} /></label>
          <label>NovaJudge 比赛 ID<input required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="例如 1" value={form.platformContestId} onChange={event => setForm({ ...form, platformContestId: event.target.value })} /></label>
          <label>NovaJudge 外榜 API Key<input required={!form.novaJudgeApiKeyConfigured} type="password" autoComplete="new-password" maxLength={2000} placeholder={form.novaJudgeApiKeyConfigured ? '已配置，留空保留原密钥' : 'NovaJudge 后台创建并启用的 API Key'} value={form.novaJudgeApiKey} onChange={event => setForm({ ...form, novaJudgeApiKey: event.target.value })} /></label>
          <label>NovaJudge 数据时区<select value={form.novaJudgeTimezone} onChange={event => setForm({ ...form, novaJudgeTimezone: event.target.value })}><option value="Asia/Shanghai">中国标准时间（Asia/Shanghai）</option><option value="UTC">UTC</option><option value="America/Vancouver">温哥华（NovaJudge 原始 Docker 默认）</option>{!['Asia/Shanghai', 'UTC', 'America/Vancouver'].includes(form.novaJudgeTimezone) ? <option value={form.novaJudgeTimezone}>{form.novaJudgeTimezone}</option> : null}</select><small className="exam-field-help">须与 NovaJudge 服务的 TZ 时区一致，用于正确推送提交时间。</small></label>
          <p className="exam-field-help">导入的考号、密码须与此比赛中的 NovaJudge 选手账号完全一致。外榜推送目标与开关在考试管理的“外榜推送”中设置。</p>
        </div></section> : <section id="exam-problems" className="exam-editor-section"><div className="exam-section-title"><h2>题目选择</h2><p>按题目编号或名称搜索。</p></div><div className="exam-section-body"><ExamSearchSelect label="考试题目" placeholder="输入题目编号或名称" value={problems} onChange={setProblems} search={searchProblems} /></div></section>}
        <section id="exam-description" className="exam-editor-section"><div className="exam-section-title"><h2>考试说明</h2><p>使用 Markdown 编辑考试须知，右侧同步显示最终效果。</p></div><div className="exam-markdown-editor"><div className="exam-markdown-toolbar"><div><strong>Markdown 编辑</strong></div><div><button type="button" aria-label="插入标题" onClick={() => insertMarkdown('## ')}><Heading2 size={16} /></button><button type="button" aria-label="插入粗体" onClick={() => insertMarkdown('**', '**')}><Bold size={16} /></button><button type="button" aria-label="插入列表" onClick={() => insertMarkdown('- ')}><List size={16} /></button><button type="button" aria-label="插入代码" onClick={() => insertMarkdown('`', '`')}><Code size={16} /></button></div></div><div className="exam-markdown-live"><textarea ref={editor} aria-label="考试说明 Markdown" rows={12} placeholder={'## 考试说明\n\n请在这里填写比赛规则、注意事项和其他说明。'} value={form.rules} onChange={event => setForm({ ...form, rules: event.target.value })} /><div className="exam-markdown-preview hydro-markdown" aria-label="考试说明预览" aria-live="polite"><MarkdownContent content={form.rules} /></div></div></div></section>
        <section id="exam-permissions" className="exam-editor-section"><div className="exam-section-title"><h2>权限控制</h2><p>指定可以编辑本场考试的管理员。</p></div><div className="exam-section-body"><ExamSearchSelect label="比赛管理员" placeholder="输入用户名、姓名或学号" value={admins} onChange={setAdmins} search={searchUsers} /></div></section>
        <section id="exam-settings" className="exam-editor-section"><div className="exam-section-title"><h2>考试设置</h2><p>{nova ? '设置监考录像保存。答题设置由 NovaJudge 管理。' : '控制提交语言、成绩展示和团队权限。'}</p></div><div className="exam-section-body"><label className="exam-checkbox"><input type="checkbox" checked={form.saveFullRecording} onChange={event => setForm({ ...form, saveFullRecording: event.target.checked })} /> 保存完整考试录像</label><label className="exam-checkbox"><input type="checkbox" checked={form.saveIncidentRecording} onChange={event => setForm({ ...form, saveIncidentRecording: event.target.checked })} /> 保存异常前后各 20 秒录像</label><p className="exam-field-help">录像保存默认均不勾选。仅勾选异常录像时保存对应机位前后各 20 秒；勾选完整录像时保存完整监考过程。直播画质保持 1080p、30 帧。</p><label className="exam-checkbox"><input type="checkbox" checked={form.requireMiniProgram} onChange={event => setForm({ ...form, requireMiniProgram: event.target.checked })} /> 需要手机第二机位</label><label className="exam-checkbox"><input type="checkbox" checked={form.requireFrontCamera} onChange={event => setForm({ ...form, requireFrontCamera: event.target.checked })} /> 需要电脑前置摄像头</label><div hidden={nova}><div><span className="exam-field-label">提交语言限制</span><div className="exam-language-options">{languageOptions.map(language => <label key={language.id}><input type="checkbox" checked={form.allowedLanguages.includes(language.id)} onChange={event => setForm({ ...form, allowedLanguages: event.target.checked ? [...form.allowedLanguages, language.id] : form.allowedLanguages.filter(id => id !== language.id) })} />{language.name}</label>)}</div>{languageError ? <p className="problem-error">语言列表读取失败：{languageError}</p> : null}<p className="exam-field-help">按评测服务实际可用的语言族限制；考生端只显示实际可用且符合题目限制的具体版本。留空则不限制语言族。</p></div><label className="exam-checkbox"><input type="checkbox" checked={form.contestRule === 'KS' || form.showTestCaseCount} disabled={form.contestRule === 'KS'} onChange={event => setForm({ ...form, showTestCaseCount: event.target.checked })} /> 展示通过测试点数目{form.contestRule === 'KS' ? '（KS 赛制固定开启）' : ''}</label><label className="exam-checkbox"><input type="checkbox" checked={form.contestRule !== 'KS' && form.showObjectiveScore} disabled={form.contestRule === 'KS'} onChange={event => setForm({ ...form, showObjectiveScore: event.target.checked })} /> 展示客观题成绩{form.contestRule === 'KS' ? '（KS 客观题实时判题，考生端仅显示已提交）' : ''}</label><label>打印方式<select value={form.printMode} onChange={event => { const printMode = event.target.value as PrintMode; setForm({ ...form, printMode, allowPrint: printMode !== 'DISABLED' }); }}><option value="DISABLED">不允许打印</option><option value="VIRTUAL">虚拟打印（仅保存电子记录）</option><option value="PHYSICAL">真实打印（进入后台打印队列）</option></select><small className="exam-field-help">虚拟打印只保存考生提交的内容；真实打印会交由监考后台审核并连接实体打印流程。</small></label>{form.contestType === 'TEAM' ? <label className="exam-checkbox"><input type="checkbox" checked={form.leaderOnlySubmission} onChange={event => setForm({ ...form, leaderOnlySubmission: event.target.checked })} /> 只有队长可以提交</label> : null}<TeamSubmissionViewSetting contestType={form.contestType} teamAccountMode={form.teamAccountMode} enabled={form.allowTeamSubmissionView} onChange={enabled => setForm({ ...form, allowTeamSubmissionView: enabled })} /></div></div></section>
      </fieldset>}
    </form>
  </div>;
}
