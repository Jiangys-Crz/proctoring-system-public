import { NextResponse } from 'next/server';
import { ZodError, type ZodSchema } from 'zod';
import { stripCredentialHashes } from './public-dto';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
  'Access-Control-Allow-Headers': 'content-type,x-proctor-client,x-proctor-session-token,x-proctor-pair-poll-token,x-proctor-upload-ticket,authorization',
  'Access-Control-Max-Age': '86400'
};

function withCors(init?: ResponseInit) {
  return {
    ...init,
    headers: {
      ...corsHeaders,
      ...(init?.headers || {})
    }
  };
}

export function ok<T>(data: T, init?: ResponseInit) {
  return NextResponse.json({ ok: true, data: stripCredentialHashes(data) }, withCors(init));
}

export function fail(message: string, status = 400, details?: unknown) {
  return NextResponse.json({ ok: false, message, ...(status < 500 && details !== undefined ? { details } : {}) }, withCors({ status, headers: { 'Cache-Control': 'no-store' } }));
}

export function options() {
  return new NextResponse(null, { status: 204, headers: corsHeaders });
}

async function boundedJson(request: Request, maxBytes: number) {
  const length = request.headers.get('content-length');
  if (length && Number(length) > maxBytes) throw new RequestParseError('请求内容过大');
  const reader = request.body?.getReader();
  if (!reader) throw new RequestParseError('请求体必须是 JSON');
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new RequestParseError('请求内容过大');
      }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

export async function parseBody<T>(request: Request, schema: ZodSchema<T>, maxBytes?: number) {
  try {
    const json = maxBytes === undefined ? await request.json() : await boundedJson(request, maxBytes);
    return schema.parse(json);
  } catch (error) {
    if (error instanceof RequestParseError) throw error;
    if (error instanceof ZodError) {
      throw new RequestParseError('请求参数不正确', error.flatten());
    }
    throw new RequestParseError('请求体必须是 JSON');
  }
}

export class RequestParseError extends Error {
  constructor(message: string, public details?: unknown) {
    super(message);
  }
}

export function toErrorMessage(error: unknown) {
  if (error instanceof Error) {
    const code = (error as Error & { code?: string }).code;
    if (code === 'P1001' || error.message.includes("Can't reach database server")) {
      console.error('Database unavailable', error);
      return '服务连接暂不可用，请稍后再试';
    }
    if (code === 'P2021' || error.message.includes('does not exist in the current database')) {
      console.error('Database schema unavailable', error);
      return '系统正在准备中，请稍后再试';
    }
    const message = error.message.replace(/\bHydro(?:OJ)?(?:\s+Judger)?\b/gi, '评测服务');
    if (/^P\d{4}$/.test(code || '') || message.length > 200 || !/[\u4e00-\u9fff]/.test(message)
      || /https?:\/\/|(?:\/Users\/|\/app\/|node_modules|DATABASE_URL|Prisma|SELECT |INSERT |password|api.?key|secret|token=)|\n\s*at\s/i.test(message)) {
      console.error('Request failed', error);
      return '服务暂不可用，请稍后再试';
    }
    return message;
  }
  return '服务器处理失败';
}
