/* ============================================================
 * 票小帮 · 本地持久化模块（IndexedDB）
 * 功能：台账数据浏览器本地持久化，刷新/关闭页面不丢失
 * 说明：File 对象无法结构化克隆，保存时自动剔除 file 字段，
 *       仅保留可序列化的台账字段。
 * ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'piaoxiaobang';
  var DB_VERSION = 1;
  var STORE = 'ledger';

  var db = null;

  function open() {
    return new Promise(function (resolve, reject) {
      if (db) { resolve(db); return; }
      if (typeof indexedDB === 'undefined') {
        reject(new Error('当前环境不支持 IndexedDB'));
        return;
      }
      var req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = function (e) {
        var d = e.target.result;
        if (!d.objectStoreNames.contains(STORE)) {
          d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
        }
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 全量覆盖保存（数据量小，简单可靠）
  function saveLedger(ledger) {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, 'readwrite');
        var s = tx.objectStore(STORE);
        s.clear();
        (ledger || []).forEach(function (item) {
          var record = Object.assign({}, item);
          delete record.file; // File 对象不可序列化
          s.add(record);
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  function loadLedger() {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, 'readonly');
        var req = tx.objectStore(STORE).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  function clearLedger() {
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  var Store = {
    open: open,
    saveLedger: saveLedger,
    loadLedger: loadLedger,
    clearLedger: clearLedger
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
  else global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
