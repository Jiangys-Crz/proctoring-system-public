import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { verifyPackagedVersion } from './verify-packaged-version.mjs';

export default async function adHocSignMac(context) {
  verifyPackagedVersion(context);
  if (context.electronPlatformName !== 'darwin') return;

  const productName = context.packager.appInfo.productFilename;
  const appPath = path.join(context.appOutDir, `${productName}.app`);
  const entitlementsPath = path.resolve(context.packager.projectDir, context.packager.platformSpecificBuildOptions.entitlements || 'entitlements.mac.plist');

  execFileSync(
    '/usr/bin/codesign',
    [
      '--force',
      '--deep',
      '--sign',
      '-',
      '--entitlements',
      entitlementsPath,
      appPath
    ],
    { stdio: 'inherit' }
  );
}
