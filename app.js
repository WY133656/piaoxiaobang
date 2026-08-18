'use strict';

const PDFJS = window.pdfjsLib;
// 本地 worker 优先（同源加载，不依赖 CDN）；本地不可用（如 file:// 协议）时回退 CDN
if (typeof PDFJS.GlobalWorkerOptions !== 'undefined') {
  PDFJS.GlobalWorkerOptions.workerSrc = 'lib/pdf.worker.min.js';
  if (location.protocol === 'file:') {
    PDFJS.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  }
}

const { PDFDocument, rgb } = PDFLib;
const LC = window.LedgerCore; // 台账规则引擎（ledger.js）

const state = {
  ledger: [],
  dedup: [],
  mergeFiles: [],
  mergeLayout: 1,
  mergeOrient: 'portrait',
  mergeBorder: 'none'
};

const DEMO_DATA = [
  { number: '2441200000001234567', code: '', date: '2026年08月15日', seller: '深圳市星辰科技有限公司', buyer: '浙江通途数科建设有限公司', amount: '1280.00', tax: '76.80', summary: '激光打印机 台 1 1280.00 13% 166.40', fileName: '发票-星辰科技.pdf' },
  { number: '2441200000002345678', code: '', date: '2026年08月15日', seller: '北京云端数据服务有限公司', buyer: '浙江通途数科建设有限公司', amount: '3560.00', tax: '213.60', summary: '服务器托管服务 项 1 3560.00 6% 213.60', fileName: '发票-云端数据.pdf' },
  { number: '2441200000001234567', code: '', date: '2026年08月14日', seller: '深圳市星辰科技有限公司', buyer: '浙江通途数科建设有限公司', amount: '1280.00', tax: '76.80', summary: '激光打印机 台 1 1280.00 13% 166.40', fileName: '发票-星辰科技(副本).pdf' },
  { number: '2441200000003456789', code: '', date: '2026年08月13日', seller: '昆明空港经济区赵记餐馆', buyer: '浙江通途数科建设有限公司', amount: '458.00', tax: '27.48', summary: '餐饮服务 1 458.00 6% 27.48', fileName: '发票-明远办公.pdf' },
  { number: '2441200000004567890', code: '', date: '2026年08月12日', seller: '慈溪市格下聚腾电器有限公司', buyer: '浙江通途数科建设有限公司', amount: '2300.00', tax: '138.00', summary: '照明灯具 套 10 230.00 13% 299.00', fileName: '发票-速达信息.pdf' }
].map(d => LC.enrichInvoice(d, ''));

function $(id) { return document.getElementById(id); }

function showToast(msg, type) {
  const toast = $('toast');
  toast.textContent = msg;
  toast.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(toast._timer);
  toast._timer = setTimeout(() => { toast.className = 'toast'; }, 2600);
}

function showLoading(text) {
  $('loadingText').textContent = text || '正在处理...';
  $('loadingOverlay').classList.add('show');
}

function hideLoading() {
  $('loadingOverlay').classList.remove('show');
}

function formatAmount(str) {
  if (str === undefined || str === null || str === '') return '-';
  const num = parseFloat(String(str).replace(/,/g, ''));
  if (isNaN(num)) return str;
  return num.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function switchPage(pageId) {
  document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
  $('page-' + pageId).classList.add('active');
  document.querySelector('.tab[data-page="' + pageId + '"]').classList.add('active');
}

function updateTotalCount() {
  $('totalCount').textContent = state.ledger.length;
}

function setupUpload(boxId, btnId, inputId, handler) {
  const box = $(boxId);
  const btn = $(btnId);
  const input = $(inputId);

  btn.addEventListener('click', (e) => { e.stopPropagation(); input.click(); });
  box.addEventListener('click', () => input.click());

  input.addEventListener('change', (e) => {
    if (e.target.files.length > 0) handler(Array.from(e.target.files));
    input.value = '';
  });

  ['dragover', 'dragenter'].forEach(ev => {
    box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.add('dragover'); });
  });
  ['dragleave', 'drop'].forEach(ev => {
    box.addEventListener(ev, (e) => { e.preventDefault(); box.classList.remove('dragover'); });
  });
  box.addEventListener('drop', (e) => {
    const files = Array.from(e.dataTransfer.files).filter(f => f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf'));
    if (files.length > 0) handler(files);
    else showToast('请上传 PDF 格式文件', 'error');
  });
}

/* ============ PDF 文本提取（按坐标还原视觉顺序） ============ */

