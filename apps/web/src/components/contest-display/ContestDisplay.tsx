'use client';

import { memo, useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Maximize2, Minimize2 } from 'lucide-react';
import type { ContestDisplayResponse, ContestDisplayScene, ContestDisplaySettings, ContestDisplayStepOptions, ContestDisplayTransition } from '@/lib/contest-display-contract';
import { DisplayScene } from './DisplayScenes';
import styles from './ContestDisplay.module.css';

const RECONNECT_MS = 2000;
const STREAM_FALLBACK_MS = 3500;
const WAITING = 'Connecting to the presentation…';
const UNAVAILABLE = 'Presentation unavailable';
const CONNECTION_MESSAGES = new Map([
  ['大屏链接已失效', 'The presentation link has expired.'],
  ['请使用大屏访问链接或管理员预览', 'Open an authorized presentation link.'],
  ['请先在大屏管理中设置封榜时间', 'Set the scoreboard freeze time to start the presentation.'],
  ['大屏播放已暂停', 'Presentation paused'],
  ['大屏连接数量已满，请稍后重试', 'Too many presentation connections. Retrying…'],
  ['该考试暂无大屏管理', 'This contest has no presentation.'],
  ['该考试暂无大屏数据', 'No presentation data for this contest.'],
  ['大屏设置已更新，请重新同步', 'Synchronizing the presentation…'],
  ['大屏连接暂时中断，正在重新同步', 'Presentation disconnected. Reconnecting…'],
]);

function connectionMessage(message?: string) {
  return (message && CONNECTION_MESSAGES.get(message)) || UNAVAILABLE;
}

function playbackPosition(settings: ContestDisplaySettings, elapsed: number): {
  scene: ContestDisplayScene; elapsed: number; transition: ContestDisplayTransition; slot: string; properties?: ContestDisplayStepOptions['properties'];
} {
  if (!settings.autoplay || !settings.playlist.length) return { scene: settings.scene, elapsed, transition: settings.transition, slot: '' };
  const durations = settings.playlist.map((_, index) => Math.max(1, settings.playlistOptions?.[index]?.durationSeconds ?? settings.durationSeconds) * 1000);
  const cycle = durations.reduce((total, duration) => total + duration, 0);
  let position = elapsed % cycle;
  let index = 0;
  while (index < durations.length - 1 && position >= durations[index]) {
    position -= durations[index++];
  }
  return { scene: settings.playlist[index], elapsed: position,
    transition: settings.playlistOptions?.[index]?.transition ?? settings.transition, slot: `${Math.floor(elapsed / cycle)}:${index}`,
    properties: settings.playlistOptions?.[index]?.properties };
}

type DisplayFrame = { key: string; snapshot: ContestDisplayResponse; scene: ContestDisplayScene; elapsed: number };

function sameFreeze(a: ContestDisplayResponse, b: ContestDisplayResponse) {
  return a.settings.freeze.at === b.settings.freeze.at && a.settings.freeze.revealed === b.settings.freeze.revealed
    && a.contest.exam.id === b.contest.exam.id && a.contest.exam.frozen === b.contest.exam.frozen
    && a.contest.exam.freezeAt === b.contest.exam.freezeAt;
}

function transitionLength(transition: ContestDisplayTransition, speed: number) {
  return transition === 'none' ? 0 : 2000 / speed;
}

const dissolveColumns = 64;
const dissolveRows = 36;
const dissolveSteps = 100;
const dissolvePaths = Array.from({ length: dissolveSteps }, () => '');
const dissolveTileWidth = (1.002 / dissolveColumns).toFixed(5);
const dissolveTileHeight = (1.002 / dissolveRows).toFixed(5);
for (let index = 0; index < dissolveColumns * dissolveRows; index++) {
  const order = Math.sin((index + 1) * 12.9898) * 43758.5453;
  const step = Math.floor((order - Math.floor(order)) * dissolveSteps);
  const x = ((index % dissolveColumns) / dissolveColumns).toFixed(5);
  const y = (Math.floor(index / dissolveColumns) / dissolveRows).toFixed(5);
  dissolvePaths[step] += `M${x},${y}h${dissolveTileWidth}v${dissolveTileHeight}h-${dissolveTileWidth}z`;
}

const DissolveMasks = memo(function DissolveMasks({ inId, outId, throughBlack, duration }: {
  inId: string; outId: string; throughBlack: boolean; duration: number;
}) {
  const renderTiles = (phase: 'in' | 'out') => {
    const start = phase === 'in' && throughBlack ? duration / 2 : 0;
    return dissolvePaths.map((path, index) => <path key={index} d={path} className={styles.dissolveTile} data-phase={phase}
      style={{ animationDelay: `${start + (index / dissolveSteps) * duration / 2}ms` }} />);
  };
  return <svg className={styles.maskDefinitions} aria-hidden="true" width="0" height="0"><defs>
    <clipPath id={inId} clipPathUnits="objectBoundingBox">{renderTiles('in')}</clipPath>
    {throughBlack && <clipPath id={outId} clipPathUnits="objectBoundingBox">{renderTiles('out')}</clipPath>}
  </defs></svg>;
});

