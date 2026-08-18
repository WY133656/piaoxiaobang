/* ============================================================
 * 票小帮 · 银行流水自动对账引擎（纯函数 UMD 模块）
 * 功能：
 *   1) parseBankRows(sheetRows) — 智能识别银行流水 Excel 列头
 *      （日期/对方/收入/支出/发生额/余额），标准化为统一记录
 *   2) matchLedger(ledger, bankRows) — 与发票台账自动匹配：
 *      金额（精确到分）+ 对方名称 + 收支方向 + 日期窗口 综合打分
 *   3) matchBusiness(bankRows, bizDocs) — 与业务单据「阶梯式匹配」：
 *      L1 强匹配（金额+户名一致）/ L2 容差匹配（±5元+日期≤3天）/
 *      L3 模糊关联（金额同户名略异→人工确认）
 *   4) buildReconIssues(result) — 红蓝橙三类异常异议表
 *      🔴长款：银行有账业务无单  🔵短款：业务有单银行无账  🟠重复：单号被多条流水核销
 *   5) buildCollectionBoard(result) — 回款看板（客户应付款 vs 银行已到账）
 *   6) buildReconWorkbook(bankRows) — 对账结果 Excel 工作簿
 *   7) analyzeUnmatchedPrompt(...) — 构造「AI 分析未匹配原因」提示词
 * 口径说明：
 *   - 台账发票按「购买方=本公司」视为支出（采购/报销）
 *   - 按「销售方=本公司」视为收入（销售开票）
 *   - 流水方向：in=收款（贷方/收入），out=付款（借方/支出）
 *   - 业务单据：type='应收' 对应流水 in，type='应付' 对应流水 out
 * ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 工具 ---------- */

  function pad2(n) { return String(n).padStart(2, '0'); }
  function pad4(n) { return String(n).padStart(4, '0'); }

  function num(v) {
    var n = parseFloat(String(v == null ? '' : v).replace(/[,，¥￥\s]/g, ''));
    return isNaN(n) ? 0 : n;
  }

  function round2(v) {
    var n = num(v);
    return Math.round(n * 100) / 100;
  }

  // 价税合计（金额 + 税额）
  function totalOf(inv) {
    if (!inv) return 0;
    return round2(round2(inv.amount) + round2(inv.tax));
  }

  // 统一日期为 yyyy-mm-dd（兼容 Excel 序列号 / 中文 / 斜杠 / 连续数字）
  function normalizeDateStr(v) {
    if (v === null || v === undefined || v === '') return '';
    var s = String(v).trim();
    if (/^\d{5}$/.test(s)) {
      var n = parseFloat(s);
      if (n > 20000 && n < 60000) {
        var d = new Date(Math.round((n - 25569) * 86400000));
        if (!isNaN(d.getTime())) return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
      }
    }
    var m = s.match(/(\d{4})[年\-\/. ](\d{1,2})[月\-\/. ](\d{1,2})日?/);
    if (m) return pad4(m[1]) + '-' + pad2(m[2]) + '-' + pad2(m[3]);
    m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    return s;
  }

  function dateTs(s) {
    var m = String(s || '').match(/(\d{4})[年\-\/. ](\d{1,2})[月\-\/. ](\d{1,2})日?/);
    if (!m) return NaN;
    return new Date(+m[1], +m[2] - 1, +m[3]).getTime();
  }

  function inWindow(rowDate, invDate, days) {
    var a = dateTs(rowDate), b = dateTs(invDate);
    if (isNaN(a) || isNaN(b)) return false;
    return Math.abs(a - b) <= days * 86400000;
  }

  // 公司名核心词（去后缀/括号/符号）
  function nameCore(n) {
    var s = String(n || '')
      .replace(/(股份有限公司|有限责任公司|有限公司|集团有限公司)/g, '')
      .replace(/[（(][^）)]*[）)]/g, '')
      .replace(/[^0-9a-zA-Z\u4e00-\u9fa5]/g, '');
    return s;
  }

  // 双方名称是否指向同一实体（全等 / 包含核心词前4字 / 简称包含）
  function namesOverlap(a, b) {
    if (!a || !b) return false;
    var ca = nameCore(a), cb = nameCore(b);
    if (!ca || !cb) return false;
    if (ca === cb) return true;
    if (ca.length >= 4 && cb.indexOf(ca.slice(0, 4)) >= 0) return true;
    if (cb.length >= 4 && ca.indexOf(cb.slice(0, 4)) >= 0) return true;
    if (ca.indexOf(cb) >= 0 || cb.indexOf(ca) >= 0) return true;
    return false;
  }

  /* ---------- 列头智能识别 ---------- */

  var HEADER_RULES = [
    { key: 'date', keywords: ['交易日期', '记账日期', '交易时间', '发生日期', '业务日期', '日期'] },
    { key: 'counterparty', keywords: ['对方户名', '交易对方', '对方名称', '对方单位', '对方账号名称', '户名', '摘要', '用途', '附言'] },
    { key: 'income', keywords: ['贷方金额', '贷方发生额', '贷方', '收入金额', '存入', '收款', '转入', '收方金额'] },
    { key: 'expense', keywords: ['借方金额', '借方发生额', '借方', '支出金额', '支取', '付款', '转出', '付方金额'] },
    { key: 'amount', keywords: ['发生额', '交易金额', '发生金额', '金额'] },
    { key: 'balance', keywords: ['账户余额', '可用余额', '余额'] },
    { key: 'summary', keywords: ['交易摘要', '摘要', '用途', '附言', '交易说明', '备注'] }
  ];

  // counterparty 的兜底关键词（摘要/用途/附言 在严格匹配完“对方”列后才启用）
  var CP_FALLBACK = ['摘要', '用途', '附言'];

  function cellText(c) {
    if (c === null || c === undefined) return '';
    return String(c).trim();
  }

  // 在前 N 行内找表头行，返回 { idx, map }
  // 两阶段：先严格匹配“对方户名”类列，找不到再退而匹配“摘要/用途/附言”
  function findHeaderRow(sheetRows) {
    var limit = Math.min(sheetRows.length, 6);
    for (var i = 0; i < limit; i++) {
      var row = sheetRows[i] || [];
      var map = {};
      var usedCols = {};

      // 阶段一：严格匹配（除 counterparty 兜底词外的全部规则）
      for (var j = 0; j < row.length; j++) {
        var t = cellText(row[j]);
        if (!t) continue;
        for (var r = 0; r < HEADER_RULES.length; r++) {
          var rule = HEADER_RULES[r];
          if (map[rule.key] !== undefined) continue;
          var isCp = rule.key === 'counterparty';
          for (var k = 0; k < rule.keywords.length; k++) {
            var kw = rule.keywords[k];
            if (isCp && CP_FALLBACK.indexOf(kw) >= 0) continue; // 兜底词留到阶段二
            if (t.indexOf(kw) >= 0 && usedCols[j] === undefined) {
              map[rule.key] = j;
              usedCols[j] = true;
              break;
            }
          }
        }
      }

      // 阶段二：counterparty 兜底——用“摘要/用途/附言”列
      if (map.counterparty === undefined) {
        for (var j2 = 0; j2 < row.length; j2++) {
          var t2 = cellText(row[j2]);
          if (!t2) continue;
          for (var f = 0; f < CP_FALLBACK.length; f++) {
            if (t2.indexOf(CP_FALLBACK[f]) >= 0 && usedCols[j2] === undefined) {
              map.counterparty = j2;
              usedCols[j2] = true;
              break;
            }
          }
          if (map.counterparty !== undefined) break;
        }
      }

      // 无“对方户名”列时，摘要把关：摘要列降级为对方户名
      if (map.counterparty === undefined && map.summary !== undefined) {
        map.counterparty = map.summary;
        delete map.summary;
      }

      if (map.date !== undefined || map.amount !== undefined || map.income !== undefined || map.expense !== undefined) {
        return { idx: i, map: map };
      }
    }
    return null;
  }

  /* ---------- 流水标准化 ---------- */

  function parseBankRows(sheetRows) {
    if (!sheetRows || !sheetRows.length) return [];
    var header = findHeaderRow(sheetRows);
    if (!header) return [];
    var map = header.map;
    var out = [];

    for (var i = header.idx + 1; i < sheetRows.length; i++) {
      var r = sheetRows[i] || [];
      var hasVal = r.some(function (c) { return c !== '' && c !== null && c !== undefined; });
      if (!hasVal) continue;

      var row = {
        rowIdx: i + 1,
        date: '',
        counterparty: '',
        summary: '',    // 摘要/用途列（现金流分类数据源）
        direction: '',      // 'in' 收款 | 'out' 付款
        amount: 0,
        balance: ''
      };
      if (map.date !== undefined) row.date = normalizeDateStr(r[map.date]);
      if (map.counterparty !== undefined) row.counterparty = cellText(r[map.counterparty]);
      if (map.summary !== undefined) row.summary = cellText(r[map.summary]);
      if (map.balance !== undefined) row.balance = cellText(r[map.balance]);

      var inc = map.income !== undefined ? num(r[map.income]) : NaN;
      var exp = map.expense !== undefined ? num(r[map.expense]) : NaN;

      if (!isNaN(inc) && inc > 0) {
        row.direction = 'in'; row.amount = inc;
      } else if (!isNaN(exp) && exp > 0) {
        row.direction = 'out'; row.amount = exp;
      } else if (map.amount !== undefined) {
        var a = num(r[map.amount]);
        if (a !== 0) {
          row.amount = Math.abs(a);
          row.direction = a > 0 ? 'in' : 'out'; // 正收负支（常见银行导出口径）
        }
      }
      if (row.amount > 0) out.push(row);
    }
    return out;
  }

  /* ---------- 与台账匹配 ---------- */

  function matchRow(row, invs, myFn, windowDays) {
    var candidates = invs.filter(function (inv) {
      var t = totalOf(inv);          // 价税合计（实际支付金额）
      var amt = round2(inv.amount);  // 不含税金额（部分流水口径）
      return (t > 0 && Math.abs(t - row.amount) <= 0.01) || (amt > 0 && Math.abs(amt - row.amount) <= 0.01);
    });
    if (!candidates.length) {
      return { status: 'unmatched', reason: '台账无对应金额发票', inv: null };
    }

    var best = null, bestScore = 0;
    candidates.forEach(function (inv) {
      var isIncomeInv = !!myFn(inv.seller); // 销售方=本公司 → 收入发票
      var dirOk = row.direction === 'in' ? isIncomeInv : !isIncomeInv;
      var party = row.direction === 'in' ? (inv.buyer || '') : (inv.seller || '');
      var nameOk = namesOverlap(row.counterparty, party);
      var dateOk = inWindow(row.date, inv.date, windowDays);
      var score = (nameOk ? 1 : 0) + (dateOk ? 0.5 : 0) + (dirOk ? 0.5 : 0);
      if (score > bestScore) {
        bestScore = score;
        best = { inv: inv, dirOk: dirOk, nameOk: nameOk, dateOk: dateOk };
      }
    });

    if (best && best.nameOk && best.dirOk) {
      return {
        status: 'matched',
        inv: best.inv,
        warning: best.dateOk ? '' : '日期超出窗口',
        reason: best.dateOk ? '' : '日期超出窗口'
      };
    }
    var reasons = [];
    if (!best.nameOk) reasons.push('对方名称不匹配');
    if (!best.dirOk) reasons.push('收支方向不符');
    if (!best.dateOk) reasons.push('日期超出窗口');
    if (!reasons.length) reasons.push('信息不完整');
    return { status: 'unmatched', inv: best.inv, reason: reasons.join('；') };
  }

  // ledger: 台账数组；bankRows: parseBankRows 输出
  // opts: { dateWindow: 天数(默认45), isMyCompanyFn: 判断"销售方是否本公司"的函数 }
  function matchLedger(ledger, bankRows, opts) {
    var o = opts || {};
    var windowDays = o.dateWindow !== undefined ? o.dateWindow : 45;
    var myFn = o.isMyCompanyFn || function () { return false; };
    var invs = (ledger || []).filter(function (inv) {
      return inv && inv.amount && totalOf(inv) > 0;
    });

    var matchedCount = 0, inAmount = 0, outAmount = 0, matchedAmount = 0;
    var rows = (bankRows || []).map(function (row) {
      var res = matchRow(row, invs, myFn, windowDays);
      var m = Object.assign({}, row, res);
      if (res.status === 'matched') {
        matchedCount++;
        matchedAmount += row.amount;
        m.invoiceNumber = res.inv.number || '';
        m.invoiceTotal = totalOf(res.inv);
        m.invoiceParty = row.direction === 'in' ? (res.inv.buyer || '') : (res.inv.seller || '');
        m.invoiceDate = res.inv.date || '';
      }
      if (row.direction === 'in') inAmount += row.amount;
      else outAmount += row.amount;
      return m;
    });

    var stats = {
      total: rows.length,
      matched: matchedCount,
      unmatched: rows.length - matchedCount,
      inAmount: round2(inAmount),
      outAmount: round2(outAmount),
      matchedAmount: round2(matchedAmount)
    };
    return { rows: rows, stats: stats };
  }

  /* ---------- 业务单据 · 阶梯式匹配 ---------- */

  // bizDocs 标准化结构：{ docNo, type('应收'|'应付'), party, amount, dueDate, note }
  // 方向映射：应收→银行 in，应付→银行 out
  function docDirOk(row, doc) {
    return row.direction === 'in' ? doc.type === '应收' : doc.type === '应付';
  }

  function dateDiffDays(a, b) {
    var ta = dateTs(a), tb = dateTs(b);
    if (isNaN(ta) || isNaN(tb)) return Infinity;
    return Math.abs(ta - tb) / 86400000;
  }

  // 阶梯式匹配：bankRows（parseBankRows 输出）↔ bizDocs（业务单据）
  // opts: { tol: 容差金额(默认5), dateWindow: 日期容差天数(默认3) }
  // 返回 { rows: 流水视角, docs: 单据核销视角, stats }
  // 匹配规则（用户方案三要素，优先级自上而下）：
  //   L1 强匹配   金额相等(±0.01) + 户名核心词全等        → 自动通过
  //   L3 模糊关联 金额相等但户名仅重叠（简称/漏字）       → 人工确认 pending（先于 L2）
  //   L2 容差匹配 金额有差异(±tol 内) + 日期差 ≤dateWindow + 户名重叠 → 自动通过 + 标记容差
  //   重复入账   金额户名均符合 L1 但单号已被核销完       → duplicate（橙字）
  function matchBusiness(bankRows, bizDocs, opts) {
    var o = opts || {};
    var tol = o.tol !== undefined ? o.tol : 5;
    var dateWindow = o.dateWindow !== undefined ? o.dateWindow : 3;
    var docs = (bizDocs || []).filter(function (d) { return d && d.amount > 0; });
    var docMatched = docs.map(function () { return 0; });   // 每张单据累计已核销金额
    var docRowIdx = docs.map(function () { return []; });   // 每张单据被哪些流水行核销

    var rows = (bankRows || []).map(function (row) {
      var base = {
        matchLevel: '', status: 'unmatched', docNo: '', docParty: '',
        docAmount: '', diff: '', tolerance: false, fuzzy: false, reason: ''
      };
      var m = Object.assign({}, row, base);

      // 候选：方向一致的单据
      var cands = [];
      docs.forEach(function (d, di) {
        if (!docDirOk(row, d)) return;
        cands.push({
          di: di, d: d,
          diffAmt: round2(d.amount) - round2(row.amount),
          diffDays: dateDiffDays(row.date, d.dueDate),
          nameEq: nameCore(row.counterparty) === nameCore(d.party) && !!nameCore(d.party),
          nameOver: namesOverlap(row.counterparty, d.party),
          available: docMatched[di] < d.amount - 0.01  // 未核销完
        });
      });
      if (!cands.length) {
        m.reason = '业务端无同方向单据';
        return m;
      }

      // L1 强匹配（含重复检测）：金额相等 + 户名核心词全等
      var l1 = cands.filter(function (c) { return Math.abs(c.diffAmt) <= 0.01 && c.nameEq; });
      if (l1.length) {
        var best1 = l1.sort(function (a, b) { return a.diffDays - b.diffDays; })[0];
        if (!best1.available) {
          // 单号已被其它流水核销完 → 重复入账嫌疑（橙字）
          m.matchLevel = 'L1'; m.status = 'duplicate';
          m.docNo = best1.d.docNo; m.docParty = best1.d.party;
          m.docAmount = best1.d.amount; m.diff = 0;
          m.reason = '业务单号 ' + best1.d.docNo + ' 已被其它流水核销（重复入账嫌疑，请核对）';
          return m;
        }
        m.matchLevel = 'L1'; m.status = 'matched';
        m.docNo = best1.d.docNo; m.docParty = best1.d.party;
        m.docAmount = best1.d.amount; m.diff = 0;
        docMatched[best1.di] = round2(docMatched[best1.di] + row.amount);
        docRowIdx[best1.di].push(row.rowIdx || rows.length + 1);
        return m;
      }

      // L3 模糊关联：金额相等但户名仅重叠（简称/漏字）→ 人工确认
      // 放在 L2 之前：金额完全相等时“户名略异”比“金额尾差”更需人工判断
      // 不排除已核销单据：户名模糊本就需人工判断，即使单号已被核销也应提示确认
      var l3 = cands.filter(function (c) {
        return Math.abs(c.diffAmt) <= 0.01 && c.nameOver && !c.nameEq;
      });
      if (l3.length) {
        var best3 = l3.sort(function (a, b) {
          if (a.available !== b.available) return a.available ? -1 : 1;
          return a.diffDays - b.diffDays;
        })[0];
        m.matchLevel = 'L3'; m.status = 'pending'; m.fuzzy = true;
        m.docNo = best3.d.docNo; m.docParty = best3.d.party;
        m.docAmount = best3.d.amount; m.diff = 0;
        m.reason = '金额一致但户名有差异（' + row.counterparty + ' ↔ ' + best3.d.party + '）' +
          (best3.available ? '，请人工确认' : '，且单号 ' + best3.d.docNo + ' 已被其它流水核销，请核对是否重复');
        return m;
      }

      // L2 容差匹配：金额确有差异（±tol 内）+ 日期差 ≤dateWindow + 户名至少重叠
      var l2 = cands.filter(function (c) {
        return c.available && Math.abs(c.diffAmt) > 0.01 && Math.abs(c.diffAmt) <= tol &&
          c.diffDays <= dateWindow && (c.nameEq || c.nameOver);
      });
      if (l2.length) {
        var best2 = l2.sort(function (a, b) { return (Math.abs(a.diffAmt) + a.diffDays) - (Math.abs(b.diffAmt) + b.diffDays); })[0];
        m.matchLevel = 'L2'; m.status = 'matched'; m.tolerance = true;
        m.docNo = best2.d.docNo; m.docParty = best2.d.party;
        m.docAmount = best2.d.amount; m.diff = round2(best2.diffAmt);
        m.reason = '容差通过（金额差 ¥' + Math.abs(best2.diffAmt).toFixed(2) + '）';
        docMatched[best2.di] = round2(docMatched[best2.di] + row.amount);
        docRowIdx[best2.di].push(row.rowIdx || rows.length + 1);
        return m;
      }

      // 完全未匹配
      var nearAmt = cands.some(function (c) {
        return Math.abs(c.diffAmt) <= tol && c.diffDays <= dateWindow;
      });
      m.reason = nearAmt ? '金额日期接近但户名无法对应' : '金额、日期均无匹配单据';
      return m;
    });

    // 单据核销视角：settled=已核销 partial=部分核销 open=未核销
    var docOut = docs.map(function (d, di) {
      var matchedAmt = docMatched[di];
      var remaining = round2(d.amount - matchedAmt);
      // 容差内多付（如手续费 5 元内）视同结清，看板显示更干净
      if (remaining < 0 && remaining >= -tol) remaining = 0;
      return {
        docNo: d.docNo, type: d.type, party: d.party, amount: d.amount,
        dueDate: d.dueDate, note: d.note || '',
        status: remaining <= 0.01 ? 'settled' : (matchedAmt > 0 ? 'partial' : 'open'),
        matchedRows: docRowIdx[di], matchedAmount: matchedAmt, remaining: remaining,
        overdue: d.dueDate ? dateTs(d.dueDate) < Date.now() : false
      };
    });

    var stats = {
      total: rows.length,
      matched: rows.filter(function (r) { return r.status === 'matched'; }).length,
      l1: rows.filter(function (r) { return r.matchLevel === 'L1'; }).length,
      l2: rows.filter(function (r) { return r.matchLevel === 'L2'; }).length,
      l3: rows.filter(function (r) { return r.matchLevel === 'L3'; }).length,
      duplicate: rows.filter(function (r) { return r.status === 'duplicate'; }).length,
      pending: rows.filter(function (r) { return r.status === 'pending'; }).length,
      unmatched: rows.filter(function (r) { return r.status === 'unmatched'; }).length,
      docs: docOut.length,
      settledDocs: docOut.filter(function (d) { return d.status === 'settled'; }).length,
      openDocs: docOut.filter(function (d) { return d.status === 'open' || d.status === 'partial'; }).length
    };
    return { rows: rows, docs: docOut, stats: stats };
  }

  /* ---------- 待办对账异议表（红蓝橙） ---------- */

  // 输入 matchBusiness 的返回值，输出三类异常清单
  function buildReconIssues(result) {
    var issues = [];
    if (!result) return issues;

    // 🔴 红字（长款）：银行有流水，业务端无对应单据（未匹配的流水）
    (result.rows || []).forEach(function (r) {
      if (r.status === 'unmatched') {
        issues.push({
          level: 'red', kind: '长款',
          title: '银行有账、业务无单',
          text: (r.direction === 'in' ? '收款' : '付款') + ' ¥' + r.amount.toFixed(2) +
            '（' + (r.counterparty || '无对方信息') + '，' + r.date + '）' +
            '业务端查不到对应单据' + (r.reason ? '：' + r.reason : ''),
          date: r.date, counterparty: r.counterparty, direction: r.direction,
          amount: r.amount, rowIdx: r.rowIdx || ''
        });
      }
    });

    // 🔵 蓝字（短款）：业务单据未核销（open/partial）
    (result.docs || []).forEach(function (d) {
      if (d.status === 'open' || d.status === 'partial') {
        issues.push({
          level: 'blue', kind: '短款',
          title: '业务有单、银行无账',
          text: (d.type === '应收' ? '应收' : '应付') + ' ¥' + d.amount.toFixed(2) +
            '（' + d.party + '，单号 ' + d.docNo + (d.dueDate ? '，预计 ' + d.dueDate : '') + '）' +
            '银行未' + (d.type === '应收' ? '到账' : '付出') +
            (d.remaining > 0 && d.remaining < d.amount ? '，已核销 ¥' + d.matchedAmount.toFixed(2) + '，余 ¥' + d.remaining.toFixed(2) : ''),
          docNo: d.docNo, party: d.party, amount: d.amount,
          dueDate: d.dueDate, remaining: d.remaining, type: d.type
        });
      }
    });

    // 🟠 橙字（重复）：单号已被核销完仍被匹配（实时标记）→ 重复入账嫌疑
    (result.rows || []).forEach(function (r) {
      if (r.status === 'duplicate') {
        issues.push({
          level: 'orange', kind: '重复',
          title: '单号已被核销（重复入账）',
          text: (r.direction === 'in' ? '收款' : '付款') + ' ¥' + r.amount.toFixed(2) +
            '（' + (r.counterparty || '无对方信息') + '，' + r.date + '）' +
            '，' + r.reason,
          docNo: r.docNo, counterparty: r.counterparty, direction: r.direction,
          amount: r.amount, rowIdx: r.rowIdx || ''
        });
      }
    });

    // 排序：红 → 橙 → 蓝（按金额倒序）
    issues.sort(function (a, b) {
      var order = { red: 0, orange: 1, blue: 2 };
      if (order[a.level] !== order[b.level]) return order[a.level] - order[b.level];
      return (b.amount || 0) - (a.amount || 0);
    });
    return issues;
  }

  /* ---------- 回款看板 ---------- */

  // 按客户/供应商聚合：应付款 vs 已到账，绿=结清 灰=未到 逾期X天
  // opts: { today: Date }
  function buildCollectionBoard(result, opts) {
    var o = opts || {};
    var today = o.today || new Date();
    today = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var rows = result && result.rows ? result.rows : [];
    var docs = result && result.docs ? result.docs : [];

    // 聚合：按 party + 方向
    var map = {};
    docs.forEach(function (d) {
      var key = d.type + '|' + d.party;
      if (!map[key]) map[key] = {
        type: d.type, party: d.party,
        dueTotal: 0, matchedAmount: 0, remaining: 0,
        docCount: 0, settledCount: 0, openDocs: [], overdueDays: 0
      };
      var g = map[key];
      g.dueTotal = round2(g.dueTotal + d.amount);
      g.matchedAmount = round2(g.matchedAmount + d.matchedAmount);
      g.remaining = round2(g.remaining + d.remaining);
      g.docCount++;
      if (d.status === 'settled') g.settledCount++;
      if (d.status !== 'settled') {
        g.openDocs.push({ docNo: d.docNo, amount: d.amount, dueDate: d.dueDate, remaining: d.remaining });
        if (d.dueDate) {
          var ts = dateTs(d.dueDate);
          if (!isNaN(ts)) {
            var days = Math.floor((today.getTime() - ts) / 86400000);
            if (days > g.overdueDays) g.overdueDays = days;
          }
        }
      }
    });

    var out = Object.keys(map).map(function (k) {
      var g = map[k];
      var ratio = g.dueTotal > 0 ? Math.round(g.matchedAmount / g.dueTotal * 100) : 0;
      var status = g.remaining <= 0.01 ? 'settled' : (g.matchedAmount > 0 ? 'partial' : (g.overdueDays > 0 ? 'overdue' : 'pending'));
      return {
        type: g.type, party: g.party,
        dueTotal: g.dueTotal, matchedAmount: g.matchedAmount, remaining: g.remaining,
        ratio: ratio, status: status, overdueDays: g.overdueDays,
        docCount: g.docCount, settledCount: g.settledCount, openDocs: g.openDocs
      };
    });

    out.sort(function (a, b) {
      if (a.status !== b.status) {
        var order = { overdue: 0, partial: 1, pending: 2, settled: 3 };
        return (order[a.status] !== undefined ? order[a.status] : 9) - (order[b.status] !== undefined ? order[b.status] : 9);
      }
      return b.remaining - a.remaining;
    });
    return out;
  }

  /* ---------- 对账结果 Excel 工作簿 ---------- */

  function buildReconWorkbook(bankRows) {
    var data = bankRows.map(function (r) {
      var stText = '未匹配';
      if (r.status === 'matched') {
        stText = r.tolerance ? '已匹配(容差)' : '已匹配';
      } else if (r.status === 'pending') {
        stText = '待人工确认';
      } else if (r.status === 'duplicate') {
        stText = '重复入账嫌疑';
      }
      return {
        '交易日期': r.date,
        '对方户名/摘要': r.counterparty,
        '收支方向': r.direction === 'in' ? '收款' : '付款',
        '流水金额(元)': r.amount.toFixed(2),
        '余额': r.balance,
        '匹配级别': r.matchLevel || '',
        '对账状态': stText,
        '匹配业务单号': r.docNo || r.invoiceNumber || '',
        '匹配对方': r.docParty || r.invoiceParty || '',
        '单据金额(元)': r.docAmount !== '' && r.docAmount !== undefined ? Number(r.docAmount).toFixed(2) : (r.invoiceTotal !== undefined ? r.invoiceTotal.toFixed(2) : ''),
        '金额差异(元)': r.diff !== '' && r.diff !== undefined ? Number(r.diff).toFixed(2) : '',
        '发票/单据日期': r.invoiceDate || r.docDueDate || '',
        '未匹配原因': r.status === 'matched' ? (r.warning || r.reason || '') : (r.status === 'pending' ? (r.reason || '待确认') : (r.reason || ''))
      };
    });
    var ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [
      { wch: 12 }, { wch: 30 }, { wch: 10 }, { wch: 12 },
      { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 20 },
      { wch: 28 }, { wch: 12 }, { wch: 12 }, { wch: 12 },
      { wch: 30 }
    ];
    var wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, '对账结果');
    return wb;
  }

  /* ---------- AI 分析未匹配原因提示词 ---------- */

  function analyzeUnmatchedPrompt(unmatchedRows, bankRows) {
    var sample = (unmatchedRows || []).slice(0, 20).map(function (r) {
      return {
        date: r.date,
        counterparty: r.counterparty || '(无对方信息)',
        direction: r.direction === 'in' ? '收款' : '付款',
        amount: r.amount.toFixed(2),
        currentHint: r.reason || ''
      };
    });
    var total = (bankRows || []).length;
    var sys = '你是企业财务对账助手。根据银行流水中未能与发票台账匹配的记录，分析可能原因并给出处理建议。输出简洁分条，中文。';
    var user = '本期银行流水共 ' + total + ' 笔，其中 ' + sample.length + ' 笔未匹配。未匹配明细如下（JSON）：\n' +
      JSON.stringify(sample, null, 2) +
      '\n\n请按以下结构输出：\n1）总体判断（一句话）\n2）逐条疑似原因（金额不符 / 对方名称不符 / 非发票收支如工资社保公积金 / 时间跨期 / 保证金押金等）\n3）建议处理方式（如：找业务确认、补录入台账、核对凭证等）';
    return { system: sys, user: user };
  }

  var Recon = {
    num: num,
    round2: round2,
    totalOf: totalOf,
    normalizeDateStr: normalizeDateStr,
    namesOverlap: namesOverlap,
    findHeaderRow: findHeaderRow,
    parseBankRows: parseBankRows,
    matchLedger: matchLedger,
    matchBusiness: matchBusiness,
    buildReconIssues: buildReconIssues,
    buildCollectionBoard: buildCollectionBoard,
    buildReconWorkbook: buildReconWorkbook,
    analyzeUnmatchedPrompt: analyzeUnmatchedPrompt
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Recon;
  else global.Recon = Recon;
})(typeof window !== 'undefined' ? window : globalThis);
