/** Browser-only file import and export. No network requests or persistent storage. */
import {t,getLocale} from './i18n.mjs';
export const LIMITS = Object.freeze({ minSuppliers: 2, maxSuppliers: 30, minCriteria: 2, maxCriteria: 10, maxBytes: 5 * 1024 * 1024 });

export class ImportError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'ImportError'; Object.assign(this, details); }
}

const clean = value => String(value ?? '').trim();
const identity = value => clean(value).normalize('NFKC').toLocaleLowerCase();

function inferDelimiter(text) {
  let quoted = false, comma = 0, tab = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') { if (quoted && text[i + 1] === '"') i++; else quoted = !quoted; }
    else if (!quoted) {
      if (c === '\n' || c === '\r') break;
      if (c === ',') comma++;
      if (c === '\t') tab++;
    }
  }
  return tab > comma ? '\t' : ',';
}

/** Parse CSV/TSV, including quoted newlines, escaped quotes, BOM and CRLF. */
export function parseCSV(text, delimiter) {
  if (typeof text !== 'string') throw new ImportError(t("文件内容必须是文本。", "File contents must be text."));
  text = text.replace(/^\uFEFF/, '');
  if (!text.length) return [];
  delimiter ??= inferDelimiter(text);
  if (delimiter !== ',' && delimiter !== '\t') throw new ImportError(t("仅支持逗号或制表符分隔。", "Only comma and tab delimiters are supported."));
  const rows = [];
  let row = [], field = '', state = 'plain', line = 1;
  const cell = () => { row.push(clean(field)); field = ''; state = 'plain'; };
  const record = () => { cell(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (state === 'quoted') {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else state = 'closed';
      } else { field += c; if (c === '\n') line++; }
      continue;
    }
    if (c === delimiter) { cell(); continue; }
    if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      record(); line++; continue;
    }
    if (state === 'closed') {
      if (c === ' ' || c === '\t') continue;
      throw new ImportError(t(`第 ${line} 行：引号结束后存在多余字符。`, `Row ${line}: unexpected characters after a closing quote.`), { row: line });
    }
    if (c === '"') {
      if (field.trim().length) throw new ImportError(t(`第 ${line} 行：字段中的引号格式不正确。`, `Row ${line}: invalid quotation marks in a field.`), { row: line });
      field = ''; state = 'quoted';
    } else field += c;
  }
  if (state === 'quoted') throw new ImportError(t(`第 ${line} 行：引号未闭合。`, `Row ${line}: unclosed quotation mark.`), { row: line });
  // A terminal line separator ends a record; it does not add an empty supplier.
  if (row.length || field.length || state === 'closed' || !/[\r\n]$/.test(text)) record();
  return rows;
}

function asTable(matrix, filename, sheetName) {
  if (!matrix.length) throw new ImportError(t("文件为空，请先填写供应商数据。", "The file is empty. Enter supplier data first."));
  return { headers: matrix[0].map(clean), rows: matrix.slice(1).map(row => row.map(clean)), filename, ...(sheetName ? { sheetName } : {}) };
}

