#!/usr/bin/env node
'use strict';
/*
 * WorkBuddy「Buddy 加油站」本机自动化（Node.js 版 —— 零 Python 依赖）。
 * Copyright (c) 2026 xifan · https://github.com/xifanCode/workBuddyIntegral
 *
 * 一次运行做两件事：
 *   1. 签到（check-in）—— 这是权威结论：签到成功就算成功。
 *   2. 派猫猫旅行（Buddy travel）—— 先「领掉已经到家的旅行积分」，再「判断能不能派新的一趟」。
 *      今天已经派过（状态为 traveling）就不再派。旅行段整体隔离，失败绝不影响签到结论。
 *
 * 为什么不需要 Python：
 *   解密 sym-v1 加密凭据必须使用 WorkBuddy 桌面端自带的 Electron 二进制
 *   （原生绑定 electron_browser_workbuddy_storage 只存在于该二进制中，纯 node 没有）。
 *   因此本脚本直接用该二进制当作 JS 运行时来跑自己 —— 不引入任何新的外部依赖，
 *   唯一前提就是「已安装并登录 WorkBuddy 桌面端」（这本来就是使用前提）。
 *
 * 运行方式（任选其一，效果相同）：
 *   ELECTRON_RUN_AS_NODE=1 "/Applications/WorkBuddy.app/Contents/MacOS/Electron" wb_buddy_auto.js
 *   node wb_buddy_auto.js            # 会自动改用 Electron 二进制重启自己
 *   ./run_local.sh                   # 本地调度入口（launchd / cron 共用）
 *
 * 用法：
 *   wb_buddy_auto.js            每日自动化（签到 + 派猫猫旅行），输出一行 JSON
 *   wb_buddy_auto.js --doctor   离线检查凭据格式/运行时能力，不解密、不联网
 *
 * 安全约束：
 *   - token 只从本机登录态文件读取，仅存于本进程内存；所有输出都会过一次脱敏。
 *   - 日志只记 path 与响应体，绝不记请求头（含 token）。
 *
 * ENDPOINTS（逆向自桌面端，全部打官方同一 endpoint https://copilot.tencent.com）：
 *   签到：POST /v2/billing/meter/checkin-activity-status      查今日是否已领
 *         POST /v2/billing/meter/daily-checkin                领取今日积分（幂等）
 *   旅行：GET  /v2/activity/growth/buddy/travel/status        查旅行状态
 *         POST /v2/activity/growth/buddy/travel/claim         领已到家的旅行礼物
 *         GET  /v2/activity/growth/buddy/travel/config        查可派地点
 *         POST /v2/activity/growth/buddy/travel/depart        派新一趟
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// ---------- 常量 ----------
const DEFAULT_ENDPOINT = 'https://copilot.tencent.com';
const AUTH_BASENAME = path.join('CodeBuddyExtension', 'Data', 'Public', 'auth', 'workbuddy-desktop.info');
const CLI_AUTH_BASENAME = path.join('CodeBuddyExtension', 'Data', 'Public', 'auth',
  'Tencent-Cloud.coding-copilot.info');
const REQUEST_TIMEOUT = 30;
const NETWORK_RETRY_DELAYS = [5, 15, 30, 60, 90];
const SERVER_RETRY_DELAYS = [3, 10];
const CODE_NO_NETWORK = -1;   // 连不上/超时
const CODE_BUDGET_OUT = -2;   // 本次运行时间预算耗尽，主动放弃
const TOKEN_LIMIT = 32768;
const AUTH_INPUT_LIMIT = 65536;
const AUTH_HELPER_TIMEOUT = 10.0;
const AUTH_OUTPUT_LIMIT = 65536;
const DEFAULT_BUDGET_SECONDS = 420.0;

const AUTH_REASONS = {
  INVALID_FORMAT: '登录凭据格式无效，请检查凭据来源和客户端版本',
  UNSUPPORTED_ENVELOPE: '尚不支持此加密凭据格式，请更新脚本',
  RUNTIME_NOT_FOUND: '未找到 WorkBuddy 客户端，请用 WORKBUDDY_EXE 指定',
  INVALID_RUNTIME_PATH: 'WORKBUDDY_EXE 不是可用的可执行文件',
  RUNTIME_UNAVAILABLE: '客户端运行时不支持所需的原生存储接口',
  KEY_MISMATCH: '凭据与所选客户端的密钥不匹配',
  DECRYPT_FAILED: '加密凭据解密失败，请检查客户端版本及凭据',
  HELPER_TIMEOUT: '凭据处理超时，请稍后重试',
  HELPER_PROTOCOL: '客户端凭据助手返回无效结果',
  MISSING_SESSION: '登录态不完整（缺少 accessToken 或 uid），请先登录客户端',
};

// ---------- 敏感值集合：解密出的 token 仅存于此，用于输出前脱敏 ----------
const _sensitive_values = new Set();

function redact(text) {
  let out = String(text);
  for (const v of _sensitive_values) {
    if (v && out.includes(v)) out = out.split(v).join('[REDACTED]');
  }
  return out;
}

class AuthError extends Error {
  constructor(reason, result) {
    super(AUTH_REASONS[reason] || '本地未找到有效登录会话，请先登录客户端');
    this.name = 'AuthError';
    this.reason = reason;
    this.result = result || 'AUTH_ERROR';
  }
  output() {
    return { result: this.result, reason: this.reason, report: this.message, needs_attention: true };
  }
}

function authFail(reason, result) { throw new AuthError(reason, result); }

// ---------- 时间预算（单调时钟） ----------
const _t0 = process.hrtime.bigint();
let _started_at = null;
function monotonic() { return Number(process.hrtime.bigint() - _t0) / 1e9; }
function startBudget() { _started_at = monotonic(); }
function budgetLeft() {
  return _started_at === null ? DEFAULT_BUDGET_SECONDS : DEFAULT_BUDGET_SECONDS - (monotonic() - _started_at);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 解密助手（进程内直接调用原生绑定，无需子进程） ----------
// 仅支持 sym-v1 / suite 1。逻辑原样取自桌面端逆向实现。
const inputLimit = AUTH_INPUT_LIMIT;
const isObject = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);

function b64(value, length) {
  if (typeof value !== 'string' || value.length > inputLimit) authFail('INVALID_FORMAT');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length)) {
    authFail('INVALID_FORMAT');
  }
  return bytes;
}

function utf8(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) authFail('INVALID_FORMAT');
  return text;
}

function nativeStorage() {
  try {
    const storage = process._linkedBinding('electron_browser_workbuddy_storage');
    if (typeof storage.loggerGet !== 'function') authFail('RUNTIME_UNAVAILABLE');
    return storage;
  } catch (_) {
    authFail('RUNTIME_UNAVAILABLE');
  }
}

function nativeStorageAvailable() {
  try {
    const storage = process._linkedBinding('electron_browser_workbuddy_storage');
    return typeof storage.loggerGet === 'function';
  } catch (_) { return false; }
}

/** 把会话里的 accessToken 字段解成 {keyId, nonce, tag, ciphertext} */
function decodeEnvelope(value) {
  if (!isObject(value) || Object.keys(value).sort().join(',') !== '$wbEncrypted,envelope'
    || value.$wbEncrypted !== 1) {
    authFail('UNSUPPORTED_ENVELOPE');
  }
  let envelope;
  try { envelope = JSON.parse(utf8(b64(value.envelope))); } catch (e) { authFail(e.reason || 'INVALID_FORMAT'); }
  if (!isObject(envelope) || !Number.isInteger(envelope.suite)) authFail('INVALID_FORMAT');
  if (envelope.suite !== 1) authFail('UNSUPPORTED_ENVELOPE');
  if (Object.keys(envelope).sort().join(',') !== 'authTag,ciphertext,keyId,nonce,suite'
    || typeof envelope.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(envelope.keyId)) {
    authFail('INVALID_FORMAT');
  }
  return {
    keyId: envelope.keyId,
    nonce: b64(envelope.nonce, 12),
    tag: b64(envelope.authTag, 16),
    ciphertext: b64(envelope.ciphertext),
  };
}

