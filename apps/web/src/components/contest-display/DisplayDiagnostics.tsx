import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import type { ContestDisplayResponse } from '@/lib/contest-display-contract';
import styles from './DisplayDiagnostics.module.css';

export type DiagnosticScene = 'testAlignment' | 'testSynchronization' | 'testClock' | 'testFps' | 'testBlueScreen';
const wallClock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const beijingClock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });

function Alignment({ title }: { title: string }) {
  const id = useId();
  return <svg className={styles.alignment} viewBox="0 0 1000 1000" preserveAspectRatio="none" aria-label="Alignment">
    <defs>{[25, 50, 100].map((size, index) => <pattern key={size} id={id + index} width={size} height={size} patternUnits="userSpaceOnUse">
      <path d={`M0 ${size}V0H${size}`} stroke={['var(--fine)', 'var(--medium)', 'var(--fg)'][index]} fill="none" vectorEffect="non-scaling-stroke" />
    </pattern>)}</defs>
    {[0, 1, 2].map(index => <rect key={index} width="1000" height="1000" fill={`url(#${id + index})`} />)}
    {Array.from({ length: 100 }, (_, index) => {
      const x = index % 10, y = Math.floor(index / 10);
      return <g key={index} transform={`translate(${x * 100 + 50} ${y * 100 + 50})`}>
        <rect x="-7" y="-7" width="14" height="14" fill="var(--bg)" />
        <text textAnchor="middle" dominantBaseline="central" fontSize="12" transform="scale(.57 1)">{x}-{y}</text>
      </g>;
    })}
    {title && <text className={styles.alignmentTitle} x="500" y="500" textAnchor="middle" dominantBaseline="central">{title}</text>}
  </svg>;
}

function useFrameClock(offset: number) {
  const [frame, setFrame] = useState(() => ({ millisecond: Date.now(), count: 0, fps: 0 }));
  useEffect(() => {
    let loop = 0, count = 0;
    const times: number[] = [];
    function tick(time: number) {
      times.push(time);
      if (times.length > 16) times.shift();
      setFrame({ millisecond: Date.now(), count: ++count,
        fps: times.length === 16 ? Math.min(60, 15_000 / (time - times[0])) : 0 });
      loop = requestAnimationFrame(tick);
    }
    loop = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(loop);
  }, []);
  return { ...frame, serverTime: frame.millisecond + offset };
}

function Sync({ offset, startedAt }: { offset: number; startedAt: number }) {
  const { serverTime } = useFrameClock(offset);
  const root = useRef<HTMLElement>(null);
  const [ratio, setRatio] = useState(16 / 9);
  useEffect(() => {
    if (!root.current) return;
    const observer = new ResizeObserver(([entry]) => {
      if (entry.contentRect.height) setRatio(entry.contentRect.width / entry.contentRect.height);
    });
    observer.observe(root.current);
    return () => observer.disconnect();
  }, []);
  const width = 2 * ratio / (ratio + 1);
  const position = (Math.max(0, serverTime - startedAt) % 2000) / 500;
  const [x, y] = position < width ? [position / width, 0] : position < 2 ? [1, (position - width) / (2 - width)]
    : position < 2 + width ? [1 - (position - 2) / width, 1] : [0, 1 - (position - 2 - width) / (2 - width)];
  return <section ref={root} className={styles.sync} aria-label="Synchronization">
    <div className={styles.timerLine} style={{ left: (serverTime % 1000) / 10 + '%' }} />
    <div className={styles.ball} style={{ left: `calc(${x * 100}% - ${x * 50}px)`, top: `calc(${y * 100}% - ${y * 50}px)` }} />
    <span className={styles.offset} style={{ '--angle': `${Math.atan(-offset / 1000)}rad` } as React.CSSProperties}>{Math.round(-offset)}</span>
  </section>;
}

