import crypto from 'node:crypto';

export const PASSWORD_DIGEST_ALGORITHM = 'PROCTOR-PASSWORD-SHA512-V1';

export function digestPasswordForStorage(password: string) {
  return `${PASSWORD_DIGEST_ALGORITHM}:${crypto.createHash('sha512').update(password, 'utf8').digest('hex')}`;
}
