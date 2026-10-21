import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read=file=>readFileSync(new URL('../../'+file,import.meta.url),'utf8');
const app=read('docs/app.js'),dataSource=read('docs/day-notes-data.js');
const id=n=>'00000000-0000-4000-8000-'+String(n).padStart(12,'0');
function harness(){
 const ctx={token:id(1),role:'ADMIN',protected:true},calls=[];
 const source={generation:id(2),notes:[{session_id:id(3),ot_date:'2027-01-13',day_note:'No Otology cases on this date.',revision:1},{session_id:id(4),ot_date:'2027-01-17',day_note:'',revision:0}]};
 const window={};vm.runInNewContext(dataSource,{window});
 const h={ctx,calls,source,fail:false,hook:()=>{},rows:[{session_id:id(3),ot_date:'2027-01-13',status:'ACTIVE',_ic_generation:id(2),slots:[{status:'AVAILABLE',type:'MAIN'}]},{session_id:id(4),ot_date:'2027-01-17',_ic_generation:id(2),slots:[]}]};
 h.data=window.OrlDayNoteData.create({getContext:()=>ctx,call:async(name,args)=>{calls.push({name,args});h.hook();if(h.fail)throw Error('Synthetic offline');return structuredClone(source)}});
 h.args={p_session_token:id(1),p_year:2027};return h;
}
test('Day Note enrichment reads all roles and exact dates without changing slots, patients or booking status',async()=>{
 for(const role of ['STAFF','ADMIN','WEBMASTER']){
  const h=harness();h.ctx.role=role;const before=JSON.stringify(h.rows),rows=await h.data.enrich(h.rows,h.args);
  assert.equal(rows[0].day_note,h.source.notes[0].day_note);assert.equal(rows[1].day_note,'');assert.equal(rows[1]._day_note_error,false);
  assert.equal(rows[0].slots,h.rows[0].slots);assert.equal(rows[0].status,'ACTIVE');assert.equal(JSON.stringify(h.rows),before);
  assert.equal(h.calls.length,1);assert.equal(h.calls[0].name,'orl_get_ot_day_notes');assert.equal(h.calls[0].args.p_year,2027);
 }
 const h=harness();h.rows=h.rows.map(({session_id,_ic_generation,...row})=>({...row,generation:_ic_generation}));
 assert.equal((await h.data.enrich(h.rows,h.args))[0].day_note,h.source.notes[0].day_note,'Staff date-only move responses use exact dates');
});
test('Day Note unknown state is explicit for failed, missing, duplicate, stale and malformed snapshots',async()=>{
 const variants=[h=>h.fail=true,h=>h.source.notes=[],h=>h.source.notes.push(h.source.notes[0]),h=>h.source.notes[0].revision=-1,
  h=>h.source.notes[0].day_note='x'.repeat(501),h=>h.source.notes[0].ot_date='2027-02-30',h=>h.source.notes[0].ot_date='2028-01-13',
  h=>h.source.generation=id(20),h=>h.rows[0]._ic_generation=undefined,h=>h.rows[0].session_id=id(30),h=>h.ctx.token=id(40),h=>h.hook=()=>{h.ctx.token=id(50)}];
 for(const change of variants){const h=harness();change(h);const rows=await h.data.enrich(h.rows,h.args);assert.equal(rows[0]._day_note_error,true);assert.equal(rows[0].day_note,undefined);assert.equal(rows[0].slots,h.rows[0].slots)}
 const h=harness();assert.equal((await h.data.enrich([],h.args)).length,0);assert.equal(h.calls.length,0);
});
test('Day Note editor re-reads the selected date and sends a single fenced write only for managers',async()=>{
 const h=harness(),choice={sessionId:id(3),otDate:'2027-01-13',owner:id(1)};
 const row=await h.data.read(choice);assert.equal(row.generation,id(2));assert.equal(row.revision,1);
 await h.data.save({...choice,note:'Updated reminder',revision:row.revision,generation:row.generation});
 assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1])),{name:'orl_set_ot_day_note',args:{p_session_token:id(1),p_session_id:id(3),p_note:'Updated reminder',p_expected_revision:1,p_generation:id(2)}});
 h.ctx.role='STAFF';await assert.rejects(h.data.read(choice));await assert.rejects(h.data.save({...choice,note:'No',revision:1,generation:id(2)}));assert.equal(h.calls.length,2);
 h.ctx.role='ADMIN';await assert.rejects(h.data.read({...choice,otDate:'2027-01-17'}));
 const before=h.calls.length;h.fail=true;await assert.rejects(h.data.save({...choice,note:'Try once',revision:1,generation:id(2)}));assert.equal(h.calls.length,before+1);
});
test('Actual rpc rechecks session after extra note read and never returns prior-user clinical rows',async()=>{
 const source=app.slice(app.indexOf('async function rpc('),app.indexOf('const dayNoteData='));
 for(const rpcName of ['orl_get_schedule','orl_booking_move_dates']){
  const rows=[{session_id:id(3),ot_date:'2027-01-13',slots:[{patient_name:'Synthetic only'}]}];let finish;
  const ctx=vm.createContext({window:{},token:id(1),protectedIcEnabled:()=>false,legacyRpc:async()=>rows,
   dayNoteData:{enrich:async result=>{await new Promise(resolve=>finish=resolve);return result}}});
  vm.runInContext(source,ctx);const result=ctx.rpc(rpcName,{p_session_token:id(1),p_year:2027});
  while(!finish)await new Promise(resolve=>setImmediate(resolve));ctx.token=id(9);finish();await assert.rejects(result,/session changed/);
 }
});
test('Actual Day Note integration covers each date selection and preserves original audit records',()=>{
 const active=name=>{let start=app.lastIndexOf('function '+name+'(');const rest=app.slice(start),end=rest.search(/\n(?:async )?function /);return end<0?rest:rest.slice(0,end)};
 for(const name of ['scheduleCard','loadPostponeSlots','reassignSlot','requestSlot'])assert.match(active(name),/orlDayNotes\?\.render/);
 assert.match(active('scheduleCard'),/orlDayNotes\?\.control/);assert.match(read('docs/booking-workflow.js'),/orlDayNotes\?\.render/);
 const html=read('docs/index.html');for(const file of ['day-notes-data.js?v=001','day-notes.js?v=001'])assert.ok(html.indexOf(file)>0&&html.indexOf(file)<html.indexOf('app.js?v=095'));
 const ctx=vm.createContext({});vm.runInContext(read('docs/audit-display.js'),ctx);
 for(const action of ['OT_DAY_NOTE_ADDED','OT_DAY_NOTE_UPDATED','OT_DAY_NOTE_REMOVED']){
  const row={action,details:JSON.stringify({ot_date:'2027-01-13',previous_note:'Before',note:'After',revision:2})},before=JSON.stringify(row);
  const view=ctx.OrlAuditDisplay.describe(row);assert.match(view.activity,/Day Note/);assert.match(view.summary,/13-01-2027/);assert.match(view.note,/Bookings are unchanged/);assert.equal(JSON.stringify(row),before);
 }
});
test('Actual rpc rechecks maintenance if it changes during the note lookup',async()=>{
 const source=app.slice(app.indexOf('async function rpc('),app.indexOf('const dayNoteData='));let blocked=false;
 const ctx=vm.createContext({window:{orlMaintenance:{before:async()=>{},after:()=>{if(blocked)throw Error('Maintenance active')}}},token:id(1),protectedIcEnabled:()=>false,legacyRpc:async()=>[{ot_date:'2027-01-13'}],dayNoteData:{enrich:async rows=>{blocked=true;return rows}}});
 vm.runInContext(source,ctx);await assert.rejects(ctx.rpc('orl_get_schedule',{p_session_token:id(1),p_year:2027}),/Maintenance active/);
});
