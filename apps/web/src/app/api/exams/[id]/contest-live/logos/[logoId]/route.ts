import { AuthError } from '@/lib/auth';
import { contestLiveHeaders, contestLiveViewer } from '@/lib/contest-live-access';
import { contestLiveOrganizationLogos } from '@/lib/contest-live-branding';
import { readContestLiveRoster } from '@/lib/contest-live-data';
import { fail, toErrorMessage } from '@/lib/http';
import { normalizeReactionOrganizationName } from '@/lib/reaction-branding-contract';
import { readReactionAsset } from '@/lib/reaction-presentation';
import { UploadSecurityError } from '@/lib/upload-security';

export const runtime = 'nodejs';

export async function GET(request: Request, { params }: { params: Promise<{ id: string; logoId: string }> }) {
  try {
    const { id, logoId } = await params;
    await contestLiveViewer(request, id);
    const school = normalizeReactionOrganizationName(new URL(request.url).searchParams.get('school') || '');
    if (!school || school.length > 200) return fail('学校校徽不存在', 404);
    const contest = await readContestLiveRoster(id);
    if (!contest?.roster.teams.some(team => normalizeReactionOrganizationName(team.organization) === school)) return fail('学校校徽不存在', 404);
    const logo = (await contestLiveOrganizationLogos([school])).get(school);
    if (!logo || logo.id !== logoId) return fail('学校校徽不存在', 404);
    const image = await readReactionAsset('logo-library', logo.objectPath);
    return new Response(new Uint8Array(image), {
      headers: { ...contestLiveHeaders, 'content-type': 'image/png', 'content-length': String(image.length) },
    });
  } catch (error) {
    if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
    return fail(toErrorMessage(error), 500);
  }
}
