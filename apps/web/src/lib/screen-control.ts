import type { Prisma, ScreenControlDisplay, ScreenControlGroup, ScreenControlImage } from '@prisma/client';
import { prisma } from './db';
import { readScreenImageTemplate, unsupportedScreenFields, type ScreenImageTemplate } from './screen-control-template';
import {
  effectiveScreenDisplay, SCREEN_CONTROL_INTERVAL_MS, SCREEN_CONTROL_MAX_GROUPS,
  ScreenControlError, validateScreenDisplayTimes, validateScreenImageOrder,
} from './screen-control-policy';

type GroupWithImages = Pick<ScreenControlGroup, 'id' | 'examId' | 'name' | 'createdAt' | 'updatedAt'> & {
  images: Array<Pick<ScreenControlImage, 'id' | 'name' | 'order' | 'width' | 'height' | 'byteSize'> & { template?: unknown }>;
};
type DisplayWithGroup = ScreenControlDisplay & { group: GroupWithImages };
export interface NewScreenControlImage {
  name: string; objectPath: string; contentType: string; byteSize: number; width: number; height: number;
}
const groupInclude = { images: { orderBy: [{ order: 'asc' as const }, { id: 'asc' as const }] } };
const displayInclude = { group: { include: groupInclude } };
// Legacy clients poll frequently and only need image metadata. Keep templates
// and storage paths out of these reads as well as out of the public response.
const clientDisplayInclude = { group: { select: {
  id: true, examId: true, name: true, createdAt: true, updatedAt: true,
  images: { select: { id: true, name: true, order: true, width: true, height: true, byteSize: true }, ...groupInclude.images },
} } } as const;
const displayOrder = [{ startsAt: 'desc' as const }, { sequence: 'desc' as const }];

export function serializeScreenControlGroup(group: GroupWithImages, sessionId?: string) {
  return {
    id: group.id, name: group.name, createdAt: group.createdAt.toISOString(), updatedAt: group.updatedAt.toISOString(),
    images: group.images.map((image) => ({
      id: image.id, name: image.name, order: image.order, width: image.width, height: image.height, byteSize: image.byteSize,
      ...(!sessionId ? { template: readScreenImageTemplate(image.template) } : {}),
      url: sessionId
        ? `/api/client/screen-control/images/${encodeURIComponent(image.id)}?sessionId=${encodeURIComponent(sessionId)}`
        : `/api/exams/${encodeURIComponent(group.examId)}/screen-control/images/${encodeURIComponent(image.id)}`,
    })),
  };
}

export function serializeScreenControlDisplay(display: DisplayWithGroup, sessionId?: string) {
  return {
    id: display.id, groupId: display.groupId, groupName: display.groupName,
    startsAt: display.startsAt.toISOString(), endsAt: display.endsAt?.toISOString() || null,
    stoppedAt: display.stoppedAt?.toISOString() || null, canceledAt: display.canceledAt?.toISOString() || null,
    createdAt: display.createdAt.toISOString(), intervalMs: SCREEN_CONTROL_INTERVAL_MS,
    images: serializeScreenControlGroup(display.group, sessionId).images,
  };
}

async function latestScreenDisplay(db: Prisma.TransactionClient, examId: string, now: Date) {
  return db.screenControlDisplay.findFirst({
    where: { examId, startsAt: { lte: now }, canceledAt: null }, orderBy: displayOrder, include: displayInclude,
  });
}

export async function getClientScreenControl(examId: string, sessionId: string, now = new Date()) {
  const [latest, next] = await Promise.all([
    prisma.screenControlDisplay.findFirst({
      where: { examId, startsAt: { lte: now }, canceledAt: null }, orderBy: displayOrder, include: clientDisplayInclude,
    }),
    prisma.screenControlDisplay.findFirst({
      where: { examId, startsAt: { gt: now }, canceledAt: null, stoppedAt: null },
      orderBy: [{ startsAt: 'asc' }, { sequence: 'desc' }], select: { startsAt: true },
    }),
  ]);
  const active = latest ? effectiveScreenDisplay([latest], now) : null;
  return { serverNow: now.toISOString(), active: active ? serializeScreenControlDisplay(active, sessionId) : null,
    nextStartsAt: next?.startsAt.toISOString() || null };
}

