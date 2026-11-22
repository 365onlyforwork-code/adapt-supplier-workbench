import test from 'node:test';
import assert from 'node:assert/strict';
import {createCloudProjectStore,CloudStoreError,MIGRATION_MAX_PROJECTS,MIGRATION_MAX_BYTES} from '../dist/cloud-projects.mjs';
import {createProjectStore,PROJECT_STORAGE_KEY} from '../dist/projects.mjs';
import {analyze} from '../dist/engine.mjs';
import {PAPER_DATA} from './fixtures/benchmark.mjs';

const copy=value=>structuredClone(value);
const response=(body,status=200)=>new Response(JSON.stringify(body),{status,headers:{'Content-Type':'application/json'}});
const failure=(code,message,status)=>response({error:{code,message}},status);
function storage(){const map=new Map();return {getItem:key=>map.get(key)??null,setItem:(key,value)=>map.set(key,value),map};}
function fixture(){
  let number=0;
  const memory=storage(),local=createProjectStore({storage:memory,idFactory:()=>`local-${++number}`,now:()=>new Date('2026-11-21T08:00:00Z').toISOString()});
  const data={...copy(PAPER_DATA),sampleCount:100,title:'企业采购评估',source:{filename:'供应商.xlsx'}};
  const {result}=analyze(data);
  return {memory,local,data,result};
}

