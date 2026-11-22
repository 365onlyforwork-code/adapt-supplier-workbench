import test from 'node:test';
import assert from 'node:assert/strict';
import {createProjectStore,PROJECT_STORAGE_KEY} from '../dist/projects.mjs';
import {analyze,reclassify} from '../dist/engine.mjs';
import {PAPER_DATA} from './fixtures/benchmark.mjs';

function memoryStorage(){const values=new Map();return {getItem:key=>values.get(key)??null,setItem:(key,value)=>values.set(key,value),values};}
function fixtures(storage=memoryStorage()){
  let id=0,time=Date.parse('2026-11-21T08:00:00Z');
  const store=createProjectStore({storage,idFactory:()=>`id-${++id}`,now:()=>new Date(time).toISOString()});
  const data={...structuredClone(PAPER_DATA),sampleCount:100,title:'真实测试项目',source:{filename:'测试.xlsx'}};
  const analysis=analyze(data);
  return {store,data,...analysis,storage,tick:(ms=1000)=>time+=ms};
}

test('a successful analysis persists an actual project, summary and import activity',()=>{
  const {store,data,result,storage}=fixtures();
  assert.deepEqual(store.listProjects(),[]);assert.deepEqual(store.listActivities(),[]);
  const saved=store.recordAnalysis({data,result,kind:'import'});
  assert.equal(saved.persisted,true);assert.equal(saved.changed,true);
  const listed=store.listProjects()[0];
  assert.equal(listed.title,'真实测试项目');assert.equal(listed.supplierCount,5);assert.equal(listed.criterionCount,6);
  assert.equal(listed.unresolvedCount,result.pairs.filter(p=>p.status==='未解决').length);
  assert.equal(listed.status,'needs-review');assert.equal(store.listActivities()[0].kind,'import');
  const reopened=createProjectStore({storage}).getProject(saved.project.id);
  assert.deepEqual(reopened.data,saved.project.data);assert.equal(reopened.preferences.deltaMode,'auto');
});

test('reads and unchanged resumes preserve timestamps and do not invent activities',()=>{
  const {store,data,result,tick}=fixtures();
  const first=store.recordAnalysis({data,result});tick();
  store.getProject(first.project.id);store.listProjects();store.listActivities();
  const resumed=store.recordAnalysis({projectId:first.project.id,data:store.getProject(first.project.id).data,result,kind:'resume'});
  assert.equal(resumed.changed,false);assert.equal(resumed.project.updatedAt,first.project.updatedAt);assert.equal(store.listActivities().length,1);
});

test('comparison options persist exact tiny explicit tolerance and successive drags are coalesced',()=>{
  const {store,data,result,cache,tick,storage}=fixtures();
  const first=store.recordAnalysis({data,result});tick();
  let changed=reclassify(cache,.8,.000000001).result;
  store.recordAnalysis({projectId:first.project.id,data,result:changed,kind:'comparison',p:.8,delta:.000000001});tick();
  changed=reclassify(cache,.85,.000000002).result;
  const saved=store.recordAnalysis({projectId:first.project.id,data,result:changed,kind:'comparison',p:.85,delta:.000000002});
  assert.equal(store.listActivities().length,2);
  assert.equal(saved.project.data.delta,2e-9);assert.equal(saved.project.preferences.deltaMode,'explicit');
  const restored=createProjectStore({storage}).getProject(first.project.id);
  assert.equal(restored.data.delta,2e-9);assert.equal(restored.data.p,.85);
  assert.equal(analyze(restored.data).result.delta,2e-9);
});

test('automatic tolerance remains automatic after a persisted comparison change',()=>{
  const {store,data,result,cache,storage}=fixtures();
  const first=store.recordAnalysis({data,result});
  const changed=reclassify(cache,.8,null).result;
  store.recordAnalysis({projectId:first.project.id,data,result:changed,kind:'comparison',p:.8,delta:null});
  const restored=createProjectStore({storage}).getProject(first.project.id);
  assert.equal(restored.preferences.deltaMode,'auto');assert.equal(restored.data.delta,null);
});

test('quota or denied storage retains the current project in memory and reports failure',()=>{
  const denied={getItem:()=>null,setItem:()=>{throw new Error('QuotaExceeded');}};
  const {store,data,result}=fixtures(denied);
  const saved=store.recordAnalysis({data,result});
  assert.equal(saved.persisted,false);assert.equal(store.listProjects().length,1);assert.equal(store.storageStatus().persistent,false);assert.ok(store.storageStatus().warning);
  const noStorage=createProjectStore({storage:null});
  assert.equal(noStorage.recordAnalysis({data,result}).persisted,false);assert.equal(noStorage.listProjects().length,1);
});

