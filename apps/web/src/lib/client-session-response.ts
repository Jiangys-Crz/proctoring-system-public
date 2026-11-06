export function revokedClientSessionResponse() {
  return Response.json({
    ok: false, code: 'CLIENT_SESSION_REVOKED',
    message: '该账号已重新登录或被监考注销，当前连接已失效；考试计时保持不变',
  }, { status: 410, headers: { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' } });
}
