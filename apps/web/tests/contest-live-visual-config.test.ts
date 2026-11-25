import assert from 'node:assert/strict';
import test from 'node:test';
import { defaultOverlayConfig } from '../src/contest-live-overlay/config';
import { resolveBroadcastVisualConfig } from '../src/contest-live-overlay/visualConfig';
import { contestLiveSceneSchema } from '../src/lib/contest-live-presets';
import { contestLiveSettingsPatchSchema, mergeContestLiveSettings, readContestLiveSettings } from '../src/lib/contest-live-settings';
import { contestLiveVisualConfigSchema, parseVisualConfigText, visualConfigDefaults } from '../src/lib/contest-live-visual-config';

test('original ICPC Live fields cascade to styles and captions, and partial rectangles keep their other dimensions', () => {
  const config = contestLiveVisualConfigSchema.parse({
    CONTEST_COLOR: '#FDBA12', CONTEST_CAPTION: 'Div 2', GLOBAL_DEFAULT_FONT_SIZE: '28px',
    WIDGET_POSITIONS: { queue: { positionX: 1520, positionY: 400, sizeX: 380, sizeY: 600 }, scoreboard: { positionX: 550 },
      customQueue: { positionX: 0, positionY: 515, sizeX: 653, sizeY: 50 } },
    'WIDGET_POSITIONS.scoreboard.sizeX': 1350,
  });
  const applied = resolveBroadcastVisualConfig(config, null, null);
  assert.equal(applied.SCOREBOARD_HEADER_BACKGROUND_COLOR, '#FDBA12');
  assert.equal(applied.QUEUE_CAPTION, 'Div 2');
  assert.equal(applied.SCOREBOARD_ROW_FONT_SIZE, '28px');
  assert.deepEqual(applied.WIDGET_POSITIONS.queue, { positionX: 1520, positionY: 400, sizeX: 380, sizeY: 600 });
  assert.deepEqual(applied.WIDGET_POSITIONS.scoreboard, { ...defaultOverlayConfig.WIDGET_POSITIONS.scoreboard, positionX: 550, sizeX: 1350 });
  assert.equal(applied.WIDGET_POSITIONS.customQueue.positionY, 515);
  assert.deepEqual(resolveBroadcastVisualConfig({}, null, null), defaultOverlayConfig);
  assert.deepEqual(defaultOverlayConfig.WIDGET_POSITIONS.scoreboard, { positionX: 16, positionY: 16, sizeX: 1488, sizeY: 984 });
  assert.ok(contestLiveVisualConfigSchema.safeParse(visualConfigDefaults).success);
});

test('scene chains and the restricted per-source URL override apply in order without undoing the saved layout', () => {
  const saved = contestLiveVisualConfigSchema.parse({
    EXTRA_CSS: '[data-widget="scoreboard"] { opacity: .9 }',
    SCENES: { stage: { CONTEST_COLOR: '#112233', SCENES: { wide: { 'WIDGET_POSITIONS.scoreboard.sizeX': 1800 } } },
      finals: { GLOBAL_DEFAULT_FONT_SIZE: '26px' } },
  });
  const result = resolveBroadcastVisualConfig(saved, 'stage.wide,finals', JSON.stringify({
    CONTEST_CAPTION: 'Source A', 'WIDGET_POSITIONS.scoreboard.positionY': 64,
    EXTRA_CSS: 'unused', SCOREBOARD_ROW_HEIGHT: 100, BASE_URL_BACKEND: 'unused',
  }));
  assert.equal(result.SCOREBOARD_CAPTION, 'Source A');
  assert.equal(result.SCOREBOARD_HEADER_BACKGROUND_COLOR, '#112233');
  assert.equal(result.SCOREBOARD_ROW_FONT_SIZE, '26px');
  assert.equal(result.WIDGET_POSITIONS.scoreboard.sizeX, 1800);
  assert.equal(result.WIDGET_POSITIONS.scoreboard.positionY, 64);
  assert.equal(result.EXTRA_CSS, saved.EXTRA_CSS);
  assert.equal(result.SCOREBOARD_ROW_HEIGHT, defaultOverlayConfig.SCOREBOARD_ROW_HEIGHT);
  assert.equal(result.BASE_URL_BACKEND, defaultOverlayConfig.BASE_URL_BACKEND);
  assert.equal(resolveBroadcastVisualConfig(saved, null, null).CONTEST_COLOR, defaultOverlayConfig.CONTEST_COLOR);
});

test('invalid JSON and unknown or mistyped fields identify the edit that needs correcting', () => {
  assert.match(parseVisualConfigText('{').error ?? '', /JSON/);
  for (const [input, message] of [
    ['null', 'JSON 对象'], ['[]', 'JSON 对象'], ['{"CONTEST_COLOUR":"red"}', 'CONTEST_COLOUR'],
    ['{"WIDGET_POSITIONS":{"queue":{"sizeY":0}}}', 'WIDGET_POSITIONS.queue.sizeY'],
    ['{"SCOREBOARD_ROW_FONT_SIZE":20}', 'SCOREBOARD_ROW_FONT_SIZE'],
    ['{"SCENES":{"final":{"TICKER_SCOREBOARD_ROWS":0}}}', 'SCENES.final.TICKER_SCOREBOARD_ROWS'],
    ['{"WIDGET_POSITIONS.queue.__proto__.positionX":24}', '无效的配置路径'],
  ]) {
    assert.ok(parseVisualConfigText(input).error?.includes(message), input);
    assert.equal(contestLiveSettingsPatchSchema.safeParse({ visualConfig: JSON.parse(input) }).success, false);
  }
});

test('contests persist and replace only their own appearance overrides, including an explicit reset', () => {
  const legacy = readContestLiveSettings({ scoreboard: { limit: 8 }, widgets: { queue: false } });
  assert.deepEqual(legacy.visualConfig, {});
  const changed = mergeContestLiveSettings(legacy, { visualConfig: { CONTEST_COLOR: '#112233', QUEUE_TITLE: '测试队列' } });
  const saved = readContestLiveSettings(JSON.parse(JSON.stringify(changed)));
  assert.deepEqual(saved.visualConfig, changed.visualConfig);
  const preset = contestLiveSceneSchema.strip().parse(legacy);
  assert.equal(Object.hasOwn(preset, 'visualConfig'), false);
  assert.deepEqual(mergeContestLiveSettings(saved, preset).visualConfig, changed.visualConfig);
  const replaced = mergeContestLiveSettings(saved, { visualConfig: { QUEUE_TITLE: '提交' } });
  assert.deepEqual(replaced.visualConfig, { QUEUE_TITLE: '提交' });
  const original = readContestLiveSettings(legacy);
  assert.deepEqual(readContestLiveSettings(mergeContestLiveSettings(replaced, { visualConfig: {} })), original);
  assert.deepEqual(readContestLiveSettings({ ...saved, visualConfig: { unknown: 'old setting' } }), original);
});
