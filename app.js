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
  mergeBorder: 'none',
  bankRows: [],       // 银行流水（自动对账）
  reconResult: null,  // 对账结果
  bizDocs: [],        // 业务单据（应收/应付，阶梯式匹配）
  reconMode: 'ledger',// 'ledger' 与发票台账匹配 | 'biz' 与业务单据阶梯匹配
  reconView: 'detail',// detail | issues | board
  reconIssues: [],    // 待办异议表（红蓝橙）
  collectionBoard: [],// 回款看板
  currentReport: null, // 当前报表（周报/月报）
  currentTemplate: null, // 当前出表模板（income / expenseRank / cashflow）
  currentAnalysis: null // 当前 4 段式 AI 分析文本
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
    const files = Array.from(e.dataTransfer.files).filter(f =>
      f.type === 'application/pdf' || /\.(pdf|ofd|jpg|jpeg|png|webp|bmp)$/i.test(f.name));
    if (files.length > 0) handler(files);
    else showToast('请上传 PDF / OFD / 图片格式文件', 'error');
  });
}

/* ============ 图片发票（拍照录入） ============ */

function isImageFile(file) {
  return /\.(jpg|jpeg|png|webp|bmp)$/i.test(file.name) || /^image\//.test(file.type);
}

// 图片 → 压缩 → JPEG base64（供腾讯云 OCR，长边 2048，白底填充）
function imageFileToBase64(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      try {
        const maxSide = 2048;
        let w = img.naturalWidth, h = img.naturalHeight;
        if (Math.max(w, h) > maxSide) {
          const r = maxSide / Math.max(w, h);
          w = Math.round(w * r);
          h = Math.round(h * r);
        }
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, w, h);
        ctx.drawImage(img, 0, 0, w, h);
        URL.revokeObjectURL(url);
        resolve(canvas.toDataURL('image/jpeg', 0.9).split(',')[1]);
      } catch (err) {
        URL.revokeObjectURL(url);
        reject(err);
      }
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片加载失败')); };
    img.src = url;
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

// 在"购买方信息/销售方信息"块内定位"名称"标签后的公司名称
// （块位置自适应，无"块+名称"连续匹配要求，兼容标签与值分行的布局）
function nameInBlock(clean, blockLabel) {
  const idx = clean.indexOf(blockLabel);
  if (idx < 0) return '';
  const seg = clean.slice(idx + blockLabel.length, idx + blockLabel.length + 260);
  const m = seg.match(/名称[：:]*?([\u4e00-\u9fa5（）()A-Za-z0-9·]{2,40}?)(?=\s*(?:名称[：:]|统一社会信用代码|纳税人识别号|身份证号|开户行|地址|电话|金额|税额|价税合计|合计|备注|收款人|开票人|销售方信息|购买方信息|销售方|购买方|项目名称|规格型号|购销|买卖|方方|信信|息息|$))/);
  if (!m) return '';
  const name = m[1].replace(/[：:，,。.、\s]/g, '');
  return (name.length >= 2 && name.length <= 40) ? name : '';
}

// 收集全部"名称：xxx"条目（按行提取，兼容多种版式）
// 为什么按行而非去空白全文：
//   左右两栏旧版发票中，"名称:通途...名称:飒贵..."在同一行（干净），
//   而"购买方信息/销售方信息"竖排拆散成"买卖方方信信"残字在下一行。
//   若用 clean 全连接，残字会粘到名称后面，正则无法正确切分。
// 版式兼容：
//   - 同行两个名称（左右两栏）：lookahead 用"名称[：:]"切分
//   - 名称标签独占一行（"名称："换行跟公司名）：取下一行
//   - 个人代开（"名称:张三身份证号:..."）：lookahead 用"身份证号"终止
function collectNameEntries(rawText) {
  const out = [];
  const lines = String(rawText || '').split('\n').map(l => l.trim());
  // lookahead 终止词：
  // - 名称[：:]：同行第二个名称
  // - 销售方信息/购买方信息/销售方/购买方：块标题（防止吃进下一块）
  // - 项目名称/规格型号：商品明细表头
  // - 购销/买卖/方方/信信/息息：左右两栏竖排标题的横向残字
  // - 销\s/购\s：竖排标题"销售方/购买方"的残字"销""购"后跟空格，
  //   解决"购 名称：A公司 销 名称：B公司"行里第一个名称被吞的问题
  const re = /名称[：:]\s*([\u4e00-\u9fa5（）()A-Za-z0-9·]{2,40}?)(?=\s*(?:名称[：:]|统一社会信用代码|纳税人识别号|身份证号|开户行|地址|电话|金额|税额|价税合计|合计|备注|收款人|开票人|销售方信息|购买方信息|销售方|购买方|项目名称|规格型号|购销|买卖|方方|信信|息息|销\s|购\s|$))/g;
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l) continue;
    // 跳过商品明细表头行（"项目名称 规格型号 单位 数量..."）
    if (/项目名称|货物或应税劳务|服务名称|商品名称|劳务名称/.test(l)) continue;
    let m, found = false;
    re.lastIndex = 0;
    while ((m = re.exec(l)) !== null) {
      found = true;
      const n = m[1].replace(/[：:，,。.、\s]/g, '');
      if (n.length >= 2 && n.length <= 40 && !out.includes(n)) out.push(n);
    }
    // "名称："标签独占一行时，公司名在下一行（数电票跨行布局）
    if (!found && /名称[：:]\s*$/.test(l)) {
      for (let j = i + 1; j < lines.length && j < i + 3; j++) {
        if (!lines[j]) continue;
        const n = lines[j].replace(/[：:，,。.、\s]/g, '');
        if (n.length >= 2 && n.length <= 40 && !out.includes(n)) out.push(n);
        break;
      }
    }
  }
  return out;
}

// 公司名特征过滤（剔除商品明细"项目名称：激光打印机"等非公司条目）
function looksLikeCompany(n) {
  return /(有限|公司|集团|厂|店|餐馆|饭店|商行|经营部|事务所|工作室|部|所|行|院|中心)$/.test(n);
}

