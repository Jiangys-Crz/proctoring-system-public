import {test} from 'node:test';
import assert from 'node:assert/strict';
import {publicQuestionAnnouncement} from '../src/lib/public-question-announcement';
import {parentRoutePath} from '@cwnupaa/proctor-shared';
test('published question notices include the public question and answer within one announcement, without candidate identity',()=>{
 const text=publicQuestionAnnouncement({content:'如何读取输入？',answer:'请使用标准输入。',problemIndex:'A',problemTitle:'求和'});
 assert.match(text,/如何读取输入/);assert.match(text,/标准输入/);assert.match(text,/题目 A/);
 assert(publicQuestionAnnouncement({content:'x'.repeat(10000),answer:'y'.repeat(10000),problemIndex:null,problemTitle:null}).length<=10000);
});
test('returning to the parent route ignores browsing order and removes query strings and trailing slashes',()=>{
 for(const [path,parent] of [['/dashboard/exams/id/settings/rooms','/dashboard/exams/id/settings'],['/contest/problems/123/submit','/contest/problems/123'],['/contest/problems/123/','/contest/problems'],['/contest/submissions/id?tab=code#L5','/contest/submissions'],['/dashboard','/'],['/','/'],['https://evil.invalid','/']])assert.equal(parentRoutePath(path),parent);
});
