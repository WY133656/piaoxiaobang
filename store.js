/* ============================================================
 * 票小帮 · 本地持久化模块（IndexedDB 多数据集）
 * 功能：台账 / 银行流水 / 业务单据 / 对账结果 / 报表快照 浏览器本地持久化
 * 说明：
 *   - DB_VERSION=2，创建 5 个 store：ledger/bank/biz/recon/reports
 *   - 通用 API：saveDataset / loadDataset / clearDataset
 *   - 旧 API（saveLedger/loadLedger/clearLedger）保留兼容
 *   - File 对象无法结构化克隆，保存时自动剔除 file 字段
 * ============================================================ */
(function (global) {
  'use strict';

  var DB_NAME = 'piaoxiaobang';
  var DB_VERSION = 2;
  var STORES = ['ledger', 'bank', 'biz', 'recon', 'reports'];

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
        STORES.forEach(function (name) {
          if (!d.objectStoreNames.contains(name)) {
            d.createObjectStore(name, { keyPath: 'id', autoIncrement: true });
          }
        });
      };
      req.onsuccess = function () { db = req.result; resolve(db); };
      req.onerror = function () { reject(req.error); };
    });
  }

  // 通用：全量覆盖保存一个数据集
  function saveDataset(name, data) {
    if (STORES.indexOf(name) < 0) return Promise.reject(new Error('未知数据集: ' + name));
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(name, 'readwrite');
        var s = tx.objectStore(name);
        s.clear();
        (data || []).forEach(function (item) {
          var record = Object.assign({}, item);
          delete record.file; // File 对象不可序列化
          s.add(record);
        });
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // 通用：读取一个数据集全部记录
  function loadDataset(name) {
    if (STORES.indexOf(name) < 0) return Promise.reject(new Error('未知数据集: ' + name));
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(name, 'readonly');
        var req = tx.objectStore(name).getAll();
        req.onsuccess = function () { resolve(req.result || []); };
        req.onerror = function () { reject(req.error); };
      });
    });
  }

  // 通用：清空一个数据集
  function clearDataset(name) {
    if (STORES.indexOf(name) < 0) return Promise.reject(new Error('未知数据集: ' + name));
    return open().then(function (d) {
      return new Promise(function (resolve, reject) {
        var tx = d.transaction(name, 'readwrite');
        tx.objectStore(name).clear();
        tx.oncomplete = function () { resolve(); };
        tx.onerror = function () { reject(tx.error); };
      });
    });
  }

  // ---- 兼容旧 API ----
  function saveLedger(ledger) { return saveDataset('ledger', ledger); }
  function loadLedger() { return loadDataset('ledger'); }
  function clearLedger() { return clearDataset('ledger'); }

  var Store = {
    open: open,
    STORES: STORES,
    saveDataset: saveDataset,
    loadDataset: loadDataset,
    clearDataset: clearDataset,
    saveLedger: saveLedger,
    loadLedger: loadLedger,
    clearLedger: clearLedger
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = Store;
  else global.Store = Store;
})(typeof window !== 'undefined' ? window : globalThis);
