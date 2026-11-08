import assert from 'node:assert/strict';
import { test } from 'node:test';
import { requireRoomLoginMethod } from '../src/lib/room-login-policy';
import { credentialMember, readCredentialTicket, signCredentialTicket } from '../src/lib/credential-login';
test('room policy enforces both login modes and requires room assignment', () => {
  requireRoomLoginMethod({ loginMode: 'CREDENTIALS' }, 'CREDENTIALS');
  requireRoomLoginMethod({ loginMode: 'SECOND_CAMERA_QR' }, 'SECOND_CAMERA_QR');
  assert.throws(() => requireRoomLoginMethod({ loginMode: 'CREDENTIALS' }, 'SECOND_CAMERA_QR'), /考试编号/);
  assert.throws(() => requireRoomLoginMethod({ loginMode: 'SECOND_CAMERA_QR' }, 'CREDENTIALS'), /改用二维码/);
  assert.throws(() => requireRoomLoginMethod(null, 'CREDENTIALS'), /尚未分配考室/);
});
test('three-field login derives identity from the registered account and shared accounts identify the captain', () => {
  const c = { name: '张三', studentId: '1', teamMembers: '张三、李四', teamMemberStudentIds: '1、2' };
  assert.deepEqual(credentialMember(c, '', false), { memberName: '张三', memberStudentId: '1' });
  assert.deepEqual(credentialMember(c, '任意旧版姓名', true), { memberName: '张三', memberStudentId: '1' });
  assert.equal(credentialMember({ ...c, name: null, studentId: null }, '', true)?.memberStudentId, '1');
});
test('second-camera tickets expire and cannot be modified', () => {
  process.env.SESSION_SECRET = 'test-only-login-ticket-key';
  const input = { purpose: 'desktop-login-materials' as const, pairCode: '123456', examId: 'exam', candidateId: 'candidate', memberName: '张三', memberStudentId: '1', expiresAt: 2000 };
  const ticket = signCredentialTicket(input);
  assert.deepEqual(readCredentialTicket(ticket, 1000), input);
  assert.throws(() => readCredentialTicket(ticket, 2000), /过期/);
  const [payload, signature] = ticket.split('.');
  assert.throws(() => readCredentialTicket(`${Buffer.from(JSON.stringify({ ...input, candidateId: 'other' })).toString('base64url')}.${signature}`, 1000), /无效/);
  assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).password, undefined);
});
