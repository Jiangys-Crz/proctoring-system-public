import type { ReactionLogoMatchBy } from '@prisma/client';
import { z } from 'zod';
import { reactionLogoOrganizationName } from './reaction-render-settings';

export const defaultContestTeamNameTemplate = '{org.name}: {team.name}';
const teamNameField = /\{(org|team|school|college)\.name\}/g;
export const contestTeamNameTemplateSchema = z.string().trim().min(1, '请填写名称模板').max(180, '名称模板最多可填 180 个字符')
  .regex(/^[^\r\n]*$/, '名称模板只能使用一行文字')
  .refine(value => !/[{}]/.test(value.replace(teamNameField, '')), '请检查花括号，支持的变量为 {org.name}、{school.name}、{college.name} 和 {team.name}');

export function contestTeamNameFields(team: string, candidate: { school?: string | null; college?: string | null }, matchBy: ReactionLogoMatchBy = 'SCHOOL') {
  const school = candidate.school?.trim() || '';
  const college = candidate.college?.trim() || '';
  return { team, school, college, org: reactionLogoOrganizationName(matchBy, { school, college }) || '' };
}

export function formatContestTeamName(template: string, fields: ReturnType<typeof contestTeamNameFields>) {
  let missing = false;
  const formatted = template.replace(teamNameField, (_, key: keyof typeof fields) => {
    if (!fields[key]) missing = true;
    return fields[key];
  });
  return missing ? fields.team : formatted;
}
