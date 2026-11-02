const { request, upload, configureServer, saveSession, clearSession } = require('../../utils/api');
const config = require('../../config');
const { parsePairQr } = require('../../utils/pair-qr');

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatTime(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return String(iso);
  return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

Page({
  data: {
    step: 1,
    serverUrl: config.serverUrl,
    serverStatus: '连接检测中',
    serverConnected: false,
    exams: [],
    examNames: [],
    examIndex: -1,
    examCode: '',
    school: '',
    college: '',
    name: '',
    teamName: '',
    studentId: '',
    examNumber: '',
    password: '',
    pairCode: '',
    credentialTicket: '',
    identityPhotoPath: '',
    roomVideoPath: '',
    verifying: false,
    submitting: false,
    message: ''
  },
  onLoad() {
    this.loadExams();
  },
  onInput(event) {
    this.setData({ [event.currentTarget.dataset.key]: event.detail.value });
  },
  onExamChange(event) {
    const examIndex = Number(event.detail.value);
    this.setData({ examIndex, examCode: this.data.exams[examIndex]?.examCode || '' });
  },
  async onExamCodeInput(event) {
    const examCode = event.detail.value.replace(/\D/g, '').slice(0, 10);
    this.setData({ examCode, examIndex: -1 });
    if (examCode.length !== 10) return;
    try {
      const exams = await request(`/api/client/exams?examCode=${examCode}`);
      if (this.data.examCode !== examCode) return;
      const withTime = exams.map(item => ({ ...item, startText: formatTime(item.startAt), endText: formatTime(item.endAt) }));
      this.setData({ exams: withTime, examNames: withTime.map(item => `${item.examCode} · ${item.name}`), examIndex: withTime.length ? 0 : -1, message: withTime.length ? '' : '未找到该编号对应的可参加考试' });
    } catch (error) { if (this.data.examCode === examCode) this.setData({ message: error.message }); }
  },
  async loadExams() {
    try {
      const exams = await request('/api/client/exams');
      const examsWithTime = exams.map((item) => ({
        ...item,
        startText: formatTime(item.startAt),
        endText: formatTime(item.endAt)
      }));
      const index = this.data.examIndex >= 0 && this.data.examIndex < examsWithTime.length ? this.data.examIndex : -1;
      this.setData({
        exams: examsWithTime,
        examNames: examsWithTime.map((item) => `${item.examCode} · ${item.name}`),
        examIndex: index,
        serverStatus: '已连接',
        serverConnected: true
      });
    } catch (error) {
      this.setData({ message: error.message, serverStatus: `连接失败：${error.message}`, serverConnected: false });
    }
  },
  async nextStep() {
    const exam = this.data.exams[this.data.examIndex];
    if (!exam) return wx.showToast({ title: '请选择考试', icon: 'none' });
    if (!this.data.school.trim()) return wx.showToast({ title: '请输入学校', icon: 'none' });
    if (!(exam.contestType === 'TEAM' && exam.teamAccountMode === 'TEAM_ACCOUNT') && !this.data.college.trim()) return wx.showToast({ title: '请输入学院', icon: 'none' });
    if (!this.data.name.trim()) return wx.showToast({ title: '请输入姓名', icon: 'none' });
    if (!this.data.studentId.trim()) return wx.showToast({ title: exam.contestType === 'TEAM' ? '请输入队员学号' : '请输入学号', icon: 'none' });
    if (!this.data.examNumber.trim()) return wx.showToast({ title: '请输入考号', icon: 'none' });
    if (!this.data.password) return wx.showToast({ title: '请输入密码', icon: 'none' });
    if (exam.contestType === 'TEAM' && !this.data.teamName.trim()) {
      return wx.showToast({ title: '请输入队伍名称', icon: 'none' });
    }
    this.setData({ verifying: true, message: '' });
    try {
      await request('/api/client/candidate-verify', {
        method: 'POST',
        data: {
          examId: exam.id,
          examCode: exam.examCode,
          examNumber: this.data.examNumber.trim(),
          password: this.data.password,
          studentId: this.data.studentId.trim(),
          name: this.data.name.trim(),
          school: this.data.school.trim(),
          college: this.data.college.trim(),
          teamName: exam.contestType === 'TEAM' ? this.data.teamName.trim() : undefined
        }
      });
      this.setData({ step: 2 });
    } catch (error) {
      wx.showToast({ title: error.message || '信息不匹配', icon: 'none' });
    } finally {
      this.setData({ verifying: false });
    }
  },
  prevStep() {
    this.setData({ step: 1 });
  },
  takeIdentityPhoto() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera'],
      camera: 'front',
      success: (res) => {
        this.setData({ identityPhotoPath: res.tempFiles[0].tempFilePath });
      }
    });
  },
  previewIdentityPhoto() {
    if (!this.data.identityPhotoPath) return;
    wx.previewImage({ urls: [this.data.identityPhotoPath] });
  },
  recordRoomVideo() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['video'],
      sourceType: ['camera'],
      maxDuration: 15,
      camera: 'back',
      success: (res) => {
        const video = res.tempFiles[0];
        if (!Number.isFinite(video.duration) || video.duration < 3 || video.duration > 15) {
          wx.showToast({ title: '环境视频须为 3–15 秒', icon: 'none' });
          return;
        }
        this.setData({ roomVideoPath: video.tempFilePath });
      }
    });
  },
  scanPairQr() {
    wx.scanCode({
      onlyFromCamera: true,
      success: async (res) => {
        try {
          const payload = parsePairQr(res.result);
          const serverUrl = configureServer(payload.serverUrl);
          this.setData({ pairCode: payload.pairCode, credentialTicket: payload.credentialTicket || '', serverUrl, serverStatus: `已选择：${serverUrl}`, serverConnected: false });
          if (payload.recoverySecret) {
            clearSession();
            const result = await request('/api/client/reconnect', { method: 'POST', data: { pairCode: payload.pairCode, recoverySecret: payload.recoverySecret, deviceId: getApp().globalData.miniProgramDeviceId } });
            saveSession(result.session.id, result.miniProgramSessionToken);
            wx.redirectTo({ url: '/pages/monitor/index' });
          } else if (payload.credentialTicket) {
            clearSession();
            const result = await request('/api/client/credential-login', { method: 'POST', data: { credentialTicket: payload.credentialTicket, action: 'inspect' } });
            this.setData({ exams: [result.exam], examNames: [result.exam.name], examIndex: 0, examCode: result.exam.examCode, pairCode: result.pairCode, name: result.name, studentId: result.studentId, examNumber: result.examNumber, step: 2, serverConnected: true, message: '电脑身份已验证，请提交第二机位材料' });
          } else await this.loadExams();
        } catch (error) { wx.showToast({ title: error.message || '二维码无效', icon: 'none' }); }
      }
    });
  },

  async submitLoginRequest() {
    const exam = this.data.exams[this.data.examIndex];
    if (!exam) return wx.showToast({ title: '请选择考试', icon: 'none' });
    if (!this.data.identityPhotoPath) return wx.showToast({ title: '请拍摄手持身份证照片', icon: 'none' });
    if (!this.data.roomVideoPath) return wx.showToast({ title: '请录制环境视频', icon: 'none' });
    if (!this.data.pairCode) return wx.showToast({ title: '请扫描电脑二维码', icon: 'none' });
    this.setData({ submitting: true, message: '' });
    try {
      const app = getApp();
      const deviceId = app.globalData.miniProgramDeviceId;
      clearSession();
      const identity = { examId: exam.id, examCode: exam.examCode, studentId: this.data.studentId, examNumber: this.data.examNumber, password: this.data.password, pairCode: this.data.pairCode, miniProgramDeviceId: deviceId, name: this.data.name, school: this.data.school, college: this.data.college, teamName: exam.contestType === 'TEAM' ? this.data.teamName : undefined };
      const ticketIdentity = this.data.credentialTicket ? { credentialTicket: this.data.credentialTicket, pairCode: this.data.pairCode, miniProgramDeviceId: deviceId } : identity;
      const { uploadTicket } = await request('/api/client/material-upload-ticket', { method: 'POST', data: ticketIdentity });
      const photo = await upload('/api/client/upload', this.data.identityPhotoPath, { examId: exam.id, channel: 'IDENTITY_PHOTO' }, uploadTicket);
      const video = await upload('/api/client/upload', this.data.roomVideoPath, { examId: exam.id, channel: 'ROOM_VIDEO' }, uploadTicket);
      const objectPath = result => (result.stored && result.stored.objectPath) || (result.segment && result.segment.objectPath);
      const material = { uploadTicket, identityPhotoPath: objectPath(photo), roomVideoPath: objectPath(video) };
      if (!material.identityPhotoPath || !material.roomVideoPath) throw new Error('材料上传响应缺少路径');
      const loginRequest = await request(this.data.credentialTicket ? '/api/client/credential-login' : '/api/login-requests', { method: 'POST', data: this.data.credentialTicket ? { credentialTicket: this.data.credentialTicket, miniProgramDeviceId: deviceId, ...material } : { ...identity, ...material } });
      saveSession(loginRequest.sessionId, loginRequest.miniProgramSessionToken);
      wx.setStorageSync('loginRequestId', loginRequest.id);
      wx.setStorageSync('candidateId', loginRequest.candidateId);
      wx.redirectTo({
        url: `/pages/monitor/index?deviceId=${encodeURIComponent(deviceId)}&sessionId=${encodeURIComponent(loginRequest.sessionId || '')}`
      });
    } catch (error) {
      this.setData({ message: error.message });
    } finally {
      this.setData({ submitting: false });
    }
  }
});
