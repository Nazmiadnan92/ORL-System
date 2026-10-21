import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const read=p=>readFileSync(new URL('../../'+p,import.meta.url),'utf8').replace(/\r/g,'');
const body=source=>source.match(/create or replace function public\.orl_db_export\([^]*?as \$\$([^]*?)\$\$;/i)[1];
const md5=value=>createHash('md5').update(value).digest('hex');

test('070 recognizes exactly the canonical exporter and reviewed indentation-only deployed exporter',()=>{
 const canonical=body(read('supabase/016_encrypted_backup_restore.sql'));
 const deployed=body(read('tests/ic-write/fixtures/backup-016-deployed-indentation.sql'));
 assert.equal(md5(canonical),'685f55c7c5c33548eb79933d3beeb16d');
 assert.equal(md5(deployed),'e3ca01db6ff28a4a095eaa5addf2e192');
 assert.equal(canonical.length,1202);assert.equal(deployed.length,1472);
 assert.notEqual(canonical,deployed);
 const a=canonical.split('\n'),b=deployed.split('\n');assert.equal(a.length,17);assert.equal(b.length,a.length);
 for(let i=0;i<a.length;i++){
  assert.equal(a[i].trim(),b[i].trim(),'Same interior tokens and string literals on line '+(i+1));
  assert.equal(a[i].replace(/^ +/,''),b[i].replace(/^ +/,''),'Only leading ASCII spaces differ on line '+(i+1));
 }
 for(const file of ['supabase/070_ot_day_notes.sql','security/release/audit-day-notes.sql']){
  const source=read(file);
  const approved=source.match(/\('public\.orl_db_export\(uuid,text\)',array\[([^\]]+)\]\)/)[1];
  assert.equal(approved,"'685f55c7c5c33548eb79933d3beeb16d','e3ca01db6ff28a4a095eaa5addf2e192'");
  assert.doesNotMatch(source,/\b(?:btrim|trim|regexp_replace)\(\s*(?:p\.)?prosrc/i,'No generic source normalization bypass');
  assert.doesNotMatch(source,/create(?: or replace)? function public\.orl_db_export/i,'Exporter is not rewritten');
 }
 const baseline=read('supabase/070_ot_day_notes.sql').match(/do \$baseline\$([^]*?)end \$baseline\$;/)[1];
 assert.match(baseline,/prosecdef and md5\(replace\(prosrc,chr\(13\),''\)\)=any\(item\.expected_md5\)/);
 assert.match(baseline,/proconfig @> array\['search_path=""'\] or proconfig @> array\['search_path=public, extensions'\]/);
 assert.match(baseline,/has_function_privilege\(client,signature,'EXECUTE'\)/);
});
