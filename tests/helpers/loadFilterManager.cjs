// CJS helper to load FilterManager which uses module.exports guard
const fs = require('fs');
const path = require('path');
const vm = require('vm');

function loadFilterManager() {
  const filePath = path.resolve(__dirname, '../../public/js/utils/FilterManager.js');
  const code = fs.readFileSync(filePath, 'utf-8');

  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    console: globalThis.console,
    localStorage: globalThis.localStorage,
    window: globalThis.window,
    setTimeout: globalThis.setTimeout,
    clearTimeout: globalThis.clearTimeout,
    Date: globalThis.Date,
    JSON: globalThis.JSON,
    Map: globalThis.Map,
    Set: globalThis.Set,
    Array: globalThis.Array,
    Object: globalThis.Object,
    Math: globalThis.Math,
    Error: globalThis.Error,
    String: globalThis.String,
    Number: globalThis.Number,
    parseInt: globalThis.parseInt,
    parseFloat: globalThis.parseFloat,
    isNaN: globalThis.isNaN,
  };

  vm.runInNewContext(code, sandbox, { filename: filePath });
  return moduleObj.exports;
}

module.exports = loadFilterManager;
