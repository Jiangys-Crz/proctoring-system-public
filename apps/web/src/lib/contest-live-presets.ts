import { z } from 'zod';
import { contestLiveSettingsPatchSchema } from './contest-live-settings';

export const contestLiveSceneSchema = contestLiveSettingsPatchSchema.omit({
  publicEnabled: true, publicMediaEnabled: true, freeze: true, teamNameTemplate: true, visualConfig: true,
});
export const contestLiveSceneNameSchema = z.string().trim().min(1).max(60);
export const contestLiveSceneIdSchema = z.string().uuid();

const contestLivePresetSchema = z.object({
  id: contestLiveSceneIdSchema,
  name: contestLiveSceneNameSchema,
  scene: contestLiveSceneSchema,
});

export type ContestLivePreset = z.infer<typeof contestLivePresetSchema>;

export function readContestLivePresets(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap(item => {
    const parsed = contestLivePresetSchema.safeParse(item);
    return parsed.success ? [parsed.data] : [];
  });
}
