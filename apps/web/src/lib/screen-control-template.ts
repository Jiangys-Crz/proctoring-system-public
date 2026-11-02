import { z } from 'zod';

export const SCREEN_TEXT_FIELDS = [
  { token: '<name>', label: '姓名', team: false },
  { token: '<teamname>', label: '队伍名称', team: true },
  { token: '<members>', label: '队伍成员', team: true },
  { token: '<school>', label: '学校' },
  { token: '<college>', label: '学院' },
  { token: '<group>', label: '组别' },
] as const;

// Positions and box sizes are percentages. Font sizes use a 1000px-wide image
// as their reference, so a layout can be copied to images of different sizes.
export const ScreenTextBlockSchema = z.object({
  id: z.string().min(1).max(80),
  content: z.string().max(500),
  x: z.number().min(0).max(99), y: z.number().min(0).max(99),
  width: z.number().min(1).max(100), height: z.number().min(1).max(100),
  fontSize: z.number().min(8).max(160),
  fontFamily: z.enum(['SANS', 'SERIF']),
  alignment: z.enum(['left', 'center', 'right']),
  color: z.string().regex(/^#[\da-fA-F]{6}$/),
  bold: z.boolean(),
}).strict().refine(block => block.x + block.width <= 100.001 && block.y + block.height <= 100.001, '文字块不能超出图片边界');

export const ScreenImageTemplateSchema = z.object({
  version: z.literal(1),
  blocks: z.array(ScreenTextBlockSchema).max(20),
}).strict().refine(template => new Set(template.blocks.map(block => block.id)).size === template.blocks.length, '文字块不能重复');

export type ScreenTextBlock = z.infer<typeof ScreenTextBlockSchema>;
export type ScreenImageTemplate = z.infer<typeof ScreenImageTemplateSchema>;
export type ScreenTextValues = Record<'name' | 'teamname' | 'members' | 'school' | 'college' | 'group', string>;

export function readScreenImageTemplate(value: unknown): ScreenImageTemplate | null {
  if (value === null || value === undefined) return null;
  // Fail closed for invalid persisted layouts instead of silently sending an
  // unpersonalized image to candidates.
  return ScreenImageTemplateSchema.parse(value);
}

export function screenTemplateFields(isTeam: boolean) {
  return SCREEN_TEXT_FIELDS.filter(field => !('team' in field) || field.team === isTeam);
}

export function unsupportedScreenFields(template: ScreenImageTemplate, isTeam: boolean) {
  const allowed = new Set<string>(screenTemplateFields(isTeam).map(field => field.token));
  return template.blocks.flatMap(block => block.content.match(/<[a-z]+>/gi) || []).filter(token => !allowed.has(token));
}

export function resolveScreenText(content: string, values: ScreenTextValues) {
  // Replace in one pass: candidate data containing a token is literal text.
  return content.replace(/<(name|teamname|members|school|college|group)>/g, (_, key: keyof ScreenTextValues) => values[key]).slice(0, 4000);
}

export const SCREEN_SAMPLE_VALUES: ScreenTextValues = {
  name: '张三', teamname: '星辰算法队', members: '张三、李四、王五',
  school: '西华师范大学', college: '计算机学院', group: '正式参赛',
};
