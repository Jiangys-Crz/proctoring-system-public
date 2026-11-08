import { federationTransaction } from './exam-federation-store';
import { digest, keyHash, sealKey } from './exam-federation-protocol';
import type { PlatformSyncSettings } from './platform-sync-settings';

/** Rebuild transport indexes while keeping original submissions, discussions,
 * images and node/origin identities. Old per-exam keys cannot address v2 data. */
export async function migrateLegacyFederation(examId:string,settings:PlatformSyncSettings) {
 await federationTransaction(examId,async tx=>{
  const config=await tx.examFederation.findUniqueOrThrow({where:{examId}});if(config.managedGlobally)return;
  const exam=await tx.exam.findUniqueOrThrow({where:{id:examId},select:{examCode:true}});
  await tx.examFederationEntry.deleteMany({where:{examId}});
  // Image capabilities remain valid; replay their existing transport entries.
  await tx.examFederationContent.deleteMany({where:{examId,kind:{not:'asset'}}});
  await tx.contestSubmission.updateMany({where:{examId},data:{federationDirty:true,federationAttemptAt:null,federationError:null,federationRevision:0}});
  await tx.examQuestion.updateMany({where:{examId},data:{federationDirty:true,federationRevision:0}});
  await tx.examQuestionMessage.updateMany({where:{question:{examId}},data:{federationDirty:true}});
  await tx.examAnnouncement.updateMany({where:{examId},data:{federationDirty:true}});
  await tx.examFederation.update({where:{examId},data:{managedGlobally:true,enabled:settings.role==='PUBLIC',
   apiKeyHash:keyHash(settings.publicApiKey),apiKeyCiphertext:sealKey(settings.publicApiKey),remoteBaseUrl:settings.publicBaseUrl,
   contractHash:digest({examCode:exam.examCode,protocol:'platform-sync-v2'}),localContractHash:null,problemMapping:undefined,
   sequence:0,pushCursor:0,pullCursor:0,contentPushCursor:0,contentPullCursor:0,generation:{increment:1},leaseToken:null,leaseUntil:null,nextAttemptAt:new Date(),lastError:null,
  }});
 });
}