async function extractPdfText(file) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await PDFJS.getDocument({ data: arrayBuffer }).promise;
  let fullText = '';
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();

    // 按 y 坐标聚合成行（容差 3pt），行内按 x 坐标从左到右排序，
    // 解决 pdf.js 返回顺序与视觉顺序不一致导致的字段错乱
    const lineMap = new Map();
    content.items.forEach(item => {
      if (!item.str) return;
      const y = item.transform[5];
      let key = null;
      for (const existing of lineMap.keys()) {
        if (Math.abs(existing - y) < 3) { key = existing; break; }
      }
      if (key === null) key = y;
      if (!lineMap.has(key)) lineMap.set(key, []);
      lineMap.get(key).push(item);
    });

    const yKeys = Array.from(lineMap.keys()).sort((a, b) => b - a);
    yKeys.forEach(k => {
      const items = lineMap.get(k).sort((a, b) => a.transform[4] - b.transform[4]);
      fullText += items.map(item => item.str).join(' ') + '\n';
    });
  }
  return { text: fullText, numPages: pdf.numPages };
}

/* ============ 发票字段解析（兼容多格式） ============ */

function normalizeDate(y, m, d) {
  const yy = String(y).padStart(4, '0');
  const mm = String(m).padStart(2, '0');
  const dd = String(d).padStart(2, '0');
  return yy + '年' + mm + '月' + dd + '日';
}

// 从指定标签后提取名称，直到遇到下一个字段标签（取最早出现的截断点）
function extractNameByLabel(clean, labelPatterns, stopPatterns) {
  for (const lp of labelPatterns) {
    const lm = clean.match(lp);
    if (!lm) continue;
    const start = lm.index + lm[0].length;
    let seg = clean.slice(start, start + 160);
    let stopAt = seg.length;
    for (const sp of stopPatterns) {
      const sm = seg.match(sp);
      if (sm && sm.index < stopAt) stopAt = sm.index;
    }
    seg = seg.slice(0, stopAt);
    let name = seg.replace(/[：:，,。.、\s]/g, '').trim();
    if (name.length >= 2 && name.length <= 40) return name;
  }
  return '';
}

