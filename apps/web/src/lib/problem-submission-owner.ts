import { prisma } from './db';

// New records use the stable local user ID. Adopt old unlinked records only
// when the old display identifier still identifies exactly one local user.
export async function problemSubmissionOwner(user: { id: string; numberId: string | null; username: string | null }) {
  const ownerKey = user.numberId || user.username || user.id;
  const matches = await prisma.user.count({ where: { OR: [{ numberId: ownerKey }, { username: ownerKey }, { id: ownerKey }] } });
  return { OR: [{ userId: user.id }, ...(matches === 1 ? [{ userId: null, ownerKey }] : [])] };
}
