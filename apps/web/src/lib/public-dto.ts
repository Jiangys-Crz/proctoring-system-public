/** Plain DTO copies only: Date/Decimal and other explicitly serialized values remain intact. */
function mapPublicValue<T>(value: T, sensitive: (key: string) => boolean): T {
  if (Array.isArray(value)) return value.map(item => mapPublicValue(item, sensitive)) as T;
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype) return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !sensitive(key))
    .map(([key, item]) => [key, mapPublicValue(item, sensitive)])) as T;
}

export const PUBLIC_USER_SELECT = {
  id: true, username: true, nickname: true, realName: true, numberId: true,
  school: true, email: true, role: true, status: true,
} as const;

/** Safe default for public candidates, examinations and nested administrative actors. */
export function publicDto<T>(value: T): T {
  return mapPublicValue(value, key => /^password(?:Hash)?$/i.test(key)
    || (key === 'externalBoardApiKey' || key === 'novaJudgeApiKey' || key === 'monitoringAlertState' || key === 'apiKeyCiphertext' || key === 'keyCiphertext' || key === 'apiKeyHash' || key === 'keyHash' || key === 'readKeyHash')
    || /(?:tokenHash|secret|credentialTicket)$/i.test(key)
    || /^(?:apiKey|secretAccessKey|privateKey|desktopSessionToken|miniProgramSessionToken|loginIp|loginIpBoundAt|loginIpReleasedAt|desktopLoginIp)$/i.test(key));
}

/** Response-wide safety net. Authorized token/password/config issuance remains explicit. */
export function stripCredentialHashes<T>(value: T): T {
  return mapPublicValue(value, key => (key === 'externalBoardApiKey' || key === 'novaJudgeApiKey' || key === 'monitoringAlertState' || key === 'apiKeyCiphertext' || key === 'keyCiphertext' || key === 'apiKeyHash' || key === 'keyHash' || key === 'readKeyHash') || /^passwordHash$/i.test(key) || /tokenHash$/i.test(key));
}
