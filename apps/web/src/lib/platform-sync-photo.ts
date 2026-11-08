import { FederationError } from './exam-federation-protocol';
import { readStoredImage } from './stored-image-read';
export async function readPlatformPhoto(key:string,examId:string,candidateId:string) {
 if(!key.startsWith(`${examId}/${candidateId}/`)||key.includes('\\')||key.split('/').some(p=>!p||p==='.'||p==='..'))throw new FederationError('身份照片不属于当前考生');
 return readStoredImage(key,10*1024*1024);
}
