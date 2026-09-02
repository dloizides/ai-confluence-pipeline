'use strict';
/**
 * Egress-proxy resolution shared by the direct/ publishers — CommonJS so the `.cjs` helpers can
 * `require` it and the `.mjs` publishers can `import` it (Node cannot `require` ESM on Node 20).
 *
 * Precedence: process.env.HTTPS_PROXY / https_proxy -> the `.env` file -> none. There is no
 * built-in default host: unset means a direct connection.
 */

/** Resolved proxy, or '' for a direct connection. `envFile` = the caller's parsed `.env` map. */
function resolveProxy(envFile) {
  const v = process.env.HTTPS_PROXY || process.env.https_proxy
    || (envFile && (envFile.HTTPS_PROXY || envFile.https_proxy)) || '';
  return String(v).trim();
}

/** curl args for the resolved proxy. Empty when going direct, so curl's own env handling stands. */
function curlProxyArgs(envFile) {
  const proxy = resolveProxy(envFile);
  return proxy ? ['--proxy', proxy] : [];
}

module.exports = { resolveProxy, curlProxyArgs };
