/* ============================================================
 * 票小帮 · OFD 数电票文本提取模块
 * 原理：OFD 本质是 ZIP 包（META/OFD.xml + Doc_x/Pages/Page_x/Content.xml），
 *       Content.xml 中 <TextObject> 含 CTM 变换矩阵与 <TextCode> 文本，
 *       按坐标聚合还原视觉行序（与 PDF 提取输出格式保持一致）。
 * 输出：{ text, numPages }，text 每行一条，供 parseInvoiceText 复用。
 * ============================================================ */
(function (global) {
  'use strict';

  var JSZipLib = (typeof JSZip !== 'undefined') ? JSZip : null;

  function decodeXmlEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
      .replace(/&amp;/g, '&');
  }

  // 解析单个 Content.xml：提取全部 TextObject → TextCode，按 CTM 计算绝对坐标
  function parsePage(xmlStr) {
    var items = [];
    var objRe = /<TextObject\b[^>]*>([\s\S]*?)<\/TextObject>/g;
    var m;
    while ((m = objRe.exec(xmlStr)) !== null) {
      var openTag = m[0].slice(0, m[0].indexOf('>') + 1);
      var ctmMatch = openTag.match(/CTM="([^"]+)"/);
      var ctm = ctmMatch ? ctmMatch[1].trim().split(/\s+/).map(Number) : [1, 0, 0, 1, 0, 0];
      var a = ctm[0], b = ctm[1] || 0, c = ctm[2] || 0, d = ctm[3], e = ctm[4] || 0, f = ctm[5] || 0;
      if (ctm.length < 6) { a = 1; b = 0; c = 0; d = 1; e = 0; f = 0; }

      var codeRe = /<TextCode\b[^>]*>([\s\S]*?)<\/TextCode>/g;
      var cm;
      while ((cm = codeRe.exec(m[1])) !== null) {
        var cOpen = cm[0].slice(0, cm[0].indexOf('>') + 1);
        var x = parseFloat((cOpen.match(/X="([^"]+)"/) || [])[1] || '0');
        var y = parseFloat((cOpen.match(/Y="([^"]+)"/) || [])[1] || '0');
        var raw = decodeXmlEntities(cm[1].replace(/<[^>]+>/g, ''));
        var lines = raw.split('\n');
        for (var li = 0; li < lines.length; li++) {
          var t = lines[li].trim();
          if (!t) continue;
          // TextCode 内部多行按行高约 14 递增偏移（无精确行高时近似）
          var px = x, py = y + li * 14;
          items.push({
            text: t,
            x: e + a * px + c * py,
            y: f + b * px + d * py
          });
        }
      }
    }

    // 按 y 聚合成行（OFD 坐标系 y 向下增长，升序 = 从上到下）
    var lineMap = [];
    items.forEach(function (it) {
      var key = null;
      for (var i = 0; i < lineMap.length; i++) {
        if (Math.abs(lineMap[i].y - it.y) < 3) { key = lineMap[i]; break; }
      }
      if (!key) { key = { y: it.y, parts: [] }; lineMap.push(key); }
      key.parts.push(it);
    });
    lineMap.sort(function (p, q) { return p.y - q.y; });

    var text = '';
    lineMap.forEach(function (row) {
      row.parts.sort(function (p, q) { return p.x - q.x; });
      text += row.parts.map(function (p) { return p.text; }).join(' ') + '\n';
    });
    return text;
  }

  async function extractText(file) {
    if (!JSZipLib) throw new Error('JSZip 库未加载，无法解析 OFD 文件');
    var arrayBuffer = await file.arrayBuffer();
    var zip = await JSZipLib.loadAsync(arrayBuffer);
    var names = Object.keys(zip.files).filter(function (n) {
      return !zip.files[n].dir && /\/Content\.xml$/i.test(n);
    });
    names.sort();
    var fullText = '';
    for (var i = 0; i < names.length; i++) {
      var xml = await zip.files[names[i]].async('string');
      fullText += parsePage(xml) + '\n';
    }
    return { text: fullText, numPages: names.length };
  }

  var OFD = {
    extractText: extractText,
    parsePage: parsePage
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = OFD;
  else global.OFD = OFD;
})(typeof window !== 'undefined' ? window : globalThis);
