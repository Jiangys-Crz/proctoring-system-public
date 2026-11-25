'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowLeft, ExternalLink, Eye, EyeOff, LoaderCircle, Menu, RefreshCw } from 'lucide-react';
import type { ContestLiveResponse, ContestLiveSettingsPatch } from '@/lib/contest-live-settings';
import { api } from './api';
import { AnalyticsPanel, LiveSettings, MediaPanel, ScenePresets, ScoreboardPanel, SourceStatus, SpotlightPanel, TeamViewPanel, TickerPanel, TitlesPanel, WidgetControls, sourceLabels } from './ContestLivePanels';
import { ContestLiveFloatingPreview } from './ContestLiveFloatingPreview';
import styles from './ContestLiveAdmin.module.css';

const tabs = [
  ['controls', '导播控制'], ['settings', '直播设置'], ['titles', '字幕与广告'], ['teamview', '队伍画面'],
  ['scoreboard', '榜单'], ['ticker', '滚动条'], ['analytics', '赛事分析'], ['spotlight', '焦点队伍'],
  ['presets', '导播预设'], ['media', '媒体素材'], ['log', '数据状态'],
] as const;

type OperationResult = void | Pick<ContestLiveResponse, 'settings'>;
type RefreshResult = { refreshedAt: Date; error: string };

