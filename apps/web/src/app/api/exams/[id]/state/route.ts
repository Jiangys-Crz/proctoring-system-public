import { SessionWriteQueueError } from '@/lib/session-write';
import { AuthError, requireUser } from '@/lib/auth';
import { getExamAccess } from '@/lib/permissions';
import { loadMonitorData, loadMonitorExam } from '@/lib/monitor-state-data';
import { finalizeEndedExam, markStaleSessionsOffline } from '@/lib/session-health';
import { publicClientSession } from '@/lib/client-auth';
import { publicObjectUrl } from '@/lib/storage';
import { options, fail, ok, toErrorMessage } from '@/lib/http';
import { flexibleExam } from '@/lib/contest-rules';
import { evidenceForAlerts } from '@/lib/alert-evidence';
import { publicDto } from '@/lib/public-dto';
import { monitorLiveStatus } from '@/lib/monitor-live-status';

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const user = await requireUser();
    const { id } = await context.params;
    const { accessible, manageable } = await getExamAccess(user, id);
    if (!accessible) return fail('无权查看该考试', 403);
    const exam = await loadMonitorExam(id);
    if (!exam) return fail('考试不存在', 404);
    if (exam.endAt.getTime() <= Date.now()) {
      await finalizeEndedExam(exam);
    } else {
      await markStaleSessionsOffline(id);
    }
    const { candidates, loginRequests, sessions, alerts, mediaSegments, rooms, cheatingRecords, printJobs, liveFrames } =
      await loadMonitorData(id, user.id, manageable);

    const [evidence, liveStatus] = await Promise.all([evidenceForAlerts(alerts), monitorLiveStatus(sessions)]);
    const [safeLoginRequests, safeAlerts, safeMediaSegments, safeLiveFrames] = await Promise.all([
      Promise.all(
        loginRequests.map(async (item) => ({
          ...item,
          identityPhotoPath: await publicObjectUrl(item.identityPhotoPath),
          roomVideoPath: await publicObjectUrl(item.roomVideoPath)
        }))
      ),
      Promise.all(
        alerts.map(async (item) => ({
          ...item,
          evidencePath: await publicObjectUrl(item.evidencePath),
          evidence: evidence.get(item.id)
        }))
      ),
      Promise.all(
        mediaSegments.map(async (item) => ({
          ...item,
          objectPath: (await publicObjectUrl(item.objectPath)) || item.objectPath
        }))
      ),
      Promise.all(
        liveFrames.map(async (item) => ({
          ...item,
          objectPath: (await publicObjectUrl(item.objectPath)) || item.objectPath
        }))
      )
    ]);

    return ok(publicDto({
      exam: { ...exam, flexible: flexibleExam(exam) },
      candidates,
      loginRequests: safeLoginRequests,
      sessions: sessions.map((session) => publicClientSession(session)),
      alerts: safeAlerts,
      mediaSegments: safeMediaSegments,
      liveFrames: safeLiveFrames,
      ...liveStatus,
      rooms,
      cheatingRecords,
      printJobs
    }));
  } catch (error) {
    if (error instanceof SessionWriteQueueError) return fail(error.message, error.status);
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
