import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';

const keyPath = process.env.PROCTOR_DEV_TLS_KEY || '/tmp/cwnupaa-proctor-dev-key.pem';
const certPath = process.env.PROCTOR_DEV_TLS_CERT || '/tmp/cwnupaa-proctor-dev-cert.pem';
const listenHost = process.env.PROCTOR_DEV_PROXY_HOST || '0.0.0.0';
const listenPort = Number(process.env.PROCTOR_DEV_PROXY_PORT || 3443);
const apiPort = Number(process.env.PROCTOR_DEV_API_PORT || 4031);
const candidatePort = Number(process.env.PROCTOR_DEV_CLIENT_PORT || 4032);

function targetPort(pathname, headers = {}) {
  if (pathname === '/api' || pathname.startsWith('/api/')) return apiPort;
  // 管理后台与考生端共用 HTTPS 入口：管理路径走 Web 后台，考试页面走考生端。
  if (pathname === '/dashboard' || pathname.startsWith('/dashboard/') || pathname === '/login') return apiPort;
  if (pathname.startsWith('/_next/')) {
    const referer = `${headers.referer || headers.referrer || ''}`;
    if (referer.includes('/dashboard') || referer.endsWith('/login')) return apiPort;
  }
  return candidatePort;
}

function forward(request, response) {
  const port = targetPort(new URL(request.url || '/', `https://${request.headers.host || 'localhost'}`).pathname, request.headers);
  const headers = { ...request.headers };
  delete headers.host;
  delete headers.connection;
  headers.host = `127.0.0.1:${port}`;
  headers['x-forwarded-proto'] = 'https';
  headers['x-forwarded-host'] = request.headers.host || `localhost:${listenPort}`;
  const upstream = http.request({
    hostname: '127.0.0.1',
    port,
    method: request.method,
    path: request.url,
    headers,
  }, (result) => {
    response.writeHead(result.statusCode || 502, result.headers);
    result.pipe(response);
  });
  upstream.on('error', (error) => {
    if (!response.headersSent) response.writeHead(502, { 'content-type': 'text/plain; charset=utf-8' });
    response.end(`开发代理连接失败：${error.message}`);
  });
  request.pipe(upstream);
}

if (!fs.existsSync(keyPath) || !fs.existsSync(certPath)) {
  throw new Error(`缺少开发证书：${keyPath} / ${certPath}`);
}

https.createServer({ key: fs.readFileSync(keyPath), cert: fs.readFileSync(certPath) }, forward)
  .listen(listenPort, listenHost, () => {
    console.log(`[mobile-proxy] HTTPS ${listenHost}:${listenPort} -> api:${apiPort}, client:${candidatePort}`);
  });