function parseInvoiceText(rawText, fileName) {
  const invoice = {
    number: '',
    code: '',
    date: '',
    seller: '',
    buyer: '',
    amount: '',
    tax: '',
    fileName: fileName || ''
  };

  const clean = rawText.replace(/\s+/g, '');

  // ---------- 发票号码 / 发票代码 ----------
  const codeMatch = clean.match(/发票代码[：:]*?(\d{8,12})/);
  if (codeMatch) invoice.code = codeMatch[1];

  const numMatch = clean.match(/发票号码[：:]*?(\d{8,20})/) ||
                   clean.match(/数电票号码[：:]*?(\d{15,20})/) ||
                   clean.match(/票据号码[：:]*?(\d{8,20})/) ||
                   clean.match(/(\d{20})/) ||
                   clean.match(/(\d{15,20})/);
  if (numMatch) invoice.number = numMatch[1];

  // ---------- 开票日期 ----------
  const dateMatch = clean.match(/开票日期[：:]*?(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/) ||
                    clean.match(/(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})日?/);
  if (dateMatch) invoice.date = normalizeDate(dateMatch[1], dateMatch[2], dateMatch[3]);

  // ---------- 名称 ----------
  const stopPatterns = [
    /销售方信息/, /购买方信息/, /销售方名称/, /购买方名称/, /销售方[：:]/, /购买方[：:]/,
    /销售方|购买方/, /信息名称/, /纳税人识别号/, /统一社会信用代码/, /开户行及账号/, /开户行/,
    /地址[，,]?电话/, /地址/, /电话/, /合计金额/, /合计税额/, /价税合计/, /合计/, /金额/, /税额/,
    /备注/, /收款人/, /开票人/
  ];

  invoice.seller = extractNameByLabel(clean, [
    /销售方信息名称[：:]*?/, /销售方名称[：:]*?/, /销方名称[：:]*?/, /销售方[：:]*?名称[：:]*?/, /销售方[：:]*?/
  ], stopPatterns);

  invoice.buyer = extractNameByLabel(clean, [
    /购买方信息名称[：:]*?/, /购买方名称[：:]*?/, /购方名称[：:]*?/, /购买方[：:]*?名称[：:]*?/, /购买方[：:]*?/
  ], stopPatterns);

  // 兼容"名称：xxx"无前缀的旧版格式（按出现顺序区分购买方/销售方）
  if (!invoice.seller || !invoice.buyer) {
    const nameMatches = [];
    const nameRe = /名称[：:]*?([\u4e00-\u9fa5（）()A-Za-z0-9·]{2,40}?)(?=纳税人识别号|统一社会信用代码|开户行|地址|电话|金额|税额|价税合计|合计|备注|收款人|开票人|$)/g;
    let m;
    while ((m = nameRe.exec(clean)) !== null) nameMatches.push(m[1]);
    if (nameMatches.length >= 2) {
      if (!invoice.buyer) invoice.buyer = nameMatches[0];
      if (!invoice.seller) invoice.seller = nameMatches[1];
    } else if (nameMatches.length === 1) {
      if (!invoice.seller && !invoice.buyer) invoice.seller = nameMatches[0];
    }
  }

  // ---------- 金额 / 税额 ----------
  // 金额优先取"合计金额"（数电票，与台账口径一致），其次价税合计（旧版发票含税总额）
  const amtMatch = clean.match(/合计金额[¥￥]?\s*([\d,]+\.\d{2})/) ||
                   clean.match(/价税合计[（(]小写[）)][¥￥]?\s*([\d,]+\.\d{2})/) ||
                   clean.match(/价税合计[¥￥]?\s*([\d,]+\.\d{2})/) ||
                   clean.match(/价税合计[（(]大写[）)][^¥￥]*[¥￥]?\s*([\d,]+\.\d{2})/) ||
                   clean.match(/合计\s*[¥￥]?\s*([\d,]+\.\d{2})/) ||
                   clean.match(/[¥￥]\s*([\d,]+\.\d{2})/);
  if (amtMatch) invoice.amount = amtMatch[1].replace(/,/g, '');

  let taxMatch = clean.match(/合计税额[¥￥]?\s*([\d,]+\.\d{2})/) ||
                 clean.match(/税额[¥￥]?\s*([\d,]+\.\d{2})/);
  if (!taxMatch && invoice.amount) {
    // 若金额来自"合计金额"，且存在"价税合计(小写)"，税额 = 价税合计 - 金额
    const totalMatch = clean.match(/价税合计[（(]小写[）)][¥￥]?\s*([\d,]+\.\d{2})/);
    if (totalMatch) {
      const diff = parseFloat(totalMatch[1].replace(/,/g, '')) - parseFloat(invoice.amount.replace(/,/g, ''));
      if (diff > 0 && diff < parseFloat(invoice.amount.replace(/,/g, ''))) {
        taxMatch = [null, diff.toFixed(2)];
      }
    }
  }
  if (!taxMatch) {
    // 兜底：纸质专票表格里"税额"标签后数字不紧邻，取其后一段内最小的金额数字（税额恒小于金额/价税合计）
    const taxIdx = clean.indexOf('税额');
    if (taxIdx >= 0) {
      const seg = clean.slice(taxIdx, taxIdx + 120);
      const nums = seg.match(/([\d,]+\.\d{2})/g);
      if (nums && nums.length) {
        const min = nums.reduce((a, b) =>
          parseFloat(b.replace(/,/g, '')) < parseFloat(a.replace(/,/g, '')) ? b : a, nums[0]);
        taxMatch = [null, min];
      }
    }
  }
  if (taxMatch) invoice.tax = taxMatch[1].replace(/,/g, '');

  return invoice;
}

// 判断字段是否识别完整
function invoiceIsComplete(inv) {
  return !!(inv.number && inv.date && inv.seller && inv.amount);
}

function dedupKey(inv) {
  return inv.code ? inv.code + '-' + inv.number : inv.number;
}

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/* ============ 台账管理 ============ */

const LEDGER_COLS = 13;

