/* ============================================================
 * 票小帮 v4 · 统一数据导入引擎（parser.js）
 * 纯函数 UMD 模块，浏览器 / Node 通用，零依赖。
 *
 * 能力：
 *  1) autoDetectMapping(headers)    表头行自动识别 → 列映射
 *  2) mapColumnsToRecords(rows)     二维数组 + 映射 → 标准化记录
 *  3) textToRows(text)              OCR / PDF 文本按行切分
 *  4) parseDocxXml(xml)             Word(docx) document.xml → 段落 + 表格
 *  5) normalizeAmount / normalizeDate   金额 / 日期容错
 *
 * 标准记录字段：
 *  date / amount(不含税) / tax / total(价税合计) / category /
 *  counterparty(对方) / summary(摘要) / type(类型) / number(号码)
 * ============================================================ */
(function (global) {
  'use strict';

  function trim(v) {
    return v === null || v === undefined ? '' : String(v).trim();
  }

  function round2(n) {
    return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  }

  /* ---------- 金额容错 ---------- */
  function normalizeAmount(v) {
    if (v === null || v === undefined || v === '') return null;
    if (typeof v === 'number') return isFinite(v) ? round2(v) : null;
    var s = trim(v).replace(/[¥￥,\s]/g, '');
    if (s === '') return null;
    // 括号负数：(1,234.56) → -1234.56
    var neg = false;
    if (s.charAt(0) === '(' && s.slice(-1) === ')') { neg = true; s = s.slice(1, -1); }
    var n = parseFloat(s);
    if (isNaN(n)) return null;
    return round2(neg ? -n : n);
  }

  /* ---------- 日期容错 ---------- */
  function pad2(n) { return String(n).padStart(2, '0'); }

  function fmtCnDate(y, m, d) {
    if (!y || !m || !d) return '';
    return y + '年' + pad2(m) + '月' + pad2(d) + '日';
  }

  // Excel 序列号日期（1899-12-30 为 0）
  function excelSerialToDate(serial) {
    var ms = Math.round((serial - 25569) * 86400 * 1000);
    var d = new Date(ms);
    return isNaN(d.getTime()) ? null : d;
  }

  function normalizeDate(v) {
    if (v === null || v === undefined || v === '') return '';
    var d = null;
    if (v instanceof Date) { d = v; }
    else if (typeof v === 'number' && v > 1000 && v < 60000) {
      d = excelSerialToDate(v);
    } else {
      var s = trim(v);
      // 2026年8月3日 / 2026-08-03 / 2026/8/3 / 2026.08.03 / 20260803
      var m = s.match(/(\d{4})[年\-\/. ](\d{1,2})[月\-\/. ](\d{1,2})日?/);
      if (m) {
        d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      } else {
        m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
        if (m) d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
      }
    }
    if (!d || isNaN(d.getTime())) return '';
    return fmtCnDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
  }

  /* ---------- 表头自动识别 ---------- */
  // 优先级从高到低，先匹配先得（同一列只归一个字段）
  var HEADER_RULES = [
    { key: 'date', keywords: ['开票日期', '发票日期', '交易日期', '记账日期', '发生日期', '业务日期', '日期', '时间'] },
    { key: 'total', keywords: ['价税合计', '含税金额', '合计金额', '总额', '总金额', '（含税）', '(含税)'] },
    { key: 'tax', keywords: ['税额', '进项税额', '销项税额', '税款'] },
    { key: 'amount', keywords: ['不含税金额', '不含税', '金额'] },
    { key: 'number', keywords: ['发票号码', '票据号码', '发票号', '凭证号', '单号', '编号', '号码'] },
    { key: 'type', keywords: ['发票类型', '票种', '类型'] },
    { key: 'category', keywords: ['费用分类', '分类', '费用项目', '项目类别', '科目'] },
    { key: 'counterparty', keywords: ['销售方名称', '销售方', '供应商', '客户', '对方户名', '对方名称', '单位名称', '公司名称', '户名'] },
    { key: 'summary', keywords: ['摘要', '项目名称', '品名', '商品名称', '货物名称', '用途', '备注', '说明'] }
  ];

  // headers: 表头行数组（字符串）→ 返回 {colIndex: fieldKey}
  function autoDetectMapping(headers) {
    var map = {};
    var used = {};
    for (var j = 0; j < headers.length; j++) {
      var t = trim(headers[j]);
      if (!t) continue;
      for (var r = 0; r < HEADER_RULES.length; r++) {
        var rule = HEADER_RULES[r];
        if (used[rule.key]) continue;
        for (var k = 0; k < rule.keywords.length; k++) {
          if (t.indexOf(rule.keywords[k]) >= 0) {
            map[j] = rule.key;
            used[rule.key] = true;
            break;
          }
        }
        if (map[j] !== undefined) break;
      }
    }
    return map;
  }

  // 在表格前 N 行内找表头行：返回 { idx, map }
  function findHeaderRow(rows) {
    var limit = Math.min(rows.length, 8);
    for (var i = 0; i < limit; i++) {
      var row = rows[i] || [];
      var map = autoDetectMapping(row);
      var keys = Object.keys(map);
      // 至少识别出 2 个关键字段才算表头行
      var keyCount = keys.filter(function (k) { return ['date', 'amount', 'total', 'tax'].indexOf(map[k]) >= 0; }).length;
      if (keyCount >= 2) return { idx: i, map: map };
    }
    return null;
  }

  /* ---------- 行列映射 → 标准记录 ---------- */
  // rows: 二维数组（首行为表头，或自动查找）；返回 { records, mapping, headerRow }
  function mapColumnsToRecords(rows, opts) {
    var o = opts || {};
    var rowsArr = Array.isArray(rows) ? rows : [];
    var mapping = o.mapping || null;
    var headerRowIdx = o.headerRowIdx !== undefined ? o.headerRowIdx : -1;

    if (!mapping) {
      var found = findHeaderRow(rowsArr);
      if (!found) {
        // 无表头：按列序默认映射（调用方显式给 mapping 时才可靠）
        return { records: [], mapping: null, headerRow: -1 };
      }
      mapping = found.map;
      headerRowIdx = found.idx;
    }

    var records = [];
    var start = headerRowIdx >= 0 ? headerRowIdx + 1 : 0;
    var invMap = {}; // fieldKey → colIndex
    Object.keys(mapping || {}).forEach(function (ci) {
      var f = mapping[ci];
      if (invMap[f] === undefined) invMap[f] = Number(ci);
    });

    for (var i = start; i < rowsArr.length; i++) {
      var row = rowsArr[i];
      if (!row || !row.length) continue;
      var rec = {};
      Object.keys(invMap).forEach(function (f) {
        var v = row[invMap[f]];
        if (f === 'amount' || f === 'tax' || f === 'total') rec[f] = normalizeAmount(v);
        else if (f === 'date') rec[f] = normalizeDate(v);
        else rec[f] = trim(v);
      });
      // 全空行跳过
      var filled = Object.keys(rec).some(function (k) {
        return rec[k] !== '' && rec[k] !== null && rec[k] !== undefined;
      });
      if (!filled) continue;
      // 至少要有金额或日期才算有效记录
      if (rec.amount === null && rec.total === null && !rec.date) continue;
      rec._row = i + 1; // 原始行号（1 基，含表头）
      records.push(rec);
    }
    return { records: records, mapping: mapping, headerRow: headerRowIdx };
  }

  /* ---------- 文本按行切分（OCR / PDF 文本） ---------- */
  function textToRows(text) {
    if (!text) return [];
    return String(text)
      .split(/\r?\n/)
      .map(function (l) { return l.replace(/[ \t]+/g, ' ').trim(); })
      .filter(function (l) {
        if (!l) return false;
        if (/^[-—=·\*_]{3,}$/.test(l)) return false; // 分隔线
        if (/^\d+[、.．]\s*$/.test(l)) return false;   // 空序号
        return true;
      })
      .map(function (l) { return [l]; });
  }

  /* ---------- Word(docx) document.xml 解析 ----------
   * 输入 XML 字符串 → { paragraphs: [...], tables: [[[cell]...]...] }
   * 轻量栈式实现，不依赖 DOMParser，Node/浏览器通用。
   */
  function parseDocxXml(xml) {
    var paragraphs = [];
    var tables = [];
    var tagRe = /<(\/?)([a-zA-Z0-9:_-]+)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
    var currentTable = null, currentRow = null, currentCell = null;
    var inText = false, paraBuf = '';

    var m;
    var lastIndex = 0;
    while ((m = tagRe.exec(xml)) !== null) {
      // 标签之间的文本节点（需在 w:t 内）
      if (m.index > lastIndex) {
        var txt = xml.slice(lastIndex, m.index);
        if (inText && txt) {
          if (currentCell !== null) currentCell += txt;
          else paraBuf += txt;
        }
      }
      lastIndex = tagRe.lastIndex;

      var closing = m[1] === '/';
      var tag = m[2];
      var selfClose = m[4] === '/' || closing;

      if (tag === 'w:tbl') {
        if (closing) { tables.push(currentTable || []); currentTable = null; }
        else { currentTable = []; }
      } else if (tag === 'w:tr') {
        if (closing) { if (currentTable) currentTable.push(currentRow || []); currentRow = null; }
        else { currentRow = []; }
      } else if (tag === 'w:tc') {
        if (closing) { if (currentRow) currentRow.push((currentCell || '').trim()); currentCell = null; }
        else { currentCell = ''; }
      } else if (tag === 'w:t') {
        inText = !closing && !selfClose;
        if (closing) inText = false;
      } else if (tag === 'w:br') {
        if (currentCell !== null) currentCell += '\n';
        else paraBuf += '\n';
      } else if (tag === 'w:p') {
        if (closing && currentTable === null && currentCell === null) {
          var p = paraBuf.replace(/\n+$/, '').trim();
          if (p) paragraphs.push(p);
          paraBuf = '';
        }
        if (closing && currentCell !== null) {
          currentCell = (currentCell + '\n').replace(/\n+$/, '\n'); // 单元格内分段保留换行
        }
      }
    }
    // 清理：去表格单元格尾部多余换行
    tables = tables.map(function (t) {
      return t.map(function (row) {
        return row.map(function (c) { return c.replace(/\n+$/, '').trim(); });
      });
    });
    return { paragraphs: paragraphs, tables: tables };
  }

  /* ---------- 表格 → 标准记录（docx 表格复用） ---------- */
  function tableToRecords(table) {
    if (!table || !table.length) return { records: [], mapping: null, headerRow: -1 };
    return mapColumnsToRecords(table);
  }

  var Parser = {
    FIELDS: ['date', 'amount', 'tax', 'total', 'category', 'counterparty', 'summary', 'type', 'number'],
    autoDetectMapping: autoDetectMapping,
    findHeaderRow: findHeaderRow,
    mapColumnsToRecords: mapColumnsToRecords,
    textToRows: textToRows,
    parseDocxXml: parseDocxXml,
    tableToRecords: tableToRecords,
    normalizeAmount: normalizeAmount,
    normalizeDate: normalizeDate
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Parser;
  else global.Parser = Parser;
})(typeof window !== 'undefined' ? window : globalThis);
