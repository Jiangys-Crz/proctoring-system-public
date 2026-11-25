'use client';

import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import type { ContestDisplayResponse } from '@/lib/contest-display-contract';
import type { ContestLiveProblem } from '@/lib/contest-live-contract';
import { normalizeReactionOrganizationName } from '@/lib/reaction-branding-contract';
import styles from './AdditionalDisplayScenes.module.css';

type AdditionalScene = 'problemColors' | 'logoWall' | 'fadingLogos' | 'slidingLogos' | 'photoSlideshow' | 'polarCountdown';
type Size = { width: number; height: number };
type Area = Size & { x: number; y: number };
type Logo = { name: string; src: string };
type Photo = Logo & { id: string };

const baseSize = { width: 1920, height: 1080 };
const balloonAspect = 115 / 170;
const balloonStep = 1800;
const palette = ['#0069e8', '#e6c35e', '#844fac', '#55d806', '#ed75b9', '#c6c7c7', '#62c7ef', '#e6932c', '#3cb362', '#e8e8e8', '#ed1429', '#ead708'];

function useSceneSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState(baseSize);
  useEffect(() => {
    const frame = ref.current;
    if (!frame) return;
    function resize(width: number, height: number) {
      if (width > 0 && height > 0) setSize({ width: Math.floor(width), height: Math.floor(height) });
    }
    resize(frame.clientWidth, frame.clientHeight);
    const observer = new ResizeObserver(([entry]) => resize(entry.contentRect.width, entry.contentRect.height));
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);
  return { ref, size };
}

function useAnimationTime(elapsed: number) {
  const [time, setTime] = useState(elapsed);
  useEffect(() => {
    const origin = performance.now() - elapsed;
    let frame = requestAnimationFrame(function animate(timestamp) {
      setTime(Math.max(0, timestamp - origin));
      frame = requestAnimationFrame(animate);
    });
    return () => cancelAnimationFrame(frame);
  }, [elapsed]);
  return time;
}

function empty(label: string) {
  return <div className={styles.empty}>{label}</div>;
}

function balloonRows(count: number, wide: boolean) {
  if (wide) return [Math.ceil(count / 2), Math.floor(count / 2)];
  const outer = Math.floor(count / 3) + Number(count % 3 === 2);
  const middle = Math.floor(count / 3) + Number(count % 3 !== 2);
  return [outer, middle, count - outer - middle];
}

function balloonAreas({ width, height }: Size, count: number) {
  const rows = balloonRows(count, width > height * 2);
  const slotHeight = Math.min(height / rows.length, width / (Math.max(1, ...rows) * balloonAspect));
  const slotWidth = slotHeight * balloonAspect;
  const margin = Math.min(5, slotWidth / 12);
  return rows.flatMap((length, row) => Array.from({ length }, (_, col) => ({
    x: (width - slotWidth * length) / 2 + col * slotWidth + margin,
    y: (height - slotHeight * rows.length) / 2 + row * slotHeight + margin,
    width: slotWidth - 2 * margin,
    height: slotHeight - 2 * margin,
  })));
}

function mix(a: Area, b: Area, progress: number): Area {
  return {
    x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress,
    width: a.width + (b.width - a.width) * progress, height: a.height + (b.height - a.height) * progress,
  };
}

function contrastColor(color: string) {
  const compact = color.slice(1);
  const rgb = compact.length === 3 ? [...compact].map(channel => channel.repeat(2)).join('') : compact;
  const [red, green, blue] = (rgb.match(/.{2}/g) ?? []).map(channel => Number.parseInt(channel, 16));
  return red * 0.299 + green * 0.587 + blue * 0.114 >= 128 ? '#000' : '#fff';
}

