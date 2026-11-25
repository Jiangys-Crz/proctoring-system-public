'use client';

import Link from 'next/link';
import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { ArrowDown, ArrowLeft, ArrowUp, Clipboard, ExternalLink, LoaderCircle, LockOpen, Maximize, Monitor, Play, Radio, RefreshCw, RotateCcw, Square } from 'lucide-react';
import { contestDisplayChartScenes, contestDisplayScenes, contestDisplayTransitions, isContestDisplayChartScene, type ContestDisplayPresentationAssets, type ContestDisplayResponse, type ContestDisplaySavedPlan, type ContestDisplayScene, type ContestDisplaySceneProperties, type ContestDisplaySettings, type ContestDisplayStepOptions, type ContestDisplayTransition } from '@/lib/contest-display-contract';
import { api } from './api';
import styles from './ContestDisplayAdmin.module.css';

const sourceLabels = { local: '本机 XCPC', hydro: 'HydroOJ 浏览器', nova: 'NovaJudge' };
const categories: { label: string; scenes: ContestDisplayScene[] }[] = [
  { label: '榜单', scenes: ['scoreboard', 'scoreboardTimeline', 'scoreboardJudge', 'scoreboardFirstToSolve', 'scoreboardMedal', 'leaderboard', 'groupLeaderboard', 'allGroupsLeaderboard'] },
  { label: '瓷砖榜单', scenes: ['scoreboardTiles', 'scoreboardRank', 'scoreboardTeam', 'scoreboardAlphabetical'] },
  { label: '赛况', scenes: ['queue', 'judgeQueue', 'firstToSolve', 'statistics', 'problem', 'problemColors', 'awards'] },
  { label: '参赛队伍', scenes: ['team', 'teamDetail', 'teamList', 'teamPhoto', 'photoSlideshow', 'organizationList', 'organizationLogo', 'logoWall', 'fadingLogos', 'slidingLogos'] },
  { label: '时钟', scenes: ['countdown', 'polarCountdown', 'contestClock', 'clock'] },
  { label: '标识与公告', scenes: ['logo', 'logoA', 'logoB', 'imageProgression', 'promotions', 'ccs', 'title', 'message', 'blank'] },
  { label: '图表', scenes: [...contestDisplayChartScenes] },
  { label: '测试', scenes: ['testAlignment', 'testSynchronization', 'testClock', 'testFps', 'testBlueScreen', 'testChart'] },
];

type SettingsPatch = Partial<Omit<ContestDisplaySettings, 'freeze'>> & { freeze?: Partial<ContestDisplaySettings['freeze']>; restartClock?: boolean };
type Properties = ContestDisplaySceneProperties & Pick<SettingsPatch, 'speed' | 'medals'>;
type DisplayConfig = Omit<ContestDisplayResponse, 'contest' | 'charts' | 'firstSolutionHistory'>;
type PlanEntry = ContestDisplayStepOptions & { scene: ContestDisplayScene };
type HistoryOption = { id: string; name: string; endAt: string };
type AssetField = keyof ContestDisplayPresentationAssets;
const assetFields: Partial<Record<ContestDisplayScene, AssetField[]>> = {
  logo: ['logo', 'banner'], title: ['logo', 'banner'], message: ['logo', 'background'],
  logoA: ['logoA'], logoB: ['logoB'], imageProgression: ['imageProgression'], promotions: ['promotions'], ccs: ['ccsPrimary', 'ccsShadow'],
};
const assetLabels: Record<AssetField, string> = {
  logo: '赛事标识地址', banner: '横幅图地址', background: '背景图地址', logoA: 'A 组图片地址', logoB: 'B 组图片地址',
  imageProgression: '序列图地址', promotions: '宣传图地址', ccsPrimary: 'CCS 前景图地址', ccsShadow: 'CCS 背景图地址',
};
const assetLists = new Set<AssetField>(['logoA', 'logoB', 'imageProgression', 'promotions']);
const tileScenes: ContestDisplayScene[] = ['scoreboardTiles', 'scoreboardRank', 'scoreboardAlphabetical'];
const clockScenes: ContestDisplayScene[] = ['scoreboard', 'scoreboardTimeline', 'scoreboardJudge', 'scoreboardFirstToSolve', 'scoreboardMedal',
  'leaderboard', 'groupLeaderboard', 'allGroupsLeaderboard', ...tileScenes];

const beijingOffset = 8 * 60 * 60_000;
function beijingInput(value: string | null) {
  return value ? new Date(Date.parse(value) + beijingOffset).toISOString().slice(0, 19) : '';
}

function Panel({ title, className, children }: { title: string; className?: string; children: ReactNode }) {
  return <section className={`${styles.panel} ${className ?? ''}`}>
    <h2 className={styles.panelTitle}>{title}</h2>
    {children}
  </section>;
}

