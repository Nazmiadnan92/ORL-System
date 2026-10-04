const uuid=x=>typeof x==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(x);
const exact=(x,keys)=>x&&typeof x==='object'&&!Array.isArray(x)&&Object.keys(x).sort().join(',')===[...keys].sort().join(',');
const str=(x,max,nonempty=false)=>typeof x==='string'&&x.length<=max&&(!nonempty||!!x.trim());
export function validControlView(b){
  return exact(b,['operation','scope','id','generation'])&&['SESSION','SLOT','HOLIDAYS','SETTINGS'].includes(b.scope)
    && (['SESSION','SLOT'].includes(b.scope)?uuid(b.id)&&uuid(b.generation):b.id===null&&b.generation===null);
}
export function validControl(b){
  if(!exact(b,['operation','action','id','data','generation','revision'])||!uuid(b.generation)
    ||typeof b.revision!=='string'||! /^[a-f0-9]{32}$/.test(b.revision)||!(b.id===null||uuid(b.id)))return false;
  const d=b.data;
  switch(b.action){
    case 'SESSION_STATUS': return uuid(b.id)&&exact(d,['status'])&&['ACTIVE','CANCELLED'].includes(d.status);
    case 'SESSION_TITLE': return uuid(b.id)&&exact(d,['title'])&&str(d.title,240);
    case 'SLOT_CLOSED': return uuid(b.id)&&exact(d,['closed'])&&typeof d.closed==='boolean';
    case 'HOLIDAY_SAVE': return exact(d,['date','title','description'])&&str(d.title,240,true)&&str(d.description,4096)
      &&typeof d.date==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(d.date)&&Number.isFinite(Date.parse(d.date));
    case 'HOLIDAY_DELETE': return uuid(b.id)&&exact(d,[]);
    case 'HOLIDAY_GENERATE': return b.id===null&&exact(d,['year'])&&Number.isInteger(d.year)&&d.year>=2026&&d.year<=2100;
    case 'HOLIDAY_CLEAR': return b.id===null&&exact(d,['password'])&&str(d.password,1024,true);
    case 'SETTINGS': return b.id===null&&d&&typeof d==='object'&&!Array.isArray(d)&&Object.keys(d).length>0
      &&Object.entries(d).every(([k,v])=>['SYSTEM_NAME','START_YEAR','END_YEAR','OT_DAYS','MAIN_SLOTS','SPECIAL_SLOTS'].includes(k)&&str(v,200,true));
    default:return false;
  }
}