function Balloon({ problem, index, area, opacity = 1 }: { problem: ContestLiveProblem; index: number; area: Area; opacity?: number }) {
  const color = problem.color && /^#(?:[\da-f]{3}|[\da-f]{6})$/i.test(problem.color) ? problem.color : palette[index % palette.length];
  return <div className={styles.balloon} style={{
    left: area.x, top: area.y, width: area.width, height: area.height, color: contrastColor(color),
    opacity, fontSize: area.height * 0.28, '--balloon-color': color,
  } as CSSProperties}>
    <span className={styles.balloonBody}>{problem.label}</span>
    <span className={styles.balloonTail} aria-hidden />
  </div>;
}

function ProblemColours({ problems, size, elapsed }: { problems: ContestLiveProblem[]; size: Size; elapsed: number }) {
  const time = useAnimationTime(elapsed);
  const position = time % (balloonStep * problems.length + 6000);
  const current = Math.floor(position / balloonStep);
  const age = position % balloonStep;
  const targets = balloonAreas(size, problems.length);
  const height = Math.min(size.height * 0.8, (size.width * 0.95) / balloonAspect);
  const width = height * balloonAspect;
  const center = { x: (size.width - width) / 2, y: (size.height - height) / 2, width, height };
  if (!problems.length) return empty('No problems');
  return <>
    {problems.slice(0, current).map((problem, index) => <Balloon key={problem.id} problem={problem} index={index} area={targets[index]} />)}
    {problems[current] && <Balloon key={problems[current].id} problem={problems[current]} index={current}
      area={mix(center, targets[current], Math.max(0, (age - 1200) / 600))}
      opacity={Math.min(1, age / 200)} />}
  </>;
}

function wallTiles({ width, height }: Size, size: number) {
  const columns = Math.max(1, Math.floor(width / size));
  const rows = Math.max(1, Math.floor(height / size));
  const left = (width - columns * size) / 2;
  const top = (height - rows * size) / 2;
  return Array.from({ length: rows }, (_, row) => {
    const shift = row % 2 !== 0 ? size / 2 : 0;
    const count = Math.floor((width - left - shift) / size);
    return Array.from({ length: count }, (_, col) => ({ x: left + shift + col * size, y: top + row * size, width: size, height: size }));
  }).flat();
}

function LogoTile({ logo, area, opacity = 1 }: { logo: Logo; area: Area; opacity?: number }) {
  return <img src={logo.src} alt={logo.name} className={styles.logo} draggable={false} style={{
    left: area.x + area.width * 0.05, top: area.y + area.height * 0.05,
    width: area.width * 0.9, height: area.height * 0.9, opacity,
  }} />;
}

function LogoWall({ logos, size }: { logos: Logo[]; size: Size }) {
  let side = Math.max(1, Math.floor(Math.min(size.height, size.width, Math.sqrt(size.width * size.height / logos.length))));
  let tiles = wallTiles(size, side);
  while (tiles.length < logos.length && side > 1) tiles = wallTiles(size, --side);
  return logos.slice(0, tiles.length).map((logo, index) => <LogoTile key={logo.name} logo={logo} area={tiles[index]} />);
}

function FadingLogos({ logos, size, elapsed }: { logos: Logo[]; size: Size; elapsed: number }) {
  const frame = useAnimationTime(elapsed);
  const side = Math.max(1, Math.min(size.width, Math.floor(size.height / 3)));
  const tiles = wallTiles(size, side);
  const stagger = tiles.map((_, i) => i).sort((a, b) => Math.sin(a * 37 + 5) - Math.sin(b * 37 + 5));
  return tiles.map((area, index) => {
    const shiftedTime = frame + 30000 * (1 + stagger[index] / tiles.length);
    const phase = shiftedTime % 30000;
    const logo = logos[(index + Math.floor(shiftedTime / 30000) * tiles.length) % logos.length];
    const opacity = Math.min(1, phase / 750, (30000 - phase) / 750);
    return <LogoTile key={index} logo={logo} area={area} opacity={opacity} />;
  });
}

