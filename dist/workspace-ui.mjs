import {t,getLocale,translateSystemText} from './i18n.mjs';

/** Server workspace UI. All reads and writes are injected; this module stores nothing. */

export const WORKSPACE_ROLES=Object.freeze({administrator:t('管理员','Administrator'),evaluator:t('评估员','Evaluator'),viewer:t('只读成员','Viewer')});
const exportFormats={adapt:t('评估文件','Assessment file'),csv:t('评估结果 CSV','Assessment results CSV'),print:t('打印评估报告','Print assessment report'),scenarios_csv:t('方案对比 CSV','Scenario comparison CSV')};
const list=value=>Array.isArray(value)?value:[];
const messageOf=error=>error instanceof Error?translateSystemText(error.message):String(translateSystemText(error?.message)||t('操作未完成，请重试。','The action could not be completed. Please try again.'));
const text=value=>typeof value==='string'?value.trim():'';
const projectKey=project=>String(project?.id||'');
let instanceCount=0;

function membersOf(value){return list(value?.members??value);}
function eventsOf(value){return list(value?.events??value);}
function userOf(session){return session?.user&&typeof session.user==='object'?session.user:null;}
function roleOf(state){return state.access?.role??state.project?.role??'';}
function canManage(state){return !!userOf(state.session)?.id&&roleOf(state)==='administrator'&&state.access?.canManageMembers!==false;}
function isLegacy(event){return event?.legacy===true||['browser','legacy'].includes(event?.source)||event?.metadata?.legacy===true||['browser','legacy'].includes(event?.metadata?.source)||typeof event?.kind==='string'&&event.kind.startsWith('legacy.');}
function historyCount(value){
  for(const key of ['historyCount','recordCount','activityCount'])if(Number.isInteger(value?.[key])&&value[key]>=0)return value[key];
  return Array.isArray(value?.activities)?value.activities.length:0;
}
function dateText(value){
  if(typeof value!=='string'||!value.trim())return '—';
  const date=new Date(value);
  if(!Number.isFinite(date.getTime()))return value;
  return new Intl.DateTimeFormat(getLocale(),{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hour12:false}).format(date);
}
function safeHref(value,base){
  if(typeof value!=='string'||!value.trim())return '';
  try{const url=new URL(value,base);return ['https:','http:'].includes(url.protocol)&&!url.username&&!url.password?url.href:'';}catch{return '';}
}

/**
 * mountWorkspace(container, options) -> {update(nextOptions),destroy()}
 *
 * Data: mode ('cloud'|'local'), session {user:{id,email,name}}, project
 * {id,title,role,canExport}, optional access {role,canExport,canManageMembers},
 * members array or {members}, audit array or {events}, migration preview
 * {projects:[{id,title,supplierCount,criterionCount,updatedAt,historyCount}],
 * count,historyCount,canMigrate,reason?,previewId?}, signInHref?, workspaceName?.
 *
 * Callbacks (all optional, async allowed):
 * onRefresh() -> options patch; onLoadMembers(projectId) -> {members};
 * onLoadAudit(projectId) -> {events}; onPreviewMigration() -> migration preview;
 * onSaveMember({userId?,email?,role,canExport}); onRemoveMember({userId});
 * onMigrate({confirmed:true,ids,previewId?}) -> server migration report;
 * onSignOut(). Write callbacks may return an options patch or call update().
 * Absent callbacks never produce simulated writes or fabricated records.
 */
