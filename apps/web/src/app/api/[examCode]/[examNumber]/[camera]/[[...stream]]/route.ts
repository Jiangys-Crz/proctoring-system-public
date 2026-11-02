import { serveLiveStream, type LiveStreamParams } from '@/lib/live-stream';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export async function GET(request: Request, context: { params: Promise<LiveStreamParams> }) {
  return serveLiveStream(request, await context.params);
}
export const POST = GET;
export const PATCH = GET;
export const DELETE = GET;
export function OPTIONS() {
  return new Response(null, { status: 204, headers: {
    'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,PATCH,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'content-type,if-match', 'Access-Control-Expose-Headers': 'location,etag', 'Access-Control-Max-Age': '86400',
  } });
}
