const { request, upload, serverBase, clearSession, saveSession, secureOrigin } = require('../../utils/api');

const config = require('../../config');
const encryptedCameraHint = '请在手机浏览器打开 HTTPS 第二机位页面，并扫描电脑左下角的重连二维码。';

Page({
  data: {
    deviceId: '',
    sessionId: '',
    message: '等待电脑端审核通过',
    locked: false,
    finished: false,
    canCancelLogin: false,
    recording: false,
    recordingVoice: false,
    voiceMessage: '等待监考老师语音',
    lastVoiceAt: '',
    liveFrameBusy: false,
    devicePosition: 'back',
    rtmpUrl: '',
    pushing: false
  },
  onLoad(query) {
    const app = getApp();
    const sessionId = query.sessionId || wx.getStorageSync('sessionId') || '';
    if (sessionId) wx.setStorageSync('sessionId', sessionId);
    this.setData({ deviceId: query.deviceId || app.globalData.miniProgramDeviceId, sessionId });
    // 先启动心跳/语音定时器，推流初始化异常不能阻断心跳上报
    this.timer = setInterval(() => this.sendHeartbeat(), 5000);
    this.voiceTimer = setInterval(() => this.pollVoice(), 3000);
    this.sendHeartbeat();
    this.setData({ message: encryptedCameraHint });
  },
  onUnload() {
	    this.stopPusher();
	    clearInterval(this.timer);
	    clearInterval(this.recordTimer);
	    clearInterval(this.liveFrameTimer);
	    clearInterval(this.voiceTimer);
	  },
  onHide() {
    this.reportSwitch();
  },
  flipCamera() {
    if (this.data.recording) return;
    this.setData({ devicePosition: this.data.devicePosition === 'back' ? 'front' : 'back' });
  },
  async sendHeartbeat() {
    try {
      const sessionId = this.data.sessionId || wx.getStorageSync('sessionId') || '';
      const result = await request('/api/client/heartbeat', {
        method: 'POST',
        data: {
          sessionId,
          deviceId: this.data.deviceId,
          side: 'MINIPROGRAM',
          capture: { mobileCameraOk: false }
        }
      });
      const nextSessionId = result.session && result.session.id;
      if (result.miniProgramSessionToken) {
        // 掉线重登/新会话时服务端可能重新签发小程序令牌
        saveSession(nextSessionId || sessionId, result.miniProgramSessionToken);
      }
      if (nextSessionId) {
        const finished = result.session.status === 'FINISHED';
        const waitingReview = result.session.status === 'WAITING_REVIEW';
        // 考试被监考结束/被判作弊无异议结束：一律退回登录首页
        if (finished) {
          this.stopPusher();
          clearSession();
          wx.showToast({ title: '考试已结束', icon: 'none' });
          wx.redirectTo({ url: '/pages/login/index' });
          return;
        }
        wx.setStorageSync('sessionId', nextSessionId);

        this.setData({
          sessionId: nextSessionId,
          locked: !!result.session.lockdown,
          finished,
          pushing: Boolean(this.data.rtmpUrl && !finished),
          canCancelLogin: waitingReview,
          // 推流失败时保留错误信息，避免被心跳的常规状态覆盖
          message: finished ? '考试已结束，等待监考老师恢复或退出' : waitingReview ? '登录请求已提交，等待监考老师审核' : result.session.lockdown ? '已锁定，等待管理员处理' : encryptedCameraHint
        });
        this.pollVoice();
      }
    } catch (error) {
      const message = error.message || '';
      if (/request:fail|网络请求失败|timeout|abort/i.test(message)) {
        // 网络中断：5 秒定时器会持续自动重连
        this.setData({ message: '网络连接已断开，正在自动重连…' });
        return;
      }
      if (error.code === 'CLIENT_SESSION_REVOKED') {
        this.stopPusher(); clearSession();
        clearInterval(this.timer); clearInterval(this.voiceTimer);
        wx.showToast({ title: '会话已注销，请重新登录', icon: 'none' });
        wx.redirectTo({ url: '/pages/login/index' });
        return;
      }
      this.setData({
        message: message.includes('令牌') ? '会话令牌已失效，请重新提交登录请求' : `心跳上报失败：${message}`
      });
    }
  },
  // 微信 live-pusher 只保证 RTMP 支持。此入口不发布明文媒体，也不伪报采集成功。
  openSecureWeb() {
    try {
      const entry = secureOrigin(config.mobileWebUrl) + '/?apiBase=' + encodeURIComponent(serverBase());
      wx.setClipboardData({ data: entry, success: () => wx.showModal({ title: '使用加密第二机位', content: '地址已复制。请在手机浏览器打开，再扫描电脑左下角的重连二维码；确认网页开始采集后可以关闭小程序。', showCancel: false }) });
    } catch (error) { this.setData({ message: error.message }); }
  },
  stopPusher() {
    this.setData({ pushing: false, rtmpUrl: '' });
  },
  async cancelLoginRequest() {
    const sessionId = this.data.sessionId || wx.getStorageSync('sessionId') || '';
    const loginRequestId = wx.getStorageSync('loginRequestId') || '';
    if (!sessionId && !loginRequestId) return wx.redirectTo({ url: '/pages/login/index' });
    try {
      this.stopPusher();
      await request('/api/client/login-request/cancel', {
        method: 'POST',
        data: { sessionId, loginRequestId }
      });
      clearSession();
      wx.showToast({ title: '已取消请求', icon: 'success' });
      wx.redirectTo({ url: '/pages/login/index' });
    } catch (error) {
      this.setData({ message: error.message || '取消失败' });
    }
  },
	  captureLiveFrame() {
	    return;
	  },
	  async reportSwitch() {
    const sessionId = this.data.sessionId || wx.getStorageSync('sessionId');
    if (!sessionId) return;
    await request('/api/client/alerts', {
      method: 'POST',
      data: {
        sessionId,
        type: 'SCREEN_SWITCH',
        severity: 4,
        message: '小程序离开第二机位监考页面'
      }
    }).catch(() => {});
  },
  async reportCameraIssue(message = '考生手动上报小程序摄像头异常') {
    const text = typeof message === 'string' ? message : '考生手动上报小程序摄像头异常';
    const sessionId = this.data.sessionId || wx.getStorageSync('sessionId');
    if (!sessionId) return;
    await request('/api/client/alerts', {
      method: 'POST',
      data: {
        sessionId,
        type: 'MOBILE_CAMERA_LOST',
        severity: 4,
        message: text
      }
    }).catch(() => {});
  },
  async pollVoice() {
    const sessionId = this.data.sessionId || wx.getStorageSync('sessionId');
    if (!sessionId) return;
    try {
      const query = this.data.lastVoiceAt ? `&after=${encodeURIComponent(this.data.lastVoiceAt)}` : '';
      const messages = await request(`/api/client/voice?sessionId=${encodeURIComponent(sessionId)}${query}`);
      for (const message of messages) {
        this.setData({ lastVoiceAt: message.createdAt, voiceMessage: '正在播放监考老师语音' });
        const audio = wx.createInnerAudioContext();
        audio.src = message.objectPath.startsWith('http') ? message.objectPath : `${serverBase()}${message.objectPath}`;
        audio.autoplay = true;
        audio.onEnded(() => {
          audio.destroy();
          this.setData({ voiceMessage: '等待监考老师语音' });
        });
        audio.onError(() => {
          audio.destroy();
          this.setData({ voiceMessage: '语音播放失败' });
        });
      }
    } catch (error) {
      this.setData({ voiceMessage: error.message });
    }
  },
  startVoiceReply() {
    const sessionId = this.data.sessionId || wx.getStorageSync('sessionId');
    if (!sessionId) return wx.showToast({ title: '尚未建立会话', icon: 'none' });
    this.recorder = wx.getRecorderManager();
    this.recorder.onStop((res) => {
      upload('/api/client/voice', res.tempFilePath, {
        sessionId,
        durationMs: String(res.duration || 0)
      }).then(() => {
        this.setData({ voiceMessage: '语音已发送给监考老师' });
      }).catch((error) => {
        this.setData({ voiceMessage: error.message });
      });
    });
    this.recorder.start({
      duration: 60000,
      sampleRate: 16000,
      numberOfChannels: 1,
      encodeBitRate: 24000,
      format: 'aac'
    });
    this.setData({ recordingVoice: true, voiceMessage: '正在录音' });
  },
  stopVoiceReply() {
    if (this.recorder) this.recorder.stop();
    this.setData({ recordingVoice: false });
  }
});