/** Returns a preview table. Domain validation happens when applying the table. */
export async function parseFile(file) {
  if (!file || typeof file.name !== 'string') throw new ImportError(t("请选择一个数据文件。", "Select a data file."));
  if (file.size > LIMITS.maxBytes) throw new ImportError(t("文件不能超过 5 MB。", "The file must not exceed 5 MB."));
  const extension = file.name.split('.').pop().toLowerCase();
  if (extension === 'csv' || extension === 'tsv') {
    const text = await file.text();
    if (text.includes('\uFFFD')) throw new ImportError(t("文件编码无法识别，请另存为 UTF-8 CSV 后重新导入。", "The file encoding is unsupported. Save as UTF-8 CSV and import again."));
    return asTable(parseCSV(text, extension === 'tsv' ? '\t' : undefined), file.name);
  }
  if (extension === 'xlsx') {
    const XLSX = globalThis.XLSX;
    if (!XLSX) throw new ImportError(t("Excel 读取组件未就绪，请改用 CSV，或刷新后重试。", "The Excel reader is unavailable. Use CSV or refresh and try again."));
    let workbook;
    try { workbook = XLSX.read(await file.arrayBuffer(), { type: 'array', cellFormula: true, cellDates: false }); }
    catch { throw new ImportError(t("无法读取 Excel 文件，请确认它是有效的 .xlsx 文件且未加密。", "Unable to read the Excel file. Use a valid, unencrypted .xlsx file.")); }
    const sheetName = ['供应商数据', '供应商', 'Suppliers'].find(name => workbook.SheetNames.includes(name)) ?? workbook.SheetNames[0];
    if (!sheetName) throw new ImportError(t("Excel 文件中没有工作表。", "The Excel file contains no worksheets."));
    const sheet = workbook.Sheets[sheetName];
    // Avoid expanding a sparsely formatted full-sheet range into millions of rows.
    if (sheet['!ref'] && XLSX.utils.decode_range) {
      const range = XLSX.utils.decode_range(sheet['!ref']);
      if (range.e.r - range.s.r + 1 > LIMITS.maxSuppliers + 1) throw new ImportError(t("Excel 数据表最多包含 30 家供应商。请删除多余数据行或超出数据区域的格式后重试。", "An Excel data sheet supports up to 30 suppliers. Remove extra rows or formatting outside the data range and try again."));
      if (range.e.c - range.s.c + 1 > 64) throw new ImportError(t("Excel 数据表列数过多，请仅保留供应商名称和需要评估的指标。", "The Excel data sheet has too many columns. Keep only supplier names and the criteria to assess."));
    }
    for (const [address, cell] of Object.entries(sheet)) {
      if (!address.startsWith('!') && cell && typeof cell === 'object' && cell.f) {
        throw new ImportError(t(`工作表「${sheetName}」的 ${address} 单元格含有公式。请粘贴为数值后重新导入。`, `Cell ${address} in sheet “${sheetName}” contains a formula. Paste values and import again.`), { sheetName, cell: address });
      }
    }
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, raw: true, defval: '', blankrows: true });
    return asTable(matrix, file.name, sheetName);
  }
  throw new ImportError(t("请选择 .csv、.tsv 或 .xlsx 文件。", "Select a .csv, .tsv or .xlsx file."));
}

function columnError(message, row, column, label) {
  return new ImportError(t(`第 ${row} 行，${label ? `「${label}」` : `第 ${column + 1} 列`}：${message}`, `Row ${row}, ${label ? `“${label}”` : `column ${column + 1}`}: ${message}`), { row, column, label });
}