function decryptEnvelope(envelope) {
  let payload;
  let key;
  let plaintext;
  try {
    try { payload = JSON.parse(nativeStorage().loggerGet()); } catch (_) { authFail('RUNTIME_UNAVAILABLE'); }
    if (!isObject(payload) || payload.version !== 1) authFail('RUNTIME_UNAVAILABLE');
    let secret;
    try { secret = b64(payload.atRestSecretKey, 32); } catch (_) { authFail('RUNTIME_UNAVAILABLE'); }
    const empty = secret.every((b) => b === 0);
    secret.fill(0);
    if (empty) authFail('RUNTIME_UNAVAILABLE');
    key = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
    payload = null;
    if (crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) !== envelope.keyId) {
      authFail('KEY_MISMATCH');
    }
    const lp = (s) => {
      const bytes = Buffer.from(s, 'utf8');
      const length = Buffer.alloc(4);
      length.writeUInt32BE(bytes.length);
      return Buffer.concat([length, bytes]);
    };
    const aad = Buffer.concat([Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
      lp('WBEV1'), lp('sym-v1'), Buffer.from([0, 0, 0, 1]), lp(envelope.keyId), Buffer.from([2, 0, 0])]);
    try {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.nonce, { authTagLength: 16 });
      cipher.setAAD(aad);
      cipher.setAuthTag(envelope.tag);
      plaintext = Buffer.concat([cipher.update(envelope.ciphertext), cipher.final()]);
    } catch (_) { authFail('DECRYPT_FAILED'); }
    const token = utf8(plaintext);
    if (!token.length || token.length > TOKEN_LIMIT || !/^[A-Za-z0-9._~+/-]+=*$/.test(token)) {
      authFail('INVALID_FORMAT');
    }
    return token;
  } finally {
    if (key) key.fill(0);
    if (plaintext) plaintext.fill(0);
  }
}

