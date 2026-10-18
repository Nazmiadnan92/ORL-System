import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const read = p => readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const code = read('docs/audit-display.js');
const context = vm.createContext({});
vm.runInContext(code,context);
const {describe,table} = context.OrlAuditDisplay;
const view = (action,details='',extra={}) => describe({action,details,...extra});

const cases = [
 ['LOGIN','Custom username login','Signed in','Signed in to the system.'],
 ['LOGIN','Login pending required password change','Signed in','Signed in. Password change required.'],
 ['USER_CREATED','synthetic (STAFF); password change required','Account created','Created account: synthetic. Role: STAFF. Password change required.'],
 ['USER_UPDATED','synthetic (ADMIN)','Account updated','Updated account: synthetic. Role: ADMIN.'],
 ['USER_DELETED','synthetic (STAFF)','Account deleted','Deleted account: synthetic. Role: STAFF.'],
 ['ACCOUNT_PASSWORD_CHANGED','User changed own password','Password changed','Changed own password.'],
 ['REQUIRED_PASSWORD_CHANGED','','Password change completed','Completed the required password change.'],
 ['ACCOUNT_THEME_CHANGED','Theme changed to RUBY','Theme changed','Changed theme to RUBY.'],
 ['REQUEST_CREATED','','Request created','Created a new draft request.'],
 ['REQUEST_CONFIRMED','','Request confirmed','Ready to choose an OT slot.'],
 ['REQUEST_APPROVE','Reviewed','Request approved','Approved the request. Note: Reviewed'],
 ['REQUEST_REJECT','Duplicate','Request rejected','Rejected the request. Note: Duplicate'],
 ['PATIENT_ASSIGNED_CONFIRMED','','OT slot confirmed','confirmed OT slot'],
 ['OT_SLOT_RESERVED','','OT slot reserved','Reserved an OT slot'],
 ['SLOT_EDIT_CONFIRM','Patient details updated','Patient details updated','Updated patient details.'],
 ['SLOT_EDIT_POSTPONE','Patient details updated','Patient details updated','Updated patient details.'],
 ['SLOT_EDIT_CANCEL','Patient cancelled by Admin/Webmaster; OT slot released; cancellation record retained','Case cancelled','The request record was kept.'],
 ['DUPLICATE_OVERRIDE','Override of REQ-TEST | Reason: Different procedure','Duplicate request allowed','Existing request: REQ-TEST Reason: Different procedure'],
 ['POSTPONE_COUNT_UPDATED','Manual count: 3 to 4','Postpone count updated','Changed postpone count from 3 to 4.'],
 ['REQUEST_PERMANENTLY_DELETED','','Request permanently deleted','Permanently deleted the request.'],
 ['STAFF_CANCELLATION_REQUESTED','Patient declined','Cancellation requested','Reason: Patient declined'],
 ['DELETION_REQUESTED','Patient declined','Cancellation requested','Requested cancellation.'],
 ['DELETION_APPROVE','Patient declined','Cancellation approved','The request record was kept.'],
 ['DELETION_REJECT','Original request reason','Cancellation rejected','Original cancellation reason: Original request reason'],
 ['OT_SLOT_CLEARED','','Patient removed from slot','Removed the patient from the OT slot.'],
 ['BOOKING_MOVE_REQUESTED','{"from":"2026-10-21","to":"2026-11-04","reason":"Patient request"}','Date change requested','21-10-2026 → 04-11-2026. Reason: Patient request'],
 ['BOOKING_MOVE_REJECTED','{"move_id":"secret-id"}','Date change rejected','Rejected the OT date change request.'],
 ['PATIENT_POSTPONED','2026-10-21 to 2026-11-04 | Patient unwell','OT postponed','Postponed OT: 21-10-2026 → 04-11-2026. Reason: Patient unwell'],
 ['OT_POSTPONED','Patient unwell','OT postponed','Postponed OT. Reason: Patient unwell'],
 ['PATIENT_REASSIGNED','{"from":"2026-11-04","to":"2026-10-21","reason":"Earlier date"}','OT moved earlier','04-11-2026 → 21-10-2026'],
 ['OT_SLOT_REASSIGNED','Main Slot 5 moved to Special Slot 2','Slot changed','Moved patient: Main Slot 5 → Special Slot 2.'],
 ['OT_SLOT_REASSIGNED','Main Slot 5 swapped with Main Slot 6','Slots swapped','Swapped patients between Main Slot 5 and Main Slot 6.'],
 ['OT_SLOT_REASSIGNED','{"mode":"CLOSED_PAST_REASSIGN","ot_date":"11-10-2026","from_slot_label":"Main Slot 5","to_slot_label":"Main Slot 6"}','Past OT slot changed','OT: 11-10-2026'],
 ['OT_HOLD_PLACED','{"ot_date":"14-10-2026","reason":"Awaiting review"}','Case put on Hold','Slot kept. OT: 14-10-2026 Reason: Awaiting review'],
 ['OT_HOLD_REMOVED','{"ot_date":"2026-10-14"}','Hold removed','Removed Hold from the case. OT: 14-10-2026'],
 ['OT_HOLD_MOVED','{"postpone_increment":1,"reason":"New date agreed"}','Held case rescheduled','Postpone count increased by 1.'],
 ['OT_MARKED_DONE','{"ot_date":"14-10-2026"}','Marked as Done','Marked the case as Done. OT: 14-10-2026'],
 ['OT_DONE_REVERSED','{"previous_status":"COMPLETED","new_status":"SCHEDULED","reason":"Marked by mistake"}','Done status undone','Changed status from Done to Scheduled. Reason: Marked by mistake'],
 ['PAST_CASE_ADDED','{"ot_date":"14-10-2026","slot_type":"MAIN","slot_number":5,"reason":"Missed entry"}','Past case added','Added a case to past OT. OT: 14-10-2026 Slot: Main Slot 5 Reason: Missed entry'],
 ['PAST_CASE_CORRECTED','{"ot_date":"14-10-2026","reason":"Correction"}','Past case corrected','Corrected a past case.'],
 ['OT_SESSION_UPDATED','ACTIVE TEST DAY','OT day updated','Status: ACTIVE Title: TEST DAY'],
 ['OT_SLOT_CLOSED','MAIN Slot 5','Slot closed','Closed the OT slot. Slot: Main Slot 5'],
 ['OT_SLOT_REOPENED','SPECIAL Slot 2','Slot reopened','Reopened the OT slot. Slot: Special Slot 2'],
 ['HOLIDAY_OVERRIDE_ACTIVATED','ACTIVE TEST','OT enabled on blocked day','Enabled OT on a holiday or blocked day.'],
 ['HOLIDAY_SAVED','2026-10-21 Test holiday','Holiday / blocked day saved','Saved Test holiday on 21-10-2026.'],
 ['HOLIDAY_DELETED','','Holiday / blocked day removed','Removed a holiday or blocked-day entry.'],
 ['HOLIDAYS_GENERATED','5 added; 2 existing date(s) kept; source Calendar Malaysia','Holidays added','Added 5 holidays. Kept 2 existing dates.'],
 ['ALL_HOLIDAYS_CLEARED','5 holiday/block record(s) permanently removed','All holiday entries removed','Permanently removed 5 holiday / blocked-day entries.'],
 ['SETTINGS_UPDATED','{"SYSTEM_NAME":"Test system","MAIN_SLOTS":10,"OT_DAYS":[0,3]}','System settings saved','OT days: Sunday, Wednesday'],
 ['IC_FULL_REVEAL','Authorized full IC access. Purpose: Clinical review. Display expiry: 60 seconds.','Full IC access approved','Approved full IC access for 60 seconds. Purpose: Clinical review'],
 ['OT_LIST_FULL_IC_GENERATED','Authorized Excel OT list with full IC. OT date: 21-10-2026. Patient count: 1. Purpose: OT list preparation. Export reference: internal-id. Access released; physical printing/download completion is not tracked.','OT list export approved','Approved Excel export for OT 21-10-2026. Patients: 1. Full IC included.'],
 ['IC_ENCRYPTED_CREATED','Optional IC absent','No IC / Passport entered','No IC / Passport was entered.'],
 ['IC_ENCRYPTED_CREATED','Encrypted identity saved; operational value masked','IC / Passport saved securely','Displayed value remains masked.'],
 ['IC_ENCRYPTED_UPDATED','','IC / Passport updated','Updated IC / Passport securely.'],
 ['IC_SHADOW_CREATED','Encrypted copy verified by backend; original retained','Encrypted identity copy created','Original value was kept.'],
 ['IC_SHADOW_UPDATED','','Identity details updated','Original value was kept.'],
 ['IC_C2_BACKFILL_BATCH','Encrypted legacy identity batch; plaintext retained pending C6. Count: 40','Existing identity records encrypted','Encrypted 40 existing identity records. Original values were kept at this stage.'],
 ['IC_C2_COMPLETED','Plaintext retained pending C6. Count: 331','Identity encryption verified','verification of 331 existing identity records.'],
 ['IC_C6_PLAINTEXT_REMOVED','Full operational IC plaintext removed after fresh cryptographic verification. Protected count: 331','Unencrypted IC values removed','Protected records: 331'],
 ['MAINTENANCE_ON','{"previous_enabled":false,"message":"System update"}','Maintenance enabled','Admin and Staff access paused. Notice: System update'],
 ['MAINTENANCE_ON','{"previous_enabled":true}','Maintenance updated','access remains paused.'],
 ['MAINTENANCE_OFF','','Maintenance disabled','Maintenance access restrictions removed.'],
 ['DATABASE_BACKUP_EXPORTED','','Backup prepared','Prepared backup data for export.'],
 ['DATABASE_BACKUP_IMPORTED','20 requests and 30 slots restored','Backup restored','Restored 20 requests and 30 OT slots from backup.'],
 ['DATABASE_REPAIR','3 inconsistency record(s) repaired; Main slots compacted','Database repaired','Fixed 3 inconsistencies and reordered Main slots.'],
 ['DATABASE_PATIENT_REMOVAL','5 patient request record(s) permanently removed','Request records permanently deleted','Permanently deleted 5 patient request records.'],
 ['AUDIT_CLEANUP','10 audit record(s) before 2026-01-01 removed','Old audit records removed','Removed 10 audit records dated before 01-01-2026.']
];
for (const [action,details,label,expected] of cases) test(action+' / '+label+' / '+details.slice(0,30), () => {
 const result=view(action,details); assert.equal(result.activity,label); assert.ok(result.summary.includes(expected),result.summary);
});