export async function getAdminScreenControl(examId: string, now = new Date()) {
  const [groups, latest, schedules, history] = await Promise.all([
    prisma.screenControlGroup.findMany({ where: { examId, deletedAt: null }, include: groupInclude, orderBy: { createdAt: 'desc' } }),
    latestScreenDisplay(prisma, examId, now),
    prisma.screenControlDisplay.findMany({
      where: { examId, startsAt: { gt: now }, stoppedAt: null, canceledAt: null }, include: displayInclude,
      orderBy: [{ startsAt: 'asc' }, { sequence: 'asc' }], take: 100,
    }),
    prisma.screenControlDisplay.findMany({
      where: { examId, OR: [{ startsAt: { lte: now } }, { canceledAt: { not: null } }] },
      include: displayInclude, orderBy: displayOrder, take: 50,
    }),
  ]);
  const current = latest ? effectiveScreenDisplay([latest], now) : null;
  return { serverNow: now.toISOString(), current: current ? serializeScreenControlDisplay(current) : null,
    groups: groups.map((group) => serializeScreenControlGroup(group)),
    schedules: schedules.map((display) => serializeScreenControlDisplay(display)),
    history: history.map((display) => serializeScreenControlDisplay(display)) };
}

async function mutateScreenControl<T>(examId: string, mutation: (tx: Prisma.TransactionClient) => Promise<T>) {
  return prisma.$transaction(async (tx) => {
    // A row lock serializes every mutation for this exam, so competing pushes,
    // stops, group edits and schedule creations cannot bypass each other's checks.
    const exam = await tx.exam.updateMany({ where: { id: examId }, data: { updatedAt: new Date() } });
    if (!exam.count) throw new ScreenControlError('考试不存在', 404);
    return mutation(tx);
  }, { maxWait: 10_000, timeout: 15_000, isolationLevel: 'ReadCommitted' });
}

async function editableScreenGroup(tx: Prisma.TransactionClient, examId: string, groupId: string, now: Date) {
  const group = await tx.screenControlGroup.findFirst({ where: { id: groupId, examId, deletedAt: null }, include: groupInclude });
  if (!group) throw new ScreenControlError('图片组不存在', 404);
  const [latest, future] = await Promise.all([
    latestScreenDisplay(tx, examId, now),
    tx.screenControlDisplay.findFirst({ where: { examId, groupId, startsAt: { gt: now }, stoppedAt: null, canceledAt: null }, select: { id: true } }),
  ]);
  const active = latest ? effectiveScreenDisplay([latest], now) : null;
  if (active?.groupId === groupId || future) throw new ScreenControlError('该组正在展示或用于定时展示，请先关闭或取消计划', 409);
  return group;
}

export async function createScreenControlGroup(examId: string, name: string, images: NewScreenControlImage[], createdById: string) {
  return mutateScreenControl(examId, async (tx) => {
    const count = await tx.screenControlGroup.count({ where: { examId, deletedAt: null } });
    if (count >= SCREEN_CONTROL_MAX_GROUPS) throw new ScreenControlError(`每场考试最多创建 ${SCREEN_CONTROL_MAX_GROUPS} 个图片组`, 409);
    const group = await tx.screenControlGroup.create({ data: { examId, name, createdById,
      images: { create: images.map((image, order) => ({ ...image, order })) } }, include: groupInclude });
    return serializeScreenControlGroup(group);
  });
}

export async function updateScreenControlGroup(examId: string, groupId: string, input: {
  name?: string; imageIds?: string[]; expectedUpdatedAt?: string;
  templates?: { imageId: string; template: ScreenImageTemplate | null }[];
}) {
  return mutateScreenControl(examId, async (tx) => {
    const group = await editableScreenGroup(tx, examId, groupId, new Date());
    if (input.expectedUpdatedAt && group.updatedAt.toISOString() !== input.expectedUpdatedAt) {
      throw new ScreenControlError('图片组已被其他操作更新，请关闭编辑器并重新打开', 409);
    }
    if (input.templates) {
      const ids = input.templates.map(item => item.imageId);
      if (new Set(ids).size !== ids.length || ids.some(id => !group.images.some(image => image.id === id))) {
        throw new ScreenControlError('只能设置当前图片组中的图片，且图片不能重复');
      }
      const exam = await tx.exam.findUniqueOrThrow({ where: { id: examId }, select: { contestType: true } });
      for (const item of input.templates) {
        const template = readScreenImageTemplate(item.template);
        if (template && unsupportedScreenFields(template, exam.contestType === 'TEAM').length) {
          throw new ScreenControlError('模板包含当前赛制不支持的字段，请使用可添加字段中的选项');
        }
        await tx.screenControlImage.update({ where: { id: item.imageId, groupId }, data: { template: template || { version: 1, blocks: [] } } });
      }
    }
    if (input.imageIds) {
      validateScreenImageOrder(group.images.map((image) => image.id), input.imageIds);
      for (const [order, id] of input.imageIds.entries()) await tx.screenControlImage.update({ where: { id, groupId }, data: { order } });
    }
    const updated = await tx.screenControlGroup.update({ where: { id: groupId }, data: { name: input.name, updatedAt: new Date() }, include: groupInclude });
    return serializeScreenControlGroup(updated);
  });
}