// ---------- 凭据校验 ----------
function validToken(token) {
  return (typeof token === 'string' && token.length > 0 && token.length <= TOKEN_LIMIT
    && /^[A-Za-z0-9._~+/-]+=*$/.test(token));
}

function validateSession(session) {
  if (!isObject(session)) authFail('INVALID_FORMAT');
  for (const field of ['auth', 'account']) {
    if (session[field] === undefined || session[field] === null) authFail('MISSING_SESSION', 'NO_SESSION');
    if (!isObject(session[field])) authFail('INVALID_FORMAT');
  }
  const tok = session.auth.accessToken;
  if (tok === undefined || tok === null || tok === '' || session.account.uid === undefined
    || session.account.uid === null || session.account.uid === '') {
    authFail('MISSING_SESSION', 'NO_SESSION');
  }
  const endpoint = session.auth.endpoint;
  if (endpoint !== undefined && endpoint !== null && endpoint !== '') {
    if (typeof endpoint !== 'string' || /[\s\x00-\x1f\x7f]/.test(endpoint)) authFail('INVALID_FORMAT');
    let parsed;
    try { parsed = new URL(endpoint); } catch (_) { authFail('INVALID_FORMAT'); }
    if (parsed.protocol !== 'https:' || !parsed.hostname || parsed.username || parsed.password
      || parsed.search || parsed.hash) {
      authFail('INVALID_FORMAT');
    }
  }
}

/** 区分明文 accessToken 与 sym-v1 加密信封 */
function tokenFormat(value) {
  if (typeof value === 'string') {
    if (!validToken(value)) authFail('INVALID_FORMAT');
    return 'plaintext';
  }
  if (!isObject(value)) authFail('INVALID_FORMAT');
  if (Object.keys(value).length !== 2 || !('$wbEncrypted' in value) || !('envelope' in value)
    || typeof value.$wbEncrypted !== 'number' || !Number.isInteger(value.$wbEncrypted)
    || value.$wbEncrypted !== 1) {
    authFail('UNSUPPORTED_ENVELOPE');
  }
  try {
    const encoded = value.envelope;
    if (typeof encoded !== 'string' || encoded.length === 0 || encoded.length > AUTH_INPUT_LIMIT - 1024) {
      throw new Error('bad envelope length');
    }
    const raw = Buffer.from(encoded, 'base64');
    if (raw.toString('base64') !== encoded) throw new Error('bad base64');
    const envelope = JSON.parse(raw.toString('utf8'));
    if (!isObject(envelope) || typeof envelope.suite !== 'number' || !Number.isInteger(envelope.suite)) {
      throw new Error('bad suite type');
    }
    if (envelope.suite !== 1) authFail('UNSUPPORTED_ENVELOPE');
    if (Object.keys(envelope).sort().join(',') !== 'authTag,ciphertext,keyId,nonce,suite') {
      throw new Error('bad envelope keys');
    }
    if (typeof envelope.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(envelope.keyId)) {
      throw new Error('bad keyId');
    }
    for (const [field, length] of [['nonce', 12], ['authTag', 16], ['ciphertext', null]]) {
      const data = envelope[field];
      if (typeof data !== 'string') throw new Error('bad field type');
      const decoded = Buffer.from(data, 'base64');
      if (decoded.toString('base64') !== data || (length !== null && decoded.length !== length)) {
        throw new Error('bad field b64');
      }
    }
    return 'sym-v1';
  } catch (e) {
    if (e instanceof AuthError) throw e;
    authFail('INVALID_FORMAT');
  }
}

// ---------- WorkBuddy 运行时发现 ----------
function macRuntime(bundle) {
  const plistPath = path.join(bundle, 'Contents', 'Info.plist');
  if (!fs.existsSync(plistPath)) return null;
  let name = 'WorkBuddy';
  try {
    // Info.plist 是 XML；只提取 CFBundleExecutable，避免引入 plist 解析依赖。
    const xml = fs.readFileSync(plistPath, 'utf8');
    const m = /<key>CFBundleExecutable<\/key>\s*<string>([^<]+)<\/string>/.exec(xml);
    if (m && m[1]) name = m[1].trim();
  } catch (_) { /* 用默认名 */ }
  if (!name || name === '.' || name === '..' || name.includes('/') || name.includes('\\')) return null;
  return path.join(bundle, 'Contents', 'MacOS', name);
}

