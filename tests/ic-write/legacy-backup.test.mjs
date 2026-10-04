import {test} from 'node:test';
import assert from 'node:assert/strict';
import {convertLegacyBackup} from '../../security/candidates/c1-create/legacy-backup.mjs';
import {verifyIdentityBackup} from '../../security/candidates/c1-create/compatibility.mjs';
import {toBase64} from '../../supabase/functions/_shared/ic-crypto.mjs';
const key=()=>toBase64(crypto.getRandomValues(new Uint8Array(32)));
const config={context:'synthetic-legacy-test',activeEncryptionKey:'enc-v1',activeSearchKey:'search-v1',
  encryptionKeys:{'enc-v1':key()},searchKeys:{'search-v1':key()}};
const backup=()=>({format:'ORLOMS_BACKUP',version:1,users:[],settings:[],holidays:[],ot_sessions:[],ot_slots:[],audit_log:[],
  requests:[{id:crypto.randomUUID(),patient_ic:'SYNTHETIC-IC-111',age:20,age_months:3,booked_by_name:'Synthetic Booker'},
    {id:crypto.randomUUID(),patient_ic:'',age:0,age_months:6,doctor:'Synthetic Doctor'}]});
test('local V1 conversion preserves source, IDs, booking/age and blank infant IC without SQL or fabricated receipts',async()=>{
  const original=backup(),before=structuredClone(original);
  const result=await convertLegacyBackup(original,config);
  assert.deepEqual(original,before);assert.equal(result.version,2);assert.equal(result.identities.length,1);
  assert.deepEqual(result.creation_receipts,[]);
  assert.equal(result.requests[1].ic_protected,false);assert.equal(result.requests[1].age_months,6);
  for(let i=0;i<before.requests.length;i++){
    const {ic_protected,creation_tracked,...record}=result.requests[i];assert.deepEqual(record,before.requests[i]);assert.equal(creation_tracked,false);
  }
  assert.deepEqual(await verifyIdentityBackup(result,config),result);
});
test('legacy conversion rejects invalid input, missing keys and relabelled protected files without altering originals',async()=>{
  const variants=[];
  for(const change of [b=>b.version=2,b=>delete b.settings,b=>b.identities=[],b=>b.requests.push(b.requests[0]),
    b=>b.requests[0].patient_ic='••••111',b=>b.requests[0].patient_ic='******111',
    b=>b.requests[0].patient_ic=null,b=>b.requests[0].ic_protected=false]){
    const b=backup();change(b);variants.push(b);
  }
  for(const b of variants){const before=structuredClone(b);await assert.rejects(convertLegacyBackup(b,config),/Keep the original/);assert.deepEqual(b,before)}
  await assert.rejects(convertLegacyBackup(backup(),{...config,encryptionKeys:{}}),/no restore/);
});