function SceneThumbnail({ scene }: { scene: ContestDisplayScene }) {
  if (['countdown', 'polarCountdown', 'contestClock', 'clock', 'testClock'].includes(scene)) return <span className={`${styles.thumbnail} ${styles.clockThumbnail}`} aria-hidden="true">02:41:36</span>;
  if (isContestDisplayChartScene(scene) || scene === 'testChart') return <span className={styles.thumbnail} aria-hidden="true">
    <svg viewBox="0 0 88 50" preserveAspectRatio="none">
      <path d="M10 10V41H81M10 18H81M10 27H81M10 35H81" fill="none" stroke="#777" strokeWidth=".6" />
      {['problemSummaryChart', 'languageSummaryChart', 'judgementChart', 'testChart'].includes(scene)
        ? <path d="M20 40V25m7 15V30m10 10V17m7 23V27m10 13V22m7 18V32m10 8V30m7 10V34" stroke="#6496ed" strokeWidth="5" />
        : <><path d="m11 29 15 2 13-11 12 4 13-9 16 9" fill="none" stroke="#59c575" strokeWidth="1.2" />
          <path d="m11 36 15-6 13 5 12-8 13 7 16-8" fill="none" stroke="#ce4a50" strokeWidth="1.2" /></>}
    </svg>
  </span>;
  if (scene === 'testAlignment' || scene === 'testSynchronization' || scene === 'testBlueScreen' || scene === 'testFps') {
    return <span className={`${styles.thumbnail} ${styles.diagnosticThumbnail}`} data-scene={scene} aria-hidden="true" />;
  }
  const table = ['scoreboard', 'scoreboardTimeline', 'scoreboardJudge', 'scoreboardFirstToSolve', 'scoreboardMedal', 'scoreboardAlphabetical', 'scoreboardRank', 'leaderboard', 'groupLeaderboard', 'allGroupsLeaderboard', 'queue', 'judgeQueue', 'teamList', 'organizationList'].includes(scene);
  const tiles = ['scoreboardTiles', 'scoreboardTeam', 'statistics', 'problem', 'problemColors', 'organizationLogo', 'logoWall', 'fadingLogos', 'slidingLogos', 'awards', 'firstToSolve'].includes(scene);
  return <span className={`${styles.thumbnail} ${table ? styles.tableThumbnail : tiles ? styles.tilesThumbnail : styles.titleThumbnail}`} aria-hidden="true">
    {scene === 'blank' ? null : table || tiles ? Array.from({ length: 6 }, (_, index) => <i key={index} />) : <i />}
  </span>;
}

function FreezeForm({ data, busy, patch }: { data: ContestDisplayResponse; busy: boolean; patch: (input: SettingsPatch, message: string) => void }) {
  const { freeze } = data.settings;
  const { startAt, endAt } = data.contest.exam;
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const local = String(new FormData(event.currentTarget).get('freezeAt'));
    const value = new Date(`${local}+08:00`);
    if (!Number.isNaN(+value)) patch({ freeze: { at: value.toISOString() } }, '已保存大屏封榜时间');
  }
  return <form className={styles.freezeForm} onSubmit={submit}>
    <label className={styles.field}>大屏封榜时间（北京时间）
      <input name="freezeAt" type="datetime-local" step={1} min={beijingInput(new Date(Date.parse(startAt) + 1000).toISOString())}
        max={beijingInput(new Date(Date.parse(endAt) - 1000).toISOString())} defaultValue={beijingInput(freeze.at)} required disabled={busy} />
    </label>
    <button className="button" type="submit" disabled={busy}>保存封榜时间</button>
    <button className="button secondary" type="button" disabled={busy || !freeze.at}
      onClick={() => patch({ enabled: false, freeze: { at: null } }, '已清除封榜时间并停止播放')}>清除并停止</button>
  </form>;
}

