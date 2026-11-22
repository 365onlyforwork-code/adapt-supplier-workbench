import {scenarioScores} from '../dist/engine.mjs';
import {evaluateEligibility} from '../dist/eligibility.mjs';
import {normalizeScenarios} from '../dist/scenarios.mjs';
import {decisionSelectionErrors,normalizeDecision} from '../dist/decision-ui.mjs';

const centerWeights=criteria=>criteria.map(({lower,modal,upper})=>lower/3+modal/3+upper/3);

function comparisonEvidence(data,weights,scoresById,decision){
  if(!decision.alternativeId)return null;
  const recommended=data.suppliers.find(supplier=>supplier.id===decision.recommendedId);
  const alternative=data.suppliers.find(supplier=>supplier.id===decision.alternativeId);
  const recommendedScore=scoresById.get(recommended.id).score;
  const alternativeScore=scoresById.get(alternative.id).score;
  // Match the scoring engine: normalize against the full submitted cohort,
  // including suppliers excluded by procurement gates, rather than just this pair.
  const contributions=data.criteria.map((criterion,index)=>{
    const values=data.suppliers.map(supplier=>supplier.values[index]);
    const reference=criterion.type==='cost'?Math.min(...values):Math.max(...values);
    const recommendedValue=recommended.values[index],alternativeValue=alternative.values[index];
    const recommendedNormalized=criterion.type==='cost'?reference/recommendedValue:recommendedValue/reference;
    const alternativeNormalized=criterion.type==='cost'?reference/alternativeValue:alternativeValue/reference;
    return {
      index,criterion:criterion.name,type:criterion.type,weight:weights[index],
      recommendedValue,alternativeValue,recommendedNormalized,alternativeNormalized,
      contribution:weights[index]*(recommendedNormalized-alternativeNormalized),
    };
  }).sort((a,b)=>Math.abs(b.contribution)-Math.abs(a.contribution)||a.index-b.index)
    .map(({index,...row})=>row);
  // All values retain the engine's 0–1 score scale. Report views convert to points.
  return {recommendedScore,alternativeScore,scoreDifference:recommendedScore-alternativeScore,contributions};
}

export function prepareReview(version){
  const data=JSON.parse(version.data_json), summary=JSON.parse(version.summary_json);
  const decision=normalizeDecision(data.procurement?.decision,data.suppliers);
  if(!decision.recommendedId||!decision.rationale)return {error:'请先保存推荐供应商和选择依据，再提交复核。'};
  const eligibility=evaluateEligibility(data,data.procurement?.eligibility);
  const eligibilityById=new Map(eligibility.rows.map(row=>[row.id,row]));
  const issues=decisionSelectionErrors(decision,data.suppliers,new Map(eligibility.rows.map(row=>[row.id,{status:row.code}])));
  const [error]=Object.values(issues);
  if(error)return {error};

  const {weights,sorted,suppliers}=scenarioScores(data,centerWeights(data.criteria));
  const scoresById=new Map(suppliers.map(supplier=>[supplier.id,supplier]));
  const criterionNames=new Map(data.criteria.map(criterion=>[criterion.id,criterion.name]));
  const candidates=new Set(eligibility.candidateIds);
  const plans=normalizeScenarios(data,data.procurement?.scenarios).map(scenario=>{
    const result=scenarioScores(data,centerWeights(scenario.criteria));
    const recommended=result.suppliers.find(supplier=>supplier.id===decision.recommendedId);
    const leadingId=result.sorted.find(id=>candidates.has(id));
    return {name:scenario.name,leader:scoresById.get(leadingId)?.name??null,rank:recommended.rank,score:recommended.score};
  });

  return {content:{
    formatVersion:1,
    dataSource:typeof data.source?.filename==='string'?data.source.filename.slice(0,200):null,
    assessmentUpdatedAt:version.changed_at,
    recommendation:scoresById.get(decision.recommendedId).name,
    alternative:scoresById.get(decision.alternativeId)?.name??null,
    comparison:comparisonEvidence(data,weights,scoresById,decision),
    rationale:decision.rationale,
    followUps:decision.followUps,
    qualification:{
      configured:eligibility.configured,
      requireQualification:eligibility.configured&&eligibility.settings.requireQualification,
      rules:eligibility.configured?eligibility.settings.rules.map(rule=>({
        criterion:criterionNames.get(rule.criterionId),operator:rule.operator,threshold:rule.threshold,
      })):[],
    },
    criteria:data.criteria.map(({name,type},index)=>({name,type,weight:weights[index]})),
    suppliers:sorted.map(id=>{
      const {name,rank,score}=scoresById.get(id);
      const row=eligibilityById.get(id);
      return {
        name,rank,score,
        qualification:row.status,
        reasons:eligibility.configured?row.reasons:[],
        selection:id===decision.recommendedId?'推荐':id===decision.alternativeId?'备选':null,
      };
    }),
    plans,
    openComparisons:summary.unresolvedCount,
  }};
}
