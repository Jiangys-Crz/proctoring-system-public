(function (root) {
  root.createPermissionActions = function ({ api, requestLocalNetwork, probeMedia, probeScreen, hosts }) {
    async function requestAdmin() {
      const started = await api.relaunchAsAdmin();
      return started ? '正在以管理员身份重新启动。' : '已取消管理员授权，请关闭软件并选择“以管理员身份运行”。';
    }
    return async function (target) {
      if (target === 'domain') {
        const result = await api.requestNetworkDomainPermission();
        return ['ready', 'limited'].includes(result.state) ? '' : result.message;
      }
      if (target === 'network') {
        return await requestLocalNetwork() ? '本地网络可访问。' : '已发起本地网络授权，请在系统提示或设置中允许访问后返回客户端。';
      }
      const permissions = await api.getSystemPermissionStatus();
      const isMac = permissions.platform === 'darwin';
      const isWindows = permissions.platform === 'win32';
      if (target === 'camera' || target === 'microphone') {
        const title = target === 'camera' ? '摄像头' : '麦克风';
        if (isMac) {
          if (permissions.media?.[target] === 'granted' || await api.askMacMediaAccess(target)) {
            await probeMedia(target);
            return `${title}权限已授权，设备检测成功。`;
          }
          await api.openMacPrivacyPane(target);
          return `已打开${title}权限设置，请允许当前客户端访问；返回后自动重新检测。`;
        }
        try {
          await probeMedia(target);
          return `${title}权限已授权，设备检测成功。`;
        } catch (error) {
          if (isWindows && ['NotAllowedError', 'PermissionDeniedError', 'SecurityError'].includes(error.name)) {
            await api.openWindowsPrivacyPane(target);
            return `已打开${title}权限设置，请允许桌面应用访问；返回后自动重新检测。`;
          }
          throw error;
        }
      }
      if (target === 'screen') {
        if (isMac) {
          if (permissions.media?.screen === 'granted') {
            await probeScreen();
            return '屏幕录制权限已授权，屏幕采集检测成功。';
          }
          await api.testScreenCapture();
          const refreshed = await api.getSystemPermissionStatus();
          if (refreshed.media?.screen === 'granted') {
            await probeScreen();
            return '屏幕录制权限已授权，屏幕采集检测成功。';
          }
          await api.openMacPrivacyPane('screen');
          return '已发起屏幕录制授权，请在系统设置中允许当前客户端；系统若要求重新启动，请重新打开客户端。';
        }
        await probeScreen();
        return '屏幕采集授权与检测成功。';
      }
      if (target === 'accessibility' || (target === 'activeWindow' && isMac)) {
        if (!isMac) return '此系统不需要单独申请辅助功能权限。';
        if (permissions.accessibility) return '辅助功能权限已授权。';
        await api.promptMacAccessibility();
        if (!(await api.getSystemPermissionStatus()).accessibility) await api.openMacPrivacyPane('accessibility');
        return '已发起辅助功能授权，请在系统设置中允许当前客户端；返回后自动重新检测。';
      }
      const capabilities = await api.getSecurityCapabilities(hosts());
      if (isWindows && capabilities.elevationStatus === 'unavailable') return '管理员权限检测失败，请重新安装完整客户端，并检查安全软件是否隔离了权限检测组件。';
      if (isWindows && !capabilities.elevated) return requestAdmin();
      if (target === 'admin') return '已以管理员身份运行。';
      const checks = {
        process: ['processScan', '进程检测'], hardware: ['hardwareScan', '外设检测'],
        vm: ['vmScan', '虚拟机检测'], activeWindow: ['activeWindow', '活动窗口检测']
      };
      const check = checks[target];
      if (!check) throw new Error('未找到对应的权限申请入口');
      if (capabilities[check[0]]) return `${check[1]}可用。`;
      return capabilities[`${check[0]}Message`] ? capabilities[`${check[0]}Message`]
        : `${check[1]}仍不可用。该项没有独立的系统授权开关，检测失败也可能由系统组件缺失或设备状态导致。`;
    };
  };
})(globalThis);