function RevealControl({ data, busy, awaitingSnapshot, onReveal }: {
  data: ContestDisplayResponse; busy: boolean; awaitingSnapshot: boolean; onReveal: () => void;
}) {
  const { freeze } = data.settings;
  const { frozen, source } = data.contest.exam;
  const reachedFreeze = !!freeze.at && Date.parse(freeze.at) <= data.serverTime;
  let message = '设置封榜时间后才能播放或生成客户端地址。';
  if (freeze.at) {
    if (freeze.revealed) {
      if (awaitingSnapshot) message = '已提交揭晓指令，正在读取最新榜单。';
      else if (data.contest.sourceError) message = '已提交揭晓指令，赛事数据暂未同步。系统将重试。';
      else if (frozen && source === 'hydro') message = '正在重新同步 HydroOJ 外榜判题结果。若长时间未恢复，请检查外榜连接和插件版本。';
      else if (frozen) message = '已提交揭晓指令，封榜结果仍在同步。';
      else message = '已揭晓大屏封榜结果。';
    } else {
      message = reachedFreeze ? '已到封榜时间，可以揭晓整张榜单。' : '到达封榜时间后可以手动揭晓榜单。';
    }
  }
  return <div className={styles.revealControl}>
    <button className="button" type="button" disabled={busy || !reachedFreeze || freeze.revealed} onClick={onReveal}>
      <LockOpen size={16} aria-hidden="true" />揭晓封榜结果
    </button>
    <p className={styles.info} role="status">{message}</p>
  </div>;
}

function readSceneProperties(form: FormData, scene: ContestDisplayScene): ContestDisplaySceneProperties {
  const fields = assetFields[scene];
  const assets = fields?.map(field => {
    const value = String(form.get(field) ?? '').trim();
    return [field, assetLists.has(field) ? value.split(/\r?\n/).map(line => line.trim()).filter(Boolean) : value];
  });
  return {
    title: String(form.get('title') ?? ''), message: String(form.get('message') ?? ''),
    theme: form.get('theme') === 'light' ? 'light' : 'dark', group: String(form.get('group') ?? ''),
    teamId: String(form.get('teamId') ?? '') || null, problemId: String(form.get('problemId') ?? '') || null,
    scroll: form.has('scroll'),
    ...(form.has('tileRows') && { tileRows: Number(form.get('tileRows')), tileColumns: Number(form.get('tileColumns')) }),
    ...(form.has('showClock') && { showClock: form.get('showClock') === 'show' }),
    ...(form.has('showLocalTime') && { showLocalTime: form.get('showLocalTime') === 'show' }),
    ...(assets && { presentationAssets: Object.fromEntries(assets) }),
  };
}

function SceneFields({ contest, settings, scene }: { contest: ContestDisplayResponse['contest']; settings: ContestDisplaySceneProperties; scene: ContestDisplayScene }) {
  const groups = [...new Set(contest.teams.map(team => team.group).filter(Boolean))];
  return <>
      <label className={styles.field}>赛事标题<input name="title" maxLength={180} defaultValue={settings.title} placeholder={contest.exam.name} /></label>
      <label className={styles.field}>公告内容<textarea name="message" rows={2} maxLength={1000} defaultValue={settings.message} /></label>
      <label className={styles.field}>队伍<select name="teamId" defaultValue={settings.teamId ?? ''}>
        <option value="">自动选择</option>
        {contest.teams.map(team => <option key={team.id} value={team.id}>{team.name}{team.organization ? ` · ${team.organization}` : ''}</option>)}
      </select></label>
      <label className={styles.field}>题目<select name="problemId" defaultValue={settings.problemId ?? ''}>
        <option value="">全部题目</option>
        {contest.problems.map(problem => <option key={problem.id} value={problem.id}>{problem.label} · {problem.name}</option>)}
      </select></label>
      <label className={styles.field}>分组<select name="group" defaultValue={settings.group}>
        <option value="">全部分组</option>
        {groups.map(group => <option key={group} value={group}>{group}</option>)}
      </select></label>
      <label className={styles.field}>颜色主题<select name="theme" defaultValue={settings.theme}><option value="dark">深色</option><option value="light">浅色</option></select></label>
      <label className={styles.check}><input type="checkbox" name="scroll" defaultChecked={settings.scroll} />榜单自动滚动</label>
      {tileScenes.includes(scene) && <>
        <label className={styles.field}>每列行数<input name="tileRows" type="number" min={1} max={24} required defaultValue={settings.tileRows ?? 14} /></label>
        <label className={styles.field}>列数<input name="tileColumns" type="number" min={1} max={4} required defaultValue={settings.tileColumns ?? 2} /></label>
      </>}
      {clockScenes.includes(scene) && <label className={styles.field}>赛事计时<select name="showClock" defaultValue={settings.showClock === false ? 'hide' : 'show'}>
        <option value="show">显示</option><option value="hide">隐藏</option>
      </select></label>}
      {scene === 'testClock' && <label className={styles.field}>本机时钟与偏移<select name="showLocalTime" defaultValue={settings.showLocalTime ? 'show' : 'hide'}>
        <option value="hide">隐藏</option><option value="show">显示</option>
      </select></label>}
      {assetFields[scene]?.map(field => {
        const value = settings.presentationAssets?.[field];
        return <label key={field} className={styles.field}>{assetLabels[field]}
          {assetLists.has(field)
            ? <textarea name={field} rows={3} maxLength={24600} defaultValue={Array.isArray(value) ? value.join('\n') : ''} placeholder="每行一个图片地址，最多 12 张" />
            : <input name={field} maxLength={2048} defaultValue={typeof value === 'string' ? value : ''} />}
        </label>;
      })}
  </>;
}

