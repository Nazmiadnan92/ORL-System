import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8').replaceAll('\r','');
const md5=s=>createHash('md5').update(s).digest('hex');

test('062 modifies only Special read visibility, retaining protected wrappers and permissions',()=>{
 const migration=read('supabase/062_staff_special_slot_visibility.sql');
 const bodies=[...migration.matchAll(/\$newbody\$([\s\S]*?)\$newbody\$/g)].map(x=>x[1]);
 const specs=[
  ['040_age_months_doctor_names.sql','orl_get_schedule',s=>s.replace(" and (v_user.role<>'STAFF' or sl.slot_type='MAIN')",'')],
  ['042_special_day_availability.sql','orl_get_special_ot_days',s=>s.replaceAll("case when v_user.role in('ADMIN','WEBMASTER') then ",'').replaceAll(' else null end','')],
  ['043_split_month_availability.sql','orl_get_year_month_counts',s=>s.replace(" and (v_user.role in('ADMIN','WEBMASTER') or sl.slot_type='MAIN')\n",'').replace("case when v_user.role in('ADMIN','WEBMASTER') then special_available else null end",'special_available')]
 ];
 assert.equal(bodies.length,3);
 specs.forEach(([file,name,transform],i)=>{
  const source=read('supabase/'+file),start=source.indexOf('create or replace function public.'+name+'(');
  const bodyStart=source.indexOf('as $$',start)+5,old=source.slice(bodyStart,source.indexOf('$$;',bodyStart));
  assert.equal(bodies[i],transform(old));
  assert.ok(migration.includes(md5(old)));assert.ok(migration.includes(md5(bodies[i])));
  assert.match(bodies[i],/public\.orl_require_session\(p_session_token\)/);
 });
 assert.doesNotMatch(migration,/(?:update|delete from|insert into|truncate|alter table)\s+(?:public|orl_private)\./i);
 assert.doesNotMatch(migration,/\bgrant\s/i);
 assert.match(migration,/proacl is not distinct from before_acl/);
 for(const name of ['orl_get_schedule','c1_mask_json','orl_require_session','orl_assign_slot','orl_move_postponed_checked'])assert.ok(migration.includes(name));
 assert.match(migration,/begin;[\s\S]*notify pgrst,'reload schema';\ncommit;/);
});

test('062 installer pins files, backs up before confirmation, uses hidden password and audited verified TLS',()=>{
 const installer=read('security/release/install-062.ps1');
 for(const path of ['supabase/062_staff_special_slot_visibility.sql','security/release/audit-special-visibility.sql']){
  const hash=createHash('sha256').update(readFileSync(new URL('../../'+path,import.meta.url))).digest('hex').toUpperCase();
  assert.ok(installer.includes(hash),path+' hash pin');
 }
 assert.ok(installer.indexOf('pg_dump.exe')<installer.indexOf("Read-Host 'Type INSTALL 062'"));
 assert.ok(installer.indexOf("Read-Host 'Type INSTALL 062'")<installer.indexOf('-f $migration'));
 assert.match(installer,/sslmode=verify-full/);assert.match(installer,/Test-OrlReviewedCa/);
 assert.match(installer,/-AsSecureString/);assert.match(installer,/Count-ne10/);
 assert.match(installer,/finally\{\$env:PGPASSWORD=\$oldPassword;\$password=\$null\}/);
 assert.doesNotMatch(installer,/pg_restore\.exe.*--dbname/);
 assert.match(installer,/\n'@\n \$lines=\$preflight/);
 assert.match(read('security/release/Pasang-062.cmd'),/install-062\.ps1/);
 assert.match(read('security/release/audit-special-visibility.sql'),/begin read only;/);
});
