import { prisma } from './db';
import { getReactionBranding } from './reaction-branding';
import { normalizeReactionOrganizationName } from './reaction-branding-contract';

export async function contestLiveOrganizationLogos(organizations: string[]) {
  const names = new Set(organizations.map(normalizeReactionOrganizationName).filter(Boolean));
  if (!names.size) return new Map<string, { id: string; objectPath: string }>();
  const branding = await getReactionBranding();
  const matches = branding.organizations.filter(item => names.has(item.name));
  if (!matches.length) return new Map<string, { id: string; objectPath: string }>();
  const assets = await prisma.reactionLogo.findMany({
    where: { id: { in: matches.map(item => item.logoId) }, archivedAt: null },
    select: { id: true, objectPath: true },
  });
  const byId = new Map(assets.map(asset => [asset.id, asset]));
  const logos = new Map<string, { id: string; objectPath: string }>();
  for (const match of matches) {
    const asset = byId.get(match.logoId);
    if (asset) logos.set(match.name, asset);
  }
  return logos;
}
