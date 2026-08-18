/* ============================================================
 * 票小帮 · AI 识别增强模块
 * 1) 腾讯云 OCR 通用印刷体识别（GeneralBasicOCR，TC3-HMAC-SHA256 签名）
 *    用于扫描件 PDF → 渲染页面转图片 → 识别文本
 * 2) 大模型字段纠错（OpenAI 兼容接口，支持混元/DeepSeek 等）
 *    用于提升金额/号码/日期等字段解析准确率
 * 配置：统一存在 localStorage['piaoxiaobang_settings']，
 *       与 ledger.js 的公司名设置共用同一存储键。
 * ============================================================ */
(function (global) {
  'use strict';

  var SETTINGS_KEY = 'piaoxiaobang_settings';

  function getSettings() {
    try {
      var raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(SETTINGS_KEY) : null;
      return raw ? JSON.parse(raw) : {};
    } catch (e) { return {}; }
  }

  function saveSettings(obj) {
    var s = getSettings();
    var next = Object.assign({}, s, obj);
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(next));
    }
    return next;
  }

  function getAIConfig() {
    var s = getSettings();
    var truthy = function (v) { return v === true || v === '1' || v === 1; };
    var base = String(s.llmBaseUrl || '').trim();
    if (!base) base = s.llmProvider === 'anthropic' ? 'https://api.anthropic.com' : 'https://api.deepseek.com';
    return {
      ocrEnabled: truthy(s.ocrEnabled),
      ocrSecretId: s.ocrSecretId || '',
      ocrSecretKey: s.ocrSecretKey || '',
      ocrRegion: s.ocrRegion || 'ap-guangzhou',
      llmEnabled: truthy(s.llmEnabled),
      llmApiKey: s.llmApiKey || '',
      llmBaseUrl: base.replace(/\/+$/, ''),
      llmModel: s.llmModel || (s.llmProvider === 'anthropic' ? 'claude-sonnet-4-5' : 'deepseek-chat'),
      llmProvider: s.llmProvider === 'anthropic' ? 'anthropic' : 'openai'
    };
  }

  // which: 'ocr' | 'llm'
  function isConfigured(which) {
    var c = getAIConfig();
    if (which === 'ocr') return c.ocrEnabled && c.ocrSecretId && c.ocrSecretKey;
    if (which === 'llm') return c.llmEnabled && c.llmApiKey;
    return false;
  }

  /* ---------- 腾讯云 TC3-HMAC-SHA256 签名（WebCrypto 实现，无额外依赖） ---------- */

  function hex(u8) {
    var out = '';
    for (var i = 0; i < u8.length; i++) out += u8[i].toString(16).padStart(2, '0');
    return out;
  }

  function sha256hex(encoder, msg) {
    return crypto.subtle.digest('SHA-256', encoder.encode(msg)).then(function (buf) {
      return hex(new Uint8Array(buf));
    });
  }

  function hmac(encoder, key, msg) {
    var keyBuf = typeof key === 'string' ? encoder.encode(key) : key;
    return crypto.subtle.importKey('raw', keyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
      .then(function (k) {
        return crypto.subtle.sign('HMAC', k, encoder.encode(msg));
      })
      .then(function (sig) { return new Uint8Array(sig); });
  }

  function tc3Sign(secretId, secretKey, service, action, payload) {
    var encoder = new TextEncoder();
    var host = service + '.tencentcloudapi.com';
    var now = new Date();
    var date = now.toISOString().slice(0, 10).replace(/-/g, '');
    var timestamp = String(Math.floor(now.getTime() / 1000));

    var canonicalHeaders =
      'content-type:application/json; charset=utf-8\n' +
      'host:' + host + '\n' +
      'x-tc-action:' + action.toLowerCase() + '\n';
    var signedHeaders = 'content-type;host;x-tc-action';

    return sha256hex(encoder, payload).then(function (hashedPayload) {
      var canonicalRequest = ['POST', '/', '', canonicalHeaders, signedHeaders, hashedPayload].join('\n');
      return sha256hex(encoder, canonicalRequest);
    }).then(function (hashedCanonical) {
      var credentialScope = date + '/' + service + '/tc3_request';
      var stringToSign = ['TC3-HMAC-SHA256', timestamp, credentialScope, hashedCanonical].join('\n');
      return hmac(encoder, 'TC3' + secretKey, date)
        .then(function (kDate) { return hmac(encoder, kDate, service); })
        .then(function (kService) { return hmac(encoder, kService, 'tc3_request'); })
        .then(function (kSigning) { return hmac(encoder, kSigning, stringToSign); })
        .then(function (signature) {
          var authorization = 'TC3-HMAC-SHA256 Credential=' + secretId + '/' + credentialScope +
            ', SignedHeaders=' + signedHeaders + ', Signature=' + hex(signature);
          return { authorization: authorization, timestamp: timestamp, host: host };
        });
    });
  }

  /* ---------- OCR：图片 base64 → 文本 ---------- */

  function ocrText(imageBase64) {
    if (!isConfigured('ocr')) return Promise.reject(new Error('OCR 未配置'));
    var cfg = getAIConfig();
    var service = 'ocr';
    var action = 'GeneralBasicOCR';
    var version = '2018-11-19';
    var region = cfg.ocrRegion || 'ap-guangzhou';
    var payload = JSON.stringify({ ImageBase64: imageBase64 });

    return tc3Sign(cfg.ocrSecretId, cfg.ocrSecretKey, service, action, payload)
      .then(function (signed) {
        return fetch('https://' + signed.host, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Host': signed.host,
            'X-TC-Action': action,
            'X-TC-Version': version,
            'X-TC-Region': region,
            'X-TC-Timestamp': signed.timestamp,
            'Authorization': signed.authorization
          },
          body: payload
        });
      })
      .then(function (res) {
        if (!res.ok) throw new Error('OCR 请求失败: HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (data.Response && data.Response.Error) {
          throw new Error('OCR 错误: ' + (data.Response.Error.Message || data.Response.Error.Code));
        }
        var dets = (data.Response && data.Response.TextDetections) || [];
        return dets.map(function (d) { return d.DetectedText || ''; }).filter(Boolean).join('\n');
      });
  }

  /* ---------- 大模型通用对话（OpenAI 兼容接口） ---------- */

  // 从模型返回内容中提取 JSON（兼容 ```json 代码块 / 纯 JSON / 夹杂文字）
  function extractJson(content) {
    var m = content.match(/```(?:json)?\s*([\s\S]*?)```/) || content.match(/\{[\s\S]*\}/);
    var jsonStr = m ? (m[1] || m[0]) : content;
    return JSON.parse(jsonStr.trim());
  }

  // 通用 chat 方法：messages = [{role, content}]，返回 content 字符串
  // 支持 OpenAI 兼容（/chat/completions）与 Anthropic（/v1/messages）两种协议
  function llmChat(messages, opts) {
    if (!isConfigured('llm')) return Promise.reject(new Error('大模型未配置'));
    var cfg = getAIConfig();
    var o = opts || {};

    if (cfg.llmProvider === 'anthropic') {
      // ---------- Anthropic Messages API ----------
      var system = '';
      var conv = [];
      (messages || []).forEach(function (msg) {
        if (msg.role === 'system') system += (system ? '\n' : '') + msg.content;
        else conv.push({ role: msg.role === 'assistant' ? 'assistant' : 'user', content: msg.content });
      });
      if (!conv.length) conv.push({ role: 'user', content: system || '.' });
      var base = cfg.llmBaseUrl.replace(/\/v1\/?$/, '');
      return fetch(base + '/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': cfg.llmApiKey,
          'anthropic-version': '2023-06-01',
          'anthropic-dangerous-direct-browser-access': 'true'
        },
        body: JSON.stringify({
          model: cfg.llmModel,
          max_tokens: o.maxTokens || 1200,
          system: system || undefined,
          messages: conv
        })
      }).then(function (res) {
        if (!res.ok) throw new Error('Anthropic 请求失败: HTTP ' + res.status);
        return res.json();
      }).then(function (data) {
        if (data.type === 'error') throw new Error('Anthropic 错误: ' + (data.error && data.error.message));
        var text = (data.content || []).map(function (b) { return b.text || ''; }).join('');
        if (!text) throw new Error('Anthropic 返回为空');
        return text;
      });
    }

    // ---------- OpenAI 兼容 ----------
    return fetch(cfg.llmBaseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.llmApiKey
      },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: messages,
        temperature: o.temperature !== undefined ? o.temperature : 0.2,
        max_tokens: o.maxTokens || 1200
      })
    }).then(function (res) {
      if (!res.ok) throw new Error('大模型请求失败: HTTP ' + res.status);
      return res.json();
    }).then(function (data) {
      var content = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      if (!content) throw new Error('大模型返回为空');
      return content;
    });
  }

  /* ---------- 大模型字段纠错（复用 llmChat） ---------- */

  function llmCorrect(invoice, rawText) {
    if (!isConfigured('llm')) return Promise.resolve(invoice);
    var sysPrompt = '你是发票信息解析助手。根据用户提供的发票文本，提取字段并以JSON返回，只输出JSON对象，不要任何解释和Markdown。' +
      '字段: number(发票号码/数电票号码), code(发票代码,无则空), date(开票日期,格式YYYY年MM月DD日), seller(销售方名称), buyer(购买方名称), ' +
      'amount(金额即不含税金额), tax(税额), invoiceType(电子专票|电子普票|纸质专票|纸质普票), summary(商品/项目摘要,尽量简洁)。';
    var userPrompt = '发票文本：\n' + String(rawText || '').slice(0, 4000) +
      '\n\n当前已解析结果(可能不准确)：\n' + JSON.stringify(invoice) +
      '\n\n请输出修正后的JSON字段，只包含能从文本确认的字段。';

    return llmChat([
      { role: 'system', content: sysPrompt },
      { role: 'user', content: userPrompt }
    ], { temperature: 0.1, maxTokens: 800 })
      .then(function (content) {
        var parsed = extractJson(content);
        var out = Object.assign({}, invoice);
        ['number', 'code', 'date', 'seller', 'buyer', 'amount', 'tax', 'invoiceType', 'summary'].forEach(function (k) {
          if (parsed[k] !== undefined && parsed[k] !== null && String(parsed[k]).trim() !== '') {
            out[k] = String(parsed[k]).trim();
          }
        });
        return out;
      });
  }

  var AI = {
    SETTINGS_KEY: SETTINGS_KEY,
    getSettings: getSettings,
    saveSettings: saveSettings,
    getAIConfig: getAIConfig,
    isConfigured: isConfigured,
    ocrText: ocrText,
    llmChat: llmChat,
    llmCorrect: llmCorrect
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = AI;
  else global.AI = AI;
})(typeof window !== 'undefined' ? window : globalThis);
