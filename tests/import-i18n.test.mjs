import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

// Each Node test file has an isolated module graph. Exercise the same URL-based
// locale selection as a fresh browser load without changing persisted data.
globalThis.location={search:'?lang=en'};
const {getLocale}=await import('../dist/i18n.mjs');
const {parseCSV,parseFile,datasetFromTable,downloadTemplate,exportResults,TEMPLATE_CSV}=await import('../dist/import.mjs');
const {createScenario,normalizeScenarios,scenarioComparison,scenarioCSV}=await import('../dist/scenarios.mjs');
const {normalizeDecision,decisionRows,decisionSelectionErrors}=await import('../dist/decision-ui.mjs');
const bundledSheetJS=await readFile(new URL('../dist/vendor/xlsx.full.min.js',import.meta.url),'utf8');
const plain=value=>JSON.parse(JSON.stringify(value));
const table=text=>{const [headers,...rows]=parseCSV(text);return {headers,rows,filename:'采购数据.csv'};};
function sheetJS(){
  const sandbox={console,Buffer,Uint8Array,ArrayBuffer,TextEncoder,TextDecoder};
  runInNewContext(bundledSheetJS,sandbox,{timeout:5000});
  return sandbox.XLSX;
}
const DATA=datasetFromTable(table('Company,Unit price,Quality\n中文企业甲,120,98\nEnglish supplier,135,99'));

test('English CSV templates and validation preserve original names and canonical IDs',()=>{
  assert.equal(getLocale(),'en');
  const csv=downloadTemplate('csv'),headers=parseCSV(csv)[0];
  assert.deepEqual(headers,['Company name','Unit price (CNY)','Acceptance rate (%)','On-time delivery rate (%)','Technical capability','Financial standing','Service responsiveness']);
  assert.equal(parseCSV(csv).length,1);
  const filled=datasetFromTable(table(csv+'中文企业甲,120,98,95,80,90,85\r\nEnglish supplier,135,99,97,90,80,95\r\n'));
  assert.equal(filled.criteria[0].type,'cost');
  assert.deepEqual(filled.suppliers.map(item=>item.id),['S1','S2']);
  assert.deepEqual(filled.suppliers.map(item=>item.name),['中文企业甲','English supplier']);
  assert.equal(filled.source.filename,'采购数据.csv');
  assert.match(filled.preferenceNote,/equally important/);
  assert.equal(parseCSV(TEMPLATE_CSV)[0][0],'公司名称');
  assert.throws(()=>datasetFromTable(table('Company,采购单价,Quality\n中文企业甲,0,98\nB,135,99')),error=>error.row===2&&error.column===1&&/Row 2, “采购单价”:.*greater than 0/.test(error.message));
  assert.throws(()=>parseCSV('A,B\n"unclosed,1'),/Row 2: unclosed/);
});

test('English Excel instructions, empty data sheet and internal link survive a real XLSX round trip',async()=>{
  const original=globalThis.XLSX,actual=sheetJS();let filename;
  globalThis.XLSX={...actual,writeFile:(_workbook,name)=>{filename=name;}};
  try{
    const workbook=downloadTemplate('xlsx');
    assert.equal(filename,'ADAPT_Supplier_Template.xlsx');
    assert.deepEqual(plain(workbook.SheetNames),['Instructions','Suppliers']);
    assert.equal(workbook.Sheets.Instructions.A3.l.Target,"#'Suppliers'!A2");
    assert.equal(workbook.Sheets.Suppliers['!ref'],'A1:G1');
    assert.equal(workbook.Sheets.Suppliers.A2,undefined);
    assert.equal(workbook.Sheets.Instructions.C17.v,98.6);
    actual.utils.sheet_add_aoa(workbook.Sheets.Suppliers,[['中文企业甲',120,98,95,80,90,85],['English supplier',135,99,97,90,80,95]],{origin:'A2'});
    const bytes=actual.write(workbook,{bookType:'xlsx',type:'array'});
    const parsed=await parseFile({name:'英文模板.xlsx',size:bytes.byteLength,arrayBuffer:async()=>bytes});
    const dataset=datasetFromTable(parsed);
    assert.equal(parsed.sheetName,'Suppliers');
    assert.equal(dataset.criteria[0].type,'cost');
    assert.deepEqual(plain(dataset.suppliers[0]),{id:'S1',name:'中文企业甲',values:[120,98,95,80,90,85]});
    // The UI language must not prevent importing an earlier Chinese template.
    const chinese=actual.utils.book_new();
    actual.utils.book_append_sheet(chinese,actual.utils.aoa_to_sheet([['填写说明'],['不应导入']]),'填写说明');
    actual.utils.book_append_sheet(chinese,actual.utils.aoa_to_sheet([['公司','采购单价','合格率'],['中文企业甲',120,98],['B',135,99]]),'供应商数据');
    const chineseBytes=actual.write(chinese,{bookType:'xlsx',type:'array'});
    const parsedChinese=await parseFile({name:'中文模板.xlsx',size:chineseBytes.byteLength,arrayBuffer:async()=>chineseBytes});
    assert.equal(parsedChinese.sheetName,'供应商数据');
    assert.equal(datasetFromTable(parsedChinese).suppliers[0].name,'中文企业甲');
  }finally{globalThis.XLSX=original;}
});

