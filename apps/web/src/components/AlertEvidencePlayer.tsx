'use client';

import { useEffect, useRef, useState } from 'react';

export interface AlertEvidence {
  windowStart: string;
  windowEnd: string;
  complete: boolean;
  pending: boolean;
  availableSeconds: number;
  segments: Array<{
    id: string;
    channel: string;
    objectPath: string;
    startedAt: string;
    endedAt: string | null;
    estimated?: boolean;
  }>;
}

export function evidenceStatus(evidence?: AlertEvidence) {
  if (!evidence) return '历史单段录像';
  if (evidence.complete) return '异常前 20 秒至后 20 秒 · 已保存';
  return `异常前后各 20 秒 · 已保存 ${Math.min(40, Math.floor(evidence.availableSeconds))} / 40 秒${evidence.pending ? '，等待录像补齐' : '，部分画面缺失'}`;
}

export function AlertEvidencePlayer({ evidence, fallback, className }: {
  evidence?: AlertEvidence;
  fallback?: string | null;
  className?: string;
}) {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [error, setError] = useState('');
  const videoRef = useRef<HTMLVideoElement>(null);
  const moving = useRef(false);
  const waitingForNext = useRef(false);
  const matchedIndex = evidence?.segments.findIndex((item) => item.id === activeId) ?? -1;
  const index = Math.max(0, matchedIndex);
  const segment = evidence?.segments[index];
  // Freeze this segment's signed URL while it is playing: status polling must
  // not reload a video solely because the download signature was renewed.
  const stableSource = useRef({ id: '', url: '' });
  const id = segment?.id || 'legacy';
  const latestUrl = segment?.objectPath || fallback || '';
  if (stableSource.current.id !== id || (error && latestUrl !== stableSource.current.url)) stableSource.current = { id, url: latestUrl };
  const source = stableSource.current.url;
  const start = segment && evidence ? Math.max(0, (Date.parse(evidence.windowStart) - Date.parse(segment.startedAt)) / 1000) : 0;
  const end = segment && evidence ? (Date.parse(evidence.windowEnd) - Date.parse(segment.startedAt)) / 1000 : Infinity;
  useEffect(() => {
    if (segment && activeId === null) setActiveId(segment.id);
    if (waitingForNext.current && evidence && index + 1 < evidence.segments.length) {
      waitingForNext.current = false;
      moving.current = true;
      setActiveId(evidence.segments[index + 1].id);
    }
  }, [index, evidence?.segments.length, segment?.id, activeId]);
  function advance() {
    if (moving.current || !evidence) return;
    videoRef.current?.pause();
    if (index + 1 < evidence.segments.length) {
      moving.current = true;
      setActiveId(evidence.segments[index + 1].id);
    } else {
      waitingForNext.current = true;
    }
  }
  return (
    <div onClick={(event) => event.stopPropagation()}>
      {source ? <video
        key={`${id}:${source}`}
        ref={videoRef}
        className={className}
        src={source}
        style={{ width: '100%', maxHeight: 360, background: '#111' }}
        controls muted playsInline autoPlay preload="metadata"
        onLoadedMetadata={(event) => {
          moving.current = false;
          setError('');
          if (start > 0) event.currentTarget.currentTime = start;
        }}
        onTimeUpdate={(event) => { if (event.currentTarget.currentTime >= end) advance(); }}
        onEnded={advance}
        onError={() => setError('该片段暂时无法播放，请刷新录像后重试。')}
      /> : <div className="muted">等待对应录像上传</div>}
      <div className="muted">{evidenceStatus(evidence)}</div>
      {error ? <div role="alert">{error}</div> : null}
      {evidence && evidence.segments.length > 1 ? <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6 }}>
        <button className="button secondary compact-button" disabled={index === 0} onClick={() => { moving.current = false; waitingForNext.current = false; setActiveId(evidence.segments[index - 1].id); }}>上一段</button>
        <span>第 {index + 1} / {evidence.segments.length} 段</span>
        <button className="button secondary compact-button" disabled={index + 1 >= evidence.segments.length} onClick={() => { moving.current = false; waitingForNext.current = false; setActiveId(evidence.segments[index + 1].id); }}>下一段</button>
      </div> : null}
    </div>
  );
}
