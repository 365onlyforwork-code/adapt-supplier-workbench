import {t,translateSystemText} from './i18n.mjs';

const actions={
  delete:[t('删除项目','Delete project'),'trash-2'],
  restore:[t('恢复项目','Restore project'),'rotate-ccw'],
  deactivate:[t('移出活跃列表','Move out of active'),'archive'],
  activate:[t('恢复到活跃列表','Restore to active'),'rotate-ccw'],
  review:[t('前往复核','Open review'),'file-check-2'],
};

export function projectMenuActions(project){
  if(project.role!=='administrator')return [];
  if(project.lifecycle==='active'&&project.reviewState==='pending')return ['review'];
  return (project.lifecycleActions??[]).filter(action=>Object.hasOwn(actions,action));
}

export function mountProjectLifecycle({findProject,changeProject,openReview,focusList,refresh,icons,notify}){
  const menu=document.querySelector('#project-row-menu');
  const dialog=document.querySelector('#project-delete-dialog');
  const confirm=document.querySelector('#confirm-project-delete');
  const cancel=document.querySelector('#cancel-project-delete');
  const listError=document.querySelector('#project-lifecycle-error');
  const deleteError=document.querySelector('#project-delete-error');
  let open=null,pendingDelete=null,saving=false;

  function showError(element,message=''){
    element.textContent=message;
    element.classList.toggle('hidden',!message);
  }

  function closeMenu({focus=false}={}){
    if(!open)return;
    const {trigger}=open;
    open=null;
    trigger.setAttribute('aria-expanded','false');
    menu.classList.add('hidden');
    if(focus&&trigger.isConnected)trigger.focus({preventScroll:true});
  }

  function positionMenu(){
    if(!open)return;
    const anchor=open.trigger.getBoundingClientRect();
    const width=menu.offsetWidth,height=menu.offsetHeight;
    const gap=5,bottom=window.innerHeight-8;
    const left=Math.max(8,Math.min(anchor.right-width,document.documentElement.clientWidth-width-8));
    const top=Math.max(8,anchor.bottom+gap+height>bottom?anchor.top-height-gap:anchor.bottom+gap);
    menu.style.left=`${left}px`;
    menu.style.top=`${top}px`;
  }

  function showMenu(trigger,{last=false}={}){
    if(saving)return;
    if(open?.trigger===trigger){closeMenu({focus:true});return;}
    closeMenu();
    const project=findProject(trigger.dataset.projectMenu);
    if(!project)return;
    const available=projectMenuActions(project);
    if(!available.length)return;
    open={trigger,project};
    menu.innerHTML=available.map(action=>{
      const [label,icon]=actions[action];
      return `<button type="button" tabindex="-1" role="menuitem" data-project-lifecycle="${action}"><i data-lucide="${icon}" aria-hidden="true"></i>${label}</button>`;
    }).join('');
    showError(listError);
    trigger.setAttribute('aria-expanded','true');
    menu.classList.remove('hidden');
    icons();
    positionMenu();
    menu.children[last?menu.children.length-1:0]?.focus({preventScroll:true});
  }

  function selectDelete(project,trigger){
    pendingDelete={project,trigger};
    document.querySelector('#project-delete-title').textContent=t(`删除「${project.title}」？`,`Delete “${project.title}”?`);
    showError(deleteError);
    dialog.showModal();
  }

  async function apply(project,action,trigger){
    if(saving)return;
    const inDialog=action==='delete';
    saving=true;
    confirm.disabled=true;
    cancel.disabled=true;
    showError(inDialog?deleteError:listError);
    try{
      const updated=await changeProject(project,action);
      if(inDialog&&dialog.open)dialog.close();
      const feedback={delete:t('已移至最近删除','Moved to Recently deleted'),restore:updated.lifecycle==='inactive'?t('已恢复，可在「已移出」查看','Restored; available in Removed'):t('项目已恢复','Project restored'),deactivate:t('已移出活跃列表','Moved out of active'),activate:t('已恢复到活跃列表','Restored to active')};
      notify(feedback[action]);
      focusList();
    }catch(error){
      if(error.status===409||error.status===403||error.status===404)await refresh();
      showError(inDialog&&dialog.open?deleteError:listError,translateSystemText(error.message)||t('操作未完成，请重试。','The action could not be completed. Please try again.'));
      if(inDialog&&dialog.open){confirm.disabled=false;confirm.focus({preventScroll:true});}
      else if(trigger.isConnected)trigger.focus({preventScroll:true});
      else focusList();
    }finally{
      saving=false;
      confirm.disabled=false;
      cancel.disabled=false;
    }
  }

  document.addEventListener('click',event=>{
    const trigger=event.target.closest('[data-project-menu]');
    if(trigger){showMenu(trigger);return;}
    const item=event.target.closest('[data-project-lifecycle]');
    if(!item||!open)return;
    const {project,trigger:anchor}=open;
    const action=item.dataset.projectLifecycle;
    closeMenu();
    if(action==='delete')selectDelete(project,anchor);
    else if(action==='review')openReview(project.id);
    else void apply(project,action,anchor);
  });

  document.addEventListener('pointerdown',event=>{
    if(open&&!menu.contains(event.target)&&!open.trigger.contains(event.target))closeMenu();
  });
  document.addEventListener('focusin',event=>{
    if(open&&!menu.contains(event.target)&&!open.trigger.contains(event.target))closeMenu();
  });
  document.addEventListener('keydown',event=>{
    const trigger=event.target.closest('[data-project-menu]');
    if(trigger&&(event.key==='ArrowDown'||event.key==='ArrowUp')){
      event.preventDefault();
      showMenu(trigger,{last:event.key==='ArrowUp'});
    }
  });
  menu.addEventListener('keydown',event=>{
    if(!open)return;
    const focusIndex=[...menu.children].indexOf(document.activeElement);
    const last=menu.children.length-1;
    const index={ArrowUp:focusIndex<=0?last:focusIndex-1,ArrowDown:focusIndex===last?0:focusIndex+1,Home:0,End:last}[event.key];
    if(index!==undefined){
      event.preventDefault();
      menu.children[index]?.focus({preventScroll:true});
    }else if(event.key==='Escape'||event.key==='Tab'){
      if(event.key==='Escape'){event.preventDefault();event.stopPropagation();}
      closeMenu({focus:true});
    }
  });
  document.addEventListener('scroll',()=>closeMenu({focus:true}),true);
  window.addEventListener('resize',positionMenu);
  dialog.addEventListener('cancel',event=>{if(saving)event.preventDefault();});
  dialog.addEventListener('close',()=>{
    const trigger=pendingDelete?.trigger;
    pendingDelete=null;
    showError(deleteError);
    if(trigger?.isConnected)trigger.focus({preventScroll:true});
  });
  cancel.addEventListener('click',()=>dialog.close());
  confirm.addEventListener('click',()=>{
    if(pendingDelete)void apply(pendingDelete.project,'delete',pendingDelete.trigger);
  });

  return {closeMenu,clearError:()=>showError(listError)};
}
