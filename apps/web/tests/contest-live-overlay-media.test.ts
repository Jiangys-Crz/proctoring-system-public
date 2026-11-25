import assert from 'node:assert/strict';
import test from 'node:test';
import { makeOverlaySnapshot } from '../src/contest-live-overlay/adapter';
import { TeamViewPosition, Widget } from '../src/contest-live-overlay/api';
import { contestLiveSceneSchema } from '../src/lib/contest-live-presets';
import {
  contestLiveSettingsPatchSchema, defaultContestLiveSettings, mergeContestLiveSettings, readContestLiveSettings, type ContestLiveResponse,
} from '../src/lib/contest-live-settings';

test('live media accepts safe broadcast asset URLs and remains off in existing settings', () => {
  const legacy = readContestLiveSettings({ titles: { title: 'Final', visible: true } });
  assert.equal(legacy.titles.titleVisible, true);
  assert.equal(legacy.titles.svgVisible, false);
  assert.equal(legacy.titles.videoVisible, false);
  for (const url of ['data:text/plain,asset', '//media.example/a.svg', '/\\media.example/a.svg', 'https://user@media.example/a.svg']) {
    assert.equal(contestLiveSettingsPatchSchema.safeParse({ titles: { svgUrl: url, videoUrl: url } }).success, false);
  }
  const patch = { titles: {
    svgUrl: '/contest-live-assets/title.svg', svgVisible: true,
    videoUrl: 'https://media.example/intro.webm', videoVisible: true,
  } };
  const settings = mergeContestLiveSettings(defaultContestLiveSettings, contestLiveSceneSchema.parse(patch));
  const titles = readContestLiveSettings(settings).titles;
  for (const key of ['svgUrl', 'svgVisible', 'videoUrl', 'videoVisible'] as const) {
    assert.equal(titles[key], patch.titles[key]);
  }
});

function fixture(): ContestLiveResponse {
  return {
    contest: {
      exam: { id: 'test', name: 'Test', source: 'local', startAt: '2026-11-17T01:00:00Z', endAt: '2026-11-17T03:00:00Z',
        beforeStart: false, freezeAt: '2026-11-17T02:30:00Z', frozen: false, scoring: 'icpc' },
      problems: [], teams: [], standings: [], submissions: [], timeline: [], statistics: [], updatedAt: null, sourceError: null,
    },
    settings: { ...defaultContestLiveSettings, obsKeyActive: false },
  };
}

test('live media projects configured overlay widgets and honors visibility and scoreboard-only output', () => {
  const response = fixture();
  response.settings = {
    ...mergeContestLiveSettings(response.settings, { titles: {
      svgUrl: '/title.svg', svgVisible: true, videoUrl: 'https://media.example/intro.webm', videoVisible: true,
    } }),
    obsKeyActive: false,
  };
  const sourceWidgets = makeOverlaySnapshot(response).widgets.map(item => item.widget);
  assert.equal(sourceWidgets.find(widget => widget.type === Widget.Type.SvgWidget)?.content, '/title.svg');
  assert.equal(sourceWidgets.find(widget => widget.type === Widget.Type.VideoWidget)?.video.url, 'https://media.example/intro.webm');
  assert.deepEqual(makeOverlaySnapshot(response, Date.now(), true).widgets.map(item => item.widget.type), [Widget.Type.ScoreboardWidget]);
  response.settings.titles = { ...response.settings.titles, svgVisible: false, videoVisible: false };
  assert.equal(makeOverlaySnapshot(response).widgets.some(item =>
    item.widget.type === Widget.Type.SvgWidget || item.widget.type === Widget.Type.VideoWidget), false);
});

test('live team positions do not shift and only include selected, available media', () => {
  const response = fixture();
  response.settings.teamMode = 'split';
  response.settings.teamSlots = [
    null,
    { teamId: 'A', primary: 'auto', secondary: 'camera', showTaskStatus: false, showTimeLine: true },
    null,
    { teamId: 'B', primary: 'photo', secondary: 'screen' },
  ];
  response.contest.teams = ['A', 'B'].map(id => ({
    id, account: id, accounts: [id], candidateIds: [], name: id, group: '', members: [], organization: '', isOutOfContest: false,
    photoUrl: '/photo/' + id, organizationLogoUrl: null, media: { screenUrl: '/screen/' + id, cameraUrl: null },
  }));
  const views = makeOverlaySnapshot(response).widgets.map(item => item.widget).filter(widget => widget.type === Widget.Type.TeamViewWidget);
  assert.deepEqual(views.map(({ settings }) => ({
    id: settings.teamId, position: settings.position, primary: settings.primary.map(media => media.url),
    secondary: settings.secondary.map(media => media.url), taskStatus: settings.showTaskStatus, timeline: settings.showTimeLine,
  })), [
    { id: 'A', position: TeamViewPosition.TOP_RIGHT, primary: ['/screen/A'], secondary: [], taskStatus: false, timeline: false },
    { id: 'B', position: TeamViewPosition.BOTTOM_RIGHT, primary: ['/photo/B'], secondary: ['/screen/B'], taskStatus: true, timeline: false },
  ]);
});
