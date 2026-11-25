import { AuthError } from '@/lib/auth';
import { authorizeContestDisplay, getContestDisplayViewer, readContestDisplayConfig } from '@/lib/contest-display-config';
import { availableContestDisplayHistory } from '@/lib/contest-display-history';
import { contestLiveHeaders } from '@/lib/contest-live-access';
import { contestLiveOrganizationLogos } from '@/lib/contest-live-branding';
import { contestLivePhotoAccountHash } from '@/lib/contest-live-broadcast';
import { readContestLiveRoster } from '@/lib/contest-live-data';
import { matchesContestDisplayHistoryLogo } from '@/lib/contest-live-media-token';
import { prisma } from '@/lib/db';
import { fail } from '@/lib/http';
import { normalizeReactionOrganizationName } from '@/lib/reaction-branding-contract';
import { readReactionAsset } from '@/lib/reaction-presentation';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string; kind: string; assetId: string }> }) {
  try {
    const { id, kind, assetId } = await params;
    if (kind !== 'logo' && kind !== 'history-logo' && kind !== 'photo') return fail('大屏素材不存在', 404);
    const [config, viewer] = await Promise.all([readContestDisplayConfig(id), getContestDisplayViewer(request, id)]);
    authorizeContestDisplay(config, viewer);
    const query = new URL(request.url).searchParams;
    if (kind === 'logo' || kind === 'history-logo') {
      const school = normalizeReactionOrganizationName(query.get('school') || '');
      if (!school || school.length > 200) return fail('校徽不存在', 404);
      if (kind === 'history-logo') {
        const archived = query.get('archive') || '';
        if (!config.settings.historyExamIds?.includes(archived) ||
          !matchesContestDisplayHistoryLogo(query.get('grant') || '', id, archived, config.revision, school, assetId) ||
          !(await availableContestDisplayHistory(id, [archived])).length) return fail('校徽不存在', 404);
      } else {
        const source = await readContestLiveRoster(id);
        if (!source?.roster.teams.some(team => normalizeReactionOrganizationName(team.organization) === school)) return fail('校徽不存在', 404);
      }
      const logo = (await contestLiveOrganizationLogos([school])).get(school);
      if (!logo || logo.id !== assetId) return fail('校徽不存在', 404);
      const bytes = await readReactionAsset('logo-library', logo.objectPath);
      return new Response(new Uint8Array(bytes), { headers: { ...contestLiveHeaders, 'content-type': 'image/png' } });
    }
    const teamId = query.get('team');
    const source = await readContestLiveRoster(id);
    const team = source?.roster.teams.find(team => team.id === teamId);
    if (!team) return fail('队伍照片不存在', 404);
    const photo = await prisma.contestLivePhoto.findFirst({ where: { id: assetId, examId: id,
      accountHash: { in: team.accounts.map(contestLivePhotoAccountHash) } }, select: { image: true, accountHash: true } });
    if (!photo) return fail('队伍照片不存在', 404);
    const [latest, currentViewer, currentSource] = await Promise.all([
      readContestDisplayConfig(id), getContestDisplayViewer(request, id), readContestLiveRoster(id),
    ]);
    authorizeContestDisplay(latest, currentViewer);
    if (!currentSource?.roster.teams.some(team => team.id === teamId &&
      team.accounts.some(account => contestLivePhotoAccountHash(account) === photo.accountHash))) return fail('队伍照片不存在', 404);
    return new Response(photo.image, { headers: { ...contestLiveHeaders, 'content-type': 'image/webp' } });
  } catch (error) {
    return error instanceof AuthError ? fail(error.message, error.status) : fail('无法读取大屏素材', 500);
  }
}
