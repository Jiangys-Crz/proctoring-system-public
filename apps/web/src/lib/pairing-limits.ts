import { consumeRateLimit } from './upload-security';

/** Public device labels are forgeable; cap the shared budget before allocating
 * per-device buckets. Do not group unrelated students behind a campus NAT. */
export async function consumeInitialPairingAttempt(deviceId: string) {
  await consumeRateLimit('pairing:initial:global', 6000);
  await consumeRateLimit(`pairing:initial:device:${deviceId}`, 10);
}
