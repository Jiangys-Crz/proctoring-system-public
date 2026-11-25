import type { Prisma } from '@prisma/client';
import sharp from 'sharp';
import { AuthError } from '@/lib/auth';
import { contestLiveHeaders, contestLiveViewer, contestLiveViewerUnchanged, normalizeContestLiveAccount, requireContestLiveManager } from '@/lib/contest-live-access';
import { readContestLiveBody } from '@/lib/contest-live-body';
import { contestLiveApiPath, contestLivePhotoAccountHash } from '@/lib/contest-live-broadcast';
import { readContestLiveRoster } from '@/lib/contest-live-data';
import { contestLiveActiveTeams } from '@/lib/contest-live-media';
import { assertContestLivePhotoTarget } from '@/lib/contest-live-media-token';
import { prisma } from '@/lib/db';
import { fail, ok, toErrorMessage } from '@/lib/http';
import { processMedia } from '@/lib/media-processing';
import { UploadSecurityError } from '@/lib/upload-security';

export const runtime = 'nodejs';

const maxImageBytes = 8 * 1024 * 1024;
type Context = { params: Promise<{ id: string; account: string }> };

function photoError(error: unknown) {
  if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
  return fail(toErrorMessage(error), 500);
}

async function resolveAccount(examId: string, value: string, db: Parameters<typeof readContestLiveRoster>[1]) {
  const account = normalizeContestLiveAccount(value);
  if (!account || account.length > 255 || /[\x00-\x1f\x7f]/.test(account)) throw new AuthError('队伍账号无效', 400);
  const data = await readContestLiveRoster(examId, db);
  const accountsByTeam = (data?.roster.teams || []).map(team => ({
    team, accounts: new Set([team.account, ...team.accounts].filter(Boolean).map(normalizeContestLiveAccount)),
  }));
  const matches = accountsByTeam.filter(team => team.accounts.has(account));
  if (!matches.length) throw new AuthError('未找到该账号对应的参赛队伍', 404);
  if (matches.length > 1) throw new AuthError('该账号对应多个参赛队伍，请使用唯一的账号', 409);
  const { team, accounts } = matches[0];
  const available = [...accounts].filter(alias => accountsByTeam.every(item => item.team.id === team.id || !item.accounts.has(alias)));
  return { primary: contestLivePhotoAccountHash(available.includes(normalizeContestLiveAccount(team.account)) ? team.account : account),
    aliases: available.map(contestLivePhotoAccountHash) };
}

async function normalizePhoto(input: Buffer) {
  return processMedia(async () => {
    try {
      const isJpeg = input.subarray(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]));
      const isPng = input.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      const isWebp = input.toString('ascii', 0, 4) === 'RIFF' && input.toString('ascii', 8, 12) === 'WEBP';
      if (!isJpeg && !isPng && !isWebp) throw new Error('unsupported image');
      const source = sharp(input, { limitInputPixels: 24_000_000, failOn: 'warning' });
      const metadata = await source.metadata();
      if (!metadata.width || !metadata.height || (metadata.pages || 1) > 1) throw new Error('invalid image');
      return await source.rotate().resize({ width: 1920, height: 1920, fit: 'inside', withoutEnlargement: true }).webp({ quality: 85 }).toBuffer();
    } catch {
      throw new AuthError('请上传有效的 JPG、PNG 或 WebP 照片', 400);
    }
  });
}

export async function GET(request: Request, { params }: Context) {
  try {
    const { id, account: photoId } = await params;
    const viewer = await contestLiveViewer(request, id);
    if (!viewer.mediaAllowed) throw new AuthError('该赛事直播未公开队伍照片', 403);
    const query = new URL(request.url).searchParams;
    const teamId = query.get('teamId') || '';
    let accountHashes: string[] | undefined;
    if (!viewer.manage) {
      if (!viewer.access || !contestLiveActiveTeams(viewer.settings).has(teamId)) throw new AuthError('该队伍照片未在直播中展示', 403);
      assertContestLivePhotoTarget(query.get('target') || '', id, teamId, photoId, viewer.access);
      const source = await readContestLiveRoster(id);
      const team = source?.roster.teams.find(team => team.id === teamId);
      if (!team) throw new AuthError('队伍照片不存在', 404);
      accountHashes = team.accounts.map(contestLivePhotoAccountHash);
    }
    const photo = await prisma.contestLivePhoto.findUnique({
      where: { id: photoId, examId: id, ...(accountHashes && { accountHash: { in: accountHashes } }) },
      select: { image: true, accountHash: true },
    });
    if (!photo) return fail('队伍照片不存在', 404);
    const [latest, source] = await Promise.all([
      contestLiveViewer(request, id), viewer.manage ? null : readContestLiveRoster(id),
    ]);
    if (!contestLiveViewerUnchanged(viewer, latest)) throw new AuthError('队伍照片授权已失效', 403);
    if (!viewer.manage && !source?.roster.teams.some(team => team.id === teamId &&
      team.accounts.some(account => contestLivePhotoAccountHash(account) === photo.accountHash))) return fail('队伍照片不存在', 404);
    return new Response(photo.image, { headers: { ...contestLiveHeaders, 'content-type': 'image/webp', 'content-length': String(photo.image.byteLength) } });
  } catch (error) { return photoError(error); }
}

async function editPhoto<T>(id: string, account: string, update: (tx: Prisma.TransactionClient,
  target: Awaited<ReturnType<typeof resolveAccount>>) => Promise<T>) {
  return prisma.$transaction(async tx => {
    const exam = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM Exam WHERE id = ${id} FOR UPDATE`;
    if (!exam.length) throw new AuthError('考试不存在', 404);
    return update(tx, await resolveAccount(id, account, tx));
  });
}

export async function PUT(request: Request, { params }: Context) {
  try {
    const { id, account } = await params;
    await requireContestLiveManager(id, request);
    const image = await normalizePhoto(await readContestLiveBody(request, maxImageBytes));
    const photo = await editPhoto(id, account, async (tx, { primary, aliases }) => {
      const saved = await tx.contestLivePhoto.upsert({
        where: { examId_accountHash: { examId: id, accountHash: primary } },
        create: { examId: id, accountHash: primary, image },
        update: { image },
        select: { id: true, updatedAt: true },
      });
      await tx.contestLivePhoto.deleteMany({ where: { examId: id, accountHash: { in: aliases.filter(alias => alias !== primary) } } });
      return saved;
    });
    return ok({ photoUrl: `${contestLiveApiPath(id)}/photos/${encodeURIComponent(photo.id)}?v=${photo.updatedAt.getTime()}` }, { headers: contestLiveHeaders });
  } catch (error) { return photoError(error); }
}

export async function DELETE(request: Request, { params }: Context) {
  try {
    const { id, account } = await params;
    await requireContestLiveManager(id, request);
    await editPhoto(id, account, (tx, { aliases }) => tx.contestLivePhoto.deleteMany({ where: { examId: id, accountHash: { in: aliases } } }));
    return ok({}, { headers: contestLiveHeaders });
  } catch (error) { return photoError(error); }
}