test('corrupt stored JSON is not overwritten on read; valid later work can still be saved',()=>{
  const storage=memoryStorage();storage.setItem(PROJECT_STORAGE_KEY,'{broken');
  const {store,data,result}=fixtures(storage);
  assert.deepEqual(store.listProjects(),[]);assert.equal(storage.getItem(PROJECT_STORAGE_KEY),'{broken');
  assert.ok(store.storageStatus().warning);
  assert.equal(store.recordAnalysis({data,result}).persisted,true);
  assert.equal(createProjectStore({storage}).listProjects().length,1);
});

test('a corrupt project is skipped without discarding other valid history',()=>{
  const {store,data,result,storage}=fixtures();store.recordAnalysis({data,result});
  const raw=JSON.parse(storage.getItem(PROJECT_STORAGE_KEY));raw.projects.push({id:'bad'});storage.setItem(PROJECT_STORAGE_KEY,JSON.stringify(raw));
  const restored=createProjectStore({storage});assert.equal(restored.listProjects().length,1);assert.match(restored.storageStatus().warning,/已忽略/);
});

test('returned copies cannot corrupt internal records and deletion removes associated activities',()=>{
  const {store,data,result}=fixtures();const {project}=store.recordAnalysis({data,result});
  project.data.suppliers.length=0;const listed=store.listProjects();listed[0].resultSummary.unresolvedCount=999;
  assert.equal(store.getProject(project.id).data.suppliers.length,5);assert.notEqual(store.listProjects()[0].unresolvedCount,999);
  assert.deepEqual(store.removeProject(project.id),{removed:true,persisted:true});assert.deepEqual(store.listActivities(),[]);
});

test('incomplete or mismatched results cannot create fake successful projects',()=>{
  const {store,data,result}=fixtures();
  assert.throws(()=>store.recordAnalysis({data,result:{}}));
  assert.throws(()=>store.recordAnalysis({data,result:{...result,pairs:[]}}));
  assert.throws(()=>store.recordAnalysis({data,result,p:.8}));
  assert.throws(()=>store.recordAnalysis({data,result,delta:.2}));
  assert.deepEqual(store.listProjects(),[]);assert.deepEqual(store.listActivities(),[]);
});

test('stale tabs refresh before saving so different projects and activities are not overwritten',()=>{
  const storage=memoryStorage();let a=0,b=0;
  const first=createProjectStore({storage,idFactory:()=>`tab-a-${++a}`});
  const stale=createProjectStore({storage,idFactory:()=>`tab-b-${++b}`});
  const data={...structuredClone(PAPER_DATA),sampleCount:100,title:'A 项目'},result=analyze(data).result;
  const savedA=first.recordAnalysis({data,result,kind:'import'});
  const savedB=stale.recordAnalysis({data:{...data,title:'B 项目'},result,kind:'import'});
  assert.equal(first.listProjects().length,2);assert.equal(stale.listProjects().length,2);
  assert.equal(createProjectStore({storage}).listProjects().length,2);
  assert.equal(first.listActivities().length,2);
  assert.equal(first.getProject(savedB.project.id).data.title,'B 项目');
  stale.removeProject(savedA.project.id);
  assert.equal(first.getProject(savedA.project.id),null);
  const savedC=first.recordAnalysis({data:{...data,title:'C 项目'},result,kind:'import'});
  assert.ok(savedC.persisted);assert.equal(stale.listProjects().length,2);
  assert.equal(stale.getProject(savedA.project.id),null);
});

test('cross-tab refresh preserves unsaved memory fallback and later persists both tabs records',()=>{
  const base=memoryStorage();let deny=false,a=0,b=0;
  const flaky={getItem:key=>base.getItem(key),setItem:(key,value)=>{if(deny)throw new Error('QuotaExceeded');base.setItem(key,value);}};
  const first=createProjectStore({storage:flaky,idFactory:()=>`memory-a-${++a}`});
  const other=createProjectStore({storage:base,idFactory:()=>`memory-b-${++b}`});
  const data={...structuredClone(PAPER_DATA),sampleCount:100},result=analyze(data).result;
  deny=true;
  const unsaved=first.recordAnalysis({data:{...data,title:'内存项目'},result});assert.equal(unsaved.persisted,false);
  const remote=other.recordAnalysis({data:{...data,title:'其他标签项目'},result});
  assert.equal(first.listProjects().length,2);assert.equal(first.getProject(unsaved.project.id).data.title,'内存项目');
  assert.equal(first.getProject(remote.project.id).data.title,'其他标签项目');
  deny=false;
  const retry=first.recordAnalysis({projectId:unsaved.project.id,data:unsaved.project.data,result,kind:'resume'});
  assert.equal(retry.changed,false);assert.equal(retry.persisted,true);
  assert.equal(createProjectStore({storage:base}).listProjects().length,2);
  assert.equal(first.listActivities().length,2);
});
