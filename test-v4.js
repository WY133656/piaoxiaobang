/* ============================================================
 * 票小帮 v4.0 端到端测试：自动对账（阶梯匹配 + 红蓝橙异议 + 回款看板）
 *                              + 出表模板（损益/费用/现金流）+ 4 段式分析
 * 运行：node test-v4.js
 * ============================================================ */
'use strict';

const Recon = require('./recon.js');
const Report = require('./report.js');

let pass = 0, fail = 0;
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra !== undefined ? '  → ' + extra : '')); }
}

/* ============ 1. 阶梯式匹配 ============ */
console.log('\n【1】matchBusiness 阶梯式匹配');

const bankRows = [
  { rowIdx: 1, date: '2026-08-10', counterparty: '云南建投第三建设有限公司', summary: '工程款回款', direction: 'in', amount: 50000 },
  { rowIdx: 2, date: '2026-08-13', counterparty: '昆明耀扬机械设备租赁', summary: '吊车租赁费', direction: 'out', amount: 9997.5 },
  { rowIdx: 3, date: '2026-08-21', counterparty: '云南建投三建', summary: '工程款回款', direction: 'in', amount: 30000 },
  { rowIdx: 4, date: '2026-08-08', counterparty: '中国建筑第八工程局有限公司', summary: '工程款回款', direction: 'in', amount: 88000 },
  { rowIdx: 5, date: '2026-08-09', counterparty: '中国建筑第八工程局有限公司', summary: '工程款回款', direction: 'in', amount: 88000 },
  { rowIdx: 6, date: '2026-08-18', counterparty: '某个人往来款', summary: '', direction: 'in', amount: 6666 }
];

const bizDocs = [
  { docNo: 'XS-2026-001', type: '应收', party: '云南建投第三建设有限公司', amount: 50000, dueDate: '2026-08-10' },
  { docNo: 'CG-2026-002', type: '应付', party: '昆明耀扬机械设备租赁', amount: 10000, dueDate: '2026-08-12' },
  { docNo: 'XS-2026-003', type: '应收', party: '云南建投第三建设有限公司', amount: 30000, dueDate: '2026-08-20' },
  { docNo: 'XS-2026-004', type: '应收', party: '中国建筑第八工程局有限公司', amount: 88000, dueDate: '2026-08-05' },
  { docNo: 'CG-2026-005', type: '应付', party: '杭州明远办公用品有限公司', amount: 12000, dueDate: '2026-07-20' }
];

const res = Recon.matchBusiness(bankRows, bizDocs, { tol: 5, dateWindow: 3 });
const byIdx = (i) => res.rows[i - 1];

check('L1 强匹配（金额相等+户名全等）', byIdx(1).status === 'matched' && byIdx(1).matchLevel === 'L1' && byIdx(1).docNo === 'XS-2026-001', JSON.stringify(byIdx(1)));
check('L2 容差匹配（差 2.5 元，1 天内）', byIdx(2).status === 'matched' && byIdx(2).matchLevel === 'L2' && byIdx(2).tolerance === true && byIdx(2).docNo === 'CG-2026-002', JSON.stringify(byIdx(2)));
check('L3 模糊关联（简称"三建"↔全称，待人工确认）', byIdx(3).status === 'pending' && byIdx(3).matchLevel === 'L3' && byIdx(3).docNo === 'XS-2026-003', JSON.stringify(byIdx(3)));
check('首笔 88000 正常 L1 核销', byIdx(4).status === 'matched' && byIdx(4).matchLevel === 'L1', JSON.stringify(byIdx(4)));
check('第二笔 88000 判为重复（橙字）', byIdx(5).status === 'duplicate' && byIdx(5).docNo === 'XS-2026-004', JSON.stringify(byIdx(5)));
check('无单据流水 → 未匹配', byIdx(6).status === 'unmatched', JSON.stringify(byIdx(6)));

check('stats.l1=3（含重复判定行，其层级同为 L1）', res.stats.l1 === 3, res.stats.l1);
check('stats.l2=1', res.stats.l2 === 1, res.stats.l2);
check('stats.l3=1', res.stats.l3 === 1, res.stats.l3);
check('stats.duplicate=1', res.stats.duplicate === 1, res.stats.duplicate);
check('stats.unmatched=1', res.stats.unmatched === 1, res.stats.unmatched);