function SlidingLogos({ logos, size, elapsed }: { logos: Logo[]; size: Size; elapsed: number }) {
  const frame = useAnimationTime(elapsed);
  const side = Math.max(1, Math.min(size.width, Math.floor(size.height / 4)));
  const columns = Math.ceil(size.width / side) + 1;
  const tick = Math.floor(frame / 15000);
  const shift = side * (frame % 15000) / 15000;
  const count = Math.floor(logos.length / 4);
  const remainder = logos.length % 4;
  return Array.from({ length: 4 }, (_, row) => {
    const start = row * count + Math.min(row, remainder);
    const length = count + Number(row < remainder);
    const toLeft = row % 2 === 0;
    return length ? Array.from({ length: columns }, (_, col) => {
      const direction = toLeft ? 1 : -1;
      const offset = (col + direction * (tick % length) + length) % length;
      const x = col * side + (toLeft ? -shift : shift - side);
      return <LogoTile key={`${row}:${col}`} logo={logos[start + offset]} area={{ x, y: row * side, width: side, height: side }} />;
    }) : [];
  }).flat();
}

const photoDuration = 12000;

function photoCorner(size: Size, image: Size, scale: number, corner: number): Area {
  const width = image.width * scale;
  const height = image.height * scale;
  return { x: corner & 1 ? size.width - width : 0, y: corner & 2 ? size.height - height : 0, width, height };
}

function PanningPhoto({ photo, stage, index, progress, shown }: {
  photo: Photo; stage: Size; index: number; progress: number; shown: boolean;
}) {
  const [image, setImage] = useState<Size | null>(null);
  let position: CSSProperties | undefined;
  if (image) {
    const cover = Math.max(stage.width / image.width, stage.height / image.height);
    const from = photoCorner(stage, image, cover * 1.1, (index * 3 + 1) % 4);
    const to = photoCorner(stage, image, cover, (index + 2) % 4);
    const target = mix(from, to, progress);
    position = { left: target.x, top: target.y, width: target.width, height: target.height, objectFit: 'fill' };
  }
  return <img className={styles.photo} src={photo.src} alt={shown ? photo.name : ''} aria-hidden={!shown} draggable={false}
    data-shown={shown || undefined} style={position}
    onLoad={({ currentTarget }) => setImage({ width: currentTarget.naturalWidth, height: currentTarget.naturalHeight })} />;
}

function PhotoSlideshow({ photos, size, elapsed }: { photos: Photo[]; size: Size; elapsed: number }) {
  const frame = useAnimationTime(elapsed);
  const index = Math.floor(frame / photoDuration);
  const progress = (frame % photoDuration) / photoDuration;
  if (photos.length === 0) return empty('No team photos');
  const current = photos[index % photos.length];
  const next = photos[(index + 1) % photos.length];
  return <>
    <PanningPhoto key={current.src} photo={current} stage={size} index={index} shown progress={progress} />
    {next.id !== current.id && <PanningPhoto key={next.src} photo={next} stage={size} index={index + 1} shown={false} progress={0} />}
  </>;
}

const arcColors = ['#5c8add', '#ffdf36', '#c43a24'];

function polarArcs(seconds: number, maxHours: number) {
  const hours = Math.trunc(seconds / 3600);
  const minutes = Math.trunc(seconds / 60);
  const hourSegment = Math.floor(360 / maxHours);
  return seconds < 0
    ? [-(maxHours + hours % maxHours) * hourSegment, -(60 + minutes % 120) * 6, -(59 + seconds % 120) * 6]
    : [-(hours % maxHours) * hourSegment, -(minutes % 120) * 6, -(seconds % 120) * 6];
}

function arcSweep(angle: number) {
  if (angle < -360) return { start: -360 - angle, sweep: 720 + angle };
  return angle < 0 ? { start: 0, sweep: -angle } : { start: 360 - angle, sweep: angle };
}

function clockValue(seconds: number) {
  const absolute = Math.abs(seconds);
  const hours = Math.floor(absolute / 3600) % 48;
  const minutes = String(Math.floor(absolute / 60) % 60).padStart(2, '0');
  return `${seconds < 0 ? '-' : '+'}${hours}:${minutes}:${String(absolute % 60).padStart(2, '0')}`;
}

