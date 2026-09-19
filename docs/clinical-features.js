// Age precision and request-based sub-specialty statistics (040/041).
function icAgeParts(ic,at=new Date(),today=new Date()){
 const raw=String(ic||'').trim();if(!/^\d{6}-?\d{2}-?\d{4}$/.test(raw))return null;
 const n=raw.replace(/-/g,''),month=+n.slice(2,4),day=+n.slice(4,6);let year=2000+(+n.slice(0,2));
 let born=new Date(year,month-1,day);if(born>today){year-=100;born=new Date(year,month-1,day)}
 if(born.getFullYear()!==year||born.getMonth()!==month-1||born.getDate()!==day||born>at)return null;
 // Match PostgreSQL age(): borrow days from the birth month when required.
 let months=(at.getFullYear()-year)*12+at.getMonth()-(month-1);
 if(at.getDate()<day)months--;
 const years=Math.floor(months/12);return years>=0&&years<=130?{years,months:months%12}:null;
}
function ageFields(readonly=false){return `<div class="field"><span class="age-label">Age</span><div class="age-pair"><label>Years<input name="age" type="number" min="0" max="130" step="1" ${readonly?'readonly':'required'}></label><label>Months<input name="age_months" type="number" min="0" max="11" step="1" placeholder="Unknown" ${readonly?'readonly':''}></label></div><small class="age-help">IC: calculated at the OT date when selected. Otherwise enter years and months (0-11). Blank months = unknown.</small></div>`}
function bindAgeParts(form,at){
 const ic=form.elements.patient_ic,years=form.elements.age,months=form.elements.age_months;if(!ic||!years)return;
 const sync=()=>{const value=icAgeParts(ic.value,at);for(const [input,key] of [[years,'years'],[months,'months']]){if(!input)continue;if(value){input.value=value[key];input.readOnly=true;input.dataset.auto='1'}else{if(input.dataset.auto==='1')input.value='';input.readOnly=false;input.dataset.auto='0'}}};
 ic.addEventListener('input',sync);sync();
}
function patientAgeText(row,date,short=false){
 const auto=icAgeParts(row.patient_ic,date?new Date(date+'T12:00:00'):new Date());
 const years=auto?.years??row.age,months=auto?.months??row.age_months;
 if(years===null||years===undefined||years==='')return short?'':'—';
 const y=Number(years),m=months===null||months===undefined||months===''?null:Number(months);
 if(m===null)return short?`${y}y`:`${y} years (months unknown)`;
 if(y===0)return short?`${m}m`:`${m} months`;
 return short?`${y}y${m?' '+m+'m':''}`:`${y} years${m?' '+m+' months':''}`;
}
let statsOffset=0,statsSub='',statsSequence=0;
function statistics(){
 statsOffset=0;statsSub='';statsSequence++;
 $('#content').innerHTML=head('Sub-specialty Statistics','Counts are requests, not unique patients. '+(user.role==='STAFF'?'Only your requests are included.':'All permitted requests are included.'))+`<form id="statsForm" class="card stats-filters"><label>Year<input id="statsYear" type="number" min="1900" max="2200" value="${new Date().getFullYear()}"></label><label>Month<select id="statsMonth"><option value="">All months</option>${months.map((m,i)=>`<option value="${i+1}">${esc(m)}</option>`).join('')}</select></label><label>From<input id="statsFrom" type="date"></label><label>To<input id="statsTo" type="date"></label><label>Specialist<input id="statsSpecialist" placeholder="Name contains..."></label><label>Status<select id="statsStatus"><option value="ACTIVE">Active cases</option><option value="PENDING">Pending approval</option><option value="SCHEDULED">Scheduled</option><option value="APPROVED">Approved</option><option value="POSTPONED">Active, previously postponed</option><option value="COMPLETED">Completed</option><option value="CANCELLED">Cancelled</option><option value="REJECTED">Rejected</option><option value="ALL">All except Draft</option></select></label><label>Slot<select id="statsAssignment"><option value="">Any</option><option value="ASSIGNED">Assigned</option><option value="UNASSIGNED">Unassigned</option></select></label><button class="primary">Apply</button></form><p class="muted">Dates use OT date for assigned cases and date submitted for unassigned cases. From/To override Year/Month. Postponed means an active request with postponement history.</p><div id="statsCards" class="stats-cards"></div><div id="statsResults" aria-live="polite"></div>`;
 $('#statsForm').onsubmit=e=>{e.preventDefault();statsOffset=0;statsSub='';loadStatistics()};loadStatistics();
}
async function loadStatistics(){
 const seq=++statsSequence,box=$('#statsResults');if(!box)return;
 const y=Number($('#statsYear').value),m=Number($('#statsMonth').value),from=$('#statsFrom').value,to=$('#statsTo').value;
 if(!from&&!to&&(!Number.isInteger(y)||y<1900||y>2200)){box.textContent='Enter a valid year.';return}
 const iso=d=>`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`;
 const p_from=from||(!to?iso(new Date(y,m?m-1:0,1)):null),p_to=to||(!from?iso(new Date(y,m||12,0)):null);
 box.textContent='Loading...';
 try{
  const data=await rpc('orl_subspecialty_statistics',{p_session_token:token,p_from,p_to,p_sub:statsSub,p_specialist:$('#statsSpecialist').value.trim(),p_status:$('#statsStatus').value,p_assignment:$('#statsAssignment').value,p_offset:statsOffset});
  if(seq!==statsSequence||currentPage!=='statistics')return;
  const cards=$('#statsCards');cards.replaceChildren();
  for(const item of [{name:'',count:data.cards.reduce((n,c)=>n+Number(c.count),0)},...data.cards]){const button=document.createElement('button');button.type='button';button.className='card stat'+(statsSub===item.name?' stats-selected':'');button.textContent=`${item.name||'All sub-specialties'}: ${item.count}`;button.onclick=()=>{statsSub=item.name;statsOffset=0;loadStatistics()};cards.append(button)}
  box.innerHTML=`<p>${Number(data.total)} matching requests${statsSub?' | '+esc(statsSub):''}</p><div class="table-wrap"><table><thead><tr><th>Patient / MRN</th><th>Age</th><th>Diagnosis / Procedure</th><th>Doctor / Specialist</th><th>Sub-specialty</th><th>Status</th><th>OT Slot</th></tr></thead><tbody>${data.rows.map(r=>`<tr><td><b>${esc(patientNameCase(r.patient_name))}</b><br>${esc(clinicalUpper(r.mrn))}</td><td>${esc(patientAgeText(r,r.ot_date))}</td><td>${esc(clinicalUpper(r.diagnosis))}<br><b>${esc(clinicalUpper(r.surgery))}</b></td><td>${esc(patientNameCase(r.doctor))}<br>${esc(patientNameCase(r.specialist))}</td><td>${esc(r.sub_specialty)}</td><td>${esc(r.status==='CONFIRMED'?'PENDING':r.status)}${r.postpone_count?`<br>Postponed ×${Number(r.postpone_count)}`:''}</td><td>${requestSlotCard(r,true)}</td></tr>`).join('')||'<tr><td colspan="7">No matching cases.</td></tr>'}</tbody></table></div><div class="actions"><button id="statsPrev" ${statsOffset===0?'disabled':''}>Previous</button><span>${data.total?statsOffset+1:0}-${Math.min(statsOffset+data.rows.length,Number(data.total))} of ${Number(data.total)}</span><button id="statsNext" ${statsOffset+100>=data.total?'disabled':''}>Next</button></div>`;
  $('#statsPrev').onclick=()=>{statsOffset=Math.max(0,statsOffset-100);loadStatistics()};$('#statsNext').onclick=()=>{statsOffset+=100;loadStatistics()};
 }catch(e){if(seq===statsSequence&&currentPage==='statistics')box.textContent=e.message}
}
