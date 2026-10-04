import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';

export async function runFullDumpRecoveryTests({t,sql,literal,json,users,payload,commit}){
  sql(readFileSync(new URL('./full-dump-recovery.sql',import.meta.url),'utf8'));
  const existing=await payload('ADMIN');commit(existing);
  const deleted=await payload('ADMIN',{patient_ic:'',age:'0',age_months:'6'});commit(deleted);
  sql(`delete from public.orl_requests where id=${literal(deleted.p_request_id)}`);
  const missing=await payload('ADMIN');
  const oldGeneration=sql('select generation from orl_private.c1_restore_generation');
  const sourceCounts=sql("select jsonb_build_object('requests',(select count(*) from public.orl_requests),"+
    "'identities',(select count(*) from orl_private.request_identity),'receipts',(select count(*) from orl_private.c1_creation_receipts))");
  const psql=process.env.ORL_IC_TEST_PSQL,bin=dirname(psql),target='c1_recovery_'+crypto.randomUUID().replaceAll('-','');
  const work=mkdtempSync(join(tmpdir(),'orl-c1-recovery-')),dump=join(work,'synthetic.dump');
  const common=['-h','127.0.0.1','-p','55461','-U','orl_test_owner'];
  const run=(exe,args,options={})=>execFileSync(join(bin,exe),args,{encoding:'utf8',stdio:['pipe','pipe','pipe'],...options});
  const targetSql=query=>run('psql.exe',['-X','-qAt',...common,'-d',target,'-v','ON_ERROR_STOP=1'],{input:query}).trim();
  const resolve=(token,id)=>JSON.parse(targetSql(`set role service_role;select public.orl_ic_c1_resolve_create(${literal(token)},${literal(id)})`));
  try{
    run('pg_dump.exe',[...common,'-d','postgres','-Fc','-f',dump]);
    run('createdb.exe',[...common,target]);
    run('pg_restore.exe',[...common,'--exit-on-error','--no-owner','-d',target,dump]);
    await t.test('fresh full-dump target stays closed until explicit owner recovery',()=>{
      assert.equal(targetSql('select orl_private.c1_recovery_ready()'),'f');
      for(const role of ['public','anon','authenticated','service_role'])
        assert.equal(targetSql(`select has_function_privilege('${role}','public.orl_ic_c1_finalize_full_dump_recovery(uuid,text,boolean)','EXECUTE')`),'f');
      assert.throws(()=>targetSql(`set role service_role;select public.orl_ic_c1_authorize(${literal(users.ADMIN)})`),/Full-dump recovery/);
      assert.throws(()=>targetSql(`insert into public.orl_sessions(user_id,token_hash,expires_at) values(${literal(users.ADMIN)},'blocked',now()+interval '1 hour')`),/Full-dump recovery/);
      assert.throws(()=>targetSql(`select public.orl_ic_c1_finalize_full_dump_recovery(${literal(oldGeneration)},'WRONG',false)`),/confirmation/);
    });
    await t.test('missing generation needs explicit null review and rolls back cleanly',()=>{
      const result=targetSql("begin;delete from orl_private.c1_restore_generation;select public.orl_ic_c1_finalize_full_dump_recovery(null,'ROTATE C1 GENERATION AND INVALIDATE SESSIONS',false);rollback;");
      assert.equal(JSON.parse(result).previous_generation_present,false);
      assert.equal(targetSql('select generation from orl_private.c1_restore_generation'),oldGeneration);
      assert.equal(targetSql('select orl_private.c1_recovery_ready()'),'f');
    });
    await t.test('finalization rotates generation, invalidates restored sessions and preserves private coverage',()=>{
      const result=JSON.parse(targetSql(`select public.orl_ic_c1_finalize_full_dump_recovery(${literal(oldGeneration)},'ROTATE C1 GENERATION AND INVALIDATE SESSIONS',false)`));
      assert.equal(result.status,'READY');assert.equal(result.generation_rotated,true);
      assert.equal(targetSql('select orl_private.c1_recovery_ready()'),'t');
      assert.notEqual(targetSql('select generation from orl_private.c1_restore_generation'),oldGeneration);
      assert.equal(targetSql('select count(*) from public.orl_sessions'),'0');
      assert.equal(targetSql("select jsonb_build_object('requests',(select count(*) from public.orl_requests),"+
        "'identities',(select count(*) from orl_private.request_identity),'receipts',(select count(*) from orl_private.c1_creation_receipts))"),sourceCounts);
    });
    await t.test('existing, deleted and missing old references resolve without recreation or blind retry',()=>{
      const freshToken=crypto.randomUUID();
      targetSql(`insert into public.orl_sessions(user_id,token_hash,expires_at) values(${literal(users.ADMIN)},encode(extensions.digest(${literal(freshToken)}::text,'sha256'),'hex'),now()+interval '1 hour')`);
      assert.deepEqual(resolve(freshToken,existing.p_request_id),{request_id:existing.p_request_id,outcome:'CREATED',status:'DRAFT',assigned:false});
      assert.deepEqual(resolve(freshToken,deleted.p_request_id),{request_id:deleted.p_request_id,outcome:'UNAVAILABLE'});
      assert.throws(()=>targetSql(`set role service_role;select public.orl_ic_c1_create(${literal(freshToken)},${literal(missing.p_request_id)},${json(missing.p_data)},${json(missing.p_envelope)},${json(missing.p_search)},${literal(oldGeneration)})`),/generation/);
      assert.deepEqual(resolve(freshToken,missing.p_request_id),{request_id:missing.p_request_id,outcome:'CANCELLED'});
      assert.deepEqual(resolve(freshToken,missing.p_request_id),{request_id:missing.p_request_id,outcome:'CANCELLED'});
      assert.equal(targetSql(`select count(*) from public.orl_requests where id=${literal(missing.p_request_id)}`),'0');
      assert.equal(targetSql(`select count(*) from orl_private.request_identity where request_id=${literal(missing.p_request_id)}`),'0');
    });
  }finally{
    try{run('dropdb.exe',[...common,'--if-exists',target])}finally{rmSync(work,{recursive:true,force:true})}
  }
}