// 单据核销视角
const docByName = (no) => res.docs.find(d => d.docNo === no);
check('单据 XS-2026-001 已结清', docByName('XS-2026-001').status === 'settled', docByName('XS-2026-001').status);
check('单据 CG-2026-002 部分核销（余 2.5 尾差）', docByName('CG-2026-002').status === 'partial' && Math.abs(docByName('CG-2026-002').remaining - 2.5) < 0.001, JSON.stringify(docByName('CG-2026-002')));
check('单据 XS-2026-003 未核销（L3 不消耗）', docByName('XS-2026-003').status === 'open', docByName('XS-2026-003').status);
check('单据 CG-2026-005 未核销且逾期', docByName('CG-2026-005').status === 'open' && docByName('CG-2026-005').overdue === true, JSON.stringify(docByName('CG-2026-005')));

/* ============ 2. 待办异议表（红蓝橙） ============ */
console.log('\n【2】buildReconIssues 红蓝橙异议表');
const issues = Recon.buildReconIssues(res);
const cnt = (lv) => issues.filter(x => x.level === lv).length;
check('红字（长款）1 条', cnt('red') === 1, cnt('red'));
check('蓝字（短款）3 条（002 尾差 + 003 未收 + 005 未付）', cnt('blue') === 3, cnt('blue'));
check('橙字（重复）1 条', cnt('orange') === 1, cnt('orange'));
check('排序：红 > 橙 > 蓝', issues[0].level === 'red' && issues[1].level === 'orange' && issues[2].level === 'blue', issues.map(x => x.level).join(','));
check('红字标题 = 银行有账、业务无单', issues[0].title === '银行有账、业务无单', issues[0].title);
check('蓝字含剩余金额提示', issues.some(x => x.level === 'blue' && x.text.indexOf('已核销') >= 0));

/* ============ 3. 回款看板 ============ */
console.log('\n【3】buildCollectionBoard 回款看板');
const board = Recon.buildCollectionBoard(res, { today: new Date('2026-08-18') });
const b = (p) => board.find(x => x.party.indexOf(p) >= 0);
check('云南建投 → 部分到账（5w/8w，到账率 63%）', b('云南建投').status === 'partial' && b('云南建投').ratio === 63, JSON.stringify(b('云南建投')));
check('中国建筑八局 → 已结清', b('中国建筑').status === 'settled' && b('中国建筑').remaining === 0, JSON.stringify(b('中国建筑')));
check('杭州明远 → 已逾期（29 天）', b('杭州明远').status === 'overdue' && b('杭州明远').overdueDays === 29, JSON.stringify(b('杭州明远')));
check('昆明耀扬 → 部分到账（尾差）', b('昆明耀扬').status === 'partial', JSON.stringify(b('昆明耀扬')));
check('排序：逾期在最前', board[0].status === 'overdue', board.map(x => x.status).join(','));

/* ============ 4. 出表模板 ============ */
console.log('\n【4】报表模板（损益/费用/现金流）');
const myCo = (n) => /票小帮科技/.test(String(n || ''));
const ledger = [
  // 本月 2026-08
  { number: 'A1', date: '2026年08月05日', seller: '票小帮科技有限公司', buyer: '云南建投第三建设有限公司', amount: 80000, tax: 0, category: '项目收入', sellerShort: '票小帮科技', invoiceType: '电子普票' },
  { number: 'A2', date: '2026年08月06日', seller: '昆明耀扬机械设备租赁', buyer: '票小帮科技有限公司', amount: 9977.5, tax: 20, category: '机械租赁', sellerShort: '昆明耀扬', invoiceType: '电子普票' },
  { number: 'A3', date: '2026年08月07日', seller: '杭州明远办公用品有限公司', buyer: '票小帮科技有限公司', amount: 12000, tax: 0, category: '办公用品', sellerShort: '杭州明远', invoiceType: '电子普票' },
  { number: 'A4', date: '2026年08月09日', seller: '北京云端数据服务有限公司', buyer: '票小帮科技有限公司', amount: 5600, tax: 0, category: '软件服务', sellerShort: '北京云端', invoiceType: '电子专票' },
  // 上月 2026-07
  { number: 'B1', date: '2026年07月10日', seller: '票小帮科技有限公司', buyer: '云南建投第三建设有限公司', amount: 60000, tax: 0, category: '项目收入', sellerShort: '票小帮科技', invoiceType: '电子普票' },
  { number: 'B2', date: '2026年07月11日', seller: '昆明耀扬机械设备租赁', buyer: '票小帮科技有限公司', amount: 20000, tax: 0, category: '机械租赁', sellerShort: '昆明耀扬', invoiceType: '电子普票' },
  // 去年同期 2025-08
  { number: 'C1', date: '2025年08月12日', seller: '票小帮科技有限公司', buyer: '云南建投第三建设有限公司', amount: 50000, tax: 0, category: '项目收入', sellerShort: '票小帮科技', invoiceType: '电子普票' },
  { number: 'C2', date: '2025年08月13日', seller: '杭州明远办公用品有限公司', buyer: '票小帮科技有限公司', amount: 8000, tax: 0, category: '办公用品', sellerShort: '杭州明远', invoiceType: '电子普票' }
];

