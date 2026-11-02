import { readFile,writeFile,mkdir } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import bcrypt from 'bcryptjs';
import {CreateExamSchema} from '@cwnupaa/proctor-shared';
import {prisma}from '../src/lib/db';
import {saveExam}from '../src/lib/exam-save';
import {digestPasswordForStorage}from '../src/lib/password-crypto';
import assert from 'node:assert/strict';

assert.equal(new URL(process.env.DATABASE_URL!).pathname,'/proctor_novajudge_qa');
const dir=process.cwd()+'/../../tmp/novajudge-live';await mkdir(dir,{recursive:true});
const nova=JSON.parse(await readFile(process.env.NOVAJUDGE_ACCESS_FILE || new URL('../../../../NovaJudge/.local/access.json', import.meta.url),'utf8'));
const password=randomBytes(18).toString('base64url');
const user=await prisma.user.create({data:{username:'nova-live-'+Date.now(),role:'SUPER_ADMIN',passwordHash:await bcrypt.hash(digestPasswordForStorage(password),10)}});
const now=Date.now();const exam=await saveExam(CreateExamSchema.parse({
 name:process.env.QA_DEMO_NAME || 'NovaJudge 监考客户端真实联调',platform:'NOVAJUDGE',platformBaseUrl:nova.url,platformContestId:String(nova.contestId),novaJudgeApiKey:nova.apiKey,novaJudgeTimezone:'Asia/Shanghai',
 startAt:new Date(now-60000),latestStartAt:new Date(now+3600000),endAt:new Date(now+14400000),durationMinutes:180,flexible:true,
 contestType:'INDIVIDUAL',administratorIds:[user.id],requireMiniProgram:false,requireFrontCamera:true,saveFullRecording:true,saveIncidentRecording:true,rules:'本机监考客户端与真实 NovaJudge 自动登录、下载、限制访问和监考联调。'
}),user.id);
const candidate=await prisma.candidate.create({data:{examId:exam.id,examNumber:nova.teamUsername,password:nova.teamPassword,name:'NovaJudge 联调考生',seatNo:'A01'}});
const room=await prisma.examRoom.create({data:{examId:exam.id,name:'本机联调考室',requireSecondCamera:false,requireFrontCamera:true,loginMode:'CREDENTIALS',loginReviewMode:'MANUAL',candidates:{create:{candidateId:candidate.id}},proctors:{create:{userId:user.id}}}});
await writeFile(dir+'/access.json',JSON.stringify({base:'http://127.0.0.1:43218',adminUsername:user.username,adminPassword:password,userId:user.id,examId:exam.id,examCode:exam.examCode,candidateId:candidate.id,roomId:room.id,novaContestId:nova.contestId,novaProblemId:nova.problemId,examNumber:nova.teamUsername,password:nova.teamPassword,name:candidate.name},null,2),{mode:0o600});
console.log('Created live exam',exam.examCode,'for actual NovaJudge contest',nova.contestId);
await prisma.$disconnect();
