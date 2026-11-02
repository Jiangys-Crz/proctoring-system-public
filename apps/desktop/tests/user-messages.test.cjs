const { test } = require('node:test');
const assert = require('node:assert/strict');
require('../src/renderer/user-messages.js');

test('technical errors become Chinese messages while room restrictions remain actionable', () => {
  const raw = "Error invoking remote method 'net:json': Error: Electron net 失败：请求失败：HTTP 404；Node HTTP 失败：请求失败：HTTP 404；系统 curl 失败：curl: (22) The requested URL returned error: 404";
  assert.equal(proctorUserMessage(new Error(raw)), '服务暂不可用，请稍后重试或联系监考老师');
  const restriction = '所在考室不允许账号密码登录，请改用二维码登录';
  assert.equal(proctorUserMessage(new Error(`Error invoking remote method 'net:json': Error: ${restriction}`)), restriction);
  assert.equal(proctorUserMessage('net::ERR_CONNECTION_REFUSED'), '无法连接监考服务器，请检查网络后重试');
  assert.equal(proctorUserMessage('TypeError: Cannot read properties of undefined'), '操作未完成，请稍后重试');
  assert.equal(proctorUserMessage('数据库连接失败 PrismaClientError'), '服务暂时异常，请稍后重试或联系监考老师');
  assert.equal(proctorUserMessage('NotAllowedError: Permission denied'), '权限未授权，请点击对应权限卡片完成授权');
});

test('toast replaces earlier notices and dismisses after exactly five seconds', () => {
  const classes = new Set(['hidden']);
  const element = { textContent: '', classList: { add: c => classes.add(c), remove: c => classes.delete(c) } };
  const callbacks = new Map();
  let next = 0;
  const show = createProctorToast(element, {
    clearTimeout: id => callbacks.delete(id),
    setTimeout: (fn, delay) => { assert.equal(delay, 5000); callbacks.set(++next, fn); return next; }
  });
  show('连接失败');
  assert.equal(classes.has('hidden'), false);
  show('请重新登录');
  assert.equal(callbacks.size, 1);
  assert.equal(element.textContent, '请重新登录');
  callbacks.get(next)();
  assert.equal(classes.has('hidden'), true);
  assert.equal(element.textContent, '');
});