function SceneProperties({ data, scene, disabled, onApply }: { data: ContestDisplayResponse; scene: ContestDisplayScene; disabled: boolean; onApply: (properties: Properties) => void }) {
  const { settings, contest } = data;
  const showMedals = scene === 'scoreboardMedal' || scene === 'awards';
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    onApply({
      ...readSceneProperties(form, scene), speed: Number(form.get('speed')),
      ...(showMedals && { medals: { gold: Number(form.get('gold')), silver: Number(form.get('silver')), bronze: Number(form.get('bronze')) } }),
    });
  }
  return <form id="display-scene-properties" className={styles.properties} onSubmit={submit}>
    <details open={(!!assetFields[scene] || ['team', 'teamDetail', 'teamPhoto', 'groupLeaderboard', 'awards', 'scoreboardMedal'].includes(scene)) || undefined}>
      <summary>演示属性</summary>
      <fieldset disabled={disabled} aria-label="演示属性">
      <SceneFields contest={contest} settings={settings} scene={scene} />
      <label className={styles.field}>播放速度<select name="speed" defaultValue={settings.speed}>{[.25, .5, .75, 1, 1.25, 1.5, 2, 3, 4].map(speed => <option key={speed} value={speed}>{speed}×</option>)}</select></label>
      {showMedals && <>
        <div className={styles.medals}>
          {([['gold', '金牌'], ['silver', '银牌'], ['bronze', '铜牌']] as const).map(([id, name]) => <label className={styles.field} key={id}>{name}
            <input name={id} type="number" min={0} max={1000} step={1} defaultValue={settings.medals[id]} required />
          </label>)}
        </div>
        <p className={styles.medalNote}>比赛结束并解封后，按正式榜单展示奖牌。</p>
      </>}
      </fieldset>
    </details>
  </form>;
}

function planEntries(plan: Pick<ContestDisplaySettings, 'playlist' | 'playlistOptions'>): PlanEntry[] {
  return plan.playlist.map((scene, index) => ({ scene, ...plan.playlistOptions?.[index] }));
}

function compilePlan(playlist: PlanEntry[], transition: ContestDisplayTransition, durationSeconds: number) {
  return { playlist: playlist.map(entry => entry.scene),
    playlistOptions: playlist.map(({ transition, durationSeconds, properties }) =>
      transition || durationSeconds || properties ? { transition, durationSeconds, properties } : null),
    transition, durationSeconds };
}