function renderLedger() {
  const body = $('ledgerBody');
  const list = state.ledger;

  if (list.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="' + LEDGER_COLS + '">上传 PDF 发票后，识别结果将显示在这里</td></tr>';
    $('ledgerMeta').textContent = '暂无数据';
    $('exportExcelBtn').disabled = true;
    $('clearLedgerBtn').disabled = true;
    return;
  }

  const dupNumbers = findDuplicates(list);
  let html = '';
  list.forEach((inv, idx) => {
    const isDup = dupNumbers.has(dedupKey(inv));
    const complete = invoiceIsComplete(inv);
    const rowClass = (isDup ? 'duplicate ' : '') + (!complete ? 'incomplete' : '');
    const catClass = !inv.category || inv.category === '待确认' ? 'tag-warning' : 'tag-info';
    const total = LC.totalOf(inv);
    html += '<tr class="' + rowClass + '">' +
      '<td>' + esc(inv.invoiceType || '电子普票') + '</td>' +
      '<td>' + esc(LC.formatDateDash(inv.date)) + '</td>' +
      '<td class="mono">' + esc(inv.number || '-') + '</td>' +
      '<td title="' + esc(inv.seller) + '">' + esc(inv.seller || '-') + '</td>' +
      '<td>' + esc(inv.sellerShort || '-') + '</td>' +
      '<td class="cell-ellipsis" title="' + esc(inv.summary) + '">' + esc(inv.summary || '-') + '</td>' +
      '<td class="num">' + formatAmount(inv.amount) + '</td>' +
      '<td class="num">' + formatAmount(inv.tax) + '</td>' +
      '<td class="num">' + formatAmount(total) + '</td>' +
      '<td class="center"><span class="tag ' + catClass + '">' + esc(inv.category || '待确认') + '</span></td>' +
      '<td class="cell-ellipsis" title="' + esc(inv.remark) + '">' + esc(inv.remark || '-') + '</td>' +
      '<td class="cell-ellipsis" title="' + esc(inv.newName) + '">' + esc(inv.newName || '-') + '</td>' +
      '<td class="center"><button class="edit-btn" data-list="ledger" data-idx="' + idx + '">编辑</button></td>' +
      '</tr>';
  });
  body.innerHTML = html;

  const dupCount = list.filter(inv => dupNumbers.has(dedupKey(inv))).length;
  const incompleteCount = list.filter(inv => !invoiceIsComplete(inv)).length;
  const confirmCount = list.filter(inv => !inv.category || inv.category === '待确认').length;
  let meta = '共 ' + list.length + ' 张';
  if (dupCount > 0) meta += '，发现 ' + dupCount + ' 张重复';
  if (incompleteCount > 0) meta += '，' + incompleteCount + ' 张待补全';
  if (confirmCount > 0) meta += '，' + confirmCount + ' 张待确认分类';
  $('ledgerMeta').textContent = meta;
  $('ledgerMeta').className = 'result-meta' + (dupCount > 0 || incompleteCount > 0 || confirmCount > 0 ? ' warn' : '');
  $('exportExcelBtn').disabled = false;
  $('clearLedgerBtn').disabled = false;

  bindEditButtons();
}

function findDuplicates(list) {
  const counts = {};
  list.forEach(inv => {
    const key = dedupKey(inv);
    if (key) counts[key] = (counts[key] || 0) + 1;
  });
  const dups = new Set();
  for (const k in counts) {
    if (counts[k] > 1) dups.add(k);
  }
  return dups;
}

async function handleLedgerFiles(files) {
  showLoading('正在识别发票 (' + files.length + ' 个文件)...');
  let success = 0, fail = 0;
  for (let i = 0; i < files.length; i++) {
    try {
      $('loadingText').textContent = '正在识别 ' + (i + 1) + '/' + files.length + ': ' + files[i].name;
      const { text } = await extractPdfText(files[i]);
      const invoice = parseInvoiceText(text, files[i].name);
      // 用台账规则引擎补齐：发票类型/摘要/简称/费用分类/特殊情况说明/重命名文件名
      LC.enrichInvoice(invoice, text);
      if (invoice.number || invoice.amount) {
        state.ledger.push(invoice);
        success++;
      } else {
        const fallback = { number: '', code: '', date: '', seller: '', buyer: '', amount: '', tax: '', summary: '', invoiceType: '', category: '', fileName: files[i].name };
        LC.enrichInvoice(fallback, text);
        state.ledger.push(fallback);
        fail++;
      }
    } catch (err) {
      console.error('解析失败:', files[i].name, err);
      const fb = { number: '', code: '', date: '', seller: '', buyer: '', amount: '', tax: '', summary: '', invoiceType: '', category: '', fileName: files[i].name };
      LC.enrichInvoice(fb, '');
      state.ledger.push(fb);
      fail++;
    }
  }
  hideLoading();
  updateTotalCount();
  renderLedger();
  if (success > 0 && fail === 0) {
    showToast('成功识别 ' + success + ' 张发票', 'success');
  } else if (success > 0 && fail > 0) {
    showToast('识别完成: ' + success + ' 张成功, ' + fail + ' 张待补全', 'error');
  } else {
    showToast('未能从 PDF 中提取发票信息（可能是扫描件）', 'error');
  }
}