function fakeServer(){
  const server={user:{id:'account-a',email:'a@example.test',name:'甲'},projects:new Map(),activities:[],requests:[],createMutations:new Map(),migrations:new Map(),next:0,networkAfterCreate:false};
  const view=project=>{
    const s=project.resultSummary;
    const managed=project.lifecycle!==undefined,lifecycle=project.lifecycle??'active',reviewState=project.reviewState??'unsubmitted';
    const lifecycleActions=project.role!=='administrator'?[]:lifecycle==='deleted'?['restore']:lifecycle==='inactive'?['activate']:reviewState==='pending'?[]:reviewState==='archived'?['deactivate']:['delete'];
    return {...copy(project),title:project.data.title,supplierCount:s.supplierCount,criterionCount:s.criterionCount,unresolvedCount:s.unresolvedCount,status:s.unresolvedCount?'needs-review':'complete',statusLabel:'已评估',...(managed?{lifecycle,lifecycleVersion:project.lifecycleVersion??0,inactiveAt:project.inactiveAt??null,deletedAt:project.deletedAt??null,reviewState,lifecycleActions}:{})};
  };
  const visible=()=>[...server.projects.values()].filter(project=>project.owner===server.user?.id);
  server.seed=(canonical,owner='account-a')=>{
    const project={...copy(canonical),id:`cloud-${++server.next}`,version:1,role:'administrator',canExport:true,owner};
    server.projects.set(project.id,project);return view(project);
  };
  server.fetch=async(url,init={})=>{
    const u=new URL(url,'https://adapt.example.test'),path=u.pathname.replace(/^\/api/,''),method=init.method??'GET',body=init.body?JSON.parse(init.body):undefined;
    server.requests.push({path,query:u.search,method,body,init});
    if(path==='/session')return server.user?response({user:server.user}):failure('UNAUTHENTICATED','请登录',401);
    if(!server.user)return failure('UNAUTHENTICATED','请登录',401);
    if(path==='/projects'&&method==='GET')return response({projects:visible().filter(project=>{
      const lifecycle=project.lifecycle??'active',filter=u.searchParams.get('lifecycle')??'active';
      return (lifecycle!=='deleted'||project.role==='administrator')&&(filter==='all'||filter===lifecycle);
    }).map(view)});
    if(path==='/activities')return response({activities:copy(server.activities.filter(row=>visible().some(project=>project.id===row.projectId)))});
    if(path==='/projects/migrate'&&method==='POST'){
      const mappings=[],projects=[];let importedCount=0,skippedCount=0,historyImportedCount=0;
      for(const legacy of body.projects){
        const key=`${server.user.id}:${legacy.localId}`;let projectId=server.migrations.get(key),alreadyImported=!!projectId;
        if(!projectId){
          const now='2026-11-21T09:00:00.000Z';
          const project=server.seed({data:legacy.data,resultSummary:legacy.resultSummary,preferences:{p:legacy.data.p,delta:legacy.data.delta,deltaMode:legacy.data.delta===null?'auto':'explicit'},source:legacy.data.source,createdAt:legacy.createdAt??now,updatedAt:legacy.updatedAt??now});
          projectId=project.id;server.migrations.set(key,projectId);server.projects.get(projectId).migrationLocalId=legacy.localId;importedCount++;
          for(const event of legacy.activities??[]){server.activities.push({...copy(event),projectId,source:'legacy',actor:null,actorLabel:'旧版浏览器记录'});historyImportedCount++;}
        }else skippedCount++;
        mappings.push({localId:legacy.localId,projectId,alreadyImported});projects.push(view(server.projects.get(projectId)));
      }
      return response({projects,importedCount,skippedCount,mappings,historyImportedCount});
    }
    if(path==='/projects'&&method==='POST'){
      const key=`${server.user.id}:${body.mutationId}`;
      if(server.createMutations.has(key))return response({project:view(server.projects.get(server.createMutations.get(key)))});
      const now='2026-11-21T09:00:00.000Z',project=server.seed({...copy(body),preferences:body.preferences??{p:body.data.p,delta:body.data.delta,deltaMode:body.data.delta===null?'auto':'explicit'},source:body.data.source,createdAt:now,updatedAt:now});
      server.createMutations.set(key,project.id);
      server.activities.unshift({id:`event-${server.next}`,projectId:project.id,projectTitle:body.data.title,kind:body.kind,label:'导入项目',detail:'',timestamp:now,actor:copy(server.user)});
      if(server.networkAfterCreate){server.networkAfterCreate=false;throw new Error('response lost after server commit');}
      return response({project});
    }
    const match=path.match(/^\/projects\/([^/]+)(.*)$/);
    if(!match)return failure('NOT_FOUND','不存在',404);
    const project=server.projects.get(decodeURIComponent(match[1])),tail=match[2];
    if(!project||project.owner!==server.user.id)return failure('NOT_FOUND','无权访问此项目',404);
    if(tail==='/lifecycle'&&method==='POST'){
      if(project.role!=='administrator')return failure('FORBIDDEN','仅管理员可调整项目状态',403);
      if(body.expectedVersion!==project.version||body.expectedLifecycleVersion!==(project.lifecycleVersion??0))return failure('VERSION_CONFLICT','项目状态已变化',409);
      const states={deactivate:'inactive',activate:'active',delete:'deleted',restore:project.hasArchivedReview||project.reviewState==='archived'?'inactive':'active'};
      const target=states[body.action];if(!target)return failure('INVALID_INPUT','状态操作无效',400);
      if(target===(project.lifecycle??'active'))return response({project:view(project),changed:false});
      if(!view(project).lifecycleActions?.includes(body.action))return failure('INVALID_STATE','该项目不能执行此操作',409);
      project.lifecycle=target;project.lifecycleVersion=(project.lifecycleVersion??0)+1;
      project.inactiveAt=target==='inactive'?'2026-11-21T09:20:00.000Z':null;project.deletedAt=target==='deleted'?'2026-11-21T09:20:00.000Z':null;
      return response({project:view(project),changed:true});
    }
    if(project.lifecycle==='deleted')return failure('NOT_FOUND','项目已删除',404);
    if(tail==='/reviews'&&method==='POST'){
      if(project.lifecycle==='inactive')return failure('PROJECT_INACTIVE','停用项目不能提交复核',409);
      if(project.role==='viewer')return failure('FORBIDDEN','只读成员不能提交复核',403);
      if(body.version!==project.version)return failure('VERSION_CONFLICT','版本冲突',409);
      project.reviewState='pending';project.review={id:`review-${project.id}`,version:project.version,status:'pending',content:{recommendation:'企业甲',rationale:'真实复核内容'}};
      return response({review:copy(project.review)});
    }
    if(tail.match(/^\/reviews\/[^/]+\/decision$/)&&method==='POST'){
      if(project.role!=='administrator')return failure('FORBIDDEN','仅管理员可复核',403);
      project.review.status=body.action==='confirm'?'confirmed':'returned';
      if(body.action==='confirm')project.hasArchivedReview=true;
      project.reviewState=project.hasArchivedReview?'archived':'returned';return response({review:copy(project.review)});
    }
    if(tail==='/members'&&method==='GET')return response({members:[{userId:server.user.id,email:server.user.email,name:server.user.name,role:project.role,canExport:project.canExport,joinedAt:project.createdAt}]});
    if(tail==='/members'&&method==='POST')return response({member:{...body,userId:'added-user',joinedAt:project.createdAt}});
    if(tail.startsWith('/members/')&&method==='PATCH')return response({member:{userId:decodeURIComponent(tail.slice(9)),...body}});
    if(tail.startsWith('/members/')&&method==='DELETE')return response({removed:true});
    if(tail==='/audit')return project.role==='administrator'?response({events:server.activities.filter(row=>row.projectId===project.id)}):failure('FORBIDDEN','仅管理员可访问',403);
    if(tail==='/export'&&method==='POST'){
      if(body.expectedVersion!==project.version)return failure('VERSION_CONFLICT','版本冲突',409);
      if(!project.canExport)return failure('FORBIDDEN','无导出权限',403);
      server.activities.unshift({id:'export-log',projectId:project.id,kind:'export',label:'导出评估',detail:body.format,timestamp:'2026-11-21T09:05:00.000Z',actor:copy(server.user)});
      return response({project:view(project),format:body.format});
    }
    if(tail===''&&method==='GET')return response({project:view(project)});
    if(tail===''&&method==='PUT'){
      if(body.version!==project.version)return failure('VERSION_CONFLICT','版本冲突',409);
      if(project.role==='viewer')return failure('FORBIDDEN','只读成员不能编辑',403);
      if(project.lifecycle==='inactive')return failure('PROJECT_INACTIVE','停用项目不能编辑',409);
      Object.assign(project,{data:copy(body.data),resultSummary:copy(body.resultSummary),preferences:copy(body.preferences),source:copy(body.data.source),version:project.version+1,updatedAt:'2026-11-21T09:10:00.000Z'});
      return response({project:view(project)});
    }
    if(tail===''&&method==='DELETE'){if(body?.version!==project.version)return failure('VERSION_CONFLICT','版本冲突',409);server.projects.delete(project.id);return response({removed:true});}
    return failure('NOT_FOUND','不存在',404);
  };
  return server;
}

