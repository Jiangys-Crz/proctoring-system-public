/** Browser-safe shared contract. No storage, credentials, database or Node imports. */
export const REACTION_BRANDING_ORGANIZATION_LIMIT = 500;
export const REACTION_BUILTIN_BADGE_URL = '/api/settings/reaction-branding/logos/builtin';
export type ReactionBrandingSettings = {
  version: 1;
  organizations: { name: string; logoId: string }[];
  defaultLogoId: string | null;
};
export type ReactionBrandingView = {
  version: 1;
  organizations: { name: string; logoId: string; previewUrl: string }[];
  defaultBadge: { logoId: string | null; previewUrl: string };
  limit: number;
};
export type ReactionBrandingLogoSelection = {
  logoId: string | null;
  basis: 'system-organization' | 'system-default' | 'built-in-default';
  organizationName: string | null;
  normalizedSchoolName: string | null;
};
export function normalizeReactionOrganizationName(value: string) {
  return value.normalize('NFKC').trim().replace(/\s+/gu, ' ');
}
export const defaultReactionBranding = (): ReactionBrandingSettings => ({ version: 1, organizations: [], defaultLogoId: null });
