import { z } from 'zod';

export const UnlockSchema = z.object({ reason: z.string().trim().min(1).max(500) });

export const MarkSchema = z.object({
  reason: z.string().trim().min(1).max(500),
  sessionId: z.string().optional(),
  teamWide: z.boolean().optional().default(false)
});
