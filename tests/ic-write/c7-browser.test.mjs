import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
const root=new URL('../../',import.meta.url);
const clinical=readFileSync(new URL('docs/clinical-features.js',root),'utf8');
const app=readFileSync(new URL('docs/app.js',root),'utf8');
test('masked DOB recalculates at selected OT date; invalid DOB and passport use manual age',()=>{
  const code=clinical.slice(0,clinical.indexOf('function ageFields'));
  const context=vm.createContext({});vm.runInContext(code,context);
  for(const at of ['2026-10-06','2027-02-02','2027-02-03','2030-03-04']){
    const result=vm.runInContext(`JSON.stringify(icAgeParts('010203-**-****',new Date('${at}'),new Date('2026-10-06')))`,context);
    const full=vm.runInContext(`JSON.stringify(icAgeParts('010203-04-5678',new Date('${at}'),new Date('2026-10-06')))`,context);
    assert.equal(result,full);assert.notEqual(result,'null');
  }
  for(const value of ['991332-**-****','********4567','******-**-1234']){
    assert.equal(vm.runInContext(`icAgeParts('${value}')`,context),null);
  }
});
test('same visible IC must never merge different patients',()=>{
  const fn=app.split('\n').find(line=>line.startsWith('function samePatientRecord('));
  const context=vm.createContext({clinicalUpper:v=>String(v||'').trim().toUpperCase()});
  vm.runInContext(fn,context);
  const same=(a,b)=>context.samePatientRecord(a,b);
  assert.equal(same({mrn:'A1',patient_ic:'010203-**-****'},{mrn:'B2',patient_ic:'010203-**-****'}),false);
  assert.equal(same({patient_ic:'010203-**-****'},{patient_ic:'010203-**-****'}),false);
  assert.equal(same({patient_ic:'********4567'},{patient_ic:'********4567'}),false);
  assert.equal(same({mrn:' a1 '},{mrn:'A1'}),true);
  assert.equal(same({id:'synthetic-a'},{id:'synthetic-a'}),true);
});
