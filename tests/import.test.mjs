import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';
import { parseCSV, parseFile, datasetFromTable, TEMPLATE_CSV, toCSV, exportResults, downloadTemplate } from '../dist/import.mjs';

const table = (text) => { const [headers, ...rows] = parseCSV(text); return { headers, rows, filename: 'sample.csv' }; };
const bundledSheetJS = await readFile(new URL('../dist/vendor/xlsx.full.min.js',import.meta.url),'utf8');
const plain = value => JSON.parse(JSON.stringify(value));
function sheetJS() {
  const sandbox = { console, Buffer, Uint8Array, ArrayBuffer, TextEncoder, TextDecoder };
  runInNewContext(bundledSheetJS,sandbox,{filename:'bundled-xlsx.full.min.js',timeout:5000});
  return sandbox.XLSX;
}

test('CSV round-trips quoted commas, quotes, newlines, CRLF, BOM, and Chinese', () => {
  assert.deepEqual(parseCSV('\uFEFF供应商,价格,质量\r\n"A,有限公司",2,3\r\n"B ""Good""\n公司",4,5\r\n'), [
    ['供应商', '价格', '质量'], ['A,有限公司', '2', '3'], ['B "Good"\n公司', '4', '5'],
  ]);
  assert.deepEqual(parseCSV('Name\tCost\tQuality\rA\t1\t2\rB\t3\t4'), [['Name', 'Cost', 'Quality'], ['A', '1', '2'], ['B', '3', '4']]);
  assert.throws(() => parseCSV('A,B\n"unclosed,2'), /未闭合/);
  assert.throws(() => parseCSV('A,B\n"closed"bad,2'), /多余字符/);
});

test('dataset schema is generic and preferences default explicitly to equal TFNs', () => {
  const dataset = datasetFromTable(table('公司,采购成本,质量,交付\n A ,20,98,90\nB,30,99,97\nC,25,96,95'));
  assert.equal(dataset.suppliers.length, 3);
  assert.deepEqual(dataset.suppliers[0], { id: 'S1', name: 'A', values: [20, 98, 90] });
  assert.deepEqual(dataset.criteria.map(c => c.type), ['cost', 'benefit', 'benefit']);
  assert.deepEqual(dataset.criteria.map(c => [c.lower, c.modal, c.upper]), [[.7, 1, 1.3], [.7, 1, 1.3], [.7, 1, 1.3]]);
  assert.match(dataset.preferenceNote, /同等重要/);
});

test('mapping selects company and numeric columns without accepting invalid mappings', () => {
  const data = table('质量,公司,备注,成本\n98,A,one,20\n99,B,two,30');
  const dataset = datasetFromTable(data, { nameColumn: 1, valueColumns: [0, 3], criteria: [
    { type: 'benefit', lower: .1, modal: .2, upper: .3 }, { type: 'cost', lower: .2, modal: .4, upper: .5 },
  ] });
  assert.deepEqual(dataset.suppliers[1].values, [99, 30]);
  assert.equal(dataset.criteria[1].modal, .4);
  assert.throws(() => datasetFromTable(data, { nameColumn: 1, valueColumns: [0, 0] }), /配置无效/);
});

test('missing, negative, nonfinite, duplicate names and malformed records give locations', () => {
  for (const [csv, match] of [
    ['公司,成本,质量\nA,1,\nB,2,3', /第 2 行.*质量.*缺少数值/],
    ['公司,成本,质量\nA,0,2\nB,2,3', /第 2 行.*成本.*大于 0/],
    ['公司,成本,质量\nA,-1,2\nB,2,3', /大于 0/],
    ['公司,成本,质量\nA,1e309,2\nB,2,3', /有限/],
    ['公司,成本,质量\nA,NaN,2\nB,2,3', /纯数值/],
    ['公司,成本,质量\nA,1,2\na,2,3', /第 3 行.*重复/],
    ['公司,成本,质量\nA,1\nB,2,3', /第 2 行.*列数/],
    ['公司,成本,质量\nA,1,2\n\nB,2,3', /第 3 行.*列数/],
    ['公司,成本,质量\n,1,2\nB,2,3', /供应商名称不能为空/],
  ]) assert.throws(() => datasetFromTable(table(csv)), match);
});