/** Convert a preview to the common engine dataset, with explicit equal TFN defaults. */
export function datasetFromTable(table, mapping = {}) {
  if (!table || !Array.isArray(table.headers) || !Array.isArray(table.rows)) throw new ImportError(t("数据表结构不正确。", "Invalid table structure."));
  const headers = table.headers.map(clean);
  if (!headers.length) throw new ImportError(t("缺少表头。", "Column headers are missing."));
  const seenHeaders = new Set();
  headers.forEach((header, index) => {
    if (!header) throw columnError(t("表头不能为空。", "The column header is required."), 1, index);
    if (seenHeaders.has(identity(header))) throw columnError(t("指标名称重复，请使用不同的名称。", "Duplicate criterion name. Use a unique name."), 1, index, header);
    seenHeaders.add(identity(header));
  });
  const nameColumn = mapping.nameColumn ?? 0;
  const valueColumns = mapping.valueColumns ?? headers.map((_, index) => index).filter(index => index !== nameColumn);
  if (!Number.isInteger(nameColumn) || nameColumn < 0 || nameColumn >= headers.length) throw new ImportError(t("请选择有效的供应商名称列。", "Select a valid supplier name column."));
  if (!Array.isArray(valueColumns) || valueColumns.some(index => !Number.isInteger(index) || index < 0 || index >= headers.length || index === nameColumn) || new Set(valueColumns).size !== valueColumns.length) throw new ImportError(t("评价指标列配置无效，不能重复或包含供应商名称列。", "Invalid criterion columns. Columns must be unique and exclude the supplier name column."));
  if (valueColumns.length < LIMITS.minCriteria || valueColumns.length > LIMITS.maxCriteria) throw new ImportError(t("请选择 2–10 项评价指标。", "Select 2–10 assessment criteria."));
  if (table.rows.length < LIMITS.minSuppliers || table.rows.length > LIMITS.maxSuppliers) throw new ImportError(t("数据需要包含 2–30 家供应商。", "The data must contain 2–30 suppliers."));
  if (mapping.criteria && (!Array.isArray(mapping.criteria) || mapping.criteria.length !== valueColumns.length)) throw new ImportError(t("指标配置数量必须与所选数据列一致。", "Criterion settings must match the selected data columns."));
  const seenNames = new Set();
  const suppliers = table.rows.map((sourceRow, index) => {
    const row = index + 2;
    if (!Array.isArray(sourceRow) || sourceRow.length !== headers.length) throw new ImportError(t(`第 ${row} 行：列数应为 ${headers.length}，实际为 ${sourceRow?.length ?? 0}。请检查分隔符或缺失单元格。`, `Row ${row}: expected ${headers.length} columns, received ${sourceRow?.length ?? 0}. Check delimiters or missing cells.`), { row });
    const name = clean(sourceRow[nameColumn]);
    if (!name) throw columnError(t("供应商名称不能为空。", "The supplier name is required."), row, nameColumn, headers[nameColumn]);
    if (seenNames.has(identity(name))) throw columnError(t(`供应商「${name}」重复，请合并或使用不同名称。`, `Duplicate supplier “${name}”. Merge the rows or use a unique name.`), row, nameColumn, headers[nameColumn]);
    seenNames.add(identity(name));
    const values = valueColumns.map(column => {
      const text = clean(sourceRow[column]);
      if (!text) throw columnError(t("缺少数值，请补充后重新导入。", "A value is missing. Complete it and import again."), row, column, headers[column]);
      // Number('0x10') and Number('') are permissive; restrict to decimal notation.
      if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) throw columnError(t("请填写纯数值，不要包含单位、百分号或千位分隔符。", "Enter a number without units, percent signs or thousands separators."), row, column, headers[column]);
      const value = Number(text);
      if (!Number.isFinite(value)) throw columnError(t("数值必须有限。", "The value must be finite."), row, column, headers[column]);
      if (value <= 0) throw columnError(t("数值必须大于 0，请检查后重新填写。", "The value must be greater than 0."), row, column, headers[column]);
      return value;
    });
    return { id: `S${index + 1}`, name, values };
  });
  const criteria = valueColumns.map((column, index) => {
    const custom = mapping.criteria?.[index] ?? {};
    const name = clean(custom.name ?? headers[column]);
    if (!name) throw new ImportError(t(`第 ${index + 1} 项指标名称不能为空。`, `Criterion ${index + 1} requires a name.`));
    const type = custom.type ?? (/成本|单价|价格|cost|price/i.test(name) ? 'cost' : 'benefit');
    if (!['cost', 'benefit'].includes(type)) throw new ImportError(t(`指标「${name}」的方向必须是 cost 或 benefit。`, `The direction of “${name}” must be cost or benefit.`));
    const lower = custom.lower === undefined ? 0.7 : Number(custom.lower);
    const modal = custom.modal === undefined ? 1 : Number(custom.modal);
    const upper = custom.upper === undefined ? 1.3 : Number(custom.upper);
    if (![lower, modal, upper].every(Number.isFinite) || !(0 < lower && lower <= modal && modal <= upper)) throw new ImportError(t(`指标「${name}」的权重需要满足 0 < 下限 ≤ 中值 ≤ 上限。`, `Importance for “${name}” must satisfy 0 < lower ≤ typical ≤ upper.`));
    return { id: `C${index + 1}`, name, type, lower, modal, upper };
  });
  if (new Set(criteria.map(item => identity(item.name))).size !== criteria.length) throw new ImportError(t("指标名称不能重复。", "Criterion names must be unique."));
  return {
    suppliers, criteria,
    source: { kind: 'import', filename: table.filename ?? t("导入数据", "Imported data"), ...(table.sheetName ? { sheetName: table.sheetName } : {}) },
    preferenceNote: mapping.criteria ? t("已使用当前配置的指标方向与权重，请确认符合采购偏好。", "The configured criterion directions and importance settings are applied. Confirm they reflect your procurement priorities.") : t("各项指标默认同等重要；请在指标设置中确认评价方向，并根据采购需求调整重要程度和允许变化范围。", "Criteria are equally important by default. Confirm their directions and adjust importance and allowed ranges to your procurement needs."),
  };
}

