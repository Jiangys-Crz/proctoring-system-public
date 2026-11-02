const { secureOrigin } = require('./api');
function parameters(value) {
  const result = {};
  String(value || '').split('&').filter(Boolean).forEach(part => {
    const [key, ...rest] = part.split('=');
    result[decodeURIComponent(key)] = decodeURIComponent(rest.join('=').replace(/\+/g, ' '));
  });
  return result;
}
function parsePairQr(raw) {
  let payload;
  if (String(raw).trim().startsWith('https://')) {
    const match = String(raw).trim().match(/^https:\/\/[^?#]+(?:\?([^#]*))?(?:#(.*))?$/);
    if (!match) throw new Error('二维码地址无效');
    const query = parameters(match[1]), secrets = parameters(match[2]);
    payload = { type: 'CWNU_PAA_PROCTOR_PAIR', serverUrl: query.apiBase, pairCode: query.pairCode, recoverySecret: secrets.recoverySecret || query.recoverySecret || '', credentialTicket: secrets.credentialTicket || '' };
  } else payload = JSON.parse(raw);
  if (payload.type !== 'CWNU_PAA_PROCTOR_PAIR' || !/^\d{6}$/.test(payload.pairCode)) throw new Error('二维码配对信息无效');
  if (payload.recoverySecret && !/^[a-z\d_-]{32,128}$/i.test(payload.recoverySecret)) throw new Error('恢复凭证无效');
  return { ...payload, serverUrl: secureOrigin(payload.serverUrl) };
}
module.exports = { parsePairQr };
