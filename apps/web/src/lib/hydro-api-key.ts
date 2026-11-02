import { randomBytes } from 'node:crypto';

/** Generate on the backend; administrators save it locally, then copy to the plugin. */
export function generateHydroApiKey() {
  return randomBytes(32).toString('hex');
}
