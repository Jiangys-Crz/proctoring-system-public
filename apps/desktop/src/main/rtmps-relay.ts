import net from 'node:net';
import tls from 'node:tls';

/** FFmpeg's bundled macOS TLS backend can block RTMP's nonblocking reads.
 * Keep RTMP on loopback and let Node handle the authenticated public TLS link. */
export async function openRtmpsRelay(destination: string, options: { ca?: tls.ConnectionOptions['ca'] } = {}) {
  const target = new URL(destination);
  if (target.protocol !== 'rtmps:' || target.username || target.password) throw new Error('加密推流地址不正确');
  const sockets = new Set<net.Socket>();
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    for (const socket of sockets) socket.destroy();
    sockets.clear();
    server.close();
  };
  const server = net.createServer((local) => {
    local.pause();
    sockets.add(local);
    const remote = tls.connect({
      host: target.hostname,
      port: Number(target.port) || 443,
      servername: net.isIP(target.hostname) ? undefined : target.hostname,
      rejectUnauthorized: true,
      ...(options.ca ? { ca: options.ca } : {})
    });
    sockets.add(remote);
    remote.setTimeout(10_000, stop);
    local.on('error', stop);
    remote.on('error', stop);
    local.once('close', stop);
    remote.once('close', stop);
    remote.once('secureConnect', () => {
      if (stopped) return;
      remote.setTimeout(0);
      local.pipe(remote);
      remote.pipe(local);
      local.resume();
    });
  });
  server.maxConnections = 1;
  server.unref();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  const address = server.address() as net.AddressInfo;
  const local = new URL(`rtmp://127.0.0.1:${address.port}`);
  local.pathname = target.pathname;
  local.search = target.search;
  return { url: local.toString(), stop };
}
