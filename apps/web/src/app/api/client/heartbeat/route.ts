import { createHash } from 'node:crypto';
import { ClientHeartbeatSchema, type ClientHeartbeatInput } from '@cwnupaa/proctor-shared';
import type { AlertType, CandidateStatus } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { publicClientSession, verifyClientTokenForSession } from '@/lib/client-auth';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';
import { effectiveEnd } from '@/lib/contest-rules';
import { createAlertOnce } from '@/lib/alert-dedup';
import { MonitorAlertState, USB_SCAN_FAILURE_MESSAGE } from '@/lib/monitor-alert-state';
import { withSessionWrite, SessionWriteQueueError } from '@/lib/session-write';
import { revokeFullyOfflineSession } from '@/lib/session-revocation';
import { revokedClientSessionResponse } from '@/lib/client-session-response';
import { recordingEventsForSession } from '@/lib/recording-policy';
import { claimCandidateStatusRecheck, refreshCandidateAlertStatus } from '@/lib/alert-acknowledgement';

function abnormalMessages(input: ClientHeartbeatInput, requirements: { requireFrontCamera: boolean; requireMiniProgram: boolean }) {
  const messages: Array<{ type: AlertType; message: string }> = [];
  if (input.side === 'MINIPROGRAM') {
    if (requirements.requireMiniProgram && input.capture?.mobileCameraOk === false) messages.push({ type: 'MOBILE_CAMERA_LOST', message: '浏览器第二机位采集或推流异常' });
    return messages;
  }
  if (input.capture?.screenOk === false) messages.push({ type: 'SCREEN_CAPTURE_LOST', message: '电脑屏幕采集异常' });
  if (requirements.requireFrontCamera && input.capture?.desktopCameraOk === false) messages.push({ type: 'CAMERA_CAPTURE_LOST', message: '电脑摄像头采集异常' });
  if (input.system?.processes?.length) messages.push({ type: 'PROCESS_POLICY', message: `发现不允许的进程：${input.system.processes.join('、')}` });
  if (input.system?.networkRemotes?.length) messages.push({ type: 'NETWORK_POLICY', message: `发现外部域名活动（来源见括号）：${input.system.networkRemotes.join('、')}` });
  if (input.system?.vmSignals?.length) messages.push({ type: 'VIRTUAL_MACHINE', message: `疑似虚拟机环境：${input.system.vmSignals.join('、')}` });
  return messages;
}

