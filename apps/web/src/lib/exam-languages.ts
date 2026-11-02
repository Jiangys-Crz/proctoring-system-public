import { languageFamily } from '@cwnupaa/proctor-shared';
export { languageFamily, languageFamilyName, groupJudgeLanguages, resolveJudgeLanguage } from '@cwnupaa/proctor-shared';
export type HydroLanguage = { id: string; name: string };


export function examLanguageName(language: HydroLanguage) {
  return language.name || language.id;
}

export function allowedProblemLanguages(problem: { problemType: string; languages: unknown }, restriction: unknown, available: HydroLanguage[]) {
  if (['objective', 'submit_answer'].includes(problem.problemType)) return ['_'];
  const configuredFamilies = Array.isArray(restriction) ? restriction.filter((item): item is string => typeof item === 'string') : [];
  const problemIds = Array.isArray(problem.languages) ? problem.languages : [];
  const candidates = available.filter(language => language.id !== '_' && (!problemIds.length || problemIds.includes(language.id)));
  return candidates
    .filter(language => !configuredFamilies.length || configuredFamilies.includes(languageFamily(language.id) || ''))
    .map(language => language.id);
}