function loadDemoData() {
  state.ledger = DEMO_DATA.map(d => ({ ...d }));
  updateTotalCount();
  renderLedger();
  showToast('已加载 ' + DEMO_DATA.length + ' 条演示数据', 'success');
}

function exportLedgerExcel() {
  if (state.ledger.length === 0) return;
  try {
    const wb = LC.buildLedgerWorkbook(state.ledger, '发票台账');
    if (!wb) { showToast('导出失败：Excel 库未就绪', 'error'); return; }
    XLSX.writeFile(wb, '发票台账_' + new Date().toISOString().slice(0, 10) + '.xlsx', { cellStyles: true });
    showToast('已导出 14 列样式台账 Excel 文件', 'success');
  } catch (err) {
    console.error(err);
    showToast('导出失败: ' + err.message, 'error');
  }
}

/* ============ 发票查重 ============ */

function renderDedup() {
  const body = $('dedupBody');
  const list = state.dedup;

  if (list.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="7">上传发票后将自动进行查重比对</td></tr>';
    $('dedupMeta').textContent = '暂无数据';
    $('exportDedupBtn').disabled = true;
    $('clearDedupBtn').disabled = true;
    return;
  }

  const dupNumbers = findDuplicates(list);
  let html = '';
  list.forEach((inv, idx) => {
    const isDup = dupNumbers.has(dedupKey(inv));
    const count = inv.number ? list.filter(x => dedupKey(x) === dedupKey(inv)).length : 1;
    html += '<tr class="' + (isDup ? 'duplicate' : '') + '">' +
      '<td class="mono">' + esc(inv.number || '-') + '</td>' +
      '<td>' + esc(LC.formatDateDash(inv.date)) + '</td>' +
      '<td>' + esc(inv.seller || '-') + '</td>' +
      '<td class="num">' + formatAmount(inv.amount) + '</td>' +
      '<td class="center"><span class="tag ' + (isDup ? 'tag-danger' : 'tag-success') + '">' + (isDup ? '重复' : '正常') + '</span></td>' +
      '<td class="center">' + count + '</td>' +
      '<td class="center"><button class="edit-btn" data-list="dedup" data-idx="' + idx + '">编辑</button></td>' +
      '</tr>';
  });
  body.innerHTML = html;

  const dupCount = list.filter(inv => dupNumbers.has(dedupKey(inv))).length;
  $('dedupMeta').textContent = '共 ' + list.length + ' 张，重复 ' + dupCount + ' 张';
  $('dedupMeta').className = 'result-meta' + (dupCount > 0 ? ' warn' : '');
  $('exportDedupBtn').disabled = false;
  $('clearDedupBtn').disabled = false;

  bindEditButtons();
}

async function handleDedupFiles(files) {
  showLoading('正在查重 (' + files.length + ' 个文件)...');
  for (let i = 0; i < files.length; i++) {
    try {
      $('loadingText').textContent = '正在识别 ' + (i + 1) + '/' + files.length + ': ' + files[i].name;
      const { text } = await extractPdfText(files[i]);
      const invoice = parseInvoiceText(text, files[i].name);
      state.dedup.push(invoice);
    } catch (err) {
      state.dedup.push({ number: '', code: '', date: '', seller: '', amount: '', tax: '', fileName: files[i].name });
    }
  }
  hideLoading();
  renderDedup();
  const dupCount = state.dedup.filter(inv => findDuplicates(state.dedup).has(dedupKey(inv))).length;
  if (dupCount > 0) {
    showToast('发现 ' + dupCount + ' 张重复发票', 'error');
  } else {
    showToast('查重完成，未发现重复', 'success');
  }
}

function dedupFromLedger() {
  if (state.ledger.length === 0) {
    showToast('台账中没有数据，请先上传发票', 'error');
    return;
  }
  state.dedup = state.ledger.map(d => ({ ...d }));
  renderDedup();
  const dupCount = state.dedup.filter(inv => findDuplicates(state.dedup).has(dedupKey(inv))).length;
  showToast('已从台账导入 ' + state.dedup.length + ' 张' + (dupCount > 0 ? '，发现 ' + dupCount + ' 张重复' : ''), dupCount > 0 ? 'error' : 'success');
}

