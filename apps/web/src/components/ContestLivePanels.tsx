'use client';

import { useEffect, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import Link from 'next/link';
import isEqual from 'lodash/isEqual';
import { ChevronDown, Columns2, Copy, ExternalLink, Eye, EyeOff, Grid2X2, Monitor, Plus, RotateCcw, Trash2, Upload } from 'lucide-react';
import type { ContestLivePreset } from '@/lib/contest-live-presets';
import { contestLiveSettingsPatchSchema, contestLiveTeamSlotCount, type ContestLiveResponse, type ContestLiveTeamSlot, type ContestLiveSettings, type ContestLiveSettingsPatch, type ContestLiveTickerMessage } from '@/lib/contest-live-settings';
import { contestTeamNameFields, contestTeamNameTemplateSchema, defaultContestTeamNameTemplate, formatContestTeamName } from '@/lib/contest-team-name';
import { parseVisualConfigText, visualConfigDefaults } from '@/lib/contest-live-visual-config';
import { SCREEN_SAMPLE_VALUES } from '@/lib/screen-control-template';
import { api } from './api';
import styles from './ContestLiveAdmin.module.css';

type Team = ContestLiveResponse['contest']['teams'][number];
type PatchProps = { patch: (settings: ContestLiveSettingsPatch) => Promise<boolean>; busy: boolean };
type SettingsProps = PatchProps & { settings: ContestLiveSettings };
type ResponseProps = PatchProps & { response: ContestLiveResponse };
type OperationProps = {
  endpoint: string;
  busy: boolean;
  perform: (operation: () => Promise<void | Pick<ContestLiveResponse, 'settings'>>, message?: string) => Promise<boolean>;
};

export const sourceLabels = { local: '监考系统本机赛事', hydro: 'HydroOJ 赛事', nova: 'NovaJudge 赛事' };
const mediaLabels = { auto: '自动选择', screen: '电脑屏幕', camera: '前置摄像头', photo: '队伍照片', empty: '空' };
const teamModes = { single: '单队伍', pvp: '两队对比', split: '分屏' };
const widgetLabels = { scoreboard: '比赛榜单', queue: '提交队列', statistics: '题目统计', ticker: '滚动条', clock: '全屏计时器' };
const clockModes = { standard: '赛前倒计时 → 已用赛时 → 结束', countdown: '赛前倒计时 → 剩余赛时 → 结束', global: '时区实时时钟' };
const scrollModes = { off: '不滚动', up: '向上', down: '向下' };
const scoreboardVersions = { normal: '常规榜单', optimistic: '乐观估计', pessimistic: '保守估计' };
const tickerModes = { text: '文字', clock: '时钟', scoreboard: '榜单', image: '图片' };
const acceptedPhotoTypes = 'image/jpeg,image/png,image/webp';
const verdictLabels: Record<string, string> = {
  AC: '通过', ACCEPTED: '通过', WA: '答案错误', TLE: '超时', MLE: '内存超限', OLE: '输出超限', RE: '运行错误', CE: '编译错误', PE: '格式错误', SE: '系统错误',
  'WRONG ANSWER': '答案错误', 'TIME LIMIT EXCEEDED': '超时', 'MEMORY LIMIT EXCEEDED': '内存超限', 'OUTPUT LIMIT EXCEEDED': '输出超限',
  'RUNTIME ERROR': '运行错误', 'COMPILE ERROR': '编译错误', 'PRESENTATION ERROR': '格式错误', 'SYSTEM ERROR': '系统错误',
  WAITING: '等待评测', QUEUEING: '排队中', JUDGING: '评测中', COMPILING: '编译中', CANCELLED: '已取消', CANCELED: '已取消',
};

function Panel({ title, children, id }: { title: string; children: ReactNode; id?: string }) {
  return <section id={id} className={`card ${styles.panel}`}><h2>{title}</h2>{children}</section>;
}

function Check({ name, label, checked, disabled, onChange }: { name?: string; label: string; checked: boolean; disabled?: boolean; onChange?: (checked: boolean) => void }) {
  return <label className={styles.check}><input type="checkbox" name={name} defaultChecked={onChange ? undefined : checked} checked={onChange ? checked : undefined} disabled={disabled} onChange={onChange ? event => onChange(event.target.checked) : undefined} />{label}</label>;
}

function Field({ label, children }: { label: string; children: ReactNode }) {
  return <label className={styles.field}>{label}{children}</label>;
}

function Options({ values }: { values: Record<string, string> }) {
  return <>{Object.entries(values).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</>;
}

function save(event: FormEvent<HTMLFormElement>, action: (values: FormData) => void) {
  event.preventDefault();
  action(new FormData(event.currentTarget));
}

function value(values: FormData, name: string) {
  return String(values.get(name) ?? '');
}

function time(value: string | Date | null) {
  return value ? new Date(value).toLocaleString('zh-CN', { hour12: false, timeZone: 'Asia/Shanghai' }) : '—';
}

function localDateTime(value: string | null) {
  if (!value) return '';
  const parts = new Map(new Intl.DateTimeFormat('en-US', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(value)).map(part => [part.type, part.value]));
  return `${parts.get('year')}-${parts.get('month')}-${parts.get('day')}T${parts.get('hour')}:${parts.get('minute')}:${parts.get('second')}`;
}

function duration(seconds: number) {
  const minutes = Math.floor(seconds / 60);
  return `${Math.floor(minutes / 60)}:${('0' + minutes % 60).slice(-2)}:${('0' + Math.floor(seconds % 60)).slice(-2)}`;
}

function verdictText(verdict: string | null) {
  return verdict ? verdictLabels[verdict.toUpperCase()] || verdict : '待评';
}

function matchesTeam(team: Team, query: string) {
  return [team.name, team.account, ...team.accounts, team.organization, team.group, ...team.members].some(field => field.toLowerCase().includes(query));
}

function TeamPicker({ teams, selected, limit, onChange }: { teams: Team[]; selected: string[]; limit: number; onChange: (ids: string[]) => void }) {
  const [query, setQuery] = useState('');
  const keyword = query.trim().toLowerCase();
  const options = teams.filter(team => matchesTeam(team, keyword));

  return <>
    <Field label={`队伍 · 已选 ${selected.length} / ${limit}`}><input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="按名称、账号、学校搜索" /></Field>
    <div className={styles.teamPicker}>
      {options.length === 0 && <p className={styles.empty}>没有匹配的队伍。</p>}
      {options.map(team => {
        const index = selected.indexOf(team.id);
        return <label key={team.id}>
          <input type={limit === 1 ? 'radio' : 'checkbox'} name="team" checked={index >= 0} disabled={limit > 1 && index < 0 && selected.length >= limit} onChange={() => {
            if (limit === 1) onChange([team.id]);
            else onChange(index >= 0 ? selected.filter(id => id !== team.id) : [...selected, team.id]);
          }} />
          <span>{index >= 0 && limit > 1 ? `${index + 1}. ` : ''}{team.name}<small>{[team.account, team.organization, team.group].filter(Boolean).join(' · ')}</small></span>
        </label>;
      })}
    </div>
  </>;
}

export function WidgetControls({ response, patch, busy }: ResponseProps) {
  const { settings } = response;
  const [expanded, setExpanded] = useState<string | null>(null);
  const options: Partial<Record<keyof typeof widgetLabels, ReactNode>> = {
    scoreboard: <ScoreboardSettings response={response} patch={patch} busy={busy} />,
    queue: <Check label="横向显示提交队列" checked={settings.horizontalQueue} disabled={busy || !settings.widgets.queue}
      onChange={checked => patch({ horizontalQueue: checked })} />,
    clock: <ClockControls key={JSON.stringify(settings.clock)} settings={settings} patch={patch} busy={busy} />,
  };
  return <section className={styles.widgetList} aria-label="直播控件">
    {(Object.keys(widgetLabels) as Array<keyof typeof widgetLabels>).map(widget => {
      const label = widgetLabels[widget];
      const shown = settings.widgets[widget];
      return <section key={widget} className={styles.widgetAccordion}>
        <div className={styles.widgetHeading}>
          <button className={styles.widgetVisibility} data-shown={shown || undefined} type="button"
            aria-label={`${shown ? '隐藏' : '显示'}${label}`} disabled={busy} aria-pressed={shown}
            onClick={() => patch({ widgets: { [widget]: !shown } })}>
            {shown ? <EyeOff size={18} aria-hidden /> : <Eye size={18} aria-hidden />}{shown ? '隐藏' : '显示'}
          </button>
          {options[widget] ? <button className={styles.widgetExpand} type="button" aria-expanded={expanded === widget}
            aria-controls={`live-widget-${widget}`} onClick={() => setExpanded(expanded === widget ? null : widget)}>
            {label}<ChevronDown size={19} aria-hidden />
          </button> : <span className={styles.widgetName}>{label}</span>}
        </div>
        {expanded === widget && options[widget] && <div id={`live-widget-${widget}`} className={styles.widgetBody}>{options[widget]}</div>}
      </section>;
    })}
  </section>;
}

function ClockControls({ settings: { clock }, patch, busy }: SettingsProps) {
  const [mode, setMode] = useState(clock.mode);
  return <form className={styles.form} key={JSON.stringify(clock)} onSubmit={event => save(event, fields => patch({ clock: {
    mode: value(fields, 'mode') as typeof clock.mode,
    timezone: value(fields, 'timezone') || clock.timezone,
    showSeconds: fields.has('showSeconds'),
  } }))}>
    <Field label="时钟模式"><select name="mode" key={clock.mode} defaultValue={clock.mode} onChange={event => setMode(event.target.value as typeof clock.mode)}><Options values={clockModes} /></select></Field>
    {mode === 'global' && <Field label="时区"><input name="timezone" placeholder="Asia/Shanghai" defaultValue={clock.timezone || 'Asia/Shanghai'} required /></Field>}
    <Check name="showSeconds" label="显示秒数" checked={clock.showSeconds} />
    <div><button type="submit" className="button" disabled={busy}>应用计时设置</button></div>
  </form>;
}

export function LiveSettings({ response, overlayUrl, endpoint, patch, perform, busy }: ResponseProps & OperationProps & { overlayUrl: string }) {
  const [obsKey, setObsKey] = useState('');
  const [copied, setCopied] = useState<'live' | 'scoreboard' | null>(null);
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  const publicLink = origin + overlayUrl;
  const obsLink = obsKey ? `${publicLink}?key=${encodeURIComponent(obsKey)}&noStatus` : '';
  const hasFreeze = Boolean(response.settings.freeze.at);

  async function copyLink(kind: 'live' | 'scoreboard', link: string) {
    try { await navigator.clipboard.writeText(link); setCopied(kind); }
    catch { setCopied(null); }
  }

  async function generate() {
    await perform(async () => {
      const { key } = await api<{ key: string }>(`${endpoint}/access`, { method: 'POST' });
      setObsKey(key);
      setCopied(null);
    }, '已生成浏览器源链接');
  }

  async function revoke() {
    await perform(async () => {
      await api(`${endpoint}/access`, { method: 'DELETE' });
      setObsKey('');
      setCopied(null);
    }, '已撤销浏览器源链接');
  }

  return <>
    <TeamNameSettings key={response.contest.exam.id} response={response} patch={patch} busy={busy} />
    <VisualConfigEditor key={response.contest.exam.id + '-visual'} settings={response.settings} patch={patch} busy={busy} />
    <FreezeSettings key={JSON.stringify(response.settings.freeze)} response={response} patch={patch} busy={busy} />
    <div className={styles.panels}>
    <Panel title="公开直播">
      <Check label="启用公开直播页" checked={hasFreeze && response.settings.publicEnabled} disabled={busy || !hasFreeze} onChange={checked => patch(checked ? { publicEnabled: true } : { publicEnabled: false, publicMediaEnabled: false })} />
      <Check label="允许公开直播播放考生屏幕和摄像头" checked={hasFreeze && response.settings.publicMediaEnabled} disabled={busy || !hasFreeze || !response.settings.publicEnabled} onChange={checked => patch({ publicMediaEnabled: checked })} />
      {hasFreeze && response.settings.publicEnabled && <div className={styles.actions}>
        <a className="button secondary" href={overlayUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />打开公开直播页</a>
        <a className="button secondary" href={`${overlayUrl}?view=scoreboard`} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />打开公开榜单大屏</a>
      </div>}
    </Panel>
    <Panel title="OBS 浏览器源">
      <p className={styles.status}>浏览器源分辨率为 1920 × 1080。生成新链接后，旧链接会失效。</p>
      <div className={styles.actions}>
        <button type="button" className="button" disabled={busy || !hasFreeze} onClick={() => void generate()}><RotateCcw size={16} aria-hidden="true" />{response.settings.obsKeyActive ? '重新生成链接' : '生成链接'}</button>
        {response.settings.obsKeyActive && <button type="button" className="button secondary" disabled={busy} onClick={() => void revoke()}>撤销链接</button>}
      </div>
      {hasFreeze && obsLink && response.settings.obsKeyActive && ([
        { kind: 'live', label: '浏览器源链接', copyLabel: '复制链接', link: obsLink },
        { kind: 'scoreboard', label: '榜单大屏源链接', copyLabel: '复制榜单大屏链接', link: `${obsLink}&view=scoreboard` },
      ] as const).map(({ kind, label, copyLabel, link }) => <div className={styles.form} key={kind}>
        <Field label={label}><input readOnly value={link} onFocus={event => event.currentTarget.select()} /></Field>
        <div><button type="button" className="button secondary" onClick={() => void copyLink(kind, link)}><Copy size={16} aria-hidden="true" />{copied === kind ? '已复制' : copyLabel}</button></div>
      </div>)}
    </Panel>
    </div>
    <SettingsEditor settings={response.settings} patch={patch} busy={busy} />
  </>;
}

const visualConfigExample = JSON.stringify({
  CONTEST_COLOR: '#176B87',
  CONTEST_CAPTION: '热身赛',
  SCOREBOARD_ROW_FONT_SIZE: '26px',
  WIDGET_POSITIONS: { queue: { positionX: 1520, positionY: 400, sizeX: 380, sizeY: 600 } },
}, null, 2);
const defaultVisualJson = JSON.stringify(visualConfigDefaults, null, 2);

function VisualConfigEditor({ settings, patch, busy }: SettingsProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const [fileError, setFileError] = useState('');
  const source = draft ?? JSON.stringify(settings.visualConfig, null, 2);
  const parsed = useMemo(() => parseVisualConfigText(source), [source]);
  const error = fileError || parsed.error;

  function edit(text: string) {
    setFileError('');
    setDraft(text);
  }

  return <Panel title="直播外观" id="visual-config">
    <form className={styles.form} onSubmit={async event => {
      event.preventDefault();
      if (parsed.config && await patch({ visualConfig: parsed.config })) setDraft(null);
    }}>
      <div className={styles.field}><label htmlFor="live-visual-json">visual-config.json</label>
        <textarea id="live-visual-json" className={styles.json} rows={10} value={source} spellCheck={false}
        disabled={busy} aria-invalid={Boolean(error)} aria-describedby={error ? 'visual-config-error' : 'visual-config-help'}
        onChange={event => edit(event.target.value)} /></div>
      <p className={styles.status} id="visual-config-help">可粘贴或导入 ICPC Live 的外观 JSON，只填写要修改的字段。组件坐标按 1920 × 1080 画布计算，普通榜单用 <code>scoreboard</code>，全屏榜单用 <code>scoreboardFullScreen</code>。保存后，本场直播预览、OBS 浏览器源和榜单大屏会自动重新载入。</p>
      {error && <p className="exam-editor-error" id="visual-config-error" role="alert">{error}</p>}
      <div className={styles.actions}>
        <button type="submit" className="button" disabled={busy || Boolean(error) || isEqual(parsed.config, settings.visualConfig)}>保存外观配置</button>
        <label className={`button secondary ${styles.upload}`} aria-disabled={busy}><Upload size={16} aria-hidden />导入 JSON
          <input type="file" accept=".json,application/json" disabled={busy} onChange={async event => {
            const file = event.target.files?.[0];
            event.target.value = '';
            if (!file) return;
            try { edit(await file.text()); } catch { setFileError('无法读取所选文件，请重新选择。'); }
          }} />
        </label>
        <button type="button" className="button secondary" disabled={busy} onClick={() => edit(visualConfigExample)}>填入示例</button>
        <button type="button" className="button secondary" disabled={busy || source === '{}'} onClick={() => edit('{}')}>填入默认配置 {'{}'}</button>
      </div>
      <details><summary>查看 ICPC Live 字段和默认值</summary>
        <Field label="默认外观参考"><textarea className={styles.json} rows={12} readOnly spellCheck={false} value={defaultVisualJson} /></Field>
        <p className={styles.status}>同场需要多套外观时，可在 <code>SCENES</code> 中定义场景，并在对应浏览器源链接中添加 <code>visualConfigScene=场景名</code>。</p>
      </details>
    </form>
  </Panel>;
}

function TeamNameSettings({ response: { settings, contest: { exam } }, patch, busy }: ResponseProps) {
  const [draft, setDraft] = useState<string | null>(null);
  const template = draft ?? settings.teamNameTemplate;
  const parsed = contestTeamNameTemplateSchema.safeParse(template);
  const sample = contestTeamNameFields(SCREEN_SAMPLE_VALUES.name, SCREEN_SAMPLE_VALUES, exam.reactionLogoMatchBy);
  function edit(value: string) {
    setDraft(value === settings.teamNameTemplate ? null : value);
  }
  return <Panel title="直播与大屏名称模板" id="team-name-template">
    <form className={styles.form} onSubmit={async event => {
      event.preventDefault();
      if (parsed.success && await patch({ teamNameTemplate: parsed.data })) setDraft(null);
    }}>
      <Field label="名称模板"><input id="team-name-input" value={template} onChange={event => edit(event.target.value)}
        spellCheck={false} disabled={busy} aria-invalid={!parsed.success} aria-describedby="team-name-help team-name-fields team-name-preview" /></Field>
      <p className={styles.status} id="team-name-help"><code>{'{org.name}'}</code> 跟随本场考试的 Reaction LOGO 匹配方式，当前按{exam.reactionLogoMatchBy === 'COLLEGE' ? '学院' : '学校'}名称匹配。 <Link href={`/dashboard/exams/${encodeURIComponent(exam.id)}/settings#exam-settings`}>更改匹配方式</Link></p>
      <p className={styles.status} id="team-name-fields"><code>{'{school.name}'}</code> 固定取学校，<code>{'{college.name}'}</code> 固定取学院，<code>{'{team.name}'}</code> 取队名或姓名。模板用到的组织字段缺失时，仅显示队名或姓名。</p>
      {parsed.success
        ? <p id="team-name-preview">示例预览　<output htmlFor="team-name-input">{formatContestTeamName(parsed.data, sample)}</output></p>
        : <p id="team-name-preview" className="exam-editor-error" role="alert">{parsed.error.issues[0].message}</p>}
      <div className={styles.actions}>
        <button type="submit" className="button" disabled={busy || !parsed.success || parsed.data === settings.teamNameTemplate}>保存模板</button>
        <button type="button" className="button secondary" disabled={busy || template === defaultContestTeamNameTemplate}
          onClick={() => edit(defaultContestTeamNameTemplate)}>填入默认模板</button>
      </div>
    </form>
  </Panel>;
}

function FreezeSettings({ response, patch, busy }: ResponseProps) {
  const { settings: { freeze }, contest: { exam, sourceError } } = response;
  const earliest = (Math.floor(Date.parse(exam.startAt) / 1000) + 1) * 1000;
  const latest = (Math.ceil(Date.parse(exam.endAt) / 1000) - 1) * 1000;
  let freezeStatus = exam.frozen ? '已封榜' : '待封榜';
  if (freeze.revealed) freezeStatus = exam.frozen || sourceError ? '已请求揭晓，正在等待赛事数据' : '已揭晓';
  return <Panel title="直播封榜" id="live-freeze">
    <p className={styles.status}>{freeze.at ? `直播封榜时间 ${time(freeze.at)} · ${freezeStatus}` : '设置手动封榜时间后即可使用赛事直播。'}</p>
    {exam.source === 'hydro' && freeze.revealed && exam.frozen && <p className={styles.status}>正在重新同步 HydroOJ 外榜判题结果。若长时间未恢复，请检查外榜连接和插件版本。</p>}
    <form className={styles.form} onSubmit={event => save(event, fields => {
      const date = new Date(`${value(fields, 'at')}+08:00`);
      if (!Number.isNaN(date.getTime())) patch({ freeze: { at: date.toISOString(), revealed: false } });
    })}>
      <Field label="手动封榜时间（北京时间）"><input type="datetime-local" name="at" step={1} min={localDateTime(new Date(earliest).toISOString())} max={localDateTime(new Date(latest).toISOString())} defaultValue={localDateTime(freeze.at)} required /></Field>
      <div className={styles.actions}>
        <button type="submit" className="button" disabled={busy}>保存封榜时间</button>
        <button type="button" className="button secondary" disabled={busy || !freeze.at} onClick={() => patch({ freeze: { at: null, revealed: false } })}>清除封榜时间并停止直播</button>
      </div>
    </form>
  </Panel>;
}

const generalSettingsSchema = contestLiveSettingsPatchSchema.omit({ visualConfig: true });

function SettingsEditor({ settings, patch, busy }: SettingsProps) {
  const [error, setError] = useState('');
  const values = generalSettingsSchema.strip().parse(settings);
  const json = JSON.stringify(values, null, 2);

  return <Panel title="直播配置 JSON">
    <details>
      <summary>查看或编辑配置</summary>
      <form className={styles.form} key={json} onSubmit={event => save(event, fields => {
        setError('');
        try {
          const result = generalSettingsSchema.safeParse(JSON.parse(value(fields, 'json')));
          if (!result.success) {
            const fields = [...new Set(result.error.issues.map(issue => issue.path.join('.') || '根对象'))];
            setError(`配置字段无效：${fields.join('、')}`);
            return;
          }
          patch(result.data);
        } catch { setError('JSON 格式有误，请检查引号、逗号和括号。'); }
      })}>
        <Field label="当前直播设置"><textarea name="json" rows={13} defaultValue={json} spellCheck={false} className={styles.json} /></Field>
        {error && <p className="exam-editor-error" role="alert">{error}</p>}
        <div><button type="submit" className="button" disabled={busy}>保存配置</button></div>
      </form>
    </details>
  </Panel>;
}

export function TitlesPanel({ settings, patch, busy }: SettingsProps) {
  const { titles } = settings;
  const titleVisible = titles.titleVisible ?? titles.visible;
  const advertisementVisible = titles.advertisementVisible ?? titles.visible;
  const pictureVisible = titles.pictureVisible ?? titles.visible;
  return <div className={styles.titlePanels}>
    <Panel title="广告">
      <form className={styles.form} key={titles.advertisement} onSubmit={event => save(event, fields => patch({ titles: {
        advertisement: value(fields, 'advertisement'), advertisementVisible: true,
      } }))}>
        <Field label="广告文字"><textarea name="advertisement" defaultValue={titles.advertisement} rows={3} maxLength={1000} required /></Field>
        <div className={styles.actions}>
          <button type="submit" className="button" disabled={busy}>显示广告</button>
          <button type="button" className="button secondary" disabled={busy || !advertisementVisible}
            onClick={() => patch({ titles: { advertisementVisible: false } })}>隐藏广告</button>
        </div>
      </form>
    </Panel>
    <Panel title="标题">
      <form className={styles.form} key={JSON.stringify([titles.title, titles.subtitle])} onSubmit={event => save(event, fields => patch({ titles: {
        title: value(fields, 'title'), subtitle: value(fields, 'subtitle'), titleVisible: true,
      } }))}>
        <Field label="主标题"><input name="title" defaultValue={titles.title} maxLength={180} /></Field>
        <Field label="副标题"><input name="subtitle" defaultValue={titles.subtitle} maxLength={250} /></Field>
        <div className={styles.actions}>
          <button type="submit" className="button" disabled={busy}>显示标题</button>
          <button type="button" className="button secondary" disabled={busy || !titleVisible}
            onClick={() => patch({ titles: { titleVisible: false } })}>隐藏标题</button>
        </div>
      </form>
    </Panel>
    <Panel title="图片">
      <form className={styles.form} key={titles.pictureUrl} onSubmit={event => save(event, fields => patch({ titles: {
        pictureUrl: value(fields, 'pictureUrl'), pictureVisible: true,
      } }))}>
        <Field label="显示图片地址"><input name="pictureUrl" defaultValue={titles.pictureUrl} placeholder="https://…" required /></Field>
        <div className={styles.actions}>
          <button type="submit" className="button" disabled={busy}>显示图片</button>
          <button type="button" className="button secondary" disabled={busy || !pictureVisible}
            onClick={() => patch({ titles: { pictureVisible: false } })}>隐藏图片</button>
        </div>
      </form>
    </Panel>
    <SupplementalMediaPanel kind="svg" settings={settings} patch={patch} busy={busy} />
    <SupplementalMediaPanel kind="video" settings={settings} patch={patch} busy={busy} />
  </div>;
}

function SupplementalMediaPanel({ kind, settings: { titles }, patch, busy }: SettingsProps & { kind: 'svg' | 'video' }) {
  const title = kind === 'svg' ? 'SVG 图层' : '视频';
  const urlKey = kind === 'svg' ? 'svgUrl' : 'videoUrl';
  const visibleKey = kind === 'svg' ? 'svgVisible' : 'videoVisible';
  return <Panel title={title}>
    <form className={styles.form} key={titles[urlKey]} onSubmit={event => save(event, fields => patch({ titles: {
      [urlKey]: value(fields, 'url').trim(), [visibleKey]: true,
    } }))}>
      <Field label={`${title}地址`}><input name="url" defaultValue={titles[urlKey]} maxLength={2048} placeholder="https://…" required /></Field>
      <div className={styles.actions}>
        <button type="submit" className="button" disabled={busy}>显示{title}</button>
        <button type="button" className="button secondary" disabled={busy || !titles[visibleKey]}
          onClick={() => patch({ titles: { [visibleKey]: false } })}>隐藏{title}</button>
      </div>
    </form>
  </Panel>;
}

function tickerPreset(id: string, part: ContestLiveTickerMessage['part'], mode: ContestLiveTickerMessage['mode'], clock: ContestLiveSettings['clock']): ContestLiveTickerMessage {
  return { id, part, mode, periodMs: 30_000, shown: false, text: '', imageUrl: '', from: 1, to: 12, clock };
}

function TickerEntry({ message, update, remove, busy }: {
  message: ContestLiveTickerMessage; update: (message: ContestLiveTickerMessage) => void; remove: () => void; busy: boolean;
}) {
  const { mode, clock } = message;
  return <details className={styles.tickerEntry} data-shown={message.shown || undefined}>
    <summary>{tickerModes[mode]} · {mode === 'text' && message.text ? message.text + ' · ' : ''}{message.periodMs} ms · {message.shown ? '已启用' : '已隐藏'}</summary>
    <form key={JSON.stringify(message)} className={styles.form} onSubmit={event => save(event, fields => update({
      ...message, periodMs: Number(fields.get('periodMs')),
      ...(mode === 'text' && { text: value(fields, 'text') }),
      ...(mode === 'image' && { imageUrl: value(fields, 'imageUrl') }),
      ...(mode === 'scoreboard' && { from: Number(fields.get('from')), to: Number(fields.get('to')) }),
      ...(mode === 'clock' && { clock: { mode: value(fields, 'clockMode') as typeof clock.mode, showSeconds: fields.has('showSeconds'), timezone: value(fields, 'timezone') } }),
    }))}>
      <Field label="轮播时长（毫秒）"><input type="number" name="periodMs" min={1000} max={600000} required defaultValue={message.periodMs} /></Field>
      {mode === 'text' && <Field label="滚动文字"><input name="text" defaultValue={message.text} maxLength={4000} /></Field>}
      {mode === 'image' && <Field label="图片地址"><input name="imageUrl" defaultValue={message.imageUrl} placeholder="https://…" /></Field>}
      {mode === 'scoreboard' && <div className={styles.fields}>
        <Field label="起始名次"><input name="from" type="number" min={1} max={10000} defaultValue={message.from} required /></Field>
        <Field label="结束名次"><input name="to" type="number" min={1} max={10000} defaultValue={message.to} required /></Field>
      </div>}
      {mode === 'clock' && <div className={styles.fields}>
        <Field label="时钟模式"><select name="clockMode" defaultValue={clock.mode}><Options values={clockModes} /></select></Field>
        <Field label="时区"><input name="timezone" defaultValue={clock.timezone} required /></Field>
        <Check name="showSeconds" label="显示秒数" checked={clock.showSeconds} />
      </div>}
      <div className={styles.actions}>
        <button type="submit" className="button" disabled={busy}>保存</button>
        <button type="button" className="button secondary" disabled={busy}
          onClick={() => update({ ...message, shown: !message.shown })}>{message.shown ? '隐藏消息' : '显示消息'}</button>
        <button type="button" className="button secondary" disabled={busy} onClick={remove}><Trash2 size={15} aria-hidden />删除</button>
      </div>
    </form>
  </details>;
}

export function TickerPanel({ settings, patch, busy }: SettingsProps) {
  const { ticker, widgets, clock } = settings;
  const legacyDuration = Math.round(ticker.speed * 1000);
  const messages = ticker.messages ?? [
    { ...tickerPreset('legacy-clock', 'short', 'clock', clock), shown: true, periodMs: legacyDuration },
    { ...tickerPreset('legacy-message', 'long', ticker.mode, clock), shown: true, periodMs: legacyDuration,
      text: ticker.text, imageUrl: ticker.imageUrl, to: Math.min(12, settings.scoreboard.limit) },
  ];
  const setMessages = (next: ContestLiveTickerMessage[]) => patch({ ticker: { messages: next } });
  return <>
    <Panel title="滚动条"><Check label="在直播中显示滚动条" checked={widgets.ticker} disabled={busy}
      onChange={shown => patch({ widgets: { ticker: shown } })} /></Panel>
    <div className={styles.panels}>
      {(['short', 'long'] as const).map(part => <Panel key={part} title={part === 'short' ? '短栏' : '长栏'}>
        <div className={styles.actions}>
          {(Object.entries(tickerModes) as [ContestLiveTickerMessage['mode'], string][]).filter(([mode]) => part === 'long' || mode !== 'scoreboard')
            .map(([mode, label]) => <button key={mode} className="button secondary" type="button" disabled={busy || messages.length >= 32}
              onClick={() => setMessages([...messages, tickerPreset(String(Date.now()) + '-' + Math.random().toString(36).slice(2), part, mode, clock)])}>
              <Plus size={15} aria-hidden />{label}
            </button>)}
        </div>
        {messages.filter(message => message.part === part).map(message => <TickerEntry key={message.id}
          message={message} busy={busy} update={updated => setMessages(messages.map(item => item.id === updated.id ? updated : item))}
          remove={() => setMessages(messages.filter(item => item.id !== message.id))} />)}
      </Panel>)}
    </div>
  </>;
}

const teamPositions = {
  single: ['主画面'],
  pvp: ['上方', '下方'],
  split: ['左上', '右上', '左下', '右下'],
} as const;
const teamModeIcons = { single: Monitor, pvp: Columns2, split: Grid2X2 };
const mediaChoices = ['screen', 'camera', 'photo', 'empty'] as const;
const teamNameOrder = new Intl.Collator('zh-CN', { numeric: true });

export function TeamViewPanel({ response, patch, busy }: ResponseProps) {
  const { settings, contest: { teams } } = response;
  const [mode, setMode] = useState(settings.teamMode);
  const [query, setQuery] = useState('');
  const [teamId, setTeamId] = useState('');
  const [primary, setPrimary] = useState<ContestLiveTeamSlot['primary']>('auto');
  const [secondary, setSecondary] = useState<ContestLiveTeamSlot['secondary']>('empty');
  const [showTaskStatus, setShowTaskStatus] = useState(true);
  const [showTimeLine, setShowTimeLine] = useState(true);
  const [batch, setBatch] = useState(false);
  const [draft, setDraft] = useState<Array<ContestLiveTeamSlot | null> | null>(null);
  const count = contestLiveTeamSlotCount[mode];
  const legacyPrimary = settings.mediaMode === 'both' ? 'auto' : settings.mediaMode;
  const active = settings.teamSlots ?? settings.selectedTeamIds.map(id => ({
    teamId: id, primary: legacyPrimary, secondary: settings.mediaMode === 'both' ? 'camera' : 'empty',
  } satisfies ContestLiveTeamSlot));
  const slots = Array.from({ length: count }, (_, index) => (draft ?? (mode === settings.teamMode ? active : []))[index] ?? null);
  const teamsById = new Map(teams.map(team => [team.id, team]));
  const choices = teams.filter(team => matchesTeam(team, query.trim().toLowerCase())).sort((a,b) => teamNameOrder.compare(a.name, b.name));
  function change(position: number, slot: ContestLiveTeamSlot | null) {
    const next = slots.map((entry, index) => index === position ? slot : entry);
    if (batch) setDraft(next);
    else patch({ teamMode: mode, teamSlots: next });
  }
  return <div className={styles.teamDirector}>
    <Panel title="队伍画面">
      <div className={styles.teamLayout} aria-label="画面布局">
        {(Object.keys(teamModes) as Array<keyof typeof teamModes>).map(layout => {
          const Icon = teamModeIcons[layout];
          return <button key={layout} type="button" aria-pressed={layout === mode} disabled={busy}
            onClick={() => { setMode(layout); setDraft(null); }}><Icon size={17} aria-hidden="true" />{teamModes[layout]}</button>;
        })}
      </div>
      <div className={styles.teamFieldSet}>
        <div role="group" aria-label="主媒体">
          <p>主媒体</p><div className={styles.teamLayout}>
            {(['auto', ...mediaChoices] as const).map(item => <button key={item} type="button" aria-pressed={primary === item}
              onClick={() => setPrimary(item)}>{mediaLabels[item]}</button>)}
          </div>
        </div>
        <div role="group" aria-label="辅助媒体">
          <p>辅助媒体</p><div className={styles.teamLayout}>
            {mediaChoices.map(item => <button key={item} type="button" aria-pressed={secondary === item}
              onClick={() => setSecondary(item)}>{mediaLabels[item]}</button>)}
          </div>
        </div>
        <div className={styles.actions}>
          <Check label="显示答题状态" checked={showTaskStatus} onChange={setShowTaskStatus} />
          {mode !== 'split' && <Check label="显示提交时间线" checked={showTimeLine} onChange={setShowTimeLine} />}
        </div>
      </div>
      <div className={styles.teamPositions} data-layout={mode}>
        {teamPositions[mode].map((label, index) => {
          const slot = slots[index];
          const selected = slot ? teamsById.get(slot.teamId) : null;
          return <div className={styles.teamPosition} key={label} data-active={slot !== null || undefined} aria-label={label} role="group">
            <strong>{label}</strong>
            <span>{selected?.name || '无队伍'}</span>
            {slot && <small>{mediaLabels[slot.primary]}{slot.secondary !== 'empty' ? ' · ' + mediaLabels[slot.secondary] : ''}</small>}
            <div className={styles.actions}>
              <button className="button" type="button" disabled={busy || !teamsById.has(teamId)}
                onClick={() => change(index, { teamId, primary, secondary, showTaskStatus, showTimeLine })}>{slot ? '替换此位置' : '在此位置播出'}</button>
              <button className="button secondary" type="button" disabled={busy || !slot}
                onClick={() => change(index, null)}>隐藏</button>
            </div>
          </div>;
        })}
      </div>
      <div className={styles.actions}>
        <Check label="批量调整" checked={batch} disabled={busy} onChange={value => { setBatch(value); setDraft(null); }} />
        {batch && <button className="button" type="button" disabled={busy || !draft} onClick={() => {
          patch({ teamMode: mode, teamSlots: slots });
          setDraft(null);
        }}>播出全部</button>}
        <button className="button secondary" type="button" disabled={busy || !active.some(Boolean)} onClick={() => {
          setDraft(null);
          patch({ teamSlots: [] });
        }}>隐藏全部</button>
      </div>
    </Panel>
    <Panel title="参赛队伍">
      <Field label="搜索队伍"><input type="search" value={query} placeholder="名称、账号、学校" onChange={event => setQuery(event.target.value)} /></Field>
      <div className={styles.teamPicker}>
        {choices.length === 0 && <p className={styles.empty}>没有匹配的队伍。</p>}
        {choices.map(team => <label key={team.id} data-live={active.some(slot => slot?.teamId === team.id) || undefined}>
          <input type="radio" name="broadcast-team" checked={teamId === team.id} onChange={() => setTeamId(team.id)} />
          <span>{team.name}<small>{[team.account, team.organization, team.group].filter(Boolean).join(' · ')}</small></span>
          <span className={styles.mediaIndicators} aria-label="可用媒体">
            {team.media.screenUrl && <span>屏幕</span>}
            {team.media.cameraUrl && <span>摄像头</span>}
            {team.photoUrl && <span>照片</span>}
          </span>
        </label>)}
      </div>
    </Panel>
  </div>;
}

export function SpotlightPanel({ response, patch, busy }: ResponseProps) {
  const { contest, settings: { spotlight } } = response;
  const [selected, setSelected] = useState(spotlight.teamIds);
  const [minimum, setMinimum] = useState('');
  const [maximum, setMaximum] = useState('');
  const scores = new Map(contest.standings.map(row => [row.teamId, contest.exam.scoring === 'icpc' ? row.solved : row.score] as const));
  const eligible = contest.teams.filter(team => {
    const score = scores.get(team.id) ?? 0;
    return (minimum === '' || score >= Number(minimum)) && (maximum === '' || score <= Number(maximum));
  });
  const scoreLabel = contest.exam.scoring === 'icpc' ? '解题数' : '得分';
  return <Panel title="焦点队伍">
    <div className={styles.fields}>
      <Field label={`最低${scoreLabel}`}><input type="number" min={0} value={minimum} onChange={event => setMinimum(event.target.value)} /></Field>
      <Field label={`最高${scoreLabel}`}><input type="number" min={0} value={maximum} onChange={event => setMaximum(event.target.value)} /></Field>
    </div>
    <p className={styles.status}>{spotlight.visible ? '焦点队伍正在播出' : '焦点队伍已隐藏'}</p>
    <TeamPicker teams={eligible} selected={selected} limit={8} onChange={setSelected} />
    <div className={styles.actions}>
      <button type="button" className="button" disabled={busy || !selected.length} onClick={() => patch({ spotlight: { teamIds: selected, visible: true } })}>播出焦点队伍</button>
      <button type="button" className="button secondary" disabled={busy || !spotlight.visible} onClick={() => patch({ spotlight: { visible: false } })}>隐藏焦点队伍</button>
    </div>
  </Panel>;
}

function ScoreboardSettings({ response, patch, busy }: ResponseProps) {
  const { contest, settings: { scoreboard } } = response;
  const groups = [...new Set(contest.teams.map(team => team.group).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'zh-CN'));
  return <form className={styles.form} key={JSON.stringify(scoreboard)} onSubmit={event => save(event, fields => patch({
      scoreboard: { offset: Number(fields.get('offset')), limit: Number(fields.get('limit')), scroll: value(fields, 'scroll') as typeof scoreboard.scroll, group: value(fields, 'group'), showProblems: fields.has('showProblems'), version: value(fields, 'version') as typeof scoreboard.version },
    }))}>
      <div className={styles.fields}>
        <Field label="跳过行数"><input type="number" name="offset" min={0} max={10000} defaultValue={scoreboard.offset} required /></Field>
        <Field label="每屏队伍数"><input type="number" name="limit" min={1} max={300} defaultValue={scoreboard.limit} required /></Field>
        <Field label="自动滚动"><select name="scroll" defaultValue={scoreboard.scroll}><Options values={scrollModes} /></select></Field>
        <Field label="榜单分组"><select name="group" defaultValue={scoreboard.group || ''}><option value="">全部分组</option>{groups.map(group => <option key={group}>{group}</option>)}</select></Field>
        <Field label="榜单版本"><select name="version" defaultValue={scoreboard.version}><Options values={scoreboardVersions} /></select></Field>
      </div>
      <Check name="showProblems" label="显示每题成绩" checked={scoreboard.showProblems} />
      <div><button type="submit" className="button" disabled={busy}>应用榜单设置</button></div>
    </form>;
}

export function ScoreboardPanel({ response, patch, busy }: ResponseProps) {
  const { contest, settings: { scoreboard, widgets } } = response;
  const isIcpc = contest.exam.scoring === 'icpc';
  const showResults = !contest.exam.beforeStart;
  const teams = new Map(contest.teams.map(team => [team.id, team] as const));
  const rows = contest.standings.filter(row => !scoreboard.group || scoreboard.group === teams.get(row.teamId)?.group);
  return <>
    <Panel title="榜单设置">
      <ScoreboardSettings response={response} patch={patch} busy={busy} />
      <Check label="在直播中显示榜单" checked={widgets.scoreboard} disabled={busy} onChange={visible => patch({ widgets: { scoreboard: visible } })} />
    </Panel>
    <Panel title={showResults ? '实时榜单' : '参赛队伍'}>
      {rows.length === 0 ? <p className={styles.empty}>{showResults ? '暂无榜单记录。' : '暂无参赛队伍。'}</p> : <div className={styles.tableScroller}><table className={styles.table}>
        <thead><tr>
          {showResults && <th scope="col">排名</th>}<th scope="col">队伍</th>
          {showResults && <th scope="col">{isIcpc ? '通过' : '总分'}</th>}{showResults && isIcpc && <th scope="col">罚时</th>}
          {contest.problems.map(problem => <th key={problem.id} scope="col" title={problem.name}>{problem.label}</th>)}
        </tr></thead>
        <tbody>{rows.map(row => {
          const team = teams.get(row.teamId);
          const cells = new Map(row.cells.map(cell => [cell.problemId, cell] as const));
          return <tr key={row.teamId}>
            {showResults && <td>{row.rank ?? '—'}</td>}<td>{team?.name || '—'}</td>
            {showResults && <td>{isIcpc ? row.solved : row.score}</td>}{showResults && isIcpc && <td>{Math.floor(row.penaltySeconds / 60)} 分钟</td>}
            {contest.problems.map(problem => {
              const cell = cells.get(problem.id);
              const result = cell?.accepted ? 'accepted' : cell?.pending ? 'pending' : cell?.wrong ? 'wrong' : undefined;
              const label = !cell ? '—' : cell.pending ? `${cell.pending} 待评` : !isIcpc ? cell.score ?? '—' : cell.accepted ? `${duration(cell.seconds)}${cell.firstBlood ? ' 首解' : ''}` : cell.wrong ? `${cell.wrong} 次未通过` : '—';
              return <td key={problem.id} data-result={result}>{label}</td>;
            })}
          </tr>;
        })}</tbody>
      </table></div>}
    </Panel>
  </>;
}

export function AnalyticsPanel({ response, patch, busy }: ResponseProps) {
  const { contest, settings: { analytics } } = response;
  const [query, setQuery] = useState('');
  const [page, setPage] = useState(0);
  const [selection, setSelection] = useState(analytics.submissionId || '');
  const [annotation, setAnnotation] = useState(analytics.annotation);
  const teams = useMemo(() => new Map(contest.teams.map(team => [team.id, team] as const)), [contest.teams]);
  const problems = useMemo(() => new Map(contest.problems.map(problem => [problem.id, problem] as const)), [contest.problems]);
  const keyword = query.trim().toLowerCase();
  const submissions = contest.submissions.filter(submission => {
    const name = teams.get(submission.teamId)?.name;
    const problem = problems.get(submission.problemId);
    return [name, problem?.label, problem?.name, submission.id, submission.verdict, verdictText(submission.verdict)].some(field => field?.toLowerCase().includes(keyword));
  }).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
  const pageSize = 50;
  const pages = Math.max(1, Math.ceil(submissions.length / pageSize));
  const selected = contest.submissions.find(submission => submission.id === selection);
  const currentPage = Math.min(page, pages - 1);

  return <>
    <Panel title="提交分析">
      <Field label="搜索提交"><input type="search" value={query} placeholder="队伍、题号、提交编号或结果" onChange={event => { setQuery(event.target.value); setPage(0); }} /></Field>
      {submissions.length === 0 ? <p className={styles.empty}>没有匹配的提交。</p> : <div className={styles.tableScroller}><table className={styles.table}>
        <thead><tr><th scope="col">选中</th><th scope="col">队伍</th><th scope="col">题目</th><th scope="col">赛时</th><th scope="col">结果</th><th scope="col">得分</th></tr></thead>
        <tbody>{submissions.slice(currentPage * pageSize, (currentPage + 1) * pageSize).map(submission => <tr key={submission.id} data-highlighted={selection === submission.id || undefined}>
          <td><input type="radio" name="submission" aria-label={`选择提交 ${submission.id}`} checked={selection === submission.id} onChange={() => setSelection(submission.id)} /></td>
          <td>{teams.get(submission.teamId)?.name || '—'}</td><td>{problems.get(submission.problemId)?.label || '—'}</td><td>{duration(submission.seconds)}</td>
          <td>{verdictText(submission.verdict)}{submission.firstBlood ? ' · 首解' : ''}</td><td>{submission.score ?? '—'}</td>
        </tr>)}</tbody>
      </table></div>}
      {pages > 1 && <div className={styles.actions}>
        <button type="button" className="button secondary" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>上一页</button>
        <span>{currentPage + 1} / {pages}</span>
        <button type="button" className="button secondary" disabled={currentPage >= pages - 1} onClick={() => setPage(currentPage + 1)}>下一页</button>
      </div>}
    </Panel>
    <Panel title="焦点提交与解说">
      {selected && <p>所选提交：{teams.get(selected.teamId)?.name} · {problems.get(selected.problemId)?.label} · {duration(selected.seconds)}</p>}
      <Field label="解说文字"><textarea value={annotation} rows={3} maxLength={500} onChange={event => setAnnotation(event.target.value)} /></Field>
      <div className={styles.actions}>
        <button type="button" className="button" disabled={busy || (!selected && !annotation.trim())} onClick={() => patch({ analytics: { submissionId: selected?.id ?? null, annotation, visible: true } })}>播出提交与解说</button>
        <button type="button" className="button secondary" disabled={busy || !analytics.visible} onClick={() => patch({ analytics: { visible: false } })}>隐藏焦点提交</button>
        <button type="button" className="button secondary" disabled={busy || !selected} onClick={() => { if (selected) patch({ selectedTeamIds: [selected.teamId], teamMode: 'single' }); }}>播出队伍画面</button>
      </div>
    </Panel>
  </>;
}

export function MediaPanel({ response, endpoint, perform, busy }: OperationProps & { response: ContestLiveResponse }) {
  const [query, setQuery] = useState('');
  const [batchMessages, setBatchMessages] = useState<string[]>([]);
  const teams = response.contest.teams.filter(team => matchesTeam(team, query.trim().toLowerCase()));

  async function sendPhoto(account: string, file: File) {
    await api(`${endpoint}/photos/${encodeURIComponent(account)}`, { method: 'PUT', body: file, headers: { 'content-type': file.type || 'application/octet-stream' } });
  }

  function upload(team: Team, file: File) {
    void perform(() => sendPhoto(team.account, file), `${team.name}的照片已上传`);
  }

  function uploadBatch(files: File[]) {
    if (!files.length) return;
    setBatchMessages([]);
    void perform(async () => {
      const normalize = (account: string) => account.trim();
      const accounts = new Map<string, Set<string>>();
      for (const team of response.contest.teams) {
        for (const alias of new Set([team.account, ...team.accounts].filter(Boolean).map(normalize))) {
          const ids = accounts.get(alias) ?? new Set<string>();
          ids.add(team.id);
          accounts.set(alias, ids);
        }
      }
      const matches = files.map(file => {
        const account = normalize(file.name.replace(/\.[^.]+$/, ''));
        return { file, account, ids: accounts.get(account) };
      });
      const counts = new Map<string, number>();
      for (const { ids } of matches) {
        if (ids?.size !== 1) continue;
        const [id] = ids;
        counts.set(id, (counts.get(id) ?? 0) + 1);
      }
      const errors: string[] = [];
      let uploaded = 0;
      for (const { file, account, ids } of matches) {
        if (!ids?.size) { errors.push(`${file.name}：找不到对应的参赛账号`); continue; }
        if (ids.size > 1) { errors.push(`${file.name}：该账号对应多个队伍`); continue; }
        const [id] = ids;
        if ((counts.get(id) ?? 0) > 1) { errors.push(`${file.name}：同一队伍选了多张照片`); continue; }
        try {
          await sendPhoto(account, file);
          uploaded += 1;
        } catch (error) {
          errors.push(`${file.name}：${error instanceof Error ? error.message : '上传失败'}`);
        }
      }
      setBatchMessages([`成功上传 ${uploaded} 张照片。`, ...errors]);
    }, '已处理所选照片');
  }

  function remove(team: Team) {
    void perform(async () => {
      await api(`${endpoint}/photos/${encodeURIComponent(team.account)}`, { method: 'DELETE' });
    }, `${team.name}的照片已删除`);
  }

  return <Panel title="队伍媒体与照片">
    <div className={styles.fields}>
      <Field label="搜索队伍"><input type="search" placeholder="队伍名称或账号" value={query} onChange={event => setQuery(event.target.value)} /></Field>
      <Field label="按账号批量上传"><input type="file" accept={acceptedPhotoTypes} multiple disabled={busy} onChange={event => {
        const files = Array.from(event.currentTarget.files || []);
        event.currentTarget.value = '';
        uploadBatch(files);
      }} /><small className={styles.status}>将文件命名为参赛账号，例如 team01.jpg。</small></Field>
    </div>
    {batchMessages.length > 0 && <div className={styles.status} role="status">{batchMessages.map(message => <div key={message}>{message}</div>)}</div>}
    {teams.length === 0 ? <p className={styles.empty}>没有匹配的队伍。</p> : <div className={styles.tableScroller}><table className={styles.table}>
      <thead><tr><th scope="col">队伍</th><th scope="col">匹配账号</th><th scope="col">电脑屏幕</th><th scope="col">前置摄像头</th><th scope="col">队伍照片</th><th scope="col">操作</th></tr></thead>
      <tbody>{teams.map(team => <tr key={team.id}>
        <td>{team.name}</td><td>{team.account || '—'}</td><td>{team.media.screenUrl ? '在线' : '—'}</td><td>{team.media.cameraUrl ? '在线' : '—'}</td>
        <td>{team.photoUrl ? <img className={styles.photo} src={team.photoUrl} alt={`${team.name}的参赛照片`} loading="lazy" /> : '—'}</td>
        <td><div className={styles.actions}>
          <label className={`button secondary ${styles.upload}`} aria-disabled={busy || !team.account}>
            <Upload size={16} aria-hidden="true" />{team.photoUrl ? '更换照片' : '上传照片'}
            <input type="file" accept={acceptedPhotoTypes} aria-label={`上传${team.name}的照片`} disabled={busy || !team.account} onChange={event => {
              const file = event.currentTarget.files?.[0];
              event.currentTarget.value = '';
              if (file) upload(team, file);
            }} />
          </label>
          {team.photoUrl && <button type="button" className="button secondary" disabled={busy} onClick={() => remove(team)}><Trash2 size={16} aria-hidden="true" />删除</button>}
        </div></td>
      </tr>)}</tbody>
    </table></div>}
  </Panel>;
}

export function ScenePresets({ endpoint, busy, perform, canApply }: OperationProps & { canApply: boolean }) {
  const [presets, setPresets] = useState<ContestLivePreset[] | null>(null);
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [selection, setSelection] = useState('');
  const selected = presets?.find(preset => preset.id === selection);
  const path = `${endpoint}/presets`;

  useEffect(() => {
    const controller = new AbortController();
    api<ContestLivePreset[]>(path, { signal: controller.signal }).then(presets => {
      if (!controller.signal.aborted) setPresets(presets);
    }).catch(error => {
      if (!controller.signal.aborted) setError(error instanceof Error ? error.message : '读取导播预设失败');
    });
    return () => controller.abort();
  }, [path]);

  function manage(action: 'save' | 'rename' | 'remove', id?: string) {
    void perform(async () => {
      const { presets } = await api<{ presets: ContestLivePreset[] }>(path, { method: 'POST', body: JSON.stringify({ action, id, ...(action === 'remove' ? {} : { name }) }) });
      setPresets(presets);
      if (action === 'remove' || !id) {
        setSelection('');
        setName('');
      }
    }, action === 'remove' ? '已删除预设' : '已保存预设');
  }

  function apply(id: string) {
    void perform(() => api<Pick<ContestLiveResponse, 'settings'>>(path, { method: 'POST', body: JSON.stringify({ action: 'apply', id }) }), '已应用导播预设');
  }

  return <Panel title="导播预设">
    {error && <p className="exam-editor-error" role="alert">{error}</p>}
    {presets === null ? !error && <p className={styles.status}>正在读取预设…</p> : <>
      <div className={styles.fields}>
        <Field label="已保存的预设"><select value={selection} onChange={event => {
          const id = event.target.value;
          setSelection(id);
          setName(presets.find(preset => preset.id === id)?.name ?? '');
        }}><option value="">新建预设</option>{presets.map(preset => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></Field>
        <Field label="预设名称"><input value={name} onChange={event => setName(event.target.value)} maxLength={60} /></Field>
      </div>
      <div className={styles.actions}>
        <button type="button" className="button" disabled={busy || !name.trim()} onClick={() => manage('save', selected?.id)}>{selected ? '用当前设置覆盖' : '保存当前导播设置'}</button>
        {selected && <>
          <button type="button" className="button secondary" disabled={busy || !canApply} onClick={() => apply(selected.id)}>应用预设</button>
          <button type="button" className="button secondary" disabled={busy || !name.trim() || name.trim() === selected.name} onClick={() => manage('rename', selected.id)}>重命名</button>
          <button type="button" className="button secondary" disabled={busy} onClick={() => manage('remove', selected.id)}><Trash2 size={16} aria-hidden="true" />删除预设</button>
        </>}
      </div>
    </>}
  </Panel>;
}

export function SourceStatus({ response, history }: { response: ContestLiveResponse; history: { refreshedAt: Date; error: string }[] }) {
  const { contest } = response;
  const summary: [string, string | number][] = [
    ['数据来源', sourceLabels[contest.exam.source]], ['开赛时间', time(contest.exam.startAt)], ['结束时间', time(contest.exam.endAt)],
    ['最近数据时间', time(contest.updatedAt)], ['队伍', contest.teams.length],
  ];
  if (!contest.exam.beforeStart) summary.push(['题目', contest.problems.length], ['已载入提交', contest.submissions.length]);
  return <>
    <Panel title="赛事数据状态">
      <dl className={styles.details}>{summary.map(([name, value]) => <div key={name}><dt>{name}</dt><dd>{value}</dd></div>)}</dl>
    </Panel>
    <Panel title="连接记录">
      <div className={styles.tableScroller}><table className={styles.table}><thead><tr><th scope="col">时间</th><th scope="col">状态</th></tr></thead>
        <tbody>{history.map(({ refreshedAt, error }, index) => <tr key={`${+refreshedAt}-${index}`}><td>{time(refreshedAt)}</td><td>{error || '已读取监考系统数据'}</td></tr>)}</tbody>
      </table></div>
    </Panel>
  </>;
}
