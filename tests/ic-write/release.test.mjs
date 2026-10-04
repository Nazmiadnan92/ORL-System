import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createIcGateway } from '../../supabase/functions/_shared/c1/gateway.mjs';
import { C1_RATE_MAX_REQUESTS, C1_RATE_WINDOW_SECONDS } from '../../supabase/functions/_shared/c1/runtime-policy.mjs';

const token='aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const request=()=>new Request('https://synthetic.supabase.co/functions/v1/ic-requests',{method:'POST',
  headers:{origin:'https://nazmiadnan92.github.io','content-type':'application/json','x-orl-session':token},
  body:JSON.stringify({operation:'PREPARE_CREATE'})});

test('release gateway stays disabled by default and requires a shared rate decision',async()=>{
  let called=0;
  const disabled=createIcGateway({origins:['https://nazmiadnan92.github.io'],rpc:async()=>{called++}});
  assert.equal((await disabled(request())).status,503);assert.equal(called,0);
  const unavailable=createIcGateway({enabled:true,origins:['https://nazmiadnan92.github.io'],
    rpc:async name=>name==='orl_ic_c1_authorize'?{role:'STAFF'}:token,cryptoConfig:()=>assert.fail('not used')});
  assert.equal((await unavailable(request())).status,503);
});

test('production Edge entrypoint uses the fixed shared SQL limiter before dispatch',async()=>{
  const oldDeno=globalThis.Deno,oldFetch=globalThis.fetch;
  const keys=Buffer.alloc(32,7).toString('base64');
  const env={ORL_IC_C1_ENABLED:'true',SUPABASE_URL:'https://synthetic.supabase.co',
    SUPABASE_SECRET_KEYS:JSON.stringify({default:'sb_secret_SYNTHETIC'}),ORL_IC_CONTEXT:'synthetic',
    ORL_IC_ACTIVE_ENCRYPTION_KEY:'enc-v1',ORL_IC_ACTIVE_SEARCH_KEY:'search-v1',
    ORL_IC_ENCRYPTION_KEYS:JSON.stringify({'enc-v1':keys}),ORL_IC_SEARCH_KEYS:JSON.stringify({'search-v1':keys})};
  const calls=[];let serve;
  try{
    globalThis.Deno={env:{get:name=>env[name]},serve:handler=>{serve=handler}};
    globalThis.fetch=async(url,options)=>{
      const name=new URL(url).pathname.split('/').at(-1);calls.push({name,options});
      if(name==='orl_ic_c1_authorize')return Response.json({role:'STAFF'});
      if(name==='orl_ic_c1_rate_limit')return Response.json(true);
      if(name==='orl_ic_c1_prepare_create')return Response.json(token);
      return new Response(null,{status:500});
    };
    await import('../../supabase/functions/ic-requests/index.ts?release-test');
    const response=await serve(request());
    assert.equal(response.status,200);
    assert.deepEqual(calls.map(x=>x.name),['orl_ic_c1_authorize','orl_ic_c1_rate_limit','orl_ic_c1_prepare_create']);
    assert.deepEqual(JSON.parse(calls[1].options.body),{p_session_token:token});
    assert.equal(calls.every(x=>x.options.signal instanceof AbortSignal),true);
    assert.equal(C1_RATE_MAX_REQUESTS,30);assert.equal(C1_RATE_WINDOW_SECONDS,60);
  }finally{globalThis.Deno=oldDeno;globalThis.fetch=oldFetch}
});

test('generated 046 is hash-pinned and contains no localhost gate or secret material',()=>{
  const sql=readFileSync(new URL('../../supabase/046_ic_c1_guarded_cutover.sql',import.meta.url),'utf8').replaceAll('\r\n','\n');
  assert.equal(createHash('sha256').update(sql).digest('hex').toUpperCase(),'F7CD04881D13A5D88E3ECF3B36D266D3A58DF9AD1C97EACF4C32507EBEF7B154');
  assert.doesNotMatch(sql,/orl_test_owner|127\.0\.0\.1|c1_test_baseline|sb_secret_|patient_ic\s*=\s*'\d/i);
  assert.match(sql,/create function public\.orl_ic_c1_rate_limit/);
  assert.match(sql,/revoke all on function public\.orl_ic_c1_finalize_full_dump_recovery/);
  for(const name of ['preflight-c1.ps1','install-046.ps1']){
    const script=readFileSync(new URL(`../../security/release/${name}`,import.meta.url),'utf8');
    assert.match(script,/Test-OrlReviewedCa/);
    assert.doesNotMatch(script,/Get-FileHash[^\n]*\$orlCa/);
  }
  const guard=readFileSync(new URL('../../security/release/Get-OrlC1RecoveryGuardSql.ps1',import.meta.url),'utf8');
  assert.match(guard,/execute 'select orl_private\.c1_recovery_ready\(\)'/);
  assert.doesNotMatch(guard,/if has_046 and not orl_private\.c1_recovery_ready/);
});

test('migration 047 is hash-pinned, display-only and uses the reviewed certificate installer',()=>{
  const sql=readFileSync(new URL('../../supabase/047_mask_ic_last_six.sql',import.meta.url),'utf8').replaceAll('\r\n','\n');
  assert.equal(createHash('sha256').update(sql).digest('hex').toUpperCase(),'9FAD29E497EE94D5A38CEB2CC8F85EF6CC765D662134A9058F14D94840E2F0D4');
  assert.match(sql,/010203-\*\*-\*{4}/);
  assert.doesNotMatch(sql,/update\s+public\.orl_requests|delete\s+from|request_identity\s+set|patient_ic\s*=\s*'\d/i);
  const installer=readFileSync(new URL('../../security/release/install-047.ps1',import.meta.url),'utf8');
  assert.match(installer,/Test-OrlReviewedCa/);
  assert.match(installer,/Security\.Cryptography\.SHA256/);
  assert.doesNotMatch(installer,/Get-FileHash/);
  assert.match(installer,/ORL-before-047/);
  assert.match(installer,/9FAD29E497EE94D5A38CEB2CC8F85EF6CC765D662134A9058F14D94840E2F0D4/);
});