test('bootstrap hydrates account-bound sync lists and loads full projects without changing local backup',async()=>{
  const {local,memory,data,result}=fixture(),saved=local.recordAnalysis({data,result}),original=memory.getItem(PROJECT_STORAGE_KEY),server=fakeServer();
  const remote=server.seed(saved.project),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  assert.deepEqual(client.listProjects(),[]);
  const state=await client.bootstrap();
  assert.equal(state.mode,'cloud');assert.equal(client.getSession().user.id,'account-a');
  assert.equal(client.listProjects()[0].id,remote.id);assert.equal(client.getProject(remote.id),null);
  const loaded=await client.loadProject(remote.id);
  assert.equal(loaded.version,1);assert.equal(loaded.role,'administrator');assert.deepEqual(loaded.data,saved.project.data);
  loaded.data.title='mutated clone';assert.notEqual(client.getProject(remote.id).data.title,'mutated clone');
  assert.equal(memory.getItem(PROJECT_STORAGE_KEY),original);
  assert.ok(server.requests.every(request=>request.init.credentials==='same-origin'&&request.init.cache==='no-store'));
});

test('account switching discards old list and full-record caches, with no cloud failure fallback',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),localProject=local.recordAnalysis({data,result}).project;
  const a=server.seed(localProject,'account-a'),b=server.seed({...localProject,data:{...localProject.data,title:'乙账户项目'}},'account-b');
  const client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  await client.bootstrap();await client.loadProject(a.id);
  server.user={id:'account-b',email:'b@example.test',name:'乙'};await client.bootstrap();
  assert.equal(client.getProject(a.id),null);assert.deepEqual(client.listProjects().map(project=>project.id),[b.id]);
  server.user=null;const anonymous=await client.bootstrap();
  assert.equal(anonymous.mode,'anonymous');assert.deepEqual(client.listProjects(),[]);assert.equal(client.getProject(b.id),null);
  await assert.rejects(client.recordAnalysis({data,result}),error=>error.status===401);
  assert.equal(local.listProjects().length,1);
});

test('unavailable service does not silently activate local mode; explicit missing-API fallback does',async()=>{
  const {local,data,result}=fixture();local.recordAnalysis({data,result});
  const closed=createCloudProjectStore({fetch:async()=>failure('UNAVAILABLE','数据库未配置',503),localStore:local});
  assert.equal((await closed.bootstrap()).mode,'unavailable');assert.deepEqual(closed.listProjects(),[]);
  const absent=createCloudProjectStore({fetch:async()=>failure('NOT_FOUND','不存在',404),localStore:local,allowLocalFallback:true});
  assert.equal((await absent.bootstrap()).mode,'local');assert.equal(absent.listProjects().length,1);
});

test('recordAnalysis reuses canonical local summary logic and saves only raw input plus summary',async()=>{
  const {local,memory,data,result}=fixture(),server=fakeServer(),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  await client.bootstrap();const saved=await client.recordAnalysis({data,result,mutationId:'explicit-mutation'});
  assert.equal(saved.persisted,true);assert.equal(saved.changed,true);assert.equal(saved.project.version,1);
  assert.equal(saved.project.resultSummary.supplierCount,5);assert.equal(saved.project.preferences.deltaMode,'auto');
  const body=server.requests.find(request=>request.method==='POST'&&request.path==='/projects').body;
  assert.equal(body.mutationId,'explicit-mutation');assert.equal('result'in body,false);assert.equal('scores'in body,false);
  assert.equal(memory.getItem(PROJECT_STORAGE_KEY),null);assert.equal(local.listProjects().length,0);
  assert.equal(client.listActivities()[0].kind,'import');
});

test('create network retries reuse mutationId and never duplicate an already committed project',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  await client.bootstrap();server.networkAfterCreate=true;
  let failed;
  await assert.rejects(client.recordAnalysis({data,result}),error=>{failed=error;return error.code==='NETWORK_ERROR'&&!!error.mutationId;});
  assert.equal(server.projects.size,1);
  const saved=await client.recordAnalysis({data,result});
  assert.equal(saved.mutationId,failed.mutationId);assert.equal(server.projects.size,1);assert.equal(client.listProjects().length,1);
});

test('caller version overrides refreshed cache and version conflicts never overwrite remote data',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  await client.bootstrap();const saved=await client.recordAnalysis({data,result});
  const actual=server.projects.get(saved.project.id);actual.version=2;actual.data.title='其他成员修改';
  await client.loadProject(actual.id);
  await assert.rejects(client.recordAnalysis({projectId:actual.id,expectedVersion:1,data:{...data,title:'我的未保存修改'},result}),error=>error instanceof CloudStoreError&&error.status===409&&error.code==='VERSION_CONFLICT'&&error.isConflict);
  const put=server.requests.findLast(request=>request.method==='PUT');assert.equal(put.body.version,1);
  assert.equal(actual.data.title,'其他成员修改');assert.match(client.storageStatus().warning,/其他成员/);
});