test('enterprise template is empty and dimension limits are enforced', () => {
  assert.deepEqual(parseCSV(TEMPLATE_CSV), [['公司名称', '采购单价（元）', '合格率（%）', '准时交付率（%）', '技术能力', '财务状况', '服务响应']]);
  assert.throws(() => datasetFromTable(table(TEMPLATE_CSV)), /2–30/);
  const filledTemplate = TEMPLATE_CSV + '公司甲,120,98,95,8,9,8\r\n公司乙,135,99,97,9,8,9\r\n';
  const dataset = datasetFromTable(table(filledTemplate));
  assert.equal(dataset.suppliers.length, 2);
  assert.equal(dataset.criteria.length, 6);
  assert.equal(dataset.criteria[0].type, 'cost');
  assert.throws(() => datasetFromTable(table('公司,成本\nA,1\nB,2')), /2–10/);
  assert.throws(() => datasetFromTable(table('公司,成本,质量\nA,1,2')), /2–30/);
  assert.throws(() => datasetFromTable(table('公司,成本,成本\nA,1,2\nB,2,3')), /重复/);
});

test('file parser handles csv/tsv and rejects ambiguous encoding or formats', async () => {
  const file = { name: '供应商.csv', size: 30, text: async () => '公司,成本,质量\nA,1,2\nB,2,3' };
  const preview = await parseFile(file);
  assert.equal(preview.filename, '供应商.csv');
  assert.equal(preview.rows.length, 2);
  await assert.rejects(parseFile({ ...file, name: 'test.pdf' }), /请选择/);
  await assert.rejects(parseFile({ ...file, size: 6 * 1024 * 1024 }), /5 MB/);
  await assert.rejects(parseFile({ ...file, text: async () => '公司,成本\n\uFFFD,2' }), /UTF-8/);
});

test('XLSX branch uses raw numeric cells and rejects uncomputed formula input', async () => {
  const original = globalThis.XLSX;
  let formula = false;
  globalThis.XLSX = {
    read: () => ({ SheetNames: ['供应商数据'], Sheets: { 供应商数据: { A1: { v: '公司' }, B2: formula ? { f: '1+1', v: 2 } : { v: 2 } } } }),
    utils: { sheet_to_json: (_sheet, opts) => { assert.equal(opts.raw, true); return [['公司', '成本', '质量'], ['A', 1, .98], ['B', 2, .99]]; } },
  };
  try {
    const file = { name: 'test.xlsx', size: 10, arrayBuffer: async () => new ArrayBuffer(0) };
    const preview = await parseFile(file);
    assert.deepEqual(datasetFromTable(preview).suppliers[0].values, [1, .98]);
    formula = true;
    await assert.rejects(parseFile(file), /B2.*公式/);
  } finally { globalThis.XLSX = original; }
});

test('CSV output prevents spreadsheet formula injection while preserving numeric negatives', () => {
  const csv = toCSV([['=HYPERLINK("evil")', '+SUM(A1)', '-bad', '@evil', -0.01, 'normal,quoted']]);
  const [row] = parseCSV(csv);
  assert.equal(row[0], '\'=HYPERLINK("evil")');
  assert.equal(row[1], '\'+SUM(A1)');
  assert.equal(row[2], '\'-bad');
  assert.equal(row[3], '\'@evil');
  assert.equal(row[4], '-0.01');
  assert.equal(row[5], 'normal,quoted');
});

