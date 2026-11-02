import { z } from 'zod';
import type { Prisma } from '@prisma/client';
import { prisma } from '@/lib/db';
import { isPublicTestExam } from '@/lib/public-test';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { publicDto, PUBLIC_USER_SELECT } from '@/lib/public-dto';
import { options, fail, ok, parseBody, RequestParseError, toErrorMessage } from '@/lib/http';

const RoomUpsertSchema = z.object({
  id: z.string().trim().min(1).optional(),
  name: z.string().trim().min(1).max(100),
  proctorNumberIds: z.array(z.string().min(1)).min(1),
  candidateExamNumbers: z.array(z.string().min(1)).default([]),
  requireSecondCamera: z.boolean().optional(),
  requireFrontCamera: z.boolean().optional(),
  loginMode: z.enum(['CREDENTIALS', 'SECOND_CAMERA_QR']).optional(),
  loginReviewMode: z.enum(['MANUAL', 'AUTO']).optional()
});

const RoomsUpsertSchema = z.object({
  rooms: z.array(RoomUpsertSchema).min(1)
});

type RoomUpsertInput = z.infer<typeof RoomUpsertSchema>;

function uniqueTrimmed(values: string[]) {
  return Array.from(new Set(values.map((item) => item.trim()).filter(Boolean)));
}

async function upsertRoom(tx: Prisma.TransactionClient, examId: string, input: RoomUpsertInput) {
  const proctorNumberIds = uniqueTrimmed(input.proctorNumberIds);
  const candidateExamNumbers = uniqueTrimmed(input.candidateExamNumbers);
  const roomName = input.name.trim();
  if (input.id && !await tx.examRoom.findFirst({ where: { id: input.id, examId }, select: { id: true } })) throw new RequestParseError('考室不存在');
  const upserted = input.id
    ? await tx.examRoom.update({
        where: { id: input.id },
        data: {
          name: roomName,
          ...(input.requireSecondCamera === undefined ? {} : { requireSecondCamera: input.requireSecondCamera }),
          ...(input.requireFrontCamera === undefined ? {} : { requireFrontCamera: input.requireFrontCamera }),
          ...(input.loginMode === undefined ? {} : { loginMode: input.loginMode }),
          ...(input.loginReviewMode === undefined ? {} : { loginReviewMode: input.loginReviewMode })
        }
      })
    : await tx.examRoom.create({
        data: {
          examId,
          name: roomName,
          requireSecondCamera: input.requireSecondCamera ?? true,
          requireFrontCamera: input.requireFrontCamera ?? true,
          loginMode: input.loginMode ?? 'CREDENTIALS',
          loginReviewMode: input.loginReviewMode ?? 'MANUAL'
        }
      });

  if (upserted.examId !== examId) throw new RequestParseError('考室不存在');

  let candidates = candidateExamNumbers.length
    ? await tx.candidate.findMany({
        where: {
          examId,
          examNumber: { in: candidateExamNumbers }
        }
      })
    : [];
  const foundExamNumbers = new Set(candidates.map((candidate) => candidate.examNumber));
  const missingCandidateExamNumbers = candidateExamNumbers.filter((examNumber) => !foundExamNumbers.has(examNumber));
  if (missingCandidateExamNumbers.length) {
    throw new RequestParseError(`考室 ${input.name} 中存在未导入的考号`, { missingCandidateExamNumbers });
  }
  const teamNames = Array.from(new Set(candidates.map(candidate => candidate.teamName).filter((name): name is string => Boolean(name))));
  if (teamNames.length) {
    const teamMembers = await tx.candidate.findMany({ where: { examId, teamName: { in: teamNames } } });
    candidates = Array.from(new Map([...candidates, ...teamMembers].map(candidate => [candidate.id, candidate])).values());
  }

  await tx.examRoomProctor.deleteMany({ where: { roomId: upserted.id } });
  await tx.examRoomCandidate.deleteMany({ where: { roomId: upserted.id } });
  if (candidates.length) {
    await tx.examRoomCandidate.deleteMany({
      where: { candidateId: { in: candidates.map(candidate => candidate.id) }, room: { examId } }
    });
  }

  const proctors = [];
  for (const numberId of proctorNumberIds) {
    const matches = await tx.user.findMany({ where: { numberId } });
    if (matches.length > 1) throw new RequestParseError(`监考学号 ${numberId} 对应多个用户，请使用“姓名＋学号”指定监考员`);
    const qualified = numberId.match(/^(.+)[+＋]([^+＋]+)$/);
    const found = qualified ? await tx.user.findUnique({ where: { realName_numberId: { realName: qualified[1].trim(), numberId: qualified[2].trim() } } }) : matches[0];
    if (qualified && !found) throw new RequestParseError(`监考员 ${numberId} 尚未导入`);
    proctors.push(found || await tx.user.create({ data: { numberId, role: 'ADMIN' } }));
  }
  for (const proctor of new Map(proctors.map(user => [user.id, user])).values()) {
    await tx.examRoomProctor.create({
      data: { roomId: upserted.id, userId: proctor.id }
    });
  }
  for (const candidate of candidates) {
    await tx.examRoomCandidate.create({
      data: { roomId: upserted.id, candidateId: candidate.id }
    });
  }

  return tx.examRoom.findUnique({
    where: { id: upserted.id },
    include: {
      proctors: { include: { user: { select: PUBLIC_USER_SELECT } } },
      candidates: { include: { candidate: true } }
    }
  });
}