function PolarCountdown({ data, now, size, renderClock }: {
  data: ContestDisplayResponse; now: number; size: Size; renderClock?: (value: string) => ReactNode;
}) {
  const { startAt, endAt, freezeAt } = data.contest.exam;
  const start = Date.parse(startAt);
  const end = Date.parse(endAt);
  if (!Number.isFinite(start)) return empty('No contest time');
  const duration = end - start;
  const freeze = freezeAt ? Date.parse(freezeAt) : start + duration * 2 / 3;
  const remaining = now > freeze;
  const seconds = Math.floor((remaining ? end - now : now - start) / 1000);
  const hours = Math.floor(duration / 3_600_000);
  const diameter = Math.max(0, Math.min(size.width, size.height) - 5);
  const stroke = Math.max(.5, diameter / 8 - 8);
  const value = clockValue(seconds);
  return <>
    {hours > 0 && polarArcs(seconds, hours).map((angle, index) => {
      const { start, sweep } = arcSweep(angle);
      const width = diameter * (4 - index) / 4;
      const arcColor = arcColors[index];
      return sweep > 0 ? <div aria-hidden className={styles.polarArc} key={arcColor} style={{
        width, height: width, left: (size.width - width) / 2, top: (size.height - width) / 2,
        backgroundImage: `conic-gradient(from ${start}deg, ${arcColor} ${sweep}deg, transparent ${sweep}deg)`,
        '--polar-stroke': `${Math.min(stroke, width * 0.48)}px`,
      } as CSSProperties} /> : null;
    })}
    <div className={styles.polarClock} data-remaining={remaining || undefined}>{renderClock?.(value) ?? value}</div>
  </>;
}

export function AdditionalDisplayScene({ scene, data, elapsed, now = data.serverTime, renderClock }: {
  scene: AdditionalScene; data: ContestDisplayResponse; elapsed: number; now?: number; renderClock?: (value: string) => ReactNode;
}) {
  const { ref, size } = useSceneSize();
  const { group, speed } = data.settings;
  const time = elapsed * speed;
  const labels: Record<AdditionalScene, string> = {
    problemColors: 'Problem Colours', logoWall: 'Logo Wall', fadingLogos: 'Fading Logos', slidingLogos: 'Sliding Logos',
    photoSlideshow: 'Photos', polarCountdown: 'Polar Countdown',
  };
  const teams = group ? data.contest.teams.filter(team => team.group === group) : data.contest.teams;
  let content: ReactNode;
  switch (scene) {
    case 'problemColors': content = <ProblemColours problems={data.contest.problems} size={size} elapsed={time} />; break;
    case 'photoSlideshow': {
      const photos = new Map<string, Photo>();
      for (const team of teams) if (team.photoUrl) photos.set(team.photoUrl, { id: team.id, name: team.name, src: team.photoUrl });
      content = <PhotoSlideshow photos={[...photos.values()]} size={size} elapsed={time} />;
      break;
    }
    case 'polarCountdown': content = <PolarCountdown data={data} size={size} now={now} renderClock={renderClock} />; break;
    default: {
      const logos = new Map<string, Logo>();
      for (const team of teams) {
        const name = normalizeReactionOrganizationName(team.organization);
        if (name && team.organizationLogoUrl) logos.set(name, { name, src: team.organizationLogoUrl });
      }
      const list = [...logos.values()];
      content = list.length === 0 ? empty('No organization logos')
        : scene === 'logoWall' ? <LogoWall logos={list} size={size} />
          : scene === 'fadingLogos' ? <FadingLogos logos={list} size={size} elapsed={time} />
            : <SlidingLogos logos={list} size={size} elapsed={time} />;
    }
  }
  return <div ref={ref} className={styles.scene} role="group" aria-label={labels[scene]}>
    {content}
  </div>;
}