function useDisplayFeed(examId: string, displayKey: string | undefined) {
  const [snapshot, setSnapshot] = useState<ContestDisplayResponse | null>(null);
  const [message, setMessage] = useState(WAITING);
  const [clockOffset, setClockOffset] = useState(0);

  useEffect(() => {
    let streaming = false;
    let active = true;
    let polling = false;
    let latestRevision = -1;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const endpoint = new URL(`/api/exams/${encodeURIComponent(examId)}/contest-display`, location.origin);
    endpoint.searchParams.set('view', 'display');
    if (displayKey) endpoint.searchParams.set('key', displayKey);
    const streamUrl = new URL(endpoint);
    streamUrl.pathname = `${endpoint.pathname}/events`;
    const stream = typeof EventSource === 'undefined' ? null : new EventSource(streamUrl);

    function accept(data: ContestDisplayResponse) {
      if (!active || data.revision < latestRevision) return;
      latestRevision = data.revision;
      setClockOffset(data.serverTime - Date.now());
      setSnapshot(data);
      setMessage('');
    }

    function unavailable(reason: string) {
      if (!active) return;
      setSnapshot(null);
      setMessage(reason);
    }

    function online() {
      streaming = true;
      clearTimeout(timer);
      timer = undefined;
    }

    async function poll() {
      timer = undefined;
      if (polling) return;
      polling = true;
      try {
        const response = await fetch(endpoint, { signal: controller.signal, cache: 'no-store' });
        if (streaming || !active) return;
        const result = await response.json() as { data?: ContestDisplayResponse; message?: string };
        if (response.ok && result.data) accept(result.data);
        else unavailable(connectionMessage(result.message));
      } catch {
        if (!streaming) unavailable('Presentation disconnected. Reconnecting…');
      } finally {
        polling = false;
        if (active && !streaming) timer = setTimeout(poll, RECONNECT_MS);
      }
    }

    stream?.addEventListener('snapshot', event => {
      try {
        const data = JSON.parse((event as MessageEvent<string>).data) as ContestDisplayResponse;
        online();
        accept(data);
      } catch {
        unavailable('Could not read the presentation. Retrying…');
      }
    });
    stream?.addEventListener('settings', event => {
      try {
        const update = JSON.parse((event as MessageEvent<string>).data) as Omit<ContestDisplayResponse, 'contest'>;
        if (!active || update.revision < latestRevision) return;
        online();
        latestRevision = update.revision;
        setClockOffset(update.serverTime - Date.now());
        setSnapshot(current => {
          if (!current) return null;
          const previous = current.settings.freeze;
          const next = update.settings.freeze;
          return previous.at === next.at && previous.revealed === next.revealed ? { ...current, ...update } : null;
        });
        setMessage('Synchronizing the presentation…');
      } catch {
        unavailable('Could not read presentation settings. Retrying…');
      }
    });
    stream?.addEventListener('unavailable', event => {
      try {
        const { message: reason } = JSON.parse((event as MessageEvent<string>).data) as { message?: string };
        online();
        unavailable(connectionMessage(reason));
      } catch {
        unavailable(UNAVAILABLE);
      }
    });
    stream?.addEventListener('error', () => {
      streaming = false;
      if (!timer && !polling) timer = setTimeout(poll, RECONNECT_MS);
    });
    timer = setTimeout(poll, stream ? STREAM_FALLBACK_MS : 0);
    return () => {
      active = false;
      stream?.close();
      controller.abort();
      clearTimeout(timer);
    };
  }, [examId, displayKey]);

  return { snapshot, message, clockOffset };
}

