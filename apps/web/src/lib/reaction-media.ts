import { spawn } from 'node:child_process';
import path from 'node:path';
import os from 'node:os';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, readFile, writeFile, rm, realpath, copyFile, stat } from 'node:fs/promises';
import { GetObjectCommand } from '@aws-sdk/client-s3';
import { prisma } from './db';
import { getStorageSettings } from './settings';
import { withS3Client } from './s3-client-pool';
import { deleteStoredObject, storeBuffer } from './storage';
import { ccsContestTimeMs, coverage, reactionChannels, reactionTimelineFrames } from './reaction-domain';
import { generateReactionVideo } from './reaction-generator';
import { reactionObjectBytes, releaseReactionOutput, reserveReactionOutput } from './reaction-storage-budget';
import { reactionPresentationFromJson, readReactionAsset } from './reaction-presentation';
import { readBuiltinReactionBadge, resolveReactionBrandingLogo } from './reaction-branding';
import { parseReactionRankContext } from './reaction-ranking';
import { auditReactionFrameTiming, reactionIncompleteReason, type DecodedFrameTime } from './reaction-frame-timing';
import { resolveReactionTeamIdentity } from './reaction-team-name';
import { cameraPlaceholderReason } from './reaction-camera-source';

export async function runMedia(executable:string,args:string[],timeout=180000) {
  return new Promise<string>((resolve,reject)=>{
    const child=spawn(executable,args,{shell:false,windowsHide:true,stdio:['ignore','pipe','pipe']}); let output='', error='';
    const timer=setTimeout(()=>{child.kill();reject(new Error('MEDIA_PROCESS_TIMEOUT'));},timeout);
    child.stdout.on('data',b=>{output=(output+b).slice(-2_000_000);}); child.stderr.on('data',b=>{error=(error+b).slice(-8000);});
    child.on('error',()=>{clearTimeout(timer);reject(new Error('MEDIA_EXECUTABLE_UNAVAILABLE'));});
    child.on('close',code=>{clearTimeout(timer);code===0?resolve(output):reject(new Error(`MEDIA_PROCESS_FAILED:${code}:${error.slice(-1500)}`));});
  });
}
export async function probeReactionVideo(filename:string) {
  const p=JSON.parse(await runMedia(process.env.FFPROBE_PATH||'ffprobe',['-v','error','-show_streams','-show_format','-of','json',filename],30000));
  const video=p.streams?.find((s:{codec_type:string})=>s.codec_type==='video'); const duration=Number(p.format?.duration);
  if(!video || !Number.isFinite(duration) || duration<=0) throw new Error('VIDEO_INVALID');
  await runMedia(process.env.FFMPEG_PATH||'ffmpeg',['-v','error','-xerror','-i',filename,'-map','0:v:0','-f','null','-'],180000);
  return {duration,width:video.width,height:video.height,codec:video.codec_name};
}
export async function probeReactionFrameTiming(filename: string, from: number, duration: number) {
  const result = JSON.parse(await runMedia(process.env.FFPROBE_PATH || 'ffprobe', ['-v', 'error', '-threads', '1', '-select_streams', 'v:0', '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time,pkt_duration_time', '-of', 'json', filename], 30000)) as { frames?: DecodedFrameTime[] };
  return auditReactionFrameTiming(result.frames || [], from, duration);
}
export async function materializeReactionObject(key:string,destination:string) {
  if(!key || key.includes('\\') || key.split('/').some(p=>!p || p==='..' || p==='.') || key.includes(':')) throw new Error('INVALID_STORAGE_KEY');
  const settings=await getStorageSettings();
  if(settings.provider==='S3') {
    await withS3Client(settings,async client=>{
      const object=await client.send(new GetObjectCommand({Bucket:settings.s3.bucket,Key:key}),{abortSignal:AbortSignal.timeout(120000)});
      if(!object.Body) throw new Error('STORAGE_OBJECT_MISSING');
      await writeFile(destination,await object.Body.transformToByteArray());
    });
  } else {
    const root=await realpath(path.resolve(settings.localUploadDir)); const full=await realpath(path.join(root,key));
    if(!full.startsWith(root+path.sep)) throw new Error('INVALID_STORAGE_KEY');
    await copyFile(full,destination);
  }
}
async function publish(filename:string,prefix:string,name:string) {
  return (await storeBuffer(await readFile(filename),{filename:name,prefix,stableName:true,contentType:name.endsWith('.json')?'application/json':'video/mp4'})).objectPath;
}
async function removeTemporary(directory: string, prefix: string) {
  const resolved = await realpath(directory), parent = await realpath(os.tmpdir());
  if (path.dirname(resolved) !== parent || !path.basename(resolved).startsWith(prefix)) throw new Error('INVALID_TEMPORARY_DIRECTORY');
  await rm(resolved, { recursive: true, force: true });
}
async function discardObjects(keys: string[]) {
  // Every key here belongs to a fresh UUID attempt. Never delete an incumbent
  // result after a stale worker loses the compare-and-swap below.
  await Promise.all(keys.map(key => deleteStoredObject(key).catch(() => {})));
}
async function contestTiming(examId: string, submissionId: string, sourceSubmittedAt: Date, examStartAt: Date) {
  const event = await prisma.reactionEvent.findUnique({ where: { examId_type_remoteId: { examId, type: 'submissions', remoteId: submissionId } } });
  const payload = event?.payload;
  const value = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload.contest_time : null;
  const source = ccsContestTimeMs(value);
  return { sourceContestTime: typeof value === 'string' ? value : null,
    contestTimeMs: source ?? Math.max(0, +sourceSubmittedAt - +examStartAt),
    contestTimeBasis: source !== null ? 'CCS submissions.contest_time' : 'fallback: proctoring exam elapsed time (CCS duration unavailable)' };
}