function exportDedupExcel() {
  if (state.dedup.length === 0) return;
  const dupNumbers = findDuplicates(state.dedup);
  const data = state.dedup.map(inv => {
    const count = inv.number ? state.dedup.filter(x => dedupKey(x) === dedupKey(inv)).length : 1;
    return {
      '发票号码': inv.number || '',
      '发票代码': inv.code || '',
      '开票日期': LC.formatDateDash(inv.date),
      '销售方名称': inv.seller || '',
      '金额(元)': inv.amount || '',
      '是否重复': dupNumbers.has(dedupKey(inv)) ? '是' : '否',
      '重复次数': count,
      '文件名': inv.fileName || ''
    };
  });
  const ws = XLSX.utils.json_to_sheet(data);
  ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 16 }, { wch: 28 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 24 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '查重结果');
  XLSX.writeFile(wb, '查重结果_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  showToast('已导出 Excel 文件', 'success');
}

/* ============ 手动编辑修正（台账模式：14 字段全可编辑） ============ */

let editingContext = null;

// 从弹窗当前值构造临时发票对象（用于自动重算）
function modalTempInvoice(base) {
  const inv = { ...(base || {}) };
  inv.invoiceType = $('editType').value;
  inv.number = $('editNumber').value.trim();
  inv.code = $('editCode').value.trim();
  inv.date = $('editDate').value.trim();
  inv.seller = $('editSeller').value.trim();
  inv.sellerShort = $('editSellerShort').value.trim();
  inv.buyer = $('editBuyer').value.trim();
  inv.summary = $('editSummary').value.trim();
  inv.amount = $('editAmount').value.trim();
  inv.tax = $('editTax').value.trim();
  inv.category = $('editCategory').value;
  inv.remark = $('editRemark').value.trim();
  inv.newName = $('editNewName').value.trim();
  return inv;
}

function openEditModal(listKey, index) {
  const inv = state[listKey][index];
  $('editType').value = inv.invoiceType || '电子普票';
  $('editNumber').value = inv.number || '';
  $('editCode').value = inv.code || '';
  $('editDate').value = inv.date || '';
  $('editSeller').value = inv.seller || '';
  $('editSellerShort').value = inv.sellerShort || '';
  $('editBuyer').value = inv.buyer || '';
  $('editSummary').value = inv.summary || '';
  $('editAmount').value = inv.amount || '';
  $('editTax').value = inv.tax || '';
  $('editCategory').value = inv.category || '待确认';
  $('editRemark').value = inv.remark || '';
  $('editNewName').value = inv.newName || '';
  $('editFileName').textContent = inv.fileName || '';
  refreshModalTotal();
  editingContext = { listKey, index };
  $('editModal').hidden = false;
}

function closeEditModal() {
  $('editModal').hidden = true;
  editingContext = null;
}

function refreshModalTotal() {
  const amt = parseFloat($('editAmount').value) || 0;
  const tax = parseFloat($('editTax').value) || 0;
  $('editTotal').textContent = formatAmount(amt + tax);
}

// 自动生成简称
function autoShort() {
  const full = $('editSeller').value.trim();
  $('editSellerShort').value = LC.extractShortName(full);
  refreshModalAuto();
}

// 自动生成特殊情况说明
function autoRemark() {
  const inv = modalTempInvoice(state[editingContext.listKey][editingContext.index]);
  $('editRemark').value = LC.buildRemark(inv);
  refreshModalAuto();
}

// 自动生成重命名文件名
function autoNewName() {
  const inv = modalTempInvoice(state[editingContext.listKey][editingContext.index]);
  $('editNewName').value = LC.buildNewName(inv);
}

// 编辑时联动重算：金额/税额变化 → 合计；简称/日期/号码变化 → 文件名
function refreshModalAuto() {
  refreshModalTotal();
  const inv = modalTempInvoice(state[editingContext ? editingContext.listKey : 'ledger'][editingContext ? editingContext.index : 0]);
  const name = LC.buildNewName(inv);
  if (name) $('editNewName').value = name;
}

function saveEditModal() {
  if (!editingContext) return;
  const { listKey, index } = editingContext;
  const inv = state[listKey][index];
  inv.invoiceType = $('editType').value;
  inv.number = $('editNumber').value.trim();
  inv.code = $('editCode').value.trim();
  inv.date = $('editDate').value.trim();
  inv.seller = $('editSeller').value.trim();
  inv.sellerShort = $('editSellerShort').value.trim();
  inv.buyer = $('editBuyer').value.trim();
  inv.summary = $('editSummary').value.trim();
  inv.amount = $('editAmount').value.trim();
  inv.tax = $('editTax').value.trim();
  inv.category = $('editCategory').value;
  inv.remark = $('editRemark').value.trim();
  inv.newName = $('editNewName').value.trim();
  // 若销售方全称变了但简称没手动改，自动重新提取
  if (inv.seller && !inv.sellerShort) inv.sellerShort = LC.extractShortName(inv.seller);
  closeEditModal();
  renderLedger();
  renderDedup();
  showToast('已保存修改', 'success');
}

