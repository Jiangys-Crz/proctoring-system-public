import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formatScore, serializeObjectiveAnswers } from '@cwnupaa/proctor-shared';
import { compileProblemDraft, validateProblemDraft, type AuthoringQuestion } from '../src/lib/problem-authoring';

const question: AuthoringQuestion = {
  id: 'q', kind: 'multiple', content: '请选择符合条件的选项。', score: 5, answerText: '',
  options: [{ id: 'a', content: '甲' }, { id: 'b', content: '乙' }, { id: 'c', content: '丙' }],
  answers: ['c', 'a'],
};

test('multi-select grading policy is saved privately in a Hydro-compatible answer tuple', () => {
  const { content, configText } = compileProblemDraft({
    kind: 'objective', title: '计分测试', questions: [
      { ...question, id: 'legacy' },
      { ...question, id: 'partial', partialCredit: true },
      { ...question, id: 'strict', partialCredit: false },
    ],
  });
  assert.deepEqual(JSON.parse(configText).answers, {
    1: [['A', 'C'], 5], 2: [['A', 'C'], 5], 3: ['A,C', 5],
  });
  assert.match(content, /\{\{ multiselect\(3\) \}\}/);
  assert.doesNotMatch(content, /A,C/);
  assert.ok(validateProblemDraft({ kind: 'objective', title: '计分测试', questions: [
    { ...question, partialCredit: 'false' },
  ] }).some(issue => issue.path === 'questions.0.partialCredit'));
});

test('scores render with two decimals, including trailing zeroes and decimal ties', () => {
  assert.equal(formatScore(2.5), '2.50');
  assert.equal(formatScore(0), '0.00');
  assert.equal(formatScore(1.005), '1.01');
  assert.equal(formatScore(null), '—');
});

test('multi-select choices are submitted in option order without mutating answers or trimming fill-ins', () => {
  const answers = { 1: ['C', 'A'], 2: '  Test, a  ' };
  assert.deepEqual(JSON.parse(serializeObjectiveAnswers(answers)), { 1: ['A', 'C'], 2: '  Test, a  ' });
  assert.deepEqual(answers[1], ['C', 'A']);
});