export function mountWorkspace(container,options={}){
  if(!container?.ownerDocument)throw new TypeError(t('工作区面板需要有效的 DOM 容器。','A valid workspace container is required.'));
  const doc=container.ownerDocument,prefix=`workspace-${++instanceCount}`;
  let state={mode:'local',session:null,project:null,access:null,members:null,audit:null,migration:null,...options},destroyed=false;
  const ui={busy:new Set(),messages:new Map(),memberDrafts:new Map(),newMember:{email:'',role:'viewer',canExport:false},selectedMigration:null,confirmed:false,migrationReport:null};
  const el=(tag,attributes={},...children)=>{
    const node=doc.createElement(tag);
    for(const [key,value]of Object.entries(attributes)){
      if(value===null||value===undefined||value===false)continue;
      if(key==='class')node.className=value;
      else if(key==='value')node.value=value;
      else if(['checked','disabled','selected','required'].includes(key))node[key]=!!value;
      else node.setAttribute(key,String(value));
    }
    for(const child of children.flat(Infinity))if(child!==null&&child!==undefined&&child!==false)node.append(child?.nodeType?child:doc.createTextNode(String(child)));
    return node;
  };
  const badge=(label,tone='neutral')=>el('span',{class:`badge ${tone}`},label);
  const button=(label,handler,{primary=false,disabled=false,extraClass=''}={})=>{
    const node=el('button',{type:'button',class:`button ${primary?'primary':'secondary'} ${extraClass}`.trim(),disabled},label);
    node.addEventListener('click',handler);return node;
  };
  const empty=label=>el('p',{class:'ws-empty'},label);
  const appendMaybe=(node,...children)=>{for(const child of children)if(child!==null&&child!==undefined&&child!==false)node.append(child);};
  const section=(title,subtitle,...children)=>el('section',{class:'ws-card'},el('div',{class:'ws-card-heading'},el('div',{},el('h3',{},title),subtitle?el('p',{},subtitle):null)),...children);
  const scopeMessage=scope=>{
    const value=ui.messages.get(scope);
    return value?el('p',{class:`ws-message ${value.error?'ws-error':'ws-success'}`,role:value.error?'alert':'status'},value.text):null;
  };
  const disabled=scope=>ui.busy.has(scope);
  const preserveIdentity=()=>`${userOf(state.session)?.id||''}:${projectKey(state.project)}`;
  const applyPatch=patch=>{
    if(!patch||typeof patch!=='object'||Array.isArray(patch))return;
    for(const key of ['mode','session','project','access','members','audit','migration','legacyMigrationAvailable','signInHref','signOutHref','workspaceName'])if(Object.hasOwn(patch,key))state[key]=patch[key];
  };
  const run=async(scope,operation,{success='',after}={})=>{
    if(disabled(scope)||destroyed)return;
    const identity=preserveIdentity();ui.busy.add(scope);ui.messages.delete(scope);render();
    try{
      const result=await operation();
      if(destroyed||identity!==preserveIdentity())return;
      if(result===false)throw new Error(t('操作未完成，请重试。','The action could not be completed. Please try again.'));
      applyPatch(result);after?.(result);
      if(success)ui.messages.set(scope,{text:success,error:false});
    }catch(error){if(!destroyed&&identity===preserveIdentity())ui.messages.set(scope,{text:messageOf(error),error:true});}
    finally{ui.busy.delete(scope);if(!destroyed)render();}
  };
  const roleSelect=(value,{locked=false}={})=>{
    const node=el('select',{'aria-label':t('项目角色','Project role'),disabled:locked});
    for(const [id,label]of Object.entries(WORKSPACE_ROLES))node.append(el('option',{value:id,selected:id===value},label));
    return node;
  };
  const checkbox=(label,checked,{locked=false,onChange}={})=>{
    const input=el('input',{type:'checkbox',checked,disabled:locked});
    if(onChange)input.addEventListener('change',()=>onChange(input.checked));
    return {node:el('label',{class:'ws-checkbox'},input,el('span',{},label)),input};
  };

  function identitySection(){
    const user=userOf(state.session),signedIn=!!user?.id,name=text(user?.name)||text(user?.email)||t('已登录帐号','Signed-in account');
    const email=text(user?.email);
    const body=el('div',{class:'ws-identity-row'},el('span',{class:'ws-avatar','aria-hidden':'true'},signedIn?Array.from(name).slice(0,1).join(''):'A'),el('div',{class:'ws-identity-copy'},el('strong',{},signedIn?name:t('尚未登录','Not signed in')),signedIn&&email&&email!==name?el('span',{},email):null));
    const signOut=safeHref(state.signOutHref,doc.baseURI);
    if(signedIn&&signOut)body.append(el('a',{class:'button secondary ws-identity-action',href:signOut,target:'_top'},t('退出登录','Sign out')));
    else if(signedIn&&typeof state.onSignOut==='function')body.append(button(disabled('identity')?t('正在退出','Signing out'):t('退出登录','Sign out'),()=>run('identity',()=>state.onSignOut()),{disabled:disabled('identity'),extraClass:'ws-identity-action'}));
    const href=safeHref(state.signInHref,doc.baseURI);
    if(!signedIn&&href)body.append(el('a',{class:'button primary ws-identity-action',href,target:'_top'},t('登录工作区','Sign in')));
    const result=section(t('账户','Account'),'',body,scopeMessage('identity'));
    if(state.mode==='local')result.append(el('p',{class:'ws-footnote'},t('项目保存在当前浏览器。','Projects are stored in this browser.')));
    return result;
  }

  function accessSection(){
    const project=state.project;
    if(!project?.id)return section(t('项目权限','Project access'),'',empty(t('尚未选择项目。','No project selected.')));
    const role=roleOf(state),exportAllowed=state.access?.canExport??project.canExport;
    const facts=el('dl',{class:'ws-access-facts'},el('div',{},el('dt',{},t('当前项目','Current project')),el('dd',{},text(project.title)||text(project.data?.title)||t('评估项目','Assessment project'))),el('div',{},el('dt',{},t('我的角色','My role')),el('dd',{},WORKSPACE_ROLES[role]||t('权限待确认','Access not confirmed'))),el('div',{},el('dt',{},t('导出权限','Export access')),el('dd',{},exportAllowed===true?t('允许导出','Allow exports'):exportAllowed===false?t('不允许导出','Exports not allowed'):t('待确认','Not confirmed'))));
    return section(t('项目权限','Project access'),'',facts);
  }

  function memberRow(member,adminCount){
    const userId=String(member.userId||member.id||''),original={role:member.role,canExport:member.canExport===true};
    const draft=ui.memberDrafts.get(userId)||{...original};
    const lastAdmin=member.role==='administrator'&&adminCount<=1,busy=disabled('members');
    const name=text(member.name)||text(member.email)||t('项目成员','Project members'),email=text(member.email);
    const row=el('tr',{},el('td',{},el('strong',{},name),email&&email!==name?el('span',{class:'ws-secondary'},email):null));
    const roles=roleSelect(draft.role,{locked:busy||lastAdmin||typeof state.onSaveMember!=='function'});
    roles.setAttribute('aria-label',t(`${name}的项目角色`,`${name}: project role`));
    if(lastAdmin)roles.title=t('项目需保留至少一名管理员','At least one administrator must remain.');
    const exportBox=checkbox(t('允许','Allowed'),draft.canExport,{locked:busy||typeof state.onSaveMember!=='function'});
    exportBox.input.setAttribute('aria-label',t(`允许${name}导出`,`Allow ${name} to export`));
    const save=button(t('保存','Save'),()=>{
      run('members',()=>state.onSaveMember({userId,role:roles.value,canExport:exportBox.input.checked}),{success:t('成员权限已更新。','Member access updated.'),after:()=>ui.memberDrafts.delete(userId)});
    },{disabled:true});
    save.setAttribute('aria-label',t(`保存${name}的权限`,`Save access for ${name}`));
    const updateDraft=()=>{ui.memberDrafts.set(userId,{role:roles.value,canExport:exportBox.input.checked});const unchanged=roles.value===original.role&&exportBox.input.checked===original.canExport;save.disabled=busy||typeof state.onSaveMember!=='function'||unchanged;save.hidden=unchanged;save.classList.toggle('hidden',unchanged);};
    roles.addEventListener('change',updateDraft);exportBox.input.addEventListener('change',updateDraft);
    save.disabled=busy||typeof state.onSaveMember!=='function'||draft.role===original.role&&draft.canExport===original.canExport;
    save.hidden=draft.role===original.role&&draft.canExport===original.canExport;
    save.classList.toggle('hidden',save.hidden);
    row.append(el('td',{},roles),el('td',{},exportBox.node));
    const actions=el('td',{},el('div',{class:'ws-row-actions'},save));
    if(typeof state.onRemoveMember==='function'){
      const remove=button(t('移除','Remove'),()=>run('members',()=>state.onRemoveMember({userId}),{success:t('成员已移除。','Member removed.'),after:()=>ui.memberDrafts.delete(userId)}),{disabled:busy||lastAdmin,extraClass:'ws-remove'});
      remove.setAttribute('aria-label',t(`移除${name}`,`Remove ${name}`));
      if(lastAdmin)remove.title=t('项目需保留至少一名管理员','At least one administrator must remain.');actions.firstChild.append(remove);
    }
    row.append(actions);return row;
  }

  function addMemberForm(){
    if(typeof state.onSaveMember!=='function')return null;
    const busy=disabled('members'),draft=ui.newMember;
    const form=el('form',{class:'ws-add-member'}),email=el('input',{id:`${prefix}-member-email`,type:'email',value:draft.email,placeholder:t('已登录成员的邮箱','Email of a signed-in member'),required:true,disabled:busy,maxlength:254,autocomplete:'email'});
    email.addEventListener('input',()=>{ui.newMember.email=email.value;});
    const roles=roleSelect(draft.role,{locked:busy});roles.setAttribute('aria-label',t('新成员项目角色','New member role'));roles.addEventListener('change',()=>{ui.newMember.role=roles.value;});
    const exports=checkbox(t('允许导出','Allow exports'),draft.canExport,{locked:busy,onChange:value=>{ui.newMember.canExport=value;}});
    const submit=el('button',{type:'submit',class:'button primary',disabled:busy},busy?t('正在保存','Saving'):t('添加成员','Add member'));
    form.append(el('label',{class:'ws-email-field',for:`${prefix}-member-email`},el('span',{},t('成员邮箱','Member email')),email),el('label',{},el('span',{},t('项目角色','Project role')),roles),exports.node,submit);
    form.addEventListener('submit',event=>{
      event.preventDefault();if(busy||!form.reportValidity())return;
      const value={email:email.value.trim(),role:roles.value,canExport:exports.input.checked};
      run('members',()=>state.onSaveMember(value),{success:t('项目成员已添加。','Project member added.'),after:()=>{ui.newMember={email:'',role:'viewer',canExport:false};}});
    });
    return form;
  }

  function memberSection(){
    const result=section(t('项目成员','Project members'),'');result.classList.add('ws-wide');result.setAttribute('data-workspace-section','members');
    if(!state.project?.id){result.append(empty(t('尚未选择项目。','No project selected.')));return result;}
    if(!canManage(state)){result.append(empty(t('仅管理员可管理成员。','Only administrators can manage members.')));return result;}
    if(state.members===null){
      if(typeof state.onLoadMembers==='function')result.append(el('div',{class:'ws-section-actions'},button(disabled('members')?t('正在读取','Loading'):t('读取成员','Load members'),()=>run('members',()=>state.onLoadMembers(state.project.id),{after:response=>{state.members=response?.members??response;}}),{disabled:disabled('members')})));
      else result.append(empty(t('成员列表暂不可用。','The member list is unavailable.')));
    }else{
      const members=membersOf(state.members),adminCount=members.filter(m=>m.role==='administrator').length;
      if(members.length){
        const table=el('table',{class:'ws-members-table'},el('thead',{},el('tr',{},...[t('成员','Member'),t('项目角色','Project role'),t('导出权限','Export access'),t('操作','Action')].map(label=>el('th',{scope:'col'},label)))),el('tbody',{},...members.map(member=>memberRow(member,adminCount))));
        result.append(el('div',{class:'table-scroll'},table));
      }else result.append(empty(t('暂无成员。','No members yet.')));
    }
    appendMaybe(result,scopeMessage('members'),addMemberForm());return result;
  }

  function auditSection(){
    const result=section(t('操作记录','Activity log'),'');result.classList.add('ws-wide');result.setAttribute('data-workspace-section','audit');
    if(!state.project?.id){result.append(empty(t('尚未选择项目。','No project selected.')));return result;}
    if(!canManage(state)){result.append(empty(t('项目管理员可查看操作记录。','Project administrators can view the activity log.')));return result;}
    if(state.audit===null){
      if(typeof state.onLoadAudit==='function')result.append(el('div',{class:'ws-section-actions'},button(disabled('audit')?t('正在读取','Loading'):t('读取操作记录','Load activity'),()=>run('audit',()=>state.onLoadAudit(state.project.id),{after:response=>{state.audit=response;}}),{disabled:disabled('audit')})));
      else result.append(empty(t('操作记录暂不可用。','The activity log is unavailable.')));
    }else{
      const events=eventsOf(state.audit);
      if(!events.length)result.append(empty(t('暂无项目操作记录。','No project activity yet.')));
      else{
        const body=el('tbody');
        for(const event of events){
          const actor=event.actor&&typeof event.actor==='object'?text(event.actor.name)||text(event.actor.email):'',legacy=isLegacy(event),stamp=event.timestamp||event.time||event.createdAt||'';
          const actorLabel=legacy?t('未记录','Not recorded'):actor||translateSystemText(text(event.actorLabel))||t('未记录','Not recorded');
          const action=el('td',{},el('strong',{},translateSystemText(text(event.label))||t('项目操作','Project action')));
          if(legacy)action.append(el('span',{class:'ws-audit-badge'},badge(t('历史记录','Historical record'))));
          const format=event.metadata?.format;
          const detail=event.kind==='project.exported'&&Object.hasOwn(exportFormats,format)?exportFormats[format]:legacy?text(event.detail):translateSystemText(text(event.detail));
          body.append(el('tr',{},el('td',{class:'ws-time-cell'},el('time',{datetime:typeof stamp==='string'?stamp:'',title:typeof stamp==='string'?stamp:''},dateText(stamp))),el('td',{title:legacy?t('旧版浏览器记录，操作人未记录','Legacy browser record; actor not recorded'):text(event.actor?.email)||null},actorLabel),action,el('td',{class:'ws-audit-detail'},detail||'—')));
        }
        result.append(el('div',{class:'table-scroll ws-audit-scroll'},el('table',{class:'ws-audit-table'},el('thead',{},el('tr',{},...[t('时间','Time'),t('操作人','Actor'),t('操作','Action'),t('内容','Details')].map(label=>el('th',{scope:'col'},label)))),body)));
      }
      const cursor=state.audit?.nextCursor;
      if(cursor&&typeof state.onLoadAudit==='function'){
        const load=()=>run('audit',()=>state.onLoadAudit(state.project.id,cursor),{after:page=>{
          state.audit={events:[...events,...eventsOf(page)],nextCursor:page?.nextCursor};
        }});
        result.append(el('div',{class:'ws-section-actions'},button(disabled('audit')?t('正在读取','Loading'):t('加载更早记录','Load earlier activity'),load,{disabled:disabled('audit')})));
      }
    }
    appendMaybe(result,scopeMessage('audit'));return result;
  }

  function migrationSection(){
    const result=section(t('浏览器项目迁移','Migrate browser projects'),'');result.classList.add('ws-wide');result.setAttribute('data-workspace-section','migration');
    const preview=state.migration,user=userOf(state.session),busy=disabled('migration');
    if(!preview){
      if(typeof state.onPreviewMigration==='function')result.append(el('div',{class:'ws-section-actions'},button(busy?t('正在读取','Loading'):t('查看浏览器项目','View browser projects'),()=>run('migration',()=>state.onPreviewMigration(),{after:response=>{state.migration=response;ui.selectedMigration=null;ui.confirmed=false;ui.migrationReport=null;}}),{disabled:busy})));
      else result.append(empty(t('暂无可迁移项目。','No projects to migrate.')));
      appendMaybe(result,scopeMessage('migration'));return result;
    }
    const projects=list(preview.projects),migratable=projects.filter(p=>!p.alreadyImported&&!p.migrated),validIds=new Set(migratable.map(p=>String(p.id||p.localId||'')));
    if(ui.selectedMigration===null)ui.selectedMigration=new Set(validIds);
    ui.selectedMigration=new Set([...ui.selectedMigration].filter(id=>validIds.has(id)));
    const count=Number.isInteger(preview.count)?preview.count:projects.length;
    result.append(el('div',{class:'ws-migration-summary'},el('strong',{},t(`${count} 个项目`,`${count} projects`)),el('span',{},t(`${historyCount(preview)} 条原操作记录`,`${historyCount(preview)} original activity records`))));
    const confirmation=checkbox(t(`我确认迁移到${state.workspaceName?`“${state.workspaceName}”`:'当前帐号的服务器工作区'}`,`I confirm migration to ${state.workspaceName?`“${state.workspaceName}”`:'the server workspace for this account'}`),ui.confirmed,{locked:busy});
    const submit=button(busy?t('正在迁移','Migrating'):t('迁移所选项目','Migrate selected projects'),()=>{
      if(!ui.confirmed||!ui.selectedMigration.size||preview.canMigrate!==true||!user?.id)return;
      const payload={confirmed:true,ids:[...ui.selectedMigration]};if(preview.previewId)payload.previewId=preview.previewId;
      run('migration',()=>state.onMigrate(payload),{after:report=>{
        ui.migrationReport=report;ui.confirmed=false;
        const mappings=list(report?.mappings),completed=new Set(mappings.map(m=>String(m.localId||'')));
        if(completed.size){state.migration={...preview,projects:projects.map(p=>completed.has(String(p.id||p.localId||''))?{...p,alreadyImported:true}:p)};ui.selectedMigration=null;}
      }});
    },{primary:true,disabled:true});
    const updateSubmit=()=>{submit.disabled=busy||preview.canMigrate!==true||!user?.id||typeof state.onMigrate!=='function'||!ui.confirmed||!ui.selectedMigration.size;};
    confirmation.input.addEventListener('change',()=>{ui.confirmed=confirmation.input.checked;updateSubmit();});
    if(projects.length){
      const body=el('tbody');
      for(const project of projects){
        const id=String(project.id||project.localId||''),already=project.alreadyImported||project.migrated;
        const pick=el('input',{type:'checkbox',checked:ui.selectedMigration.has(id),disabled:busy||already,'aria-label':t(`迁移${text(project.title)||'浏览器项目'}`,`Migrate ${text(project.title)||'browser project'}`)});
        pick.addEventListener('change',()=>{if(pick.checked)ui.selectedMigration.add(id);else ui.selectedMigration.delete(id);ui.confirmed=false;confirmation.input.checked=false;updateSubmit();});
        body.append(el('tr',{},el('td',{},pick),el('td',{},el('strong',{},text(project.title)||t('未命名项目','Untitled project')),already?el('span',{class:'ws-secondary'},t('已迁移','Migrated')):null),el('td',{class:'numeric'},Number.isInteger(project.supplierCount)?t(`${project.supplierCount} 家`,`${project.supplierCount}`):'—'),el('td',{class:'numeric'},t(`${historyCount(project)} 条`,`${historyCount(project)}`)),el('td',{class:'ws-time-cell'},dateText(project.updatedAt))));
      }
      result.append(el('div',{class:'table-scroll'},el('table',{class:'ws-migration-table'},el('thead',{},el('tr',{},el('th',{scope:'col'},t('选择','Select')),...[t('浏览器项目','Browser project'),t('供应商','Suppliers'),t('原操作记录','Original activity'),t('原更新时间','Original update time')].map(label=>el('th',{scope:'col'},label)))),body)));
    }else result.append(empty(translateSystemText(preview.reason)||t('暂无可迁移项目。','No projects to migrate.')));
    if(projects.length&&preview.reason)result.append(el('p',{class:'ws-footnote'},translateSystemText(String(preview.reason))));
    if(projects.length&&preview.canMigrate===true&&user?.id){result.append(el('div',{class:'ws-migration-confirm'},confirmation.node,submit));}
    if(ui.migrationReport){
      const report=ui.migrationReport,parts=[];
      if(Number.isInteger(report.importedCount))parts.push(t(`已迁移 ${report.importedCount} 个项目`,`${report.importedCount} projects migrated`));
      if(Number.isInteger(report.skippedCount))parts.push(t(`已存在 ${report.skippedCount} 个项目`,`${report.skippedCount} projects already exist`));
      if(Number.isInteger(report.historyImportedCount))parts.push(t(`已迁移 ${report.historyImportedCount} 条历史记录`,`${report.historyImportedCount} historical records migrated`));
      if(parts.length)result.append(el('p',{class:'ws-message ws-success',role:'status'},parts.join(t('；','; '))));
    }
    appendMaybe(result,scopeMessage('migration'));updateSubmit();return result;
  }

  function render(){
    if(destroyed)return;
    const header=el('header',{class:'ws-heading'},el('div',{},el('h2',{},t('工作区设置','Workspace settings'))));
    if(typeof state.onRefresh==='function')header.append(button(disabled('refresh')?t('正在刷新','Refreshing'):t('刷新','Refresh'),()=>run('refresh',()=>state.onRefresh()),{disabled:disabled('refresh')}));
    const migration=state.legacyMigrationAvailable===false?null:migrationSection();
    const wrapper=el('div',{class:'ws-workspace'},header,scopeMessage('refresh'),el('div',{class:'ws-grid'},identitySection(),accessSection(),memberSection(),auditSection(),migration));
    container.replaceChildren(wrapper);
  }
  render();
  return {
    update(next={}){
      const before=preserveIdentity(),oldMigration=state.migration;
      state={...state,...next};
      if(before!==preserveIdentity()){
        ui.memberDrafts.clear();ui.newMember={email:'',role:'viewer',canExport:false};ui.messages.clear();ui.confirmed=false;ui.migrationReport=null;
      }
      if(Object.hasOwn(next,'migration')&&next.migration!==oldMigration){ui.selectedMigration=null;ui.confirmed=false;ui.migrationReport=null;}
      render();
    },
    destroy(){destroyed=true;container.replaceChildren();},
  };
}