test('unchanged resume verifies the current version and does not create a synthetic update',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  await client.bootstrap();const saved=await client.recordAnalysis({data,result});
  const resumed=await client.recordAnalysis({projectId:saved.project.id,expectedVersion:1,data:saved.project.data,result,kind:'resume'});
  assert.equal(resumed.changed,false);assert.equal(server.requests.filter(request=>request.method==='PUT').length,0);
  server.projects.get(saved.project.id).version=2;
  await assert.rejects(client.recordAnalysis({projectId:saved.project.id,expectedVersion:1,data:saved.project.data,result,kind:'resume'}),error=>error.status===409);
});

test('migration requires explicit confirmation and preview, includes legacy activities, and is idempotent',async()=>{
  const {local,memory,data,result}=fixture(),legacy=local.recordAnalysis({data,result}),backup=memory.getItem(PROJECT_STORAGE_KEY),server=fakeServer(),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  await client.bootstrap();assert.equal(server.requests.some(request=>request.path==='/projects/migrate'),false);
  await assert.rejects(client.migrateLocalProjects({confirmed:true}),/预览/);
  const preview=client.previewLocalMigration();assert.equal(preview.count,1);assert.equal(preview.historyCount,1);assert.equal(preview.projects[0].historyCount,1);
  await assert.rejects(client.migrateLocalProjects({previewId:preview.previewId}),/明确确认/);
  const migrated=await client.migrateLocalProjects({confirmed:true,previewId:preview.previewId,ids:[legacy.project.id]});
  assert.equal(migrated.importedCount,1);assert.equal(migrated.skippedCount,0);
  const request=server.requests.find(request=>request.path==='/projects/migrate').body.projects[0];
  const event=local.listActivities()[0];assert.equal(request.activities[0].id,event.id);assert.equal(request.activities[0].timestamp,event.timestamp);assert.equal(request.activities[0].kind,event.kind);assert.equal('actor'in request.activities[0],false);
  assert.equal(client.listActivities()[0].source,'legacy');assert.equal(client.listActivities()[0].actor,null);
  const repeated=await client.migrateLocalProjects({confirmed:true,previewId:preview.previewId});
  assert.equal(repeated.importedCount,1);assert.equal(repeated.skippedCount,0);assert.equal(repeated.completedCount,1);assert.equal(server.projects.size,1);assert.equal(server.activities.length,1);
  assert.equal(repeated.historyImportedCount,1);
  assert.equal(server.requests.filter(request=>request.path==='/projects/migrate').length,1);
  assert.equal(client.previewLocalMigration().canMigrate,false);
  const reloaded=createCloudProjectStore({fetch:server.fetch,localStore:local});await reloaded.bootstrap();
  assert.equal(reloaded.previewLocalMigration().count,0);
  assert.equal(memory.getItem(PROJECT_STORAGE_KEY),backup);
});

test('local project changes invalidate migration preview instead of silently uploading unseen data',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  const legacy=local.recordAnalysis({data,result});await client.bootstrap();client.previewLocalMigration();
  local.recordAnalysis({projectId:legacy.project.id,data:{...data,title:'预览后修改'},result});
  await assert.rejects(client.migrateLocalProjects({confirmed:true}),error=>error.code==='MIGRATION_PREVIEW_CHANGED');
  assert.equal(server.requests.some(request=>request.path==='/projects/migrate'),false);
});

test('export authorization is independent of editor role and tied to displayed project version',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  await client.bootstrap();const saved=await client.recordAnalysis({data,result}),actual=server.projects.get(saved.project.id);
  actual.role='viewer';actual.canExport=true;await client.loadProject(actual.id);
  assert.equal(client.permissions(actual.id).canEdit,false);assert.equal(client.permissions(actual.id).canExport,true);
  const exported=await client.recordExport(actual.id,'scenarios_csv',1);assert.equal(exported.format,'scenarios_csv');
  actual.canExport=false;
  await assert.rejects(client.recordExport(actual.id,'csv',1),error=>error.status===403);
  actual.canExport=true;actual.version=2;
  await assert.rejects(client.recordExport(actual.id,'adapt',1),error=>error.status===409);
  const body=server.requests.findLast(request=>request.path.endsWith('/export')).body;assert.equal(body.expectedVersion,1);
});

test('review export forwards pdf/html/print and propagates permission failures before generation',async()=>{
  const {local,data,result}=fixture(),server=fakeServer();
  const original=local.recordAnalysis({data,result}).project,project=server.seed(original),calls=[];
  const review={id:'review-fixed',version:1,status:'confirmed',content:{recommendation:'已确认的推荐供应商',rationale:'保留本版依据'}};
  let allowed=true,generations=0;
  const client=createCloudProjectStore({localStore:local,fetch:async(url,init={})=>{
    if(url===`/api/projects/${project.id}/reviews/${review.id}/export`){
      calls.push({method:init.method,body:JSON.parse(init.body)});
      return allowed?response({review:copy(review)}):failure('FORBIDDEN','无导出权限',403);
    }
    return server.fetch(url,init);
  }});
  await client.bootstrap();
  const generate=async format=>{const fixed=await client.exportReview(project.id,review.id,format);generations++;return fixed;};
  for(const format of ['pdf','html','print'])assert.deepEqual(await generate(format),review);
  assert.equal(generations,3);assert.deepEqual(calls.map(call=>call.body),[{format:'pdf'},{format:'html'},{format:'print'}]);assert.ok(calls.every(call=>call.method==='POST'));
  await assert.rejects(generate('docx'),/报告导出格式/);assert.equal(calls.length,3);
  allowed=false;await assert.rejects(generate('pdf'),error=>error.status===403);assert.equal(generations,3);
  client.clearSession();await assert.rejects(generate('pdf'),error=>error.status===401);assert.equal(generations,3);assert.equal(calls.length,4);
});

