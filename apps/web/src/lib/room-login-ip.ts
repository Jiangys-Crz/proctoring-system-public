import type { Prisma } from '@prisma/client';
import { prisma } from './db';
import { LoginFlowError } from './room-login-policy';

type Db = Pick<Prisma.TransactionClient, 'exam' | 'examRoom' | 'systemSetting' | 'platformSyncItem'>;
type Exam = { id: string; examCode: string; ipLoginRestrictionEnabled: boolean };
type Room = { id: string; name: string };
const key = (examId: string, roomId: string) => `room-login-ip:${examId}:${roomId}`;

/** Room policy is transported in ROOM snapshots. Bound candidate IPs never are. */
export async function roomLoginIpPolicies(db: Db, exam: Exam, rooms: readonly Room[]) {
  if (!rooms.length) return [];
  const [settings, snapshots] = await Promise.all([
    db.systemSetting.findMany({ where: { key: { in: rooms.map(room => key(exam.id, room.id)) } }, select: { key: true, value: true } }),
    db.platformSyncItem.findMany({ where: { scope: exam.examCode, kind: 'ROOM', localId: { in: rooms.map(room => room.id) }, deleted: false }, select: { localId: true, payload: true } }),
  ]);
  const configured = new Map(settings.map(row => [row.key, (row.value as { enabled?: unknown })?.enabled]));
  // An older receiver may have saved a new peer's ROOM snapshot before this
  // feature was installed. Honor that policy instead of reversing it on boot.
  const received = new Map(snapshots.map(row => [row.localId, (row.payload as { ipLoginRestrictionEnabled?: unknown })?.ipLoginRestrictionEnabled]));
  return rooms.map(room => {
    const override = configured.get(key(exam.id, room.id)), remote = received.get(room.id);
    return { ...room, enabled: typeof override === 'boolean' ? override : typeof remote === 'boolean' ? remote : exam.ipLoginRestrictionEnabled };
  });
}

export async function setRoomLoginIpPolicy(db: Db, examId: string, roomId: string, enabled: boolean) {
  const value = { enabled };
  await db.systemSetting.upsert({ where: { key: key(examId, roomId) },
    create: { key: key(examId, roomId), value }, update: { value } });
}

export async function deleteRoomLoginIpPolicy(db: Db, examId: string, roomId: string) {
  await db.systemSetting.deleteMany({ where: { key: key(examId, roomId) } });
}

export async function examRoomLoginIpPolicies(examId: string, db: Db = prisma) {
  const [exam, rooms] = await Promise.all([
    db.exam.findUnique({ where: { id: examId }, select: { id: true, examCode: true, ipLoginRestrictionEnabled: true } }),
    db.examRoom.findMany({ where: { examId }, select: { id: true, name: true }, orderBy: [{ name: 'asc' }, { id: 'asc' }] }),
  ]);
  if (!exam) throw new LoginFlowError('考试不存在', 404);
  return { defaultEnabled: exam.ipLoginRestrictionEnabled, rooms: await roomLoginIpPolicies(db, exam, rooms) };
}

export async function candidateLoginIpEnabled(db: Db, examId: string, candidateId: string) {
  const [exam, rooms] = await Promise.all([
    db.exam.findUnique({ where: { id: examId }, select: { id: true, examCode: true, ipLoginRestrictionEnabled: true } }),
    db.examRoom.findMany({ where: { examId, candidates: { some: { candidateId } } }, select: { id: true, name: true } }),
  ]);
  if (!exam) throw new LoginFlowError('考试不存在', 404);
  if (!rooms.length) return exam.ipLoginRestrictionEnabled;
  // Invalid historical multi-room assignments must not bypass an enabled room.
  return (await roomLoginIpPolicies(db, exam, rooms)).some(room => room.enabled);
}

export function restrictedCandidateWhere(examId: string, policy: { defaultEnabled: boolean; rooms: readonly { id: string; enabled: boolean }[] }): Prisma.CandidateWhereInput {
  return { OR: [
    { rooms: { some: { roomId: { in: policy.rooms.filter(room => room.enabled).map(room => room.id) }, room: { examId } } } },
    ...(policy.defaultEnabled ? [{ rooms: { none: { room: { examId } } } }] : []),
  ] };
}