test('analysis export records settings, ranking, criterion configuration and pairs', () => {
  const dataset = datasetFromTable(table('公司,成本,质量\nA,1,2\nB,2,3'));
  const csv = exportResults({ p: .9, delta: .02, suppliers: [{ name: '=evil', baseline: .8, wsmRank: 1, rsi: .95 }], pairs: [{ a: 'S1', b: 'S2', status: 'unresolved', min: -.01, max: .03 }] }, dataset);
  assert.match(csv, /判断覆盖率（%）,90/);
  assert.match(csv, /重要程度下限/);
  assert.match(csv, /需确认偏好/);
  assert.match(csv, /'=evil/);
});

test('export keeps the fixed 5/95 score percentiles when interval coverage changes', () => {
  const dataset = datasetFromTable(table('公司,成本,质量\nA,1,2\nB,2,3'));
  const result = {
    p: .95, delta: .02,
    suppliers: [{ name: 'A', baseline: .8, wsmRank: 1, mean: .79, lo: .65, hi: .91, score5: .70, score95: .88, rsi: .95 }],
    pairs: [],
  };
  const rows = parseCSV(exportResults(result, dataset));
  const headerIndex = rows.findIndex(row => row[0] === '公司名称' && row.includes('评分下限（5%分位，百分制）'));
  assert.notEqual(headerIndex, -1);
  const headers = rows[headerIndex], values = rows[headerIndex + 1];
  assert.equal(values[headers.indexOf('评分下限（5%分位，百分制）')], '70');
  assert.equal(values[headers.indexOf('评分上限（95%分位，百分制）')], '88');
  assert.deepEqual(rows.find(row => row[0] === '判断覆盖率（%）'), ['判断覆盖率（%）', '95']);
});

test('bundled XLSX bytes open on a visible guide with an internal data link and unclipped header widths', () => {
  const original = globalThis.XLSX;
  const actual = sheetJS();
  let filename,bytes;
  globalThis.XLSX = { ...actual, writeFile: (workbook, name) => { filename = name; bytes = actual.write(workbook,{bookType:'xlsx',type:'array'}); } };
  try {
    downloadTemplate('xlsx');
    assert.equal(filename, 'ADAPT_企业数据模板.xlsx');
    assert.ok(bytes.byteLength>1000);
    assert.deepEqual(Array.from(new Uint8Array(bytes).slice(0,2)),[0x50,0x4b]);
    const reopened = actual.read(bytes,{type:'array',cellStyles:true,cellNF:true});
    assert.deepEqual(plain(reopened.SheetNames),['填写说明','供应商数据']);
    assert.equal(reopened.Workbook.Views?.[0]?.activeTab??0,0);
    assert.ok(reopened.Workbook.Sheets.every(sheet=>!sheet.Hidden));
    const guide=reopened.Sheets.填写说明,inputs=reopened.Sheets.供应商数据;
    assert.match(guide.A2.v,/A2/);
    assert.equal(guide.A3.l.Target,"#'供应商数据'!A2");
    assert.match(guide.A15.v,/示例.*不会导入/);
    assert.equal(guide.B17.v,120.5);assert.equal(guide.C17.v,98.6);assert.doesNotMatch(guide.C17.z,/%/);
    const instructions=actual.utils.sheet_to_json(guide,{header:1,raw:true}).flat().join(' ');
    for(const pattern of [/2–30/,/2–10/,/大于 0/,/公式/,/相同|一致/,/98\.6.*98\.6%/,/1–100/])assert.match(instructions,pattern);
    assert.ok(guide['!merges'].some(range=>range.s.r===0&&range.s.c===0&&range.e.c===6));
    assert.ok(inputs['!cols'].every(column=>column.wch>=18));
    assert.ok(inputs['!rows'][0].hpt>=25);
    assert.equal(inputs['!ref'],'A1:G1');assert.equal(inputs.A2,undefined);
    assert.deepEqual(plain(actual.utils.sheet_to_json(inputs,{header:1,raw:true})),parseCSV(TEMPLATE_CSV));
  } finally { globalThis.XLSX = original; }
});

test('a filled disposable XLSX imports its named data sheet even with the guide and sample first', async () => {
  const original=globalThis.XLSX,actual=sheetJS();
  globalThis.XLSX={...actual,writeFile:()=>{}};
  try {
    const workbook=downloadTemplate('xlsx');
    const rows=[['供应商甲',120.5,98.6,97.2,85,88,90],['供应商乙',135.8,99.1,98.4,92,87,91]];
    actual.utils.sheet_add_aoa(workbook.Sheets.供应商数据,rows,{origin:'A2'});
    const bytes=actual.write(workbook,{bookType:'xlsx',type:'array'});
    const file={name:'一次性填写验证.xlsx',size:bytes.byteLength,arrayBuffer:async()=>bytes};
    const parsed=await parseFile(file),dataset=datasetFromTable(parsed);
    assert.equal(parsed.sheetName,'供应商数据');assert.equal(parsed.rows.length,2);
    assert.deepEqual(plain(dataset.suppliers.map(supplier=>supplier.name)),['供应商甲','供应商乙']);
    assert.deepEqual(plain(dataset.suppliers[0].values),[120.5,98.6,97.2,85,88,90]);
    assert.equal(dataset.criteria[0].type,'cost');assert.equal(dataset.criteria.length,6);
    assert.equal(workbook.Sheets.填写说明.A17.v,'示例供应商（仅示范）');
    const disposable=actual.read(bytes,{type:'array'});
    disposable.Sheets.供应商数据.B2={t:'n',f:'1+1',v:2};
    const formulaBytes=actual.write(disposable,{bookType:'xlsx',type:'array'});
    await assert.rejects(parseFile({...file,size:formulaBytes.byteLength,arrayBuffer:async()=>formulaBytes}),/B2.*公式/);
  }finally{globalThis.XLSX=original;}
});

test('Chinese UI imports the English Suppliers sheet after Instructions without renaming external fields',async()=>{
  const original=globalThis.XLSX,actual=sheetJS();globalThis.XLSX=actual;
  try{
    const workbook=actual.utils.book_new();
    actual.utils.book_append_sheet(workbook,actual.utils.aoa_to_sheet([['Instructions'],['Example only']]),'Instructions');
    actual.utils.book_append_sheet(workbook,actual.utils.aoa_to_sheet([['Company name','Unit price (CNY)','Acceptance rate (%)'],['中文公司',120,98],['English Co.',130,99]]),'Suppliers');
    const bytes=actual.write(workbook,{bookType:'xlsx',type:'array'});
    const preview=await parseFile({name:'English.xlsx',size:bytes.byteLength,arrayBuffer:async()=>bytes});
    const dataset=datasetFromTable(preview);
    assert.equal(preview.sheetName,'Suppliers');
    assert.equal(dataset.criteria[0].name,'Unit price (CNY)');
    assert.equal(dataset.criteria[0].type,'cost');
    assert.deepEqual(plain(dataset.suppliers.map(item=>item.name)),['中文公司','English Co.']);
  }finally{globalThis.XLSX=original;}
});

test('business report converts score units and pair ranges consistently and names all decisions', () => {
  const dataset = datasetFromTable(table('公司,成本,质量\nA,1,2\nB,2,3'));
  const report = exportResults({ p: .95, delta: .02, suppliers: [{ name: 'A', baseline: .8, topsis: .7, vikor: .25, wsmRank: 1, rsi: .95 }], pairs: [
    { a: 'S1', b: 'S2', prob: .8, lo: -.01, hi: .03, min: -.02, max: .04, status: 'separable' },
    { a: 'S1', b: 'S2', status: 'equivalent' }, { a: 'S1', b: 'S2', status: '未解决' },
  ] }, dataset);
  const rows = parseCSV(report), supplierHeader = rows.findIndex(row => row[0] === '公司名称' && row.includes('综合评分（百分制）'));
  const heading = rows[supplierHeader], supplier = rows[supplierHeader + 1];
  assert.equal(supplier[heading.indexOf('综合评分（百分制）')], '80');
  assert.equal(supplier[heading.indexOf('理想匹配评分（百分制）')], '70');
  assert.equal(supplier[heading.indexOf('折中排序值（低优）')], '0.25');
  assert.deepEqual(rows.find(row => row[0] === '可接受评分差异（分）'), ['可接受评分差异（分）', '2']);
  const pairHeader = rows.findIndex(row => row[0] === '公司甲');
  assert.match(rows[pairHeader][3], /95%范围/);
  assert.deepEqual(rows[pairHeader + 1], ['A', 'B', '80', '-1', '3', '-2', '4', '优势明确']);
  assert.equal(rows[pairHeader + 2].at(-1), '差异可接受');
  assert.equal(rows[pairHeader + 3].at(-1), '需确认偏好');
  assert.ok(rows.findIndex(row => row[0] === '计算方法说明') > pairHeader + 3);
});
