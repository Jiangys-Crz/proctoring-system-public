import { ZodError } from 'zod';
import { AuthError, requireSuperAdmin } from '@/lib/auth';
import { fail, ok, options, parseBody, RequestParseError } from '@/lib/http';
import { acquireUploadSlot, boundedUploadForm, consumeRateLimit, UploadSecurityError } from '@/lib/upload-security';
import { REACTION_ASSET_MAX_BYTES } from '@/lib/reaction-presentation';
import { deleteReactionBrandingBinding, getReactionBrandingView, ReactionBrandingDeleteSchema, ReactionBrandingRenameSchema, renameReactionBrandingOrganization, uploadReactionBranding } from '@/lib/reaction-branding';

const headers = { 'cache-control': 'private, no-store' };
function brandingError(error: unknown) {
  if (error instanceof AuthError || error instanceof UploadSecurityError) return fail(error.message, error.status);
  if (error instanceof RequestParseError) return fail(error.message, 400, error.details);
  if (error instanceof ZodError) return fail('组织徽章参数不正确', 400, error.flatten());
  return fail('组织徽章操作失败，请检查服务端配置', 500);
}

export async function GET() {
  try { await requireSuperAdmin(); return ok(await getReactionBrandingView(), { headers }); }
  catch (error) { return brandingError(error); }
}
export async function POST(request: Request) {
  let release: (() => void) | undefined;
  try {
    const user = await requireSuperAdmin(request);
    await consumeRateLimit(`reaction-branding:${user.id}`, 15);
    release = acquireUploadSlot();
    const form = await boundedUploadForm(request, REACTION_ASSET_MAX_BYTES + 16384);
    for (const key of ['file', 'kind', 'name', 'replace', 'existingName']) if (form.getAll(key).length > 1) throw new UploadSecurityError('请求参数不能重复');
    const file = form.get('file'), replace = form.get('replace');
    if (!(file instanceof File)) throw new UploadSecurityError('请选择一张徽章图片');
    if (replace !== null && replace !== 'true' && replace !== 'false') throw new UploadSecurityError('替换标志不正确');
    const input = { kind: form.get('kind'), ...(form.has('name') ? { name: form.get('name') } : {}), replace: replace === 'true', ...(form.has('existingName') ? { existingName: form.get('existingName') } : {}) };
    return ok(await uploadReactionBranding(user, file, input), { headers });
  } catch (error) { return brandingError(error); }
  finally { release?.(); }
}
export async function PATCH(request: Request) {
  try {
    const user = await requireSuperAdmin(request);
    const input = await parseBody(request, ReactionBrandingRenameSchema, 4096);
    return ok(await renameReactionBrandingOrganization(user, input), { headers });
  } catch (error) { return brandingError(error); }
}
export async function DELETE(request: Request) {
  try {
    const user = await requireSuperAdmin(request);
    const input = await parseBody(request, ReactionBrandingDeleteSchema, 2048);
    return ok(await deleteReactionBrandingBinding(user, input), { headers });
  } catch (error) { return brandingError(error); }
}
export const OPTIONS = options;
