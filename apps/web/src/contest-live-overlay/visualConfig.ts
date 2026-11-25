import type { OverlayConfig } from './config.interface';
import type { LocationRectangle } from './utils/location-rectangle';
import type { ContestLiveVisualConfig } from '../lib/contest-live-visual-config';
import { resolveOverlayConfig } from './config';

type Overrides = Partial<Pick<OverlayConfig, 'WIDGET_POSITIONS' | 'CONTEST_CAPTION' | 'SCOREBOARD_CAPTION' | 'QUEUE_TITLE' | 'STATISTICS_TITLE'>>;
const textKeys = new Set(['CONTEST_CAPTION', 'SCOREBOARD_CAPTION', 'QUEUE_TITLE', 'STATISTICS_TITLE']);
const rectangleKeys = ['positionX', 'positionY', 'sizeX', 'sizeY'] as const;

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

export function overlayVisualOverrides(raw: string | null, positions: OverlayConfig['WIDGET_POSITIONS']) {
  if (!raw || raw.length > 12_000) return {};
  let config: Record<string, unknown>;
  try { config = record(JSON.parse(raw)); } catch { return {}; }
  const overrides: Overrides & Record<string, unknown> = {};
  const widgetOverrides = record(config.WIDGET_POSITIONS);
  const layout = { ...positions };
  for (const [key, value] of Object.entries(config)) {
    if (textKeys.has(key) && typeof value === 'string' && value.length <= 200) overrides[key] = value;
    if (key !== 'VERDICT_FROZEN' && /(?:^|_)(?:COLOR|BACKGROUND)$/.test(key) && typeof value === 'string'
      && value.length <= 100 && globalThis.CSS?.supports('color', value)) overrides[key] = value;
  }
  for (const [widget, fallback] of Object.entries(positions)) {
    const baseKey = `WIDGET_POSITIONS.${widget}`;
    const position = { ...record(widgetOverrides[widget]), ...record(config[baseKey]) };
    const rect: LocationRectangle = { ...fallback };
    for (const component of rectangleKeys) {
      const amount = config[`${baseKey}.${component}`] ?? position[component];
      if (typeof amount === 'number' && Number.isFinite(amount) && Math.abs(amount) <= 4096
        && (!component.startsWith('size') || amount > 0)) rect[component] = amount;
    }
    layout[widget] = rect;
  }
  overrides.WIDGET_POSITIONS = layout;
  return overrides;
}

export function resolveBroadcastVisualConfig(saved: ContestLiveVisualConfig, scene: string | null, forced: string | null) {
  const layers: Record<string, unknown>[] = [saved];
  for (const chain of (scene ?? '').split(',').filter(Boolean)) {
    let current: Record<string, unknown> = saved;
    for (const name of chain.split('.')) {
      const scenes = record(current.SCENES);
      if (!Object.hasOwn(scenes, name)) break;
      current = record(scenes[name]);
      layers.push(current);
    }
  }
  const configured = resolveOverlayConfig(...layers);
  if (!forced) return configured;
  // A browser-source URL may override its own labels, colors and positions only.
  return resolveOverlayConfig(...layers, overlayVisualOverrides(forced, configured.WIDGET_POSITIONS));
}
