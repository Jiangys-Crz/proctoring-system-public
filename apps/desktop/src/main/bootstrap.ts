import { app, crashReporter, dialog } from 'electron';
import { configureWindowsRendering, startupFailureDetail, writeStartupDiagnostic } from './startup';
import { ensureWindowsAdministrator } from './windows-admin-startup';

// This entry runs before importing the rest of the application, including the
// updater and window modules, so startup failures can be diagnosed too.
configureWindowsRendering(app);
writeStartupDiagnostic(app, 'bootstrap-start', `electron=${process.versions.electron} administrator-relaunch=${process.argv.includes('--proctor-elevated-relaunch')}`);
try {
  crashReporter.start({ uploadToServer: false });
} catch (error) {
  writeStartupDiagnostic(app, 'crash-reporter', String(error));
}
app.on('child-process-gone', (_event, details) => {
  writeStartupDiagnostic(app, 'child-process-gone', `${details.type} ${details.reason} exit=${details.exitCode}`);
});
let reportingFailure = false;
function reportStartupFailure(error: unknown) {
  writeStartupDiagnostic(app, 'startup-failed', error instanceof Error ? error.stack || error.message : String(error));
  if (reportingFailure) return;
  reportingFailure = true;
  dialog.showErrorBox('监考客户端启动失败', startupFailureDetail(app));
  app.quit();
}
process.on('uncaughtException', reportStartupFailure);
process.on('unhandledRejection', reportStartupFailure);

void app.whenReady().then(async () => {
  // Release verification runs the actual packaged binary, without opening the
  // proctoring UI, requesting permissions, or changing the installed app.
  if (process.argv.includes('--proctor-version')) {
    process.stdout.write(JSON.stringify({ version: app.getVersion(), arch: process.arch,
      packaged: app.isPackaged, appPath: app.getAppPath(), executable: app.getPath('exe') }) + '\n');
    app.quit(); return;
  }
  if (process.platform === 'darwin' && !await require('./mac-installation').ensureMacInstallation(app, dialog)) return;
  // Never create a renderer or load optional startup modules until ownership
  // and Windows elevation have been established.
  if (!app.requestSingleInstanceLock()) {
    if (process.platform === 'darwin') await dialog.showMessageBox({ type: 'warning', title: '已有监考客户端正在运行',
      message: `当前打开的是 v${app.getVersion()}，请先退出已经运行的客户端`,
      detail: '关闭窗口可能不会退出应用。请在旧客户端按 Command-Q，再从“应用程序”打开新版；考试进行中请先完成考试。', buttons: ['退出'] });
    app.quit(); return;
  }
  if (process.platform === 'win32' && !await ensureWindowsAdministrator(app, dialog)) { app.quit(); return; }
  require('./main');
}).catch(reportStartupFailure);
