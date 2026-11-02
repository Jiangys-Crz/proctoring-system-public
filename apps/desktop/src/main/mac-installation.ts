import type { App, Dialog } from 'electron';

type MacApp = Pick<App, 'isPackaged' | 'isInApplicationsFolder' | 'moveToApplicationsFolder' | 'getVersion' | 'getPath' | 'quit'>;
type MacDialog = Pick<Dialog, 'showMessageBox' | 'showErrorBox'>;

/** Run before the instance lock: opening a new DMG must not silently activate an old copy. */
export async function ensureMacInstallation(app: MacApp, dialog: MacDialog) {
  if (!app.isPackaged || app.isInApplicationsFolder()) return true;
  const version = app.getVersion();
  const choice = await dialog.showMessageBox({
    type: 'info', title: `安装监考客户端 v${version}`,
    message: '请先将新版安装到“应用程序”',
    detail: `当前打开的是安装包或其他目录中的副本。安装后会替换“应用程序”中的旧版本并重新打开。\n\n请先完全退出其他监考客户端；正在考试时请稍后更新。\n\n当前文件：${app.getPath('exe')}`,
    buttons: ['安装并重新打开', '退出'], defaultId: 0, cancelId: 1,
  });
  if (choice.response !== 0) { app.quit(); return false; }
  try {
    // Electron's default existsAndRunning behavior reopens the old app. Refuse
    // that path instead of reporting a successful update while still on it.
    if (app.moveToApplicationsFolder({ conflictHandler: conflict => conflict === 'exists' })) return false;
    await dialog.showMessageBox({ type: 'warning', title: '尚未完成安装',
      message: '新版尚未替换旧版，请完全退出旧客户端后再试',
      detail: '请使用菜单“退出”或 Command-Q 完全退出其他监考客户端，然后重新打开安装包中的新版。如系统询问安装权限，请完成授权。取消安装不会更新原应用。',
      buttons: ['退出'], defaultId: 0 });
  } catch (error) {
    dialog.showErrorBox('无法安装监考客户端', `请退出旧客户端，确认“应用程序”目录允许写入，再重新安装。\n${error instanceof Error ? error.message : String(error)}`);
  }
  app.quit();
  return false;
}