function findWorkbuddyRuntime() {
  const override = process.env.WORKBUDDY_EXE;
  if (override) {
    const p = path.resolve(override.replace(/^~(?=$|\/)/, os.homedir()));
    let ok = false;
    try { ok = fs.statSync(p).isFile(); } catch (_) { ok = false; }
    if (!ok || (process.platform !== 'win32' && !isExecutable(p))) {
      authFail('INVALID_RUNTIME_PATH');
    }
    return p;
  }
  const home = os.homedir();
  const candidates = [];
  if (process.platform === 'win32') {
    const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    candidates.push(path.join(local, 'Programs', 'WorkBuddy', 'WorkBuddy.exe'));
    for (const name of ['ProgramFiles', 'ProgramFiles(x86)']) {
      if (process.env[name]) candidates.push(path.join(process.env[name], 'WorkBuddy', 'WorkBuddy.exe'));
    }
  } else if (process.platform === 'darwin') {
    for (const root of ['/Applications', path.join(home, 'Applications')]) {
      candidates.push(macRuntime(path.join(root, 'WorkBuddy.app')));
    }
  }
  for (const p of candidates) {
    if (p && fs.existsSync(p) && (process.platform === 'win32' || isExecutable(p))) {
      return path.resolve(p);
    }
  }
  authFail('RUNTIME_NOT_FOUND');
}

function isExecutable(p) {
  try { fs.accessSync(p, fs.constants.X_OK); return true; } catch (_) { return false; }
}

// ---------- 自重启：确保跑在 WorkBuddy Electron 二进制里（解密必需） ----------
// 返回 true 表示已交出控制权（父进程不应继续主流程）。
function ensureElectronRuntime() {
  if (process.versions.electron) return false;         // 已在 Electron 中
  if (nativeStorageAvailable()) return false;          // 绑定可用，直接跑
  if (process.env.WB_BUDDY_REEXEC) return false;       // 已重启过，避免死循环

  let exe = null;
  try { exe = findWorkbuddyRuntime(); } catch (_) { exe = null; }
  if (!exe) return false;   // 没有运行时：交给主流程报 RUNTIME_NOT_FOUND

  const env = Object.assign({}, process.env);
  for (const k of Object.keys(env)) {
    const ku = k.toUpperCase();
    if (ku.startsWith('ELECTRON_') || ku.startsWith('NODE_') || ku.startsWith('WORKBUDDY_')) delete env[k];
  }
  env.ELECTRON_RUN_AS_NODE = '1';
  env.WB_BUDDY_REEXEC = '1';

  let child;
  try {
    child = spawn(exe, [__filename].concat(process.argv.slice(2)), { env, stdio: 'inherit' });
  } catch (e) {
    const out = { result: 'ERROR', report: '无法启动 WorkBuddy 运行时：' + e.message, success: false };
    process.stdout.write(redact(JSON.stringify(out)) + '\n');
    process.exit(1);
  }
  child.on('error', (e) => {
    const out = { result: 'ERROR', report: '无法启动 WorkBuddy 运行时：' + e.message, success: false };
    process.stdout.write(redact(JSON.stringify(out)) + '\n');
    process.exit(1);
  });
  child.on('exit', (code) => process.exit(code === null ? 1 : code));
  return true;
}

// ---------- 会话读取 / 解密 ----------
function findAuthFile() {
  const override = process.env.WORKBUDDY_AUTH_FILE;
  if (override) return fs.existsSync(override) ? override : null;
  const home = os.homedir();
  const local = process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
  const xdg = process.env.XDG_DATA_HOME || path.join(home, '.local', 'share');
  const candidates = [
    path.join(local, AUTH_BASENAME),
    path.join(home, 'Library', 'Application Support', AUTH_BASENAME),
    path.join(xdg, CLI_AUTH_BASENAME),
    path.join(home, '.config', AUTH_BASENAME),
    path.join(home, '.workbuddy', 'auth', 'workbuddy-desktop.info'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return null;
}

function loadSession(authFile) {
  let last = null;
  for (let i = 0; i < 3; i++) {
    try { return JSON.parse(fs.readFileSync(authFile, 'utf8')); } catch (e) {
      last = e;
      if (e && (e.code === 'EACCES' || e.code === 'EPERM')) { sleepSync(2.0); continue; }
      throw e;
    }
  }
  throw last;
}

// 读取期的短暂同步等待（仅在权限错误时使用，避免引入 async 复杂度）
function sleepSync(seconds) {
  const end = Date.now() + seconds * 1000;
  while (Date.now() < end) { /* busy-wait，仅 2s 且罕见 */ }
}

function resolveSession(session) {
  validateSession(session);
  let token = session.auth.accessToken;
  if (tokenFormat(token) !== 'plaintext') {
    token = decryptEnvelope(decodeEnvelope(token));
  }
  _sensitive_values.add(token);
  return Object.assign({}, session, { auth: Object.assign({}, session.auth, { accessToken: token }) });
}

function buildHeaders(session) {
  validateSession(session);
  const auth = session.auth || {};
  const account = session.account || {};
  const token = auth.accessToken;
  const uid = account.uid;
  if (!validToken(token)) authFail('INVALID_FORMAT');
  const headers = {
    Accept: 'application/json',
    Authorization: 'Bearer ' + token,   // token 只进请求头，绝不记录/打印
    'Content-Type': 'application/json',
    'X-User-Id': uid,
    'User-Agent': 'WorkBuddy',
  };
  if (account.enterpriseId) {
    headers['X-Enterprise-Id'] = account.enterpriseId;
    headers['X-Tenant-Id'] = account.enterpriseId;
  }
  if (auth.domain) headers['X-Domain'] = auth.domain;
  return headers;
}

// ---------- HTTP ----------
async function httpRequest(url, headers, method, payload, timeoutSec) {
  const body = (payload === undefined || payload === null) ? undefined : JSON.stringify(payload);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutSec) * 1000);
  try {
    const resp = await fetch(url, { method, headers, body, signal: controller.signal });
    const raw = await resp.text();
    let parsed;
    try { parsed = JSON.parse(raw); } catch (_) { parsed = { raw: raw.slice(0, 500) }; }
    return [resp.status, parsed];
  } catch (e) {
    const msg = (e && e.name === 'AbortError') ? 'timeout' : String(e && e.message ? e.message : e);
    return [CODE_NO_NETWORK, { error: msg }];
  } finally {
    clearTimeout(timer);
  }
}

