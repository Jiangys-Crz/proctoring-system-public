'use client';

import isPropValid from '@emotion/is-prop-valid';
import { StyleSheetManager } from 'styled-components';
import isEqual from 'lodash/isEqual';
import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { Provider, batch } from 'react-redux';
import type { ContestLiveResponse } from '@/lib/contest-live-settings';
import { makeOverlaySnapshot } from './adapter';
import { createOverlayQueue } from './queueFeed';
import { OptimismLevel } from './api';
import type { OrderedWidget } from './api';
import { StatusLayout } from './components/layouts/StatusLayout';
import { initializeOverlayConfig } from './config';
import type { OverlayConfig } from './config.interface';
import { resolveBroadcastVisualConfig } from './visualConfig';
import { setInfo } from './redux/contest/contestInfo';
import { setFromSnapshot } from './redux/contest/queue';
import { handleScoreboardDiff } from './redux/contest/scoreboard';
import { setStatistics } from './redux/contest/statistics';
import { contestDataConnection, WebsocketStatus, setWebsocketStatus } from './redux/status';
import { createOverlayStore, setTimeline, type OverlayStore } from './redux/store';
import { setMessages, stopScrolling } from './redux/ticker';
import { setWidgets } from './redux/widgets';
import styles from './overlay.module.css';

const MainLayout = lazy(() => import('./components/layouts/MainLayout'));

export type OverlayPageProps = {
  examId: string;
  accessKey?: string;
  preview: boolean;
  noStatus: boolean;
  scoreboardOnly: boolean;
};

const updateStatus = (store: OverlayStore, state: WebsocketStatus) =>
  store.dispatch(setWebsocketStatus(contestDataConnection, state));

type Snapshot = ReturnType<typeof makeOverlaySnapshot>;

function preserveWidgetOrder(widgets: OrderedWidget[], previous: OrderedWidget[] = []) {
  const order = new Map(previous.map((item, index) => [item.widget.widgetId, index]));
  return widgets.map((item, index) => ({
    ...item,
    showOrder: order.get(item.widget.widgetId) ?? previous.length + index,
  })).sort((a, b) => a.showOrder - b.showOrder).map((item, showOrder) => ({ ...item, showOrder }));
}

function applySnapshot(store: OverlayStore, current: Snapshot, previous: Snapshot | undefined) {
  const { dispatch } = store;
  batch(() => {
    if (!isEqual(previous?.contestInfo, current.contestInfo)) void dispatch(setInfo(current.contestInfo));
    if (!isEqual(previous?.queue, current.queue)) void dispatch(setFromSnapshot(current.queue));
    if (previous?.scoreboardVersion !== current.scoreboardVersion || !isEqual(previous?.standings, current.standings)) {
      dispatch(handleScoreboardDiff({ optimism: OptimismLevel.normal, diff: current.standings }));
      if (current.scoreboardVersion !== OptimismLevel.normal) {
        dispatch(handleScoreboardDiff({ optimism: current.scoreboardVersion, diff: current.standings }));
      }
    }
    if (!isEqual(previous?.statistics, current.statistics)) dispatch(setStatistics(current.statistics));
    if (!isEqual(previous?.timeline, current.timeline)) dispatch(setTimeline(current.timeline));
    if (!isEqual(previous?.ticker, current.ticker)) void dispatch(setMessages(current.ticker));
    if (!isEqual(previous?.widgets, current.widgets)) void dispatch(setWidgets(current.widgets));
  });
}

function canvasScale() {
  return Math.min(window.innerWidth / 1920, window.innerHeight / 1080);
}

