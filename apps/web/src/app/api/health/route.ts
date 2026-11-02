import { HYDRO_SETTINGS_VERSION } from '@/lib/hydro-settings-contract';
import { prisma } from '@/lib/db';
import { options, ok, fail, toErrorMessage } from '@/lib/http';

export async function GET() {
  try {
    await prisma.$queryRaw`SELECT 1`;
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