function retryDelays(code) {
  if (code === CODE_NO_NETWORK) return NETWORK_RETRY_DELAYS;
  if (code >= 500) return SERVER_RETRY_DELAYS;
  return [];
}

async function requestWithRetry(url, headers, method, payload, retry) {
  if (budgetLeft() <= 1) return [CODE_BUDGET_OUT, { error: '已达本次运行时间预算，跳过剩余请求' }];
  let [code, body] = await httpRequest(url, headers, method, payload,
    Math.max(1, Math.min(REQUEST_TIMEOUT, budgetLeft())));
  if (!retry) return [code, body];
  const attempts = new Map();
  for (;;) {
    const delays = retryDelays(code);
    if (!delays.length) return [code, body];
    const key = delays.join(',');
    const used = attempts.get(key) || 0;
    if (used >= delays.length) return [code, body];
    const delay = delays[used];
    attempts.set(key, used + 1);
    if (budgetLeft() <= delay + REQUEST_TIMEOUT) return [code, body];
    await sleep(delay * 1000);
    [code, body] = await httpRequest(url, headers, method, payload,
      Math.max(1, Math.min(REQUEST_TIMEOUT, budgetLeft())));
  }
}

/** POST 默认不重试：写操作若在服务端处理完成后才超时，重试会重复提交。 */
function post(url, headers, payload, retry) {
  return requestWithRetry(url, headers, 'POST', payload, retry === true);
}
function get(url, headers) {
  return requestWithRetry(url, headers, 'GET', null, true);
}

// ---------- 小工具 ----------
function dig(obj, key) {
  if (isObject(obj)) {
    if (key in obj && obj[key] !== null && obj[key] !== undefined) return obj[key];
    for (const k of ['data', 'result', 'resp', 'response']) {
      if (k in obj && isObject(obj[k])) {
        const r = dig(obj[k], key);
        if (r !== null && r !== undefined) return r;
      }
    }
  }
  return null;
}

function asInt(v, dflt) {
  const d = dflt === undefined ? 0 : dflt;
  if (v === null || v === undefined || v === '' || typeof v === 'boolean' && false) return d;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : d;
}

function fmtCredit(v) {
  if (v === null || v === undefined || v === '') return v;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : v;
}

function httpLabel(code) {
  if (code === CODE_NO_NETWORK) return '网络不可达';
  if (code === CODE_BUDGET_OUT) return '时间预算耗尽';
  return 'HTTP ' + code;
}

function isAlreadyCheckedIn(cbody) {
  if (cbody === null || cbody === undefined) return true;
  if (isObject(cbody)) {
    const msg = cbody.msg || '';
    if (cbody.code === 10001 || String(msg).includes('已签')) return true;
  }
  return false;
}

function logStep(log, step, method, p, code, body) {
  log.push({ step, method, path: p, http: code, body });
}

function authFailure(code) {
  if (code === 401) {
    return { result: 'AUTH_REJECTED', http: code, needs_attention: true,
      report: '服务端拒绝认证（HTTP 401），请检查客户端登录状态' };
  }
  return { result: 'FORBIDDEN', http: code, needs_attention: true,
    report: '服务端拒绝此操作（HTTP 403），请检查账号权限或活动条件' };
}

function alreadyReport(status, via) {
  const todayCredit = dig(status, 'today_credit') || dig(status, 'daily_credit');
  const streakDays = dig(status, 'streak_days');
  const totalCredits = dig(status, 'total_credits');
  const inner = [];
  if (todayCredit !== null && todayCredit !== undefined) inner.push('今日 +' + fmtCredit(todayCredit));
  if (streakDays !== null && streakDays !== undefined) inner.push('连续 ' + streakDays + ' 天');
  if (totalCredits !== null && totalCredits !== undefined) inner.push('累计 ' + fmtCredit(totalCredits) + ' 积分');
  const prefix = via || '今日已签过';
  const report = inner.length ? prefix + '（' + inner.join('，') + '）' : prefix;
  return { result: 'ALREADY', report, today_credit: todayCredit,
    streak_days: streakDays, total_credits: totalCredits };
}

