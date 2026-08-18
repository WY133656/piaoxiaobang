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

  /* ---------- 出表模板 1：损益对比表（本月 vs 上月 vs 去年同期） ---------- */

  // ledger: 台账；opts: { year, month(1-12), isMyCompanyFn }
  function buildIncomeStatement(ledger, opts) {
    var o = opts || {};
    var myFn = o.isMyCompanyFn || function () { return false; };
    var now = o.now || new Date();
    var y = o.year !== undefined ? o.year : now.getFullYear();
    var m = o.month !== undefined ? o.month : now.getMonth() + 1;

    var fmtM = function (yy, mm) { return yy + '-' + pad2(mm); };
    var snap = function (yy, mm) {
      var start = new Date(yy, mm - 1, 1);
      var end = new Date(yy, mm, 0);
      return buildFinancialSnapshot(ledger, {
        from: fmtDate(start), to: fmtDate(end), isMyCompanyFn: myFn
      });
    };

    var cur = snap(y, m);
    var lastM = m === 1 ? snap(y - 1, 12) : snap(y, m - 1);
    var lastY = snap(y - 1, m);

    // 收入行（分类）∪ 支出行（分类）
    var names = [];
    [cur, lastM, lastY].forEach(function (s) {
      s.inCategory.concat(s.outCategory).forEach(function (g) {
        if (names.indexOf(g.name) < 0) names.push(g.name);
      });
    });
    var byName = function (s, name) {
      var g = s.inCategory.concat(s.outCategory).filter(function (x) { return x.name === name; })[0];
      return g ? g.amount : 0;
    };
    var pct = function (a, b) { return b === 0 ? (a === 0 ? 0 : 100) : Math.round((a - b) / b * 100); };

    var rows = names.map(function (name) {
      var c = byName(cur, name), lm = byName(lastM, name), ly = byName(lastY, name);
      return {
        name: name,
        current: c, lastMonth: lm, lastYear: ly,
        momPct: pct(c, lm), yoyPct: pct(c, ly),
        kind: cur.inCategory.filter(function (x) { return x.name === name; }).length ? 'income' : 'expense'
      };
    });
    rows.sort(function (a, b) { return b.current - a.current; });

    return {
      kind: 'income',
      title: y + '年' + m + '月损益对比表（本月 vs 上月 vs 去年同期）',
      period: y + '年' + m + '月',
      rows: rows,
      totals: {
        income: { current: cur.inAmount, lastMonth: lastM.inAmount, lastYear: lastY.inAmount },
        expense: { current: cur.outAmount, lastMonth: lastM.outAmount, lastYear: lastY.outAmount },
        net: { current: cur.netAmount, lastMonth: lastM.netAmount, lastYear: lastY.netAmount }
      },
      count: cur.count
    };
  }

  /* ---------- 出表模板 2：费用明细排行（分类/供应商，Top3 高亮） ---------- */

  // ledger: 台账；opts: { by: 'category'|'seller', year, month, limit }
  function buildExpenseRanking(ledger, opts) {
    var o = opts || {};
    var myFn = o.isMyCompanyFn || function () { return false; };
    var now = o.now || new Date();
    var y = o.year !== undefined ? o.year : now.getFullYear();
    var m = o.month !== undefined ? o.month : now.getMonth() + 1;
    var by = o.by || 'category';
    var limit = o.limit !== undefined ? o.limit : 10;
    var start = new Date(y, m - 1, 1);
    var end = new Date(y, m, 0);
    var snap = buildFinancialSnapshot(ledger, { from: fmtDate(start), to: fmtDate(end), isMyCompanyFn: myFn });

    var src = by === 'seller' ? snap.topSuppliers.map(function (x) { return { name: x.name, amount: x.amount, count: x.count }; })
      : snap.outCategory.map(function (x) { return { name: x.name, amount: x.amount, count: x.count }; });
    var rows = src.map(function (x, i) {
      return { rank: i + 1, name: x.name, amount: x.amount, count: x.count, pct: snap.outAmount > 0 ? Math.round(x.amount / snap.outAmount * 100) : 0 };
    });
    var top3 = rows.slice(0, 3);
    return {
      kind: 'expenseRank',
      title: y + '年' + m + '月费用明细排行（按' + (by === 'seller' ? '供应商' : '分类') + '）',
      by: by, period: y + '年' + m + '月',
      total: snap.outAmount, totalCount: snap.outCount,
      top3: top3, rows: rows, limit: limit
    };
  }

  /* ---------- 出表模板 3：现金流简表（经营/投资/筹资） ---------- */

  // 默认归类关键词规则（可按摘要/对方户名命中）
  var CASHFLOW_RULES = [
    { type: '经营', keywords: ['工资', '社保', '公积金', '货款', '材料', '采购', '销售', '回款', '租金', '租赁', '房租', '水电', '办公', '差旅', '报销', '快递', '物流', '仓储', '推广', '广告', '税费', '发票', '劳务', '服务费', '运输'] },
    { type: '投资', keywords: ['设备', '固定资产', '股权', '投资', '厂房', '无形资产', '车辆', '装修', '机器', '软件'] },
    { type: '筹资', keywords: ['贷款', '借款', '还款', '利息', '分红', '注册资本', '股东', '融资', '担保'] }
  ];

  // bankRows: parseBankRows 输出；opts: { rules, period }
  function buildCashflow(bankRows, opts) {
    var o = opts || {};
    var rules = o.rules || CASHFLOW_RULES;
    var rows = (bankRows || []).map(function (r) {
      var text = (r.counterparty || '') + ' ' + (r.summary || '');
      var type = '';
      for (var i = 0; i < rules.length; i++) {
        var hit = rules[i].keywords.some(function (kw) { return text.indexOf(kw) >= 0; });
        if (hit) { type = rules[i].type; break; }
      }
      return { date: r.date, counterparty: r.counterparty, direction: r.direction, amount: r.amount, type: type || '未分类' };
    });

    var group = {};
    rows.forEach(function (r) {
      if (!group[r.type]) group[r.type] = { in: 0, out: 0, count: 0 };
      var g = group[r.type];
      if (r.direction === 'in') g.in += r.amount; else g.out += r.amount;
      g.count++;
    });
    var kinds = ['经营', '投资', '筹资', '未分类'];
    var out = {};
    var totalIn = 0, totalOut = 0;
    kinds.forEach(function (k) {
      var g = group[k] || { in: 0, out: 0, count: 0 };
      out[k] = { in: round2(g.in), out: round2(g.out), net: round2(g.in - g.out), count: g.count };
      totalIn += g.in; totalOut += g.out;
    });
    return {
      kind: 'cashflow',
      title: (o.period || '本期') + '现金流简表（经营 / 投资 / 筹资）',
      period: o.period || '',
      sections: out,
      totalIn: round2(totalIn), totalOut: round2(totalOut),
      net: round2(totalIn - totalOut),
      rules: rules, rows: rows
    };
  }

  /* ---------- 4 段式 AI 文字报告（用户方案） ---------- */

  // data: { period, snapshot, cashflow, income, expenseRank, alerts }
  // 返回 { system, user } —— 供 llmChat 调用；Prompt 约束"只基于数据，不捏造"
  function buildAnalysisReportV2(data) {
    var d = data || {};
    var s = d.snapshot || {};
    var cf = d.cashflow || {};
    var inc = d.income || {};
    var er = d.expenseRank || {};

    var sys = '你是企业财务分析师。基于提供的统计数据，撰写约 500 字的中文财务简报，严格按 4 个固定段落：' +
      '一、总体概览（收入/支出/净额 + 环比）；二、费用异动预警（异常波动分类，给出核查建议）；' +
      '三、现金流健康度（经营/投资/筹资净额，判断资金安全垫）；四、业务提示（集中度、应收风险、待办事项）。' +
      '只依据给定数据客观分析，禁止编造数字或事实；数字保留两位小数；简洁专业。';

    var user = JSON.stringify({
      period: d.period || '',
      snapshot: {
        inAmount: s.inAmount, outAmount: s.outAmount, netAmount: s.netAmount,
        inCount: s.inCount, outCount: s.outCount,
        inCategory: (s.inCategory || []).slice(0, 5),
        outCategory: (s.outCategory || []).slice(0, 5),
        topSuppliers: (s.topSuppliers || []).slice(0, 5),
        topBuyers: (s.topBuyers || []).slice(0, 5)
      },
      alerts: d.alerts || [],
      incomeStatement: inc.rows ? inc.rows.slice(0, 8) : [],
      expenseRanking: er.rows ? er.rows.slice(0, 5) : [],
      cashflow: cf.sections || {}
    }, null, 2);
    return { system: sys, user: user };
  }

  // 未配置大模型时的规则模板降级（同样 4 段结构）
  function templateAnalysisV2(data) {
    var d = data || {};
    var s = d.snapshot || {};
    var cf = d.cashflow || {};
    var parts = [];

    // 一、总体概览
    var net = s.netAmount;
    var netText = net >= 0 ? '净额 +¥' + fmtAmount(net) : '净额 ¥' + fmtAmount(net);
    parts.push('一、总体概览');
    parts.push('本期收入 ¥' + fmtAmount(s.inAmount) + '（' + (s.inCount || 0) + ' 笔），支出 ¥' + fmtAmount(s.outAmount) +
      '（' + (s.outCount || 0) + ' 笔），' + netText + '。');
    if (d.alerts && d.alerts.length) {
      parts.push('环比提醒 ' + d.alerts.length + ' 条，详见下文。');
    }

    // 二、费用异动预警
    parts.push('二、费用异动预警');
    if (d.alerts && d.alerts.length) {
      d.alerts.slice(0, 3).forEach(function (a) {
        parts.push('- ' + a.text + '。');
      });
      parts.push('建议逐项核查波动原因，确认是否为一次性支出或业务正常变化。');
    } else if (s.outCategory && s.outCategory.length) {
      var top = s.outCategory[0];
      parts.push('本期支出最高分类为「' + top.name + '」¥' + fmtAmount(top.amount) + '，占总支出 ' +
        (s.outAmount > 0 ? Math.round(top.amount / s.outAmount * 100) : 0) + '%，环比无显著异常波动。');
    } else {
      parts.push('本期无显著费用波动。');
    }

    // 三、现金流健康度
    parts.push('三、现金流健康度');
    if (cf.sections) {
      var op = cf.sections['经营'];
      if (op) {
        parts.push('经营性净现金流 ¥' + fmtAmount(op.net) + '（流入 ¥' + fmtAmount(op.in) + ' / 流出 ¥' + fmtAmount(op.out) + '）' +
          (op.net >= 0 ? '，经营造血能力正常，资金安全垫充足。' : '，经营净流出，需关注垫付资金压力。'));
      }
      ['投资', '筹资'].forEach(function (k) {
        var g = cf.sections[k];
        if (g && g.count > 0) parts.push(k + '性现金流净额 ¥' + fmtAmount(g.net) + '（流入 ¥' + fmtAmount(g.in) + ' / 流出 ¥' + fmtAmount(g.out) + '）。');
      });
      var un = cf.sections['未分类'];
      if (un && un.count > 0) parts.push('另有 ' + un.count + ' 笔流水未能自动分类（合计 ¥' + fmtAmount(un.in + un.out) + '），建议补充归类规则。');
    } else {
      parts.push('暂未导入银行流水，无法评估现金流结构。');
    }

    // 四、业务提示
    parts.push('四、业务提示');
    var tips = [];
    if (s.topSuppliers && s.topSuppliers.length) {
      var s0 = s.topSuppliers[0];
      var share = s.outAmount > 0 ? Math.round(s0.amount / s.outAmount * 100) : 0;
      if (share >= 40) tips.push('供应商集中度偏高：最大供应商 ' + s0.name + ' 占支出 ' + share + '%，建议评估备选供应商以分散风险。');
    }
    if (s.topBuyers && s.topBuyers.length) {
      var b0 = s.topBuyers[0];
      var bshare = s.inAmount > 0 ? Math.round(b0.amount / s.inAmount * 100) : 0;
      if (bshare >= 40) tips.push('客户集中度偏高：最大客户 ' + b0.name + ' 占收入 ' + bshare + '%，关注大客户回款与续约。');
    }
    if (s.incompleteCount > 0) tips.push('有 ' + s.incompleteCount + ' 张发票字段不完整，建议尽快补全以保证对账与报表准确。');
    if (d.period) tips.push('本月账期结账前，请复核未匹配流水与未核销单据（见「对账」页红蓝橙异议清单）。');
    if (!tips.length) tips.push('本期经营数据整体平稳，维持现有节奏，定期复核异常即可。');
    tips.forEach(function (t) { parts.push('- ' + t); });
    return parts.join('\n');
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
    templateAnalysis: templateAnalysis,
    buildIncomeStatement: buildIncomeStatement,
    buildExpenseRanking: buildExpenseRanking,
    buildCashflow: buildCashflow,
    CASHFLOW_RULES: CASHFLOW_RULES,
    buildAnalysisReportV2: buildAnalysisReportV2,
    templateAnalysisV2: templateAnalysisV2
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Report;
  else global.Report = Report;
})(typeof window !== 'undefined' ? window : globalThis);
