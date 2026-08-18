/* ============================================================
 * 票小帮 v4.1 · 财务报表分析引擎（finstat.js）
 * 纯函数 UMD 模块，浏览器 / Node 通用，零依赖。
 *
 * 能力：
 *  1) detectStatementType(rows)   报表类型识别（利润表/资产负债表/现金流量表）
 *  2) parseStatement(rows)        解析单张报表 → 科目行 { name, current, previous }
 *  3) textLinesToRows(lines)      OCR/PDF 文本行 → [科目, 金额] 表格行
 *  4) buildFinAnalysis(statements) 综合财务分析（指标 + 勾稽校验 + 预警）
 *  5) buildFinAnalysisPrompt / templateFinAnalysis  4 段式 AI 报告
 * ============================================================ */
(function (global) {
  'use strict';

  function trim(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  function normalizeAmount(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? round2(v) : null;
    var s = trim(v).replace(/[¥￥,\s]/g, '').replace(/，/g, '');
    if (s === '') return null;
    // 括号负数：(1,234.56) → -1234.56；负号 −/-
    var neg = false;
    if (s.charAt(0) === '(' && s.slice(-1) === ')') { neg = true; s = s.slice(1, -1); }
    else if (s.charAt(0) === '−' || s.charAt(0) === '-') { neg = true; s = s.slice(1); }
    var n = parseFloat(s);
    if (isNaN(n)) return null;
    return round2(neg ? -n : n);
  }

  /* ---------- 报表类型识别 ----------
   * 权重计分：统计全表科目关键词，得分最高的类型胜出
   * 关键词必须足够特异，避免"净利润/未分配利润"互相干扰。
   */
  var TYPE_RULES = [
    {
      type: 'income', label: '利润表',
      score: [
        [2.0, ['营业收入']], [1.5, ['营业成本']],
        [1.2, ['营业利润']], [1.2, ['利润总额']], [1.5, ['净利润']],
        [0.8, ['销售费用']], [0.8, ['管理费用']], [0.8, ['财务费用']],
        [0.6, ['营业税金及附加']], [0.6, ['税金及附加']],
        [0.5, ['其他业务收入']], [0.5, ['投资收益']], [0.4, ['所得税费用']]
      ]
    },
    {
      type: 'balance', label: '资产负债表',
      score: [
        [1.5, ['资产总计']], [1.5, ['负债合计']], [1.2, ['所有者权益']],
        [1.2, ['流动资产合计']], [1.2, ['流动负债合计']],
        [1.0, ['货币资金']], [1.0, ['应收账款']], [0.9, ['未分配利润']],
        [0.8, ['存货']], [0.8, ['固定资产']], [0.8, ['实收资本']],
        [0.6, ['预付账款']], [0.6, ['预收账款']], [0.6, ['应付账款']],
        [0.5, ['非流动资产合计']], [0.5, ['非流动负债合计']]
      ]
    },
    {
      type: 'cashflow', label: '现金流量表',
      score: [
        [2.0, ['经营活动产生的现金流量']], [2.0, ['投资活动产生的现金流量']],
        [2.0, ['筹资活动产生的现金流量']], [1.5, ['现金及现金等价物']],
        [1.0, ['销售商品、提供劳务收到的现金']], [0.9, ['购买商品、接受劳务支付的现金']],
        [0.8, ['支付给职工以及为职工支付的现金']], [0.5, ['购建固定资产']]
      ]
    }
  ];

  function detectStatementType(rows) {
    var text = (rows || []).map(function (r) {
      return (Array.isArray(r) ? r : [r]).map(function (c) { return trim(c); }).join(' ');
    }).join(' ');
    if (!text) return { type: 'unknown', label: '未识别', score: 0 };
    var best = null;
    TYPE_RULES.forEach(function (rule) {
      var s = 0;
      rule.score.forEach(function (pair) {
        for (var i = 0; i < pair[1].length; i++) {
          if (text.indexOf(pair[1][i]) >= 0) { s += pair[0]; break; }
        }
      });
      if (!best || s > best.score) best = { type: rule.type, label: rule.label, score: s };
    });
    return best && best.score > 0 ? best : { type: 'unknown', label: '未识别', score: 0 };
  }

  /* ---------- 表头行识别 ----------
   * 财务报表表头形态：
   *   资产负债表：[项目, 行次, 期末余额, 年初余额]
   *   利润表 / 现金流量表：[项目, 行次, 本期金额, 上期金额] 或 [项目, 行次, 本月数, 本年累计数]
   */
  function findHeader(rows) {
    var limit = Math.min(rows.length, 10);
    for (var i = 0; i < limit; i++) {
      var row = rows[i] || [];
      var nameCol = -1, curCol = -1, prevCol = -1;
      for (var j = 0; j < row.length; j++) {
        var t = trim(row[j]);
        if (!t) continue;
        if (/项目|科目|报表项目|项目名称/.test(t) && nameCol < 0) nameCol = j;
        else if (/(期末余额|期末数|本期金额|本月数|本期发生额|期末)/.test(t) && curCol < 0) curCol = j;
        else if (/(年初余额|年初数|上期金额|上年同期|本年累计数|期初余额|期初数|上期数)/.test(t) && prevCol < 0) prevCol = j;
        else if (/(行次|行号)/.test(t)) { /* 行次列忽略 */ }
      }
      if (nameCol >= 0 && curCol >= 0) return { idx: i, nameCol: nameCol, curCol: curCol, prevCol: prevCol };
    }
    return null;
  }

  // 从报表中提取期间（如 "2026年8月" / "2026年1-6月" / "2026-08"）
  function extractPeriod(rows) {
    var limit = Math.min(rows.length, 12);
    for (var i = 0; i < limit; i++) {
      var row = rows[i] || [];
      for (var j = 0; j < row.length; j++) {
        var t = trim(row[j]);
        if (!t) continue;
        var m = t.match(/(\d{4})\s*年\s*(\d{1,2})\s*月/);
        if (m) return m[1] + '年' + Number(m[2]) + '月';
        m = t.match(/(\d{4})[-\/](\d{1,2})/);
        if (m) return m[1] + '年' + Number(m[2]) + '月';
      }
    }
    return '';
  }

  // 报表标题（第一行若为 利润表/资产负债表/现金流量表 等）
  function extractTitle(rows) {
    for (var i = 0; i < Math.min(rows.length, 3); i++) {
      var row = rows[i] || [];
      for (var j = 0; j < row.length; j++) {
        var t = trim(row[j]);
        if (/^(利润表|资产负债表|现金流量表|合并利润表|合并资产负债表|合并现金流量表)/.test(t)) return t;
      }
    }
    return '';
  }

  // 判断是否为无效行（单位/编制单位/报表日期/会计期间/纯数字等元信息）
  function isMetaRow(cells, nameCol) {
    var name = trim(cells[nameCol]);
    if (!name) return true;
    if (/^(单位|编制单位|会计期间|报表日期|日期|金额单位|单位：|制表|审核|会计主管|会企|会财|第\s*\d+\s*页)/.test(name)) return true;
    if (/^\d+(\.\d+)?$/.test(name)) return true; // 纯数字行次残留
    if (/^行次|^项目/.test(name)) return true;
    return false;
  }

  /* ---------- 解析单张报表 ----------
   * rows: 二维数组（Excel sheet 或 docx 表格或 textLinesToRows 输出）
   * 返回 { type, label, title, period, items: [{name,current,previous}], mapping, rowCount }
   */
  function parseStatement(rows) {
    var src = (rows || []).filter(function (r) { return Array.isArray(r) && r.some(function (c) { return trim(c) !== ''; }); });
    var typeInfo = detectStatementType(src);
    var header = findHeader(src);
    if (!header) {
      return { type: typeInfo.type, label: typeInfo.label, title: extractTitle(src), period: extractPeriod(src), items: [], mapping: null, rowCount: src.length };
    }
    var items = [];
    for (var i = header.idx + 1; i < src.length; i++) {
      var row = src[i];
      if (isMetaRow(row, header.nameCol)) continue;
      var name = trim(row[header.nameCol]);
      var cur = header.curCol >= 0 ? normalizeAmount(row[header.curCol]) : null;
      var prev = header.prevCol >= 0 ? normalizeAmount(row[header.prevCol]) : null;
      if (cur === null && prev === null) continue;
      // 跳过合计/总计行（保留用于指标，但标记）
      var isTotal = /(合计|总计|净额)/.test(name);
      items.push({ name: name, current: cur, previous: prev, isTotal: isTotal });
    }
    return {
      type: typeInfo.type, label: typeInfo.label,
      title: extractTitle(src), period: extractPeriod(src),
      items: items,
      mapping: { nameCol: header.nameCol, curCol: header.curCol, prevCol: header.prevCol },
      rowCount: src.length
    };
  }

  /* ---------- OCR / PDF 文本行 → 表格行 ----------
   * 输入 ["营业收入 1234567.89", ...] 或 [["营业收入 1234567.89"], ...]
   * 输出 [[科目, 金额1, 金额2?], ...]，可交给 parseStatement
   */
  function textLinesToRows(lines) {
    var out = [];
    (lines || []).forEach(function (ln) {
      var s = trim(Array.isArray(ln) ? ln.join(' ') : ln);
      if (!s) return;
      // 跳过明显非科目行
      if (/^(单位|编制|会计期间|报表日期|日期|金额|会企|制表|审核|注|第)\s*[:：]/.test(s)) return;
      if (/^\d{4}\s*[年\-\/]/.test(s) && !/\d/.test(s.replace(/^\d{4}\s*[年\-\/].*/, ''))) return; // 日期行
      // 形态1："科目 金额" / "科目 金额 金额"（空格/制表分隔）
      var m = s.match(/^([\u4e00-\u9fa5A-Za-z（）()·、和与%％\d]+?)\s+(-?[\d,，.]+)\s*(-?[\d,，.]+)?\s*$/);
      if (!m) {
        // 形态2：OCR 无空格 "营业收入1,234,567.89"
        m = s.match(/^([\u4e00-\u9fa5A-Za-z（）()·、和与%％]+?)(-?[\d,，.]+)\s*(-?[\d,，.]+)?\s*$/);
      }
      if (!m) return;
      var name = m[1].trim();
      if (!/[\u4e00-\u9fa5]/.test(name) || /^(合计|总计)$/.test(name)) return;
      out.push([name, m[2].replace(/,/g, '').replace(/，/g, ''), m[3] ? m[3].replace(/,/g, '').replace(/，/g, '') : '']);
    });
    return out;
  }

  /* ---------- 工具：模糊查找科目 ---------- */
  // items: parseStatement 的 items；kws: 关键词数组
  // 匹配策略：先全等（如「负债合计」优先于「流动负债合计」），再包含兜底
  function findItem(items, kws) {
    if (!items) return null;
    var kwsArr = Array.isArray(kws) ? kws : [kws];
    // 第一轮：全等
    for (var k = 0; k < kwsArr.length; k++) {
      for (var i = 0; i < items.length; i++) {
        if (items[i].name === kwsArr[k]) return items[i];
      }
    }
    // 第二轮：包含
    for (var i2 = 0; i2 < items.length; i2++) {
      var it = items[i2];
      for (var k2 = 0; k2 < kwsArr.length; k2++) {
        if (it.name.indexOf(kwsArr[k2]) >= 0) return it;
      }
    }
    return null;
  }

  function n(v) { return v === null || v === undefined ? 0 : v; }

  function pct(a, b) {
    if (b === 0) return 0;
    return round2(a / b * 100);
  }

  /* ---------- 综合财务分析 ----------
   * statements: parseStatement 输出数组（可多份，取每种类型第一份）
   * 返回 { kind:'finAnalysis', title, period, used:{...}, indicators:[...], checks:[...], alerts:[...], sourceCount }
   */
  function buildFinAnalysis(statements, opts) {
    var o = opts || {};
    // 保留未知类型（items 可能为空）以给出「未识别」提示；其余类型需有科目数据
    var st = (statements || []).filter(function (s) {
      return s && (s.type === 'unknown' || (s.items && s.items.length));
    });
    var income = st.filter(function (s) { return s.type === 'income'; })[0] || null;
    var balance = st.filter(function (s) { return s.type === 'balance'; })[0] || null;
    var cashflow = st.filter(function (s) { return s.type === 'cashflow'; })[0] || null;
    var unknown = st.filter(function (s) { return s.type === 'unknown'; });

    var indicators = [], checks = [], alerts = [];
    var period = o.period || income && income.period || balance && balance.period || cashflow && cashflow.period || '';

    var rev = income ? findItem(income.items, ['营业收入']) : null;
    var cost = income ? findItem(income.items, ['营业成本']) : null;
    var netP = income ? findItem(income.items, ['净利润']) : null;
    var gross = rev ? round2(n(rev.current) - n(cost ? cost.current : 0)) : null;

    // ---- 盈利能力 ----
    var profitGroup = { title: '盈利能力', items: [] };
    if (income) {
      profitGroup.period = income.period || '';
      if (rev) {
        profitGroup.items.push({ name: '营业收入', value: rev.current, prev: rev.previous, fmt: 'money' });
        if (rev.previous !== null) {
          profitGroup.items.push({ name: '收入同比', value: pct(round2(rev.current - rev.previous), rev.previous), fmt: 'pct' });
        }
      }
      if (gross !== null) profitGroup.items.push({ name: '毛利', value: gross, fmt: 'money' });
      if (rev && gross !== null) profitGroup.items.push({ name: '毛利率', value: pct(gross, rev.current), fmt: 'pct' });
      if (netP) {
        profitGroup.items.push({ name: '净利润', value: netP.current, prev: netP.previous, fmt: 'money' });
        if (rev && rev.current !== 0) profitGroup.items.push({ name: '净利率', value: pct(netP.current, rev.current), fmt: 'pct' });
      }
      // 期间费用合计
      var sExp = findItem(income.items, ['销售费用']), mExp = findItem(income.items, ['管理费用']), fExp = findItem(income.items, ['财务费用']);
      var totalExp = n(sExp ? sExp.current : 0) + n(mExp ? mExp.current : 0) + n(fExp ? fExp.current : 0);
      if (totalExp !== 0) {
        profitGroup.items.push({ name: '期间费用率', value: rev && rev.current !== 0 ? pct(totalExp, rev.current) : 0, fmt: 'pct', sub: '销售' + n(sExp ? sExp.current : 0) + ' + 管理' + n(mExp ? mExp.current : 0) + ' + 财务' + n(fExp ? fExp.current : 0) });
      }
      if (netP && netP.current < 0) alerts.push({ level: 'bad', text: '本期净利润为负（' + fmtMoney(netP.current) + '），处于亏损状态，需关注主营业务盈利能力与成本控制。' });
      if (netP && netP.previous !== null && netP.previous < 0 && netP.current >= 0) alerts.push({ level: 'ok', text: '净利润由亏转盈，经营状况改善。' });
      if (rev && rev.current > 0 && gross !== null && gross / rev.current < 0.1) alerts.push({ level: 'warn', text: '毛利率仅 ' + pct(gross, rev.current).toFixed(1) + '%，偏低，需核查定价或成本结构。' });
    }
    if (profitGroup.items.length) indicators.push(profitGroup);

    // ---- 偿债与资本结构 ----
    var debtGroup = { title: '偿债与资本结构', items: [] };
    if (balance) {
      debtGroup.period = balance.period || '';
      var ta = findItem(balance.items, ['资产总计']);
      var tl = findItem(balance.items, ['负债合计']);
      var eq = findItem(balance.items, ['所有者权益']);
      var ca = findItem(balance.items, ['流动资产合计']);
      var cl = findItem(balance.items, ['流动负债合计']);
      var cash = findItem(balance.items, ['货币资金']);
      if (ta) debtGroup.items.push({ name: '资产总计', value: ta.current, prev: ta.previous, fmt: 'money' });
      if (tl) debtGroup.items.push({ name: '负债合计', value: tl.current, fmt: 'money' });
      if (eq) debtGroup.items.push({ name: '所有者权益', value: eq.current, fmt: 'money' });
      if (ta && ta.current !== 0 && tl) {
        var dar = pct(tl.current, ta.current);
        debtGroup.items.push({ name: '资产负债率', value: dar, fmt: 'pct' });
        if (dar > 70) alerts.push({ level: 'warn', text: '资产负债率 ' + dar.toFixed(1) + '%，偏高，偿债压力较大，建议控制新增负债。' });
        else if (dar > 50) alerts.push({ level: 'warn', text: '资产负债率 ' + dar.toFixed(1) + '%，处于中高水平，关注财务杠杆。' });
        else if (dar < 20) alerts.push({ level: 'info', text: '资产负债率 ' + dar.toFixed(1) + '%，财务结构稳健，但可适度利用杠杆提升资金效率。' });
      }
      if (ca && cl && cl.current !== 0) {
        var cr = round2(ca.current / cl.current);
        debtGroup.items.push({ name: '流动比率', value: cr, fmt: 'ratio', sub: '流动资产 ' + fmtMoney(ca.current) + ' / 流动负债 ' + fmtMoney(cl.current) });
        if (cr < 1) alerts.push({ level: 'bad', text: '流动比率 ' + cr.toFixed(2) + '（<1），短期偿债能力不足，存在流动性风险。' });
        else if (cr < 1.5) alerts.push({ level: 'warn', text: '流动比率 ' + cr.toFixed(2) + '，短期偿债能力偏紧。' });
        else alerts.push({ level: 'ok', text: '流动比率 ' + cr.toFixed(2) + '，短期偿债能力良好。' });
      }
      if (cash) debtGroup.items.push({ name: '货币资金', value: cash.current, prev: cash.previous, fmt: 'money' });
    }
    if (debtGroup.items.length) indicators.push(debtGroup);

    // ---- 现金流量 ----
    var cfGroup = { title: '现金流量', items: [] };
    if (cashflow) {
      cfGroup.period = cashflow.period || '';
      ['经营', '投资', '筹资'].forEach(function (k) {
        var it = findItem(cashflow.items, [k + '活动产生的现金流量净额']);
        if (it) cfGroup.items.push({ name: k + '活动净额', value: it.current, prev: it.previous, fmt: 'money' });
      });
      var endCash = findItem(cashflow.items, ['期末现金及现金等价物余额', '期末现金及现金等价物']);
      if (endCash) cfGroup.items.push({ name: '期末现金及等价物', value: endCash.current, fmt: 'money' });
      var opNet = findItem(cashflow.items, ['经营活动产生的现金流量净额']);
      if (opNet) {
        if (opNet.current < 0) alerts.push({ level: 'warn', text: '经营活动现金流净额为负（' + fmtMoney(opNet.current) + '），经营造血不足，需核查回款与垫付情况。' });
        else alerts.push({ level: 'ok', text: '经营活动现金流净额 ' + fmtMoney(opNet.current) + '，经营造血能力正常。' });
      }
    }
    if (cfGroup.items.length) indicators.push(cfGroup);

    // ---- 勾稽校验（三表联动） ----
    if (balance) {
      var ta2 = findItem(balance.items, ['资产总计']);
      var tl2 = findItem(balance.items, ['负债合计']);
      var eq2 = findItem(balance.items, ['所有者权益']);
      if (ta2 && tl2 && eq2) {
        var diff = round2(n(ta2.current) - n(tl2.current) - n(eq2.current));
        checks.push({
          ok: Math.abs(diff) <= 1,
          title: '资产负债表平衡校验',
          detail: '资产总计 ' + fmtMoney(n(ta2.current)) + ' = 负债合计 ' + fmtMoney(n(tl2.current)) + ' + 所有者权益 ' + fmtMoney(n(eq2.current)) +
            (Math.abs(diff) <= 1 ? '，勾稽平衡 ✓' : '，差异 ' + fmtMoney(diff) + '，请核对报表数据。')
        });
      }
    }
    if (income && balance) {
      var netP2 = findItem(income.items, ['净利润']);
      var und = findItem(balance.items, ['未分配利润']);
      if (netP2 && und && und.previous !== null) {
        var undDiff = round2(n(und.current) - n(und.previous));
        var gap = round2(undDiff - n(netP2.current));
        var tol = Math.max(1, Math.abs(n(netP2.current)) * 0.05);
        checks.push({
          ok: Math.abs(gap) <= tol,
          title: '净利润 ↔ 未分配利润变动',
          detail: '未分配利润期末 - 年初 = ' + fmtMoney(undDiff) + '，本期净利润 ' + fmtMoney(n(netP2.current)) +
            (Math.abs(gap) <= tol ? '，勾稽一致 ✓' : '，差异 ' + fmtMoney(gap) + '（可能存在分红、利润分配或前期差错调整）。')
        });
      }
    }
    if (cashflow && balance) {
      var endCash2 = findItem(cashflow.items, ['期末现金及现金等价物余额', '期末现金及现金等价物']);
      var cash2 = findItem(balance.items, ['货币资金']);
      if (endCash2 && cash2) {
        var cGap = round2(Math.abs(n(endCash2.current) - n(cash2.current)));
        var cTol = Math.max(1, Math.abs(n(endCash2.current)) * 0.05);
        checks.push({
          ok: cGap <= cTol,
          title: '期末现金 ↔ 货币资金',
          detail: '现金流量表期末现金 ' + fmtMoney(n(endCash2.current)) + '，资产负债表货币资金 ' + fmtMoney(n(cash2.current)) +
            (cGap <= cTol ? '，口径一致 ✓' : '，差异 ' + fmtMoney(cGap) + '（可能存在受限资金、保证金或编制口径差异）。')
        });
      }
    }
    if (!checks.length) checks.push({ ok: true, title: '勾稽校验', detail: '报表齐全（资产负债表/利润表/现金流量表）后可执行三表联动校验。' });

    // 未识别文件提示
    if (unknown.length) alerts.push({ level: 'warn', text: '有 ' + unknown.length + ' 个文件未能识别为财务报表类型，请确认文件内容为利润表/资产负债表/现金流量表。' });

    // 缺少报表提示
    var missing = [];
    if (!income) missing.push('利润表');
    if (!balance) missing.push('资产负债表');
    if (!cashflow) missing.push('现金流量表');
    if (missing.length) alerts.push({ level: 'info', text: '未上传' + missing.join('、') + '，相关指标与勾稽校验将跳过。' });

    return {
      kind: 'finAnalysis',
      title: '财务报表综合分析' + (period ? '（' + period + '）' : ''),
      period: period,
      income: income, balance: balance, cashflow: cashflow,
      unknown: unknown,
      indicators: indicators,
      checks: checks,
      alerts: alerts,
      sourceCount: st.length
    };
  }

  /* ---------- 4 段式 AI 报告 ---------- */
  function buildFinAnalysisPrompt(data) {
    var d = data || {};
    var sys = '你是资深财务分析师。基于用户上传的企业财务报表（资产负债表/利润表/现金流量表）解析数据，撰写约 500 字的中文财务分析报告，严格按 4 个固定段落：' +
      '一、总体概览（资产规模、收入、净利润、经营现金流一句话总结）；二、盈利能力与费用（毛利率/净利率/期间费用率，异常原因提示）；' +
      '三、偿债能力与现金流健康度（资产负债率/流动比率/三大活动净额，判断资金安全垫）；四、业务提示与风险（勾稽异常、数据缺口、改进建议）。' +
      '只依据给定数据客观分析，禁止编造数字或事实；数字保留两位小数；简洁专业。';

    var pick = function (g) {
      return (g || []).map(function (x) {
        return { name: x.name, value: x.value, prev: x.prev !== undefined ? x.prev : null, sub: x.sub || '' };
      });
    };
    var user = JSON.stringify({
      period: d.period || '',
      indicators: (d.indicators || []).map(function (g) { return { group: g.title, items: pick(g.items) }; }),
      checks: d.checks || [],
      alerts: d.alerts || [],
      sourceCount: d.sourceCount || 0
    }, null, 2);
    return { system: sys, user: user };
  }

  function fmtMoney(n) {
    var v = n === null || n === undefined ? 0 : n;
    return '¥' + Number(v).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  // 未配置大模型时的规则模板降级（同 4 段结构）
  function templateFinAnalysis(data) {
    var d = data || {};
    var parts = [];

    parts.push('一、总体概览');
    var inc = d.indicators ? d.indicators.filter(function (g) { return g.title === '盈利能力'; })[0] : null;
    var debt = d.indicators ? d.indicators.filter(function (g) { return g.title === '偿债与资本结构'; })[0] : null;
    var cf = d.indicators ? d.indicators.filter(function (g) { return g.title === '现金流量'; })[0] : null;
    var v = function (g, name) { return g ? (function () { var it = g.items.filter(function (x) { return x.name.indexOf(name) >= 0; })[0]; return it ? it.value : null; })() : null; };
    var rev = v(inc, '营业收入'), netP = v(inc, '净利润'), ta = v(debt, '资产总计'), opNet = v(cf, '经营活动');
    parts.push('本期' + (d.period || '') + '：营业收入 ' + fmtMoney(rev === null ? 0 : rev) + '，净利润 ' + fmtMoney(netP === null ? 0 : netP) +
      '，资产总计 ' + fmtMoney(ta === null ? 0 : ta) + '，经营活动现金流净额 ' + fmtMoney(opNet === null ? 0 : opNet) + '。');

    parts.push('二、盈利能力与费用');
    if (inc && inc.items.length) {
      inc.items.slice(0, 4).forEach(function (it) {
        parts.push('- ' + it.name + '：' + (it.fmt === 'pct' ? it.value.toFixed(1) + '%' : fmtMoney(it.value)) + (it.sub ? '（' + it.sub + '）' : ''));
      });
      var net = v(inc, '净利润');
      if (net !== null && net < 0) parts.push('本期亏损，建议重点核查成本与费用控制、回款效率。');
      else parts.push('整体盈利能力' + ((net !== null && net >= 0) ? '正常' : '待完善') + '，关注毛利率与费用率变化趋势。');
    } else {
      parts.push('未上传利润表，无法评估盈利能力。');
    }

    parts.push('三、偿债能力与现金流健康度');
    if (debt && debt.items.length) {
      var dar = v(debt, '资产负债率'), cr = v(debt, '流动比率');
      if (dar !== null) parts.push('- 资产负债率 ' + dar.toFixed(1) + '%，' + (dar > 70 ? '偏高，偿债压力较大。' : dar > 50 ? '处于中高水平，关注杠杆变化。' : '结构稳健。'));
      if (cr !== null) parts.push('- 流动比率 ' + cr.toFixed(2) + '，' + (cr < 1 ? '短期偿债能力不足。' : cr < 1.5 ? '偏紧，需关注流动性。' : '短期偿债能力良好。'));
    } else {
      parts.push('未上传资产负债表，无法评估偿债能力。');
    }
    if (cf && cf.items.length) {
      cf.items.forEach(function (it) { parts.push('- ' + it.name + '：' + fmtMoney(it.value)); });
      if (opNet !== null && opNet < 0) parts.push('经营现金流为负，注意回款与垫资压力。');
    } else {
      parts.push('未上传现金流量表，无法评估现金流结构。');
    }

    parts.push('四、业务提示与风险');
    var tips = (d.alerts || []).filter(function (a) { return a.level === 'warn' || a.level === 'bad'; });
    if (tips.length) {
      tips.slice(0, 4).forEach(function (t) { parts.push('- ' + t.text); });
    } else if (d.checks && d.checks.some(function (c) { return !c.ok; })) {
      parts.push('- 存在勾稽校验异常项，请逐项核对报表数据（详见校验清单）。');
    } else {
      parts.push('- 三表勾稽校验通过，数据质量良好；建议按月连续上传报表，持续跟踪趋势。');
    }
    if (d.sourceCount && d.sourceCount < 3) parts.push('- 当前仅上传 ' + d.sourceCount + ' 张报表，补齐后分析更完整。');
    return parts.join('\n');
  }

  var FinStat = {
    detectStatementType: detectStatementType,
    parseStatement: parseStatement,
    textLinesToRows: textLinesToRows,
    findItem: findItem,
    buildFinAnalysis: buildFinAnalysis,
    buildFinAnalysisPrompt: buildFinAnalysisPrompt,
    templateFinAnalysis: templateFinAnalysis,
    normalizeAmount: normalizeAmount,
    fmtMoney: fmtMoney
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = FinStat;
  else global.FinStat = FinStat;
})(typeof window !== 'undefined' ? window : globalThis);
