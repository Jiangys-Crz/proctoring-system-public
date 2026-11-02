const config = require('./config');

App({
  globalData: {
    serverUrl: config.serverUrl,
    miniProgramDeviceId: wx.getStorageSync('miniProgramDeviceId') || ''
  },
  onLaunch() {
    if (!this.globalData.miniProgramDeviceId) {
      this.globalData.miniProgramDeviceId = `mp_${Date.now()}_${Math.random().toString(16).slice(2)}`;
      wx.setStorageSync('miniProgramDeviceId', this.globalData.miniProgramDeviceId);
    }
  },
  onHide() {
    const sessionId = wx.getStorageSync('sessionId');
    if (!sessionId) return;
    const { request } = require('./utils/api');
    request('/api/client/alerts', { method: 'POST', data: { sessionId, type: 'SCREEN_SWITCH', severity: 4, message: '小程序切到后台或离开监考页面' } }).catch(() => {});

  }
});
