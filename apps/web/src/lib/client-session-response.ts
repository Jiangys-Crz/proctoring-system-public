export function revokedClientSessionResponse() {
  return Response.json({
    ok: false, code: 'CLIENT_SESSION_REVOKED',
    message: '客户端所需端均离线满 2 分钟，会话已注销，请重新登录；考试计时保持不变',
  }, { status: 410, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
