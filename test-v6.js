/* v4.1.1 测试：多期对比格式财务报表（上市公司 PDF，如贵州茅台资产负债表）
 * 链路：PDF 文本行 → textLinesToRows → parseStatement → buildFinAnalysis
 */
const fs = require('fs');
const path = require('path');
const FinStat = require('./finstat.js');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (detail !== undefined ? '  → ' + detail : '')); }
}

console.log('== 1. 真实茅台 PDF（多期对比格式，单位亿元）==');
const lines = JSON.parse(fs.readFileSync(path.join(__dirname, '_moutai_lines.json'), 'utf8'));
const rows = FinStat.textLinesToRows(lines);
check('textLinesToRows 输出行数 > 15', rows.length > 15, rows.length);
check('含报表日期表头行', rows.some(r => r[0] === '报表日期' && /^\d{4}-\d{2}-\d{2}$/.test(r[1])), JSON.stringify(rows[0]));
check('含单位行 亿元', rows.some(r => r[0] === '单位' && r[1] === '亿元'));
const cashRow = rows.find(r => r[0] === '货币资金');
check('货币资金行含 4 期数值', cashRow && cashRow.length === 5, JSON.stringify(cashRow));
const arRow = rows.find(r => r[0] === '应收票据及应收账款');
check('首行科目（应收票据及应收账款）解析', arRow && Number(arRow[1]) === 0.32, JSON.stringify(arRow));
const finRow = rows.find(r => r[0] === '应收款项融资');
check('"—" 占位转为空值', finRow && finRow[3] === '' && finRow[4] === '', JSON.stringify(finRow));
check('比率分析区被截断（无 资产负债率 科目）', !rows.some(r => r[0] === '资产负债率'));
check('免责声明不入表（无 营运资金）', !rows.some(r => (r[0] || '').indexOf('营运资金') === 0));
check('首页概览行不入表（无 归属母公司股东权益（2026Q1））', !rows.some(r => /\d{4}Q\d/.test(r[0] || '')));

const st = FinStat.parseStatement(rows);
check('类型识别 = 资产负债表', st.type === 'balance', st.type);
check('单位 = 亿元', st.unit === '亿元', st.unit);
check('期间 = 2026年3月', st.period === '2026年3月', st.period);
check('mapping.mode = date-columns', st.mapping && st.mapping.mode === 'date-columns', JSON.stringify(st.mapping));
check('科目数 ≥ 20', st.items.length >= 20, st.items.length);
const it = (n) => st.items.find(x => x.name === n);
check('货币资金 本期 487.87 / 上期 516.91', it('货币资金') && it('货币资金').current === 487.87 && it('货币资金').previous === 516.91, JSON.stringify(it('货币资金')));
check('资产总计 3199.19 / 3038.35', it('资产总计') && it('资产总计').current === 3199.19 && it('资产总计').previous === 3038.35, JSON.stringify(it('资产总计')));
check('负债合计 387.83', it('负债合计') && it('负债合计').current === 387.83);
check('所有者权益合计 2811.36', it('所有者权益合计') && it('所有者权益合计').current === 2811.36);

const res = FinStat.buildFinAnalysis([st]);
check('unit 透传 亿元', res.unit === '亿元', res.unit);
const debt = res.indicators.filter(g => g.title === '偿债与资本结构')[0];
const vi = (n) => debt.items.filter(x => x.name === n)[0];
check('资产总计指标 3199.19', vi('资产总计') && vi('资产总计').value === 3199.19);
check('资产负债率 ≈ 12.12%', Math.abs(vi('资产负债率').value - 12.12) < 0.05, vi('资产负债率').value);
check('流动比率 ≈ 7.06', Math.abs(vi('流动比率').value - 7.06) < 0.02, vi('流动比率') && vi('流动比率').value);
check('所有者权益取合计 2811.36 而非归母 2708.94', vi('所有者权益') && vi('所有者权益').value === 2811.36, vi('所有者权益') && vi('所有者权益').value);
const bal = res.checks.filter(c => c.title === '资产负债表平衡校验')[0];
check('平衡校验通过（3199.19 = 387.83 + 2811.36）', bal && bal.ok === true, bal && bal.detail);
const tmpl = FinStat.templateFinAnalysis(res);
check('模板报告含单位标注', tmpl.indexOf('金额单位：亿元') >= 0);
check('模板报告为 4 段', (tmpl.match(/^[一二三四]、/gm) || []).length === 4);

console.log('== 2. 东财/新浪 xlsx 多期列（二维数组直接入 parseStatement）==');
const xlsxRows = [
  ['科目', '2024-03-31', '2023-12-31', '2023-09-30'],
  ['货币资金', 1000.5, 900.25, 850],
  ['应收账款', 100, 120, 110],
  ['流动资产合计', 1100.5, 1020.25, 960],
  ['资产总计', 2000, 1900, 1850],
  ['流动负债合计', 500, 520, 510],
  ['负债合计', 600, 650, 640],
  ['所有者权益合计', 1400, 1250, 1210]
];
const st2 = FinStat.parseStatement(xlsxRows);
check('xlsx 多期列类型 = 资产负债表', st2.type === 'balance', st2.type);
check('xlsx 期间 = 2024年3月', st2.period === '2024年3月', st2.period);
check('xlsx 货币资金 1000.5/900.25', st2.items[0].current === 1000.5 && st2.items[0].previous === 900.25, JSON.stringify(st2.items[0]));
const res2 = FinStat.buildFinAnalysis([st2]);
const bal2 = res2.checks.filter(c => c.title === '资产负债表平衡校验')[0];
check('xlsx 平衡校验通过', bal2 && bal2.ok === true, bal2 && bal2.detail);

console.log('== 3. 回归：标准格式（期末余额/年初余额）不受影响 ==');
const stdRows = [
  ['资产负债表', '', '', ''],
  ['编制单位：XX公司', '2026年8月', '单位：元', ''],
  ['项目', '行次', '期末余额', '年初余额'],
  ['货币资金', '', '50000.00', '40000.00'],
  ['应收账款', '', '3000.00', '2000.00'],
  ['流动资产合计', '', '53000.00', '42000.00'],
  ['资产总计', '', '80000.00', '70000.00'],
  ['流动负债合计', '', '20000.00', '25000.00'],
  ['负债合计', '', '30000.00', '35000.00'],
  ['未分配利润', '', '20000.00', '15000.00'],
  ['所有者权益合计', '', '50000.00', '35000.00']
];
const st3 = FinStat.parseStatement(stdRows);
check('标准格式 mode=standard', st3.mapping && st3.mapping.mode === 'standard', JSON.stringify(st3.mapping));
check('标准格式单位 = 元', st3.unit === '元', st3.unit);
check('标准格式 资产总计 80000', FinStat.findItem(st3.items, ['资产总计']).current === 80000);

console.log('== 4. 回归：OCR 无空格行 / 旧 textLinesToRows 行为 ==');
const ocrRows = FinStat.textLinesToRows(['营业收入 1234567.89 1100000', '营业成本890,000.00', '净利润 200000 180000']);
check('OCR 空格行（2 值）', ocrRows[0][0] === '营业收入' && ocrRows[0][1] === '1234567.89', JSON.stringify(ocrRows[0]));
check('OCR 无空格行', ocrRows[1][0] === '营业成本' && ocrRows[1][1] === '890000.00', JSON.stringify(ocrRows[1]));
const st4 = FinStat.parseStatement(ocrRows);
check('OCR 行类型 = 利润表', st4.type === 'income', st4.type);

console.log('\n结果：' + pass + ' 通过 / ' + fail + ' 失败');
process.exit(fail ? 1 : 0);