function DisplayPlan({ data, playlist, transition, active, select, setPlaylist, setTransition, disabled, patch }: {
  data: ContestDisplayResponse; playlist: PlanEntry[]; transition: ContestDisplayTransition;
  active: number | null; select: (index: number) => void; setPlaylist: (playlist: PlanEntry[], selected: number | null) => void;
  setTransition: (transition: ContestDisplayTransition) => void; disabled: boolean; patch: (input: SettingsPatch, message: string) => void;
}) {
  const step = active === null ? null : playlist[active];
  const [baseDuration, setBaseDuration] = useState(String(data.settings.durationSeconds));
  const [planName, setPlanName] = useState('');
  const [savedName, setSavedName] = useState('');
  const savedPlans = data.settings.savedPlans ?? [];
  const savedPlan = savedPlans.find(plan => plan.name === savedName);
  const validDuration = Number.isInteger(+baseDuration) && +baseDuration >= 3 && +baseDuration <= 600;
  const canSave = playlist.length > 0 && validDuration && planName.trim() && (savedPlans.length < 20 || savedPlans.some(plan => plan.name === planName.trim()));
  function move(delta: number) {
    if (active === null || active + delta < 0 || active + delta >= playlist.length) return;
    const next = [...playlist];
    const [entry] = next.splice(active, 1);
    next.splice(active + delta, 0, entry);
    setPlaylist(next, active + delta);
  }
  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!playlist.length) {
      patch({ autoplay: false, playlist: [] }, '已清空演示计划');
      return;
    }
    patch({ enabled: true, hidden: false, autoplay: true, ...compilePlan(playlist, transition, +baseDuration),
      scene: playlist[0].scene, restartClock: true }, '已开始轮播演示计划');
  }
  function changeStep(options: ContestDisplayStepOptions) {
    const next = playlist.map((entry, index) => index === active ? { ...entry, ...options } : entry);
    setPlaylist(next, active);
  }
  function loadPlan(plan: ContestDisplaySavedPlan) {
    setPlaylist(planEntries(plan), null);
    setTransition(plan.transition);
    setBaseDuration(String(plan.durationSeconds));
    setPlanName(plan.name);
  }
  return <Panel title="演示计划" className={styles.planPanel}>
    <ol className={styles.planList}>
      {playlist.map(({ scene, transition: stepTransition, durationSeconds, properties }, index) => <li key={`${index}:${scene}`}>
        <button className={styles.tile} type="button" aria-pressed={active === index} onClick={() => select(index)}>
          <SceneThumbnail scene={scene} /><span className={styles.planStep}>{index + 1}. {contestDisplayScenes[scene]}
            {stepTransition || durationSeconds || properties ? <small>{[stepTransition && contestDisplayTransitions[stepTransition], durationSeconds && `${durationSeconds} 秒`, properties && '自定义属性'].filter(Boolean).join(' · ')}</small> : null}
          </span>
        </button>
      </li>)}
      {!playlist.length && <li className={styles.planEmpty}>从演示列表加入场景</li>}
    </ol>
    <div className={styles.planControls}>
      <button className="button secondary" type="button" title="上移" aria-label="上移" disabled={disabled || active === null || active === 0} onClick={() => move(-1)}><ArrowUp size={16} /></button>
      <button className="button secondary" type="button" title="下移" aria-label="下移" disabled={disabled || active === null || active === playlist.length - 1} onClick={() => move(1)}><ArrowDown size={16} /></button>
      <button className="button secondary" type="button" disabled={disabled || active === null} onClick={() => setPlaylist(playlist.filter((_, index) => index !== active), null)}>移除</button>
      <button className="button secondary" type="button" disabled={disabled || !playlist.length} onClick={() => setPlaylist([], null)}>全部移除</button>
    </div>
    <form className={styles.planForm} onSubmit={apply}>
      <label className={styles.field}>每场景停留（秒）<input name="duration" type="number" min={3} max={600} step={1} required
        value={baseDuration} onChange={event => setBaseDuration(event.target.value)} disabled={disabled} /></label>
      {step && <fieldset className={styles.stepFields} disabled={disabled}>
        <legend>所选场景</legend>
        <label className={styles.field}>进入转场<select value={step.transition ?? ''} onChange={event => changeStep({ transition: (event.target.value || undefined) as ContestDisplayTransition | undefined })}>
          <option value="">使用默认转场</option>
          {Object.entries(contestDisplayTransitions).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select></label>
        <label className={styles.field}>停留（秒）<input type="number" min={3} max={600} step={1} value={step.durationSeconds ?? ''}
          placeholder="使用默认时长" onChange={event => changeStep({ durationSeconds: event.target.value ? Number(event.target.value) : undefined })}
          onBlur={event => { if (event.target.value && !event.target.validity.valid) changeStep({ durationSeconds: undefined }); }} /></label>
      </fieldset>}
      <p className={styles.info}>默认转场 · {contestDisplayTransitions[transition]}</p>
      <button className="button" type="submit" disabled={disabled || (!playlist.length && !data.settings.playlist.length)}>应用演示计划</button>
    </form>
    {step && <details className={styles.savedPlans} key={active}>
      <summary>所选场景属性</summary>
      <form className={styles.properties} key={JSON.stringify(step.properties)} onSubmit={event => {
        event.preventDefault();
        changeStep({ properties: readSceneProperties(new FormData(event.currentTarget), step.scene) });
      }}>
        <fieldset aria-label="所选场景属性" disabled={disabled}>
          <SceneFields contest={data.contest} settings={{ ...data.settings, ...step.properties,
            presentationAssets: { ...data.settings.presentationAssets, ...step.properties?.presentationAssets } }} scene={step.scene} />
          <div className={styles.planControls}>
            <button className="button secondary" type="submit">保存场景属性</button>
            <button className="button secondary" type="button" disabled={!step.properties}
              onClick={() => changeStep({ properties: undefined })}>使用默认属性</button>
          </div>
        </fieldset>
      </form>
    </details>}
    <details className={styles.savedPlans}>
      <summary>已保存的演示计划</summary>
      <label className={styles.field}>已保存<select value={savedName} onChange={event => setSavedName(event.target.value)}>
        <option value="">选择演示计划</option>
        {savedPlans.map(plan => <option key={plan.name} value={plan.name}>{plan.name}</option>)}
      </select></label>
      <div className={styles.planControls}>
        <button type="button" className="button secondary" disabled={disabled || !savedPlan} onClick={() => savedPlan && loadPlan(savedPlan)}>载入</button>
        <button type="button" className="button secondary" disabled={disabled || !savedPlan}
          onClick={() => patch({ savedPlans: savedPlans.filter(plan => plan.name !== savedName) }, '已删除演示计划')}>删除</button>
      </div>
      <label className={styles.field}>计划名称<input value={planName} maxLength={80} onChange={event => setPlanName(event.target.value)} /></label>
      <button type="button" className="button secondary" disabled={disabled || !canSave} onClick={() => {
        const name = planName.trim();
        patch({ savedPlans: [...savedPlans.filter(plan => plan.name !== name), { name, ...compilePlan(playlist, transition, +baseDuration) }] }, '已保存演示计划');
        setSavedName(name);
      }}>保存计划</button>
    </details>
  </Panel>;
}

