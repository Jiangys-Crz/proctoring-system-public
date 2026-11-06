import { HYDRO_SETTINGS_VERSION } from '@/lib/hydro-settings-contract';
import { prisma } from '@/lib/db';
import { options, ok, fail, toErrorMessage } from '@/lib/http';

// Many clients probe several network transports together. Share only the
// in-flight DB read; never cache a completed healthy/unhealthy observation.
const shared = globalThis as typeof globalThis & { proctorHealthRead?: Promise<void> };
async function readDatabaseHealth() {
  if (!shared.proctorHealthRead) {
    const pending = Promise.resolve().then(async () => { await prisma.$queryRaw`SELECT 1`; })
      .finally(() => { if (shared.proctorHealthRead === pending) shared.proctorHealthRead = undefined; });
    shared.proctorHealthRead = pending;
  }
  await shared.proctorHealthRead;
}

export async function GET() {
  try {
    await readDatabaseHealth();
    return ok({
      service: 'CWNU PAA Proctoring Platform',
      status: 'ok',
      database: 'ok',
      settingsVersion: HYDRO_SETTINGS_VERSION,
      time: new Date().toISOString()
    }, { headers: { 'Cache-Control': 'no-store' } });
  } catch (error) {
    return fail(toErrorMessage(error), 503, {
      service: 'CWNU PAA Proctoring Platform',
      status: 'degraded',
      database: 'unavailable',
      time: new Date().toISOString()
    });
  }
}

export const OPTIONS = options;
