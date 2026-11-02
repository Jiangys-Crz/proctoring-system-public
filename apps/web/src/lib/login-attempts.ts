import { consumeRateLimit } from './upload-security';

/** All administrator login routes share limits, including the legacy alias. */
export async function consumeAdministratorLoginAttempt(account: string) {
  await consumeRateLimit('administrator-login:global', 300);
  const normalized = account.trim().normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase();
  await consumeRateLimit(`administrator-login:${normalized}`, 20, 15 * 60_000);
}

export async function consumeAdministratorPasswordAttempt(userId: string) {
  // Username, email and number ID all resolve to this same persistent budget.
  await consumeRateLimit(`administrator-password:${userId}`, 20, 15 * 60_000);
}

export async function consumeCandidatePasswordAttempt(candidateIds: string[]) {
  // Charge existing identities only; arbitrary exam numbers cannot create an
  // unbounded set of database buckets. Pair-code/name rotation grants no reset.
  for (const id of [...new Set(candidateIds)].sort()) {
    await consumeRateLimit(`candidate-password:${id}`, 30, 15 * 60_000);
  }
}
