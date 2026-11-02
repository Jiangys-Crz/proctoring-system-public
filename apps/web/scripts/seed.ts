import { PrismaClient } from '@prisma/client';
import { ensureBootstrapAdministrator } from '../src/lib/bootstrap-admin';
import { ensurePublicTestExam } from '../src/lib/public-test';

const prisma = new PrismaClient();

async function main() {
  const created = await ensureBootstrapAdministrator(prisma);
  console.log(created ? 'Created built-in super administrator: admin' : 'Existing admin account preserved');
  console.log(`Public system test exam ready: ${await ensurePublicTestExam(prisma)}`);
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
