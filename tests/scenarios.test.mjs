import test from 'node:test';
import assert from 'node:assert/strict';
import {MAX_SCENARIOS,createScenario,editScenario,normalizeScenarios,scenarioInput,scenarioDataSignature,scenarioComparison,createScenarioRunner,scenarioCSV} from '../dist/scenarios.mjs';
import {scenarioScores} from '../dist/engine.mjs';
import {parseCSV} from '../dist/import.mjs';

const DATA={
  suppliers:[
    {id:'A',name:'企业甲',values:[10,80]},
    {id:'B',name:'企业乙',values:[20,100]},
    {id:'C',name:'企业丙',values:[12,90]},
    {id:'D',name:'企业丁',values:[8,60]},
  ],
  criteria:[
    {id:'cost',name:'采购单价',type:'cost',lower:.7,modal:1,upper:1.3},
    {id:'quality',name:'合格率',type:'benefit',lower:.7,modal:1,upper:1.3},
  ],sampleCount:100,seed:20261101,p:.9,delta:.02,
};

function score(data){
  const result=scenarioScores(data,data.criteria.map(c=>c.lower/3+c.modal/3+c.upper/3));
  return {sorted:result.sorted,suppliers:result.suppliers.map(row=>({id:row.id,name:row.name,baseline:row.score,wsmRank:row.rank}))};
}

test('create copies current settings and edits only relative importance, preserving range ratios',()=>{
  const before=structuredClone(DATA),scenario=createScenario(DATA,' 质量优先 ',[1,4]);
  assert.equal(scenario.name,'质量优先');
  assert.deepEqual(scenario.criteria.map(c=>[c.lower,c.modal,c.upper]),[[.7,1,1.3],[2.8,4,5.2]]);
  assert.deepEqual(DATA,before);
  const edited=editScenario(DATA,scenario,'重视质量',[2,3]);
  assert.deepEqual(edited.criteria.map(c=>[c.lower,c.modal,c.upper]),[[1.4,2,2.6],[2.0999999999999996,3,3.9000000000000004]]);
  const candidate=scenarioInput(DATA,edited);
  assert.deepEqual(candidate.suppliers,DATA.suppliers);
  assert.deepEqual(candidate.criteria.map(c=>c.type),['cost','benefit']);
  candidate.suppliers[0].values[0]=999;
  assert.equal(DATA.suppliers[0].values[0],10);
});

test('restore canonicalizes known criteria order and drops untrusted extra fields',()=>{
  const original=createScenario(DATA,'自定义情景');
  const [restored]=normalizeScenarios(DATA,[{...original,criteria:[...original.criteria].reverse(),untrusted:'ignored'}]);
  assert.deepEqual(restored.criteria,original.criteria);
  assert.equal('untrusted'in restored,false);
  assert.notEqual(restored,original);
  assert.deepEqual(normalizeScenarios(DATA,null),[]);
});

test('restore rejects excessive, duplicate, mismatched and unsafe scenario configurations',()=>{
  const original=createScenario(DATA,'方案');
  const rejected=[
    [{...original,id:'<script>'},/编号/],
    [{...original,id:'baseline'},/编号/],
    [{...original,name:'x'.repeat(81)},/1–80/],
    [{...original,name:'a\nb'},/控制字符/],
    [{...original,criteria:original.criteria.slice(0,1)},/数量/],
    [{...original,criteria:[original.criteria[0],original.criteria[0]]},/重复指标/],
    [{...original,criteria:[original.criteria[0],{...original.criteria[1],id:'unknown'}]},/未知/],
    [{...original,criteria:[{...original.criteria[0],modal:Infinity},original.criteria[1]]},/重要程度/],
    [{...original,criteria:[{...original.criteria[0],modal:'1'},original.criteria[1]]},/重要程度/],
    [{...original,criteria:[{...original.criteria[0],lower:0},original.criteria[1]]},/重要程度/],
    [{...original,criteria:[{...original.criteria[0],upper:.5},original.criteria[1]]},/重要程度/],
    [{...original,datasetSignature:'different'},/已变化/],
  ];
  for(const [entry,message]of rejected)assert.throws(()=>normalizeScenarios(DATA,[entry]),message);
  assert.throws(()=>normalizeScenarios(DATA,[original,{...original,id:'second'}]),/名称.*重复/);
  assert.throws(()=>normalizeScenarios(DATA,[original,{...original,name:'different'}]),/编号.*重复/);
  assert.throws(()=>normalizeScenarios(DATA,Array(MAX_SCENARIOS+1).fill(original)),/最多保存/);
});