export function ContestDisplay({ examId, displayKey }: { examId: string; displayKey?: string }) {
  const { snapshot, message, clockOffset } = useDisplayFeed(examId, displayKey);
  const root = useRef<HTMLDivElement>(null);
  const mountedAt = useRef(Date.now());
  const [localNow, setNow] = useState(mountedAt.current);
  const now = localNow + clockOffset;
  const [fullscreen, setFullscreen] = useState(false);
  const [canFullscreen, setCanFullscreen] = useState(false);
  const [fullscreenError, setFullscreenError] = useState('');
  const [controlsVisible, setControlsVisible] = useState(true);

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 100);
    setCanFullscreen(document.fullscreenEnabled);
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', update);
    let hideControls: ReturnType<typeof setTimeout>;
    function showControls() {
      clearTimeout(hideControls);
      setControlsVisible(true);
      hideControls = setTimeout(() => setControlsVisible(false), 2500);
    }
    showControls();
    document.addEventListener('pointermove', showControls);
    async function toggleByKey(event: KeyboardEvent) {
      if ((event.key === 'f' || event.key === 'F') && !event.ctrlKey && !event.metaKey && !event.altKey) {
        event.preventDefault();
        await toggle();
      }
    }
    document.addEventListener('keydown', toggleByKey);
    return () => {
      clearInterval(timer);
      clearTimeout(hideControls);
      document.removeEventListener('fullscreenchange', update);
      document.removeEventListener('keydown', toggleByKey);
      document.removeEventListener('pointermove', showControls);
    };
  }, []);

  async function toggle() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else if (root.current?.requestFullscreen) await root.current.requestFullscreen();
      setFullscreenError('');
    } catch {
      setFullscreenError('Use your browser’s full-screen mode.');
    }
  }

  const { settings } = snapshot ?? {};
  const startedAt = snapshot?.startedAt ? Date.parse(snapshot.startedAt) : mountedAt.current;
  const elapsed = Math.max(0, now - (Number.isFinite(startedAt) ? startedAt : mountedAt.current));
  const position = settings ? playbackPosition(settings, elapsed) : null;
  const hidden = !!settings?.hidden;
  const frame = snapshot && position && !hidden ? {
    key: `${position.scene}:${position.slot}`,
    snapshot: position.properties ? { ...snapshot, settings: { ...snapshot.settings, ...position.properties,
      presentationAssets: { ...snapshot.settings.presentationAssets, ...position.properties.presentationAssets } } } : snapshot,
    scene: position.scene, elapsed: position.elapsed,
  } : null;
  const previousFrame = useRef<DisplayFrame | null>(null);
  const maskId = useId();
  const [outgoing, setOutgoing] = useState<{ frame: DisplayFrame; target: string; transition: ContestDisplayTransition; duration: number } | null>(null);
  useLayoutEffect(() => {
    const previous = previousFrame.current;
    previousFrame.current = frame;
    if (!frame || (previous && !sameFreeze(previous.snapshot, frame.snapshot))) {
      setOutgoing(current => current ? null : current);
    } else if (previous && previous.key !== frame.key && position && settings) {
      const duration = transitionLength(position.transition, settings.speed);
      setOutgoing(duration ? { frame: previous, target: frame.key, transition: position.transition, duration } : null);
    }
  }, [frame, position, settings]);
  useEffect(() => {
    if (!outgoing) return;
    const timer = setTimeout(() => setOutgoing(current => current === outgoing ? null : current), outgoing.duration);
    return () => clearTimeout(timer);
  }, [outgoing]);
  const animation = outgoing && frame && frame.key === outgoing.target && sameFreeze(outgoing.frame.snapshot, frame.snapshot) ? outgoing : null;
  const throughBlack = animation?.transition === 'dissolveBlack';
  const dissolve = animation && (animation.transition === 'dissolve' || throughBlack);
  return <main ref={root} lang="en" className={styles.display} data-theme={settings?.theme || 'dark'} aria-label="XCPC Presentation">
    {frame ? <>
      {throughBlack && <div className={styles.hiddenFrame} />}
      {dissolve && <DissolveMasks key={`masks:${frame.key}`} inId={`${maskId}-in`} outId={`${maskId}-out`}
        throughBlack={throughBlack} duration={animation.duration} />}
      {animation && <div className={styles.scene} key={`outgoing:${animation.frame.key}`} aria-hidden="true" data-phase="out"
        data-theme={animation.frame.snapshot.settings.theme} data-transition={animation.transition}
        style={{ '--transition-seconds': `${animation.duration}ms`, clipPath: throughBlack ? `url("#${maskId}-out")` : undefined } as CSSProperties}>
        <DisplayScene scene={animation.frame.scene} data={animation.frame.snapshot} now={now} elapsed={animation.frame.elapsed} />
      </div>}
      <div className={styles.scene} key={frame.key} data-phase={animation ? 'in' : undefined} data-theme={frame.snapshot.settings.theme}
        data-transition={animation?.transition} style={{ '--transition-seconds': `${animation?.duration ?? 0}ms`,
          clipPath: dissolve ? `url("#${maskId}-in")` : undefined } as CSSProperties}>
        <DisplayScene scene={frame.scene} data={frame.snapshot} now={now} elapsed={frame.elapsed} />
      </div>
      {animation && ['fadeBlack', 'fadeWhite', 'flash'].includes(animation.transition) &&
        <div className={styles.transitionWash} key={`wash:${frame.key}`} data-transition={animation.transition}
          style={{ '--transition-seconds': `${animation.duration}ms` } as CSSProperties} />}
    </> : !hidden && <div className={styles.connection} role="status">{message}</div>}
    {hidden && <div className={styles.hiddenFrame} />}
    {canFullscreen && !hidden && <button type="button" className={styles.fullscreen} data-visible={controlsVisible || undefined}
      onClick={() => void toggle()} aria-label={fullscreen ? 'Exit Fullscreen' : 'Fullscreen'} title={fullscreen ? 'Exit Fullscreen (F)' : 'Fullscreen (F)'}>
      {fullscreen ? <Minimize2 aria-hidden /> : <Maximize2 aria-hidden />}
    </button>}
    {fullscreenError && !hidden && <div className={styles.fullscreenError} role="status">{fullscreenError}</div>}
  </main>;
}
