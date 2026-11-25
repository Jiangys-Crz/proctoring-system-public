import { z } from 'zod';
import { defaultOverlayConfig } from '../contest-live-overlay/config';

type VisualValue = string | number | boolean | null | ContestLiveVisualConfig;
export type ContestLiveVisualConfig = { [key: string]: VisualValue };

// Connection details and the standalone ICPC Live admin are owned by this application.
const internalKeys = new Set(['BASE_URL_WS', 'BASE_URL_BACKEND', 'WEBSOCKET_RECONNECT_TIME', 'WEBSOCKETS',
  'ADMIN_HIDE_MENU', 'ADMIN_HIDE_CONTROL', 'LOG_LINES']);
export const visualConfigDefaults = Object.fromEntries(Object.entries(defaultOverlayConfig).filter(([key]) => !internalKeys.has(key)));

const number = z.number({ error: '请填写有限数字' });
const text = z.string({ error: '请填写字符串' });
const rectangle = z.strictObject({
  positionX: number, positionY: number,
  sizeX: number.positive('宽度必须大于 0'), sizeY: number.positive('高度必须大于 0'),
}).partial();
const positiveCounts = new Set(['TICKER_SCOREBOARD_REPEATS', 'TICKER_SCOREBOARD_ROWS', 'QUEUE_HORIZONTAL_HEIGHT_NUM']);
const positiveLengths = new Set(['QUEUE_ROW_HEIGHT', 'QUEUE_ROW_WIDTH', 'SCOREBOARD_ROW_HEIGHT', 'QUEUE_FEATURED_RUN_ASPECT',
  'PVP_ASPECT_RATIO_WIDTH', 'PVP_ASPECT_RATIO_HEIGHT', 'PVP_SECONDARY_DIVISOR', 'SCOREBOARD_SCROLL_INTERVAL']);

function visualField(key: string, value: unknown): z.ZodType {
  if (key === 'WIDGET_POSITIONS') {
    return z.object(Object.fromEntries(Object.keys(defaultOverlayConfig.WIDGET_POSITIONS).map(id => [id, rectangle])))
      .partial().catchall(rectangle.required());
  }
  if (key === 'AWARD_EFFECTS' || key === 'EFFECT_RANK_BACKGROUND_COLOR') return z.record(z.string().min(1), text);
  if (key === 'EXTRA_CSS') return text.nullable();
  if (typeof value === 'boolean') return z.boolean({ error: '请填写 true 或 false' });
  if (typeof value === 'number') {
    if (key.endsWith('_OPACITY')) return number.min(0, '透明度应在 0 到 1 之间').max(1, '透明度应在 0 到 1 之间');
    if (positiveCounts.has(key)) return number.int().positive('请填写正整数');
    if (positiveLengths.has(key)) return number.positive('必须大于 0');
    if (key.endsWith('_TIME') || key.endsWith('_PADDING')) return number.nonnegative('不能小于 0');
    return number;
  }
  const property = key.endsWith('_FONT_SIZE') ? 'font-size' : key.endsWith('_FONT_FAMILY') ? 'font-family'
    : key.endsWith('_COLOR') || /^VERDICT_(OK|NOK|UNKNOWN|FROZEN)$/.test(key) ? 'color' : null;
  return property ? text.refine(value => !globalThis.CSS || CSS.supports(property, value), `请填写有效的 CSS ${property} 值`) : text;
}

const visualFields = Object.fromEntries(Object.entries(visualConfigDefaults).map(([key, value]) => [key, visualField(key, value)]));
const layerSchema: z.ZodType<ContestLiveVisualConfig, Record<string, unknown>> = z.lazy(() => z.strictObject({
  ...visualFields,
  $schema: text,
  SCENES: z.record(z.string().min(1), layerSchema),
}).partial() as z.ZodType<ContestLiveVisualConfig, Record<string, unknown>>);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function expandKeys(source: Record<string, unknown>, target: Record<string, unknown>, path: string[] = []) {
  for (const [key, value] of Object.entries(source)) {
    const parts = path.at(-1) === 'SCENES' ? [key] : key.split('.');
    const fullPath = [...path, ...parts];
    if (fullPath.length > 32 || parts.some(part => !part || ['__proto__', 'constructor', 'prototype'].includes(part))) {
      throw new Error(`无效的配置路径 ${fullPath.join('.')}`);
    }
    let node = target;
    for (const [index, part] of parts.entries()) {
      const last = index === parts.length - 1;
      if (last && !isRecord(value)) {
        if (Object.hasOwn(node, part)) throw new Error(`配置路径重复 ${fullPath.join('.')}`);
        node[part] = value;
      } else {
        if (!Object.hasOwn(node, part)) node[part] = Object.create(null);
        const child = node[part];
        if (!isRecord(child)) throw new Error(`配置路径冲突 ${fullPath.join('.')}`);
        node = child;
        if (last && isRecord(value)) expandKeys(value, node, fullPath);
      }
    }
  }
}

export const contestLiveVisualConfigSchema = z.unknown().transform((input, ctx) => {
  if (!isRecord(input)) {
    ctx.addIssue({ code: 'custom', message: '外观配置必须是 JSON 对象' });
    return z.NEVER;
  }
  const expanded: Record<string, unknown> = Object.create(null);
  try {
    expandKeys(input, expanded);
    return expanded;
  } catch (error) {
    ctx.addIssue({ code: 'custom', message: error instanceof Error ? error.message : '配置路径无效' });
    return z.NEVER;
  }
}).pipe(layerSchema);

export function parseVisualConfigText(source: string) {
  try {
    const parsed = contestLiveVisualConfigSchema.safeParse(JSON.parse(source));
    if (parsed.success) return { config: parsed.data };
    const issue = parsed.error.issues[0];
    const field = issue.code === 'unrecognized_keys' ? issue.keys.map(key => [...issue.path, key].join('.')).join('、') : issue.path.join('.');
    const message = issue.code === 'unrecognized_keys' ? '无法识别此字段，请检查拼写' : issue.message;
    return { error: [field, message].filter(Boolean).join(' · ') };
  } catch (error) {
    return { error: `JSON 语法有误。\n${error instanceof Error ? error.message : ''}` };
  }
}
