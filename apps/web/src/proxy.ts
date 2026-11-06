import { NextResponse, type NextRequest } from 'next/server';

const clientApiPrefixes = ['/api/client', '/api/login-requests', '/api/uploads'];

function isClientApi(pathname: string) {
  return clientApiPrefixes.some((prefix) => pathname.startsWith(prefix));
}

function withCors(response: NextResponse) {
  response.headers.set('Access-Control-Allow-Origin', '*');
  response.headers.set('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.headers.set('Access-Control-Allow-Headers', 'content-type,x-proctor-client,x-proctor-session-token,x-proctor-pair-poll-token,x-proctor-upload-ticket,authorization');
  return response;
}

export function proxy(request: NextRequest) {
  if (request.nextUrl.pathname === '/dashboard/system') {
    const response = NextResponse.next();
    response.headers.set('Cache-Control', 'no-store');
    return response;
  }
  if (!isClientApi(request.nextUrl.pathname)) return NextResponse.next();
  if (request.method === 'OPTIONS') return withCors(new NextResponse(null, { status: 204 }));
  return withCors(NextResponse.next());
}

export const config = {
  // Upload handlers own CORS and bounded streaming reads. Avoid the proxy's
  // request-body clone before their credential validation.
  matcher: ['/dashboard/system', '/api/((?!live-relay/(?:media-auth|streams|publish/[^/]+)$|live/[^/]+$|exam-sync/|settings/(?:live-api-keys(?:/reveal)?|desktop-releases/upload)$|client/(?:upload|public-test-login|live-frame|voice|qa/image)$|voice$|exams/[^/]+/(?:qa/image|screen-control/groups)$|uploads$).*)']
};