// ---------- 1) 签到：权威结论 ----------
async function runCheckin(headers, endpoint, log) {
  let [scode, sbody] = await post(endpoint + '/v2/billing/meter/checkin-activity-status', headers, null, true);
  logStep(log, '签到-查状态', 'POST', '/v2/billing/meter/checkin-activity-status', scode, sbody);

  if (scode === CODE_BUDGET_OUT) return [1, { result: 'TIMEOUT', report: '已达时间预算，签到跳过，下次自动重试' }];
  if (scode === CODE_NO_NETWORK) {
    return [1, { result: 'NETWORK', report: '网络不可达，签到跳过（' + (sbody.error || '') + '）' }];
  }
  if (scode === 401 || scode === 403) return [1, authFailure(scode)];
  if (!(scode >= 200 && scode < 300)) {
    return [1, { result: 'ERROR', report: '签到接口返回异常（HTTP ' + scode + '）', http: scode }];
  }

  const status = isObject(sbody) ? sbody : {};
  if (dig(status, 'active') === false) return [0, { result: 'INACTIVE', report: '签到活动未开启', active: false }];
  const tci = dig(status, 'today_checked_in');
  if (tci === true || tci === 1) return [0, alreadyReport(status)];

  let [ccode, cbody] = await post(endpoint + '/v2/billing/meter/daily-checkin', headers, null, true);
  logStep(log, '签到-领取', 'POST', '/v2/billing/meter/daily-checkin', ccode, cbody);

  if (ccode === CODE_NO_NETWORK || ccode === CODE_BUDGET_OUT) {
    return [1, { result: ccode === CODE_NO_NETWORK ? 'NETWORK' : 'TIMEOUT',
      report: '领取请求未能送达，下次自动重试' }];
  }
  if (ccode === 401 || ccode === 403) return [1, authFailure(ccode)];
  if (isAlreadyCheckedIn(cbody)) return [0, alreadyReport(status, '今日已签过（服务端判定已领取）')];

  const credit = dig(cbody, 'credit');
  if (credit !== null && credit !== undefined) {
    const out = { result: 'CLAIMED', credit, report: '成功领取 ' + fmtCredit(credit) + ' 积分' };
    for (const key of ['streak_days', 'total_credits', 'is_streak_day', 'next_streak_day']) {
      out[key] = dig(status, key);
    }
    return [0, out];
  }
  if (isObject(cbody) && ('code' in cbody || 'msg' in cbody)) {
    return [1, { result: 'ERROR', http: ccode,
      report: '领取失败：' + (cbody.msg || ('code ' + cbody.code)) + '（HTTP ' + ccode + '）' }];
  }
  return [1, { result: 'UNKNOWN', http: ccode, report: '未识别的领取返回，请检查接口' }];
}

// ---------- 2) 派猫猫旅行 ----------
async function travelClaimArrived(headers, base, log) {
  const [scode, sbody] = await get(base + '/buddy/travel/status', headers);
  logStep(log, '旅行-查状态', 'GET', '/v2/activity/growth/buddy/travel/status', scode, sbody);
  if (scode === CODE_NO_NETWORK) return { ok: false, skip: true, note: '网络不可达，旅行跳过' };
  if (scode === CODE_BUDGET_OUT) return { ok: false, skip: true, note: '时间预算耗尽，旅行跳过' };
  if (scode === 401 || scode === 403) return { ok: false, auth: true, note: '认证/权限拒绝，旅行跳过' };
  if (!(scode >= 200 && scode < 300)) return { ok: false, note: '查旅行状态失败：' + httpLabel(scode) };

  const state = dig(sbody, 'state');
  const dailyLimit = Boolean(dig(sbody, 'daily_limit_reached'));
  const result = { state_after: state, daily_limit: dailyLimit, status_body: sbody, ok: true };

  if (state === 'arrived') {
    // 每次运行先「领取已到家的旅行奖励」，领取成功置 idle 后即可随机换猫派新趟。
    // 仅当自动领取失败时，才降级为「给领取入口让用户手动领」。
    const recordId = dig(sbody, 'record_id');
    const [ccode, cbody] = await post(base + '/buddy/travel/claim', headers, { record_id: recordId }, false);
    logStep(log, '旅行-领到家礼物', 'POST', '/v2/activity/growth/buddy/travel/claim', ccode, cbody);
    const reward = dig(cbody, 'reward_credit');
    if (ccode >= 200 && ccode < 300 && reward !== null && reward !== undefined) {
      const got = asInt(reward);
      Object.assign(result, { state_after: 'idle', claimed_credit: got, note: '领到旅行礼物 +' + fmtCredit(got) + ' 积分；无需等到第二天，现在就可随机换猫派新趟' });
    } else {
      const msg = isObject(cbody) ? (cbody.msg || '') : '';
      // 领失败不置 idle，避免覆盖未领取的奖励、也不会去派新趟；降级为手动领取引导
      const deeplink = dig(sbody, 'use_deeplink');
      const addr = (typeof deeplink === 'string' && deeplink.trim())
        ? deeplink.trim()
        : 'workbuddy://home?openBuddySwitcher=true（WorkBuddy → Buddy 加油站）';
      Object.assign(result, {
        ok: false,
        manual_claim: true,
        claim_address: addr,
        note: '自动领取失败（' + (msg || httpLabel(ccode)) + '）。奖励可随时在客户端手动领取（不依赖脚本、不必等第二天），领取入口：' + addr
          + '；领取后随时再运行一次即可随机换猫派新趟',
      });
    }
  } else if (state === 'traveling') {
    const loc = dig(sbody, 'location') || {};
    result.note = 'Buddy 旅行中（' + (loc.name != null ? loc.name : '?') + '）；奖励到家后可随时领取'
      + '（客户端手动领或让我自动领皆可），领完即可随机换猫派新趟';
  } else if (state === 'idle') {
    result.note = '旅行空闲，可派新趟';
  } else {
    result.note = '旅行状态：' + state;
  }
  return result;
}

