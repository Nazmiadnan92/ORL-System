import { createHash, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';
import net from 'node:net';
import tls from 'node:tls';

const host='aws-0-ap-southeast-1.pooler.supabase.com';
const port=5432;
const expectedCaDerSha256='807025AD50D4ED219D2C9C7D299C004F824EB00CF7F65AFEF607D07B72E6CAFA';
const caPath=new URL('../../../ic-encryption-package-b/certs/supabase-prod-ca-2021.crt',import.meta.url);
const ca=readFileSync(caPath);
const caCertificate=new X509Certificate(ca);
const caDerSha256=createHash('sha256').update(caCertificate.raw).digest('hex').toUpperCase();
if(caDerSha256!==expectedCaDerSha256)throw new Error('Reviewed CA DER fingerprint changed.');
const now=Date.now();
if(now<Date.parse(caCertificate.validFrom)||now>=Date.parse(caCertificate.validTo))throw new Error('Reviewed CA is outside its validity period.');

const metadata=await new Promise((resolve,reject)=>{
  const socket=net.connect({host,port});
  const fail=error=>{socket.destroy();reject(error)};
  socket.setTimeout(20000,()=>fail(new Error('TLS metadata check timed out.')));
  socket.once('error',fail);
  socket.once('connect',()=>{
    const request=Buffer.alloc(8);request.writeInt32BE(8,0);request.writeInt32BE(80877103,4);socket.write(request);
  });
  socket.once('data',reply=>{
    socket.removeListener('error',fail);
    if(reply[0]!==0x53)return fail(new Error('Production pooler refused PostgreSQL TLS.'));
    if(reply.length>1)socket.unshift(reply.subarray(1));
    const secure=tls.connect({socket,servername:host,ca,rejectUnauthorized:true},()=>{
      try{
        if(!secure.authorized)throw new Error('TLS chain or hostname was not authorized.');
        const peer=secure.getPeerCertificate();
        resolve({host,port,authorized:secure.authorized,protocol:secure.getProtocol(),cipher:secure.getCipher()?.standardName||secure.getCipher()?.name,
          subject:peer.subject,issuer:peer.issuer,validFrom:peer.valid_from,validTo:peer.valid_to,
          fingerprint256:peer.fingerprint256,serialNumber:peer.serialNumber,reviewedCaDerSha256:caDerSha256});
      }catch(error){reject(error)}finally{secure.end()}
    });
    secure.setTimeout(20000,()=>{secure.destroy();reject(new Error('TLS handshake timed out.'))});
    secure.once('error',reject);
  });
});

console.log(JSON.stringify(metadata,null,2));
