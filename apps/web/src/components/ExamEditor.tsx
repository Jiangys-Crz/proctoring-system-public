'use client';

import { browserExamPlatformName, isBrowserExam, type ExamPlatform } from '@cwnupaa/proctor-shared';
import type { ReactionLogoMatchBy } from '@prisma/client';
import { HydroBrowserFields } from './HydroBrowserFields';
import { useRouter } from 'next/navigation';
import { applyMarkdownShortcut, markdownShortcutHelp } from '@cwnupaa/proctor-shared/markdown-shortcuts';
import { useCallback, useEffect, useRef, useState } from 'react';
import { LoaderCircle, Save } from 'lucide-react';
import { MarkdownContent, MarkdownFormatButtons } from './MarkdownComposer';
import { groupJudgeLanguages, type HydroLanguage } from '@/lib/exam-languages';
import { toDatetimeLocalValue } from '@/lib/datetime-local';
import { ExamSearchSelect, type SearchOption } from './ExamSearchSelect';
import { normalizeContestFormat } from '@/lib/contest-format';
import { TeamSubmissionViewSetting } from './TeamSubmissionViewSetting';
import { ExamFederationSettings } from './ExamFederationSettings';

export type Rule = 'GPLT' | 'XCPC' | 'LANQIAO' | 'ACM' | 'OI' | 'IOI' | 'KS';
export const examRuleLabels: Record<Exclude<Rule, 'ACM'>, string> = { LANQIAO: 'LANQIAO', GPLT: 'GPLT', XCPC: 'XCPC', IOI: 'IOI', OI: 'OI', KS: 'KS' };
const isXcpc = (rule: Rule) => rule === 'XCPC' || rule === 'ACM';
type PrintMode = 'DISABLED' | 'VIRTUAL' | 'PHYSICAL';
async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'content-type': 'application/json', ...init?.headers } });
  const body = await response.json();
  if (!response.ok || !body.ok) throw new Error(body.message || '操作失败，请重试');
  return body.data;
}
const initialForm = { platform: 'HYDRO' as ExamPlatform, platformBaseUrl: '', platformContestId: '', hydroBrowserApiKey: '', hydroBrowserApiKeyConfigured: false, hydroBrowserEventFeedApiKey: '', hydroBrowserEventFeedApiKeyConfigured: false, novaJudgeApiKey: '', novaJudgeTimezone: 'Asia/Shanghai', novaJudgeApiKeyConfigured: false, name: '', contestRule: 'IOI' as Rule, startDate: '', startTime: '', durationMinutes: 120, latestStartAt: '', freezeMinutes: 0, rules: '', allowedLanguages: [] as string[], showTestCaseCount: false, showObjectiveScore: false, allowPrint: false, printMode: 'DISABLED' as PrintMode, allowTeamSubmissionView: false, leaderOnlySubmission: false, contestType: 'INDIVIDUAL' as 'INDIVIDUAL' | 'TEAM', teamAccountMode: 'MEMBER_ACCOUNTS' as 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT', requireMiniProgram: true, requireFrontCamera: true, saveFullRecording: false, saveIncidentRecording: false, reactionLogoMatchBy: 'SCHOOL' as ReactionLogoMatchBy };
type ExamData = {
  platform: ExamPlatform; platformBaseUrl: string; platformContestId: string; novaJudgeTimezone: string; novaJudgeApiKeyConfigured?: boolean; hydroBrowserApiKeyConfigured?: boolean; hydroBrowserEventFeedApiKeyConfigured?: boolean;
  examCode: string; name: string; contestRule: Rule; startAt: string; latestStartAt: string; durationMinutes: number; flexible: boolean;
  freezeMinutes: number | null; scoreboardFrozenAt: string | null; endAt: string; rules: string;
  allowedLanguages: string[]; showTestCaseCount: boolean; showObjectiveScore: boolean; allowPrint: boolean; printMode: PrintMode; allowTeamSubmissionView: boolean; leaderOnlySubmission: boolean;
  contestType: 'INDIVIDUAL' | 'TEAM'; teamAccountMode: 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT'; requireMiniProgram: boolean; requireFrontCamera: boolean; saveFullRecording: boolean; saveIncidentRecording: boolean;
  reactionLogoMatchBy: ReactionLogoMatchBy;
  problems: Array<{ hydroProblemId: string; title: string }>;
  administrators: Array<{ user: { id: string; username: string | null; realName: string | null; numberId: string | null } }>;
};
export function ExamEditor({ examId, onImport }: { examId?: string; onImport?: () => void }) {
  const router = useRouter();
  const [examCode, setExamCode] = useState('');
  const [form, setForm] = useState(initialForm);
  const [platformSyncEnabled, setPlatformSyncEnabled] = useState(false);
  const nova = form.platform === 'NOVAJUDGE';
  const hydroBrowser = form.platform === 'HYDRO_BROWSER';
  const browser = isBrowserExam(form.platform);
  const [availableLanguages, setAvailableLanguages] = useState<HydroLanguage[]>([]);
  const [languageError, setLanguageError] = useState('');
  useEffect(() => {
    if (browser) return;
    const controller = new AbortController();
    request<HydroLanguage[]>('/api/hydro/languages', { signal: controller.signal })
      .then(setAvailableLanguages).catch(err => { if (!controller.signal.aborted) setLanguageError(err.message); });
    return () => controller.abort();
  }, [browser]);
  const languageOptions = groupJudgeLanguages(availableLanguages);
  for (const id of form.allowedLanguages) if (!languageOptions.some(item => item.id === id)) languageOptions.push({ id, name: `${id}（当前不可用）`, versions: [] });
  const [problems, setProblems] = useState<SearchOption[]>([]);
  const [admins, setAdmins] = useState<SearchOption[]>([]);
  const [loading, setLoading] = useState(Boolean(examId));
  const [saving, setSaving] = useState(false);
  const [savingReactionLogo, setSavingReactionLogo] = useState(false);
  const [reactionLogoNotice, setReactionLogoNotice] = useState<{ text: string; error?: boolean }>();
  const [error, setError] = useState('');
  const [loadFailed, setLoadFailed] = useState(false);
  const editor = useRef<HTMLTextAreaElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);
  const savingRef = useRef(false);
  useEffect(() => {
    if (!examId) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, [examId]);
  useEffect(() => {
    if (!examId) return;
    const controller = new AbortController();
    void request<ExamData>(`/api/exams/${examId}`, { signal: controller.signal }).then(exam => {
      setExamCode(exam.examCode);
      const start = toDatetimeLocalValue(exam.startAt).split('T');
      const printMode = exam.printMode === 'DISABLED' && exam.allowPrint ? 'PHYSICAL' : exam.printMode;
      setForm(normalizeContestFormat({ platform: exam.platform, platformBaseUrl: exam.platformBaseUrl, platformContestId: exam.platformContestId, hydroBrowserApiKey: '', hydroBrowserApiKeyConfigured: exam.hydroBrowserApiKeyConfigured ?? false, hydroBrowserEventFeedApiKey: '', hydroBrowserEventFeedApiKeyConfigured: exam.hydroBrowserEventFeedApiKeyConfigured ?? false, novaJudgeApiKey: '', novaJudgeTimezone: exam.novaJudgeTimezone || 'Asia/Shanghai', novaJudgeApiKeyConfigured: exam.novaJudgeApiKeyConfigured ?? false, name: exam.name, contestRule: exam.contestRule === 'ACM' ? 'XCPC' : exam.contestRule, startDate: start[0], startTime: start[1], durationMinutes: exam.durationMinutes,
        latestStartAt: exam.flexible ? toDatetimeLocalValue(exam.latestStartAt) : '',
        freezeMinutes: exam.freezeMinutes ?? (exam.scoreboardFrozenAt ? Math.max(0, Math.round((+new Date(exam.endAt) - +new Date(exam.scoreboardFrozenAt)) / 60_000)) : 0),
        rules: exam.rules, allowedLanguages: exam.allowedLanguages || [], showTestCaseCount: exam.showTestCaseCount, showObjectiveScore: exam.showObjectiveScore, allowPrint: printMode !== 'DISABLED', printMode, allowTeamSubmissionView: exam.allowTeamSubmissionView, leaderOnlySubmission: exam.leaderOnlySubmission,
        contestType: exam.contestType, teamAccountMode: exam.teamAccountMode || 'MEMBER_ACCOUNTS', requireMiniProgram: exam.requireMiniProgram, requireFrontCamera: exam.requireFrontCamera, saveFullRecording: exam.saveFullRecording ?? false, saveIncidentRecording: exam.saveIncidentRecording ?? false, reactionLogoMatchBy: exam.reactionLogoMatchBy ?? 'SCHOOL' }));
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
  const flexible = !browser && !isXcpc(form.contestRule) && Boolean(form.latestStartAt);
  const latest = flexible ? new Date(form.latestStartAt) : start;
  const earliestEnd = new Date(+start + form.durationMinutes * 60_000);
  const latestEnd = new Date(+latest + form.durationMinutes * 60_000);
  const validTime = Number.isFinite(+earliestEnd) && Number.isFinite(+latestEnd) && form.durationMinutes > 0 && latest >= start;
  const timeText = (date: Date) => date.toLocaleString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false });
  const updateRules = (rules: string) => setForm(current => ({ ...current, rules }));
  async function saveReactionLogoMatchBy(value: ReactionLogoMatchBy) {
    if (!examId || savingReactionLogo || value === form.reactionLogoMatchBy) return;
    const previous = form.reactionLogoMatchBy;
    setForm(current => ({ ...current, reactionLogoMatchBy: value }));
    setReactionLogoNotice(undefined);
    setSavingReactionLogo(true);
    try {
      await request(`/api/exams/${examId}`, { method: 'PATCH', body: JSON.stringify({ reactionLogoMatchBy: value }) });
      setReactionLogoNotice({ text: 'Reaction LOGO 匹配方式已保存' });
    } catch (err) {
      setForm(current => ({ ...current, reactionLogoMatchBy: previous }));
      setReactionLogoNotice({ text: err instanceof Error ? err.message : 'Reaction LOGO 匹配方式保存失败', error: true });
    } finally { setSavingReactionLogo(false); }
  }
  async function save(event: React.FormEvent) {
    event.preventDefault();
    if (savingRef.current || savingReactionLogo) return;
    setError('');
    let message = '';
    if (!form.name.trim()) message = '请输入考试标题';
    else if (!validTime) message = '请检查开始时间、考试时长和最晚开始时间';
    else if (nova && (!form.platformBaseUrl.trim() || !/^[1-9]\d*$/.test(form.platformContestId))) message = '请填写有效的 NovaJudge 平台域名和比赛 ID';
    else if (nova && !form.novaJudgeApiKey.trim() && !form.novaJudgeApiKeyConfigured) message = '请填写 NovaJudge 外榜 API Key';
    else if (hydroBrowser && (!form.platformBaseUrl.trim() || !/^[a-f\d]{24}$/i.test(form.platformContestId))) message = '请填写有效的 HydroOJ 地址和比赛 ID';
    else if (hydroBrowser && form.hydroBrowserEventFeedApiKey.trim() && !/^[\x21-\x7e]{32,1024}$/.test(form.hydroBrowserEventFeedApiKey.trim())) message = 'HydroOJ EventFeed 密钥应为 32 到 1024 个可打印字符';
    else if (!browser && isXcpc(form.contestRule) && form.freezeMinutes >= form.durationMinutes) message = '封榜分钟数必须小于考试时长';
    else if (!browser && !problems.length) message = '请至少选择一道题目';
    if (message) { setError(message); requestAnimationFrame(() => errorRef.current?.focus()); return; }
    savingRef.current = true; setSaving(true);
    try {
      await request(`/api/exams${examId ? `/${examId}` : ''}`, {
        method: examId ? 'PATCH' : 'POST',
        body: JSON.stringify({ name: form.name.trim(), contestRule: form.contestRule,
          startAt: start.toISOString(), latestStartAt: latest.toISOString(), endAt: latestEnd.toISOString(), durationMinutes: form.durationMinutes, flexible,
          freezeMinutes: browser ? 0 : isXcpc(form.contestRule) ? form.freezeMinutes : null, platform: form.platform,
          ...(nova ? { platformBaseUrl: form.platformBaseUrl.trim(), platformContestId: form.platformContestId, novaJudgeTimezone: form.novaJudgeTimezone, ...(form.novaJudgeApiKey.trim() ? { novaJudgeApiKey: form.novaJudgeApiKey.trim() } : {}) } : hydroBrowser ? { platformBaseUrl: form.platformBaseUrl.trim(), platformContestId: form.platformContestId, ...(form.hydroBrowserApiKey.trim() ? { hydroBrowserApiKey: form.hydroBrowserApiKey.trim() } : {}), ...(form.hydroBrowserEventFeedApiKey.trim() ? { hydroBrowserEventFeedApiKey: form.hydroBrowserEventFeedApiKey.trim() } : {}) } : {}), contestType: form.contestType, teamAccountMode: form.teamAccountMode,
          rules: form.rules, ...(browser ? {} : { problemIds: problems.map(problem => problem.id), ...(!examId && platformSyncEnabled ? { platformSyncEnabled: true } : {}) }), administratorIds: admins.map(user => user.id),
          allowedLanguages: form.allowedLanguages, showTestCaseCount: form.showTestCaseCount, showObjectiveScore: form.showObjectiveScore, allowPrint: form.printMode !== 'DISABLED', printMode: form.printMode, allowTeamSubmissionView: form.allowTeamSubmissionView, leaderOnlySubmission: form.leaderOnlySubmission,
          requireMiniProgram: form.requireMiniProgram, requireFrontCamera: form.requireFrontCamera, saveFullRecording: form.saveFullRecording, saveIncidentRecording: form.saveIncidentRecording })
      });
      router.push('/dashboard/exams'); router.refresh();
    } catch (err) { setError(err instanceof Error ? err.message : '保存失败'); requestAnimationFrame(() => errorRef.current?.focus()); }
    finally { savingRef.current = false; setSaving(false); }
  }
  return <div className={examId ? 'exam-editor-page' : 'exam-editor-create'}>
    <form id="exam-editor-form" className="exam-editor-form" aria-label={examId ? '编辑考试' : '发布考试'} onSubmit={save}>
      {examId ? <nav className="exam-editor-subnav" aria-label="考试编辑章节"><a href="#exam-information">考试信息</a>{browser ? <a href="#exam-browser">{browserExamPlatformName(form.platform)} 接入</a> : <a href="#exam-problems">题目选择</a>}<a href="#exam-description">考试说明</a><a href="#exam-permissions">权限控制</a><a href="#exam-settings">考试设置</a></nav> : null}
      {error ? <div ref={errorRef} tabIndex={-1} className="exam-editor-error" role="alert">{error}</div> : null}
      {loading ? <div className="problem-loading"><LoaderCircle className="spin" size={20} /> 正在加载考试…</div> : <fieldset disabled={saving || loadFailed} className="exam-editor-fields">
        <section id="exam-information" className="exam-editor-section">
          <div className="exam-section-title exam-editor-heading">
            <h2>考试信息</h2>
            {onImport ? <button type="button" className="button secondary" onClick={onImport}>导入公网考试</button> : null}
          </div>
          <div className="exam-section-body">
          <label>考试类型<select aria-label="考试类型" value={form.platform} disabled={Boolean(examId)} onChange={event => setForm({ ...form, platform: event.target.value as ExamPlatform, ...(event.target.value === 'NOVAJUDGE' ? { contestRule: 'XCPC', latestStartAt: '', freezeMinutes: 0 } : event.target.value === 'HYDRO_BROWSER' ? { contestRule: 'IOI', contestType: 'INDIVIDUAL', teamAccountMode: 'MEMBER_ACCOUNTS', latestStartAt: '', freezeMinutes: 0, allowTeamSubmissionView: false, leaderOnlySubmission: false } : {}) })}><option value="HYDRO">本平台答题（Hydro 评测）</option><option value="NOVAJUDGE">NovaJudge（监考与浏览器）</option><option value="HYDRO_BROWSER">HydroOJ（监考与浏览器）</option></select></label>
          <div className="exam-time-preview"><span>考试编号</span><strong>{examCode || (form.startDate ? `${form.startDate.replaceAll('-', '')}XX（保存后自动生成）` : '保存后自动生成 10 位唯一编号')}</strong></div>{!hydroBrowser ? <div className="exam-form-columns"><label hidden={nova}>赛制<select aria-label="规则" value={form.contestRule} onChange={event => { const rule = event.target.value as Rule; setForm(normalizeContestFormat({ ...form, contestRule: rule })); }}>{Object.entries(examRuleLabels).map(([value, label]) => <option value={value} key={value}>{label}</option>)}</select></label><label>比赛类型<select aria-label="比赛类型" value={form.contestType} disabled={!nova && !isXcpc(form.contestRule)} onChange={event => { const contestType = event.target.value as 'INDIVIDUAL' | 'TEAM'; setForm(normalizeContestFormat({ ...form, contestType })); }}>{nova || form.contestRule !== 'GPLT' ? <option value="INDIVIDUAL">个人赛</option> : null}{nova || isXcpc(form.contestRule) || form.contestRule === 'GPLT' ? <option value="TEAM">团队赛</option> : null}</select></label>{form.contestType === 'TEAM' ? <label>团队账号方式<select aria-label="团队账号方式" value={form.teamAccountMode} disabled={!nova && form.contestRule === 'GPLT'} onChange={event => { const teamAccountMode = event.target.value as 'MEMBER_ACCOUNTS' | 'TEAM_ACCOUNT'; setForm(normalizeContestFormat({ ...form, teamAccountMode })); }}><option value="MEMBER_ACCOUNTS">每个成员一个账号</option>{nova || form.contestRule !== 'GPLT' ? <option value="TEAM_ACCOUNT">一个队伍一个账号</option> : null}</select></label> : null}</div> : null}
          <label>标题<input required maxLength={200} placeholder="输入考试名称" value={form.name} onChange={event => setForm({ ...form, name: event.target.value })} /></label>
          <div className="exam-form-columns"><label>开始日期<input required type="date" value={form.startDate} onChange={event => setForm({ ...form, startDate: event.target.value })} /></label><label>开始时间<input required type="time" value={form.startTime} onChange={event => setForm({ ...form, startTime: event.target.value })} /></label><label>考试时长（分钟）<input required type="number" min={1} max={525600} step={1} value={form.durationMinutes || ''} onChange={event => setForm({ ...form, durationMinutes: Number(event.target.value) })} /></label></div>
          {!browser && (isXcpc(form.contestRule) ? <label>封榜时间（剩余分钟数）<input type="number" required min={0} max={Math.max(0, form.durationMinutes - 1)} step={1} value={form.freezeMinutes} onChange={event => setForm({ ...form, freezeMinutes: Number(event.target.value) })} /></label> : <label>最晚开始时间<input type="datetime-local" min={form.startDate && form.startTime ? `${form.startDate}T${form.startTime}` : undefined} value={form.latestStartAt} onChange={event => setForm({ ...form, latestStartAt: event.target.value })} /></label>)}
          <div className="exam-time-preview" aria-live="polite"><span>结束时间{flexible ? '范围' : ''}</span><strong>{validTime ? `${timeText(earliestEnd)}${flexible && +latest > +start ? ` — ${timeText(latestEnd)}` : ''}` : '—'}</strong>{validTime && !browser && isXcpc(form.contestRule) && form.freezeMinutes > 0 && form.freezeMinutes < form.durationMinutes ? <span>封榜时间：{timeText(new Date(+latestEnd - form.freezeMinutes * 60_000))}</span> : null}</div>
        </div></section>
        {nova ? <section id="exam-browser" className="exam-editor-section"><div className="exam-section-title"><h2>NovaJudge 接入</h2></div><div className="exam-section-body">
          <label>NovaJudge 平台域名<input required placeholder="https://judge.example.org" maxLength={512} value={form.platformBaseUrl} onChange={event => setForm({ ...form, platformBaseUrl: event.target.value })} /></label>
          <label>NovaJudge 比赛 ID<input required inputMode="numeric" pattern="[1-9][0-9]*" placeholder="例如 1" value={form.platformContestId} onChange={event => setForm({ ...form, platformContestId: event.target.value })} /></label>
          <label>NovaJudge 外榜 API Key<input required={!form.novaJudgeApiKeyConfigured} type="password" autoComplete="new-password" maxLength={2000} placeholder={form.novaJudgeApiKeyConfigured ? '同一站点留空保留原密钥' : 'NovaJudge 后台创建并启用的 API Key'} value={form.novaJudgeApiKey} onChange={event => setForm({ ...form, novaJudgeApiKey: event.target.value })} /></label>
          <label>NovaJudge 数据时区<select value={form.novaJudgeTimezone} onChange={event => setForm({ ...form, novaJudgeTimezone: event.target.value })}><option value="Asia/Shanghai">中国标准时间（Asia/Shanghai）</option><option value="UTC">UTC</option><option value="America/Vancouver">温哥华（NovaJudge 原始 Docker 默认）</option>{!['Asia/Shanghai', 'UTC', 'America/Vancouver'].includes(form.novaJudgeTimezone) ? <option value={form.novaJudgeTimezone}>{form.novaJudgeTimezone}</option> : null}</select></label>
        </div></section> : hydroBrowser ? <section id="exam-browser" className="exam-editor-section"><div className="exam-section-title"><h2>HydroOJ 接入</h2></div><div className="exam-section-body"><HydroBrowserFields baseUrl={form.platformBaseUrl} contestId={form.platformContestId} apiKey={form.hydroBrowserApiKey} apiKeyConfigured={form.hydroBrowserApiKeyConfigured} eventFeedApiKey={form.hydroBrowserEventFeedApiKey} eventFeedApiKeyConfigured={form.hydroBrowserEventFeedApiKeyConfigured} onApiKey={hydroBrowserApiKey => setForm({ ...form, hydroBrowserApiKey })} onEventFeedApiKey={hydroBrowserEventFeedApiKey => setForm({ ...form, hydroBrowserEventFeedApiKey })} onBaseUrl={platformBaseUrl => setForm({ ...form, platformBaseUrl })} onContestId={platformContestId => setForm({ ...form, platformContestId })} /></div></section> : <section id="exam-problems" className="exam-editor-section"><div className="exam-section-title"><h2>题目选择</h2></div><div className="exam-section-body"><ExamSearchSelect label="考试题目" placeholder="输入题目编号或名称" value={problems} onChange={setProblems} search={searchProblems} /></div></section>}
        <section id="exam-description" className="exam-editor-section"><div className="exam-section-title"><h2>考试说明</h2></div><div className="exam-markdown-editor"><div className="exam-markdown-toolbar"><div><strong title={markdownShortcutHelp}>Markdown 编辑</strong></div><div role="group" aria-label="Markdown 格式"><MarkdownFormatButtons editor={editor} onChange={updateRules} disabled={saving || loadFailed} /></div></div><div className="exam-markdown-live"><textarea ref={editor} aria-label="考试说明 Markdown" rows={12} placeholder={'## 考试说明\n\n请在这里填写比赛规则、注意事项和其他说明。'} value={form.rules} onChange={event => updateRules(event.target.value)} onKeyDown={event => applyMarkdownShortcut(event, updateRules)} /><div className="exam-markdown-preview hydro-markdown" aria-label="考试说明预览" aria-live="polite"><MarkdownContent content={form.rules} /></div></div></div></section>
        <section id="exam-permissions" className="exam-editor-section"><div className="exam-section-title"><h2>权限控制</h2></div><div className="exam-section-body"><ExamSearchSelect label="比赛管理员" placeholder="输入用户名、姓名或学号" value={admins} onChange={setAdmins} search={searchUsers} /></div></section>
        <section id="exam-settings" className="exam-editor-section"><div className="exam-section-title"><h2>考试设置</h2></div><div className="exam-section-body">
          {examId ? <div>
            <label>Reaction LOGO 匹配方式<select value={form.reactionLogoMatchBy} disabled={savingReactionLogo} onChange={event => void saveReactionLogoMatchBy(event.target.value as ReactionLogoMatchBy)}>
              <option value="SCHOOL">按学校名称匹配</option>
              <option value="COLLEGE">按学院名称匹配</option>
            </select></label>
            {reactionLogoNotice?.error ? <p role="alert" className="exam-editor-error">{reactionLogoNotice.text}</p>
              : <p role="status" className="muted">{savingReactionLogo ? '正在保存匹配方式…' : reactionLogoNotice?.text || '选择后自动保存'}</p>}
          </div> : null}
          <p className="muted">录像及其保存设置仅对当前服务器生效，公网和内网分别配置。</p>
          <label className="exam-checkbox"><input type="checkbox" role="switch" className="settings-switch" checked={form.saveFullRecording} onChange={event => setForm({ ...form, saveFullRecording: event.target.checked })} /> 保存完整考试录像</label><label className="exam-checkbox"><input type="checkbox" role="switch" className="settings-switch" checked={form.saveIncidentRecording} onChange={event => setForm({ ...form, saveIncidentRecording: event.target.checked })} /> 保存异常前后各 20 秒录像</label>{!browser ? examId ? <ExamFederationSettings key={examId} examId={examId} /> : <label className="exam-checkbox"><input type="checkbox" role="switch" className="settings-switch" checked={platformSyncEnabled} onChange={event => setPlatformSyncEnabled(event.target.checked)} /> 跨网同步</label> : null}<div hidden={browser}><div><span className="exam-field-label">提交语言限制</span><div className="exam-language-options">{languageOptions.map(language => <label key={language.id}><input type="checkbox" role="switch" className="settings-switch" checked={form.allowedLanguages.includes(language.id)} onChange={event => setForm({ ...form, allowedLanguages: event.target.checked ? [...form.allowedLanguages, language.id] : form.allowedLanguages.filter(id => id !== language.id) })} />{language.name}</label>)}</div>{languageError ? <p className="problem-error">语言列表读取失败：{languageError}</p> : null}</div><label className="exam-checkbox"><input type="checkbox" role="switch" className="settings-switch" checked={form.contestRule === 'KS' || form.showTestCaseCount} disabled={form.contestRule === 'KS'} onChange={event => setForm({ ...form, showTestCaseCount: event.target.checked })} /> 展示通过测试点数目{form.contestRule === 'KS' ? '（KS 赛制固定开启）' : ''}</label><label className="exam-checkbox"><input type="checkbox" role="switch" className="settings-switch" checked={form.contestRule !== 'KS' && form.showObjectiveScore} disabled={form.contestRule === 'KS'} onChange={event => setForm({ ...form, showObjectiveScore: event.target.checked })} /> 展示客观题成绩{form.contestRule === 'KS' ? '（KS 客观题实时判题，考生端仅显示已提交）' : ''}</label><label>打印方式<select value={form.printMode} onChange={event => { const printMode = event.target.value as PrintMode; setForm({ ...form, printMode, allowPrint: printMode !== 'DISABLED' }); }}><option value="DISABLED">不允许打印</option><option value="VIRTUAL">虚拟打印（仅保存电子记录）</option><option value="PHYSICAL">真实打印（进入后台打印队列）</option></select></label>{form.contestType === 'TEAM' ? <label className="exam-checkbox"><input type="checkbox" role="switch" className="settings-switch" checked={form.leaderOnlySubmission} disabled={form.contestRule === 'GPLT'} onChange={event => setForm({ ...form, leaderOnlySubmission: event.target.checked })} /> 只有队长可以提交</label> : null}<TeamSubmissionViewSetting contestType={form.contestType} teamAccountMode={form.teamAccountMode} enabled={form.allowTeamSubmissionView} onChange={enabled => setForm({ ...form, allowTeamSubmissionView: enabled })} showHelp={false} /></div></div></section>
      </fieldset>}
      <footer className="exam-editor-footer">
        <button className="button" type="submit" disabled={saving || savingReactionLogo || loading || loadFailed}>{saving ? <LoaderCircle size={17} className="spin" /> : <Save size={17} />}{saving ? '保存中…' : '保存考试'}</button>
      </footer>
    </form>
  </div>;
}