export async function deleteScreenControlGroup(examId: string, groupId: string) {
  return mutateScreenControl(examId, async (tx) => {
    await editableScreenGroup(tx, examId, groupId, new Date());
    // Keep past displays and their images available in the administrator's history.
    await tx.screenControlGroup.update({ where: { id: groupId }, data: { deletedAt: new Date() } });
    return { id: groupId };
  });
}

export async function createScreenControlDisplay(examId: string, input: { groupId: string; startsAt?: string; endsAt?: string | null }, createdById: string) {
  return mutateScreenControl(examId, async (tx) => {
    const now = new Date();
    const { startsAt, endsAt } = validateScreenDisplayTimes(input, now);
    const group = await tx.screenControlGroup.findFirst({ where: { id: input.groupId, examId, deletedAt: null }, include: groupInclude });
    if (!group?.images.length) throw new ScreenControlError('请选择该考试中的有效图片组', 404);
    if (input.startsAt) {
      const schedules = await tx.screenControlDisplay.count({ where: { examId, startsAt: { gt: now }, stoppedAt: null, canceledAt: null } });
      if (schedules >= 100) throw new ScreenControlError('最多保留 100 个待执行的定时展示', 409);
    } else {
      const latest = await latestScreenDisplay(tx, examId, now);
      const current = latest ? effectiveScreenDisplay([latest], now) : null;
      if (current) await tx.screenControlDisplay.update({ where: { id: current.id }, data: { stoppedAt: now } });
    }
    const previous = await tx.screenControlDisplay.findFirst({ where: { examId }, orderBy: { sequence: 'desc' }, select: { sequence: true } });
    const display = await tx.screenControlDisplay.create({ data: {
      examId, groupId: group.id, groupName: group.name, startsAt, endsAt, createdById, sequence: (previous?.sequence || 0) + 1,
    }, include: displayInclude });
    return serializeScreenControlDisplay(display);
  });
}

export async function stopScreenControlDisplay(examId: string, displayId?: string) {
  return mutateScreenControl(examId, async (tx) => {
    const now = new Date();
    const latest = await latestScreenDisplay(tx, examId, now);
    const current = latest ? effectiveScreenDisplay([latest], now) : null;
    if (displayId && current?.id !== displayId) throw new ScreenControlError('当前展示已发生变化，请刷新后再关闭', 409);
    if (current) await tx.screenControlDisplay.update({ where: { id: current.id }, data: { stoppedAt: now } });
    return { stoppedDisplayId: current?.id || null };
  });
}

export async function cancelScreenControlDisplay(examId: string, displayId: string) {
  return mutateScreenControl(examId, async (tx) => {
    const now = new Date();
    const display = await tx.screenControlDisplay.findFirst({ where: { id: displayId, examId } });
    if (!display) throw new ScreenControlError('展示计划不存在', 404);
    if (display.canceledAt || display.stoppedAt) return { canceledDisplayId: display.id };
    if (display.startsAt <= now) {
      const latest = await latestScreenDisplay(tx, examId, now);
      const current = latest ? effectiveScreenDisplay([latest], now) : null;
      if (current?.id !== display.id) throw new ScreenControlError('该展示已经结束，请刷新后重试', 409);
      await tx.screenControlDisplay.update({ where: { id: display.id }, data: { stoppedAt: now } });
    } else {
      await tx.screenControlDisplay.update({ where: { id: display.id }, data: { canceledAt: now } });
    }
    return { canceledDisplayId: display.id };
  });
}