function bindEditButtons() {
  document.querySelectorAll('.edit-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      openEditModal(btn.dataset.list, parseInt(btn.dataset.idx));
    });
  });
}

/* ============ 合并打印 ============ */

function renderMergeFileList() {
  const list = $('mergeFileList');
  if (state.mergeFiles.length === 0) {
    list.innerHTML = '<div class="merge-file-empty">未选择文件</div>';
    $('doMergeBtn').disabled = true;
    $('mergePreviewInfo').textContent = '请先上传发票文件';
    return;
  }
  let html = '';
  state.mergeFiles.forEach((f, i) => {
    html += '<div class="merge-file-item">' +
      '<span class="file-name" title="' + esc(f.name) + '">' + (i + 1) + '. ' + esc(f.name) + '</span>' +
      '<button class="file-remove" data-idx="' + i + '">×</button>' +
      '</div>';
  });
  list.innerHTML = html;

  list.querySelectorAll('.file-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const idx = parseInt(btn.dataset.idx);
      state.mergeFiles.splice(idx, 1);
      renderMergeFileList();
    });
  });

  const perPage = state.mergeLayout;
  const pages = Math.ceil(state.mergeFiles.length / perPage);
  $('mergePreviewInfo').textContent = '共 ' + state.mergeFiles.length + ' 张发票，每页 ' + perPage + ' 张，需 ' + pages + ' 张 A4 纸';
  $('doMergeBtn').disabled = false;
}

async function handleMergeFiles(files) {
  state.mergeFiles = state.mergeFiles.concat(files);
  renderMergeFileList();
  showToast('已添加 ' + files.length + ' 个文件', 'success');
}

function calcLayout(perPage, pageW, pageH, margin) {
  let cols, rows;
  switch (perPage) {
    case 1: cols = 1; rows = 1; break;
    case 2: cols = 1; rows = 2; break;
    case 4: cols = 2; rows = 2; break;
    case 6: cols = 2; rows = 3; break;
    case 8: cols = 2; rows = 4; break;
    default: cols = 1; rows = 1;
  }
  const gap = 6;
  const availW = pageW - margin.left - margin.right;
  const availH = pageH - margin.top - margin.bottom;
  const cellW = (availW - gap * (cols - 1)) / cols;
  const cellH = (availH - gap * (rows - 1)) / rows;

  const positions = [];
  for (let i = 0; i < perPage; i++) {
    const col = i % cols;
    const row = Math.floor(i / cols);
    positions.push({
      x: margin.left + col * (cellW + gap),
      y: pageH - margin.top - (row + 1) * cellH - row * gap,
      w: cellW,
      h: cellH
    });
  }
  return positions;
}

async function doMerge() {
  if (state.mergeFiles.length === 0) return;
  showLoading('正在合并 ' + state.mergeFiles.length + ' 张发票...');

  try {
    const mergedPdf = await PDFDocument.create();
    const isLandscape = state.mergeOrient === 'landscape';
    const pageW = isLandscape ? 841.89 : 595.28;
    const pageH = isLandscape ? 595.28 : 841.89;

    const mmToPt = (mm) => mm * 2.8346;
    const margin = {
      top: mmToPt(parseFloat($('marginTop').value) || 0),
      bottom: mmToPt(parseFloat($('marginBottom').value) || 0),
      left: mmToPt(parseFloat($('marginLeft').value) || 0),
      right: mmToPt(parseFloat($('marginRight').value) || 0)
    };

    const perPage = state.mergeLayout;
    const positions = calcLayout(perPage, pageW, pageH, margin);
    const showBorder = state.mergeBorder === 'show';
    const files = state.mergeFiles;

    for (let i = 0; i < files.length; i += perPage) {
      $('loadingText').textContent = '正在合并 ' + (i + 1) + '-' + Math.min(i + perPage, files.length) + '/' + files.length;
      const page = mergedPdf.addPage([pageW, pageH]);
      const batch = files.slice(i, i + perPage);

      for (let j = 0; j < batch.length; j++) {
        try {
          const fileBytes = await batch[j].arrayBuffer();
          const sourcePdf = await PDFDocument.load(fileBytes);
          const sourcePages = sourcePdf.getPages();
          if (sourcePages.length === 0) continue;
          const [embedded] = await mergedPdf.embedPages([sourcePages[0]]);
          const pos = positions[j];

          const scale = Math.min(pos.w / embedded.width, pos.h / embedded.height);
          const drawW = embedded.width * scale;
          const drawH = embedded.height * scale;
          const drawX = pos.x + (pos.w - drawW) / 2;
          const drawY = pos.y + (pos.h - drawH) / 2;

          page.drawPage(embedded, {
            x: drawX,
            y: drawY,
            xScale: scale,
            yScale: scale
          });

          if (showBorder) {
            page.drawRectangle({
              x: drawX,
              y: drawY,
              width: drawW,
              height: drawH,
              borderColor: rgb(0.7, 0.7, 0.7),
              borderWidth: 0.5
            });
          }
        } catch (err) {
          console.error('嵌入失败:', batch[j].name, err);
        }
      }
    }

    const pdfBytes = await mergedPdf.save();
    const blob = new Blob([pdfBytes], { type: 'application/pdf' });
    downloadBlob(blob, '合并发票_' + new Date().toISOString().slice(0, 10) + '.pdf');
    hideLoading();
    showToast('合并完成，已下载 PDF 文件', 'success');
  } catch (err) {
    hideLoading();
    console.error(err);
    showToast('合并失败: ' + err.message, 'error');
  }
}