function HistorySettings({ options, stored, disabled, save }: {
  options: HistoryOption[]; stored: string[]; disabled: boolean; save: (values: string[]) => void;
}) {
  const [selection, setSelection] = useState(stored.filter(id => options.some(item => item.id === id)));
  return <details className={styles.savedPlans}>
    <summary>历史赛事来源</summary>
    <form className={styles.historyForm} onSubmit={event => { event.preventDefault(); save(selection); }}>
      {options.length ? <div className={styles.historyOptions}>
        {options.map(item => <label className={styles.check} key={item.id}>
          <input type="checkbox" checked={selection.includes(item.id)} disabled={disabled || (selection.length >= 4 && !selection.includes(item.id))}
            onChange={event => setSelection(event.target.checked ? [...selection, item.id] : selection.filter(id => id !== item.id))} />
          {item.name} · {beijingInput(item.endAt).slice(0, 10)}
        </label>)}
      </div> : <p>没有可用的历史赛事。</p>}
      <button className="button secondary" type="submit" disabled={disabled || (!selection.length && !stored.length)}>保存历史赛事</button>
    </form>
  </details>;
}

export function ContestDisplayAdmin({ examId, examName, historyOptions = [] }: { examId: string; examName: string; historyOptions?: HistoryOption[] }) {
  const examKey = encodeURIComponent(examId);
  const endpoint = `/api/exams/${examKey}/contest-display`;
  const previewPath = `/contest-display/${examKey}`;
  const [data, setData] = useState<ContestDisplayResponse | null>(null);
  const [snapshotRevision, setSnapshotRevision] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [status, setStatus] = useState('');
  const [reload, setReload] = useState(0);
  const [playbackUrl, setPlaybackUrl] = useState('');
  const [selection, setSelection] = useState<ContestDisplayScene | null>(null);
  const [transition, setTransition] = useState<ContestDisplayTransition | null>(null);
  const [draftPlaylist, setDraftPlaylist] = useState<PlanEntry[] | null>(null);
  const [selectedStep, setSelectedStep] = useState<number | null>(null);
  const [category, setCategory] = useState('');
  const stage = useRef<HTMLDivElement>(null);
  const requestClock = useRef(0);
  const locked = useRef(false);

  useEffect(() => {
    const controller = new AbortController();
    let requestRunning = false;
    async function refresh() {
      if (locked.current || requestRunning || document.hidden) return;
      requestRunning = true;
      const version = requestClock.current;
      try {
        const response = await api<ContestDisplayResponse>(endpoint, { signal: controller.signal, cache: 'no-store' });
        if (!controller.signal.aborted && version === requestClock.current) {
          setData(response);
          setSnapshotRevision(response.revision);
          setLoadError('');
          if (!response.keyActive) setPlaybackUrl('');
        }
      } catch (reason) {
        if (!controller.signal.aborted && version === requestClock.current) setLoadError(reason instanceof Error ? reason.message : '无法读取大屏配置');
      } finally {
        requestRunning = false;
      }
    }
    void refresh();
    const timer = setInterval(() => void refresh(), 5000);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [endpoint, reload]);

  async function perform(action: () => Promise<void>, message = '') {
    if (locked.current) return false;
    locked.current = true;
    requestClock.current += 1;
    setBusy(true);
    setError('');
    setStatus('');
    try {
      await action();
      setStatus(message);
      return true;
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : '无法更新大屏');
      return false;
    } finally {
      setBusy(false);
      locked.current = false;
      setReload(value => value + 1);
    }
  }

  function patch(input: SettingsPatch, message?: string) {
    if (!data) return;
    void perform(async () => {
      const result = await api<DisplayConfig>(endpoint, { method: 'PATCH', body: JSON.stringify({ ...input, expectedRevision: data.revision }) });
      setData({ ...data, ...result });
      if (!result.keyActive) setPlaybackUrl('');
      if (input.playlist) {
        setDraftPlaylist(null);
        setSelectedStep(null);
      }
    }, message);
  }

  function manageAccess(method: 'POST' | 'DELETE') {
    void perform(async () => {
      const { key, ...result } = await api<DisplayConfig & { key?: string }>(`${endpoint}/access`, { method });
      setPlaybackUrl(key ? new URL(`${previewPath}?${new URLSearchParams({ key })}`, window.location.origin).toString() : '');
      setData(currentData => currentData && { ...currentData, ...result });
    }, method === 'POST' ? '已生成客户端地址' : '客户端地址已撤销');
  }

  async function copyPlaybackUrl() {
    try {
      await navigator.clipboard.writeText(playbackUrl);
      setStatus('已复制客户端地址');
    } catch {
      const input = document.getElementById('contest-display-playback-url') as HTMLInputElement | null;
      input?.select();
      setStatus('已选中客户端地址，请复制');
    }
  }

  async function fullscreen() {
    try {
      if (!stage.current?.requestFullscreen) throw new Error('unavailable');
      await stage.current.requestFullscreen();
    } catch {
      window.open(previewPath, '_blank', 'noopener');
    }
  }

  const settings = data?.settings;
  const freezeReady = Boolean(settings?.freeze.at);
  const disabled = !freezeReady || busy;
  const current = selection ?? settings?.scene ?? 'scoreboard';
  const selectedTransition = transition ?? settings?.transition ?? 'fade';
  const playlist = draftPlaylist ?? (settings ? planEntries(settings) : []);
  const catalog = categories.filter(item => !category || item.label === category).flatMap(item => item.scenes);
  const statusText = data ? `${sourceLabels[data.contest.exam.source]} · ${settings?.enabled ? settings.hidden ? '黑屏' : settings.autoplay ? '轮播中' : contestDisplayScenes[settings.scene] : '已停止播放'}` : '';
  const showPlaybackUrl = playbackUrl && data?.keyActive && freezeReady;

  return <div className={`grid management-page ${styles.page}`}>
    <header className={styles.header}>
      <div><Link className={styles.back} href="/dashboard/live/displays"><ArrowLeft size={16} aria-hidden="true" />返回考试列表</Link><h1>{examName} · 大屏管理</h1></div>
      <div className={styles.actions}>
        <Link className="button secondary" href={`/dashboard/live/contests/${examKey}?tab=settings#team-name-template`}>设置名称模板</Link>
        {freezeReady && <a className="button secondary" href={previewPath} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />打开大屏预览</a>}
        <button type="button" className="button secondary" onClick={() => { setError(''); setReload(value => value + 1); }} disabled={busy}><RefreshCw size={16} aria-hidden="true" />刷新数据</button>
      </div>
    </header>
    {(error || loadError) && <p className="exam-editor-error" role="alert">{error || loadError}</p>}
    {data?.contest.sourceError && <p className="exam-editor-error" role="alert">赛事数据源 · {data.contest.sourceError}</p>}
    {status && <p className={styles.info} role="status">{status}</p>}
    {!data && !loadError && <p className={`card ${styles.wait}`} role="status"><LoaderCircle className="spin" size={17} />正在读取大屏配置</p>}
    {data && <>
      <section className={`card ${styles.freezeCard}`} aria-labelledby="display-freeze-title">
        <h2 id="display-freeze-title">封榜与揭晓</h2>
        <FreezeForm key={settings?.freeze.at} data={data} busy={busy} patch={patch} />
        <RevealControl data={data} busy={busy} awaitingSnapshot={snapshotRevision !== data.revision}
          onReveal={() => patch({ freeze: { revealed: true } })} />
      </section>
      <div className={styles.workspace}>
        <Panel title="播放客户端" className={styles.clientPanel}>
          <div className={styles.clientArea}>
            <div className={styles.clientCard}>
              <div className={styles.stage} ref={stage}>
                {freezeReady ? <iframe src={previewPath} title="大屏客户端预览" allow="fullscreen" allowFullScreen /> : <div className={styles.awaiting}><Monitor size={28} aria-hidden="true" />等待设置封榜时间</div>}
              </div>
              <p className={styles.clientMeta}><Monitor size={15} aria-hidden="true" />{statusText}</p>
            </div>
          </div>
          <div className={styles.clientActions}>
            <button className="button secondary" type="button" disabled={disabled} onClick={() => void fullscreen()}><Maximize size={16} aria-hidden="true" />全屏预览</button>
            <button className="button" type="button" disabled={disabled || (settings?.enabled && !settings.hidden)}
              onClick={() => patch({ enabled: true, hidden: false }, '已启用大屏客户端播放')}><Play size={16} aria-hidden="true" />{settings?.enabled && settings.hidden ? '重新显示' : '启用播放'}</button>
            <button className="button secondary" type="button" disabled={disabled || !settings?.enabled} onClick={() => patch({ enabled: false }, '已停止大屏客户端播放')}><Square size={16} aria-hidden="true" />停止播放</button>
            <button className="button secondary" type="button" disabled={disabled || settings?.hidden}
              onClick={() => patch({ enabled: true, hidden: true }, '客户端已切换为黑屏')}>黑屏</button>
            <button className="button secondary" type="button" disabled={disabled}
              onClick={() => patch({ restartClock: true }, '已同步所有大屏的场景计时')}><RotateCcw size={15} aria-hidden />重置场景计时</button>
          </div>
          <div className={styles.linkPanel}>
            <h3>客户端地址</h3>
            <div className={styles.actions}>
              <button type="button" className="button secondary" disabled={disabled} onClick={() => manageAccess('POST')}><Radio size={16} aria-hidden="true" />{data.keyActive ? '重新生成地址' : '生成地址'}</button>
              <button type="button" className="button secondary" disabled={busy || !data.keyActive} onClick={() => manageAccess('DELETE')}>撤销地址</button>
            </div>
            {showPlaybackUrl && <div className={styles.address}>
              <input id="contest-display-playback-url" aria-label="大屏客户端地址" readOnly type="text" value={playbackUrl} onFocus={event => event.currentTarget.select()} />
              <button type="button" className="button secondary" onClick={() => void copyPlaybackUrl()}><Clipboard size={16} aria-hidden="true" />复制地址</button>
            </div>}
            <p className={styles.info}>在大屏电脑用浏览器打开客户端地址，点击画面进入全屏。</p>
          </div>
        </Panel>
        <div className={styles.catalogColumn}>
          <Panel title="演示列表">
            <label className={styles.field}>演示分类<select value={category} onChange={event => setCategory(event.target.value)}>
              <option value="">全部演示</option>{categories.map(item => <option value={item.label} key={item.label}>{item.label}</option>)}
            </select></label>
            <div className={styles.sceneGrid} aria-label="演示场景">
              {catalog.map(scene => <button className={styles.tile} key={scene} type="button" aria-pressed={current === scene} onClick={() => setSelection(scene)}>
                <SceneThumbnail scene={scene} /><span>{contestDisplayScenes[scene]}</span>
              </button>)}
            </div>
            <SceneProperties key={JSON.stringify([current, settings?.title, settings?.message, settings?.teamId, settings?.problemId, settings?.group, settings?.theme, settings?.speed, settings?.scroll, settings?.medals, settings?.tileRows, settings?.tileColumns, settings?.showClock, settings?.showLocalTime, settings?.presentationAssets])} data={data} scene={current} disabled={disabled}
              onApply={properties => patch({ ...properties, scene: current, enabled: true, hidden: false, autoplay: false, transition: selectedTransition, restartClock: true }, '已应用当前演示')} />
            {(current === 'historicalComparisonChart' || current === 'firstToSolve') && <HistorySettings
              key={JSON.stringify(settings?.historyExamIds)} options={historyOptions} stored={settings?.historyExamIds ?? []} disabled={busy}
              save={historyExamIds => patch({ historyExamIds }, '已保存历史赛事来源')} />}
            <div className={styles.catalogActions}>
              <button className="button secondary" type="button" disabled={disabled || playlist.length >= 100}
                onClick={() => { setDraftPlaylist([...playlist, { scene: current }]); setSelectedStep(playlist.length); }}>加入演示计划</button>
              <button className="button" form="display-scene-properties" type="submit" disabled={disabled}>立即应用</button>
            </div>
          </Panel>
          <Panel title="转场效果">
            <div className={styles.transitionGrid} aria-label="转场效果">
              {(Object.entries(contestDisplayTransitions) as [ContestDisplayTransition, string][]).map(([id, name]) => <button className={styles.tile} key={id} type="button" aria-pressed={selectedTransition === id}
                onClick={() => setTransition(id)}><span className={styles.transitionSample} data-transition={id} aria-hidden="true" /><span>{name}</span></button>)}
            </div>
            <div className={styles.catalogActions}>
              <button className="button secondary" type="button" disabled={disabled || selectedStep === null || !playlist[selectedStep]}
                onClick={() => setDraftPlaylist(playlist.map((entry, index) => index === selectedStep ? { ...entry, transition: selectedTransition } : entry))}>将转场加入所选场景</button>
            </div>
          </Panel>
        </div>
        <DisplayPlan key={settings?.durationSeconds} data={data} playlist={playlist} transition={selectedTransition} active={selectedStep} select={setSelectedStep} disabled={disabled} patch={patch}
          setTransition={setTransition}
          setPlaylist={(scenes, step) => { setDraftPlaylist(scenes); setSelectedStep(step); }} />
      </div>
    </>}
  </div>;
}