test('member and audit wrappers preserve server roles and operation endpoints',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  await client.bootstrap();const saved=await client.recordAnalysis({data,result}),projectId=saved.project.id;
  assert.equal((await client.listMembers(projectId)).members[0].role,'administrator');
  const added=await client.saveMember(projectId,{email:'new@example.test',role:'viewer',canExport:true});assert.equal(added.member.canExport,true);
  const edited=await client.saveMember(projectId,{userId:'added-user',role:'evaluator',canExport:false});assert.equal(edited.member.role,'evaluator');
  assert.equal((await client.removeMember(projectId,{userId:'added-user'})).removed,true);
  assert.equal(Array.isArray((await client.readAudit(projectId)).events),true);
  const changed=server.requests.find(request=>request.method==='PATCH');assert.equal(changed.path,`/projects/${projectId}/members/added-user`);
  await client.readAudit(projectId,{limit:50,cursor:'opaque+/= &token'});
  const audit=server.requests.findLast(request=>request.path.endsWith('/audit'));
  assert.equal(new URLSearchParams(audit.query).get('cursor'),'opaque+/= &token');
  assert.equal(new URLSearchParams(audit.query).get('limit'),'50');
});

test('migration batches are bounded and a later failure can resume the original confirmation',async()=>{
  const {local,memory,data,result}=fixture();
  for(let index=0;index<52;index++)local.recordAnalysis({data:{...data,title:`采购评估 ${index+1}`},result});
  const backup=memory.getItem(PROJECT_STORAGE_KEY),server=fakeServer();let migrationCalls=0;
  const fetch=async(url,init)=>{
    if(url==='/api/projects/migrate'&&++migrationCalls===2)return failure('TEMPORARY_FAILURE','稍后重试',503);
    return server.fetch(url,init);
  };
  const client=createCloudProjectStore({fetch,localStore:local});await client.bootstrap();
  const preview=client.previewLocalMigration(),confirm={confirmed:true,previewId:preview.previewId};
  let partial;
  await assert.rejects(client.migrateLocalProjects(confirm),error=>{
    partial=error.partial;
    return error.status===503&&partial.completedCount===50&&partial.remainingIds.length===2&&partial.canRetry;
  });
  assert.equal(partial.importedCount,50);assert.equal(partial.historyImportedCount,50);
  assert.equal(client.listProjects().length,50);
  const completed=await client.migrateLocalProjects(confirm);
  assert.equal(completed.completedCount,52);assert.equal(completed.importedCount,52);assert.equal(completed.skippedCount,0);assert.equal(completed.historyImportedCount,52);assert.equal(completed.remainingIds.length,0);
  const requests=server.requests.filter(request=>request.path==='/projects/migrate');
  assert.deepEqual(requests.map(request=>request.body.projects.length),[50,2]);
  assert.ok(requests.every(request=>request.body.projects.length<=MIGRATION_MAX_PROJECTS&&new TextEncoder().encode(JSON.stringify(request.body)).byteLength<=MIGRATION_MAX_BYTES));
  assert.equal(client.previewLocalMigration().count,0);assert.equal(memory.getItem(PROJECT_STORAGE_KEY),backup);
});

test('UTF-8 payload size also splits a migration with fewer than 50 projects',async()=>{
  const {local,data,result}=fixture();
  const large='资料'.repeat(520_000);
  for(let index=0;index<2;index++)local.recordAnalysis({data:{...data,title:`大项目${index}`,notes:large},result});
  const server=fakeServer(),client=createCloudProjectStore({fetch:server.fetch,localStore:local});await client.bootstrap();
  const preview=client.previewLocalMigration();
  const outcome=await client.migrateLocalProjects({confirmed:true,previewId:preview.previewId});
  assert.equal(outcome.importedCount,2);
  const requests=server.requests.filter(request=>request.path==='/projects/migrate');
  assert.deepEqual(requests.map(request=>request.body.projects.length),[1,1]);
  assert.ok(requests.every(request=>new TextEncoder().encode(JSON.stringify(request.body)).byteLength<=MIGRATION_MAX_BYTES));
});