function setupLayoutButtons() {
  document.querySelectorAll('#layoutOptions .layout-opt').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#layoutOptions .layout-opt').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mergeLayout = parseInt(btn.dataset.layout);
      renderMergeFileList();
    });
  });

  document.querySelectorAll('.layout-opt[data-orient]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-opt[data-orient]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mergeOrient = btn.dataset.orient;
    });
  });

  document.querySelectorAll('.layout-opt[data-border]').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.layout-opt[data-border]').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      state.mergeBorder = btn.dataset.border;
    });
  });
}

function init() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchPage(tab.dataset.page));
  });

  setupUpload('ledgerUploadBox', 'ledgerSelectBtn', 'ledgerFileInput', handleLedgerFiles);
  setupUpload('dedupUploadBox', 'dedupSelectBtn', 'dedupFileInput', handleDedupFiles);
  setupUpload('mergeUploadBox', 'mergeSelectBtn', 'mergeFileInput', handleMergeFiles);

  $('loadDemoBtn').addEventListener('click', loadDemoData);
  $('exportExcelBtn').addEventListener('click', exportLedgerExcel);
  $('clearLedgerBtn').addEventListener('click', () => {
    state.ledger = [];
    updateTotalCount();
    renderLedger();
    showToast('已清空台账', 'success');
  });

  $('exportDedupBtn').addEventListener('click', exportDedupExcel);
  $('clearDedupBtn').addEventListener('click', () => {
    state.dedup = [];
    renderDedup();
    showToast('已清空查重列表', 'success');
  });
  $('dedupFromLedgerBtn').addEventListener('click', dedupFromLedger);

  $('doMergeBtn').addEventListener('click', doMerge);
  setupLayoutButtons();

  $('editSaveBtn').addEventListener('click', saveEditModal);
  $('editCancelBtn').addEventListener('click', closeEditModal);
  $('editCloseBtn').addEventListener('click', closeEditModal);
  $('editModal').addEventListener('click', (e) => {
    if (e.target === $('editModal')) closeEditModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !$('editModal').hidden) closeEditModal();
  });

  // 费用分类下拉选项（与规则引擎同一数据源）
  const catSelect = $('editCategory');
  catSelect.innerHTML = '';
  LC.CATEGORIES.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    catSelect.appendChild(opt);
  });

  // 编辑弹窗内的自动生成按钮
  $('autoShortBtn').addEventListener('click', autoShort);
  $('autoRemarkBtn').addEventListener('click', autoRemark);
  $('autoNameBtn').addEventListener('click', autoNewName);
  // 金额/税额变化时联动刷新合计与文件名
  ['editAmount', 'editTax', 'editSellerShort', 'editDate', 'editNumber'].forEach(id => {
    $(id).addEventListener('input', refreshModalAuto);
  });

  console.log('%c票小帮已启动（台账模式）', 'color:#185fa5;font-size:14px;font-weight:bold');
  console.log('所有文件均在浏览器本地处理，不会上传到服务器');
}

document.addEventListener('DOMContentLoaded', init);
