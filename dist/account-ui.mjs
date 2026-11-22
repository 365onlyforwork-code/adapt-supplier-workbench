import {t,getLocale,translateSystemText} from './i18n.mjs';

const errorMessages={
  INVALID_CREDENTIALS:()=>t('用户名或密码不正确。','The username or password is incorrect.'),
  ACCOUNT_PENDING:()=>t('账号待审核，通过后即可登录。','Your account is awaiting approval.'),
  ACCOUNT_REJECTED:()=>t('此注册申请未获批准。','This registration was not approved.'),
  ACCOUNT_UNAVAILABLE:()=>t('用户名或邮箱已被使用。','This username or email is already in use.'),
  USERNAME_UNAVAILABLE:()=>t('用户名不可用。','This username is unavailable.'),
  INVALID_INPUT:()=>t('请检查填写内容后重试。','Check the form and try again.'),
  PASSWORD_CHANGE_REQUIRED:()=>t('请先设置新密码。','Set a new password to continue.'),
  PASSWORD_REUSE:()=>t('请设置与原密码不同的新密码。','Choose a password different from the current one.'),
  UNAUTHENTICATED:()=>t('登录已失效，请重新登录。','Your session has expired. Sign in again.'),
  FORBIDDEN:()=>t('仅系统管理员可审批注册申请。','Only a system administrator can review registrations.'),
  RATE_LIMITED:()=>t('尝试过于频繁，请稍后重试。','Too many attempts. Try again later.'),
  AUTH_UNAVAILABLE:()=>t('账户服务暂不可用，请稍后重试。','The account service is temporarily unavailable. Try again later.'),
  REGISTRATION_RESOLVED:()=>t('此申请已处理，请刷新列表。','This registration has already been reviewed. Refresh the list.'),
  NOT_FOUND:()=>t('未找到此注册申请。','This registration could not be found.'),
};

class AccountError extends Error{
  constructor(code,message,status=0){super(errorMessages[code]?.()||translateSystemText(message)||t('操作未完成，请重试。','The action could not be completed. Try again.'));this.code=code;this.status=status;}
}

function canonicalUser(value){
  if(!value||typeof value!=='object'||typeof value.id!=='string'||!value.id||!['admin','user'].includes(value.role)||typeof value.mustChangePassword!=='boolean')throw new AccountError('AUTH_UNAVAILABLE');
  return {id:value.id,username:String(value.username??''),name:String(value.name??''),email:String(value.email??''),role:value.role,mustChangePassword:value.mustChangePassword};
}