test('changed baseline weights preserve scenarios but changed source values or directions invalidate them',()=>{
  const scenario=createScenario(DATA,'方案');
  const newBaseline=structuredClone(DATA);newBaseline.criteria[0].modal=.8;
  assert.equal(scenarioDataSignature(DATA),scenarioDataSignature(newBaseline));
  assert.equal(normalizeScenarios(newBaseline,[scenario]).length,1);
  const newData=structuredClone(DATA);newData.suppliers[0].values[0]=11;
  assert.throws(()=>normalizeScenarios(newData,[scenario]),/已变化/);
  const newDirection=structuredClone(DATA);newDirection.criteria[0].type='benefit';
  assert.throws(()=>normalizeScenarios(newDirection,[scenario]),/已变化/);
  assert.throws(()=>createScenario(DATA,'方案',[1,0]),/大于零/);
});

test('actual engine rankings change with procurement importance and compare to current baseline',()=>{
  const scenario=createScenario(DATA,'质量优先',[1,4]),candidate=scenarioInput(DATA,scenario);
  const model=scenarioComparison(DATA,score(DATA),[{scenario,result:score(candidate)}]);
  assert.equal(model.columns[0].top[0].id,'A');
  assert.equal(model.columns[1].top[0].id,'B');
  assert.equal(model.columns[1].byId.get('B').change,3);
  assert.ok(model.columns[1].byId.get('D').change<0);
  assert.equal(model.columns[1].top.length,3);
});

test('qualified-only order is explicitly separate from original ranks and retains full-cohort scores',()=>{
  const scenario=createScenario(DATA,'质量优先',[1,4]),baseline=score(DATA),result=score(scenarioInput(DATA,scenario));
  const model=scenarioComparison(DATA,baseline,[{scenario,result}],{eligibleIds:['B','C'],eligibleOnly:true});
  assert.equal(model.filtered,true);assert.equal(model.total,4);assert.equal(model.qualifiedCount,2);
  assert.deepEqual(model.rows.map(row=>row.id),['C','B']);
  assert.equal(model.columns[0].byId.get('C').rank,1);
  assert.equal(model.columns[0].byId.get('C').originalRank,3);
  assert.equal(model.columns[1].byId.get('B').rank,1);
  assert.equal(model.columns[1].byId.get('B').change,1);
  assert.equal(model.columns[1].byId.get('B').score,result.suppliers.find(row=>row.id==='B').baseline);
  const all=scenarioComparison(DATA,baseline,[{scenario,result}],{eligibleIds:['B','C'],eligibleOnly:false});
  assert.equal(all.rows.length,4);assert.equal(all.filtered,false);
  const empty=scenarioComparison(DATA,baseline,[{scenario,result}],{eligibleIds:[]});
  assert.equal(empty.rows.length,0);
});

test('runner uses original supplier cohort and supports a minimal baseline-only scoring adapter',async()=>{
  const configs=[createScenario(DATA,'质量优先',[1,4]),createScenario(DATA,'成本优先',[4,1])],calls=[];
  const runner=createScenarioRunner(async data=>{calls.push(structuredClone(data));return score(data);});
  const run=await runner.run(DATA,configs);
  assert.equal(run.stale,false);assert.equal(run.completed.length,2);
  assert.equal(run.completed[0].result.sorted[0],'B');
  assert.equal(run.completed[1].result.sorted[0],'D');
  assert.equal(calls.length,2);assert.ok(calls.every(call=>call.suppliers.length===4));
  assert.deepEqual(calls[0].suppliers,DATA.suppliers);
});

test('runner discards stale async completions and reports meaningful scoring errors',async()=>{
  let resolve;
  const scenario=createScenario(DATA,'优先质量'),runner=createScenarioRunner(()=>new Promise(done=>{resolve=done;}));
  const pending=runner.run(DATA,[scenario]);
  runner.invalidate();resolve(score(DATA));
  assert.deepEqual(await pending,{stale:true,completed:[]});
  const bad=createScenarioRunner(async()=>{throw new Error('计算服务不可用');});
  await assert.rejects(bad.run(DATA,[scenario]),/优先质量.*计算服务不可用/);
  const incomplete=createScenarioRunner(async()=>({suppliers:[]}));
  await assert.rejects(incomplete.run(DATA,[scenario]),/完整供应商/);
});

test('comparison CSV includes proper scoring units, original rank, scope and injection protection',()=>{
  const data=structuredClone(DATA);data.suppliers[0].name='=BAD()';
  const scenario=createScenario(data,'+方案'),model=scenarioComparison(data,score(data),[{scenario,result:score(data)}],{eligibleIds:['A','B']});
  const rows=parseCSV(scenarioCSV(model));
  assert.match(rows[1][1],/仅通过准入.*全部供应商/);
  assert.deepEqual(rows[3],['方案名称','公司名称','入围顺序','原排名','综合评分（百分制）','较当前评估的顺序变化']);
  assert.equal(rows[4][1],"'=BAD()");
  assert.equal(rows[6][0],"'+方案");
  assert.equal(rows[4][4],'80');
});
