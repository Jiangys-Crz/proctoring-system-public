import type { ReactionLogoMatchBy } from '@prisma/client';
import { normalizeReactionOrganizationName, type ReactionBrandingSettings, type ReactionBrandingLogoSelection } from './reaction-branding-contract';

export function reactionLogoOrganizationName(matchBy: ReactionLogoMatchBy, candidate: { school: string | null; college: string | null }) {
  return matchBy === 'COLLEGE' ? candidate.college : candidate.school;
}

/** One system-wide exact organization map; legacy exam/team overrides are not inputs. */
export function reactionLogoSelection(branding: ReactionBrandingSettings, organizationName: string | null): ReactionBrandingLogoSelection {
  const normalizedOrganizationName = organizationName ? normalizeReactionOrganizationName(organizationName) || null : null;
  const organization = normalizedOrganizationName ? branding.organizations.find(item => normalizeReactionOrganizationName(item.name) === normalizedOrganizationName) : undefined;
  if (organization) return { logoId: organization.logoId, basis: 'system-organization', organizationName: normalizedOrganizationName, normalizedOrganizationName };
  if (branding.defaultLogoId) return { logoId: branding.defaultLogoId, basis: 'system-default', organizationName: null, normalizedOrganizationName };
  return { logoId: null, basis: 'built-in-default', organizationName: null, normalizedOrganizationName };
}
