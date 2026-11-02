import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allowedProblemLanguages, groupJudgeLanguages, languageFamily, resolveJudgeLanguage } from '../src/lib/exam-languages';
import { CreateExamSchema } from '@cwnupaa/proctor-shared';
import { resolveJudgeLanguage as pluginResolve } from '../../../hydro-plugin/cwnupaa-proctor-auth/judge-language';

test('all configured language families and concrete versions remain available in an unrestricted trial/public/formal exam', () => {
  const ids = ['c.c11', 'cc.cc17o2', 'cc.cc20o2', 'py3', 'py.py3', 'py.pypy3', 'java17', 'js.node', 'rs', 'go', 'pas'];
  const languages = ids.map(id => ({ id, name: id }));
  assert.deepEqual(allowedProblemLanguages({ problemType: 'default', languages: [] }, [], languages), ids);
  assert.deepEqual(groupJudgeLanguages(languages).map(group => group.name), ['C', 'C++', 'Python', 'Java', 'JavaScript', 'Rust', 'Go', 'Pascal']);
  assert.deepEqual(allowedProblemLanguages({ problemType: 'default', languages: ['rs', 'go'] }, ['rust'], languages), ['rs']);
  assert.equal(languageFamily('ts'), 'typescript');
  assert.deepEqual(CreateExamSchema.shape.allowedLanguages.parse(['rust', 'javascript', 'go', 'python']), ['rust', 'javascript', 'go', 'python']);
});

test('legacy Python aliases resolve to enabled Python 3 without switching versions or bypassing restrictions', () => {
  for (const resolve of [resolveJudgeLanguage, pluginResolve]) {
    assert.equal(resolve('python', ['py2', 'py.py3', 'py.pypy3']), 'py.py3');
    assert.equal(resolve('py.py3', ['py2', 'py3']), 'py3');
    assert.equal(resolve('py.pypy3', ['py3', 'pypy3']), 'pypy3');
    assert.equal(resolve('python', ['py2', 'py.pypy3']), null);
    assert.equal(resolve('py.py3', ['py2']), null);
    assert.equal(resolve('python', ['py3', 'py2'], ['py2']), null);
    assert.equal(resolve('py3', ['py3'], ['java']), null);
    assert.equal(resolve('java17', ['java17', 'java21']), 'java17');
    assert.equal(resolve('java17', ['java21']), null);
    assert.equal(resolve('cc.cc20o2', ['cc.cc17o2']), null);
  }
});