class HeartbeatError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export async function POST(request: Request) {
  try {
    const input = await parseBody(request, ClientHeartbeatSchema);
    const selected = input.sessionId
      ? { id: input.sessionId }
      : await prisma.clientSession.findFirst({
          where: input.side === 'DESKTOP' ? { desktopDeviceId: input.deviceId } : { miniProgramDeviceId: input.deviceId },
          orderBy: { createdAt: 'desc' }, select: { id: true }
        });
    if (!selected) return fail('未找到有效客户端会话', 404);
    const result = await withSessionWrite(selected.id, async (tx) => {
      // Read after taking the lock: two sides must not restore an old heartbeat,
      // unlock a finished session, or both insert the same automatic alert.
      const session = await tx.clientSession.findUnique({ where: { id: selected.id }, include: {
        candidate: { select: { startedAt: true, abnormal: true, status: true } },
        exam: { select: {
          platform: true,
          startAt: true, latestStartAt: true, endAt: true, durationMinutes: true, contestRule: true, flexible: true,
          requireFrontCamera: true, requireMiniProgram: true, saveFullRecording: true, saveIncidentRecording: true
        } }
      } });
      if (!session) throw new HeartbeatError('未找到有效客户端会话', 404);
      if (session.revokedAt) return { revoked: true as const };
      const deviceId = input.side === 'DESKTOP' ? session.desktopDeviceId : session.miniProgramDeviceId;
      if (deviceId !== input.deviceId || !verifyClientTokenForSession(request, session, input.side)) {
        throw new HeartbeatError('客户端会话令牌无效或已过期，请通过配对或重连恢复', 401);
      }
      const { candidate: _candidate, exam: _exam, ...sessionRow } = session;
      const now = new Date();
      const publicTest = await isPublicTestExam(session.examId, tx);
      const room = await tx.examRoom.findFirst({
        where: { examId: session.examId, candidates: { some: { candidateId: session.candidateId } } },
        select: { requireFrontCamera: true, requireSecondCamera: true }
      });
      const requireFrontCamera = room?.requireFrontCamera ?? session.exam.requireFrontCamera;
      const requireSecondCamera = room?.requireSecondCamera ?? session.exam.requireMiniProgram;
      const requirements = { requireFrontCamera, requireSecondCamera, isPublicTest: publicTest,
        saveFullRecording: !publicTest && session.exam.saveFullRecording,
        saveIncidentRecording: !publicTest && session.exam.saveIncidentRecording };
      if (await revokeFullyOfflineSession(tx, session, requireSecondCamera, now)) return { revoked: true as const };
      const effectiveEndAt = effectiveEnd(session.exam, session.candidate.startedAt || session.startedAt);
      const heartbeatData = input.side === 'DESKTOP'
        ? { lastDesktopSeenAt: now, desktopOfflineAt: null }
        : { lastMiniProgramSeenAt: now, miniProgramOfflineAt: null };
      if (session.status === 'FINISHED' || effectiveEndAt <= now) {
        const data = { ...heartbeatData, status: 'FINISHED' as const, endedAt: session.endedAt || now,
          lockdown: false, lockdownReason: null, updatedAt: now };
        await tx.clientSession.updateMany({ where: { id: session.id }, data });
        const item = { ...sessionRow, ...data };
        // An old, expired session must not finish a newer login by the same candidate.
        if (session.status !== 'FINISHED') await tx.candidate.update({ where: { id: session.candidateId }, data: { status: 'FINISHED' } });
        return { publicTest, novaJudge: session.exam.platform === 'NOVAJUDGE', session: { ...publicClientSession(item), effectiveEndAt: effectiveEndAt.toISOString() }, requirements, alertsCreated: 0 };
      }
      const messages: Array<{ type: AlertType; message: string; id?: string }> = publicTest ? [] : abnormalMessages(input, { requireFrontCamera, requireMiniProgram: requireSecondCamera });
      const peripheralScanFailed = !publicTest && input.side === 'DESKTOP' && input.system?.peripheralScanOk === false;
      if (peripheralScanFailed) messages.push({ type: 'PERIPHERAL_CHANGED', message: USB_SCAN_FAILURE_MESSAGE });
      const fingerprint = !publicTest && input.side === 'DESKTOP' && !peripheralScanFailed ? input.system?.peripheralsFingerprint?.trim() : undefined;
      const previousBaseline = session.peripheralsBaselineFingerprint;
      const upgradedPeripheralScan = Boolean(
        fingerprint && previousBaseline && (
          /^[0-9a-f]{64}$/.test(previousBaseline) && /^(?:usb-v[3456]|mac-usb-v2|mac-usb-v3):[0-9a-f]{64}$/.test(fingerprint)
          || /^mac-usb-v2:[0-9a-f]{64}$/.test(previousBaseline) && /^mac-usb-v3:[0-9a-f]{64}$/.test(fingerprint)
          || /^usb-v3:[0-9a-f]{64}$/.test(previousBaseline) && /^usb-v4:[0-9a-f]{64}$/.test(fingerprint)
          || /^usb-v[34]:[0-9a-f]{64}$/.test(previousBaseline) && /^usb-v5:[0-9a-f]{64}$/.test(fingerprint)
          || /^usb-v[345]:[0-9a-f]{64}$/.test(previousBaseline) && /^usb-v6:[0-9a-f]{64}$/.test(fingerprint)
        ) &&
        session.lastPeripheralsFingerprint === previousBaseline && !session.lockdown
      );
      const baselineFingerprint = upgradedPeripheralScan ? fingerprint : previousBaseline;
      const peripheralChanged = Boolean(fingerprint && baselineFingerprint && fingerprint !== baselineFingerprint);
      const newPeripheralChange = peripheralChanged && fingerprint !== session.lastPeripheralsFingerprint;
      const acceptedPeripheralEventIds: string[] = [];
      const usbMessages: Array<{ type: AlertType; message: string; id: string }> = [];
      if (input.side === 'DESKTOP') for (const event of input.system?.peripheralEvents || []) {
        if (acceptedPeripheralEventIds.includes(event.id)) continue;
        acceptedPeripheralEventIds.push(event.id);
        if (publicTest) continue;
        const id = 'usb_event_' + createHash('sha256').update(`${session.id}:${event.id}`).digest('hex');
        if (await tx.alert.findFirst({ where: { sessionId: session.id, id } })) continue;
        usbMessages.push({ id, type: 'PERIPHERAL_CHANGED', message: `检测到 USB 外设${event.action === 'INSERT' ? '接入' : '移除'}：${event.deviceId}` });
      }
      messages.push(...usbMessages);

      const peripheralMessage = peripheralChanged ? `检测到外设接入或移除，原始指纹 ${baselineFingerprint}，当前指纹 ${fingerprint}` : '';
      if (newPeripheralChange && !usbMessages.length && !(session.lockdown && session.lockdownReason?.startsWith('检测到 USB 外设'))) messages.push({ type: 'PERIPHERAL_CHANGED', message: peripheralMessage });
      const firstStartedAt = session.candidate.startedAt || session.startedAt;
      const recoveredStatus = session.status === 'OFFLINE' && input.side === 'DESKTOP'
        ? firstStartedAt ? 'IN_EXAM' : session.approvedAt ? 'APPROVED' : 'WAITING_REVIEW'
        : session.status;
      const shouldLockdown = usbMessages.length > 0 || newPeripheralChange || peripheralScanFailed || session.lockdown;
      const monitorState = new MonitorAlertState(session.monitoringAlertState);
      if (!publicTest) {
        if (input.side === 'DESKTOP') {
          monitorState.observe('CLIENT_OFFLINE', true, now);
          monitorState.observe('USB_SCAN_FAILED', input.system?.peripheralScanOk, now);
          monitorState.observe('SCREEN_CAPTURE_LOST', input.capture?.screenOk, now);
          monitorState.observe('CAMERA_CAPTURE_LOST', !requireFrontCamera || input.capture?.desktopCameraOk, now);
          monitorState.observe('PROCESS_POLICY', input.system?.processes ? input.system.processes.length === 0 : undefined, now);
          monitorState.observe('NETWORK_POLICY', input.system?.networkRemotes ? input.system.networkRemotes.length === 0 : undefined, now);
          monitorState.observe('VIRTUAL_MACHINE', input.system?.vmSignals ? input.system.vmSignals.length === 0 : undefined, now);
        } else {
          monitorState.observe('SECOND_CAMERA_OFFLINE', true, now);
          monitorState.observe('MOBILE_CAMERA_LOST', !requireSecondCamera || input.capture?.mobileCameraOk, now);
        }
      }
      let alertsCreated = 0;
      const evidenceByChannel = new Map<string, { objectPath: string } | null>();
      for (const item of messages) {
        const channel = item.type === 'MOBILE_CAMERA_LOST' ? 'MOBILE_CAMERA' : item.type === 'CAMERA_CAPTURE_LOST' ? 'DESKTOP_CAMERA' : 'DESKTOP_SCREEN';
        const evidence = async () => {
          if (!evidenceByChannel.has(channel)) evidenceByChannel.set(channel, await tx.mediaSegment.findFirst({
            where: { sessionId: session.id, deletedAt: null, channel, startedAt: { gte: new Date(now.getTime() - 30_000), lte: now } },
            orderBy: { startedAt: 'desc' }, select: { objectPath: true }
          }));
          return evidenceByChannel.get(channel)?.objectPath;
        };
        const data = {
          examId: session.examId, candidateId: session.candidateId, sessionId: session.id,
          type: item.type, severity: item.type === 'PERIPHERAL_CHANGED' ? 5 : item.type === 'VIRTUAL_MACHINE' ? 3 : 4,
          message: item.message, ...(item.id ? { id: item.id } : {})
        };
        // USB changes already have a stricter fingerprint transition guard. A
        // second real change after an accepted baseline needs its own evidence.
        const result = item.type === 'PERIPHERAL_CHANGED' && item.message !== USB_SCAN_FAILURE_MESSAGE
          ? await createAlertOnce(tx, data, now, { evidence, bypassCooldown: true })
          : await monitorState.report(tx, data, { now, evidence });
        if (result.created) alertsCreated += 1;
      }
      const data = {
        ...heartbeatData,
        ...(monitorState.changed ? { monitoringAlertState: monitorState.toJson() } : {}),
        status: shouldLockdown ? 'LOCKED' as const : recoveredStatus,
        startedAt: firstStartedAt,
        updatedAt: now,
        ...(fingerprint ? {
          peripheralsBaselineFingerprint: baselineFingerprint || fingerprint,
          lastPeripheralsFingerprint: fingerprint
        } : {}),
        ...(usbMessages.length ? { lockdown: true, lockdownReason: usbMessages[0].message }
          : newPeripheralChange ? { lockdown: true, lockdownReason: peripheralMessage }
          : peripheralScanFailed && !session.lockdown ? { lockdown: true, lockdownReason: USB_SCAN_FAILURE_MESSAGE } : {})
      };
      // We already hold this row's write lock and have its complete scalar
      // snapshot. MySQL cannot RETURNING, so update() would select it again.
      await tx.clientSession.updateMany({ where: { id: session.id }, data });
      const { monitoringAlertState: _monitoringAlertState, ...responseData } = data;
      const refreshed = { ...sessionRow, ...responseData };
      const otherOffline = input.side === 'DESKTOP' ? requireSecondCamera && Boolean(session.miniProgramOfflineAt) : Boolean(session.desktopOfflineAt);
      // A handled, still-active episode remains deduplicated. Repeating its
      // raw observation must not undo a proctor's acknowledgement on every
      // heartbeat; a genuinely new alert/escalation restores abnormal state.
      const abnormal = alertsCreated > 0 || otherOffline || shouldLockdown || session.candidate.abnormal;
      const desktopStillOffline = input.side === 'MINIPROGRAM' && (session.status === 'OFFLINE' || Boolean(session.desktopOfflineAt));
      const candidateStatusFor = (isAbnormal: boolean): CandidateStatus => desktopStillOffline ? 'OFFLINE'
        : shouldLockdown || alertsCreated > 0 ? 'ONLINE_ABNORMAL'
          : recoveredStatus === 'WAITING_REVIEW' ? 'REQUESTING'
            : firstStartedAt ? isAbnormal ? 'ONLINE_ABNORMAL' : 'ONLINE_NORMAL' : 'APPROVED';
      const candidateStatus = candidateStatusFor(abnormal);
      const recoveredConnection = input.side === 'DESKTOP'
        ? session.status === 'OFFLINE' || Boolean(session.desktopOfflineAt)
        : Boolean(session.miniProgramOfflineAt);
      const repairHistoricalFlag = !alertsCreated && !shouldLockdown && !otherOffline && !desktopStillOffline
        && (session.candidate.abnormal || session.candidate.status === 'ONLINE_ABNORMAL')
        && claimCandidateStatusRecheck(session.id, now);
      if (recoveredConnection || repairHistoricalFlag) {
        // An ack while offline/locked deliberately keeps the safety state. Once
        // it recovers, clear that flag only after checking remaining incidents.
        await refreshCandidateAlertStatus(tx, session.candidateId, now);
      } else if (alertsCreated > 0 || shouldLockdown && !session.lockdown
        || candidateStatus !== session.candidate.status || abnormal !== session.candidate.abnormal) {
        // Other sessions can create or handle incidents after our initial
        // snapshot. Lock and merge the latest candidate state only when a real
        // transition needs a write; ordinary unchanged heartbeats do no read.
        await tx.$queryRaw`SELECT id FROM Candidate WHERE id = ${session.candidateId} FOR UPDATE`;
        const latest = await tx.candidate.findUniqueOrThrow({ where: { id: session.candidateId }, select: { abnormal: true, status: true } });
        if (latest.status !== session.candidate.status || latest.abnormal !== session.candidate.abnormal) {
          // A cross-session transition can also change physical OFFLINE or
          // FINISHED state. Reconcile that rare race from all current sessions.
          await refreshCandidateAlertStatus(tx, session.candidateId, now, true);
        } else {
          const nextAbnormal = alertsCreated > 0 || otherOffline || shouldLockdown || latest.abnormal;
          // OFFLINE may describe another active session. Only the full
          // recovery reconciliation can prove every required side is back.
          const nextStatus = latest.status === 'FINISHED' || latest.status === 'OFFLINE' ? latest.status : candidateStatusFor(nextAbnormal);
          if (nextStatus !== latest.status || nextAbnormal !== latest.abnormal) {
            await tx.candidate.update({ where: { id: session.candidateId }, data: { status: nextStatus, abnormal: nextAbnormal } });
          }
        }
      }
      return { publicTest, novaJudge: session.exam.platform === 'NOVAJUDGE', session: { ...publicClientSession(refreshed), effectiveEndAt: effectiveEndAt.toISOString() }, requirements, alertsCreated, acceptedPeripheralEventIds };
    });
    if ('revoked' in result) return revokedClientSessionResponse();
    const { publicTest, novaJudge, ...response } = result;
    const recordingEvents = publicTest || response.requirements?.saveIncidentRecording !== true ? [] : await recordingEventsForSession(selected.id);
    const retry = novaJudge && input.side === 'DESKTOP' ? await prisma.oJLoginTicket.findFirst({
      where: { sessionId: selected.id, status: 'ISSUED', exam: { platform: 'NOVAJUDGE' } },
      orderBy: { createdAt: 'desc' }, select: { id: true },
    }) : null;
    return ok({ ...response, recordingEvents, ojLoginRetryId: retry?.id || null, desktopSessionToken: null, miniProgramSessionToken: null });
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof HeartbeatError) return fail(error.message, error.status);
    if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
