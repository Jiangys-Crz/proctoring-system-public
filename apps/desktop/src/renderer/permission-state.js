(function (root) {
  root.proctorPermissionRows = function (permissions, capabilities, checks) {
    const rows = [
      { key: 'network', title: '监考服务器连接', granted: checks.network, detail: checks.networkDetail, label: checks.network ? '可访问' : '连接失败' },
      { key: 'screen', title: '屏幕录制', granted: checks.screen, detail: checks.screenDetail },
      { key: 'camera', title: '摄像头权限', granted: checks.camera, detail: checks.cameraDetail },
      { key: 'microphone', title: '麦克风权限', granted: checks.microphone, detail: checks.microphoneDetail }
    ];
    if (permissions?.platform === 'darwin') rows.push({ key: 'accessibility', title: '辅助功能权限', granted: permissions.accessibility === true });
    if (permissions?.platform === 'win32') rows.push({ key: 'admin', title: 'Windows 管理员权限', granted: capabilities?.elevated === true,
      label: capabilities?.elevated === true ? '已授权' : capabilities?.elevationStatus === 'standard' ? '未授权' : '检测失败',
      detail: capabilities?.elevated === true || capabilities?.elevationStatus === 'standard' ? '' : '无法确认管理员权限，请重新检测或检查客户端权限检测组件。' });
    rows.push(
      { key: 'process', title: '进程检测', granted: capabilities?.processScan === true,
        label: capabilities?.processScan === true ? '可用' : capabilities?.elevationStatus === 'standard' ? '需要管理员权限' : '检测失败',
        detail: capabilities?.processScan === true ? '' : capabilities?.processScanMessage || capabilities?.diagnostic || '请点击重新检测；系统组件异常与未取得管理员权限会分别提示。' },
      { key: 'domain', title: '网络检测', granted: ['ready', 'limited'].includes(capabilities?.networkDomainStatus?.state), label: capabilities?.networkDomainStatus?.state === 'ready' ? '可用' : capabilities?.networkDomainStatus?.state === 'limited' ? '基础检测可用' : '检测失败', detail: capabilities?.networkDomainStatus?.message },
      ...[['hardware', '外设检测', 'hardwareScan'], ['vm', '虚拟机检测', 'vmScan'], ['activeWindow', '活动窗口检测', 'activeWindow']].map(([key, title, field]) => ({
        key, title, granted: capabilities?.[field] === true,
        label: permissions?.platform === 'win32' ? capabilities?.[field] === true ? '可用' : '检测失败' : undefined,
        detail: capabilities?.[field] === true ? '' : capabilities?.[`${field}Message`] || capabilities?.diagnostic || ''
      }))
    );
    return rows.map(row => ({ ...row, granted: row.granted === true,
      label: row.label || (row.granted ? '已授权' : !capabilities && ['domain', 'hardware', 'vm', 'activeWindow'].includes(row.key) ? '检测失败' : '未授权') }));
  };
})(globalThis);