function TestClock({ offset, showLocalTime, renderClock }: {
  offset: number; showLocalTime: boolean; renderClock: (value: string) => ReactNode;
}) {
  const { millisecond, serverTime } = useFrameClock(offset);
  return <section className={styles.testClock} aria-label="Clock">
    {showLocalTime && <>
      <div className={styles.localTick} style={{ left: (millisecond % 1000) / 10 + '%' }} />
      <div className={styles.serverTick} style={{ left: (serverTime % 1000) / 10 + '%' }} />
      <div className={styles.timeDetail}>{renderClock(String(Math.round(-offset)))}<small>Server time diff [ms]</small></div>
      <div className={styles.timeDetail} data-right>{renderClock(wallClock.format(millisecond))}<small>Local time</small></div>
    </>}
    <div className={styles.clockFace}>{renderClock(beijingClock.format(serverTime))}</div>
  </section>;
}

function Fps() {
  const { fps, count } = useFrameClock(0);
  const gaugePoint = (value: number, radius: number) => {
    const angle = (225 - value * 4.5) * Math.PI / 180;
    return [540 + radius * Math.cos(angle), 540 - radius * Math.sin(angle)];
  };
  const [needleX, needleY] = gaugePoint(fps, 510);
  const [leftX, leftY] = gaugePoint(0, 459);
  const [rightX, rightY] = gaugePoint(60, 459);
  return <section className={styles.fps} aria-label="FPS">
    <svg viewBox="0 0 1080 1080" className={styles.gauge}>
      <path d={`M${leftX},${leftY} A459,459 0 1 1 ${rightX},${rightY}`} fill="none" stroke="var(--fine)" strokeWidth="102" />
      {Array.from({ length: 13 }, (_, i) => {
        const major = i % 2 === 0;
        const [x1, y1] = gaugePoint(i * 5, major ? 509 : 485), [x2, y2] = gaugePoint(i * 5, major ? 409 : 432);
        return <line key={i} x1={x1} x2={x2} y1={y1} y2={y2} stroke={major ? 'currentColor' : '#808080'} strokeWidth={major ? 2 : 1} />;
      })}
      <line x1="540" x2={needleX} y1="540" y2={needleY} stroke="#f00" strokeWidth="4" />
      <text className={styles.fpsValue} x="540" y="1035" textAnchor="middle">{fps.toFixed(1)}</text>
    </svg>
    {(['left', 'right'] as const).map(side => <div key={side} className={styles.frameBits} data-side={side}>
      {Array.from({ length: 10 }, (_, i) => {
        const period = 2 ** (i + 1);
        return <i key={i} data-lit={(side === 'left' ? count % period === 0 : count % period >= period / 2) || undefined} />;
      })}
    </div>)}
  </section>;
}

function BlueScreen() {
  return <svg className={styles.blueScreen} viewBox="0 0 1920 1080" preserveAspectRatio="none" aria-label="BSoD">
    <rect width="1920" height="1080" fill="#0078d0" />
    <text fontSize="182" x="198" y="330">:(</text>
    <text x="207" y="436" fontSize="40">
      <tspan x="207">Your PC needs to restart. System diagnostics are collecting</tspan>
      <tspan x="207" dy="59">error information before the restart.</tspan>
      <tspan x="207" dy="148">20% complete</tspan>
    </text>
    <text x="207" y="717" fontSize="20">Stop code: CRITICAL_PROCESS_DIED</text>
  </svg>;
}

export function DisplayDiagnosticScene({ scene, data, now, elapsed, renderClock }: {
  scene: DiagnosticScene; data: ContestDisplayResponse; now: number; elapsed: number; renderClock: (value: string) => ReactNode;
}) {
  const [offset] = useState(() => now - Date.now());
  switch (scene) {
    case 'testAlignment': return <Alignment title={data.settings.title} />;
    case 'testSynchronization': return <Sync offset={offset} startedAt={now - elapsed} />;
    case 'testClock': return <TestClock offset={offset} showLocalTime={data.settings.showLocalTime === true} renderClock={renderClock} />;
    case 'testFps': return <Fps />;
    case 'testBlueScreen': return <BlueScreen />;
  }
}