test('every mapped action has an independent representative fixture',()=>{
 const labels=code.slice(code.indexOf('var labels ='),code.indexOf('var own ='));
 const codes=[...labels.matchAll(/\b([A-Z][A-Z0-9_]+):/g)].map(x=>x[1]);
 assert.deepEqual([...new Set(cases.map(x=>x[0]))].sort(),codes.sort());
});
test('JSON and historical text variants retain dates, reasons and zero counts without guessing missing data',()=>{
 const doneMove={mode:'DONE_PAST_REASSIGN',from_slot_label:'Main Slot 1',to_slot_label:'Main Slot 2',to_request_id:null,from_request_status:'COMPLETED'};
 assert.equal(view('OT_SLOT_REASSIGNED',doneMove).activity,'Past OT slot changed');
 assert.match(view('OT_SLOT_REASSIGNED',doneMove).summary,/Moved patient: Main Slot 1 → Main Slot 2\. Existing Done status kept\./);
 assert.equal(view('OT_SLOT_REASSIGNED',{...doneMove,to_request_id:'synthetic-id'}).activity,'Past OT slots swapped');
 assert.match(view('OT_SLOT_REASSIGNED',{...doneMove,to_request_id:'synthetic-id'}).summary,/Swapped patients between/);
 assert.equal(view('PATIENT_POSTPONED',JSON.stringify({from:'2026-10-21',to:'2026-11-04',reason:'Patient unwell'})).summary,view('PATIENT_POSTPONED','2026-10-21 to 2026-11-04 | Patient unwell').summary);
 assert.match(view('PATIENT_POSTPONED','21-10-2026 to 04-11-2026 | A\nB').summary,/Reason: A\nB$/);
 assert.match(view('POSTPONE_COUNT_UPDATED','Unscheduled manual count: 1 to 0').summary,/from 1 to 0/);
 assert.match(view('HOLIDAYS_GENERATED','0 added; 5 existing date(s) kept; source Calendar Malaysia',{record_id:'2027'}).summary,/0 holidays for 2027/);
 assert.doesNotMatch(view('OT_MARKED_DONE','{"reason":""}').summary,/Reason|OT:|undefined|null|surgery completed/i);
 assert.doesNotMatch(view('SLOT_EDIT_POSTPONE','Patient details updated').summary,/postponed/i);
 assert.doesNotMatch(view('BOOKING_MOVE_REJECTED','{"move_id":"hidden"}').summary,/hidden|Reason|date:/);
 assert.doesNotMatch(view('PAST_CASE_ADDED','{}').summary,/Done|completed|confirmed/);
 assert.match(view('OT_LIST_FULL_IC_GENERATED').note,/completion are not recorded/);
 assert.match(view('DATABASE_BACKUP_EXPORTED').note,/not confirmed/);
 assert.doesNotMatch(view('OT_HOLD_MOVED','{}').summary,/increased/);
});
test('unknown, null, malformed and prototype-like inputs remain safe and readable',()=>{
 for(const action of ['FUTURE_ACTION','constructor','toString','__proto__',''])assert.equal(view(action).activity,'Other activity');
 for(const details of [null,undefined,'{bad json','null','[]',42,{reason:{nested:'value'}}]){
  const result=view('OT_HOLD_PLACED',details);assert.equal(typeof result.summary,'string');assert.doesNotMatch(result.summary,/undefined|\[object Object\]/);
 }
 assert.equal(view('FUTURE_ACTION','Sensitive original text').summary,'Recorded system activity. See Technical details.');
 assert.match(table([]),/No matching audit records/);
});
test('original data is not mutated and raw action, IDs and details exist only inside closed native details',()=>{
 const original=Object.freeze({action:'OT_DONE_REVERSED',record_id:'synthetic-record-id',record_type:'REQUEST',occurred_at:'2026-10-19T01:02:03Z',user_name:'Test Admin',user_role:'WEBMASTER',details:' { "reason": "Mistake", "original_completed_by": "synthetic-user-id" } '});
 const before=JSON.stringify(original);const html=table([original]);assert.equal(JSON.stringify(original),before);
 assert.match(html,/<details class="audit-technical"><summary>Technical details<\/summary>/);assert.doesNotMatch(html,/<details[^>]*\bopen\b/);
 const withoutTechnical=html.replace(/<details[\s\S]*?<\/details>/g,'');assert.doesNotMatch(withoutTechnical,/synthetic-record-id|synthetic-user-id|OT_DONE_REVERSED/);
 assert.match(html,/Original details<\/div><pre> \{ &quot;reason&quot;/);
 assert.match(html,/Date \/ Time \(MYT\)/);assert.match(html,/19\/10\/2026, 09:02:03/);
 const nested=Object.freeze({reason:'Test',before:Object.freeze({status:'COMPLETED'}),after:Object.freeze({status:'SCHEDULED'})});
 assert.doesNotThrow(()=>table([{action:'PAST_CASE_CORRECTED',details:nested}]));
});
test('untrusted data is escaped everywhere including original details, user, role, IDs and summaries',()=>{
 const attack='<img src=x onerror="globalThis.pwned=1"> & <script>alert(1)</script>';
 const html=table([{action:attack,user_name:attack,user_role:attack,record_id:attack,record_type:attack,occurred_at:attack,details:attack},{action:'OT_HOLD_PLACED',details:JSON.stringify({reason:attack})}]);
 assert.doesNotMatch(html,/<img|<script|<\/script>/);assert.match(html,/&lt;img/);assert.match(html,/&amp;/);
 assert.equal(context.pwned,undefined);
});
test('frontend uses the same read-only audit endpoint and cache-busted display assets before app',()=>{
 const app=read('docs/app.js'),html=read('docs/index.html');
 const load=app.slice(app.indexOf('async function loadAudit()'),app.indexOf('\n',app.indexOf('async function loadAudit()')));
 assert.match(load,/rpc\('orl_get_audit',\{p_session_token:owner,p_search:/);assert.match(load,/OrlAuditDisplay.table/);
 assert.doesNotMatch(code,/\b(fetch|rpc|localStorage|sessionStorage|XMLHttpRequest)\b|Object\.hasOwn\(/);
 assert.ok(html.indexOf('audit-display.js?v=001')<html.indexOf('app.js?v=093'));
 assert.match(html,/audit-display\.css\?v=001/);
});
