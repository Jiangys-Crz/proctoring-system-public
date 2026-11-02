import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createEvidenceLookup, evidenceWindow, type EvidenceAlert, type EvidenceSegment } from '../src/lib/evidence-window';

const base = new Date('2026-10-01T00:00:00Z').getTime();
const channels = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'];
const types = ['SCREEN_SWITCH', 'CAMERA_CAPTURE_LOST', 'SECOND_CAMERA_OFFLINE'];
const date = (offset: number) => new Date(base + offset);

test('indexed evidence matches a full scan across randomized sessions, channels, duplicates and old clips', () => {
  let seed = 824963;
  const random = (maximum: number) => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed % maximum;
  };
  const records: EvidenceSegment[] = Array.from({ length: 4000 }, (_, index) => {
    const start = random(240_000) - 120_000;
    return {
      id: String(index), sessionId: random(20) === 0 ? null : `session-${random(8)}`,
      channel: channels[random(channels.length)], objectPath: `recording-${random(3000)}.webm`,
      startedAt: date(start), endedAt: random(10) === 0 ? null : date(start + random(180_000) + 1)
    };
  });
  const lookup = createEvidenceLookup(records);
  for (let index = 0; index < 500; index++) {
    const alert: EvidenceAlert = {
      id: random(5) ? `desktop_alert_${index}` : `mobile_alert_${index}`,
      sessionId: random(20) === 0 ? null : `session-${random(8)}`,
      type: types[random(types.length)], createdAt: date(random(360_000) - 180_000),
      message: random(6) ? undefined : '离开第二机位页面'
    };
    const now = date(index % 2 ? 0 : 3_600_000);
    assert.deepEqual(evidenceWindow(alert, lookup(alert), now), evidenceWindow(alert, records, now));
  }
});

test('lookup retains a long earlier clip and excludes intervals touching only the window boundary', () => {
  const alert: EvidenceAlert = { id: 'desktop_alert', sessionId: 'session', type: 'SCREEN_SWITCH', createdAt: date(0) };
  const create = (id: string, start: number, end: number | null): EvidenceSegment => ({
    id, sessionId: 'session', channel: 'DESKTOP_SCREEN', objectPath: `${id}.webm`,
    startedAt: date(start), endedAt: end === null ? null : date(end)
  });
  const records = [
    create('long', -3_600_000, 100_000), create('old', -90_000, -80_000),
    create('ends-at-start', -30_000, -20_000), create('legacy-ends-at-start', -30_000, null),
    create('legacy-overlap', -29_999, null), create('inside', -10_000, 10_000),
    create('starts-at-end', 20_000, 30_000)
  ];
  const lookup = createEvidenceLookup(records);
  assert.deepEqual(lookup(alert).map(record => record.id), ['long', 'legacy-overlap', 'inside']);
  assert.deepEqual(evidenceWindow(alert, lookup(alert), date(0)), evidenceWindow(alert, records, date(0)));
  assert.equal(evidenceWindow(alert, lookup(alert), date(0)).complete, false, 'legacy footage still cannot prove a complete window');
});

test('many alerts inspect the recording index once instead of rescanning every other candidate', () => {
  let sessionReads = 0;
  const records: EvidenceSegment[] = [];
  for (let session = 0; session < 30; session++) for (const channel of channels) for (let clip = 0; clip < 360; clip++) {
    records.push({
      id: `${session}-${channel}-${clip}`, get sessionId() { sessionReads++; return `session-${session}`; },
      channel, objectPath: `${session}/${channel}/${clip}.webm`,
      startedAt: date(clip * 5000), endedAt: date((clip + 1) * 5000)
    });
  }
  const lookup = createEvidenceLookup(records);
  for (let index = 0; index < 300; index++) {
    const alert: EvidenceAlert = {
      id: `desktop_alert_${index}`, sessionId: `session-${index % 30}`,
      type: types[index % types.length], createdAt: date(100_000 + index * 5000)
    };
    assert.equal(evidenceWindow(alert, lookup(alert), date(0)).availableSeconds, 40);
  }
  const fullScanReads = records.length * 300;
  assert.ok(sessionReads < fullScanReads / 50, `${sessionReads} inspected session values, compared with ${fullScanReads} for repeated full scans`);
});
