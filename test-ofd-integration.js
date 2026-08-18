'use strict';
// 端到端验证：OFD 提取文本 → parseInvoiceText → enrichInvoice
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const LC = require(path.join(__dirname, 'ledger.js'));

const sandbox = {
  window: { pdfjsLib: {}, LedgerCore: LC },
  PDFLib: { PDFDocument: {}, rgb: function () {} },
  document: { addEventListener: function () {} },
  console: console,
  setTimeout: setTimeout,
  clearTimeout: clearTimeout,
  Math: Math,
  JSON: JSON,
  Object: Object,
  Array: Array,
  String: String,
  Number: Number,
  Promise: Promise,
  Date: Date,
  Blob: function () {},
  URL: { createObjectURL: function () {}, revokeObjectURL: function () {} },
  Store: { saveLedger: function () { return Promise.resolve(); }, clearLedger: function () { return Promise.resolve(); } },
  OFD: { extractText: function () { return Promise.resolve({ text: '', numPages: 0 }); } },
  AI: { isConfigured: function () { return false; }, getSettings: function () { return {}; }, saveSettings: function () {} },
  JSZip: {}
};
sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8'), sandbox);

const OFD = require(path.join(__dirname, 'ofd.js'));

const xml = '<?xml version="1.0" encoding="UTF-8"?>' +
'<Page><Content>' +
'<TextObject ID="1" CTM="1 0 0 1 100 50"><TextCode X="0" Y="0">电子发票（增值税专用发票）</TextCode></TextObject>' +
'<TextObject ID="2" CTM="1 0 0 1 100 80"><TextCode X="0" Y="0">发票号码：2441200000001234567</TextCode></TextObject>' +
'<TextObject ID="3" CTM="1 0 0 1 100 110"><TextCode X="0" Y="0">开票日期：2026年08月15日</TextCode></TextObject>' +
'<TextObject ID="4" CTM="1 0 0 1 100 150"><TextCode X="0" Y="0">购买方信息</TextCode></TextObject>' +
'<TextObject ID="5" CTM="1 0 0 1 100 170"><TextCode X="0" Y="0">名称：浙江通途数科建设有限公司</TextCode></TextObject>' +
'<TextObject ID="6" CTM="1 0 0 1 100 220"><TextCode X="0" Y="0">销售方信息</TextCode></TextObject>' +
'<TextObject ID="7" CTM="1 0 0 1 100 240"><TextCode X="0" Y="0">名称：深圳市星辰科技有限公司</TextCode></TextObject>' +
'<TextObject ID="8" CTM="1 0 0 1 100 300"><TextCode X="0" Y="0">项目名称 规格型号 金额 税率 税额</TextCode></TextObject>' +
'<TextObject ID="9" CTM="1 0 0 1 100 320"><TextCode X="0" Y="0">*激光打印机* 台 1 1280.00 13% 166.40</TextCode></TextObject>' +
'<TextObject ID="10" CTM="1 0 0 1 100 400"><TextCode X="0" Y="0">合计金额 1280.00</TextCode></TextObject>' +
'<TextObject ID="11" CTM="1 0 0 1 100 420"><TextCode X="0" Y="0">合计税额 76.80</TextCode></TextObject>' +
'<TextObject ID="12" CTM="1 0 0 1 100 450"><TextCode X="0" Y="0">价税合计（小写）￥1356.80</TextCode></TextObject>' +
'</Content></Page>';

const text = OFD.parsePage(xml);
const inv = sandbox.parseInvoiceText(text, '数电票-测试.ofd');
console.log('--- OFD 全链路解析结果 ---');
console.log('发票类型:', inv.invoiceType || '(待 enrich)');
console.log('号码:', inv.number);
console.log('日期:', inv.date);
console.log('购买方:', inv.buyer);
console.log('销售方:', inv.seller);
console.log('金额:', inv.amount, '| 税额:', inv.tax);

LC.enrichInvoice(inv, text);
console.log('--- enrich 后 ---');
console.log('类型:', inv.invoiceType);
console.log('简称:', inv.sellerShort);
console.log('摘要:', inv.summary);
console.log('分类:', inv.category);
console.log('备注:', inv.remark);
console.log('新文件名:', inv.newName);

const ok = inv.number === '2441200000001234567' && inv.seller === '深圳市星辰科技有限公司' &&
  inv.buyer === '浙江通途数科建设有限公司' && inv.amount === '1280.00' && inv.tax === '76.80' &&
  inv.invoiceType === '电子专票' && inv.newName && inv.newName.indexOf('电子专票+20260815+2441200000001234567+') === 0;
console.log(ok ? '\n✅ OFD 端到端测试全部通过' : '\n❌ 测试存在失败项');
process.exit(ok ? 0 : 1);
