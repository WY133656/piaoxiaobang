/* ============================================================
 * 票小帮 · 银行流水自动对账引擎（纯函数 UMD 模块）
 * 功能：
 *   1) parseBankRows(sheetRows) — 智能识别银行流水 Excel 列头
 *      （日期/对方/收入/支出/发生额/余额），标准化为统一记录
 *   2) matchLedger(ledger, bankRows) — 与发票台账自动匹配：
 *      金额（精确到分）+ 对方名称 + 收支方向 + 日期窗口 综合打分
 *   3) buildReconWorkbook(bankRows) — 对账结果 Excel 工作簿
 *   4) analyzeUnmatchedPrompt(...) — 构造「AI 分析未匹配原因」提示词
 * 口径说明：
 *   - 台账发票按「购买方=本公司」视为支出（采购/报销）
 *   - 按「销售方=本公司」视为收入（销售开票）
 *   - 流水方向：in=收款（贷方/收入），out=付款（借方/支出）
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
    { key: 'balance', keywords: ['账户余额', '可用余额', '余额'] }
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
        direction: '',      // 'in' 收款 | 'out' 付款
        amount: 0,
        balance: ''
      };
      if (map.date !== undefined) row.date = normalizeDateStr(r[map.date]);
      if (map.counterparty !== undefined) row.counterparty = cellText(r[map.counterparty]);
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

  /* ---------- 对账结果 Excel 工作簿 ---------- */

  function buildReconWorkbook(bankRows) {
    var data = bankRows.map(function (r) {
      return {
        '交易日期': r.date,
        '对方户名/摘要': r.counterparty,
        '收支方向': r.direction === 'in' ? '收款' : '付款',
        '流水金额(元)': r.amount.toFixed(2),
        '余额': r.balance,
        '对账状态': r.status === 'matched' ? '已匹配' : '未匹配',
        '匹配发票号码': r.invoiceNumber || '',
        '匹配发票价税合计': r.invoiceTotal !== undefined ? r.invoiceTotal.toFixed(2) : '',
        '匹配对方': r.invoiceParty || '',
        '发票日期': r.invoiceDate || '',
        '未匹配原因': r.status === 'matched' ? (r.warning || '') : (r.reason || '')
      };
    });
    var ws = XLSX.utils.json_to_sheet(data);
    ws['!cols'] = [
      { wch: 12 }, { wch: 30 }, { wch: 10 }, { wch: 12 },
      { wch: 12 }, { wch: 10 }, { wch: 22 }, { wch: 14 },
      { wch: 28 }, { wch: 12 }, { wch: 26 }
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
    buildReconWorkbook: buildReconWorkbook,
    analyzeUnmatchedPrompt: analyzeUnmatchedPrompt
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Recon;
  else global.Recon = Recon;
})(typeof window !== 'undefined' ? window : globalThis);
