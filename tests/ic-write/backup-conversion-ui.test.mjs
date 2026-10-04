import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {previewBackupVersion} from '../../docs/ic-client.mjs';

const app=readFileSync(new URL('../../docs/app.js',import.meta.url),'utf8');
const conversion=app.slice(app.indexOf('function showLegacyBackupConversion('),app.indexOf('async function encodeBackup('));
const functions=app.split(/\r?\n/).filter(x=>/^async function (backupKey|streamBytes|decodeBackup|encodeBackup|previewBackup)\(/.test(x));
assert.equal(functions.length,5);
function harness(){
  const calls=[],downloads=[],box={},status={},button={disabled:false};
  const original={format:'ORLOMS_BACKUP',version:1,requests:[{id:crypto.randomUUID(),patient_ic:'SYNTHETIC',age:0,age_months:6}]};
  const converted={...structuredClone(original),version:2};
  const fields={password:'SYNTHETIC-WM',passphrase:'SYNTHETIC-FILE',confirm_passphrase:'SYNTHETIC-FILE',consent:'on'};
  const form={isConnected:true,elements:Object.fromEntries(Object.entries(fields).map(([k,value])=>[k,{value}])),
    reset(){for(const f of Object.values(this.elements))f.value=''}};
  const blobs=new Map();
  const ctx=vm.createContext({crypto,TextEncoder,TextDecoder,Uint8Array,Blob,Response,CompressionStream,DecompressionStream,
    window:{_restoreBackup:{old:true}},user:{id:'synthetic-owner',role:'WEBMASTER'},token:'synthetic-session',
    protectedIcEnabled:()=>true,protectedIcClient:async()=>({previewBackupVersion}),
    $:selector=>({'#backupPreview':box,'#backupConvertForm':form,'#backupConvertStatus':status}[selector]),
    esc:String,FormData:class{
      constructor(f){this.data=f.data||Object.fromEntries(Object.entries(f.elements).map(([k,v])=>[k,v.value]))}
      get(k){return this.data[k]}
    },
    document:{createElement:()=>({click(){downloads.push({name:this.download,blob:blobs.get(this.href)})}})},
    URL:{createObjectURL:blob=>{const id=crypto.randomUUID();blobs.set(id,blob);return id},revokeObjectURL:id=>blobs.delete(id)},
    setTimeout:fn=>fn(),
    rpc:async(name,args)=>{calls.push({name,args});return converted},
  });
  vm.runInContext(conversion+'\n'+functions.join('\n'),ctx);
  const show=()=>ctx.showLegacyBackupConversion(original,box);
  const submit=()=>form.onsubmit({preventDefault(){},target:form,submitter:button});
  return {ctx,calls,downloads,box,status,form,button,original,converted,show,submit};
}

test('actual Webmaster V1 preview offers explicit conversion, never a Restore button or automatic request',async()=>{
  const h=harness(),phrase='SYNTHETIC-ORIGINAL',file=await h.ctx.encodeBackup(h.original,phrase);
  await h.ctx.previewBackup({preventDefault(){},target:{data:{file,passphrase:phrase}},submitter:h.button});
  assert.equal(h.ctx.window._restoreBackup,null);assert.equal(h.calls.length,0);
  assert.match(h.box.innerHTML,/Convert and Download Copy/);assert.doesNotMatch(h.box.innerHTML,/backupRestoreForm/);
  for(const role of ['STAFF','ADMIN']){h.ctx.user.role=role;assert.throws(h.show,/Webmaster/)}
});

test('actual conversion rejects missing consent/password, short or mismatched passphrases without network activity',async()=>{
  for(const [key,value] of [['consent',''],['password',''],['passphrase','short'],['confirm_passphrase','different']]){
    const h=harness();h.show();h.form.elements[key].value=value;await h.submit();
    assert.equal(h.calls.length,0);assert.equal(h.downloads.length,0);assert.equal(h.ctx.window._restoreBackup,null);
  }
});

test('actual conversion downloads separate encrypted copy, keeps original, clears passwords, and never restores',async()=>{
  const h=harness(),before=structuredClone(h.original);h.show();await h.submit();
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'orl_ic_convert_legacy_backup');
  assert.deepEqual(Object.keys(h.calls[0].args).sort(),['p_backup','p_password','p_session_token']);
  assert.equal(h.downloads.length,1);assert.match(h.downloads[0].name,/^orl-converted-[0-9a-f-]+\.orlbackup$/);
  const opened=await h.ctx.decodeBackup(h.downloads[0].blob,'SYNTHETIC-FILE');
  assert.deepEqual(structuredClone(opened),h.converted);assert.deepEqual(h.original,before);
  assert.equal(h.ctx.window._restoreBackup,null);assert.match(h.status.textContent,/No Restore was performed/);
  for(const key of ['password','passphrase','confirm_passphrase'])assert.equal(h.form.elements[key].value,'');
  await h.submit();assert.equal(h.calls.length,1,'Double click cannot repeat conversion');
});

test('conversion failure or account/navigation change does not download, retain password, or restore',async()=>{
  for(const condition of ['failure','account','navigation']){
    const h=harness();h.show();h.ctx.rpc=async()=>{
      if(condition==='failure')throw new Error('Synthetic conversion rejected');
      if(condition==='account')h.ctx.token='another-session';
      if(condition==='navigation')h.form.isConnected=false;
      return h.converted;
    };
    await h.submit();assert.equal(h.downloads.length,0);assert.equal(h.ctx.window._restoreBackup,null);
    for(const key of ['password','passphrase','confirm_passphrase'])assert.equal(h.form.elements[key].value,'');
    if(condition==='failure'){assert.equal(h.button.disabled,false);assert.match(h.status.textContent,/rejected/)}
  }
});