// 是否自家公司（购买方通常是本公司，用它来区分销售方/购买方）
// 公司名可在设置弹窗修改（localStorage 持久化），支持全称/核心词匹配
function isMyCompany(n) {
  const MY = (LC && LC.getMyCompany()) || '';
  if (!MY || !n) return false;
  // 核心词：去掉后缀（如"浙江通途数科建设有限公司" → "通途数科"）
  const core = MY.replace(/(股份有限公司|有限责任公司|有限公司|集团有限公司)/g, '').slice(0, 4);
  return n === MY || n.indexOf(MY) >= 0 || MY.indexOf(n) >= 0 || (core.length >= 2 && n.indexOf(core) >= 0);
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

  // ---------- 名称（销售方 / 购买方） ----------
  // 1) 优先按"购买方信息/销售方信息"块提取（数电票/新版电子票，块位置自适应，不会对调）
  invoice.buyer = nameInBlock(clean, '购买方信息') || nameInBlock(clean, '购买方');
  invoice.seller = nameInBlock(clean, '销售方信息') || nameInBlock(clean, '销售方');

  // 2) 兜底：无块标题的旧版格式（"名称：xxx"平铺）
  //    用"自家公司=购买方"识别，避免按出现顺序假设导致销售方/购买方对调
  if (!invoice.seller || !invoice.buyer) {
    const names = collectNameEntries(rawText).filter(looksLikeCompany);
    const myIdx = names.findIndex(isMyCompany);
    if (myIdx >= 0) {
      // 自家公司 → 购买方；其余第一条 → 销售方
      if (!invoice.buyer) invoice.buyer = names[myIdx];
      const others = names.filter((n, i) => i !== myIdx);
      // 公司条目里没有其他名称时，从全量条目里再找（兼容个人代开"名称:张三"）
      invoice.seller = invoice.seller || others[0] ||
        collectNameEntries(rawText).find(n => !isMyCompany(n)) || '';
    } else {
      // 没识别到自家公司（如代开/转开），退回首条=购买方、次条=销售方
      if (!invoice.buyer) invoice.buyer = names[0] || '';
      if (!invoice.seller) invoice.seller = names[1] || '';
    }
  }

  // ---------- 金额 / 税额 ----------
  // 金额优先取"合计金额"（数电票标签）或"合计 ¥xx"（数电票合计行，不含税），
  // 其次价税合计（旧版发票只有含税总额时兜底）
  const amtMatch = clean.match(/合计金额[¥￥]?\s*([\d,]+\.\d{2})/) ||
                   clean.match(/合计\s*[¥￥]?\s*([\d,]+\.\d{2})/) ||
                   clean.match(/价税合计[（(]小写[）)][¥￥]?\s*([\d,]+\.\d{2})/) ||
                   clean.match(/价税合计[¥￥]?\s*([\d,]+\.\d{2})/) ||
                   clean.match(/价税合计[（(]大写[）)][^¥￥]*[¥￥]?\s*([\d,]+\.\d{2})/) ||
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

// 筛选状态（搜索关键词 / 费用分类）
const filterState = { keyword: '', category: '' };

function getFilteredLedger() {
  const k = filterState.keyword;
  const c = filterState.category;
  return state.ledger.filter(inv => {
    if (c && inv.category !== c) return false;
    if (k) {
      const hay = [inv.number, inv.code, inv.date, inv.seller, inv.sellerShort, inv.summary, inv.buyer, inv.remark]
        .join(' ').toLowerCase();
      if (hay.indexOf(k) < 0) return false;
    }
    return true;
  });
}

function updateStats() {
  const filtered = getFilteredLedger();
  let amt = 0, tax = 0, all = 0;
  filtered.forEach(inv => {
    amt += LC.round2(inv.amount);
    tax += LC.round2(inv.tax);
    all += LC.round2(LC.totalOf(inv));
  });
  const fmt = (n) => '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $('statCount').textContent = filtered.length;
  $('statAmount').textContent = fmt(amt);
  $('statTax').textContent = fmt(tax);
  $('statTotal').textContent = fmt(all);
}

function renderLedger() {
  const body = $('ledgerBody');
  const list = state.ledger;
  const filtered = getFilteredLedger();

  if (list.length === 0) {
    body.innerHTML = '<tr class="empty-row"><td colspan="' + LEDGER_COLS + '">上传 PDF 发票后，识别结果将显示在这里</td></tr>';
    $('ledgerMeta').textContent = '暂无数据';
    $('exportExcelBtn').disabled = true;
    $('clearLedgerBtn').disabled = true;
    $('downloadZipBtn').disabled = true;
    updateStats();
    return;
  }

  const dupNumbers = findDuplicates(list);
  let html = '';
  filtered.forEach(inv => {
    // 编辑按钮需定位 state.ledger 中的真实下标
    const idx = state.ledger.indexOf(inv);
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
  if (filtered.length === 0) {
    html = '<tr class="empty-row"><td colspan="' + LEDGER_COLS + '">没有符合筛选条件的发票</td></tr>';
  }
  body.innerHTML = html;

  const dupCount = list.filter(inv => dupNumbers.has(dedupKey(inv))).length;
  const incompleteCount = list.filter(inv => !invoiceIsComplete(inv)).length;
  const confirmCount = list.filter(inv => !inv.category || inv.category === '待确认').length;
  let meta = '共 ' + list.length + ' 张';
  if (filtered.length !== list.length) meta += '，当前显示 ' + filtered.length + ' 张';
  if (dupCount > 0) meta += '，发现 ' + dupCount + ' 张重复';
  if (incompleteCount > 0) meta += '，' + incompleteCount + ' 张待补全';
  if (confirmCount > 0) meta += '，' + confirmCount + ' 张待确认分类';
  $('ledgerMeta').textContent = meta;
  $('ledgerMeta').className = 'result-meta' + (dupCount > 0 || incompleteCount > 0 || confirmCount > 0 ? ' warn' : '');
  $('exportExcelBtn').disabled = false;
  $('clearLedgerBtn').disabled = false;
  $('downloadZipBtn').disabled = !filtered.some(inv => !!inv.file);
  updateStats();

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

// 台账数据持久化到 IndexedDB（file 字段不入库）
function saveLedgerNow() {
  return Store.saveLedger(state.ledger).catch(err => {
    console.error('保存本地台账失败:', err);
  });
}

// PDF 页面渲染为 JPEG base64（供 OCR 使用，最多前 N 页）
async function renderPdfToImages(file, maxPages) {
  const arrayBuffer = await file.arrayBuffer();
  const pdf = await PDFJS.getDocument({ data: arrayBuffer }).promise;
  const pages = Math.min(pdf.numPages, maxPages || 3);
  const images = [];
  for (let i = 1; i <= pages; i++) {
    const page = await pdf.getPage(i);
    const viewport = page.getViewport({ scale: 2 });
    const canvas = document.createElement('canvas');
    canvas.width = Math.ceil(viewport.width);
    canvas.height = Math.ceil(viewport.height);
    const ctx = canvas.getContext('2d');
    await page.render({ canvasContext: ctx, viewport }).promise;
    images.push(canvas.toDataURL('image/jpeg', 0.92).split(',')[1]);
  }
  return images;
}

// 统一入口：图片走压缩+OCR，OFD 走 JSZip 解包提取，PDF 走 pdf.js 文本提取
async function extractInvoiceText(file) {
  if (isImageFile(file)) {
    if (!AI.isConfigured('ocr')) {
      throw new Error('图片识别需要先在设置中开启并配置腾讯云 OCR');
    }
    const b64 = await imageFileToBase64(file);
    const text = await AI.ocrText(b64);
    return { text: text || '', numPages: 1 };
  }
  const isOfd = /\.ofd$/i.test(file.name);
  if (isOfd) {
    return OFD.extractText(file);
  }
  return extractPdfText(file);
}

/* ============================================================
 * 四格式统一导入：发票路径（PDF/OFD/图片）+ 表格路径（Excel/CSV/Word）
 * 独立：每个模块自带导入入口；联动：导入结果统一写入共享台账
 * ============================================================ */

// 表格导入预览弹窗的映射字段（UI 展示用）
const IMPORT_FIELDS = [
  { key: 'date', label: '开票日期' },
  { key: 'number', label: '发票号码' },
  { key: 'amount', label: '金额（不含税）' },
  { key: 'tax', label: '税额' },
  { key: 'total', label: '价税合计' },
  { key: 'counterparty', label: '销售方/供应商' },
  { key: 'category', label: '费用分类' },
  { key: 'type', label: '发票类型' },
  { key: 'summary', label: '摘要/备注' }
];

let importContext = null; // { rows, headerRow, fileName, onDone }

async function handleLedgerFiles(files) {
  const list = Array.from(files);
  const tableFiles = list.filter(f => /\.(xlsx|xls|csv|docx)$/i.test(f.name));
  const invoiceFiles = list.filter(f => !/\.(xlsx|xls|csv|docx)$/i.test(f.name));

  if (invoiceFiles.length) await processInvoiceFiles(invoiceFiles);
  let tableOk = 0, tableFail = 0;
  for (const f of tableFiles) {
    try {
      if (await importTableFile(f)) tableOk++;
      else tableFail++; // 用户取消
    } catch (err) {
      console.error('表格导入失败:', f.name, err);
      showToast('导入失败: ' + f.name + '（' + err.message + '）', 'error');
      tableFail++;
    }
  }
  if (tableFiles.length) {
    if (tableOk > 0) {
      showToast('表格导入完成: ' + tableOk + ' 个文件成功' + (tableFail > 0 ? '，' + tableFail + ' 个失败/取消' : ''), tableFail > 0 ? 'error' : 'success');
    }
  }
}

// 发票路径（PDF/OFD/图片 → 文本 → 规则解析 → OCR 兜底 → 大模型纠错）
async function processInvoiceFiles(files) {
  showLoading('正在识别发票 (' + files.length + ' 个文件)...');
  let success = 0, fail = 0, ocrCount = 0, llmCount = 0;
  for (let i = 0; i < files.length; i++) {
    const file = files[i];
    try {
      $('loadingText').textContent = '正在识别 ' + (i + 1) + '/' + files.length + ': ' + file.name;
      const extracted = await extractInvoiceText(file);
      let text = extracted.text || '';
      let invoice = parseInvoiceText(text, file.name);

      // 扫描件兜底：关键字段缺失且已配置腾讯云 OCR → 渲染页面转图片识别
      if (!invoice.number && !/\.ofd$/i.test(file.name) && AI.isConfigured('ocr')) {
        try {
          $('loadingText').textContent = '文本为空，调用 OCR (' + (i + 1) + '/' + files.length + ')';
          const images = await renderPdfToImages(file, 3);
          const parts = [];
          for (let j = 0; j < images.length; j++) {
            const t = await AI.ocrText(images[j]);
            if (t) parts.push(t);
          }
          if (parts.length > 0) {
            text = parts.join('\n');
            invoice = parseInvoiceText(text, file.name);
            ocrCount++;
          }
        } catch (err) {
          console.error('OCR 识别失败:', file.name, err);
        }
      }

      // 大模型字段纠错（提升号码/金额/日期准确率）
      if (AI.isConfigured('llm') && text) {
        try {
          $('loadingText').textContent = '大模型校验字段 (' + (i + 1) + '/' + files.length + ')';
          const fixed = await AI.llmCorrect(invoice, text);
          if (fixed) { invoice = fixed; llmCount++; }
        } catch (err) {
          console.error('大模型纠错失败:', file.name, err);
        }
      }

      // 台账规则引擎补齐：发票类型/摘要/简称/费用分类/特殊情况说明/重命名文件名
      LC.enrichInvoice(invoice, text);
      invoice.file = file; // 原始文件引用（仅内存，供打包下载）
      if (invoice.number || invoice.amount) {
        state.ledger.push(invoice);
        success++;
      } else {
        const fallback = { number: '', code: '', date: '', seller: '', buyer: '', amount: '', tax: '', summary: '', invoiceType: '', category: '', fileName: file.name };
        LC.enrichInvoice(fallback, text);
        state.ledger.push(fallback);
        fail++;
      }
    } catch (err) {
      console.error('解析失败:', file.name, err);
      const fb = { number: '', code: '', date: '', seller: '', buyer: '', amount: '', tax: '', summary: '', invoiceType: '', category: '', fileName: file.name };
      LC.enrichInvoice(fb, '');
      state.ledger.push(fb);
      fail++;
    }
  }
  hideLoading();
  await saveLedgerNow();
  updateTotalCount();
  renderLedger();
  const extras = [];
  if (ocrCount > 0) extras.push(ocrCount + ' 张走 OCR');
  if (llmCount > 0) extras.push(llmCount + ' 张大模型校验');
  const suffix = extras.length ? '（' + extras.join('，') + '）' : '';
  if (success > 0 && fail === 0) {
    showToast('成功识别 ' + success + ' 张发票' + suffix, 'success');
  } else if (success > 0 && fail > 0) {
    showToast('识别完成: ' + success + ' 张成功, ' + fail + ' 张待补全' + suffix, 'error');
  } else {
    showToast('未能从文件中提取发票信息（可尝试在设置中开启 OCR）', 'error');
  }
}

// 表格文件 → 解析 → 预览确认 → 入台账；返回 true=已导入，false=取消
async function importTableFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  let rows = null;
  if (ext === 'docx') {
    const buf = await readFileAsArrayBuffer(file);
    const zip = await JSZip.loadAsync(buf);
    const entry = zip.file('word/document.xml');
    if (!entry) throw new Error('不是有效的 Word 文档');
    const xml = await entry.async('text');
    const doc = Parser.parseDocxXml(xml);
    const tables = (doc.tables || []).slice().sort((a, b) => b.length - a.length);
    rows = (tables.length && tables[0].length > 1)
      ? tables[0]
      : Parser.textToRows((doc.paragraphs || []).join('\n'));
  } else {
    const buf = await readFileAsArrayBuffer(file);
    const wb = XLSX.read(new Uint8Array(buf), { type: 'array' });
    const ws = wb.Sheets[wb.SheetNames[0]];
    if (!ws) throw new Error('表格为空');
    rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  }
  const parsed = Parser.mapColumnsToRecords(rows);
  if (!parsed.records.length) throw new Error('未识别到有效数据（表头需含 日期/金额 等列）');
  return new Promise(resolve => openImportPreview(rows, parsed, file.name, resolve));
}

function readFileAsArrayBuffer(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(new Error('文件读取失败'));
    r.readAsArrayBuffer(file);
  });
}

// 打开导入预览弹窗：列映射 + 前几行预览，onDone(true/false)
function openImportPreview(rows, parsed, fileName, onDone) {
  importContext = { rows, headerRow: parsed.headerRow, fileName, onDone };
  $('importTip').textContent = '文件「' + fileName + '」识别到 ' + parsed.records.length + ' 条数据。确认列映射后点击"确认导入"写入台账。';
  renderImportMapUI(rows, parsed.headerRow, parsed.mapping);
  renderImportPreviewTable(rows, parsed.headerRow);
  $('importModal').hidden = false;
}

function renderImportMapUI(rows, headerRow, mapping) {
  const headers = headerRow >= 0 ? (rows[headerRow] || []) : [];
  const box = $('importMap');
  box.innerHTML = '';
  const fieldToCol = {};
  Object.keys(mapping || {}).forEach(ci => { fieldToCol[mapping[ci]] = Number(ci); });
  IMPORT_FIELDS.forEach(f => {
    const row = document.createElement('div');
    row.className = 'import-map-row';
    const label = document.createElement('span');
    label.className = 'import-map-label';
    label.textContent = f.label;
    const sel = document.createElement('select');
    sel.className = 'import-map-select';
    sel.dataset.field = f.key;
    const none = document.createElement('option');
    none.value = '-1';
    none.textContent = '（不导入）';
    sel.appendChild(none);
    headers.forEach((h, i) => {
      const op = document.createElement('option');
      op.value = String(i);
      const name = (h === null || h === undefined || String(h).trim() === '') ? '第' + (i + 1) + '列' : String(h).trim();
      op.textContent = name;
      sel.appendChild(op);
    });
    if (fieldToCol[f.key] !== undefined) sel.value = String(fieldToCol[f.key]);
    row.appendChild(label);
    row.appendChild(sel);
    box.appendChild(row);
  });
}

function renderImportPreviewTable(rows, headerRow) {
  const t = $('importPreviewTable');
  t.innerHTML = '';
  const start = headerRow >= 0 ? headerRow : 0;
  const end = Math.min(rows.length, start + 6);
  for (let i = start; i < end; i++) {
    const tr = document.createElement('tr');
    const r = rows[i] || [];
    for (let j = 0; j < r.length; j++) {
      const td = document.createElement(i === start ? 'th' : 'td');
      td.textContent = r[j] === null || r[j] === undefined ? '' : String(r[j]);
      tr.appendChild(td);
    }
    t.appendChild(tr);
  }
}

// 确认导入：收集映射 → 重算 → 转台账 → 保存
function importConfirmAction() {
  if (!importContext) return;
  const { rows, fileName, onDone } = importContext;
  const mapping = {};
  document.querySelectorAll('#importMap select').forEach(sel => {
    const col = Number(sel.value);
    if (col >= 0) mapping[col] = sel.dataset.field;
  });
  const parsed = Parser.mapColumnsToRecords(rows, { mapping });
  if (!parsed.records.length) { showToast('没有可导入的数据行', 'error'); return; }
  const added = parsed.records.map((r, idx) => {
    const inv = {
      number: r.number || '',
      code: '',
      date: r.date || '',
      seller: r.counterparty || '',
      buyer: '',
      amount: (r.amount !== null && r.amount !== undefined) ? r.amount : '',
      tax: (r.tax !== null && r.tax !== undefined) ? r.tax : '',
      total: (r.total !== null && r.total !== undefined) ? r.total : '',
      invoiceType: r.type || '',
      summary: r.summary || '',
      category: r.category || '',
      fileName: fileName + (parsed.records.length > 1 ? ' 第' + (idx + 1) + '/' + parsed.records.length + '条' : '')
    };
    LC.enrichInvoice(inv, (inv.summary || '') + ' ' + (inv.seller || ''));
    return inv;
  });
  state.ledger.push(...added);
  closeImportModal();
  saveLedgerNow().then(() => {
    updateTotalCount();
    renderLedger();
    showToast('已导入 ' + added.length + ' 条记录到台账', 'success');
  });
  if (onDone) onDone(true);
}

function importCancelAction() {
  closeImportModal();
  if (importContext && importContext.onDone) importContext.onDone(false);
}

function closeImportModal() {
  $('importModal').hidden = true;
  importContext = null;
}

// 按「重命名后文件名」批量打包下载（仅含内存中有原始文件的发票）
async function downloadLedgerZip() {
  const list = getFilteredLedger().filter(inv => !!inv.file);
  if (list.length === 0) {
    showToast('当前列表没有可下载的原始文件，请重新上传发票', 'error');
    return;
  }
  showLoading('正在打包 ' + list.length + ' 个文件...');
  try {
    const zip = new JSZip();
    const used = {};
    for (let i = 0; i < list.length; i++) {
      const inv = list[i];
      $('loadingText').textContent = '打包 ' + (i + 1) + '/' + list.length + ': ' + (inv.newName || inv.file.name);
      const buf = await inv.file.arrayBuffer();
      let name = inv.newName || inv.fileName || inv.file.name;
      // OFD 文件保持 .ofd 后缀（重命名规则默认生成 .pdf）
      if (/\.ofd$/i.test(inv.fileName || inv.file.name) && /\.pdf$/i.test(name)) {
        name = name.replace(/\.pdf$/i, '.ofd');
      }
      // 同名文件加序号避免覆盖
      if (used[name] !== undefined) {
        used[name]++;
        const dot = name.lastIndexOf('.');
        name = name.slice(0, dot) + '(' + used[name] + ')' + name.slice(dot);
      } else {
        used[name] = 0;
      }
      zip.file(name, buf);
    }
    const blob = await zip.generateAsync({ type: 'blob' });
    downloadBlob(blob, '发票重命名打包_' + new Date().toISOString().slice(0, 10) + '.zip');
    hideLoading();
    showToast('已打包 ' + list.length + ' 个文件并下载', 'success');
  } catch (err) {
    hideLoading();
    console.error(err);
    showToast('打包失败: ' + err.message, 'error');
  }
}

function loadDemoData() {
  state.ledger = DEMO_DATA.map(d => ({ ...d }));
  saveLedgerNow();
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
      const extracted = await extractInvoiceText(files[i]);
      const invoice = parseInvoiceText(extracted.text || '', files[i].name);
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

/* ============ 自动对账（银行流水 ⇄ 台账） ============ */

function handleBankFiles(files) {
  const file = files[0];
  if (!file) return;
  showLoading('正在读取银行流水...');
  const reader = new FileReader();
  reader.onload = (e) => {
    try {
      const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
      const ws = wb.Sheets[wb.SheetNames[0]];
      const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
      const rows = Recon.parseBankRows(sheetRows);
      if (!rows.length) {
        hideLoading();
        showToast('未能识别流水数据，请确认表头包含「交易日期/对方户名/收入/支出」等列', 'error');
        return;
      }
      state.bankRows = rows;
      state.reconResult = null;
      hideLoading();
      renderRecon();
      showToast('已读取 ' + rows.length + ' 笔银行流水，点击「开始对账」', 'success');
    } catch (err) {
      hideLoading();
      console.error(err);
      showToast('读取流水失败: ' + err.message, 'error');
    }
  };
  reader.onerror = () => { hideLoading(); showToast('读取文件失败', 'error'); };
  reader.readAsArrayBuffer(file);
}

/* ---- 业务单据（应收/应付模板）---- */

// 固定模板列：业务单号 / 类型(应收|应付) / 客户供应商 / 金额 / 预计到账日期 / 备注
// 容错识别：按表头关键词定位列，列顺序无关
function parseBizDocs(sheetRows) {
  const rows = sheetRows || [];
  let headerIdx = -1, cols = null;

  // 两阶段识别表头：先精确匹配「单号 + 金额」，再按关键词兜底
  const keywordCols = {
    docNo: ['业务单号', '单号', '编号'],
    type: ['业务类型', '类型', '方向'],
    party: ['客户', '供应商', '对方', '单位名称', '名称'],
    amount: ['金额', '应收金额', '应付金额'],
    dueDate: ['预计到账', '到账日期', '日期', '期限'],
    note: ['备注', '说明']
  };
  const matchCol = (header) => {
    const h = String(header || '').trim();
    for (const key of Object.keys(keywordCols)) {
      if (keywordCols[key].some(kw => h.indexOf(kw) >= 0)) return key;
    }
    return '';
  };

  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    const line = rows[i];
    if (!Array.isArray(line)) continue;
    const text = line.map(String).join('|');
    if (!/单号|编号/.test(text)) continue;
    const colMap = {};
    line.forEach((cell, ci) => {
      const key = matchCol(cell);
      if (key && colMap[key] === undefined) colMap[key] = ci;
    });
    if (colMap.docNo !== undefined && colMap.amount !== undefined && colMap.party !== undefined) {
      headerIdx = i; cols = colMap; break;
    }
  }
  if (cols === null) return { docs: [], errors: ['未识别到业务单据模板表头（需包含 业务单号/类型/客户供应商/金额/日期）'] };

  // 日期归一：支持 2026-08-20 / 2026/8/20 / 2026年8月20日 / Excel 序列号
  const normDate = (v) => {
    if (v === undefined || v === null || v === '') return '';
    if (typeof v === 'number' && v > 20000 && v < 60000) {
      // Excel 日期序列号 → Date（1900 系统，含闰年 bug 修正）
      const d = new Date(Math.round((v - 25569) * 86400000));
      return isNaN(d.getTime()) ? '' : fmtDateObj(d);
    }
    const s = String(v).trim();
    let m = s.match(/(\d{4})[年\-\/.](\d{1,2})[月\-\/.](\d{1,2})/);
    if (m) return m[1] + '-' + m[2].padStart(2, '0') + '-' + m[3].padStart(2, '0');
    m = s.match(/(\d{4})(\d{2})(\d{2})/);
    if (m) return m[1] + '-' + m[2] + '-' + m[3];
    const t = new Date(s);
    return isNaN(t.getTime()) ? '' : fmtDateObj(t);
  };

  const docs = [];
  const errors = [];
  rows.slice(headerIdx + 1).forEach((line) => {
    if (!Array.isArray(line)) return;
    const cell = (key) => line[cols[key]];
    const docNo = String(cell('docNo') || '').trim();
    const amount = parseFloat(String(cell('amount') || '').replace(/,/g, ''));
    if (!docNo || isNaN(amount) || amount <= 0) return;

    const typeRaw = String(cell('type') || '');
    const type = /收|销|借/.test(typeRaw) ? '应收' : (/付|购/.test(typeRaw) ? '应付' : '应收');
    docs.push({
      docNo, type,
      party: String(cell('party') || '').trim(),
      amount: Math.round(amount * 100) / 100,
      dueDate: normDate(cell('dueDate')),
      note: String(cell('note') || '').trim()
    });
  });

  if (!docs.length) errors.push('模板内未解析到有效单据行（单号 + 金额必填）');
  return { docs, errors };
}

function handleBizFiles(files) {
  showLoading('正在读取业务单据...');
  const all = [];
  let pending = files.length;
  const finish = () => {
    hideLoading();
    state.bizDocs = all;
    state.reconResult = null;
    renderRecon();
    showToast('已读取业务单据 ' + all.length + ' 条，点击「开始对账」走阶梯式匹配', all.length ? 'success' : 'error');
  };
  Array.from(files).forEach(file => {
    const reader = new FileReader();
    reader.onload = (e) => {
      try {
        const wb = XLSX.read(new Uint8Array(e.target.result), { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const sheetRows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
        const parsed = parseBizDocs(sheetRows);
        if (parsed.errors.length) {
          parsed.errors.forEach(msg => showToast(msg, 'error'));
        }
        parsed.docs.forEach(d => all.push(d));
      } catch (err) {
        console.error(err);
        showToast('读取业务单据失败: ' + err.message, 'error');
      }
      if (--pending === 0) finish();
    };
    reader.onerror = () => { if (--pending === 0) finish(); };
    reader.readAsArrayBuffer(file);
  });
}

function clearBizDocs() {
  state.bizDocs = [];
  state.reconResult = null;
  state.reconIssues = [];
  state.collectionBoard = [];
  state.reconView = 'detail';
  renderRecon();
  showToast('已清空业务单据，对账退化为与发票台账匹配', 'success');
}

function startRecon() {
  if (!state.bankRows.length) return;
  showLoading(state.bizDocs.length ? '正在执行阶梯式匹配（L1 强匹配 / L2 容差 / L3 模糊）...' : '正在与台账自动匹配...');
  setTimeout(() => {
    if (state.bizDocs.length) {
      // 业务单据模式：三要素阶梯式匹配 + 红蓝橙异议 + 回款看板
      const res = Recon.matchBusiness(state.bankRows, state.bizDocs, { tol: 5, dateWindow: 3 });
      state.reconResult = res;
      state.reconMode = 'biz';
      state.reconIssues = Recon.buildReconIssues(res);
      state.collectionBoard = Recon.buildCollectionBoard(res);
    } else {
      // 未导入单据 → 退化为与发票台账匹配
      const res = Recon.matchLedger(state.ledger, state.bankRows, {
        isMyCompanyFn: (n) => isMyCompany(n)
      });
      state.reconResult = res;
      state.reconMode = 'ledger';
      state.reconIssues = [];
      state.collectionBoard = [];
    }
    state.reconView = 'detail';
    hideLoading();
    renderRecon();
    const s = state.reconResult.stats;
    showToast('对账完成：匹配 ' + s.matched + ' / ' + s.total + ' 笔' + (s.unmatched > 0 ? '，未匹配 ' + s.unmatched + ' 笔' : ''),
      s.unmatched > 0 ? 'error' : 'success');
  }, 30);
}

function renderRecon() {
  const body = $('reconBody');
  const rows = state.bankRows;
  const res = state.reconResult;
  const isBiz = state.reconMode === 'biz';

  if (!rows.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="9">上传银行流水并点击「开始对账」</td></tr>';
    $('reconMeta').textContent = '请先上传银行流水';
    $('startReconBtn').disabled = true;
    $('clearReconBtn').disabled = true;
    $('exportReconBtn').disabled = true;
    $('reconAiBtn').disabled = true;
    $('reconStats').innerHTML = '';
    $('reconAiResult').hidden = true;
    $('reconViewTabs').hidden = true;
    $('reconViewIssues').hidden = true;
    $('reconViewBoard').hidden = true;
    $('reconViewDetail').hidden = false;
    return;
  }

  // 视图切换 tabs：仅业务单据模式显示（异议表/看板依赖单据数据）
  const tabsEl = $('reconViewTabs');
  if (isBiz && res) {
    tabsEl.hidden = false;
    tabsEl.querySelectorAll('.view-tab').forEach(t => {
      t.classList.toggle('active', t.dataset.view === state.reconView);
    });
  } else {
    tabsEl.hidden = true;
    state.reconView = 'detail';
  }
  $('reconViewDetail').hidden = state.reconView !== 'detail';
  $('reconViewIssues').hidden = state.reconView !== 'issues';
  $('reconViewBoard').hidden = state.reconView !== 'board';

  // 统计卡
  let statsHtml = '<div class="stat-card"><span class="stat-label">流水笔数</span><span class="stat-value">' + rows.length + '</span></div>';
  if (res) {
    const s = res.stats;
    if (isBiz) {
      statsHtml +=
        '<div class="stat-card"><span class="stat-label">L1 强匹配</span><span class="stat-value ok">' + s.l1 + '</span></div>' +
        '<div class="stat-card"><span class="stat-label">L2 容差</span><span class="stat-value ok">' + s.l2 + '</span></div>' +
        '<div class="stat-card"><span class="stat-label">待确认</span><span class="stat-value' + (s.pending ? ' bad' : '') + '">' + s.pending + '</span></div>' +
        '<div class="stat-card"><span class="stat-label">重复</span><span class="stat-value' + (s.duplicate ? ' bad' : '') + '">' + s.duplicate + '</span></div>' +
        '<div class="stat-card"><span class="stat-label">未匹配</span><span class="stat-value' + (s.unmatched ? ' bad' : '') + '">' + s.unmatched + '</span></div>' +
        '<div class="stat-card"><span class="stat-label">单据结清</span><span class="stat-value">' + s.settledDocs + '/' + s.docs + '</span></div>';
    } else {
      statsHtml +=
        '<div class="stat-card"><span class="stat-label">已匹配</span><span class="stat-value ok">' + s.matched + '</span></div>' +
        '<div class="stat-card"><span class="stat-label">未匹配</span><span class="stat-value bad">' + s.unmatched + '</span></div>' +
        '<div class="stat-card"><span class="stat-label">收款合计</span><span class="stat-value">' + formatAmount(s.inAmount.toFixed(2)) + '</span></div>' +
        '<div class="stat-card"><span class="stat-label">付款合计</span><span class="stat-value">' + formatAmount(s.outAmount.toFixed(2)) + '</span></div>';
    }
  } else {
    statsHtml += '<div class="stat-card stat-hint"><span class="stat-label">提示</span><span class="stat-value" style="font-size:13px">点击「开始对账」' + (state.bizDocs.length ? '执行阶梯式匹配' : '匹配台账') + '</span></div>';
  }
  $('reconStats').innerHTML = statsHtml;

  // 明细表
  let html = '';
  rows.forEach((r, idx) => {
    const m = res ? res.rows[idx] : null;
    let statusClass = 'tag-warning', statusText = '待对账';
    if (m) {
      if (isBiz) {
        if (m.status === 'matched') { statusClass = m.tolerance ? 'tag-info' : 'tag-success'; statusText = m.tolerance ? '容差' : '已匹配'; }
        else if (m.status === 'pending') { statusClass = 'tag-warning'; statusText = '待确认'; }
        else if (m.status === 'duplicate') { statusClass = 'tag-danger'; statusText = '重复'; }
        else { statusClass = 'tag-danger'; statusText = '未匹配'; }
      } else {
        statusClass = m.status === 'matched' ? 'tag-success' : 'tag-danger';
        statusText = m.status === 'matched' ? '已匹配' : '未匹配';
      }
    }
    const warnClass = m && ((m.status === 'matched' && m.warning) || (isBiz && m.status === 'unmatched')) ? ' cell-warn' : '';
    let docNo = '-', docParty = '-', diffHtml = '-', reason = '-';
    if (m) {
      if (isBiz) {
        docNo = m.docNo || '-';
        docParty = m.docParty || '-';
        diffHtml = (m.diff === undefined || m.diff === '') ? '-' : (m.diff > 0 ? '+' : '') + formatAmount(m.diff.toFixed(2));
        reason = m.reason || '-';
      } else {
        docNo = m.invoiceNumber || '-';
        docParty = m.invoiceParty || '-';
        if (m.invoiceTotal !== undefined) diffHtml = formatAmount((m.invoiceTotal - r.amount).toFixed(2));
        reason = m.status === 'matched' ? (m.warning || '-') : (m.reason || '-');
      }
    }
    html += '<tr class="' + (m && m.status === 'unmatched' ? 'duplicate' : '') + '">' +
      '<td>' + esc(r.date) + '</td>' +
      '<td class="cell-ellipsis" title="' + esc(r.counterparty) + '">' + esc(r.counterparty || '-') + '</td>' +
      '<td class="center">' + (r.direction === 'in' ? '收款' : '付款') + '</td>' +
      '<td class="num">' + formatAmount(r.amount.toFixed(2)) + '</td>' +
      '<td class="center"><span class="tag ' + statusClass + '">' + statusText + '</span></td>' +
      '<td class="mono">' + esc(docNo) + '</td>' +
      '<td class="cell-ellipsis" title="' + esc(docParty) + '">' + esc(docParty) + '</td>' +
      '<td class="num">' + diffHtml + '</td>' +
      '<td class="' + warnClass + '">' + esc(reason) + '</td>' +
      '</tr>';
  });
  body.innerHTML = html;

  const meta = res
    ? '共 ' + rows.length + ' 笔，匹配 ' + res.stats.matched + ' 笔，未匹配 ' + res.stats.unmatched + ' 笔' + (isBiz ? '（阶梯式：L1 ' + res.stats.l1 + ' / L2 ' + res.stats.l2 + ' / L3 ' + res.stats.l3 + '）' : '')
    : '共 ' + rows.length + ' 笔，待对账';
  $('reconMeta').textContent = meta;
  $('reconMeta').className = 'result-meta' + (res && res.stats.unmatched > 0 ? ' warn' : '');
  $('startReconBtn').disabled = false;
  $('clearReconBtn').disabled = false;
  $('exportReconBtn').disabled = !(res && res.rows.length > 0);
  $('reconAiBtn').disabled = !(res && res.rows.some(r => r.status === 'unmatched'));

  // 异议表 + 回款看板（仅业务单据模式）
  if (isBiz) renderReconIssues();
  if (isBiz) renderCollectionBoard();
}

/* ---- 待办异议表（红蓝橙） ---- */

const ISSUE_LABEL = { red: '长款', blue: '短款', orange: '重复' };

function renderReconIssues() {
  const issues = state.reconIssues || [];
  const c = (n) => issues.filter(x => x.level === n).length;
  $('issuesSummary').innerHTML =
    '<div class="issue-chip type-red"><span class="dot"></span><span class="label">红·长款（银行有账业务无单）</span><span class="num">' + c('red') + '</span></div>' +
    '<div class="issue-chip type-blue"><span class="dot"></span><span class="label">蓝·短款（业务有单银行无账）</span><span class="num">' + c('blue') + '</span></div>' +
    '<div class="issue-chip type-orange"><span class="dot"></span><span class="label">橙·重复（单号被重复核销）</span><span class="num">' + c('orange') + '</span></div>';

  if (!issues.length) {
    $('issuesList').innerHTML = '<div class="report-none">没有待办异议，所有流水与单据均已对上 ✔</div>';
    return;
  }
  $('issuesList').innerHTML = issues.map((it) => {
    const side = it.level === 'blue'
      ? formatAmount((it.remaining || it.amount).toFixed(2))
      : formatAmount(it.amount.toFixed(2));
    return '<div class="issues-item type-' + it.level + '">' +
      '<span class="issue-badge type-' + it.level + '">' + (ISSUE_LABEL[it.level] || it.kind) + '</span>' +
      '<div class="issue-body">' +
        '<div class="issue-title">' + esc(it.title) + '</div>' +
        '<div class="issue-desc">' + esc(it.text) + '</div>' +
        '<div class="issue-suggestion">' + issueSuggestion(it) + '</div>' +
      '</div>' +
      '<div class="issue-side type-' + it.level + '">¥' + side + '</div>' +
      '</div>';
  }).join('');
}

function issueSuggestion(it) {
  if (it.level === 'red') return '建议：核对银行摘要，确认是否为未录单的业务/费用，补录业务单据或做账外说明';
  if (it.level === 'blue') return '建议：跟进催收/付款，确认对方是否已支付但流水未下载完整，或调整预计到账日期';
  return '建议：核对两笔流水是否同一笔款项，确认是否重复入账，必要时红冲或联系银行';
}

/* ---- 回款看板 ---- */

const BOARD_STATUS = {
  settled: { text: '已结清', cls: 'settled' },
  partial: { text: '部分到账', cls: 'partial' },
  overdue: { text: '已逾期', cls: 'overdue' },
  pending: { text: '未到账', cls: 'pending' }
};

function renderCollectionBoard() {
  const board = state.collectionBoard || [];
  const sum = (f) => board.reduce((a, b) => a + (f(b) || 0), 0);
  const amt = (n) => '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  $('boardSummary').innerHTML =
    '<div class="board-chip">应收合计 <strong>' + amt(sum(b => b.type === '应收' ? b.dueTotal : 0)) + '</strong></div>' +
    '<div class="board-chip">应付合计 <strong>' + amt(sum(b => b.type === '应付' ? b.dueTotal : 0)) + '</strong></div>' +
    '<div class="board-chip">已到账 <strong style="color:var(--color-success)">' + amt(sum(b => b.matchedAmount)) + '</strong></div>' +
    '<div class="board-chip">未结清 <strong style="color:var(--color-warning)">' + amt(sum(b => b.remaining)) + '</strong></div>';

  if (!board.length) {
    $('boardGrid').innerHTML = '<div class="report-none">暂无单据，导入业务单据后生成回款看板</div>';
    return;
  }
  $('boardGrid').innerHTML = board.map((g) => {
    const st = BOARD_STATUS[g.status] || BOARD_STATUS.pending;
    const openInfo = g.openDocs && g.openDocs.length
      ? g.openDocs.map(d => '单号 ' + d.docNo + (d.dueDate ? '（' + d.dueDate + '）' : '')).join('、')
      : '';
    return '<div class="board-card">' +
      '<div class="board-head">' +
        '<span class="board-party" title="' + esc(g.party) + '">' + esc(g.party) + '</span>' +
        '<span class="board-type">' + (g.type === '应收' ? '应收' : '应付') + '</span>' +
      '</div>' +
      '<div class="board-amounts">' +
        '<div class="row"><span>应收/应付合计</span><span class="amt">' + amt(g.dueTotal) + '</span></div>' +
        '<div class="row"><span>银行已到账</span><span class="amt paid">' + amt(g.matchedAmount) + '</span></div>' +
        '<div class="row"><span>未到账</span><span class="amt left">' + amt(g.remaining) + '</span></div>' +
      '</div>' +
      '<div class="board-head"><span class="board-status ' + st.cls + '">' + st.text + (g.status === 'overdue' && g.overdueDays > 0 ? ' · 逾期 ' + g.overdueDays + ' 天' : '') + '</span>' +
        '<span class="board-overdue">到账率 ' + g.ratio + '% · ' + g.docCount + ' 单</span></div>' +
      (openInfo ? '<div class="board-foot">未结：' + esc(openInfo) + '</div>' : '') +
      '</div>';
  }).join('');
}

function switchReconView(view) {
  if (view !== 'detail' && view !== 'issues' && view !== 'board') return;
  state.reconView = view;
  renderRecon();
}

function clearRecon() {
  state.bankRows = [];
  state.reconResult = null;
  state.reconIssues = [];
  state.collectionBoard = [];
  state.reconView = 'detail';
  $('reconAiResult').hidden = true;
  renderRecon();
  showToast('已清空对账数据', 'success');
}

function exportReconExcel() {
  if (!state.reconResult || !state.reconResult.rows.length) return;
  try {
    const wb = Recon.buildReconWorkbook(state.reconResult.rows);
    XLSX.writeFile(wb, '对账结果_' + new Date().toISOString().slice(0, 10) + '.xlsx');
    showToast('已导出对账结果 Excel', 'success');
  } catch (err) {
    console.error(err);
    showToast('导出失败: ' + err.message, 'error');
  }
}

// AI 分析未匹配流水原因
async function aiAnalyzeRecon() {
  if (!state.reconResult) return;
  const unmatched = state.reconResult.rows.filter(r => r.status === 'unmatched');
  if (!unmatched.length) { showToast('没有未匹配项需要分析', 'success'); return; }
  if (!AI.isConfigured('llm')) {
    showToast('请先在「设置」中开启并配置大模型（DeepSeek/混元等）', 'error');
    return;
  }
  showLoading('AI 正在分析 ' + unmatched.length + ' 笔未匹配流水...');
  try {
    const p = Recon.analyzeUnmatchedPrompt(unmatched, state.bankRows);
    const content = await AI.llmChat([
      { role: 'system', content: p.system },
      { role: 'user', content: p.user }
    ], { temperature: 0.3, maxTokens: 1200 });
    renderMarkdownToHtml($('reconAiResult'), content);
    $('reconAiResult').hidden = false;
    hideLoading();
    showToast('AI 分析完成', 'success');
  } catch (err) {
    hideLoading();
    console.error(err);
    showToast('AI 分析失败: ' + err.message, 'error');
  }
}

/* ============ 报表中心（周报 / 月报 / AI 分析） ============ */

// 极简 Markdown 渲染（标题/列表/加粗/行内代码）
function inlineMd(s) {
  return esc(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/\*([^*]+)\*/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

function renderMarkdownToHtml(el, md) {
  const lines = String(md || '').split('\n');
  let html = '', listTag = '';
  lines.forEach(l => {
    if (/^#{1,4}\s/.test(l)) {
      if (listTag) { html += '</' + listTag + '>'; listTag = ''; }
      const level = l.match(/^#+/)[0].length;
      html += '<div class="md-h' + level + '">' + inlineMd(l.replace(/^#+\s*/, '')) + '</div>';
    } else if (/^\s*[-*]\s/.test(l)) {
      if (listTag !== 'ul') {
        if (listTag) html += '</' + listTag + '>';
        html += '<ul class="md-list">';
        listTag = 'ul';
      }
      html += '<li>' + inlineMd(l.replace(/^\s*[-*]\s*/, '')) + '</li>';
    } else if (/^\s*\d+[.、]\s/.test(l)) {
      if (listTag !== 'ol') {
        if (listTag) html += '</' + listTag + '>';
        html += '<ol class="md-list">';
        listTag = 'ol';
      }
      html += '<li>' + inlineMd(l.replace(/^\s*\d+[.、]\s*/, '')) + '</li>';
    } else {
      if (listTag) { html += '</' + listTag + '>'; listTag = ''; }
      if (l.trim()) html += '<div class="md-p">' + inlineMd(l) + '</div>';
    }
  });
  if (listTag) html += '</' + listTag + '>';
  el.innerHTML = html;
}

function fmtDateObj(d) {
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
}

function buildWeekly() {
  if (!state.ledger.length) { showToast('台账为空，请先上传发票', 'error'); return; }
  const rep = Report.buildWeeklyReport(state.ledger, { isMyCompanyFn: isMyCompany });
  state.currentReport = rep;
  renderReportView(rep);
}

function buildMonthly() {
  if (!state.ledger.length) { showToast('台账为空，请先上传发票', 'error'); return; }
  const rep = Report.buildMonthlyReport(state.ledger, { isMyCompanyFn: isMyCompany });
  state.currentReport = rep;
  renderReportView(rep);
}

function renderReportView(rep) {
  const s = rep.snapshot;
  const fmt = (n) => '¥' + n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const rangeText = fmtDateObj(rep.range.start) + ' ~ ' + fmtDateObj(rep.range.end);

  let html = '';
  // 头部
  html += '<div class="report-card report-head">' +
    '<div class="report-title">' + esc(rep.title) + '</div>' +
    '<div class="report-sub">数据范围：' + rangeText + ' · 共 ' + s.count + ' 张发票</div>' +
    '</div>';
  // 收支汇总
  html += '<div class="report-grid">' +
    '<div class="report-metric"><span class="rm-label">收入</span><span class="rm-value in">' + fmt(s.inAmount) + '</span><span class="rm-sub">' + s.inCount + ' 张</span></div>' +
    '<div class="report-metric"><span class="rm-label">支出</span><span class="rm-value out">' + fmt(s.outAmount) + '</span><span class="rm-sub">' + s.outCount + ' 张</span></div>' +
    '<div class="report-metric"><span class="rm-label">净额</span><span class="rm-value">' + fmt(s.netAmount) + '</span><span class="rm-sub">收入 - 支出</span></div>' +
    '</div>';
  // Top5 供应商
  html += '<div class="report-card"><div class="report-card-title">Top5 供应商（支出）</div>';
  if (s.topSuppliers.length) {
    const max = s.topSuppliers[0].amount || 1;
    html += s.topSuppliers.map((x, i) =>
      '<div class="report-bar-row"><span class="rb-rank">' + (i + 1) + '</span>' +
      '<span class="rb-name" title="' + esc(x.name) + '">' + esc(x.name) + '</span>' +
      '<span class="rb-track"><span class="rb-fill" style="width:' + Math.max(4, Math.round(x.amount / max * 100)) + '%"></span></span>' +
      '<span class="rb-val">' + fmt(x.amount) + ' <em>' + x.count + ' 笔</em></span></div>').join('');
  } else {
    html += '<div class="report-none">本期无支出数据</div>';
  }
  html += '</div>';
  // Top5 客户
  if (s.topBuyers.length) {
    html += '<div class="report-card"><div class="report-card-title">Top5 客户（收入）</div>';
    const max = s.topBuyers[0].amount || 1;
    html += s.topBuyers.map((x, i) =>
      '<div class="report-bar-row"><span class="rb-rank">' + (i + 1) + '</span>' +
      '<span class="rb-name" title="' + esc(x.name) + '">' + esc(x.name) + '</span>' +
      '<span class="rb-track"><span class="rb-fill in" style="width:' + Math.max(4, Math.round(x.amount / max * 100)) + '%"></span></span>' +
      '<span class="rb-val">' + fmt(x.amount) + ' <em>' + x.count + ' 笔</em></span></div>').join('');
    html += '</div>';
  }
  // 支出分类占比
  html += '<div class="report-card"><div class="report-card-title">支出分类占比</div>';
  if (s.outCategory.length) {
    const max = s.outCategory[0].amount || 1;
    html += s.outCategory.map((x, i) =>
      '<div class="report-bar-row"><span class="rb-rank">' + (i + 1) + '</span>' +
      '<span class="rb-name" title="' + esc(x.name) + '">' + esc(x.name) + '</span>' +
      '<span class="rb-track"><span class="rb-fill cat" style="width:' + Math.max(4, Math.round(x.amount / max * 100)) + '%"></span></span>' +
      '<span class="rb-val">' + fmt(x.amount) + ' <em>' + x.count + ' 笔</em></span></div>').join('');
  } else {
    html += '<div class="report-none">本期无支出数据</div>';
  }
  html += '</div>';
  // 异常提醒
  if (rep.alerts.length) {
    html += '<div class="report-card"><div class="report-card-title">异常波动提醒（环比）</div>' +
      rep.alerts.map(a => '<div class="alert-item ' + a.level + '">' + esc(a.text) + '</div>').join('') +
      '</div>';
  }
  // 分析
  if (rep.analysis) {
    html += '<div class="report-card"><div class="report-card-title">AI 财务分析</div><div class="md-body">' +
      renderMarkdownText(rep.analysis) + '</div></div>';
  }
  $('reportView').innerHTML = html;
  $('reportHint').textContent = '已生成：' + esc(rep.title) + '。可「复制简报」或「导出 Excel」';
}

// 分析报告 Markdown → HTML（纯文本返回）
function renderMarkdownText(md) {
  const tmp = document.createElement('div');
  renderMarkdownToHtml(tmp, md);
  return tmp.innerHTML;
}

// 用大模型生成文字版财务分析（未配置时模板降级）
// v4.0：4 段固定结构（总体概览/费用异动预警/现金流健康度/业务提示），只基于提供数据
async function aiAnalyzeReport() {
  if (!state.ledger.length && !state.bankRows.length) {
    showToast('台账为空，请先上传发票（或银行流水）再生成分析', 'error');
    return;
  }
  const data = collectAnalysisData();
  if (!AI.isConfigured('llm')) {
    const content = Report.templateAnalysisV2(data);
    renderAnalysisV2(content);
    showToast('未配置大模型，已用内置模板生成 4 段式分析（配置后效果更佳）', 'error');
    return;
  }
  showLoading('AI 正在生成 4 段式财务分析报告...');
  try {
    const p = Report.buildAnalysisReportV2(data);
    const content = await AI.llmChat([
      { role: 'system', content: p.system },
      { role: 'user', content: p.user }
    ], { temperature: 0.4, maxTokens: 1500 });
    renderAnalysisV2(content);
    hideLoading();
    showToast('AI 4 段式财务分析报告已生成', 'success');
  } catch (err) {
    hideLoading();
    console.error(err);
    showToast('AI 分析失败: ' + err.message, 'error');
  }
}

// 汇总 4 段式分析所需数据：当前月快照 + 三张出表模板 + 环比预警
function collectAnalysisData() {
  const now = new Date();
  const y = now.getFullYear(), m = now.getMonth() + 1;
  const fmtD = (d) => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  const snap = Report.buildFinancialSnapshot(state.ledger, {
    from: fmtD(new Date(y, m - 1, 1)), to: fmtD(new Date(y, m, 0)), isMyCompanyFn: isMyCompany
  });
  const prev = Report.buildFinancialSnapshot(state.ledger, {
    from: fmtD(new Date(y, m - 2, 1)), to: fmtD(new Date(y, m - 1, 0)), isMyCompanyFn: isMyCompany
  });
  return {
    period: y + '年' + m + '月',
    snapshot: snap,
    alerts: Report.compareSnapshots(snap, prev),
    income: state.currentTemplate && state.currentTemplate.kind === 'income'
      ? state.currentTemplate
      : Report.buildIncomeStatement(state.ledger, { isMyCompanyFn: isMyCompany }),
    expenseRank: state.currentTemplate && state.currentTemplate.kind === 'expenseRank'
      ? state.currentTemplate
      : Report.buildExpenseRanking(state.ledger, { isMyCompanyFn: isMyCompany }),
    cashflow: state.bankRows.length ? Report.buildCashflow(state.bankRows) : null
  };
}

// 4 段式分析结果渲染（Markdown → 卡片）
function renderAnalysisV2(md) {
  const title = 'AI 4 段式财务分析（' + new Date().toLocaleDateString('zh-CN') + '）';
  state.currentAnalysis = md;
  let html = '<div class="report-card report-head"><div class="report-title">' + title + '</div>' +
    '<div class="report-sub">四段结构：总体概览 / 费用异动预警 / 现金流健康度 / 业务提示 · 仅基于已导入数据生成</div></div>';
  html += '<div class="report-card"><div class="md-body">' + renderMarkdownText(md) + '</div></div>';
  $('reportView').innerHTML = html;
  $('reportHint').textContent = '已生成 AI 4 段式分析报告。可「导出 Word」或「打印/PDF」';
}

function copyBrief() {
  if (!state.currentReport && !state.currentTemplate && !state.currentAnalysis) { showToast('请先生成周报/月报或出表模板', 'error'); return; }
  let text;
  if (state.currentAnalysis) text = state.currentAnalysis;
  else if (state.currentTemplate) text = templateBriefText(state.currentTemplate);
  else text = Report.buildBriefText(state.currentReport);
  const done = () => showToast('简报已复制，可粘贴到微信 / 钉钉 / 文档分享', 'success');
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(done).catch(() => {
      fallbackCopy(text); done();
    });
  } else {
    fallbackCopy(text); done();
  }
}

// 出表模板 → 纯文本简报
function templateBriefText(rep) {
  const lines = [rep.title];
  if (rep.kind === 'income') {
    lines.push('收入合计 ' + TMPL_FMT(rep.totals.income.current) + '（上月 ' + TMPL_FMT(rep.totals.income.lastMonth) + '）');
    lines.push('支出合计 ' + TMPL_FMT(rep.totals.expense.current) + '（上月 ' + TMPL_FMT(rep.totals.expense.lastMonth) + '）');
    lines.push('净额 ' + TMPL_FMT(rep.totals.net.current) + '（上月 ' + TMPL_FMT(rep.totals.net.lastMonth) + '）');
    rep.rows.slice(0, 6).forEach(r => lines.push('- ' + r.name + '：' + TMPL_FMT(r.current) + '（环比 ' + TMPL_PCT(r.momPct) + '）'));
  } else if (rep.kind === 'expenseRank') {
    lines.push('支出合计 ' + TMPL_FMT(rep.total) + '，共 ' + rep.totalCount + ' 笔');
    rep.rows.slice(0, 5).forEach(r => lines.push((r.rank <= 3 ? '★' : '') + r.rank + '. ' + r.name + '：' + TMPL_FMT(r.amount) + '（占 ' + r.pct + '%）'));
  } else if (rep.kind === 'cashflow') {
    lines.push('总流入 ' + TMPL_FMT(rep.totalIn) + ' / 总流出 ' + TMPL_FMT(rep.totalOut) + ' / 净额 ' + TMPL_FMT(rep.net));
    ['经营', '投资', '筹资', '未分类'].forEach(k => {
      const g = rep.sections[k] || { in: 0, out: 0, net: 0, count: 0 };
      if (g.count > 0) lines.push('- ' + k + '：流入 ' + TMPL_FMT(g.in) + ' / 流出 ' + TMPL_FMT(g.out) + ' / 净额 ' + TMPL_FMT(g.net) + '（' + g.count + ' 笔）');
    });
  }
  return lines.join('\n');
}

function fallbackCopy(text) {
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  try { document.execCommand('copy'); } catch (e) { /* ignore */ }
  document.body.removeChild(ta);
}

function exportReportExcel() {
  // 出表模板走专用导出；周报/月报走原导出
  if (state.currentTemplate) { exportTemplateExcel(); return; }
  if (!state.currentReport) { showToast('请先生成周报或月报（或出表模板）', 'error'); return; }
  const s = state.currentReport.snapshot;
  const rows = [
    ['票小帮 · 业务报表'],
    ['报表', state.currentReport.title],
    ['数据范围', fmtDateObj(state.currentReport.range.start) + ' ~ ' + fmtDateObj(state.currentReport.range.end)],
    [],
    ['指标', '数值'],
    ['收入(元)', s.inAmount],
    ['支出(元)', s.outAmount],
    ['净额(元)', s.netAmount],
    ['发票张数', s.count],
    ['收入张数', s.inCount],
    ['支出张数', s.outCount],
    [],
    ['Top5 供应商', '金额(元)', '笔数'],
  ];
  s.topSuppliers.forEach(x => rows.push([x.name, x.amount, x.count]));
  rows.push([], ['支出分类', '金额(元)', '笔数']);
  s.outCategory.forEach(x => rows.push([x.name, x.amount, x.count]));
  if (state.currentReport.analysis) {
    rows.push([], ['AI 分析']);
    String(state.currentReport.analysis).split('\n').forEach(l => rows.push([l]));
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 24 }, { wch: 16 }, { wch: 10 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '业务报表');
  XLSX.writeFile(wb, '业务报表_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  showToast('已导出业务报表 Excel', 'success');
}

/* ============ 出表模板（损益对比 / 费用排行 / 现金流简表） ============ */

const TMPL_FMT = (n) => '¥' + (n || 0).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const TMPL_PCT = (n) => (n === undefined || n === null || n === '' || isNaN(n)) ? '-' : (n > 0 ? '+' : '') + n + '%';
const TMPL_PCT_CLS = (n) => (Math.abs(n || 0) >= 30 ? ' cell-warn' : '');

function buildIncome() {
  if (!state.ledger.length) { showToast('台账为空，请先上传发票', 'error'); return; }
  const rep = Report.buildIncomeStatement(state.ledger, { isMyCompanyFn: isMyCompany });
  state.currentTemplate = rep;
  renderTemplateView(rep);
}

function buildExpenseRank(by) {
  if (!state.ledger.length) { showToast('台账为空，请先上传发票', 'error'); return; }
  const rep = Report.buildExpenseRanking(state.ledger, { isMyCompanyFn: isMyCompany, by: by || 'category' });
  state.currentTemplate = rep;
  renderTemplateView(rep);
}

function buildCashflow() {
  if (!state.bankRows.length) { showToast('请先在对账页上传银行流水（现金流简表取数自银行流水）', 'error'); return; }
  const rep = Report.buildCashflow(state.bankRows);
  state.currentTemplate = rep;
  renderTemplateView(rep);
}

// 模板视图渲染：损益对比表 / 费用排行 / 现金流简表
function renderTemplateView(rep) {
  state.currentTemplate = rep;
  const nowTxt = new Date().toLocaleDateString('zh-CN');
  let html = '<div class="report-card report-head"><div class="report-title">' + esc(rep.title) + '</div>' +
    '<div class="report-sub">数据来源：本地发票台账 / 银行流水 · ' + nowTxt + ' 生成</div></div>';

  if (rep.kind === 'income') {
    const mkRows = (rows, kind) => rows.filter(r => r.kind === kind).map(r =>
      '<tr><td>' + esc(r.name) + '</td>' +
      '<td class="num">' + TMPL_FMT(r.current) + '</td>' +
      '<td class="num">' + TMPL_FMT(r.lastMonth) + '</td>' +
      '<td class="num">' + TMPL_FMT(r.lastYear) + '</td>' +
      '<td class="num' + TMPL_PCT_CLS(r.momPct) + '">' + TMPL_PCT(r.momPct) + '</td>' +
      '<td class="num' + TMPL_PCT_CLS(r.yoyPct) + '">' + TMPL_PCT(r.yoyPct) + '</td></tr>').join('');
    const mkTotal = (label, t) =>
      '<tr class="tmpl-total"><td>' + label + '</td>' +
      '<td class="num">' + TMPL_FMT(t.current) + '</td>' +
      '<td class="num">' + TMPL_FMT(t.lastMonth) + '</td>' +
      '<td class="num">' + TMPL_FMT(t.lastYear) + '</td><td></td><td></td></tr>';
    html += '<div class="report-card"><div class="report-card-title">收入</div>' +
      '<table class="tmpl-table"><thead><tr><th>项目</th><th class="num">本月</th><th class="num">上月</th><th class="num">去年同期</th><th class="num">环比</th><th class="num">同比</th></tr></thead>' +
      '<tbody>' + (mkRows(rep.rows, 'income') || '<tr><td colspan="6" class="report-none">本期无收入</td></tr>') + mkTotal('收入合计', rep.totals.income) + '</tbody></table></div>';
    html += '<div class="report-card"><div class="report-card-title">支出</div>' +
      '<table class="tmpl-table"><thead><tr><th>项目</th><th class="num">本月</th><th class="num">上月</th><th class="num">去年同期</th><th class="num">环比</th><th class="num">同比</th></tr></thead>' +
      '<tbody>' + (mkRows(rep.rows, 'expense') || '<tr><td colspan="6" class="report-none">本期无支出</td></tr>') + mkTotal('支出合计', rep.totals.expense) + mkTotal('净额', rep.totals.net) + '</tbody></table></div>';
    html += '<div class="report-hint-txt">说明：环比 = 本月 vs 上月，同比 = 本月 vs 去年同期；红色标注波动 ≥30% 的项目，建议核查原因。</div>';
  }

  if (rep.kind === 'expenseRank') {
    const byLabel = rep.by === 'seller' ? '供应商' : '分类';
    html += '<div class="view-tabs" style="margin:10px 0">' +
      '<button class="view-tab' + (rep.by === 'category' ? ' active' : '') + '" onclick="toggleExpenseRank(\'category\')">按分类</button>' +
      '<button class="view-tab' + (rep.by === 'seller' ? ' active' : '') + '" onclick="toggleExpenseRank(\'seller\')">按供应商</button></div>';
    html += '<div class="report-card"><div class="report-card-title">' + rep.period + ' 费用排行（按' + byLabel + '）· 合计 ' + TMPL_FMT(rep.total) + ' / ' + rep.totalCount + ' 笔</div>' +
      '<table class="tmpl-table"><thead><tr><th>排名</th><th>' + byLabel + '</th><th class="num">金额</th><th class="num">占比</th><th class="num">笔数</th></tr></thead><tbody>';
    if (rep.rows.length) {
      rep.rows.forEach(r => html +=
        '<tr' + (r.rank <= 3 ? ' class="tmpl-top"' : '') + '>' +
        '<td class="center">' + (r.rank <= 3 ? '<span class="rank-badge top' + r.rank + '">' + r.rank + '</span>' : r.rank) + '</td>' +
        '<td>' + esc(r.name) + '</td>' +
        '<td class="num">' + TMPL_FMT(r.amount) + '</td>' +
        '<td class="num">' + r.pct + '%</td>' +
        '<td class="num">' + r.count + '</td></tr>');
    } else {
      html += '<tr><td colspan="5" class="report-none">本期无支出数据</td></tr>';
    }
    html += '</tbody></table></div>';
    html += '<div class="report-hint-txt">说明：Top3 高亮显示；占比 = 该' + byLabel + '金额 / 本期支出总额。</div>';
  }

  if (rep.kind === 'cashflow') {
    const netCls = rep.net >= 0 ? 'rm-value in' : 'rm-value out';
    html += '<div class="report-grid">' +
      '<div class="report-metric"><span class="rm-label">总流入</span><span class="rm-value in">' + TMPL_FMT(rep.totalIn) + '</span></div>' +
      '<div class="report-metric"><span class="rm-label">总流出</span><span class="rm-value out">' + TMPL_FMT(rep.totalOut) + '</span></div>' +
      '<div class="report-metric"><span class="rm-label">净额</span><span class="' + netCls + '">' + TMPL_FMT(rep.net) + '</span></div></div>';
    html += '<div class="report-card"><div class="report-card-title">现金流结构（经营 / 投资 / 筹资）</div>' +
      '<table class="tmpl-table"><thead><tr><th>类别</th><th class="num">流入</th><th class="num">流出</th><th class="num">净额</th><th class="num">笔数</th></tr></thead><tbody>';
    ['经营', '投资', '筹资', '未分类'].forEach(k => {
      const g = rep.sections[k] || { in: 0, out: 0, net: 0, count: 0 };
      html += '<tr' + (k === '未分类' && g.count > 0 ? ' class="tmpl-warn"' : '') + '>' +
        '<td>' + k + '</td>' +
        '<td class="num">' + TMPL_FMT(g.in) + '</td>' +
        '<td class="num">' + TMPL_FMT(g.out) + '</td>' +
        '<td class="num">' + TMPL_FMT(g.net) + '</td>' +
        '<td class="num">' + g.count + '</td></tr>';
    });
    html += '</tbody></table></div>';
    html += '<div class="report-hint-txt">说明：按「摘要 / 对方户名」关键词自动归类（如 工资/货款→经营，设备/股权→投资，贷款/利息→筹资）；未分类流水建议补充规则后重新生成。</div>';
  }

  $('reportView').innerHTML = html;
  $('reportHint').textContent = '已生成：' + rep.title + '。可「导出 Excel / Word」或「打印/PDF」，或点击「AI 分析报告」生成 4 段式文字分析';
}

// 费用排行视图内切换 按分类 / 按供应商
function toggleExpenseRank(by) {
  buildExpenseRank(by);
}

// 出表模板导出 Excel（复用同一入口）
function exportTemplateExcel() {
  const rep = state.currentTemplate;
  if (!rep) { showToast('请先生成出表模板', 'error'); return; }
  const rows = [[rep.title], [], []];
  if (rep.kind === 'income') {
    rows[1] = ['项目', '本月(元)', '上月(元)', '去年同期(元)', '环比%', '同比%'];
    rep.rows.forEach(r => rows.push([r.name, r.current, r.lastMonth, r.lastYear, r.momPct, r.yoyPct]));
    rows.push(['收入合计', rep.totals.income.current, rep.totals.income.lastMonth, rep.totals.income.lastYear, '', '']);
    rows.push(['支出合计', rep.totals.expense.current, rep.totals.expense.lastMonth, rep.totals.expense.lastYear, '', '']);
    rows.push(['净额', rep.totals.net.current, rep.totals.net.lastMonth, rep.totals.net.lastYear, '', '']);
  } else if (rep.kind === 'expenseRank') {
    rows[1] = ['排名', rep.by === 'seller' ? '供应商' : '分类', '金额(元)', '占比%', '笔数'];
    rep.rows.forEach(r => rows.push([r.rank, r.name, r.amount, r.pct, r.count]));
    rows.push(['合计', '', rep.total, 100, rep.totalCount]);
  } else if (rep.kind === 'cashflow') {
    rows[1] = ['类别', '流入(元)', '流出(元)', '净额(元)', '笔数'];
    ['经营', '投资', '筹资', '未分类'].forEach(k => {
      const g = rep.sections[k] || { in: 0, out: 0, net: 0, count: 0 };
      rows.push([k, g.in, g.out, g.net, g.count]);
    });
    rows.push(['合计', rep.totalIn, rep.totalOut, rep.net, rep.rows.length]);
  }
  const ws = XLSX.utils.aoa_to_sheet(rows);
  ws['!cols'] = [{ wch: 22 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 8 }, { wch: 8 }];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, '出表模板');
  XLSX.writeFile(wb, rep.title.replace(/\s+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.xlsx');
  showToast('已导出出表模板 Excel', 'success');
}

/* ============ 导出 Word / 打印 PDF ============ */

// 报表视图 → 内嵌样式的 HTML（供 Word/打印复用）
const REPORT_PRINT_CSS = [
  'body{font-family:"Microsoft YaHei",sans-serif;color:#1f2937;font-size:13px;margin:24px}',
  'h2{text-align:center;margin-bottom:4px}',
  '.report-sub{color:#888;font-size:12px;text-align:center;margin-bottom:16px}',
  '.report-card{border:1px solid #e5e7eb;border-radius:8px;padding:12px 14px;margin:12px 0;page-break-inside:avoid}',
  '.report-title{font-size:16px;font-weight:700;text-align:center}',
  '.report-grid{display:flex;gap:12px;margin:12px 0}',
  '.report-metric{flex:1;border:1px solid #e5e7eb;border-radius:8px;padding:10px;text-align:center}',
  '.rm-label{display:block;color:#888;font-size:12px}.rm-value{display:block;font-size:18px;font-weight:700}.rm-value.in{color:#16a34a}.rm-value.out{color:#dc2626}',
  '.report-card-title{font-weight:700;margin-bottom:8px}',
  '.tmpl-table{width:100%;border-collapse:collapse;font-size:12.5px}',
  '.tmpl-table th,.tmpl-table td{border:1px solid #e5e7eb;padding:6px 8px;text-align:left}',
  '.tmpl-table th{background:#f3f4f6}.num{text-align:right;font-variant-numeric:tabular-nums}',
  '.center{text-align:center}.tmpl-total td{font-weight:700;background:#f9fafb}',
  '.tmpl-top td{background:#fff7ed}.tmpl-warn td{background:#fef2f2}',
  '.rank-badge{display:inline-block;min-width:18px;text-align:center;border-radius:50%;color:#fff;font-size:11px;padding:1px 4px}',
  '.rank-badge.top1{background:#dc2626}.rank-badge.top2{background:#ea580c}.rank-badge.top3{background:#d97706}',
  '.report-hint-txt{color:#888;font-size:12px;margin-top:10px}',
  '.md-body{line-height:1.8}.md-h1{font-size:15px;font-weight:700;margin:10px 0 6px}.md-h2{font-size:14px;font-weight:700;margin:10px 0 6px}',
  '.md-h3{font-size:13px;font-weight:600;margin:8px 0 4px}.md-p{margin:6px 0}.md-list{margin:6px 0;padding-left:20px}',
  '.view-tabs{display:none}',
  '.tag,.issue-chip,.board-chip{display:none}'
].join('');

function reportViewToHtml(title) {
  const bodyHtml = $('reportView') ? $('reportView').innerHTML : '';
  return '<html><head><meta charset="utf-8"><style>' + REPORT_PRINT_CSS + '</style></head><body>' +
    '<h2>' + esc(title) + '</h2>' +
    '<div class="report-sub">票小帮 · 生成时间：' + new Date().toLocaleString('zh-CN') + '</div>' +
    bodyHtml + '</body></html>';
}

function currentDocTitle() {
  if (state.currentAnalysis) return 'AI 财务分析报告';
  if (state.currentTemplate) return state.currentTemplate.title;
  if (state.currentReport) return state.currentReport.title;
  return '票小帮报表';
}

function exportReportWord() {
  if (!state.currentReport && !state.currentTemplate && !state.currentAnalysis) {
    showToast('请先生成报表或分析报告', 'error');
    return;
  }
  const html = reportViewToHtml(currentDocTitle());
  const blob = new Blob(['\ufeff' + html], { type: 'application/msword;charset=utf-8' });
  downloadBlob(blob, currentDocTitle().replace(/\s+/g, '_') + '_' + new Date().toISOString().slice(0, 10) + '.doc');
  showToast('已导出 Word 文档（.doc）', 'success');
}

function exportReportPdf() {
  if (!state.currentReport && !state.currentTemplate && !state.currentAnalysis) {
    showToast('请先生成报表或分析报告', 'error');
    return;
  }
  const html = reportViewToHtml(currentDocTitle());
  const w = window.open('', '_blank', 'width=900,height=700');
  if (!w) { showToast('浏览器拦截了打印窗口，请允许弹窗后重试', 'error'); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
  setTimeout(() => { w.focus(); w.print(); }, 300);
  showToast('请在打印窗口中选择「另存为 PDF」或直接打印', 'success');
}

// 周一打开页面自动生成上周周报（仅本地统计，不发送邮件）
function checkMondayReport() {
  try {
    const d = new Date();
    if (d.getDay() !== 1) return;
    if (!state.ledger.length) return;
    const rep = Report.buildWeeklyReport(state.ledger, { isMyCompanyFn: isMyCompany });
    if (rep.snapshot.count === 0) return;
    state.currentReport = rep;
    renderReportView(rep);
    setTimeout(() => {
      showToast('今天是周一，已自动生成上周周报：收入 ¥' + rep.snapshot.inAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) +
        '，支出 ¥' + rep.snapshot.outAmount.toLocaleString('zh-CN', { minimumFractionDigits: 2 }) + '，见「报表中心」', 'success');
    }, 1200);
  } catch (err) {
    console.error('周一自动生成周报失败:', err);
  }
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
  saveLedgerNow();
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

/* ============ 设置弹窗 ============ */

function openSettings() {
  const s = AI.getSettings();
  $('setMyCompany').value = LC.getMyCompany();
  $('setOcrEnabled').value = s.ocrEnabled ? '1' : '0';
  $('setOcrRegion').value = s.ocrRegion || 'ap-guangzhou';
  $('setOcrSecretId').value = s.ocrSecretId || '';
  $('setOcrSecretKey').value = s.ocrSecretKey || '';
  $('setLlmEnabled').value = s.llmEnabled ? '1' : '0';
  $('setLlmProvider').value = s.llmProvider === 'anthropic' ? 'anthropic' : 'openai';
  $('setLlmBaseUrl').value = s.llmBaseUrl || (s.llmProvider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com');
  $('setLlmModel').value = s.llmModel || (s.llmProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'deepseek-chat');
  $('setLlmApiKey').value = s.llmApiKey || '';
  $('settingsModal').hidden = false;
}

function closeSettings() {
  $('settingsModal').hidden = true;
}

function saveSettingsModal() {
  AI.saveSettings({
    myCompany: $('setMyCompany').value.trim(),
    ocrEnabled: $('setOcrEnabled').value === '1',
    ocrRegion: $('setOcrRegion').value.trim() || 'ap-guangzhou',
    ocrSecretId: $('setOcrSecretId').value.trim(),
    ocrSecretKey: $('setOcrSecretKey').value.trim(),
    llmEnabled: $('setLlmEnabled').value === '1',
    llmProvider: $('setLlmProvider').value === 'anthropic' ? 'anthropic' : 'openai',
    llmBaseUrl: $('setLlmBaseUrl').value.trim() || ($('setLlmProvider').value === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com'),
    llmModel: $('setLlmModel').value.trim() || ($('setLlmProvider').value === 'anthropic' ? 'claude-sonnet-4-5' : 'deepseek-chat'),
    llmApiKey: $('setLlmApiKey').value.trim()
  });
  if ($('setLlmEnabled').value === '1' && $('setLlmApiKey').value.trim()) {
    showToast('AI 已启用：数据将发送到 ' + ($('setLlmProvider').value === 'anthropic' ? 'Anthropic' : '你配置的') + ' 服务商，其余功能仍本地处理', 'error');
  }
  // 公司名变化 → 重算已有发票的「购买方非本公司」备注
  state.ledger.forEach(inv => {
    inv.remark = LC.buildRemark(inv);
  });
  saveLedgerNow();
  closeSettings();
  renderLedger();
  showToast('设置已保存', 'success');
}

// 启动时从 IndexedDB 恢复台账
async function initFromStore() {
  try {
    const rows = await Store.loadLedger();
    if (rows && rows.length > 0) {
      state.ledger = rows.map(r => { delete r.id; return r; });
      updateTotalCount();
      renderLedger();
      showToast('已恢复本地台账 ' + rows.length + ' 条（重新上传后可打包下载）', 'success');
    }
  } catch (err) {
    console.error('读取本地台账失败:', err);
  }
}

function init() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => switchPage(tab.dataset.page));
  });

  setupUpload('ledgerUploadBox', 'ledgerSelectBtn', 'ledgerFileInput', handleLedgerFiles);
  setupUpload('dedupUploadBox', 'dedupSelectBtn', 'dedupFileInput', handleDedupFiles);
  setupUpload('mergeUploadBox', 'mergeSelectBtn', 'mergeFileInput', handleMergeFiles);

  // 表格导入预览弹窗
  $('importConfirmBtn').addEventListener('click', importConfirmAction);
  $('importCancelBtn').addEventListener('click', importCancelAction);
  $('importCloseBtn').addEventListener('click', importCancelAction);

  $('loadDemoBtn').addEventListener('click', loadDemoData);
  $('exportExcelBtn').addEventListener('click', exportLedgerExcel);
  $('downloadZipBtn').addEventListener('click', downloadLedgerZip);
  $('clearLedgerBtn').addEventListener('click', () => {
    state.ledger = [];
    Store.clearLedger().catch(err => console.error('清空本地台账失败:', err));
    updateTotalCount();
    renderLedger();
    showToast('已清空台账', 'success');
  });

  // 筛选栏
  $('ledgerSearch').addEventListener('input', (e) => {
    filterState.keyword = e.target.value.trim().toLowerCase();
    renderLedger();
  });
  $('ledgerCategoryFilter').addEventListener('change', (e) => {
    filterState.category = e.target.value;
    renderLedger();
  });

  $('exportDedupBtn').addEventListener('click', exportDedupExcel);
  $('clearDedupBtn').addEventListener('click', () => {
    state.dedup = [];
    renderDedup();
    showToast('已清空查重列表', 'success');
  });
  $('dedupFromLedgerBtn').addEventListener('click', dedupFromLedger);

  // 自动对账
  setupUpload('bankUploadBox', 'bankSelectBtn', 'bankFileInput', handleBankFiles);
  setupUpload('bizUploadBox', 'bizSelectBtn', 'bizFileInput', handleBizFiles);
  $('bizClearBtn').addEventListener('click', clearBizDocs);
  $('startReconBtn').addEventListener('click', startRecon);
  $('clearReconBtn').addEventListener('click', clearRecon);
  $('exportReconBtn').addEventListener('click', exportReconExcel);
  $('reconAiBtn').addEventListener('click', aiAnalyzeRecon);
  $('reconViewTabs').addEventListener('click', (e) => {
    const tab = e.target.closest('.view-tab');
    if (tab) switchReconView(tab.dataset.view);
  });

  // 报表中心
  $('weekReportBtn').addEventListener('click', buildWeekly);
  $('monthReportBtn').addEventListener('click', buildMonthly);
  $('incomeBtn').addEventListener('click', buildIncome);
  $('expenseRankBtn').addEventListener('click', () => buildExpenseRank('category'));
  $('cashflowBtn').addEventListener('click', buildCashflow);
  $('aiReportBtn').addEventListener('click', aiAnalyzeReport);
  $('copyBriefBtn').addEventListener('click', copyBrief);
  $('exportReportBtn').addEventListener('click', exportReportExcel);
  $('reportWordBtn').addEventListener('click', exportReportWord);
  $('reportPdfBtn').addEventListener('click', exportReportPdf);

  $('doMergeBtn').addEventListener('click', doMerge);
  setupLayoutButtons();

  $('editSaveBtn').addEventListener('click', saveEditModal);
  $('editCancelBtn').addEventListener('click', closeEditModal);
  $('editCloseBtn').addEventListener('click', closeEditModal);
  $('editModal').addEventListener('click', (e) => {
    if (e.target === $('editModal')) closeEditModal();
  });

  // 设置弹窗
  $('settingsBtn').addEventListener('click', openSettings);
  $('settingsSaveBtn').addEventListener('click', saveSettingsModal);
  $('settingsCancelBtn').addEventListener('click', closeSettings);
  $('settingsCloseBtn').addEventListener('click', closeSettings);
  // 切换接口类型时联动默认地址/模型
  $('setLlmProvider').addEventListener('change', (e) => {
    const anthropic = e.target.value === 'anthropic';
    const urlEl = $('setLlmBaseUrl'), modelEl = $('setLlmModel');
    if (!urlEl.value.trim() || urlEl.value.indexOf('deepseek') >= 0 || urlEl.value.indexOf('anthropic') >= 0) {
      urlEl.value = anthropic ? 'https://api.anthropic.com' : 'https://api.deepseek.com';
    }
    if (!modelEl.value.trim() || modelEl.value.indexOf('deepseek') >= 0 || modelEl.value.indexOf('claude') >= 0) {
      modelEl.value = anthropic ? 'claude-sonnet-4-5' : 'deepseek-chat';
    }
  });
  $('settingsModal').addEventListener('click', (e) => {
    if (e.target === $('settingsModal')) closeSettings();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('editModal').hidden) closeEditModal();
      else if (!$('settingsModal').hidden) closeSettings();
    }
  });

  // 费用分类下拉选项（编辑弹窗 + 筛选栏，同一数据源）
  const catSelect = $('editCategory');
  catSelect.innerHTML = '';
  LC.CATEGORIES.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    catSelect.appendChild(opt);
  });
  const catFilter = $('ledgerCategoryFilter');
  LC.CATEGORIES.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    catFilter.appendChild(opt);
  });

  // 编辑弹窗内的自动生成按钮
  $('autoShortBtn').addEventListener('click', autoShort);
  $('autoRemarkBtn').addEventListener('click', autoRemark);
  $('autoNameBtn').addEventListener('click', autoNewName);
  // 金额/税额变化时联动刷新合计与文件名
  ['editAmount', 'editTax', 'editSellerShort', 'editDate', 'editNumber'].forEach(id => {
    $(id).addEventListener('input', refreshModalAuto);
  });

  // 启动恢复本地台账
  initFromStore().then(() => {
    // 周一自动提醒（需先恢复台账）
    checkMondayReport();
  });

  console.log('%c票小帮已启动（台账模式）', 'color:#185fa5;font-size:14px;font-weight:bold');
  console.log('所有文件均在浏览器本地处理，不会上传到服务器');
}

document.addEventListener('DOMContentLoaded', init);
