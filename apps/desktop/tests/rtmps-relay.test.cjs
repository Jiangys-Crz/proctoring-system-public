const test = require('node:test');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const path = require('node:path');
const net = require('node:net');
const tls = require('node:tls');
const { once } = require('node:events');
const { openRtmpsRelay } = require('../dist/main/rtmps-relay.js');

async function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'rtmps-relay-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(root, 'key.pem'), '-out', path.join(root, 'cert.pem'), '-days', '1', '-subj', '/CN=localhost', '-addext', 'subjectAltName=DNS:localhost'], { stdio: 'ignore' });
  const cert = readFileSync(path.join(root, 'cert.pem'));
  const server = tls.createServer({ cert, key: readFileSync(path.join(root, 'key.pem')) });
  server.on('tlsClientError', () => {});
  const sockets = new Set();
  server.on('secureConnection', socket => { sockets.add(socket); socket.on('error', () => {}); });
  server.listen(0, '::'); await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  return { server, cert, url: `rtmps://localhost:${server.address().port}/live/session_DESKTOP_SCREEN?token=fixture-only` };
}

test('RTMP stays on loopback while a verified TLS link forwards large media packets in both directions', { timeout: 15_000 }, async t => {
  const f = await fixture(t);
  let sni;
  f.server.on('secureConnection', socket => { sni = socket.servername; socket.pipe(socket); });
  const relay = await openRtmpsRelay(f.url, { ca: f.cert });
  t.after(relay.stop);
  const address = new URL(relay.url);
  assert.equal(address.protocol, 'rtmp:'); assert.equal(address.hostname, '127.0.0.1');
  assert.equal(address.pathname + address.search, '/live/session_DESKTOP_SCREEN?token=fixture-only');
  const client = net.connect(Number(address.port), address.hostname);
  t.after(() => client.destroy()); client.on('error', () => {});
  await once(client, 'connect');
  const payload = Buffer.alloc(256 * 1024, 37), chunks = [];
  await new Promise((resolve, reject) => {
    let received = 0;
    client.on('data', chunk => { chunks.push(chunk); received += chunk.length; if (received === payload.length) resolve(); });
    client.once('error', reject);
    client.write(payload);
  });
  assert.deepEqual(Buffer.concat(chunks), payload); assert.equal(sni, 'localhost');
  const closed = once(client, 'close'); relay.stop(); relay.stop(); await closed;
  await assert.rejects(async () => { const socket = net.connect(Number(address.port), address.hostname); await once(socket, 'connect'); });
});

test('an untrusted public certificate closes the relay before sending any RTMP credentials or media', { timeout: 15_000 }, async t => {
  const f = await fixture(t); let bytes = 0;
  f.server.on('secureConnection', socket => socket.on('data', data => { bytes += data.length; }));
  const relay = await openRtmpsRelay(f.url); t.after(relay.stop);
  const address = new URL(relay.url), client = net.connect(Number(address.port), address.hostname);
  client.on('error', () => {}); t.after(() => client.destroy());
  const closed = once(client, 'close');
  client.write('private RTMP credentials'); await closed;
  assert.equal(bytes, 0);
});
