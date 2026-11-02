import { isIP } from 'node:net';

function privateAddress(address: string) {
  if (isIP(address) === 4) {
    const [a, b] = address.split('.').map(Number);
    return a === 10 || a === 127 || a === 192 && b === 168 || a === 172 && b >= 16 && b <= 31 || a === 169 && b === 254;
  }
  if (isIP(address) === 6) return /^(?:fc|fd|fe[89ab])/i.test(address) || address === '::1';
  return false;
}

// Chrome rejects ICE port 80/443 on private addresses. A host may expose a
// separate high port forwarding to the existing media socket, without changing
// public 443 candidates or interrupting already-connected publishers.
export function browserIceAnswer(sdp: string, configuredPort = process.env.MEDIA_BROWSER_ICE_PORT) {
  if (!configuredPort) return sdp;
  if (!/^\d{4,5}$/.test(configuredPort) || Number(configuredPort) < 1024 || Number(configuredPort) > 65535) throw new Error('内网 WebRTC 浏览器端口配置无效');
  return sdp.replace(/^(a=candidate:\S+\s+\d+\s+(?:udp|tcp)\s+\d+\s+)(\S+)(\s+)443(?=\s)/gmi,
    (line, prefix: string, address: string, space: string) => privateAddress(address) ? prefix + address + space + configuredPort : line);
}
