import { verify, createPublicKey, type KeyObject } from 'node:crypto';
import { z } from 'zod';
import { digest, DomainError } from '../../policy/src/core.js';

const claimSchema=z.object({
  version:z.literal(1),purpose:z.enum(['document_review','task_review']),intent:z.string().uuid(),
  binding:z.string().regex(/^[a-f0-9]{64}$/),request:z.string().regex(/^[a-f0-9]{64}$/),origin:z.string(),
  nonce:z.string().regex(/^[A-Za-z0-9_-]{43}$/),issued:z.number().int().finite(),expires:z.number().int().finite(),
}).strict();

/** Verification only: the independent trusted host retains its private signing key and must
 * deliver attestations directly to the user-controlled browser, never via model/tool output.
 * There is deliberately no handoff-signing or minting endpoint in this application. */
export class DocumentReviewHandoffVerifier {
  constructor(private readonly publicKey:KeyObject,readonly origin:string,private readonly now:()=>number=Date.now,private readonly purpose:'document_review'|'task_review'='document_review') {
    if(!['document_review','task_review'].includes(purpose))throw new Error('Unsupported review purpose.');
    if(publicKey.type!=='public'||publicKey.asymmetricKeyType!=='ed25519')throw new Error('An Ed25519 trusted-host public key is required.');
    const url=new URL(origin);if(url.protocol!=='https:'||url.origin!==origin||url.pathname!=='/'||url.username||url.password||url.search||url.hash)throw new Error('An exact HTTPS review origin is required.');
  }
  verify(proof:string,expected:{intent:string;binding:string;request:string}):{nonceHash:string;expires:number} {
    const fail=()=>new DomainError('PERMISSION_DENIED','A fresh trusted-host browser handoff is required.');
    if(typeof proof!=='string'||proof.length>4096)throw fail();
    const parts=proof.split('.');const [body,signature]=parts;
    if(parts.length!==2||!body||!signature||!/^[A-Za-z0-9_-]+$/.test(body)||!/^[A-Za-z0-9_-]{86}$/.test(signature))throw fail();
    const bytes=Buffer.from(body,'base64url');const sig=Buffer.from(signature,'base64url');
    if(bytes.toString('base64url')!==body||sig.length!==64||sig.toString('base64url')!==signature||!verify(null,bytes,this.publicKey,sig))throw fail();
    let claim:z.infer<typeof claimSchema>;
    try{claim=claimSchema.parse(JSON.parse(bytes.toString('utf8')));}catch{throw fail();}
    if(claim.purpose!==this.purpose||claim.origin!==this.origin||claim.intent!==expected.intent||claim.binding!==expected.binding||claim.request!==expected.request||
      claim.issued>this.now()+30000||claim.expires<=this.now()||claim.expires<=claim.issued||claim.expires>claim.issued+120000||
      Buffer.from(claim.nonce,'base64url').toString('base64url')!==claim.nonce)throw fail();
    return{nonceHash:digest(claim.nonce),expires:claim.expires};
  }
}

/** Public SPKI only. createPublicKey alone would silently accept private PEM input. */
export function parseDocumentReviewHostPublicKey(pem:string):KeyObject {
  if(!/^-----BEGIN PUBLIC KEY-----\r?\n[A-Za-z0-9+/=\r\n]+\r?\n-----END PUBLIC KEY-----\r?\n?$/.test(pem))throw new Error('Only a public SPKI host key is accepted.');
  const key=createPublicKey({key:pem,format:'pem',type:'spki'});
  if(key.type!=='public'||key.asymmetricKeyType!=='ed25519')throw new Error('An Ed25519 public host key is required.');
  return key;
}
