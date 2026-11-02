import { NextRequest } from 'next/server';
import { randomBytes } from 'node:crypto';
import { externalPasswordLogin, getExternalUserId } from '@/lib/cwnupaa';
import { z } from 'zod';
import { fail, ok, toErrorMessage } from '@/lib/http';
import { consumeRateLimit, UploadSecurityError } from '@/lib/upload-security';
import { enrollPublicTest, getPublicTestExam, PUBLIC_TEST_COOKIE, PUBLIC_TEST_STATE_SECONDS, publicTestEnrollmentKey, PublicTestError } from '@/lib/public-test';

export const dynamic = 'force-dynamic';
const ModeSchema = z.object({ mode: z.literal('secondCamera'), account: z.string().trim().min(1).max(191), password: z.string().min(1).max(200) }).strict();
const noStore = { 'Cache-Control': 'no-store' };

function isTestEnrollmentOrigin(request: Request) {
  try {
    const origin = new URL(request.headers.get('origin') || '');
    return ['https:', 'http:'].includes(origin.protocol) && origin.host === (request.headers.get('host') || new URL(request.url).host);
  } catch { return false; }
}
export async function GET() {
  try {
    const exam = await getPublicTestExam();
    return ok({ name: exam.name, durationMinutes: exam.durationMinutes, loginMode: 'SECOND_CAMERA_QR', requireSecondCamera: true }, { headers: noStore });
  } catch (error) { return fail(toErrorMessage(error), error instanceof PublicTestError ? error.status : 503); }
}
export async function POST(request: NextRequest) {
  try {
    if (!isTestEnrollmentOrigin(request)) return fail('请从本网站领取测试账号', 403);
    if (!request.headers.get('content-type')?.startsWith('application/json')) return fail('请求格式不正确', 400);
    // Read a small bounded JSON body even if Content-Length is absent or forged.
    if (!request.body) return fail('请选择体验模式', 400);
    const reader = request.body.getReader();
    let content = '';
    try {
      let size = 0;
      const decoder = new TextDecoder();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return fail('请求内容过长', 413); }
        content += decoder.decode(value, { stream: true });
      }
      content += decoder.decode();
    } finally { reader.releaseLock(); }
    const input = ModeSchema.safeParse(JSON.parse(content));
    if (!input.success) return fail('请填写协会官网账号和密码，并使用第二机位测试', 400);
    const oldToken = request.cookies.get(PUBLIC_TEST_COOKIE)?.value || '';
    const token = /^[A-Za-z0-9_-]{43}$/.test(oldToken) ? oldToken : randomBytes(32).toString('base64url');
    await consumeRateLimit('public-test:all:minute', 300);
    await consumeRateLimit('public-test:all:day', 10_000, 86_400_000);
    await consumeRateLimit(publicTestEnrollmentKey(token), 10, 3_600_000);
    await consumeRateLimit(`public-test:login:${input.data.account.toLocaleLowerCase()}`, 10, 15 * 60_000);
    let external;
    try { external = await externalPasswordLogin(input.data.account, input.data.password); }
    catch { return fail('协会官网验证失败，请检查用户名或邮箱及密码', 401); }
    const externalId = getExternalUserId(external);
    if (!externalId) return fail('官网身份信息不完整，无法绑定测试账号', 403);
    await consumeRateLimit(`public-test:owner:${externalId}`, 20, 3_600_000);
    const response = ok(await enrollPublicTest(externalId, input.data.mode), { headers: noStore });
    response.cookies.set(PUBLIC_TEST_COOKIE, token, { httpOnly: true, sameSite: 'strict',
      secure: request.nextUrl.protocol === 'https:' || request.headers.get('origin')?.startsWith('https://'),
      path: '/api/public-test', maxAge: PUBLIC_TEST_STATE_SECONDS });
    return response;
  } catch (error) {
    if (error instanceof SyntaxError) return fail('请求格式不正确', 400);
    return fail(toErrorMessage(error), error instanceof PublicTestError || error instanceof UploadSecurityError ? error.status : 500);
  }
}
