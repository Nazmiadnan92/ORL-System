// Read-only schedule enrichment. Note failures never grant or change booking rights.
(function(root){
 'use strict';
 const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
 const date=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&!isNaN(Date.parse(value))&&new Date(value).toISOString().slice(0,10)===value;
 const revision=value=>Number.isSafeInteger(value)&&value>=0;
 const manager=role=>role==='ADMIN'||role==='WEBMASTER';
 function create({getContext,call}){
  const own=owner=>!!owner&&getContext().token===owner;
  async function load(owner,year){
   if(!own(owner)||!Number.isInteger(year)||year<2026||year>2100)throw Error('Reload the schedule to check Day Notes.');
   const result=await call('orl_get_ot_day_notes',{p_session_token:owner,p_year:year});
   if(!own(owner)||!uuid(result?.generation)||!Array.isArray(result.notes))throw Error('Day Notes could not be verified.');
   const ids=new Map(),dates=new Map();
   for(const row of result.notes){
    if(!uuid(row?.session_id)||!date(row.ot_date)||Number(row.ot_date.slice(0,4))!==year||typeof row.day_note!=='string'
     ||Array.from(row.day_note).length>500||!revision(row.revision)||ids.has(row.session_id)||dates.has(row.ot_date))throw Error('Day Notes could not be verified.');
    const snapshot={session_id:row.session_id,ot_date:row.ot_date,day_note:row.day_note,revision:row.revision,generation:result.generation};
    ids.set(row.session_id,snapshot);dates.set(row.ot_date,snapshot);
   }
   return {ids,dates,generation:result.generation};
  }
  async function enrich(rows,args){
   if(!Array.isArray(rows)||!rows.length)return rows;
   const owner=args.p_session_token;
   // Discard any unverified note metadata supplied by a different schedule path.
   const unknown=rows.map(row=>({...row,day_note:undefined,_day_note_revision:undefined,_day_note_generation:undefined,_day_note_owner:owner,_day_note_error:true}));
   try{
    const notes=await load(owner,args.p_year);
    return unknown.map(row=>{
     const snapshot=notes.dates.get(row.ot_date),generation=row._ic_generation||row.generation;
     if(!own(owner)||!snapshot||(row.session_id&&row.session_id!==snapshot.session_id)
      ||(getContext().protected&&!uuid(generation))||(generation&&generation!==notes.generation))return row;
     return {...row,day_note:snapshot.day_note,_day_note_revision:snapshot.revision,_day_note_generation:notes.generation,_day_note_error:false};
    });
   }catch{return unknown}
  }
  async function read({sessionId,otDate,owner}){
   if(!manager(getContext().role)||!uuid(sessionId)||!date(otDate))throw Error('Admin or Webmaster access required.');
   const notes=await load(owner,Number(otDate.slice(0,4))),snapshot=notes.ids.get(sessionId);
   if(!own(owner)||!manager(getContext().role)||snapshot?.ot_date!==otDate)throw Error('Reload this OT date before editing.');
   return snapshot;
  }
  async function save({sessionId,note,revision:expectedRevision,generation,owner}){
   if(!own(owner)||!manager(getContext().role)||!uuid(sessionId)||!uuid(generation)||!revision(expectedRevision)
    ||typeof note!=='string'||Array.from(note).length>500)throw Error('Reload this OT date before editing.');
   // One attempt only. After a lost response the editor requires a new read.
   const result=await call('orl_set_ot_day_note',{p_session_token:owner,p_session_id:sessionId,p_note:note,p_expected_revision:expectedRevision,p_generation:generation});
   if(!own(owner)||!manager(getContext().role))throw Error('Your session changed.');
   return result;
  }
  return Object.freeze({enrich,read,save});
 }
 root.OrlDayNoteData=Object.freeze({create});
})(window);