// 随机挑一只已有猫猫设为当前（派新趟前换猫；任何失败都不影响派发）
async function randomBuddySwitch(headers, base, log) {
  try {
    const [lcode, lbody] = await get(base + '/buddy/list', headers);
    logStep(log, '猫猫-查列表', 'GET', '/v2/activity/growth/buddy/list', lcode, lbody);
    if (!(lcode >= 200 && lcode < 300)) return { name: null };
    const buddies = dig(lbody, 'buddies');
    if (!Array.isArray(buddies) || !buddies.length) return { name: null };
    const pool = buddies.filter(isObject);
    const pick = pool[Math.floor(Math.random() * pool.length)];
    if (!pick || pick.instance_id == null) return { name: null };
    const [rcode, rbody] = await post(base + '/buddy/switch', headers, { instance_id: pick.instance_id }, false);
    logStep(log, '猫猫-随机切换', 'POST', '/v2/activity/growth/buddy/switch', rcode, rbody);
    if (!(rcode >= 200 && rcode < 300)) return { name: null };
    return { name: pick.name != null ? pick.name : 'Buddy', instance_id: pick.instance_id };
  } catch (_) {
    return { name: null };
  }
}

async function travelTryDispatch(headers, base, claim, log) {
  const state = claim.state_after;
  if (state === 'traveling') return { ok: true, note: '今日已派过，Buddy 在路上，跳过派发' };
  if (state === 'arrived') return { ok: true, note: '猫猫礼物未领取，请先手动领取（见领取入口），领取后再运行一次即可派新趟' };
  if (state !== 'idle') return { ok: true, note: '当前不可派（state=' + state + '）' };
  if (claim.daily_limit) return { ok: true, note: '今日旅行名额已用完，不派' };

  const [ccode, cbody] = await get(base + '/buddy/travel/config', headers);
  logStep(log, '旅行-查可派地点', 'GET', '/v2/activity/growth/buddy/travel/config', ccode, cbody);
  if (!(ccode >= 200 && ccode < 300)) return { ok: false, note: '查旅行配置失败：' + httpLabel(ccode) };
  const locs = dig(cbody, 'locations');
  if (!(Array.isArray(locs) && locs.length && isObject(locs[0]))) {
    return { ok: false, note: '旅行配置无可用地点' };
  }
  const loc = locs[0];

  // 派新趟前随机换一只已有猫猫（切换失败不影响本次派发）
  const rc = await randomBuddySwitch(headers, base, log);

  const [dcode, dbody] = await post(base + '/buddy/travel/depart', headers, { location_id: loc.id }, false);
  logStep(log, '旅行-派新一趟', 'POST', '/v2/activity/growth/buddy/travel/depart', dcode, dbody);
  if (dcode >= 200 && dcode < 300) {
    const dloc = dig(dbody, 'location') || {};
    const locName = dloc.name != null ? dloc.name : '?';
    const dur = dig(dbody, 'duration_hours') || (dloc.duration_hours != null ? dloc.duration_hours : '?');
    const who = rc.name ? rc.name + '（随机选中）' : 'Buddy';
    return { ok: true, dispatched: true, buddy: rc.name, note: '派 ' + who + ' 去' + locName + '（' + dur + ' 小时后回）' };
  }
  const msg = dig(dbody, 'msg') || '';
  return { ok: false, note: '派 Buddy 失败：' + (msg || httpLabel(dcode)) };
}

// ---------- doctor ----------
function probeRuntime() {
  nativeStorage();   // 绑定不可用会抛 RUNTIME_UNAVAILABLE
  if (!crypto.getCiphers().includes('aes-256-gcm')) authFail('RUNTIME_UNAVAILABLE');
  return process.versions.electron || 'unknown';
}

