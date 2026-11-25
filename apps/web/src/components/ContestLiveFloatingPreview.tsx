'use client';

import { useEffect, useRef, useState, type PointerEvent } from 'react';
import { Grip, X } from 'lucide-react';
import styles from './ContestLiveAdmin.module.css';

type Position = { x: number; y: number; width: number };
const ratio = 16 / 9;
const titleHeight = 29;

function constrain(position: Position): Position {
  const availableWidth = Math.max(1, Math.min(window.innerWidth, (window.innerHeight - titleHeight) * ratio));
  const width = Math.max(Math.min(225, availableWidth), Math.min(position.width, availableWidth));
  return {
    width,
    x: Math.max(0, Math.min(position.x, window.innerWidth - width)),
    y: Math.max(0, Math.min(position.y, window.innerHeight - titleHeight - width / ratio)),
  };
}

export function ContestLiveFloatingPreview({ examId, src, close }: { examId: string; src: string; close: () => void }) {
  const key = `contest-live-preview:${examId}`;
  const [position, setPosition] = useState<Position | null>(null);
  const positionRef = useRef<Position | null>(null);
  const drag = useRef<{ mode: 'move' | 'resize'; pointer: number; x: number; y: number; origin: Position } | null>(null);

  useEffect(() => {
    let restored: Position = { x: 0, y: 0, width: 576 };
    try {
      const saved = JSON.parse(localStorage.getItem(key) ?? 'null');
      if (saved && [saved.x, saved.y, saved.width].every(Number.isFinite)) restored = saved;
    } catch { /* Storage can be disabled for a browser profile. */ }
    const resize = () => {
      positionRef.current = constrain(positionRef.current ?? restored);
      setPosition(positionRef.current);
    };
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, [key]);

  function start(event: PointerEvent<HTMLElement>, mode: 'move' | 'resize') {
    const origin = positionRef.current;
    if (!origin || event.button !== 0) return;
    drag.current = { mode, pointer: event.pointerId, x: event.clientX, y: event.clientY, origin };
    event.currentTarget.setPointerCapture(event.pointerId);
  }

  function move(event: PointerEvent<HTMLElement>) {
    const active = drag.current;
    if (!active || active.pointer !== event.pointerId) return;
    const dx = event.clientX - active.x, dy = event.clientY - active.y;
    const next = active.mode === 'move' ? { ...active.origin, x: active.origin.x + dx, y: active.origin.y + dy }
      : { ...active.origin, width: active.origin.width + (Math.abs(dx) >= Math.abs(dy * ratio) ? dx : dy * ratio) };
    positionRef.current = constrain(next);
    setPosition(positionRef.current);
  }

  function finish(event: PointerEvent<HTMLElement>) {
    if (drag.current?.pointer !== event.pointerId) return;
    drag.current = null;
    try { localStorage.setItem(key, JSON.stringify(positionRef.current)); } catch { /* Storage is optional. */ }
  }

  if (!position) return null;
  return <aside className={styles.floatingPreview} aria-label="直播预览" style={{ left: position.x, top: position.y, width: position.width }}>
    <div className={styles.previewTitle}>
      <div className={styles.previewDrag} onPointerDown={event => start(event, 'move')} onPointerMove={move}
        onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish}><Grip size={15} aria-hidden />赛事直播预览</div>
      <button type="button" aria-label="关闭直播预览" onClick={close}><X size={16} aria-hidden /></button>
    </div>
    <div className={styles.previewCanvas}>
      <iframe src={src} title="赛事直播预览" allow="autoplay; fullscreen" width={1920} height={1080}
        style={{ transform: `scale(${position.width / 1920})` }} />
    </div>
    <div className={styles.previewResize} onPointerDown={event => start(event, 'resize')} onPointerMove={move}
      onPointerUp={finish} onPointerCancel={finish} onLostPointerCapture={finish} aria-hidden />
  </aside>;
}
