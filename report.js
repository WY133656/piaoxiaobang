/* ============================================================
 * 票小帮 · 业务报表引擎（纯函数 UMD 模块）
 * 功能：
 *   1) buildWeeklyReport / buildMonthlyReport — 周报/月报统计
 *   2) buildFinancialSnapshot — 收支汇总 + 分类占比 + Top5 供应商/客户
 *   3) compareSnapshots — 环比异常提醒（分类变化 >30% 且金额达阈值）
 *   4) buildBriefText — 简报文本（页面展示 / 一键复制分享）
 *   5) buildAnalysisPrompt / templateAnalysis — AI 分析提示词与模板降级
 * 口径（与 recon.js 一致）：
 *   - 支出 = 发票销售方非本公司（采购/报销）
 *   - 收入 = 发票销售方是本公司（销售开票）
 * ============================================================ */
(function (global) {
  'use strict';

  function pad2(n) { return String(n).padStart(2, '0'); }

  function num(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[,，¥￥\s]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function round2(v) { return Math.round(num(v) * 100) / 100; }

  function totalOf(inv) {
    if (!inv) return 0;
    return round2(round2(inv.amount) + round2(inv.tax));
  }

  function fmtAmount(n) {
    return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // 日期转时间戳（兼容 yyyy年mm月dd日 / yyyy-mm-dd / yyyy/mm/dd）
  function dateTsOf(s) {
    var m = String(s || '').match(/(\d{4})[年\-/. ](\d{1,2})[月\-/. ](\d{1,2})日?/);
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  }

  function fmtDate(d) {
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
  }

  function sumInvs(arr) {
    return arr.reduce(function (acc, x) { return acc + totalOf(x); }, 0);
  }

  function aggBy(arr, keyFn) {
    var map = {};
    arr.forEach(function (x) {
      var k = keyFn(x) || '未知';
      if (!map[k]) map[k] = { name: k, amount: 0, count: 0 };
      map[k].amount += totalOf(x);
      map[k].count++;
    });
    return Object.keys(map).map(function (k) { return map[k]; })
      .sort(function (a, b) { return b.amount - a.amount; })
      .map(function (g) { g.amount = round2(g.amount); return g; });
  }

  /* ---------- 财务快照 ---------- */

  // opts: { from, to (yyyy-mm-dd), isMyCompanyFn }
  function buildFinancialSnapshot(ledger, opts) {
    var o = opts || {};
    var myFn = o.isMyCompanyFn || function () { return false; };
    var fromTs = o.from ? dateTsOf(o.from) : -Infinity;
    var toTs = o.to ? dateTsOf(o.to) + 86399999 : Infinity;

    var inRange = (ledger || []).filter(function (inv) {
      if (!inv || inv.amount === undefined || inv.amount === null || inv.amount === '') return false;
      var ts = dateTsOf(inv.date);
      if (isNaN(ts)) return false;
      return ts >= fromTs && ts <= toTs;
    });

    var outInvs = inRange.filter(function (inv) { return !myFn(inv.seller); }); // 支出
    var inInvs = inRange.filter(function (inv) { return myFn(inv.seller); });   // 收入

    return {
      count: inRange.length,
      inCount: inInvs.length,
      outCount: outInvs.length,
      inAmount: round2(sumInvs(inInvs)),
      outAmount: round2(sumInvs(outInvs)),
      netAmount: round2(sumInvs(inInvs) - sumInvs(outInvs)),
      byCategory: aggBy(inRange, function (x) { return x.category || '未分类'; }),
      outCategory: aggBy(outInvs, function (x) { return x.category || '未分类'; }),
      inCategory: aggBy(inInvs, function (x) { return x.category || '未分类'; }),
      byType: aggBy(inRange, function (x) { return x.invoiceType || '未知'; }),
      topSuppliers: aggBy(outInvs, function (x) { return x.sellerShort || x.seller || '未知'; }).slice(0, 5),
      topBuyers: aggBy(inInvs, function (x) { return x.buyer || '未知'; }).slice(0, 5),
      incompleteCount: inRange.filter(function (x) {
        return !(x.number && x.date && x.seller && x.amount);
      }).length
    };
  }

  /* ---------- 环比对比 ---------- */

  function compareSnapshots(curr, prev) {
    var alerts = [];
    if (!prev || !prev.count) return alerts;
    var pct = function (a, b) { return b ? (a - b) / b : (a > 0 ? 1 : 0); };

    var outPct = pct(curr.outAmount, prev.outAmount);
    if (Math.abs(outPct) >= 0.3 && Math.abs(curr.outAmount - prev.outAmount) >= 2000) {
      alerts.push({
        level: outPct > 0 ? 'warn' : 'info',
        text: '支出总额环比变化 ' + (outPct > 0 ? '+' : '') + Math.round(outPct * 100) +
          '%（' + fmtAmount(prev.outAmount) + ' → ' + fmtAmount(curr.outAmount) + ' 元），请关注'
      });
    }

    var prevCat = {};
    prev.byCategory.forEach(function (c) { prevCat[c.name] = c; });
    curr.byCategory.forEach(function (c) {
      var p = prevCat[c.name];
      if (!p) {
        if (c.amount >= 1000) alerts.push({ level: 'info', text: '新增支出分类「' + c.name + '」' + fmtAmount(c.amount) + ' 元' });
        return;
      }
      var d = pct(c.amount, p.amount);
      if (Math.abs(d) >= 0.3 && Math.abs(c.amount - p.amount) >= 1000) {
        alerts.push({
          level: d > 0 ? 'warn' : 'info',
          text: '分类「' + c.name + '」环比变化 ' + (d > 0 ? '+' : '') + Math.round(d * 100) +
            '%（' + fmtAmount(p.amount) + ' → ' + fmtAmount(c.amount) + ' 元）'
        });
      }
    });
    return alerts;
  }

  /* ---------- 周报 / 月报 ---------- */

  // 上周范围：上周一 ~ 上周日；prevStart/prevEnd 为上上周
  function lastWeekRange(now) {
    var d = now || new Date();
    d = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    var dow = d.getDay();
    var thisMonday = new Date(d);
    thisMonday.setDate(d.getDate() - ((dow + 6) % 7));
    var start = new Date(thisMonday); start.setDate(start.getDate() - 7);
    var end = new Date(thisMonday); end.setDate(end.getDate() - 1);
    var prevStart = new Date(start); prevStart.setDate(prevStart.getDate() - 7);
    var prevEnd = new Date(start); prevEnd.setDate(prevEnd.getDate() - 1);
    return { start: start, end: end, prevStart: prevStart, prevEnd: prevEnd };
  }

  function buildWeeklyReport(ledger, opts) {
    var o = opts || {};
    var myFn = o.isMyCompanyFn || function () { return false; };
    var rng = lastWeekRange(o.now || new Date());
    var snapshot = buildFinancialSnapshot(ledger, { from: fmtDate(rng.start), to: fmtDate(rng.end), isMyCompanyFn: myFn });
    var prev = buildFinancialSnapshot(ledger, { from: fmtDate(rng.prevStart), to: fmtDate(rng.prevEnd), isMyCompanyFn: myFn });
    return {
      kind: 'week',
      title: '上周（' + fmtDate(rng.start) + ' ~ ' + fmtDate(rng.end) + '）业务财务简报',
      range: { start: rng.start, end: rng.end },
      snapshot: snapshot,
      prevSnapshot: prev,
      alerts: compareSnapshots(snapshot, prev)
    };
  }

  function buildMonthlyReport(ledger, opts) {
    var o = opts || {};
    var myFn = o.isMyCompanyFn || function () { return false; };
    var now = o.now || new Date();
    var y, m;
    if (o.year === undefined && o.month === undefined) {
      var d0 = new Date(now.getFullYear(), now.getMonth() - 1, 1); // 上个月
      y = d0.getFullYear(); m = d0.getMonth() + 1;
    } else {
      y = o.year !== undefined ? o.year : now.getFullYear();
      m = o.month !== undefined ? o.month : now.getMonth() + 1;
    }
    var start = new Date(y, m - 1, 1);
    var end = new Date(y, m, 0);
    var prevStart = new Date(y, m - 2, 1);
    var prevEnd = new Date(y, m - 1, 0);
    var snapshot = buildFinancialSnapshot(ledger, { from: fmtDate(start), to: fmtDate(end), isMyCompanyFn: myFn });
    var prev = buildFinancialSnapshot(ledger, { from: fmtDate(prevStart), to: fmtDate(prevEnd), isMyCompanyFn: myFn });
    return {
      kind: 'month',
      title: y + '年' + m + '月财务简报',
      range: { start: start, end: end },
      snapshot: snapshot,
      prevSnapshot: prev,
      alerts: compareSnapshots(snapshot, prev)
    };
  }

  /* ---------- 简报文本 ---------- */

  function buildBriefText(rep) {
    var s = rep.snapshot;
    var NUM = ['一', '二', '三', '四', '五', '六'];
    var used = 2; // 「一、收支汇总」「二、Top5 供应商」已占用
    var take = function () { var n = NUM[used]; used++; return n; };
    var lines = [];
    lines.push('【票小帮】' + rep.title);
    lines.push('');
    lines.push('一、收支汇总');
    lines.push('  收入：¥' + fmtAmount(s.inAmount) + '（' + s.inCount + ' 笔）');
    lines.push('  支出：¥' + fmtAmount(s.outAmount) + '（' + s.outCount + ' 笔）');
    lines.push('  净额：¥' + fmtAmount(s.netAmount) + '（发票 ' + s.count + ' 张）');
    lines.push('');
    lines.push('二、Top5 供应商（支出）');
    if (s.topSuppliers.length) {
      s.topSuppliers.forEach(function (x, i) {
        lines.push('  ' + (i + 1) + '. ' + x.name + '　¥' + fmtAmount(x.amount) + '（' + x.count + ' 笔）');
      });
    } else {
      lines.push('  本期无支出数据');
    }
    if (s.topBuyers.length) {
      lines.push('');
      lines.push(take() + '、Top5 客户（收入）');
      s.topBuyers.forEach(function (x, i) {
        lines.push('  ' + (i + 1) + '. ' + x.name + '　¥' + fmtAmount(x.amount) + '（' + x.count + ' 笔）');
      });
    }
    if (rep.alerts.length) {
      lines.push('');
      lines.push(take() + '、异常波动提醒');
      rep.alerts.forEach(function (a) {
        lines.push('  [' + (a.level === 'warn' ? '警告' : '提示') + '] ' + a.text);
      });
    }
    if (rep.analysis) {
      lines.push('');
      lines.push(take() + '、分析');
      String(rep.analysis).split('\n').forEach(function (l) { lines.push('  ' + l); });
    }
    lines.push('');
    lines.push('—— 由票小帮自动生成，数据来源：本地发票台账');
    return lines.join('\n');
  }

  /* ---------- AI 分析 ---------- */

  function buildAnalysisPrompt(snap) {
    var sys = '你是企业财务分析师。基于发票台账的统计摘要，生成一份面向管理层的简洁、客观的中文财务分析报告（Markdown 分小节：收支概况 / 结构分析 / 供应商与客户 / 风险与建议）。只依据给定数据，不编造。';
    var user = '统计摘要（JSON）：\n' + JSON.stringify({
      count: snap.count,
      inAmount: snap.inAmount,
      outAmount: snap.outAmount,
      netAmount: snap.netAmount,
      byCategory: snap.byCategory.slice(0, 8),
      topSuppliers: snap.topSuppliers,
      topBuyers: snap.topBuyers,
      incompleteCount: snap.incompleteCount
    }, null, 2);
    return { system: sys, user: user };
  }

  // 未配置大模型时的模板降级分析
  function templateAnalysis(snap) {
    var parts = [];
    var net = snap.outAmount - snap.inAmount;
    var netText = net >= 0 ? '净支出 ¥' + fmtAmount(net) : '净收入 ¥' + fmtAmount(-net);
    parts.push('本期共处理发票 ' + snap.count + ' 张：支出 ' + snap.outCount + ' 张（¥' + fmtAmount(snap.outAmount) + '），收入 ' + snap.inCount + ' 张（¥' + fmtAmount(snap.inAmount) + '），' + netText + '。');
    if (snap.outCategory.length) {
      var top = snap.outCategory[0];
      var share = snap.outAmount > 0 ? Math.round(top.amount / snap.outAmount * 100) : 0;
      parts.push('支出主要集中在「' + top.name + '」（¥' + fmtAmount(top.amount) + '，占 ' + share + '%）。');
    }
    if (snap.topSuppliers.length) {
      var s0 = snap.topSuppliers[0];
      parts.push('最大供应商为 ' + s0.name + '，' + s0.count + ' 笔，合计 ¥' + fmtAmount(s0.amount) + '。');
    }
    if (snap.incompleteCount > 0) {
      parts.push('另有 ' + snap.incompleteCount + ' 张发票字段不完整，建议尽快补全以保证报表准确。');
    }
    parts.push('建议：关注支出集中度与分类波动，对异常金额核实业务真实性；配置大模型后可生成更深入的分析。');
    return parts.join('\n');
  }

  var Report = {
    num: num,
    round2: round2,
    totalOf: totalOf,
    dateTsOf: dateTsOf,
    buildFinancialSnapshot: buildFinancialSnapshot,
    compareSnapshots: compareSnapshots,
    buildWeeklyReport: buildWeeklyReport,
    buildMonthlyReport: buildMonthlyReport,
    buildBriefText: buildBriefText,
    buildAnalysisPrompt: buildAnalysisPrompt,
    templateAnalysis: templateAnalysis
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Report;
  else global.Report = Report;
})(typeof window !== 'undefined' ? window : globalThis);