function runDoctor() {
  const authFile = findAuthFile();
  if (!authFile) return { result: 'NO_AUTH', report: '未找到登录凭据文件' };
  try {
    const session = loadSession(authFile);
    validateSession(session);
    const kind = tokenFormat(session.auth.accessToken);
    const out = { result: 'AUTH_READY', credential_file: authFile, credential_format: kind,
      report: '本地凭据格式有效（' + kind + '）；未联网' };
    if (kind === 'sym-v1') {
      const runtime = findWorkbuddyRuntime();
      const electronVersion = probeRuntime();
      out.runtime = runtime;
      out.electron_version = electronVersion;
      out.report = '已识别加密凭据，运行时具备解密能力（未取密钥、未联网）';
    }
    return out;
  } catch (e) {
    if (e instanceof AuthError) return e.output();
    return { result: 'ERROR', report: 'doctor 异常（' + e.name + '）' };
  }
}

// ---------- 主流程 ----------
async function run() {
  startBudget();
  const authFile = findAuthFile();
  if (!authFile) {
    return { result: 'NO_AUTH', report: '未找到登录凭据文件，请先登录 WorkBuddy 客户端', success: false };
  }
  const log = [];
  // 解密/取 token（失败在这里就返回，根本进不到请求阶段）
  let headers;
  let endpoint;
  try {
    const session = resolveSession(loadSession(authFile));
    headers = buildHeaders(session);
    endpoint = session.auth.endpoint || DEFAULT_ENDPOINT;
  } catch (e) {
    const o = (e instanceof AuthError) ? e.output() : { result: 'AUTH_ERROR', report: String(e && e.message ? e.message : e) };
    o.success = false;
    return o;
  }

  // ===== 第一步：签到（权威结论）=====
  const [ccode, checkout] = await runCheckin(headers, endpoint, log);
  const checkinResult = checkout.result;
  const success = (ccode === 0);   // 签到成功即算成功

  // ===== 第二步：派猫猫旅行（整体隔离，绝不影响上面的签到结论）=====
  let travel = { report: '未运行', result: 'SKIPPED' };
  if (!['NETWORK', 'TIMEOUT', 'AUTH_REJECTED', 'FORBIDDEN', 'NO_SESSION', 'AUTH_ERROR'].includes(checkinResult)) {
    try {
      const base = endpoint + '/v2/activity/growth';
      const claim = await travelClaimArrived(headers, base, log);
      const disp = await travelTryDispatch(headers, base, claim, log);
      travel = {
        claim: claim.note,
        dispatch: disp.note,
        claimed_credit: claim.claimed_credit,
        claim_address: claim.claim_address,
        result: claim.manual_claim ? 'NEED_CLAIM' : ((claim.ok && disp.ok) ? 'OK' : 'PARTIAL'),
      };
      if (claim.claimed_credit != null) travel.reward_credit = claim.claimed_credit;
      // 猫猫奖励积分显式进日志(与签到积分并列汇总一条)
      log.push({
        step: '积分汇总',
        checkin_credit: dig(checkout, 'today_credit'),
        travel_reward_credit: claim.claimed_credit != null ? claim.claimed_credit : 0,
      });
    } catch (e) {
      travel = { result: 'ERROR', report: '旅行模块异常（' + e.name + ': ' + e.message + '）' };
    }
  } else {
    travel = { result: checkinResult, report: '服务端不可达或认证未通过，旅行跳过' };
  }

  let travelReport = travel.report;
  if (!travelReport) {
    travelReport = [travel.claim, travel.dispatch].filter(Boolean).join('；');
  }

  let report = checkout.report || '';
  if (travel.claim || travel.dispatch) {
    report = (report ? report + '；' : '') + travelReport;
  }

  return {
    success,
    checkin_result: checkinResult,
    report,
    checkin: checkout,
    travel,
    needs_attention: (!success) || (travel.result === 'ERROR') || (travel.result === 'NEED_CLAIM'),
    raw: log,
  };
}

async function main() {
  const action = process.argv[2] || 'run';
  let out;
  try {
    if (action === '--doctor') out = runDoctor();
    else if (action === 'run' || action === '') out = await run();
    else out = { result: 'ERROR', report: '未知命令：' + action };
  } catch (e) {
    if (e instanceof AuthError) {
      out = e.output();
      out.success = false;
    } else {
      out = { result: 'ERROR', report: '脚本运行异常（' + e.name + '）', success: false };
    }
  }
  // 脱敏后打印：token 从不进入输出，这里再兜底一次
  process.stdout.write(redact(JSON.stringify(out)) + '\n');
  return out && out.success ? 0 : 1;
}

// ---------- 入口 ----------
if (ensureElectronRuntime()) {
  // 已通过 WorkBuddy Electron 二进制重启本脚本，控制权已交出
} else {
  main().then((code) => { process.exitCode = code; }, (e) => {
    process.stdout.write(redact(JSON.stringify({ result: 'ERROR', report: '脚本运行异常（' + e.name + '）', success: false })) + '\n');
    process.exitCode = 1;
  });
}