const inc = Report.buildIncomeStatement(ledger, { isMyCompanyFn: myCo, year: 2026, month: 8 });
check('损益表：本月收入 80000', inc.totals.income.current === 80000, inc.totals.income.current);
check('损益表：本月支出 27597.5（9977.5+20+12000+5600）', inc.totals.expense.current === 27597.5, inc.totals.expense.current);
const expRow = inc.rows.find(r => r.name === '机械租赁');
check('损益表：机械租赁 环比 +48%（9977.5+20 vs 20000）', expRow && expRow.momPct === -50, expRow && expRow.momPct);
check('损益表：跨年同比取 2025-08（本月收入同比 +60%）', inc.totals.income.lastYear === 50000 && inc.totals.income.current === 80000);

const er = Report.buildExpenseRanking(ledger, { isMyCompanyFn: myCo, year: 2026, month: 8, by: 'category' });
check('费用排行：Top1 = 办公用品 12000', er.rows[0] && er.rows[0].name === '办公用品' && er.rows[0].amount === 12000, JSON.stringify(er.rows[0]));
check('费用排行：占比与总额一致', Math.abs(er.total - 27597.5) < 0.01 && er.rows[0].pct === 43, er.total + ' / ' + er.rows[0].pct);
const erS = Report.buildExpenseRanking(ledger, { isMyCompanyFn: myCo, year: 2026, month: 8, by: 'seller' });
check('费用排行（按供应商）：Top1 = 杭州明远', erS.rows[0].name === '杭州明远', erS.rows[0].name);

const cf = Report.buildCashflow(bankRows);
check('现金流：流入 262666（50000+30000+88000+88000+6666）', cf.totalIn === 262666, cf.totalIn);
check('现金流：经营类 5 笔（摘要命中"回款/租赁"）', cf.sections['经营'].count === 5, cf.sections['经营'].count);
check('现金流：未分类 1 笔（无摘要）', cf.sections['未分类'].count === 1, cf.sections['未分类'].count);
check('现金流：四类齐备', !!cf.sections['经营'] && !!cf.sections['投资'] && !!cf.sections['筹资'] && !!cf.sections['未分类']);

/* ============ 5. 4 段式 AI 报告 ============ */
console.log('\n【5】4 段式分析（Prompt 构造 + 模板降级）');
const data = {
  period: '2026年8月',
  snapshot: { inAmount: 80000, outAmount: 27597.5, netAmount: 52402.5, inCount: 1, outCount: 3,
    inCategory: [{ name: '项目收入', amount: 80000, count: 1 }],
    outCategory: [{ name: '机械租赁', amount: 9997.5, count: 1 }, { name: '办公用品', amount: 12000, count: 1 }],
    topSuppliers: [{ name: '杭州明远', amount: 12000, count: 1 }],
    topBuyers: [{ name: '云南建投', amount: 80000, count: 1 }] },
  alerts: [{ level: 'info', text: '机械租赁环比下降 50%' }],
  income: inc, expenseRank: er, cashflow: cf
};
const p = Report.buildAnalysisReportV2(data);
check('Prompt：system 含 4 段结构约束', p.system.indexOf('总体概览') >= 0 && p.system.indexOf('费用异动预警') >= 0 && p.system.indexOf('现金流健康度') >= 0 && p.system.indexOf('业务提示') >= 0);
check('Prompt：user 为 JSON 且含现金流水数据', typeof p.user === 'string' && p.user.indexOf('"cashflow"') >= 0);
const tpl = Report.templateAnalysisV2(data);
check('模板降级：含 4 个段标题', ['总体概览', '费用异动预警', '现金流健康度', '业务提示'].every(h => tpl.indexOf(h) >= 0), tpl);
check('模板降级：不含编造数字（净额一致）', tpl.indexOf('52,402.50') >= 0, tpl.split('\n')[2]);

console.log('\n====================================');
console.log('通过 ' + pass + ' / ' + (pass + fail) + ' 项');
if (fail) { console.log('有 ' + fail + ' 项失败！'); process.exit(1); }
console.log('全部通过 ✔');
