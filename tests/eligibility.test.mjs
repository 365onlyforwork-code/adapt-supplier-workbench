import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeEligibility,evaluateEligibility} from '../dist/eligibility.mjs';

const data={criteria:[{id:'cost',name:'采购单价（元）',type:'cost'},{id:'quality',name:'合格率（%）',type:'benefit'}],suppliers:[{id:'A',name:'甲',values:[100,98]},{id:'B',name:'乙',values:[120,99]},{id:'C',name:'丙',values:[95,96]}]};
const rules=[{id:'g1',criterionId:'cost',operator:'<=',threshold:110},{id:'g2',criterionId:'quality',operator:'>=',threshold:98}];

test('no enabled rules means unconfigured, never manufactured eligibility',()=>{
  for(const settings of [{},{enabled:true},{enabled:false,rules}]){
    const result=evaluateEligibility(data,settings);assert.equal(result.configured,false);
    assert.ok(result.rows.every(row=>row.status==='未配置'&&row.eligible===null));
    assert.deepEqual(result.eligibleIds,[]);assert.deepEqual(result.candidateIds,['A','B','C']);
  }
});

test('raw cost and percentage thresholds apply inclusively and equally to all suppliers',()=>{
  const before=JSON.stringify(data),result=evaluateEligibility(data,{enabled:true,rules});
  assert.deepEqual(result.rows.map(row=>row.status),['合格','不合格','不合格']);
  assert.deepEqual(result.eligibleIds,['A']);assert.deepEqual(result.excludedIds,['B','C']);
  assert.equal(result.rows[0].checks[1].actual,98);assert.equal(result.rows[0].checks[1].passed,true);
  assert.equal(result.counts.ineligible,2);assert.equal(JSON.stringify(data),before);
});

test('manual qualification is explicit, missing proof is pending, and known failures take priority',()=>{
  const settings={enabled:true,rules,requireQualification:true,qualifications:{A:'pending',B:'pending',C:'verified'}};
  const result=evaluateEligibility(data,settings);
  assert.deepEqual(result.rows.map(row=>row.status),['待核验','不合格','不合格']);
  assert.deepEqual(result.pendingIds,['A']);assert.deepEqual(result.candidateIds,[]);
  const onlyManual=evaluateEligibility(data,{enabled:true,requireQualification:true,qualifications:{A:'verified',B:'failed'}});
  assert.deepEqual(onlyManual.rows.map(row=>row.status),['合格','不合格','待核验']);
  assert.equal(onlyManual.rows[2].qualificationStatus,'pending');
});

test('known invalid thresholds, operators and duplicate metrics are rejected',()=>{
  for(const threshold of [NaN,Infinity,-1,'98',null])assert.throws(()=>normalizeEligibility(data,{enabled:true,rules:[{...rules[0],threshold}]}));
  assert.throws(()=>normalizeEligibility(data,{rules:[{...rules[0],operator:'>'}]}));
  assert.throws(()=>normalizeEligibility(data,{rules:[rules[0],{...rules[0],id:'another'}]}));
  assert.throws(()=>normalizeEligibility(data,{qualifications:{A:'auto-pass'}}));
});

test('restored stale references are filtered and cannot silently qualify suppliers',()=>{
  const normalized=normalizeEligibility(data,{enabled:true,rules:[{criterionId:'removed',operator:'>=',threshold:98}],qualifications:{removed:'verified'}});
  assert.deepEqual(normalized.rules,[]);assert.deepEqual(normalized.qualifications,{});
  assert.equal(evaluateEligibility(data,normalized).configured,false);
});

test('unusual supplier keys cannot change prototypes or inherit qualification approvals',()=>{
  const unusual={...data,suppliers:[{id:'__proto__',name:'原型键供应商',values:[100,98]},{id:'constructor',name:'构造键供应商',values:[105,99]}]};
  const qualifications=Object.fromEntries([['__proto__','verified']]);
  const normalized=normalizeEligibility(unusual,{enabled:true,requireQualification:true,qualifications});
  assert.equal(Object.getPrototypeOf(normalized.qualifications),Object.prototype);
  assert.equal(Object.hasOwn(normalized.qualifications,'__proto__'),true);
  assert.deepEqual(evaluateEligibility(unusual,normalized).rows.map(row=>row.status),['合格','待核验']);
  assert.equal({}.verified,undefined);
});

test('raw incomplete, nonpositive or dimensionally invalid data remains invalid',()=>{
  for(const value of [0,-1,null,NaN]){
    const invalid=structuredClone(data);invalid.suppliers[0].values[0]=value;
    assert.throws(()=>evaluateEligibility(invalid,{enabled:true,rules}));
  }
  const invalid=structuredClone(data);invalid.suppliers[0].values.pop();assert.throws(()=>normalizeEligibility(invalid,{}));
});
