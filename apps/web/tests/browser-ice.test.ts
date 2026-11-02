import assert from 'node:assert/strict';
import { test } from 'node:test';
import { browserIceAnswer } from '../src/lib/browser-ice';

test('a configured LAN port changes only private 443 ICE candidates, retaining credentials and SDP layout', () => {
  const sdp = 'v=0\r\na=ice-ufrag:keep\r\na=ice-pwd:keep\r\na=candidate:one 1 udp 123 192.168.50.20 443 typ host\r\na=candidate:two 1 tcp 123 192.168.50.20 443 typ host tcptype passive\r\na=candidate:three 1 udp 123 203.0.113.10 443 typ host\r\na=candidate:four 1 udp 123 fd00::15 443 typ host\r\na=candidate:five 1 udp 123 192.168.50.20 8189 typ host\r\n';
  assert.equal(browserIceAnswer(sdp, '18189'), sdp.replaceAll('192.168.50.20 443', '192.168.50.20 18189').replace('fd00::15 443', 'fd00::15 18189'));
  assert.equal(browserIceAnswer(sdp, ''), sdp, 'public host without an override stays identical');
  for (const port of ['443', '80', '65536', '0', '../18189', '18189junk']) assert.throws(() => browserIceAnswer(sdp, port));
});
