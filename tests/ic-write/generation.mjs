import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
export async function runGenerationTests({t,sql,literal,json,users,payload,commit}){
  const pw=crypto.randomUUID();
  sql('update public.orl_users set password_hash=extensions.crypt('+literal(pw)+",extensions.gen_salt('bf',4)) where id="+literal(users.WEBMASTER));
  const exportBackup=()=>JSON.parse(sql('set role service_role; select public.orl_ic_c1_export('+literal(users.WEBMASTER)+','+literal(pw)+')'));
  const importSql=b=>'select public.orl_ic_c1_import('+literal(users.WEBMASTER)+','+literal(pw)+','+json(b)+');';
  const generation=()=>sql('select generation from orl_private.c1_restore_generation');
  await t.test('successful Restore rotates generation and blocks a delayed CREATE absent from backup and receipts',async()=>{
    const pending=await payload('ADMIN'),before=generation(),backup=exportBackup();
    assert.equal(backup.creation_receipts.some(c=>c.request_id===pending.p_request_id),false);
    sql('set role service_role; '+importSql(backup));
    assert.notEqual(generation(),before);
    assert.throws(()=>commit(pending));
    assert.equal(sql('select count(*) from public.orl_requests where id='+literal(pending.p_request_id)),'0');
    assert.equal(sql('select count(*) from orl_private.c1_creation_receipts where request_id='+literal(pending.p_request_id)),'0');
    const fresh=await payload('ADMIN');assert.equal(commit(fresh),fresh.p_request_id);
  });
  await t.test('failed Restore does not rotate generation; preparation and state remain private',async()=>{
    const pending=await payload('ADMIN'),before=generation(),backup=exportBackup();
    backup.creation_receipts[0].owner_id=crypto.randomUUID();
    assert.throws(()=>sql('set role service_role; '+importSql(backup)));
    assert.equal(generation(),before);assert.equal(commit(pending),pending.p_request_id);
    for(const role of ['anon','authenticated']){
      assert.equal(sql("select has_function_privilege('"+role+"','public.orl_ic_c1_prepare_create(uuid)','EXECUTE')"),'f');
      assert.equal(sql("select has_table_privilege('"+role+"','orl_private.c1_restore_generation','SELECT,INSERT,UPDATE,DELETE')"),'f');
    }
    assert.throws(()=>sql('set role service_role; select public.orl_ic_c1_prepare_create('+literal(crypto.randomUUID())+')'));
  });
  await t.test('active creation-generation shared lock refuses Restore without changing data or generation',async()=>{
    const backup=exportBackup(),before=generation();
    const child=spawn(process.env.ORL_IC_TEST_PSQL,['-X','-qAt','-h','127.0.0.1','-p','55461','-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'],{stdio:['pipe','pipe','pipe'],windowsHide:true});
    let timer;
    const closed=new Promise((resolve,reject)=>{child.on('error',reject);child.on('close',code=>code===0?resolve():reject(Error('Synthetic lock failed')))});
    closed.catch(()=>{});
    try{
      const ready=new Promise((resolve,reject)=>{
        let output='';child.stdout.on('data',bytes=>{output+=bytes.toString();if(output.includes('GENERATION_HELD'))resolve()});
        child.on('error',reject);timer=setTimeout(()=>reject(Error('Lock not ready')),5000);
      });
      child.stdin.write("begin; select pg_advisory_xact_lock_shared(hashtextextended('orl_ic_restore_generation',0)); select 'GENERATION_HELD';\n");
      await ready;clearTimeout(timer);
      assert.throws(()=>sql('set role service_role; '+importSql(backup)));
      assert.equal(generation(),before);
      assert.equal(sql('select count(*) from public.orl_requests'),String(backup.requests.length));
    }finally{clearTimeout(timer);child.stdin.end('rollback;\n');await closed}
  });
}
