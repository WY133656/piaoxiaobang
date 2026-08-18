/* ============================================================
 * 票小帮 v4.1 · 财务报表分析引擎端到端测试
 * 运行：node test-v5.js
 * ============================================================ */
'use strict';
const FinStat = require('./finstat.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

console.log('== 1. 报表类型识别 ==');

const incomeRows = [
  ['利润表'],
  ['编制单位：XX公司', '', '', '', ''],
  ['会计期间：2026年8月', '', '', '', ''],
  ['项目', '行次', '本期金额', '上期金额'],
  ['一、营业收入', '1', '1000000', '800000'],
  ['减：营业成本', '2', '600000', '500000'],
  ['销售费用', '3', '50000', '40000'],
  ['管理费用', '4', '80000', '70000'],
  ['财务费用', '5', '10000', '12000'],
  ['二、营业利润', '6', '260000', '178000'],
  ['加：营业外收入', '7', '0', '2000'],
  ['三、利润总额', '8', '260000', '180000'],
  ['减：所得税费用', '9', '40000', '30000'],
  ['四、净利润', '10', '220000', '150000']
];

const balanceRows = [
  ['资产负债表'],
  ['编制单位：XX公司', '', '', ''],
  ['2026年8月31日', '', '', ''],
  ['项目', '行次', '期末余额', '年初余额'],
  ['流动资产：', '', '', ''],
  ['货币资金', '1', '380000', '300000'],
  ['应收账款', '2', '120000', '100000'],
  ['存货', '3', '100000', '80000'],
  ['流动资产合计', '4', '600000', '480000'],
  ['非流动资产合计', '5', '400000', '320000'],
  ['资产总计', '6', '1000000', '800000'],
  ['流动负债合计', '7', '300000', '250000'],
  ['非流动负债合计', '8', '100000', '100000'],
  ['负债合计', '9', '400000', '350000'],
  ['实收资本', '10', '300000', '300000'],
  ['未分配利润', '11', '300000', '150000'],
  ['所有者权益合计', '12', '600000', '450000']
];

const cashflowRows = [
  ['现金流量表'],
  ['编制单位：XX公司', '', '', ''],
  ['会计期间：2026年8月', '', '', ''],
  ['项目', '行次', '本期金额', '上期金额'],
  ['一、经营活动产生的现金流量：', '', '', ''],
  ['经营活动产生的现金流量净额', '1', '150000', '100000'],
  ['二、投资活动产生的现金流量：', '', '', ''],
  ['投资活动产生的现金流量净额', '2', '-50000', '-20000'],
  ['三、筹资活动产生的现金流量：', '', '', ''],
  ['筹资活动产生的现金流量净额', '3', '30000', '50000'],
  ['四、现金及现金等价物净增加额', '4', '130000', '130000'],
  ['加：期初现金及现金等价物余额', '5', '250000', '120000'],
  ['期末现金及现金等价物余额', '6', '380000', '250000']
];

const t1 = FinStat.detectStatementType(incomeRows);
check('利润表识别', t1.type === 'income', JSON.stringify(t1));
const t2 = FinStat.detectStatementType(balanceRows);
check('资产负债表识别', t2.type === 'balance', JSON.stringify(t2));
const t3 = FinStat.detectStatementType(cashflowRows);
check('现金流量表识别', t3.type === 'cashflow', JSON.stringify(t3));

console.log('== 2. parseStatement 科目解析 ==');

const inc = FinStat.parseStatement(incomeRows);
check('利润表：类型正确', inc.type === 'income', inc.type);
check('利润表：期间提取 2026年8月', inc.period === '2026年8月', inc.period);
check('利润表：科目数 10（跳过编制单位/期间/表头）', inc.items.length === 10, inc.items.length);
check('利润表：营业收入 1000000 / 上期 800000',
  inc.items[0].name === '一、营业收入' && inc.items[0].current === 1000000 && inc.items[0].previous === 800000,
  JSON.stringify(inc.items[0]));
check('利润表：净利润 220000', FinStat.findItem(inc.items, ['净利润']).current === 220000, '');
check('利润表：所得税 40000', FinStat.findItem(inc.items, ['所得税费用']).current === 40000, '');

const bal = FinStat.parseStatement(balanceRows);
check('资产负债表：类型正确', bal.type === 'balance', bal.type);
check('资产负债表：科目数', bal.items.length === 12, bal.items.length);
check('资产负债表：期末余额列取数（资产总计 1000000）', FinStat.findItem(bal.items, ['资产总计']).current === 1000000, '');
check('资产负债表：年初余额列取数（未分配利润年初 150000）', FinStat.findItem(bal.items, ['未分配利润']).previous === 150000, '');
check('资产负债表：货币资金 380000', FinStat.findItem(bal.items, ['货币资金']).current === 380000, '');

const cf = FinStat.parseStatement(cashflowRows);
check('现金流量表：类型正确', cf.type === 'cashflow', cf.type);
check('现金流量表：经营净额 150000', FinStat.findItem(cf.items, ['经营活动产生的现金流量净额']).current === 150000, '');
check('现金流量表：期末现金 380000', FinStat.findItem(cf.items, ['期末现金及现金等价物余额']).current === 380000, '');
check('现金流量表：负数（投资净额 -50000）', FinStat.findItem(cf.items, ['投资活动产生的现金流量净额']).current === -50000, '');

console.log('== 3. 表头变体与元信息容错 ==');

// 变体：利润表无行次列 + 本月数/本年累计数；金额为字符串带逗号
const incomeVariant = [
  ['利润表（简表）'],
  ['项目', '本月数', '本年累计数'],
  ['营业收入', '1,000,000.00', '5,000,000.00'],
  ['营业成本', '600,000.00', '3,200,000.00'],
  ['净利润', '220,000.00', '900,000.00']
];
const incV = FinStat.parseStatement(incomeVariant);
check('变体表头：本月数列识别（营业收入 1000000）', incV.items.length === 3 && incV.items[0].current === 1000000, JSON.stringify(incV.items[0]));
check('变体表头：本年累计数列识别（净利润本年 900000）', FinStat.findItem(incV.items, ['净利润']).previous === 900000, '');

// 括号负数
const negRows = [
  ['项目', '期末余额', '年初余额'],
  ['未分配利润', '(50000)', '10000'],
  ['资产总计', '800000', '700000']
];
const negP = FinStat.parseStatement(negRows);
check('括号负数：未分配利润 -50000', FinStat.findItem(negP.items, ['未分配利润']).current === -50000, JSON.stringify(negP.items[0]));

console.log('== 4. OCR 文本行解析 ==');

const ocrLines = [
  '编制单位：XX公司',
  '营业收入 1,234,567.89 987,654.32',
  '营业成本890,000.00',
  '净利润 200000',
  '2026年8月',
  '（三）净利润（净亏损以“-”号填列） 150000',
  '管理费用 60,000'
];
const finRows = FinStat.textLinesToRows(ocrLines);
check('OCR 行：有效科目行数 5（跳过编制单位/日期行；带注释科目行保留）', finRows.length === 5, finRows.length + ' → ' + JSON.stringify(finRows));
check('OCR 行：营业收入金额解析', finRows[0] && finRows[0][0] === '营业收入' && finRows[0][1] === '1234567.89' && finRows[0][2] === '987654.32', JSON.stringify(finRows[0]));
check('OCR 行：无空格行解析（营业成本 890000.00）', finRows[1] && finRows[1][0] === '营业成本' && finRows[1][1] === '890000.00', JSON.stringify(finRows[1]));

console.log('== 5. 综合财务分析 ==');

const res = FinStat.buildFinAnalysis([inc, bal, cf]);
check('分析：sourceCount = 3', res.sourceCount === 3, res.sourceCount);
check('分析：期间 = 2026年8月', res.period === '2026年8月', res.period);

const grp = (title) => res.indicators.filter(g => g.title === title)[0];
const it = (g, name) => { const x = g.items.filter(i => i.name.indexOf(name) >= 0)[0]; return x ? x.value : undefined; };

const incG = grp('盈利能力');
check('指标：毛利率 40%', it(incG, '毛利率') === 40, it(incG, '毛利率'));
check('指标：净利率 22%', it(incG, '净利率') === 22, it(incG, '净利率'));
check('指标：收入同比 +25%', it(incG, '收入同比') === 25, it(incG, '收入同比'));
check('指标：期间费用率 14%', it(incG, '期间费用率') === 14, it(incG, '期间费用率'));

const debtG = grp('偿债与资本结构');
check('指标：资产负债率 40%', it(debtG, '资产负债率') === 40, it(debtG, '资产负债率'));
check('指标：流动比率 2.00', it(debtG, '流动比率') === 2, it(debtG, '流动比率'));

const cfG = grp('现金流量');
check('指标：经营活动净额 150000', it(cfG, '经营活动') === 150000, it(cfG, '经营活动'));
check('指标：投资活动净额 -50000', it(cfG, '投资活动') === -50000, it(cfG, '投资活动'));

check('勾稽校验：3 项', res.checks.length === 3, res.checks.length);
check('勾稽校验①：资产负债表平衡 ✓', res.checks[0].ok, res.checks[0].detail);
check('勾稽校验②：净利润 220000 = 未分配利润变动 150000？', !res.checks[1].ok, res.checks[1].detail + '（未分配利润变动 150000 ≠ 净利润 220000，应提示差异）');
check('勾稽校验③：期末现金 = 货币资金 ✓', res.checks[2].ok, res.checks[2].detail);

// 修正勾稽一致场景：未分配利润变动 = 220000
const balOk = JSON.parse(JSON.stringify(bal));
const und = FinStat.findItem(balOk.items, ['未分配利润']);
und.previous = 80000; // 期末 300000 - 年初 80000 = 220000 = 净利润
const resOk = FinStat.buildFinAnalysis([inc, balOk, cf]);
check('勾稽一致：净利润 ↔ 未分配利润变动通过', resOk.checks[1].ok, resOk.checks[1].detail);

// 预警检查
const warnLevels = res.alerts.map(a => a.level);
check('预警：含信息提示（无风险类）', warnLevels.includes('info') || warnLevels.includes('ok'), JSON.stringify(res.alerts));

// 模板降级报告
const tpl = FinStat.templateFinAnalysis(res);
check('模板报告：4 段齐全', ['一、总体概览', '二、盈利能力与费用', '三、偿债能力与现金流健康度', '四、业务提示与风险'].every(s => tpl.indexOf(s) >= 0), tpl.split('\n').slice(0, 4).join(' | '));
check('模板报告：含真实数字', tpl.indexOf('¥1,000,000.00') >= 0 || tpl.indexOf('1,000,000.00') >= 0, tpl.split('\n')[1]);

const prompt = FinStat.buildFinAnalysisPrompt(res);
check('AI Prompt：系统约束含「禁止编造」', prompt.system.indexOf('禁止编造') >= 0, '');
check('AI Prompt：用户数据含指标 JSON', prompt.user.indexOf('indicators') >= 0, '');

console.log('== 6. 边界：仅利润表 ==');

const resOnly = FinStat.buildFinAnalysis([inc]);
check('仅利润表：勾稽校验提示报表不全', resOnly.checks[0].detail.indexOf('报表齐全') >= 0, resOnly.checks[0].detail);
check('仅利润表：缺少资产负债表预警', resOnly.alerts.some(a => a.text.indexOf('资产负债表') >= 0), JSON.stringify(resOnly.alerts));
check('仅利润表：偿债分组不出现', !resOnly.indicators.some(g => g.title === '偿债与资本结构'), '');

console.log('== 7. 边界：未知类型文件 ==');

const junk = FinStat.parseStatement([
  ['姓名', '部门', '工资'],
  ['张三', '财务部', '8000']
]);
check('未知文件：type = unknown', junk.type === 'unknown', junk.type);
const resJunk = FinStat.buildFinAnalysis([junk]);
check('未知文件：预警提示未识别', resJunk.alerts.some(a => a.text.indexOf('未能识别') >= 0), JSON.stringify(resJunk.alerts));

console.log('');
console.log('========== 结果：' + pass + ' 通过 / ' + fail + ' 失败 ==========');
process.exit(fail > 0 ? 1 : 0);
