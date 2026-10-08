import test from 'node:test';import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';import {execFileSync} from 'node:child_process';
test('057+058 installer transaction: both bodies validate together; failures roll back both migrations',()=>{
 const args=['-X','-qAt','-h','127.0.0.1','-p',process.env.ORL_IC_TEST_PORT,'-U','orl_test_owner','-d','postgres','-v','ON_ERROR_STOP=1'];
 const sql=input=>execFileSync(process.env.ORL_IC_TEST_PSQL,args,{input,encoding:'utf8',stdio:['pipe','pipe','pipe']}).trim();
 const body=file=>{
  const text=readFileSync(new URL('../../'+file,import.meta.url),'utf8');
  assert.equal([...text.matchAll(/^begin;\r?$/gm)].length,1);assert.equal([...text.matchAll(/^commit;\r?$/gm)].length,1);
  return text.replace(/^begin;\r?$/m,'-- outer installer transaction').replace(/^commit;\r?$/m,'-- outer installer commit');
 };
 const snapshot=()=>sql("select md5(jsonb_build_object('requests',(select jsonb_agg(to_jsonb(r) order by id) from public.orl_requests r),'slots',(select jsonb_agg(to_jsonb(s) order by id) from public.orl_ot_slots s),'identity',(select jsonb_agg(to_jsonb(i) order by request_id) from orl_private.request_identity i))::text)");
 const before=snapshot(),a=body('supabase/057_booking_move_requests.sql'),b=body('supabase/058_six_special_slots_2027.sql');
 const audit=readFileSync(new URL('../../security/release/audit-booking-workflow.sql',import.meta.url),'utf8').replace(/^begin read only;\r?$/m,'').replace(/^rollback;\r?$/m,'');
 const output=sql('begin;\n'+a+'\n'+b+'\n'+audit+'\nrollback;');
 const result=JSON.parse(output.split(/\r?\n/).find(l=>l.startsWith('{')));
 assert.equal(Object.keys(result).length,13);for(const [key,value] of Object.entries(result))assert.equal(value,true,key);
 assert.equal(snapshot(),before);assert.equal(sql("select to_regclass('orl_private.booking_move_requests') is null"),'t');
 // The production copy of020 was indented by the SQL editor before046 cloned it.
 // Accept only that separately reviewed body, not arbitrary whitespace/logic variants.
 const deployed=readFileSync(new URL('./fixtures/schedule-020-deployed-indentation.sql',import.meta.url),'utf8');
 const variantOutput=sql('begin;\n'+deployed+'\n'+a+'\n'+b+'\n'+audit+'\nrollback;');
 const variantResult=JSON.parse(variantOutput.split(/\r?\n/).find(l=>l.startsWith('{')));
 for(const [key,value] of Object.entries(variantResult))assert.equal(value,true,'deployed indentation: '+key);
 assert.equal(snapshot(),before);assert.equal(sql("select to_regclass('orl_private.booking_move_requests') is null"),'t');
 const unreviewed=deployed.replace('then 10 else 5 end','then 10 else 4 end');
 assert.notEqual(unreviewed,deployed);
 assert.throws(()=>sql('begin;\n'+unreviewed+'\n'+a+'\n'+b+'\ncommit;'),e=>/reviewed schedule baseline differs/.test(e.stderr||''));
 assert.equal(snapshot(),before);assert.equal(sql("select to_regclass('orl_private.booking_move_requests') is null"),'t');
 assert.throws(()=>sql('begin;\n'+a+'\n'+b+'\nselect 1/0;\ncommit;'));
 assert.equal(snapshot(),before);assert.equal(sql("select to_regclass('orl_private.booking_move_requests') is null"),'t');
 assert.equal(sql("select md5(replace(prosrc,chr(13),'')) from pg_proc where oid='orl_private.c1_prepare_schedule(uuid,integer,integer)'::regprocedure"),'a3466ebff4648c78b6f1582beffb7d3c');
});