export function ContestLiveAdmin({ examId, examName }: { examId: string; examName: string }) {
  const params = useSearchParams();
  const tab = tabs.find(([slug]) => slug === params.get('tab'))?.[0] || 'controls';
  const examKey = encodeURIComponent(examId);
  const endpoint = `/api/exams/${examKey}/contest-live`;
  const overlayUrl = `/contest-live/${examKey}`;
  const adminUrl = `/dashboard/live/contests/${examKey}`;
  const previewUrl = `${overlayUrl}?preview=1`;
  const scoreboardPreviewUrl = `${overlayUrl}?view=scoreboard&preview=1`;
  const [data, setData] = useState<ContestLiveResponse | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [actionError, setActionError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [reload, setReload] = useState(0);
  const [history, setHistory] = useState<RefreshResult[]>([]);
  const busyRef = useRef(false);
  const requestRevision = useRef(0);
  const hasFreeze = Boolean(data?.settings.freeze.at);
  const liveUnavailable = busy || !hasFreeze;

  const applyResponse = useCallback((response: ContestLiveResponse) => {
    setData(response);
    setLoadError('');
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    let pending = false;

    function record(error: string) {
      setHistory(previous => {
        if (previous[0]?.error === error) return previous;
        return [{ refreshedAt: new Date(), error }, ...previous].slice(0, 20);
      });
    }

    async function load() {
      if (pending || busyRef.current || document.hidden) return;
      pending = true;
      const revision = requestRevision.current;
      try {
        const response = await api<ContestLiveResponse>(endpoint, { cache: 'no-store', signal: controller.signal });
        if (controller.signal.aborted || revision !== requestRevision.current) return;
        applyResponse(response);
        record(response.contest.sourceError || '');
      } catch (error) {
        if (controller.signal.aborted || revision !== requestRevision.current) return;
        const message = error instanceof Error ? error.message : '无法读取直播数据';
        setLoadError(message);
        record(message);
      } finally {
        pending = false;
      }
    }

    void load();
    const timer = setInterval(() => void load(), 5000);
    document.addEventListener('visibilitychange', load);
    return () => {
      controller.abort();
      clearInterval(timer);
      document.removeEventListener('visibilitychange', load);
    };
  }, [applyResponse, endpoint, reload]);

  async function perform(operation: () => Promise<OperationResult>, message = '已应用到直播') {
    if (busyRef.current) return false;
    busyRef.current = true;
    requestRevision.current += 1;
    setBusy(true);
    setStatus('');
    setActionError('');
    try {
      const result = await operation();
      const response = result && data ? { ...data, settings: result.settings } : await api<ContestLiveResponse>(endpoint, { cache: 'no-store' });
      applyResponse(response);
      setStatus(message);
      return true;
    } catch (error) {
      setActionError(error instanceof Error ? error.message : '直播操作失败');
      return false;
    } finally {
      setBusy(false);
      busyRef.current = false;
    }
  }

  async function patch(settings: ContestLiveSettingsPatch) {
    if (!data) return false;
    const nameChanged = settings.teamNameTemplate !== undefined && settings.teamNameTemplate !== data.settings.teamNameTemplate;
    const message = settings.freeze?.revealed ? '已保存揭晓设置，正在同步榜单'
      : nameChanged ? '已保存直播与大屏名称模板' : settings.visualConfig ? '已保存本场直播外观' : '已应用到直播';
    const saved = await perform(() => api<Pick<ContestLiveResponse, 'settings'>>(endpoint, { method: 'PATCH', body: JSON.stringify(settings) }), message);
    if (saved && (nameChanged || settings.freeze || settings.scoreboard?.version)) setReload(value => value + 1);
    return saved;
  }

  return <div className={`grid management-page ${styles.liveWorkspace}`}>
    <header className={styles.header}>
      <div>
        <Link className={styles.back} href="/dashboard/live/contests"><ArrowLeft size={16} aria-hidden="true" />返回考试列表</Link>
        <h1>{examName}</h1>
        {data && <p className={styles.status}>{sourceLabels[data.contest.exam.source]}{data.contest.exam.frozen ? ' · 已封榜' : ''}</p>}
      </div>
      <div className={styles.actions}>
        <button type="button" className="button secondary" disabled={busy} onClick={() => setReload(value => value + 1)}><RefreshCw size={16} aria-hidden="true" />刷新数据</button>
        <button type="button" className="button secondary" disabled={!hasFreeze} aria-pressed={hasFreeze && showPreview} onClick={() => setShowPreview(value => !value)}>
          {hasFreeze && showPreview ? <EyeOff size={16} aria-hidden="true" /> : <Eye size={16} aria-hidden="true" />}{hasFreeze && showPreview ? '收起预览' : '嵌入预览'}
        </button>
        {data?.settings.freeze.at && <button type="button" className="button secondary"
          disabled={busy || data.settings.freeze.revealed || Date.parse(data.settings.freeze.at) > Date.now()}
          onClick={() => patch({ freeze: { revealed: true } })}>揭晓直播榜单</button>}
        {hasFreeze ? <a className="button" href={previewUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />打开直播预览</a> : <button type="button" className="button" disabled><ExternalLink size={16} aria-hidden="true" />打开直播预览</button>}
        {hasFreeze ? <a className="button secondary" href={scoreboardPreviewUrl} target="_blank" rel="noreferrer"><ExternalLink size={16} aria-hidden="true" />打开榜单大屏</a> : <button type="button" className="button secondary" disabled><ExternalLink size={16} aria-hidden="true" />打开榜单大屏</button>}
      </div>
    </header>
    <nav className={styles.tabs} aria-label="赛事直播" data-open={menuOpen || undefined}>
      <button className={styles.tabMenu} type="button" aria-controls="contest-live-navigation"
        aria-expanded={menuOpen} aria-label="赛事直播导航" onClick={() => setMenuOpen(value => !value)}><Menu size={22} aria-hidden /></button>
      <Link className={styles.liveBrand} href={adminUrl}>ICPC Live 3</Link>
      <div className={styles.tabLinks} id="contest-live-navigation">
        {tabs.map(([slug, label]) => <Link key={slug} href={`${adminUrl}?tab=${slug}`} scroll={false}
          onClick={() => setMenuOpen(false)} aria-current={tab === slug ? 'page' : undefined}>{label}</Link>)}
      </div>
    </nav>
    {(loadError || actionError) && <div className="exam-editor-error" role="alert">{actionError || loadError}</div>}
    {data?.contest.sourceError && <div className="exam-editor-error" role="alert">数据源异常：{data.contest.sourceError}</div>}
    <p className={styles.status} role="status">{busy ? '正在应用直播操作…'
      : status === '已保存揭晓设置，正在同步榜单' && data?.settings.freeze.revealed && !data.contest.exam.frozen && !data.contest.sourceError
        ? '已揭晓直播榜单' : status}</p>
    {hasFreeze && showPreview && <ContestLiveFloatingPreview examId={examId} src={previewUrl} close={() => setShowPreview(false)} />}
    {!data && !loadError && <div className="card" role="status"><LoaderCircle size={17} aria-hidden="true" className="spin" /> 正在读取直播</div>}
    {data && <>
      {!hasFreeze && tab !== 'settings' && <div className={`card ${styles.panel}`}>
        <p>设置直播封榜时间后即可使用导播和直播预览。</p>
        <div><Link className="button" href={`${adminUrl}?tab=settings#live-freeze`} scroll={false}>设置封榜时间</Link></div>
      </div>}
      {tab === 'controls' && <WidgetControls response={data} patch={patch} busy={liveUnavailable} />}
      {tab === 'settings' && <LiveSettings response={data} overlayUrl={overlayUrl} endpoint={endpoint} patch={patch} perform={perform} busy={busy} />}
      {tab === 'scoreboard' && <ScoreboardPanel response={data} patch={patch} busy={liveUnavailable} />}
      {tab === 'titles' && <TitlesPanel settings={data.settings} patch={patch} busy={liveUnavailable} />}
      {tab === 'ticker' && <TickerPanel settings={data.settings} patch={patch} busy={liveUnavailable} />}
      {tab === 'teamview' && <TeamViewPanel response={data} patch={patch} busy={liveUnavailable} />}
      {tab === 'spotlight' && <SpotlightPanel response={data} patch={patch} busy={liveUnavailable} />}
      {tab === 'analytics' && <AnalyticsPanel response={data} patch={patch} busy={liveUnavailable} />}
      {tab === 'presets' && <ScenePresets endpoint={endpoint} perform={perform} busy={busy} canApply={hasFreeze} />}
      {tab === 'media' && <MediaPanel response={data} endpoint={endpoint} perform={perform} busy={busy} />}
      {tab === 'log' && <SourceStatus response={data} history={history} />}
    </>}
  </div>;
}
