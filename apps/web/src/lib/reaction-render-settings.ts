import { normalizeReactionOrganizationName, type ReactionBrandingSettings, type ReactionBrandingLogoSelection } from './reaction-branding-contract';

/** One system-wide exact organization map; legacy exam/team overrides are not inputs. */
export function reactionLogoSelection(branding: ReactionBrandingSettings, schoolName: string | null): ReactionBrandingLogoSelection {
  const normalizedSchoolName = schoolName ? normalizeReactionOrganizationName(schoolName) || null : null;
  const organization = normalizedSchoolName ? branding.organizations.find(item => normalizeReactionOrganizationName(item.name) === normalizedSchoolName) : undefined;
  if (organization) return { logoId: organization.logoId, basis: 'system-organization', organizationName: normalizeReactionOrganizationName(organization.name), normalizedSchoolName };
  if (branding.defaultLogoId) return { logoId: branding.defaultLogoId, basis: 'system-default', organizationName: null, normalizedSchoolName };
  return { logoId: null, basis: 'built-in-default', organizationName: null, normalizedSchoolName };
}
