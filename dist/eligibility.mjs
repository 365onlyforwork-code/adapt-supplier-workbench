/**
 * Numeric hard gates and explicit manual qualification verification.
 * Rules use original raw metric values; the scoring engine is never modified.
 *
 * Settings:
 * {enabled:false, rules:[{id,criterionId,operator:'>='|'<=',threshold:number}],
 *  requireQualification:false,
 *  qualifications:{[supplierId]:'verified'|'failed'|'pending'}}
 *
 * An enabled manual qualification requirement is itself an eligibility rule.
 * Otherwise an empty rule list is unconfigured, and no supplier is called
 * eligible. candidateIds then retains all suppliers for ordinary analysis.
 */
const STATUSES=new Set(['verified','failed','pending']);
const finite=value=>typeof value==='number'&&Number.isFinite(value);
const own=(object,key)=>Object.prototype.hasOwnProperty.call(object,key);

function inspectData(data){
  if(!data||!Array.isArray(data.criteria)||!data.criteria.length||!Array.isArray(data.suppliers)||!data.suppliers.length) throw new Error('请先载入供应商与指标数据。');
  const criteria=new Map(),suppliers=new Map();
  for(const criterion of data.criteria){
    if(!criterion||typeof criterion.id!=='string'||!criterion.id||criteria.has(criterion.id)) throw new Error('指标标识必须非空且唯一。');
    criteria.set(criterion.id,criterion);
  }
  for(const supplier of data.suppliers){
    if(!supplier||typeof supplier.id!=='string'||!supplier.id||suppliers.has(supplier.id)) throw new Error('供应商标识必须非空且唯一。');
    if(!Array.isArray(supplier.values)||supplier.values.length!==data.criteria.length||supplier.values.some(value=>!finite(value)||value<=0)) throw new Error('准入检查需要完整且大于零的原始指标数据。');
    suppliers.set(supplier.id,supplier);
  }
  return {criteria,suppliers};
}

/**
 * Return canonical settings safe to persist locally or in an assessment file.
 * Unknown metric/supplier references are removed when restoring another dataset;
 * malformed known thresholds are rejected instead of being silently applied.
 * At most one hard gate per criterion prevents conflicting duplicate thresholds.
 * Object.fromEntries preserves own keys safely, including unusual supplier IDs.
 */
export function normalizeEligibility(data,settings={}){
  const {criteria,suppliers}=inspectData(data);
  if(settings===null||typeof settings!=='object'||Array.isArray(settings)) settings={};
  if(settings.rules!==undefined&&!Array.isArray(settings.rules)) throw new Error('准入规则应为列表。');
  const inputRules=settings.rules??[];
  if(inputRules.length>1000) throw new Error('准入规则过多，请按实际指标逐项设置。');
  const rules=[],seen=new Set();
  for(const rule of inputRules){
    if(!rule||typeof rule!=='object'||!criteria.has(rule.criterionId)) continue;
    const name=String(criteria.get(rule.criterionId).name??rule.criterionId);
    if(seen.has(rule.criterionId)) throw new Error(`${name} 只能设置一条准入规则。`);
    if(rule.operator!=='>='&&rule.operator!=='<=') throw new Error(`${name} 的比较方式应为“不低于”或“不高于”。`);
    if(!finite(rule.threshold)||rule.threshold<0) throw new Error(`${name} 的阈值必须是大于或等于零的有限数值。`);
    seen.add(rule.criterionId);
    rules.push({id:typeof rule.id==='string'&&rule.id.length>0&&rule.id.length<=120?rule.id:`gate-${rule.criterionId}`,criterionId:rule.criterionId,operator:rule.operator,threshold:rule.threshold});
  }
  const qualifications=settings.qualifications&&typeof settings.qualifications==='object'&&!Array.isArray(settings.qualifications)?settings.qualifications:{};
  const entries=[];
  for(const supplierId of suppliers.keys()){
    if(!own(qualifications,supplierId)) continue;
    const status=qualifications[supplierId];
    if(!STATUSES.has(status)) throw new Error(`${suppliers.get(supplierId).name??supplierId} 的资质核验状态无效。`);
    entries.push([supplierId,status]);
  }
  return {enabled:settings.enabled===true,rules,requireQualification:settings.requireQualification===true,qualifications:Object.fromEntries(entries)};
}

export function evaluateEligibility(data,settings={}){
  const canonical=normalizeEligibility(data,settings);
  const configured=canonical.enabled&&(canonical.rules.length>0||canonical.requireQualification);
  const criteria=new Map(data.criteria.map((criterion,index)=>[criterion.id,{...criterion,index}]));
  const rows=data.suppliers.map(supplier=>{
    if(!configured) return {id:supplier.id,name:String(supplier.name??supplier.id),status:'未配置',code:'unconfigured',eligible:null,checks:[],qualificationStatus:null,reasons:[canonical.enabled?'尚未设置准入规则。':'尚未启用准入规则。']};
    const checks=canonical.rules.map(rule=>{
      const criterion=criteria.get(rule.criterionId),actual=supplier.values[criterion.index];
      return {criterionId:rule.criterionId,name:String(criterion.name??criterion.id),operator:rule.operator,threshold:rule.threshold,actual,passed:rule.operator==='>='?actual>=rule.threshold:actual<=rule.threshold};
    });
    const qualificationStatus=canonical.requireQualification?(own(canonical.qualifications,supplier.id)?canonical.qualifications[supplier.id]:'pending'):null;
    const reasons=checks.filter(check=>!check.passed).map(check=>`${check.name}为 ${check.actual}，未满足${check.operator==='>='?'不低于':'不高于'} ${check.threshold}。`);
    if(qualificationStatus==='failed') reasons.push('人工核验确认资质不符合要求。');
    if(qualificationStatus==='pending') reasons.push('资质证明尚待人工核验。');
    const failed=checks.some(check=>!check.passed)||qualificationStatus==='failed';
    const pending=!failed&&qualificationStatus==='pending';
    return {id:supplier.id,name:String(supplier.name??supplier.id),status:failed?'不合格':pending?'待核验':'合格',code:failed?'ineligible':pending?'pending':'eligible',eligible:!failed&&!pending,checks,qualificationStatus,reasons};
  });
  const counts={unconfigured:0,eligible:0,ineligible:0,pending:0};
  for(const row of rows) counts[row.code]++;
  const eligibleIds=rows.filter(row=>row.code==='eligible').map(row=>row.id),pendingIds=rows.filter(row=>row.code==='pending').map(row=>row.id),excludedIds=rows.filter(row=>row.code==='ineligible').map(row=>row.id);
  return {configured,settings:canonical,rows,outcomes:rows,counts,eligibleIds,pendingIds,excludedIds,candidateIds:configured?eligibleIds:data.suppliers.map(supplier=>supplier.id)};
}
