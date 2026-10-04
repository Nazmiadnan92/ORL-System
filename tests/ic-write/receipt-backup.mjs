import assert from 'node:assert/strict';
import { verifyIdentityBackup } from '../../security/candidates/c1-create/compatibility.mjs';

export async function runReceiptBackupTests({t,sql,literal,json,users,keys,payload,commit}){
  const pw=crypto.randomUUID();
  sql('update public.orl_users set password_hash=extensions.crypt('+literal(pw)+",extensions.gen_salt('bf',4)) where id="+literal(users.WEBMASTER));
  const exportBackup=()=>JSON.parse(sql('set role service_role; select public.orl_ic_c1_export('+literal(users.WEBMASTER)+','+literal(pw)+')'));
  const importSql=b=>'select public.orl_ic_c1_import('+literal(users.WEBMASTER)+','+literal(pw)+','+json(b)+');';
  const resolve=(owner,id)=>JSON.parse(sql('set role service_role; select public.orl_ic_c1_resolve_create('+literal(owner)+','+literal(id)+')'));
  const snapshot=()=>sql("select jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),"+
    "'identities',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i),"+
    "'receipts',(select jsonb_agg(to_jsonb(c) order by request_id) from orl_private.c1_creation_receipts c),"+
    "'slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),"+
    "'audit',(select jsonb_agg(to_jsonb(a) order by id) from public.orl_audit_log a))");
  const fenced=await payload('ADMIN');
  const deleted=await payload('ADMIN',{patient_ic:'',age:'0',age_months:'6'});
  let backup;

  await t.test('portable backup includes cancelled attempts and deleted-request receipts with exact coverage',async()=>{
    assert.equal(resolve(users.ADMIN,fenced.p_request_id).outcome,'CANCELLED');
    commit(deleted);sql('delete from public.orl_requests where id='+literal(deleted.p_request_id));
    backup=exportBackup();
    assert.equal(backup.creation_receipt_format,'ORL_CREATE_RECEIPTS_V1');
    assert.equal(backup.creation_receipts.find(c=>c.request_id===fenced.p_request_id).outcome,'CANCELLED');
    assert.equal(backup.creation_receipts.find(c=>c.request_id===deleted.p_request_id).outcome,'CREATED');
    assert.equal(backup.requests.some(r=>r.id===deleted.p_request_id),false);
    assert.deepEqual(await verifyIdentityBackup(backup,keys),backup);
  });

  await t.test('older Restore merges rather than deletes newer cancellation and creation markers',async()=>{
    const newer=await payload('ADMIN'),saved=await payload('ADMIN');
    resolve(users.ADMIN,newer.p_request_id);commit(saved);
    const result=JSON.parse(sql('set role service_role; '+importSql(await verifyIdentityBackup(backup,keys))));
    assert.ok(result.creation_receipts>=backup.creation_receipts.length+2);
    assert.equal(resolve(users.ADMIN,newer.p_request_id).outcome,'CANCELLED');
    assert.equal(resolve(users.ADMIN,saved.p_request_id).outcome,'UNAVAILABLE');
    for(const attempt of [fenced,deleted,newer,saved])assert.throws(()=>commit(attempt));
    const after=exportBackup();assert.deepEqual(await verifyIdentityBackup(after,keys),after);
  });

  await t.test('receipt manifest rehydrates an empty receipt table inside a rolled-back synthetic restore',async()=>{
    const before=snapshot();
    const result=sql('begin; delete from orl_private.c1_creation_receipts; set local role service_role; '+importSql(backup)+
      'reset role; select count(*) from orl_private.c1_creation_receipts; rollback;').split(/\r?\n/);
    assert.equal(Number(result.at(-1)),backup.creation_receipts.length);
    assert.equal(snapshot(),before);
  });

  await t.test('receipt ownership remaps through backup usernames; owner conflict aborts all restore changes',async()=>{
    const alternate=structuredClone(backup),other=crypto.randomUUID();
    const old=users.ADMIN;
    alternate.users.find(u=>u.id===old).id=other;
    for(const r of alternate.requests)if(r.created_by===old)r.created_by=other;
    for(const c of alternate.creation_receipts)if(c.owner_id===old)c.owner_id=other;
    await verifyIdentityBackup(alternate,keys);
    const before=snapshot();
    sql('begin; set local role service_role; '+importSql(alternate)+'rollback;');
    assert.equal(snapshot(),before);
    const conflict=structuredClone(backup);
    conflict.creation_receipts.find(c=>c.request_id===fenced.p_request_id).owner_id=users.STAFF;
    await verifyIdentityBackup(conflict,keys);
    assert.throws(()=>sql('set role service_role; '+importSql(conflict)));
    assert.equal(snapshot(),before);
  });
}