const TEMPLATE_HEADERS = ['公司名称', '采购单价（元）', '合格率（%）', '准时交付率（%）', '技术能力', '财务状况', '服务响应'];
const templateHeaders = () => {
  const english = ['Company name', 'Unit price (CNY)', 'Acceptance rate (%)', 'On-time delivery rate (%)', 'Technical capability', 'Financial standing', 'Service responsiveness'];
  return TEMPLATE_HEADERS.map((header, index) => t(header, english[index]));
};

/** Escape spreadsheet formula prefixes as well as ordinary CSV syntax. */
export function csvCell(value) {
  let text = String(value ?? '');
  if (typeof value !== 'number' && /^[\s\u0000-\u001F]*[=+\-@]/.test(text)) text = `'${text}`;
  return /[",\r\n\t]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCSV(rows) { return '\uFEFF' + rows.map(row => row.map(csvCell).join(',')).join('\r\n') + '\r\n'; }
export const TEMPLATE_CSV = toCSV([TEMPLATE_HEADERS]);

function downloadBlob(content, filename, type) {
  if (typeof document === 'undefined') return;
  const blob = content instanceof Blob ? content : new Blob([content], { type });
  const url = URL.createObjectURL(blob), anchor = document.createElement('a');
  anchor.href = url; anchor.download = filename; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadTemplate(type = 'csv') {
  if (type === 'xlsx') {
    const XLSX = globalThis.XLSX;
    if (!XLSX) throw new ImportError(t("Excel 组件未就绪，请选择 CSV 模板。", "The Excel component is unavailable. Use the CSV template."));
    const workbook = XLSX.utils.book_new();
    const columns = (getLocale()==='en' ? [36, 24, 24, 30, 25, 24, 28] : [36, 22, 19, 23, 18, 18, 18]).map(wch => ({ wch }));
    const guide = XLSX.utils.aoa_to_sheet([
      [t("ADAPT 供应商数据填写指南", "ADAPT supplier data instructions")],
      [t("请到“供应商数据”工作表，从 A2 开始填写；每行一家供应商。", "Enter data in the Suppliers sheet starting at A2, with one supplier per row.")],
      [t("点击前往“供应商数据” A2", "Go to Suppliers!A2")],
      [],
      [t("填写规则", "Entry rules")],
      [t("公司名称", "Company name"), t("填写完整且唯一的公司名称，不要重复。", "Enter the full company name. Each name must be unique.")],
      [t("行数与指标", "Rows and criteria"), t("填写 2–30 家供应商、2–10 项数值指标。", "Enter 2–30 suppliers and 2–10 numeric criteria.")],
      [t("数值与公式", "Values and formulas"), t("各项数值须大于 0，不留空。公式请先粘贴为数值。", "Every value must be greater than 0. Leave no blanks. Paste formulas as values.")],
      [t("采购单价", "Unit price"), t("同一列使用一致的计价口径与单位，如元／件。", "Use a consistent pricing basis and unit within each column, such as CNY per item.")],
      [t("百分比", "Percentages"), t("输入 98.6 表示 98.6%；使用普通数值格式，不带百分号。", "Enter 98.6 for 98.6%. Use number format without a percent sign.")],
      [t("定性评分", "Qualitative scores"), t("技术能力、财务状况、服务响应建议统一采用 1–100 分。", "Use a consistent 1–100 scale for technical capability, financial standing and service responsiveness.")],
      [t("指标列", "Criterion columns"), t("可改名或增减指标列；同一列采用相同单位与评分标准。", "Rename, add or remove criterion columns as needed. Use consistent units and scoring standards within each column.")],
      [t("导入前", "Before importing"), t("保留“供应商数据”页名。保存文件后导入工作台，确认评价方向与重要程度。", "Keep the Suppliers sheet name. Save and import the file, then confirm criterion directions and importance.")],
      [],
      [t("填写示例（仅供理解，位于说明页，不会导入）", "Example only — kept in Instructions and excluded from imports")],
      [...templateHeaders()],
      [t("示例供应商（仅示范）", "Example supplier (illustrative only)"), 120.5, 98.6, 97.2, 85, 88, 90],
      [t("实际资料请填入“供应商数据”页；不要把说明文字填入数据表。", "Enter actual data in Suppliers. Keep instructions out of the data sheet.")],
    ]);
    guide['!cols'] = columns.map(column => ({ ...column }));
    guide['!rows'] = [30, 27, 25, 10, 25, 27, 27, 27, 27, 27, 27, 27, 27, 10, 26, 28, 27, 27].map(hpt => ({ hpt }));
    guide['!merges'] = [0, 1, 2, 4, 14, 17].map(r => ({ s: { r, c: 0 }, e: { r, c: 6 } }));
    for (let r = 5; r <= 12; r++) guide['!merges'].push({ s: { r, c: 1 }, e: { r, c: 6 } });
    guide.A3.l = { Target: `#'${t('供应商数据', 'Suppliers')}'!A2`, Tooltip: t("前往供应商数据，从 A2 开始填写", "Go to Suppliers and start at A2") };
    guide.B17.z = '0.00';
    guide.C17.z = guide.D17.z = '0.0';
    const inputs = XLSX.utils.aoa_to_sheet([[...templateHeaders()]]);
    inputs['!cols'] = columns.map(column => ({ ...column }));
    inputs['!rows'] = [{ hpt: 28 }];
    XLSX.utils.book_append_sheet(workbook, guide, t("填写说明", "Instructions"));
    XLSX.utils.book_append_sheet(workbook, inputs, t("供应商数据", "Suppliers"));
    workbook.Workbook ??= {};
    workbook.Workbook.Views = [{ activeTab: 0, firstSheet: 0 }];
    XLSX.writeFile(workbook, t("ADAPT_企业数据模板.xlsx", "ADAPT_Supplier_Template.xlsx"));
    return workbook;
  }
  if (type !== 'csv') throw new ImportError(t("模板格式仅支持 csv 或 xlsx。", "Template formats are csv or xlsx only."));
  const csv = toCSV([templateHeaders()]);
  downloadBlob(csv, t("ADAPT_企业数据模板.csv", "ADAPT_Supplier_Template.csv"), 'text/csv;charset=utf-8');
  return csv;
}

/** Download machine-readable ranking rows with the analysis settings recorded. */
export function exportResults(result, dataset, additionalRows = []) {
  if (!result || !Array.isArray(result.suppliers) || !dataset?.criteria) throw new ImportError(t("分析完成后才可以导出结果。", "Complete the analysis before exporting results."));
  const statuses = { separable: t("优势明确", "Clear advantage"), equivalent: t("差异可接受", "Acceptable difference"), unresolved: t("需确认偏好", "Confirm priorities"), 可分: t("优势明确", "Clear advantage"), 可区分: t("优势明确", "Clear advantage"), 等效: t("差异可接受", "Acceptable difference"), 未解决: t("需确认偏好", "Confirm priorities") };
  const percent = value => typeof value === 'number' && Number.isFinite(value) ? value * 100 : '';
  const rows = [
    [t("ADAPT 供应商评估报告", "ADAPT supplier assessment report")],
    [t("数据来源", "Data source"), dataset.source?.filename ?? dataset.name ?? t("当前评估", "Current assessment")],
    [t("导出时间", "Exported at"), new Date().toISOString()],
    [t("判断覆盖率（%）", "Assessment coverage (%)"), percent(result.p)], [t("可接受评分差异（分）", "Acceptable score difference (points)"), percent(result.delta)],
    [t("阅读说明", "Reading guide"), t("综合评分与理想匹配评分按百分制展示；排名稳定率表示评价重点变化时保持当前名次的比例，比较概率不代表真实履约成功率。", "Overall and ideal-match scores use a 100-point scale. Rank stability is the share of importance settings that retain the current rank. Comparison probabilities do not predict actual delivery success.")],
    [], [t("公司名称", "Company name"), t("综合评分（百分制）", "Overall score (out of 100)"), t("综合排名", "Overall rank"), t("理想匹配评分（百分制）", "Ideal-match score (out of 100)"), t("理想匹配排名", "Ideal-match rank"), t("折中排序值（低优）", "Compromise value (lower is better)"), t("折中排名", "Compromise rank"), t("平均评分（百分制）", "Mean score (out of 100)"), t("评分下限（5%分位，百分制）", "Lower score (5th percentile, out of 100)"), t("评分上限（95%分位，百分制）", "Upper score (95th percentile, out of 100)"), t("排名稳定率（%）", "Rank stability (%)")],
  ];
  for (const supplier of [...result.suppliers].sort((a, b) => a.wsmRank - b.wsmRank)) rows.push([
    supplier.name, percent(supplier.baseline), supplier.wsmRank, percent(supplier.topsis), supplier.topsisRank, supplier.vikor, supplier.vikorRank,
    percent(supplier.mean), percent(supplier.score5), percent(supplier.score95), percent(supplier.rsi),
  ]);
  rows.push([], [t("评价指标", "Criterion"), t("评价方向", "Direction"), t("重要程度下限", "Importance lower bound"), t("重要程度中值", "Typical importance"), t("重要程度上限", "Importance upper bound")]);
  for (const criterion of dataset.criteria) rows.push([criterion.name, criterion.type === 'cost' ? t("越低越好", "Lower is better") : t("越高越好", "Higher is better"), criterion.lower, criterion.modal, criterion.upper]);
  const coverage = Number.isFinite(result.p) ? `${Number((result.p * 100).toFixed(4))}%` : t("当前", "current");
  rows.push([], [t("公司甲", "Company A"), t("公司乙", "Company B"), t("甲优于乙的概率（%）", "Probability that A outperforms B (%)"), t(`评分差异下限（${coverage}范围，分）`, `Lower score difference (${coverage} interval, points)`), t(`评分差异上限（${coverage}范围，分）`, `Upper score difference (${coverage} interval, points)`), t("全部允许设置下的最小评分差（分）", "Minimum score difference across all allowed settings (points)"), t("全部允许设置下的最大评分差（分）", "Maximum score difference across all allowed settings (points)"), t("评估结论", "Assessment outcome")]);
  const names = new Map(dataset.suppliers.map(supplier => [supplier.id, supplier.name]));
  for (const pair of result.pairs ?? []) rows.push([names.get(pair.a) ?? pair.a, names.get(pair.b) ?? pair.b, percent(pair.prob), percent(pair.lo), percent(pair.hi), percent(pair.min), percent(pair.max), statuses[pair.status] ?? pair.status]);
  if (additionalRows.length) rows.push([], ...additionalRows);
  rows.push([], [t("计算方法说明", "Scoring methods")], [t("综合评分方法", "Overall scoring method"), 'WSM'], [t("理想匹配评分方法", "Ideal-match scoring method"), 'TOPSIS'], [t("折中排序方法", "Compromise ranking method"), t("VIKOR（值越低越优，保留原始标度）", "VIKOR (lower is better; original scale retained)")]);
  const csv = toCSV(rows);
  downloadBlob(csv, t("ADAPT_供应商分析结果.csv", "ADAPT_Supplier_Results.csv"), 'text/csv;charset=utf-8');
  return csv;
}
