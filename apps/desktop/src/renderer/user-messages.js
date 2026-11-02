(function (root) {
  root.proctorUserMessage = function (error, fallback = '操作未完成，请稍后重试') {
    let message = String(error?.message || error || '').trim();
    message = message.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/, '');
    if (message.startsWith('Electron net 失败：')) message = message.slice('Electron net 失败：'.length).split('；Node HTTP 失败：')[0];
    if (/HTTP\s*404|status(?: code)?\s*404/i.test(message)) return '服务暂不可用，请稍后重试或联系监考老师';
    if (/HTTP\s*401/i.test(message)) return '登录信息已失效，请重新登录';
    if (/HTTP\s*403/i.test(message)) return '当前操作未获允许，请联系监考老师';
    if (/HTTP\s*429/i.test(message)) return '操作过于频繁，请稍后重试';
    if (/HTTP\s*5\d\d|数据库|Prisma|SQL|Missing required env/i.test(message)) return '服务暂时异常，请稍后重试或联系监考老师';
    if (/ERR_CERT|certificate|证书/i.test(message)) return '服务器安全连接失败，请联系监考老师';
    if (/TIMED_OUT|ETIMEDOUT|timeout|超时/i.test(message)) return '连接超时，请检查网络后重试';
    if (/ERR_|ECONN|ENOTFOUND|EHOST|fetch failed|Failed to fetch|NetworkError|curl:|网络请求失败/i.test(message)) return '无法连接监考服务器，请检查网络后重试';
    if (/NotAllowedError|Permission denied|EACCES|EPERM/i.test(message)) return '权限未授权，请点击对应权限卡片完成授权';
    if (/NotFoundError|DevicesNotFoundError/i.test(message)) return '未检测到所需设备，请检查设备连接';
    if (/NotReadableError|TrackStartError/i.test(message)) return '设备暂时无法使用，请关闭占用设备的软件后重试';
    if (/Invalid URL/i.test(message)) return '服务器地址不正确，请检查后重试';
    if (!message || !/[\u4e00-\u9fff]/.test(message) || message.length > 220 || /Error|Exception|Electron|Node HTTP|curl|HTTP\s*\d|<html|\bat\s+\w|https?:\/\/|\/Users\/|\/node_modules\/|\bstack\b/i.test(message)) return fallback;
    return message;
  };

  root.createProctorToast = function (element, timers = root) {
    let timer;
    return function (message) {
      timers.clearTimeout(timer);
      element.textContent = message;
      element.classList.remove('hidden');
      timer = timers.setTimeout(() => {
        element.classList.add('hidden');
        element.textContent = '';
      }, 5000);
    };
  };
})(globalThis);