test('project removal uses a version precondition and retains the original local backup',async()=>{
  const {local,memory,data,result}=fixture(),legacy=local.recordAnalysis({data,result}).project,backup=memory.getItem(PROJECT_STORAGE_KEY),server=fakeServer(),remote=server.seed(legacy),client=createCloudProjectStore({fetch:server.fetch,localStore:local});
  await client.bootstrap();await client.loadProject(remote.id);
  server.projects.get(remote.id).version=2;
  await assert.rejects(client.removeProject(remote.id),error=>error.status===409);
  assert.equal(server.projects.has(remote.id),true);
  await client.loadProject(remote.id);
  assert.deepEqual(await client.removeProject(remote.id),{removed:true,persisted:true});
  assert.equal(client.getProject(remote.id),null);assert.equal(client.listProjects().length,0);
  assert.equal(memory.getItem(PROJECT_STORAGE_KEY),backup);
});

test('late full-project reads cannot repopulate another account cache',async()=>{
  const {local,data,result}=fixture(),legacy=local.recordAnalysis({data,result}).project,server=fakeServer(),a=server.seed(legacy),b=server.seed({...legacy,data:{...legacy.data,title:'乙项目'}},'account-b');
  let release;
  const client=createCloudProjectStore({localStore:local,fetch:(url,init)=>url===`/api/projects/${a.id}`?new Promise(resolve=>{release=()=>resolve(response({project:a}));}):server.fetch(url,init)});
  await client.bootstrap();const pending=client.loadProject(a.id);
  server.user={id:'account-b',email:'b@example.test',name:'乙'};await client.bootstrap();release();
  await assert.rejects(pending,error=>error.code==='STALE_CONTEXT');
  assert.deepEqual(client.listProjects().map(project=>project.id),[b.id]);assert.equal(client.getProject(a.id),null);
});

test('lifecycle-aware refresh uses all scope while default sync lists retain inactive projects',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),canonical=local.recordAnalysis({data,result}).project;
  const active=server.seed(canonical),inactive=server.seed(canonical),deleted=server.seed(canonical);
  for(const [projectId,lifecycle]of [[active.id,'active'],[inactive.id,'inactive'],[deleted.id,'deleted']])Object.assign(server.projects.get(projectId),{lifecycle,lifecycleVersion:2,reviewState:'unsubmitted'});
  const client=createCloudProjectStore({fetch:server.fetch,localStore:local});await client.bootstrap();
  assert.deepEqual(new Set(client.listProjects().map(project=>project.id)),new Set([active.id,inactive.id]));
  assert.equal(client.listProjects({lifecycle:'active'})[0].id,active.id);
  assert.equal(client.listProjects({lifecycle:'inactive'})[0].id,inactive.id);
  assert.equal(client.listProjects({lifecycle:'deleted'})[0].id,deleted.id);
  assert.equal(client.listProjects({lifecycle:'all'}).length,3);
  const loaded=await client.loadProject(inactive.id);
  assert.equal(loaded.lifecycle,'inactive');assert.equal(client.permissions(inactive.id).canEdit,false);assert.equal(client.permissions(inactive.id).canExport,true);
  await client.refresh();assert.equal(client.getProject(inactive.id).lifecycle,'inactive');
  assert.ok(server.requests.filter(request=>request.path==='/projects'&&request.method==='GET').every(request=>new URLSearchParams(request.query).get('lifecycle')==='all'));
  assert.throws(()=>client.listProjects({lifecycle:'bad'}),/状态筛选/);
});

test('lifecycle mutations preserve assessment version, use double CAS and reconcile cached full records',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),remote=server.seed(local.recordAnalysis({data,result}).project);
  Object.assign(server.projects.get(remote.id),{lifecycle:'active',lifecycleVersion:0,reviewState:'archived',hasArchivedReview:true});
  const draft=server.seed(local.getProject(local.listProjects()[0].id));Object.assign(server.projects.get(draft.id),{lifecycle:'active',lifecycleVersion:0,reviewState:'unsubmitted'});
  const client=createCloudProjectStore({fetch:server.fetch,localStore:local});await client.bootstrap();const initial=await client.loadProject(remote.id);
  const paused=await client.deactivateProject(remote.id,{expectedVersion:1,expectedLifecycleVersion:0});
  assert.equal(paused.changed,true);assert.equal(paused.project.lifecycle,'inactive');assert.equal(paused.project.version,1);assert.equal(paused.project.lifecycleVersion,1);
  assert.deepEqual(client.getProject(remote.id).data,initial.data);assert.equal(client.getProject(remote.id).lifecycle,'inactive');assert.equal(client.permissions(remote.id).canEdit,false);
  await assert.rejects(client.changeProjectLifecycle(remote.id,'activate',{expectedVersion:1,expectedLifecycleVersion:0}),error=>error.status===409);
  assert.equal(client.getProject(remote.id).lifecycle,'inactive');
  const resumed=await client.activateProject(remote.id);assert.equal(resumed.project.lifecycle,'active');assert.equal(resumed.project.lifecycleVersion,2);
  const removed=await client.removeProject(draft.id,1);assert.deepEqual(removed,{removed:true,persisted:true});assert.equal(client.getProject(draft.id),null);
  const trash=client.listProjects({lifecycle:'deleted'})[0];assert.equal(trash.id,draft.id);assert.equal(trash.version,1);assert.equal(trash.lifecycleVersion,1);assert.equal(client.permissions(draft.id).canRestore,true);
  const restored=await client.restoreProject(draft.id,{expectedVersion:1,expectedLifecycleVersion:1});assert.equal(restored.project.lifecycle,'active');assert.equal(restored.project.lifecycleVersion,2);
  assert.equal(client.listProjects({lifecycle:'deleted'}).length,0);assert.equal(client.listProjects().length,2);
  const last=server.requests.findLast(request=>request.path.endsWith('/lifecycle'));assert.deepEqual(last.body,{action:'restore',expectedVersion:1,expectedLifecycleVersion:1});
});

