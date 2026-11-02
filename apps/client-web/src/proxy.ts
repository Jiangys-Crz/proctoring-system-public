import { NextResponse, type NextRequest } from 'next/server';

export function proxy(request: NextRequest) {
  const desktopClient = request.headers.get('x-proctor-client') === 'desktop';
  const sessionToken = request.headers.get('x-proctor-session-token');
  if (desktopClient && sessionToken) {
    const response = NextResponse.next();
    response.cookies.set('proctor-client', 'desktop', { httpOnly: true, sameSite: 'strict', path: '/contest' });
    response.cookies.set('proctor-session-token', sessionToken, { httpOnly: true, sameSite: 'strict', path: '/contest' });
    return response;
  }
  if (request.cookies.get('proctor-client')?.value === 'desktop' && request.cookies.get('proctor-session-token')?.value) {
    return NextResponse.next();
  }

  return new NextResponse('考试页面仅允许通过监考客户端访问。', {
    status: 403,
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }
  });
}

export const config = { matcher: ['/contest/:path*'] };