/** Preserve the common timeline; missing intervals are black, never shortened. */
export async function renderReactionTimeline(
  report: ReturnType<typeof coverage>, durationSeconds: number,
  resolveSource: (id: string) => Promise<string>, directory: string, name: string,
) {
  const pieces = reactionTimelineFrames(report.slices, durationSeconds);
  const chunks: string[] = [];
  let decodedPieces = 0;
  const encode = ['-an', '-c:v', 'libx264', '-preset', 'veryfast', '-threads', '2', '-bf', '0', '-avoid_negative_ts', 'make_zero', '-pix_fmt', 'yuv420p', '-video_track_timescale', '12800'];
  for (let i = 0; i < pieces.length; i++) {
    const piece = pieces[i], output = path.join(directory, `${name}-part-${i}.mp4`);
    const background = `color=c=black:s=1280x720:r=25:d=${piece.frames / 25}`;
    let rendered = false;
    if (piece.id) {
      try {
        const input = await resolveSource(piece.id);
        // Overlay returns the black base after EOF (repeatlast=0). The base
        // owns the frame count, preventing a damaged/short source from moving
        // all later footage earlier on this channel.
        const filter = `[0:v]setpts=PTS-STARTPTS,trim=start=${piece.from}:duration=${piece.frames / 25},setpts=PTS-${piece.from}/TB,scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,setsar=1,fps=25[clip];[1:v][clip]overlay=eof_action=pass:repeatlast=0:shortest=0,setsar=1[out]`;
        await runMedia(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-y', '-i', input, '-f', 'lavfi', '-i', background, '-filter_complex_threads', '2', '-filter_complex', filter, '-map', '[out]', '-frames:v', String(piece.frames), ...encode, output]);
        rendered = true; decodedPieces++;
      } catch {
        report.complete = false;
        report.issues.push(`SOURCE_UNAVAILABLE_OR_UNDECODABLE:${piece.id}`);
      }
    }
    if (!rendered) await runMedia(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-y', '-f', 'lavfi', '-i', background, '-vf', 'setsar=1', '-frames:v', String(piece.frames), ...encode, output]);
    chunks.push(output);
  }
  if (!decodedPieces) return null;
  const list = path.join(directory, `${name}.txt`);
  await writeFile(list, chunks.map(p => `file '${p.replace(/\\/g, '/').replace(/'/g, "'\\''")}'`).join('\n'));
  const output = path.join(directory, `${name}.mp4`);
  // Independent WebM/MP4 pieces may carry different encoder delay or B-frame
  // DTS. Re-encode onto the shared frame clock; stream-copy can make a valid
  // collection of fragments into a non-monotonic, unplayable MP4.
  const totalFrames=pieces.reduce((sum,piece)=>sum+piece.frames,0);
  await runMedia(process.env.FFMPEG_PATH || 'ffmpeg', ['-nostdin', '-v', 'error', '-xerror', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-vf', 'setpts=N/(25*TB),fps=25,setsar=1', '-frames:v', String(totalFrames), ...encode, '-movflags', '+faststart', output]);
  const probe = await probeReactionVideo(output);
  if (Math.abs(probe.duration - durationSeconds) > 0.08) { report.complete = false; report.issues.push('OUTPUT_TIMELINE_MISMATCH'); }
  return { output, probe, pieces };
}
export async function captureReaction(id:string) {
  const r=await prisma.reaction.findUniqueOrThrow({where:{id},include:{segments:{include:{segment:true}},exam:true}});
  if(r.status!=='CAPTURING') return;
  if(!r.windowEnd) throw new Error('REACTION_WINDOW_NOT_CLOSED');
  const temporary=await mkdtemp(path.join(os.tmpdir(),'proctor-reaction-'));
  const prefix=`reactions/${r.examId}/${r.id}/capture-${randomUUID()}`;
  const published: string[] = []; let adopted = false, settled = false; let reserved = 0n;
  async function publishReserved(filename: string, name: string) {
    const bytes = (await stat(filename, { bigint: true })).size;
    await reserveReactionOutput(id, bytes); reserved += bytes;
    published.push(`${prefix}/${name}`);
    return publish(filename, prefix, name);
  }
  try {
    const channels:Record<string,unknown>={}; const paths:Record<string,string>={}; let allComplete=true;
    const reports: ReturnType<typeof coverage>[] = [];
    for(const channel of reactionChannels) {
      const segments=r.segments.map(x=>x.segment).filter(s=>s.channel===channel && !s.deletedAt);
      const report=coverage(segments,r.windowStart,r.windowEnd);
      reports.push(report);
      const frameTiming: Record<string, Awaited<ReturnType<typeof probeReactionFrameTiming>>> = {};
      const rendered=report.slices.length ? await renderReactionTimeline(report,(+r.windowEnd-+r.windowStart)/1000,async segmentId=>{
        const segment=segments.find(s=>s.id===segmentId)!;
        // Distinct source/output names also support uploaded MP4 containers.
        const input=path.join(temporary,`${channel}-${segments.indexOf(segment)}.source${path.extname(segment.objectPath)}`);
        await materializeReactionObject(segment.objectPath,input);
        const slice=report.slices.find(s=>s.id===segmentId)!;
        const timing=await probeReactionFrameTiming(input,slice.from,slice.duration);
        frameTiming[segmentId]=timing;
        if(!timing.complete){report.complete=false;report.issues.push(`${timing.issue}:${segmentId}`);}
        return input;
      },temporary,channel) : null;
      allComplete&&=report.complete;
      channels[channel]={...report,frameTiming,gapPresentation:'black frames for absent source intervals; sparse source frames remain PARTIAL',output:rendered?.probe||null,segments:segments.map(s=>({id:s.id,start:s.startedAt,end:s.endedAt,durationSeconds:s.durationSeconds,clockOffsetMs:s.clockOffsetMs,clockUncertaintyMs:s.clockUncertaintyMs,receivedAt:s.receivedAt}))};
      if(!rendered) continue;
      const name=channel==='DESKTOP_CAMERA'?'camera.mp4':'desktop.mp4';
      paths[channel]=await publishReserved(rendered.output,name);
    }
    const status=allComplete?'COMPLETE':Object.keys(paths).length?'PARTIAL':'MISSING';
    const incompleteReason=reactionIncompleteReason(reports);
    const timing=await contestTiming(r.examId,r.submissionId,r.sourceSubmittedAt,r.exam.startAt);
    const metadata={schemaVersion:1,examId:r.examId,contestId:r.contestId,submissionId:r.submissionId,teamId:r.teamId,teamName:r.teamName,schoolName:r.schoolName,problemId:r.problemId,verdict:r.originalVerdict,...timing,
      sourceSubmittedAt:r.sourceSubmittedAt,submissionObservedAt:r.submissionObservedAt,judgementObservedAt:r.judgementObservedAt,sourceJudgementEndAt:r.sourceJudgementEndAt,
      endTimeBasis:'server-observed-final-judgement (CCS synthetic end_time ignored)',eventOffsetMs:r.eventOffsetMs,windowStart:r.windowStart,windowEnd:r.windowEnd,status,incompleteReason,rankContext:r.rankContext,channels};
    const metadataFile=path.join(temporary,'metadata.json'); await writeFile(metadataFile,JSON.stringify(metadata,null,2));
    const metadataPath=await publishReserved(metadataFile,'metadata.json');
    adopted=await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${r.examId} FOR UPDATE`;
      const config=await tx.reactionConfig.findUnique({where:{examId:r.examId}});
      const result=await tx.reaction.updateMany({where:{id,status:'CAPTURING',windowStart:r.windowStart,windowEnd:r.windowEnd,originalVerdict:r.originalVerdict,reservedBytes:{gte:reserved}},data:{status,error:incompleteReason,cameraPath:paths.DESKTOP_CAMERA||null,desktopPath:paths.DESKTOP_SCREEN||null,metadataPath,outputBytes:reserved,durationSeconds:(+r.windowEnd!-+r.windowStart)/1000,finalizedAt:new Date(),generationStatus:config?.autoGenerate&&paths.DESKTOP_SCREEN&&r.judgementObservedAt&&(status==='PARTIAL'||paths.DESKTOP_CAMERA)?'QUEUED':'IDLE'}});
      await tx.reaction.updateMany({where:{id,reservedBytes:{gte:reserved}},data:{reservedBytes:{decrement:reserved}}});
      return result.count===1;
    },{isolationLevel:'ReadCommitted',timeout:15000});settled=true;
  } finally {try{if(!adopted) await discardObjects(published);if(!settled) await releaseReactionOutput(id,reserved);}finally{await removeTemporary(temporary,'proctor-reaction-');}}
}
export async function generateStoredReaction(id:string) {
  const r=await prisma.reaction.findUniqueOrThrow({where:{id},include:{exam:{include:{reactionConfig:true}}}});
  if(!['COMPLETE','PARTIAL'].includes(r.status)||(!r.cameraPath&&r.status!=='PARTIAL')||!r.desktopPath||!r.judgementObservedAt||!r.windowEnd) throw new Error('REACTION_GENERATOR_PLAYABLE_INPUTS_REQUIRED');
  const originalWindowDurationSeconds=(+r.windowEnd-+r.windowStart)/1000;
  if(!Number.isFinite(originalWindowDurationSeconds)||originalWindowDurationSeconds<=0) throw new Error('REACTION_GENERATOR_TIMING_INVALID');
  const temporary=await mkdtemp(path.join(os.tmpdir(),'proctor-generate-'));
  const prefix=`reactions/${r.examId}/${r.id}/generation-${randomUUID()}`;
  const published:string[]=[];let adopted=false,settled=false;let reserved=0n;
  try {
    const cameraPath=r.cameraPath?path.join(temporary,'camera.mp4'):null,desktopPath=path.join(temporary,'desktop.mp4'),outputPath=path.join(temporary,'reaction.mp4');
    const metadataFile=path.join(temporary,'metadata.json');
    let metadata:Record<string,unknown>={};
    if(r.metadataPath){await materializeReactionObject(r.metadataPath,metadataFile);metadata=JSON.parse(await readFile(metadataFile,'utf8'));}
    // Regenerated metadata retires the former display number; CCS UUID remains authoritative.
    delete metadata.displayId;
    metadata.submissionId=r.submissionId;
    const placeholderReason=cameraPlaceholderReason(r.cameraPath,metadata);
    if(r.cameraPath&&cameraPath){try{await materializeReactionObject(r.cameraPath,cameraPath);}catch{throw new Error('REACTION_GENERATOR_CAMERA_READ_FAILED');}}
    await materializeReactionObject(r.desktopPath,desktopPath);
    const timing=await contestTiming(r.examId,r.submissionId,r.sourceSubmittedAt,r.exam.startAt);
    const presentation=reactionPresentationFromJson(r.exam.reactionConfig?.presentation,r.examId);
    // Organization badges are managed only in System settings. Legacy manual
    // logo JSON remains readable for audit but never overrides system matching.
    const [candidate,teamEvent]=await Promise.all([
      prisma.candidate.findFirst({where:{examId:r.examId,examNumber:r.teamId},select:{examId:true,examNumber:true,teamName:true,school:true}}),
      prisma.reactionEvent.findUnique({where:{examId_type_remoteId:{examId:r.examId,type:'teams',remoteId:r.teamId}}}),
    ]);
    const teamIdentity=resolveReactionTeamIdentity({examId:r.examId,teamId:r.teamId,candidate,teamEvent});
    const currentCandidate=candidate?.examId===r.examId&&candidate.examNumber===r.teamId;
    const schoolName=currentCandidate?candidate!.school:r.schoolName;
    const schoolSource=currentCandidate?'current-candidate':'recording-snapshot';
    const resolvedLogo=await resolveReactionBrandingLogo(schoolName);
    async function asset(key:string|undefined,name:string,namespace=r.examId) {
      if(!key) return null;
      const buffer=await readReactionAsset(namespace,key),filename=path.join(temporary,name);
      await writeFile(filename,buffer);
      return {filename,sha256:createHash('sha256').update(buffer).digest('hex')};
    }
    const logoBuffer=resolvedLogo.path?await readReactionAsset('logo-library',resolvedLogo.path):await readBuiltinReactionBadge();
    const logoAsset={filename:path.join(temporary,'logo.png'),sha256:createHash('sha256').update(logoBuffer).digest('hex')};
    await writeFile(logoAsset.filename,logoBuffer);
    const backgroundAsset=await asset(presentation.backgroundPath,'background.png');
    const rankContext=parseReactionRankContext(r.rankContext,{contestId:r.contestId,teamId:r.teamId,submissionId:r.submissionId,verdict:r.originalVerdict});
    const ranks=rankContext?.status==='AVAILABLE'?{rankBefore:rankContext.beforeRank,rankAfter:rankContext.afterRank}:{rankBefore:null,rankAfter:null};
    const generated=await generateReactionVideo({cameraPath,desktopPath,outputPath,cameraPlaceholderReason:placeholderReason??undefined,teamName:teamIdentity.teamName,schoolName:resolvedLogo.normalizedSchoolName||undefined,problemLabel:r.problemLabel,verdict:r.originalVerdict||r.verdict||'',contestTimeMs:timing.contestTimeMs,judgementOffsetSeconds:(+r.judgementObservedAt-+r.windowStart)/1000,allowPartial:r.status==='PARTIAL',windowDurationSeconds:originalWindowDurationSeconds,...ranks,presentation:{fontPreset:presentation.fontPreset,logoPath:logoAsset.filename,backgroundPath:backgroundAsset?.filename}});
    const renderMetadata={generatedAt:new Date().toISOString(),renderer:'icpc/reactions-generator',submissionId:r.submissionId,teamName:teamIdentity.teamName,teamNameSource:teamIdentity.source,degraded:r.status==='PARTIAL',sourceStatus:r.status,incompleteReason:r.error,cameraSource:generated.cameraSource,cameraPlaceholderReason:generated.cameraPlaceholderReason,cameraTemplateBasis:generated.cameraTemplateBasis,generationWindow:generated.generationWindow,outputDurationSeconds:generated.duration,alignedWindowStart:r.windowStart.toISOString(),selectedWindowEnd:new Date(+r.windowStart+generated.duration*1000).toISOString(),fontPreset:presentation.fontPreset,logo:{basis:resolvedLogo.basis,source:'system-reaction-branding',organizationName:resolvedLogo.organizationName,normalizedSchoolName:resolvedLogo.normalizedSchoolName,schoolName,schoolSource,logoId:resolvedLogo.logoId,sha256:logoAsset.sha256},background:backgroundAsset?{basis:'uploaded',sha256:backgroundAsset.sha256}:{basis:'built-in'},rankContext:rankContext as unknown as import('@prisma/client').Prisma.InputJsonValue};
    const originalTeamNameSnapshot=typeof metadata.originalTeamNameSnapshot==='string'?metadata.originalTeamNameSnapshot:typeof metadata.teamName==='string'?metadata.teamName:r.teamName;
    await writeFile(metadataFile,JSON.stringify({...metadata,teamName:teamIdentity.teamName,originalTeamNameSnapshot,rankContext:r.rankContext,generation:renderMetadata},null,2));
    const oldVideoBytes=r.reactionPath?await reactionObjectBytes(r.reactionPath):0n;
    const oldMetadataBytes=r.metadataPath?await reactionObjectBytes(r.metadataPath):0n;
    const oldBytes=oldVideoBytes+oldMetadataBytes;
    if(r.outputBytes<oldBytes) throw new Error('REACTION_STORAGE_ACCOUNTING_UNINITIALIZED');
    const newBytes=(await stat(outputPath,{bigint:true})).size+(await stat(metadataFile,{bigint:true})).size;
    await reserveReactionOutput(id,newBytes);reserved=newBytes;
    published.push(`${prefix}/reaction.mp4`);const reactionPath=await publish(outputPath,prefix,'reaction.mp4');
    published.push(`${prefix}/metadata.json`);const metadataPath=await publish(metadataFile,prefix,'metadata.json');
    adopted=await prisma.$transaction(async tx=>{
      await tx.$queryRaw`SELECT id FROM Exam WHERE id = ${r.examId} FOR UPDATE`;
      const result=await tx.reaction.updateMany({where:{id,status:r.status,windowStart:r.windowStart,windowEnd:r.windowEnd,judgementObservedAt:r.judgementObservedAt,generationStatus:r.generationStatus,cameraPath:r.cameraPath,desktopPath:r.desktopPath,reactionPath:r.reactionPath,metadataPath:r.metadataPath,originalVerdict:r.originalVerdict,outputBytes:r.outputBytes,reservedBytes:{gte:reserved}},data:{reactionPath,metadataPath,renderMetadata,outputBytes:r.outputBytes-oldBytes+newBytes,generationStatus:'COMPLETE',generationError:null}});
      await tx.reaction.updateMany({where:{id,reservedBytes:{gte:reserved}},data:{reservedBytes:{decrement:reserved}}});
      return result.count===1;
    },{isolationLevel:'ReadCommitted',timeout:15000});settled=true;
    if(adopted) await discardObjects([r.reactionPath,r.metadataPath].filter((key):key is string=>Boolean(key)));
  } finally {try{if(!adopted) await discardObjects(published);if(!settled) await releaseReactionOutput(id,reserved);}finally{await removeTemporary(temporary,'proctor-generate-');}}
}
