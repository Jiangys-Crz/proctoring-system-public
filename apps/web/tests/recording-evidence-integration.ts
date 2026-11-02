// Synthetic records only; never reads or writes physical recordings or global settings.
import assert from 'node:assert/strict';
import { randomInt, randomUUID } from 'node:crypto';
import type { MediaChannel } from '@prisma/client';
import { prisma } from '../src/lib/db';
import { evidenceForAlerts } from '../src/lib/alert-evidence';
import { evidenceWindow, type EvidenceAlert, type EvidenceSegment } from '../src/lib/evidence-window';

if (!process.env.DATABASE_URL?.includes('/proctor_performance_qa')) throw new Error('Use the isolated performance fixture database.');
const prefix = `recording-evidence-${randomUUID()}`;
const base = Date.now() - 24 * 60 * 60_000;
const channels: MediaChannel[] = ['DESKTOP_SCREEN', 'DESKTOP_CAMERA', 'MOBILE_CAMERA'];
const types = ['SCREEN_SWITCH', 'CAMERA_CAPTURE_LOST', 'SECOND_CAMERA_OFFLINE'];
let examId = '';
try {
  const exam = await prisma.exam.create({ data: {
    examCode: String(randomInt(1_000_000_000, 10_000_000_000)), name: prefix,
    startAt: new Date(base), latestStartAt: new Date(base), endAt: new Date(base + 600_000),
    durationMinutes: 10, platform: 'HYDRO', platformBaseUrl: 'http://localhost',
    platformContestId: prefix, contestType: 'INDIVIDUAL', rules: 'Synthetic test'
  } });
  examId = exam.id;
  const candidates = Array.from({ length: 30 }, (_, index) => ({
    id: `${prefix}-candidate-${index}`, examId, examNumber: `${prefix}-${index}`, password: 'synthetic', seatNo: String(index)
  }));
  await prisma.candidate.createMany({ data: candidates });
  const sessions = candidates.map((candidate, index) => ({ id: `${prefix}-session-${index}`, examId, candidateId: candidate.id }));
  await prisma.clientSession.createMany({ data: sessions });
  const segments = sessions.flatMap(session => channels.flatMap(channel => Array.from({ length: 120 }, (_, index) => ({
    id: `${session.id}-${channel}-${index}`, examId, candidateId: session.candidateId,
    sessionId: session.id, channel, objectPath: `https://recordings.invalid/${session.id}/${channel}/${index}.webm`,
    startedAt: new Date(base + index * 5000), endedAt: index % 17 === 0 ? null : new Date(base + (index + 1) * 5000),
    deletedAt: index % 29 === 0 ? new Date() : null
  }))));
  for (let index = 0; index < segments.length; index += 500) await prisma.mediaSegment.createMany({ data: segments.slice(index, index + 500) });
  const alerts: (EvidenceAlert & { evidenceDeletedAt?: Date | null })[] = Array.from({ length: 300 }, (_, index) => ({
    id: `desktop_alert_${index}`, sessionId: sessions[index % sessions.length].id,
    type: types[Math.floor(index / 30) % 3], createdAt: new Date(base + 40_000 + Math.floor(index / 30) * 50_000),
    evidenceDeletedAt: index % 47 === 0 ? new Date() : null
  }));
  alerts.push({ id: 'unbound-note', sessionId: null, type: 'MANUAL_NOTE', createdAt: new Date(base + 300_000) });
  const start = performance.now();
  const actual = await evidenceForAlerts(alerts);
  const elapsedMs = performance.now() - start;
  const visible: EvidenceSegment[] = segments.filter(segment => !segment.deletedAt).map(({ id, sessionId, channel, objectPath, startedAt, endedAt }) => ({ id, sessionId, channel, objectPath, startedAt, endedAt }));
  for (const alert of alerts) {
    const expected = evidenceWindow(alert, alert.evidenceDeletedAt ? [] : visible);
    if (alert.evidenceDeletedAt) expected.pending = false;
    assert.deepEqual(actual.get(alert.id), expected);
  }
  console.log(JSON.stringify({ sessions: sessions.length, segments: segments.length, alerts: alerts.length, elapsedMs: Math.round(elapsedMs), fullScanComparison: 'passed' }));
} finally {
  if (examId) await prisma.exam.delete({ where: { id: examId } });
  await prisma.$disconnect();
}
