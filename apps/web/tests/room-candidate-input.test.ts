import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveRoomCandidateInput } from '../src/lib/room-candidate-input';

const candidates = [
  { examNumber: '1001', studentId: '001' },
  { examNumber: '1002', studentId: '002' },
  { examNumber: '001', studentId: '003' },
  { examNumber: 'T1001', studentId: null, teamMemberStudentIds: '004、005' },
];

test('multiline student IDs resolve to exam accounts and preserve leading zeroes', () => {
  assert.deepEqual(resolveRoomCandidateInput(' 001\r\n002\n001 ', 'STUDENT_ID', candidates), ['1001', '1002']);
});

test('explicit input type distinguishes a student ID from another candidate exam account', () => {
  assert.deepEqual(resolveRoomCandidateInput('001', 'EXAM_NUMBER', candidates), ['001']);
  assert.deepEqual(resolveRoomCandidateInput('001', 'STUDENT_ID', candidates), ['1001']);
});

test('team member student IDs resolve to one shared account without duplicate assignments', () => {
  assert.deepEqual(resolveRoomCandidateInput('004\n005', 'STUDENT_ID', candidates), ['T1001']);
});

test('Chinese and English separators work alongside line breaks', () => {
  assert.deepEqual(resolveRoomCandidateInput('001、002，003;004；005', 'STUDENT_ID', candidates), ['1001', '1002', '001', 'T1001']);
});

test('unknown and empty identifiers fail before changing the room roster', () => {
  assert.throws(() => resolveRoomCandidateInput('001\nmissing', 'STUDENT_ID', candidates), /未找到学号为“missing”/);
  assert.throws(() => resolveRoomCandidateInput('001\nmissing', 'EXAM_NUMBER', candidates), /未找到考号为“missing”/);
  assert.throws(() => resolveRoomCandidateInput(' \n ', 'STUDENT_ID', candidates), /请输入考生学号/);
});

test('duplicate student IDs across candidates require an unambiguous exam account', () => {
  assert.throws(() => resolveRoomCandidateInput('001', 'STUDENT_ID', [...candidates, { examNumber: 'other-school', studentId: '001' }]), /对应多名考生，请改用考号添加/);
});