test('legacy deleted archived reviews restore to inactive without changing assessment data',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),remote=server.seed(local.recordAnalysis({data,result}).project);
  Object.assign(server.projects.get(remote.id),{lifecycle:'deleted',lifecycleVersion:3,reviewState:'archived',hasArchivedReview:true});
  const client=createCloudProjectStore({fetch:server.fetch,localStore:local});await client.bootstrap();
  const restored=await client.restoreProject(remote.id);assert.equal(restored.project.lifecycle,'inactive');assert.equal(restored.project.reviewState,'archived');
  const project=await client.loadProject(remote.id);assert.deepEqual(project.data.suppliers,data.suppliers);assert.equal(project.version,1);
  assert.equal(client.permissions(remote.id).canEdit,false);assert.equal(client.permissions(remote.id).canExport,true);
});

test('failed or forbidden lifecycle changes never optimistically rewrite the list or cached data',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),remote=server.seed(local.recordAnalysis({data,result}).project);
  Object.assign(server.projects.get(remote.id),{lifecycle:'active',lifecycleVersion:0,reviewState:'archived',role:'evaluator'});
  let unavailable=false;
  const client=createCloudProjectStore({localStore:local,fetch:(url,init)=>unavailable&&url.endsWith('/lifecycle')?failure('UNAVAILABLE','服务暂不可用',503):server.fetch(url,init)});
  await client.bootstrap();await client.loadProject(remote.id);
  assert.deepEqual(client.listProjects()[0].lifecycleActions,[]);
  await assert.rejects(client.deactivateProject(remote.id),error=>error.status===403);assert.equal(client.getProject(remote.id).lifecycle,'active');
  server.projects.get(remote.id).role='administrator';await client.refreshProjects();await client.loadProject(remote.id);unavailable=true;
  const before=client.getProject(remote.id);
  await assert.rejects(client.changeProjectLifecycle(remote.id,'delete'),error=>error.status===503);
  assert.deepEqual(client.getProject(remote.id),before);assert.equal(client.listProjects({lifecycle:'deleted'}).length,0);
});

test('a late full-project read cannot reactivate a successfully paused project',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),remote=server.seed(local.recordAnalysis({data,result}).project);
  Object.assign(server.projects.get(remote.id),{lifecycle:'active',lifecycleVersion:0,reviewState:'archived'});
  let pauseRead=false,release;
  const client=createCloudProjectStore({localStore:local,fetch:async(url,init)=>{
    if(pauseRead&&url===`/api/projects/${remote.id}`){pauseRead=false;const old=await server.fetch(url,init);return new Promise(resolve=>{release=()=>resolve(old);});}
    return server.fetch(url,init);
  }});
  await client.bootstrap();await client.loadProject(remote.id);pauseRead=true;
  const old=client.loadProject(remote.id);await new Promise(resolve=>setImmediate(resolve));
  await client.deactivateProject(remote.id);release();
  await assert.rejects(old,error=>error.code==='STALE_PROJECT');
  assert.equal(client.getProject(remote.id).lifecycle,'inactive');assert.equal(client.listProjects()[0].lifecycleVersion,1);
});

test('a late all-scope list response cannot resurrect a deleted project',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),remote=server.seed(local.recordAnalysis({data,result}).project);
  Object.assign(server.projects.get(remote.id),{lifecycle:'active',lifecycleVersion:0,reviewState:'unsubmitted'});
  let pauseList=false,release;
  const client=createCloudProjectStore({localStore:local,fetch:async(url,init)=>{
    if(pauseList&&url==='/api/projects?lifecycle=all'){pauseList=false;const old=await server.fetch(url,init);return new Promise(resolve=>{release=()=>resolve(old);});}
    return server.fetch(url,init);
  }});
  await client.bootstrap();pauseList=true;const old=client.refreshProjects();await new Promise(resolve=>setImmediate(resolve));
  await client.changeProjectLifecycle(remote.id,'delete');release();
  assert.deepEqual(await old,[]);assert.equal(client.listProjects().length,0);assert.equal(client.listProjects({lifecycle:'deleted'})[0].lifecycleVersion,1);
});

test('same-app review submission, return and confirmation immediately refresh authoritative row state',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),remote=server.seed(local.recordAnalysis({data,result}).project);
  Object.assign(server.projects.get(remote.id),{lifecycle:'active',lifecycleVersion:0,reviewState:'unsubmitted'});
  const client=createCloudProjectStore({fetch:server.fetch,localStore:local});await client.bootstrap();await client.loadProject(remote.id);
  const pending=await client.submitReview(remote.id,1);assert.equal(pending.status,'pending');assert.equal(client.listProjects()[0].reviewState,'pending');
  const returned=await client.decideReview(remote.id,pending.id,'return','补充依据');assert.equal(returned.status,'returned');assert.equal(client.listProjects()[0].reviewState,'returned');
  await client.submitReview(remote.id,1);const confirmed=await client.decideReview(remote.id,pending.id,'confirm','同意');
  assert.equal(confirmed.status,'confirmed');assert.equal(client.listProjects()[0].reviewState,'archived');assert.equal(client.getProject(remote.id).reviewState,'archived');assert.equal(client.listProjects()[0].version,1);
});

