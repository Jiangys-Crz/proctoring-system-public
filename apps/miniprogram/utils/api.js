const config = require('../config');

function secureOrigin(value) {
  const match = String(value || '').trim().match(/^https:\/\/(\[[a-f\d:]+\]|[a-z\d](?:[a-z\d.-]*[a-z\d])?)(?::(\d{1,5}))?\/?$/i);
  if (!match || (match[2] && (Number(match[2]) < 1 || Number(match[2]) > 65535))) throw new Error('监考服务器必须使用 HTTPS 域名或地址');
  return `https://${match[1].toLowerCase()}${match[2] && Number(match[2]) !== 443 ? ':' + Number(match[2]) : ''}`;
}
function clearSession() {
  ['sessionId', 'loginRequestId', 'candidateId', 'miniProgramSessionToken', 'sessionServerOrigin'].forEach(key => wx.removeStorageSync(key));
}
function serverBase() {
  const app = getApp();
  const origin = secureOrigin((app.globalData || {}).serverUrl || config.serverUrl);
  if (wx.getStorageSync('miniProgramSessionToken') && wx.getStorageSync('sessionServerOrigin') !== origin) clearSession();
  return origin;
}
function configureServer(value) {
  const next = secureOrigin(value);
  if (next !== serverBase()) clearSession();
  getApp().globalData.serverUrl = next;
  return next;
}
function saveSession(sessionId, token) {
  if (!sessionId || !token) throw new Error('响应缺少会话信息');
  const origin = serverBase();
  wx.setStorageSync('sessionId', sessionId);
  wx.setStorageSync('miniProgramSessionToken', token);
  wx.setStorageSync('sessionServerOrigin', origin);
}
function authHeaders() {
  const origin = serverBase();
  const token = wx.getStorageSync('sessionServerOrigin') === origin && wx.getStorageSync('miniProgramSessionToken');
  return token ? { 'x-proctor-session-token': token, authorization: `Bearer ${token}` } : {};
}
function accept(body, statusCode, origin) {
  if (serverBase() !== origin) throw new Error('服务器已切换，请重新登录');
  if (body.code === 'CLIENT_SESSION_REVOKED') {
    clearSession();
    const error = new Error('会话已注销，请重新登录');
    error.code = body.code;
    throw error;
  }
  if (statusCode >= 200 && statusCode < 300 && body.ok) return body.data;
  throw new Error(body.message || `请求失败：${statusCode}`);
}
function endpoint(origin, path) {
  if (!/^\/(?!\/)/.test(path)) throw new Error('接口地址无效');
  return origin + path;
}
function request(path, options = {}) {
  return new Promise((resolve, reject) => {
    let origin;
    try { origin = serverBase(); } catch (error) { reject(error); return; }
    wx.request({
      url: endpoint(origin, path), method: options.method || 'GET', data: options.data,
      header: { 'content-type': 'application/json', 'x-proctor-client': 'miniprogram', ...authHeaders() },
      success(res) { try { resolve(accept(res.data || {}, res.statusCode, origin)); } catch (error) { reject(error); } },
      fail(err) { reject(new Error(err.errMsg || '网络请求失败')); }
    });
  });
}
function upload(path, filePath, formData, uploadTicket) {
  return new Promise((resolve, reject) => {
    let origin;
    try { origin = serverBase(); } catch (error) { reject(error); return; }
    wx.uploadFile({
      url: endpoint(origin, path), filePath, name: 'file', formData,
      header: { 'x-proctor-client': 'miniprogram', ...authHeaders(), ...(uploadTicket ? { 'x-proctor-upload-ticket': uploadTicket } : {}) },
      success(res) { try { resolve(accept(JSON.parse(res.data || '{}'), res.statusCode, origin)); } catch (error) { reject(error); } },
      fail(err) { reject(new Error(err.errMsg || '上传失败')); }
    });
  });
}
module.exports = { request, upload, serverBase, authHeaders, configureServer, secureOrigin, saveSession, clearSession };