test('English results use business labels and fixed percentile units without translating company data',()=>{
  const rows=parseCSV(exportResults({p:.95,delta:.02,suppliers:[{name:'中文企业甲',baseline:.8,wsmRank:1,score5:.7,score95:.88,lo:.6,hi:.9}],pairs:[{a:'S1',b:'S2',status:'未解决'}]},DATA));
  const headerIndex=rows.findIndex(row=>row[0]==='Company name'),headers=rows[headerIndex],values=rows[headerIndex+1];
  assert.equal(values[0],'中文企业甲');
  assert.equal(values[headers.indexOf('Overall score (out of 100)')],'80');
  assert.equal(values[headers.indexOf('Lower score (5th percentile, out of 100)')],'70');
  assert.equal(values[headers.indexOf('Upper score (95th percentile, out of 100)')],'88');
  assert.deepEqual(rows.find(row=>row[0]==='Assessment coverage (%)'),['Assessment coverage (%)','95']);
  assert.equal(rows.find(row=>row[0]==='中文企业甲'&&row[1]==='English supplier').at(-1),'Confirm priorities');
  assert.ok(rows.find(row=>row[0]==='Data source'&&row[1]==='采购数据.csv'));
});

test('English scenario and decision presentation leaves saved configurations and business text unchanged',()=>{
  const scenario=createScenario(DATA,'重视质量',[1,4]);
  assert.equal(normalizeScenarios(DATA,[scenario])[0].name,'重视质量');
  const result={suppliers:DATA.suppliers.map((supplier,index)=>({...supplier,baseline:.8-index*.1,wsmRank:index+1}))};
  const comparison=scenarioComparison(DATA,result,[{scenario,result}],{eligibleIds:['S1']});
  assert.equal(comparison.columns[0].id,'baseline');
  assert.equal(comparison.columns[0].name,'Current assessment');
  const rows=parseCSV(scenarioCSV(comparison));
  assert.deepEqual(rows[3],['Scenario name','Company name','Shortlist order','Original rank','Overall score (out of 100)','Order change from current assessment']);
  assert.equal(rows[5][0],'重视质量');
  assert.equal(rows[5][1],'中文企业甲');
  assert.throws(()=>createScenario(DATA,'方案',[1,0]),/Importance for “Quality” must be greater than zero/);
  const decision={recommendedId:'S1',alternativeId:'S2',rationale:'价格与交付均符合要求',followUps:'安排样品核验'};
  assert.deepEqual(normalizeDecision(decision,DATA.suppliers),decision);
  assert.deepEqual(decisionRows(decision,DATA.suppliers)[0],['Recommended supplier','中文企业甲']);
  assert.deepEqual(decisionRows(decision,DATA.suppliers)[2],['Rationale',decision.rationale]);
  assert.match(decisionSelectionErrors(decision,DATA.suppliers,{S1:{status:'pending'}}).recommendedId,/中文企业甲.*pending verification/);
});
