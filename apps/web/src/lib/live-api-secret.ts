import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { AuthError } from './auth';
import { liveApiKeyHash, validLiveApiKey } from './live-api-key';

function encryptionKey() {
  const secret = process.env.SESSION_SECRET || '';
  if (secret.length < 32) throw new AuthError('请先配置至少 32 字符的会话密钥', 503);
  return createHash('sha256').update('live-api-key:v1:' + secret).digest();
}
export function sealLiveApiKey(key: string) {
  const iv = randomBytes(12), cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const data = Buffer.concat([cipher.update(key, 'utf8'), cipher.final()]);
  return [iv, cipher.getAuthTag(), data].map(p => p.toString('base64url')).join('.');
}
export function revealLiveApiKey(ciphertext: string | null, hash: string) {
  if (!ciphertext) throw new AuthError('旧密钥仅保存了摘要，无法还原；请生成一个新密钥后使用重复复制功能', 409);
  try {
    const parts = ciphertext.split('.').map(p => Buffer.from(p, 'base64url'));
    if (parts.length !== 3 || parts[0].length !== 12 || parts[1].length !== 16) throw new Error();
    const decipher = createDecipheriv('aes-256-gcm', encryptionKey(), parts[0]); decipher.setAuthTag(parts[1]);
    const key = Buffer.concat([decipher.update(parts[2]), decipher.final()]).toString('utf8');
    if (!validLiveApiKey(key) || liveApiKeyHash(key) !== hash) throw new Error();
    return key;
  } catch { throw new AuthError('直播密钥无法读取，请核对会话密钥配置或生成新密钥', 409); }
}