/** Passwords exist only in the active form/request, never in storage or getState(). */
export function mountAccountUI({root,onSignedIn,onSignedOut,onToggleLanguage}={}){
  if(!root?.ownerDocument)throw new TypeError('A valid account UI root is required.');
  const doc=root.ownerDocument;
  const el=(tag,attributes={},...children)=>{
    const node=doc.createElement(tag);
    for(const [key,value]of Object.entries(attributes)){
      if(value===undefined||value===null||value===false)continue;
      if(key==='class')node.className=value;
      else if(key==='value')node.value=value;
      else if(['hidden','disabled','required','noValidate'].includes(key))node[key]=!!value;
      else node.setAttribute(key,String(value));
    }
    for(const child of children.flat(Infinity))if(child!==undefined&&child!==null&&child!==false)node.append(child?.nodeType?child:doc.createTextNode(String(child)));
    return node;
  };
  const button=(label,action,attributes={})=>{
    const node=el('button',{type:'button',...attributes},label);node.addEventListener('click',action);return node;
  };
  const state={user:null,status:'checking'};
  const draft={username:'',name:'',email:''};
  let mode='login',busy=false,destroyed=false,startPromise=null,epoch=0,approvalsBusy=false,registrations=[];
  const gate=el('dialog',{id:'account-gate',class:'account-gate','aria-labelledby':'account-gate-title'});
  const approvals=el('dialog',{id:'account-approvals-dialog',class:'account-approvals','aria-labelledby':'account-approvals-title'});
  root.replaceChildren(gate,approvals);
  gate.addEventListener('cancel',event=>event.preventDefault());
  approvals.addEventListener('cancel',event=>{if(approvalsBusy)event.preventDefault();});
  const approvalTrigger=doc.querySelector('#account-approvals-button');
  if(approvalTrigger)approvalTrigger.textContent=t('注册审批','Registration approvals');

  const getState=()=>({user:state.user?{...state.user}:null,status:state.status,authenticated:!!state.user,ready:!!state.user&&!state.user.mustChangePassword,mustChangePassword:!!state.user?.mustChangePassword});
  async function request(path,{method='GET',body}={}){
    let response;
    try{response=await fetch(`/api/auth${path}`,{method,credentials:'same-origin',cache:'no-store',headers:{accept:'application/json',...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{})});}
    catch{throw new AccountError('AUTH_UNAVAILABLE');}
    let result;try{result=await response.json();}catch{throw new AccountError('AUTH_UNAVAILABLE','',response.status);}
    if(!response.ok)throw new AccountError(result.error?.code,result.error?.message,response.status);
    return result;
  }
  function openGate(){if(!gate.open&&!destroyed)gate.showModal();}
  function message(node,value='',error=false){
    node.textContent=value;node.hidden=!value;node.classList.toggle('is-error',error);node.setAttribute('role',error?'alert':'status');
  }
  function gateMessage(value,error=false){message(gate.querySelector('[data-account-message]'),value,error);}
  function setBusy(value,label){
    busy=value;gate.setAttribute('aria-busy',String(value));
    for(const control of gate.querySelectorAll('input,button'))control.disabled=value;
    const submit=gate.querySelector('[data-account-submit]');
    if(submit)submit.textContent=value?label:submit.dataset.idleLabel;
  }
  function field(form,key,label,{type='text',value='',autocomplete,maxLength,minLength,hint}={}){
    const id=`account-${form.dataset.accountForm}-${key}`,errorId=`${id}-error`,hintId=`${id}-hint`;
    const input=el('input',{id,name:key,type,value,required:true,autocomplete,maxlength:maxLength,minlength:minLength,'aria-describedby':`${hint?`${hintId} `:''}${errorId}`});
    const error=el('span',{id:errorId,class:'account-field-error',hidden:true});
    const wrap=el('div',{class:'account-field'},el('label',{for:id},label),input,hint?el('span',{id:hintId,class:'account-field-hint'},hint):null,error);
    form.append(wrap);
    if(['username','name','email'].includes(key))input.addEventListener('input',()=>{draft[key]=input.value;input.removeAttribute('aria-invalid');error.hidden=true;});
    else input.addEventListener('input',()=>{input.removeAttribute('aria-invalid');error.hidden=true;});
    return input;
  }
  function invalid(form,key,text){
    const input=form.elements.namedItem(key),node=doc.getElementById(`${input.id}-error`);
    input.setAttribute('aria-invalid','true');node.textContent=text;node.hidden=false;input.focus();return false;
  }
  function validate(form,type){
    for(const node of form.querySelectorAll('.account-field-error'))node.hidden=true;
    for(const input of form.querySelectorAll('input'))input.removeAttribute('aria-invalid');
    if(type!=='change-password'){
      const username=form.elements.namedItem('username').value.trim();
      if(!username)return invalid(form,'username',t('请输入用户名。','Enter your username.'));
      if(type==='register'&&!/^[A-Za-z0-9_.-]{3,40}$/.test(username))return invalid(form,'username',t('请使用 3–40 位英文、数字或 _ . -。','Use 3–40 letters, numbers, or _ . -.'));
    }
    if(type==='register'){
      const name=form.elements.namedItem('name').value.trim(),email=form.elements.namedItem('email').value.trim();
      if(!name||Array.from(name).length>100)return invalid(form,'name',t('请填写 1–100 字的姓名。','Enter a full name of 1–100 characters.'));
      if(email.length>254||!/^\S+@[^\s@]+\.[^\s@]+$/.test(email))return invalid(form,'email',t('请输入有效邮箱。','Enter a valid email address.'));
    }
    const password=form.elements.namedItem('password').value;
    if(!password)return invalid(form,'password',t('请输入密码。','Enter your password.'));
    if(type!=='login'&&(password.length<12||password.length>128||!password.trim()))return invalid(form,'password',t('请设置 12–128 位密码。','Use a password of 12–128 characters.'));
    if(type==='change-password'&&password!==form.elements.namedItem('confirmPassword').value)return invalid(form,'confirmPassword',t('两次输入的密码不一致。','The passwords do not match.'));
    return true;
  }

  function gateLayout(title,content){
    const mark=el('span',{class:'account-brand-mark'},el('img',{
      src:new URL('./brand/bentham-symbol.jpg',import.meta.url).href,width:80,height:80,alt:'',
    }));
    const identity=el('div',{class:'account-brand-identity'},
      el('span',{class:'account-brand-company'},t('贝翰战略咨询','Bentham Strategy Consulting')),
      el('strong',{class:'account-brand-wordmark'},'ADAPT'),
      el('span',{class:'account-brand-product'},t('采购评估工作台','Procurement Workbench')),
    );
    const workflows=[
      [t('数据导入','Data import'),t('Excel、CSV、TSV','Excel, CSV, and TSV')],
      [t('供应商对比','Supplier comparison'),t('评分、排名与权重影响','Scores, ranking, and weight sensitivity')],
      [t('复核归档','Review and archive'),t('锁定评估版本，导出 PDF','Lock versions and export review PDFs')],
    ];
    const overview=el('section',{class:'account-system-overview','aria-labelledby':'account-system-title'},
      el('h2',{id:'account-system-title'},
        t('看清每一项差异，','See every difference clearly, '),
        el('br'),
        t('做好每一次取舍。','weigh every trade-off.'),
      ),
      el('dl',{class:'account-overview-list'},workflows.map(([label,detail])=>
        el('div',{},el('dt',{},label),el('dd',{},detail)),
      )),
    );
    const language=typeof onToggleLanguage==='function'
      ?button(t('English','简体中文'),onToggleLanguage,{
        class:'account-language',lang:t('en','zh-CN'),'aria-label':t('切换为英文','Switch to Chinese'),'data-account-action':'language',
      })
      :null;
    const heading=el('header',{class:'account-auth-heading'},el('h1',{id:'account-gate-title'},title),language);
    return el('div',{class:'account-layout'},el('div',{class:'account-layout-content'},
      el('div',{class:'account-brand-pane'},el('div',{class:'account-brand-content'},
        el('div',{class:'account-brand'},mark,identity),overview,
      )),
      el('div',{class:'account-auth-pane'},el('div',{class:'account-auth-content'},heading,content)),
    ));
  }
  function formMode(next){if(busy)return;mode=next;renderGate();gate.querySelector('input')?.focus();}
  function renderGate(screen=state.status){
    const mustChange=!!state.user?.mustChangePassword;
    const title=mustChange?t('设置新密码','Set a new password'):mode==='register'?t('创建账户','Create an account'):t('登录','Sign in');
    const content=[];
    const notice=el('p',{class:'account-message',hidden:true,'data-account-message':'',tabindex:'-1'});
    if(screen==='checking')content.push(el('p',{class:'account-checking',role:'status'},t('正在检查登录状态…','Checking your session…')));
    else if(screen==='unavailable'){
      content.push(el('p',{class:'account-message is-error',role:'alert'},t('账户服务暂不可用，请重试。','The account service is unavailable. Please try again.')),button(t('重试','Retry'),()=>void start(),{class:'account-submit','data-account-action':'retry-session'}));
    }else if(screen==='registered'){
      content.push(el('div',{class:'account-registration-state'},el('span',{class:'account-status-pill'},t('待审核','Pending approval')),el('p',{},t('注册申请已提交，批准后即可登录。','Your registration was submitted. You can sign in after approval.'))),button(t('返回登录','Back to sign in'),()=>formMode('login'),{class:'account-submit','data-account-action':'show-login'}));
    }else{
      if(mustChange)content.push(el('p',{class:'account-intro'},t('首次登录，请为当前账户设置新密码。','Set a new password for your first sign-in.')));
      else{
        const tabs=el('div',{class:'account-tabs',role:'tablist','aria-label':t('账户操作','Account access')});
        for(const [key,label]of [['login',t('登录','Sign in')],['register',t('注册','Register')]])tabs.append(button(label,()=>formMode(key),{role:'tab','aria-selected':String(mode===key),tabindex:mode===key?'0':'-1','data-account-tab':key}));
        tabs.addEventListener('keydown',event=>{if(['ArrowLeft','ArrowRight','Home','End'].includes(event.key)){event.preventDefault();formMode(event.key==='Home'?'login':event.key==='End'?'register':mode==='login'?'register':'login');gate.querySelector(`[data-account-tab="${mode}"]`)?.focus();}});
        content.push(tabs);
      }
      const kind=mustChange?'change-password':mode,form=el('form',{class:'account-form',noValidate:true,'data-account-form':kind});
      if(!mustChange){
        field(form,'username',t('用户名','Username'),{value:draft.username,autocomplete:'username',maxLength:40,hint:kind==='register'?t('3–40 位英文、数字或 _ . -','3–40 letters, numbers, or _ . -'):null});
        if(kind==='register'){
          field(form,'name',t('姓名','Full name'),{value:draft.name,autocomplete:'name',maxLength:100});
          field(form,'email',t('邮箱','Email'),{type:'email',value:draft.email,autocomplete:'email',maxLength:254});
        }
      }
      field(form,'password',mustChange?t('新密码','New password'):t('密码','Password'),{type:'password',autocomplete:kind==='login'?'current-password':'new-password',maxLength:128,hint:kind==='login'?null:t('12–128 位','12–128 characters')});
      if(mustChange)field(form,'confirmPassword',t('确认新密码','Confirm new password'),{type:'password',autocomplete:'new-password',maxLength:128});
      const label=mustChange?t('保存并继续','Save and continue'):kind==='register'?t('提交注册','Submit registration'):t('登录','Sign in');
      form.append(notice,el('button',{type:'submit',class:'account-submit','data-account-submit':'','data-idle-label':label},label));
      form.addEventListener('submit',event=>{event.preventDefault();void submit(form,kind);});content.push(form);
      if(mustChange)content.push(button(t('退出登录','Sign out'),()=>void signOut().catch(()=>{}),{class:'account-secondary-action','data-account-action':'sign-out'}));
    }
    if(!content.some(node=>node===notice||node.contains?.(notice)))content.push(notice);
    gate.replaceChildren(gateLayout(title,content));openGate();
  }

  async function acceptUser(value,{notify=false}={}){
    state.user=canonicalUser(value);epoch++;
    state.status=state.user.mustChangePassword?'password-required':'ready';
    if(state.user.mustChangePassword){renderGate();return;}
    if(gate.open)gate.close();
    if(notify&&typeof onSignedIn==='function'){
      // Authentication has already succeeded; workspace initialization owns
      // its own errors and must not be reported as an invalid password.
      try{await onSignedIn({...state.user});}
      catch{doc.dispatchEvent(new CustomEvent('account:workspace-error'));}
    }
  }
  async function submit(form,kind){
    if(busy||destroyed||!validate(form,kind))return;
    const password=form.elements.namedItem('password').value;
    const payload=kind==='change-password'?{password}:{username:form.elements.namedItem('username').value.trim(),password};
    if(kind==='register'){payload.name=form.elements.namedItem('name').value.trim();payload.email=form.elements.namedItem('email').value.trim();}
    gateMessage();setBusy(true,kind==='register'?t('正在提交…','Submitting…'):kind==='change-password'?t('正在保存…','Saving…'):t('正在登录…','Signing in…'));
    let result;
    try{result=await request(kind==='change-password'?'/change-password':kind==='register'?'/register':'/login',{method:'POST',body:payload});}
    catch(error){
      setBusy(false);gateMessage(error.message,true);
      for(const input of form.querySelectorAll('input[type=password]'))input.value='';
      if(['ACCOUNT_PENDING','ACCOUNT_REJECTED','RATE_LIMITED'].includes(error.code))gate.querySelector('[data-account-message]')?.focus();
      else form.elements.namedItem('password').focus();
      return;
    }
    setBusy(false);
    for(const input of form.querySelectorAll('input[type=password]'))input.value='';
    if(kind==='register'){
      if(result.registration?.status!=='pending'){gateMessage(t('注册状态暂不可用，请重新登录确认。','Registration status is unavailable. Try signing in to check.'),true);return;}
      mode='login';renderGate('registered');gate.querySelector('[data-account-action="show-login"]')?.focus();
    }else{
      try{await acceptUser(result.user,{notify:true});}
      catch(error){state.user=null;state.status='unavailable';renderGate();}
    }
  }

  async function start(){
    if(startPromise)return startPromise;
    const task=async()=>{
      state.status='checking';renderGate();setBusy(true);
      try{
        const result=await request('/session');
        if(destroyed)return getState();
        if(result.user)await acceptUser(result.user);
        else{state.user=null;state.status='anonymous';renderGate();}
      }catch{state.user=null;state.status='unavailable';renderGate();}
      finally{setBusy(false);}
      return getState();
    };
    startPromise=task();try{return await startPromise;}finally{startPromise=null;}
  }

  async function signOut(){
    if(busy)throw new AccountError('BUSY',t('请等待当前操作完成。','Wait for the current operation to finish.'));
    if(gate.open)setBusy(true,t('正在退出…','Signing out…'));
    try{await request('/logout',{method:'POST',body:{}});}
    catch(error){if(gate.open){setBusy(false);gateMessage(error.message,true);}throw error;}
    state.user=null;state.status='anonymous';epoch++;registrations=[];
    if(approvals.open)approvals.close();mode='login';setBusy(false);renderGate();
    if(typeof onSignedOut==='function')await onSignedOut();
    return getState();
  }

  function registrationDate(value){
    const date=new Date(value);return Number.isFinite(date.getTime())?new Intl.DateTimeFormat(getLocale(),{dateStyle:'medium',timeStyle:'short',timeZone:'Asia/Shanghai'}).format(date):'—';
  }
  function approvalsMessage(value='',error=false){message(approvals.querySelector('[data-account-approvals-message]'),value,error);}
  function renderApprovals(){
    const close=button('×',()=>approvals.close(),{class:'account-close','aria-label':t('关闭注册审批','Close registration approvals'),disabled:approvalsBusy});
    const refresh=button(t('刷新','Refresh'),()=>void loadApprovals(),{class:'account-button secondary',disabled:approvalsBusy,'data-account-action':'refresh-approvals'});
    const pending=registrations.filter(row=>row.status==='pending');
    const messageNode=el('p',{class:'account-message',hidden:true,'data-account-approvals-message':'',tabindex:'-1'});
    const content=[el('header',{class:'account-approvals-heading'},el('div',{},el('h2',{id:'account-approvals-title'},t('注册审批','Registration approvals')),el('p',{},t('待审核申请','Pending registrations'))),refresh,close),messageNode];
    if(approvalsBusy&&!registrations.length)content.push(el('p',{class:'account-approval-empty',role:'status'},t('正在读取申请…','Loading registrations…')));
    else if(!pending.length)content.push(el('p',{class:'account-approval-empty'},t('暂无待审核申请。','No pending registrations.')));
    else{
      const head=el('thead',{},el('tr',{},...[t('申请人','Applicant'),t('用户名','Username'),t('邮箱','Email'),t('申请时间','Submitted'),t('操作','Actions')].map(label=>el('th',{scope:'col'},label))));
      const body=el('tbody');
      for(const row of pending){
        const actions=el('div',{class:'account-registration-actions'});
        for(const [action,label]of [['approve',t('批准','Approve')],['reject',t('拒绝','Reject')]])actions.append(button(label,()=>void decideRegistration(row,action),{class:`account-button ${action==='approve'?'primary':'reject'}`,disabled:approvalsBusy,'data-registration-action':action,'data-registration-id':row.id,'aria-label':t(`${label}${row.name}的申请`,`${label} registration for ${row.name}`)}));
        body.append(el('tr',{'data-registration-id':row.id},el('th',{scope:'row'},row.name),el('td',{},row.username),el('td',{},row.email),el('td',{class:'account-registration-time'},registrationDate(row.createdAt)),el('td',{},actions)));
      }
      content.push(el('div',{class:'account-registrations-scroll',role:'region','aria-label':t('待审核注册申请','Pending registration requests'),tabindex:'0'},el('table',{class:'account-registrations-table'},head,body)));
    }
    approvals.replaceChildren(...content);approvals.setAttribute('aria-busy',String(approvalsBusy));
  }
  async function loadApprovals(){
    if(approvalsBusy||destroyed)return;
    const identity=state.user?.id,requestEpoch=epoch;approvalsBusy=true;renderApprovals();
    try{
      const result=await request('/registrations?status=pending');
      if(destroyed||requestEpoch!==epoch||identity!==state.user?.id)return;
      if(!Array.isArray(result.registrations))throw new AccountError('AUTH_UNAVAILABLE');
      registrations=result.registrations.filter(row=>row&&typeof row.id==='string');
      approvalsBusy=false;renderApprovals();
    }catch(error){approvalsBusy=false;renderApprovals();approvalsMessage(error.message,true);}
    finally{approvalsBusy=false;}
  }
  async function decideRegistration(row,action){
    if(approvalsBusy||state.user?.role!=='admin'||!getState().ready)return;
    approvalsBusy=true;renderApprovals();
    try{
      const result=await request(`/registrations/${encodeURIComponent(row.id)}/${action}`,{method:'POST',body:{}});
      if(result.registration?.id!==row.id||result.registration.status!==(action==='approve'?'approved':'rejected'))throw new AccountError('AUTH_UNAVAILABLE');
      registrations=registrations.map(value=>value.id===row.id?result.registration:value);
      approvalsBusy=false;renderApprovals();approvalsMessage(action==='approve'?t(`已批准 ${row.name} 的申请。`,`Approved the registration for ${row.name}.`):t(`已拒绝 ${row.name} 的申请。`,`Rejected the registration for ${row.name}.`));
      approvals.querySelector('[data-account-approvals-message]')?.focus();
    }catch(error){
      approvalsBusy=false;renderApprovals();approvalsMessage(error.message,true);approvals.querySelector('[data-account-approvals-message]')?.focus();
    }finally{approvalsBusy=false;}
  }
  async function openApprovals(){
    if(!getState().ready||state.user.role!=='admin')throw new AccountError('FORBIDDEN');
    renderApprovals();if(!approvals.open)approvals.showModal();await loadApprovals();
  }

  return {start,openApprovals,signOut,getState,openSignIn(){if(!getState().ready){mode='login';renderGate();}return getState();},destroy(){destroyed=true;epoch++;if(gate.open)gate.close();if(approvals.open)approvals.close();root.replaceChildren();}};
}
