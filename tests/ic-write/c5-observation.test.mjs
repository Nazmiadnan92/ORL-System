import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';

const script=readFileSync(new URL('../../security/release/observe-c5.ps1',import.meta.url),'utf8');
const cmd=readFileSync(new URL('../../security/release/Jalankan-C5.cmd',import.meta.url),'utf8');

test('C5 live observer uses fixed public assets and a strict read-only workflow allowlist',()=>{
  for(const rpc of ['orl_get_dashboard','orl_get_schedule','orl_get_requests','orl_get_postponed','orl_get_deletions',
    'orl_get_audit','orl_get_settings','orl_get_account_settings','orl_list_holidays','orl_db_overview'])
    assert.match(script,new RegExp(`'${rpc}'`));
  for(const forbidden of ['orl_create_request','orl_assign_slot','orl_ic_reveal','orl_db_remove_patient','orl_db_import'])
    assert.doesNotMatch(script,new RegExp(`'${forbidden}'`));
  assert.match(script,/app\.js\?v=075/);assert.match(script,/styles\\\.css\\\?v=071/);
  assert.match(script,/icProtectionEnabled:\\s\*true/);
  assert.match(cmd,/observe-c5\.ps1/);
});

test('C5 validates masking, safe Edge denials and always attempts logout',()=>{
  assert.match(script,/Assert-OrlMaskedIdentity/);assert.match(script,/010203-\*\*-\*\*\*\*/);
  assert.match(script,/Please sign in again\./);assert.match(script,/Session access denied\./);
  assert.match(script,/finally\{/);assert.match(script,/Invoke-OrlRpc 'orl_logout'/);
  assert.match(script,/patient_mutations=0;reveal_operations=0/);
});