test('a successful review remains successful if the subsequent summary refresh fails',async()=>{
  const {local,data,result}=fixture(),server=fakeServer(),remote=server.seed(local.recordAnalysis({data,result}).project);
  Object.assign(server.projects.get(remote.id),{lifecycle:'active',lifecycleVersion:0,reviewState:'unsubmitted'});
  let failRefresh=false;
  const client=createCloudProjectStore({localStore:local,fetch:(url,init)=>failRefresh&&url==='/api/projects?lifecycle=all'?failure('UNAVAILABLE','列表暂不可用',503):server.fetch(url,init)});
  await client.bootstrap();failRefresh=true;
  const submitted=await client.submitReview(remote.id,1);assert.equal(submitted.status,'pending');assert.match(client.storageStatus().warning,/复核已保存/);
  failRefresh=false;await client.refreshProjects();assert.equal(client.listProjects()[0].reviewState,'pending');assert.equal(client.storageStatus().warning,'');
});

test('client lifecycle and same-app review state interoperate with the real SQLite-backed API',async()=>{
  const [{DatabaseSync},{readFile},{createApiHandler}]=await Promise.all([import('node:sqlite'),import('node:fs/promises'),import('../server/api.mjs')]);
  const migrations=new URL('../drizzle/',import.meta.url),journal=JSON.parse(await readFile(new URL('meta/_journal.json',migrations),'utf8'));
  const schema=(await Promise.all(journal.entries.map(({tag})=>readFile(new URL(`${tag}.sql`,migrations),'utf8')))).join('\n');
  const sqlite=new DatabaseSync(':memory:');sqlite.exec('PRAGMA foreign_keys=ON');sqlite.exec(schema);
  const db={prepare(sql){return {bindings:[],bind(...values){this.bindings=values;return this;},first(){return sqlite.prepare(sql).get(...this.bindings)??null;},all(){return {results:sqlite.prepare(sql).all(...this.bindings)};},run(){return {success:true,meta:{changes:Number(sqlite.prepare(sql).run(...this.bindings).changes)}};}};},batch(statements){sqlite.exec('BEGIN');try{const out=statements.map(statement=>statement.run());sqlite.exec('COMMIT');return out;}catch(error){sqlite.exec('ROLLBACK');throw error;}}};
  const actor={id:'integration-owner',email:'integration@example.test',name:'Integration owner'};
  const handler=createApiHandler({resolveIdentity:()=>actor}),{local,data,result}=fixture();
  const client=createCloudProjectStore({localStore:local,fetch:(url,init={})=>handler(new Request(`https://adapt.example.test${url}`,init),{DB:db})});
  try{
    await client.bootstrap();
    const input={...data,procurement:{decision:{recommendedId:data.suppliers[0].id,alternativeId:data.suppliers[1].id,rationale:'已核对本轮报价与交付条件。',followUps:''}}};
    const saved=await client.recordAnalysis({data:input,result});
    assert.equal(saved.project.lifecycle,'active');assert.equal(saved.project.lifecycleVersion,0);assert.deepEqual(saved.project.lifecycleActions,['delete']);
    const submitted=await client.submitReview(saved.project.id,1);assert.equal(client.listProjects()[0].reviewState,'pending');assert.deepEqual(client.listProjects()[0].lifecycleActions,[]);
    await client.decideReview(saved.project.id,submitted.id,'confirm','同意。');assert.equal(client.listProjects()[0].reviewState,'archived');assert.deepEqual(client.listProjects()[0].lifecycleActions,['deactivate']);
    const stopped=await client.deactivateProject(saved.project.id);assert.equal(stopped.project.lifecycle,'inactive');assert.equal(stopped.project.version,1);assert.equal(stopped.project.lifecycleVersion,1);
    await client.loadProject(saved.project.id);await client.refresh();assert.equal(client.listProjects()[0].lifecycle,'inactive');assert.equal(client.permissions(saved.project.id).canEdit,false);
    await client.activateProject(saved.project.id);assert.equal(client.listProjects()[0].lifecycleVersion,2);
    await assert.rejects(client.changeProjectLifecycle(saved.project.id,'delete'),error=>error.code==='PROJECT_ARCHIVED');
    const draft=await client.recordAnalysis({data:{...data,title:'可删除的草稿'},result});
    await client.removeProject(draft.project.id);assert.equal(client.listProjects({lifecycle:'deleted'})[0].id,draft.project.id);
    await client.restoreProject(draft.project.id);assert.equal(client.listProjects({lifecycle:'deleted'}).length,0);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_versions WHERE project_id=?').get(saved.project.id).n,1);
    assert.equal(sqlite.prepare('SELECT COUNT(*) n FROM project_reviews WHERE project_id=? AND status=?').get(saved.project.id,'confirmed').n,1);
  }finally{sqlite.close();}
});
