import { z } from 'zod';
import { ScreenImageTemplateSchema } from './screen-control-template';

export const SCREEN_CONTROL_INTERVAL_MS = 5_000;
export const SCREEN_CONTROL_MAX_GROUPS = 50;
export const SCREEN_CONTROL_MAX_IMAGES = 30;
export const SCREEN_CONTROL_MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const SCREEN_CONTROL_MAX_GROUP_BYTES = 80 * 1024 * 1024;
export const SCREEN_CONTROL_MAX_PIXELS = 25_000_000;
export const SCREEN_CONTROL_MAX_DIMENSION = 10_000;

export const ScreenControlGroupNameSchema = z.string().trim().min(1, '请输入图片组名称').max(120);
export const UpdateScreenControlGroupSchema = z.object({
  name: ScreenControlGroupNameSchema.optional(),
  imageIds: z.array(z.string().min(1)).min(1).max(SCREEN_CONTROL_MAX_IMAGES).optional(),
  templates: z.array(z.object({ imageId: z.string().min(1), template: ScreenImageTemplateSchema.nullable() }).strict())
    .min(1).max(SCREEN_CONTROL_MAX_IMAGES).optional(),
  expectedUpdatedAt: z.iso.datetime({ offset: true }).optional(),
}).strict().refine((value) => value.name !== undefined || value.imageIds !== undefined || value.templates !== undefined, '请输入组名称、图片顺序或信息模板');

// Offset-bearing dates avoid silently interpreting a schedule in the server's timezone.
const DateSchema = z.iso.datetime({ offset: true });
export const CreateScreenControlDisplaySchema = z.object({
  groupId: z.string().min(1),
  startsAt: DateSchema.optional(),
  endsAt: DateSchema.nullable().optional(),
}).strict();
export const ScreenControlActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('STOP'), displayId: z.string().min(1).optional() }).strict(),
  z.object({ action: z.literal('CANCEL'), displayId: z.string().min(1) }).strict(),
]);

export class ScreenControlError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}

export interface ScreenDisplayTiming {
  id: string;
  startsAt: Date;
  endsAt: Date | null;
  stoppedAt: Date | null;
  canceledAt: Date | null;
  createdAt: Date;
  sequence?: number;
}

/** A later push permanently supersedes earlier pushes, including after it ends. */
export function effectiveScreenDisplay<T extends ScreenDisplayTiming>(displays: T[], now: Date): T | null {
  const latest = displays.filter((display) => !display.canceledAt && display.startsAt <= now)
    .sort((left, right) => right.startsAt.getTime() - left.startsAt.getTime()
      || (right.sequence || 0) - (left.sequence || 0)
      || right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id))[0];
  return latest && !latest.stoppedAt && (!latest.endsAt || latest.endsAt > now) ? latest : null;
}

export function validateScreenDisplayTimes(input: { startsAt?: string; endsAt?: string | null }, now: Date) {
  const startsAt = input.startsAt ? new Date(input.startsAt) : now;
  const endsAt = input.endsAt ? new Date(input.endsAt) : null;
  if (!Number.isFinite(startsAt.getTime()) || (endsAt && !Number.isFinite(endsAt.getTime()))) {
    throw new ScreenControlError('展示时间不正确');
  }
  if (input.startsAt && startsAt < now) throw new ScreenControlError('定时展示的开始时间必须晚于当前时间');
  if (endsAt && endsAt <= startsAt) throw new ScreenControlError('展示截止时间必须晚于开始时间');
  return { startsAt, endsAt };
}

export function validateScreenImageOrder(actualIds: string[], requestedIds: string[]) {
  const requested = new Set(requestedIds);
  if (requested.size !== actualIds.length || requestedIds.length !== actualIds.length || actualIds.some((id) => !requested.has(id))) {
    throw new ScreenControlError('图片顺序必须包含该组全部图片，且不能重复或包含其他组图片');
  }
}

export function validateScreenUploadSizes(sizes: number[]) {
  if (!sizes.length || sizes.length > SCREEN_CONTROL_MAX_IMAGES) throw new ScreenControlError(`每组需要 1 至 ${SCREEN_CONTROL_MAX_IMAGES} 张图片`);
  if (sizes.some((size) => !Number.isSafeInteger(size) || size <= 0 || size > SCREEN_CONTROL_MAX_IMAGE_BYTES)) {
    throw new ScreenControlError('每张图片必须有效且不超过 10MB', 413);
  }
  if (sizes.reduce((sum, size) => sum + size, 0) > SCREEN_CONTROL_MAX_GROUP_BYTES) throw new ScreenControlError('每组图片总大小不能超过 80MB', 413);
}