export default function OverlayPage({ examId, accessKey, preview, noStatus, scoreboardOnly }: OverlayPageProps) {
  const params = useSearchParams();
  const scene = params.get('visualConfigScene');
  const forced = params.get('forceVisualConfig');
  const store = useMemo(() => createOverlayStore(), [examId, accessKey, preview, scoreboardOnly]);
  const [scale, setScale] = useState(canvasScale);
  const [notice, setNotice] = useState('Connecting to ICPC Live…');
  const [appearance, setAppearance] = useState<OverlayConfig | null>(null);

  useEffect(() => {
    const resize = () => setScale(canvasScale());
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);

  useEffect(() => {
    const url = new URL(`/api/exams/${encodeURIComponent(examId)}/contest-live`, window.location.origin);
    if (scoreboardOnly) url.searchParams.set('view', 'scoreboard');
    url.searchParams.set('overlay', '1');
    if (accessKey) url.searchParams.set('key', accessKey);
    if (preview) url.searchParams.set('preview', '1');

    let stopped = false;
    let controller: AbortController | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let previous: Snapshot | undefined;
    let previousVisual: ContestLiveResponse['settings']['visualConfig'] | undefined;
    const overlayQueue = createOverlayQueue();
    updateStatus(store, WebsocketStatus.CONNECTING);

    async function poll() {
      let pollDelay = 2_000;
      controller = new AbortController();
      const timeout = setTimeout(() => controller?.abort(), 12_000);
      try {
        const response = await fetch(url, {
          cache: 'no-store',
          signal: controller.signal,
          referrerPolicy: 'no-referrer',
        });
        if (stopped) return;
        if ([401, 403, 404, 409].includes(response.status)) {
          void store.dispatch(setWidgets([]));
          previous = undefined;
          previousVisual = undefined;
          setAppearance(null);
          overlayQueue.reset();
        }
        const result = await response.json() as { ok: true; data: ContestLiveResponse } | { ok: false };
        if (stopped) return;
        if (!response.ok || !result.ok) {
          updateStatus(store, WebsocketStatus.DISCONNECTED);
          setNotice(response.status === 401 || response.status === 403
            ? 'This live overlay is not available with the current access.'
            : 'The live overlay is unavailable.');
          return;
        }
        const now = Date.now(), { settings, contest } = result.data;
        const visual = settings.visualConfig ?? {};
        if (!isEqual(visual, previousVisual)) {
          const next = resolveBroadcastVisualConfig(visual, scene, forced);
          if (!initializeOverlayConfig(next)) {
            // Recreate module-scoped styled components with the new configuration.
            // Reloading this browser source retains its preview, OBS key and scene.
            window.location.reload();
            stopped = true;
            return;
          }
          previousVisual = visual;
          setAppearance(next);
        }
        if (!scoreboardOnly && settings.widgets.queue && !contest.sourceError && now >= Date.parse(contest.exam.startAt) && now < Date.parse(contest.exam.endAt)) {
          pollDelay = 1_000;
        }
        const queue = scoreboardOnly ? [] : overlayQueue.select(contest,
          settings.analytics.visible ? settings.analytics.submissionId : null, now);
        const current = makeOverlaySnapshot(result.data, now, scoreboardOnly, queue);
        current.widgets = preserveWidgetOrder(current.widgets, previous?.widgets);
        applySnapshot(store, current, previous);
        previous = current;
        updateStatus(store, result.data.contest.sourceError ? WebsocketStatus.DISCONNECTED : WebsocketStatus.CONNECTED);
        setNotice(result.data.contest.sourceError ? 'Contest data is temporarily unavailable.' : '');
      } catch {
        if (stopped) return;
        updateStatus(store, WebsocketStatus.DISCONNECTED);
        setNotice('Connection lost. Retrying…');
      } finally {
        clearTimeout(timeout);
        if (!stopped) timer = setTimeout(poll, pollDelay);
      }
    }

    void poll();
    return () => {
      stopped = true;
      controller?.abort();
      clearTimeout(timer);
      void store.dispatch(stopScrolling());
    };
  }, [examId, accessKey, preview, scoreboardOnly, store, scene, forced]);

  return (
    <Provider store={store}>
      <StyleSheetManager shouldForwardProp={(prop, element) => typeof element !== 'string' || isPropValid(prop)}>
        {appearance?.EXTRA_CSS && <style>{appearance.EXTRA_CSS}</style>}
        <div className={styles.canvas} style={{ transform: `scale(${scale})` }}>
          {appearance && <Suspense fallback={null}><MainLayout noStatus={noStatus} /></Suspense>}
          {!noStatus && <StatusLayout />}
        </div>
        {notice && (!noStatus || preview) && <p role="status" className={styles.notice}>{notice}</p>}
      </StyleSheetManager>
    </Provider>
  );
}