export async function GET(_request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin();
    const { id } = await context.params;
    const rooms = await prisma.examRoom.findMany({
      where: { examId: id },
      include: {
        proctors: { include: { user: { select: PUBLIC_USER_SELECT } }, orderBy: { user: { numberId: 'asc' } } },
        candidates: { include: { candidate: true }, orderBy: { candidate: { seatNo: 'asc' } } }
      },
      orderBy: { createdAt: 'asc' }
    });
    return ok(publicDto(rooms));
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin(request);
    const { id } = await context.params;
    if (await isPublicTestExam(id)) return fail('公开测试考室由系统维护，必须使用第二机位', 403);
    const body = await request.json();
    const roomsInput = 'rooms' in body ? RoomsUpsertSchema.parse(body).rooms : [RoomUpsertSchema.parse(body)];
    const exam = await prisma.exam.findUnique({ where: { id } });
    if (!exam) return fail('考试不存在', 404);

    const rooms = await prisma.$transaction(async (tx) => {
      const result = [];
      for (const roomInput of roomsInput) {
        result.push(await upsertRoom(tx, id, roomInput));
      }
      return result;
    });

    return ok(publicDto(roomsInput.length === 1 ? rooms[0] : { imported: rooms.length, rooms }), { status: 201 });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    if (error instanceof RequestParseError || error instanceof z.ZodError) return fail(error.message || '请求参数不正确', 400, error instanceof RequestParseError ? error.details : error.flatten());
    if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') return fail('本场考试已存在同名考室，请使用不同的考室名称；修改已有考室请点击“修改”', 409);
    return fail(toErrorMessage(error), 500);
  }
}

export async function DELETE(request: Request, context: { params: Promise<{ id: string }> }) {
  try {
    await requireSuperAdmin(request);
    const { id } = await context.params;
    if (await isPublicTestExam(id)) return fail('公开测试考室长期开放，不能删除', 403);
    const { searchParams } = new URL(request.url);
    const roomId = searchParams.get('roomId');
    if (!roomId) return fail('缺少 roomId', 400);
    const room = await prisma.examRoom.findFirst({ where: { id: roomId, examId: id } });
    if (!room) return fail('考室不存在', 404);
    await prisma.examRoom.delete({ where: { id: roomId } });
    return ok({ deleted: true });
  } catch (error) {
    if (error instanceof AuthError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}

export const OPTIONS = options;
