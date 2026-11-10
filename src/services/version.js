'use strict';

/**
 * 版本信息的唯一来源：统一从 package.json 读取，避免出现多处硬编码版本号。
 */

const path = require('path');

let pkg = {};
try {
  pkg = require(path.join(__dirname, '..', '..', 'package.json'));
} catch {
  pkg = {};
}

const VERSION = pkg.version || '0.0.0';
const NAME = pkg.productName || 'DgxayCode';
const BIN = 'dgxay';

/** 用于 HTTP User-Agent，例如 DgxayCode-CLI/1.0.0 */
const USER_AGENT = `${String(NAME).replace(/\s+/g, '')}-CLI/${VERSION}`;
/** 界面展示用的版本号，例如 V1.0 */
const VERSION_LABEL = VERSION.startsWith('1.') ? VERSION.split('.').slice(0, 2).join('.') : VERSION;

module.exports = { VERSION, VERSION_LABEL, NAME, BIN, USER_AGENT };
