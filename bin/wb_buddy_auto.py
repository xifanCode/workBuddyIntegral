#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""WorkBuddy「Buddy 加油站」本机自动化：每日签到 + 派猫猫旅行。

一次运行做两件事：
  1. 签到（check-in）—— 这是权威结论：签到成功就算成功。
  2. 派猫猫旅行（Buddy travel）—— 先「领掉已经到家的旅行积分」，再「判断能不能派新的一趟」。
     今天已经派过（状态为 traveling）就不再派。旅行段整体隔离，失败绝不影响签到结论。

安全约束：
  - token 只从本机登录态文件读取；加密凭据(sym-v1)由本机 WorkBuddy 运行时就地解密，
    仅经内存管道返回，绝不打印、绝不写文件。所有输出都会再过一次脱敏。
  - 解释器不写死版本号：用 command -v 动态取（见 run_local.sh / crontab）。
  - 接口名以桌面端实际请求为准（见下方 ENDPOINTS），非网络流传的旧名。

ENDPOINTS（逆向自桌面端，全部打官方同一 endpoint https://copilot.tencent.com）：
  签到：POST /v2/billing/meter/checkin-activity-status      查今日是否已领
        POST /v2/billing/meter/daily-checkin                领取今日积分（幂等）
  旅行：GET  /v2/activity/growth/buddy/travel/status        查旅行状态(state/record_id/daily_limit_reached)
        POST /v2/activity/growth/buddy/travel/claim         领已到家的旅行礼物 {"record_id":...}
        GET  /v2/activity/growth/buddy/travel/config        查可派地点
        POST /v2/activity/growth/buddy/travel/depart        派新一趟 {"location_id":...}

用法：
  python3 wb_buddy_auto.py            每日自动化（签到 + 派猫猫旅行），输出一行 JSON + 原始返回
  python3 wb_buddy_auto.py --doctor   离线检查凭据格式/运行时能力，不解密、不联网
"""

import base64
import json
import math
import ntpath
import os
import plistlib
import re
import ssl
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
import urllib.parse

DEFAULT_ENDPOINT = "https://copilot.tencent.com"
AUTH_BASENAME = os.path.join("CodeBuddyExtension", "Data", "Public", "auth", "workbuddy-desktop.info")
CLI_AUTH_BASENAME = os.path.join("CodeBuddyExtension", "Data", "Public", "auth",
                                 "Tencent-Cloud.coding-copilot.info")
REQUEST_TIMEOUT = 30
NETWORK_RETRY_DELAYS = (5, 15, 30, 60, 90)
SERVER_RETRY_DELAYS = (3, 10)
CODE_NO_NETWORK = -1   # 连不上/超时
CODE_BUDGET_OUT = -2   # 本次运行时间预算耗尽，主动放弃
TOKEN_LIMIT = 32768
AUTH_INPUT_LIMIT = 65536
AUTH_HELPER_TIMEOUT = 10.0
AUTH_OUTPUT_LIMIT = 65536
DEFAULT_BUDGET_SECONDS = 420.0

AUTH_REASONS = {
    "INVALID_FORMAT": "登录凭据格式无效，请检查凭据来源和客户端版本",
    "UNSUPPORTED_ENVELOPE": "尚不支持此加密凭据格式，请更新脚本",
    "RUNTIME_NOT_FOUND": "未找到 WorkBuddy 客户端，请用 WORKBUDDY_EXE 指定",
    "INVALID_RUNTIME_PATH": "WORKBUDDY_EXE 不是可用的可执行文件",
    "RUNTIME_UNAVAILABLE": "客户端运行时不支持所需的原生存储接口",
    "KEY_MISMATCH": "凭据与所选客户端的密钥不匹配",
    "DECRYPT_FAILED": "加密凭据解密失败，请检查客户端版本及凭据",
    "HELPER_TIMEOUT": "凭据处理超时，请稍后重试",
    "HELPER_PROTOCOL": "客户端凭据助手返回无效结果",
    "MISSING_SESSION": "登录态不完整（缺少 accessToken 或 uid），请先登录客户端",
}

# 解密助手：只把固定代码放进 argv，加密字段经 stdin 传入；解密结果只经 stdout 管道
# 回到本进程内存，不落盘、不外泄。仅支持 sym-v1 / suite 1。原样取自桌面端逆向逻辑。
AUTH_HELPER_JS = r"""
'use strict';
const crypto = require('crypto');
const inputLimit = 65536;
const failure = reason => { throw {reason}; };
const object = x => x !== null && typeof x === 'object' && !Array.isArray(x);
function base64(value, length) {
  if (typeof value !== 'string' || value.length > inputLimit) failure('INVALID_FORMAT');
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value || (length !== undefined && bytes.length !== length))
    failure('INVALID_FORMAT');
  return bytes;
}
function utf8(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) failure('INVALID_FORMAT');
  return text;
}
function decode(value) {
  if (!object(value) || Object.keys(value).sort().join(',') !== '$wbEncrypted,envelope' || value.$wbEncrypted !== 1)
    failure('UNSUPPORTED_ENVELOPE');
  let envelope;
  try { envelope = JSON.parse(utf8(base64(value.envelope))); }
  catch (e) { failure(e.reason || 'INVALID_FORMAT'); }
  if (!object(envelope) || !Number.isInteger(envelope.suite)) failure('INVALID_FORMAT');
  if (envelope.suite !== 1) failure('UNSUPPORTED_ENVELOPE');
  if (Object.keys(envelope).sort().join(',') !== 'authTag,ciphertext,keyId,nonce,suite' ||
      typeof envelope.keyId !== 'string' || !/^[0-9a-f]{16}$/.test(envelope.keyId)) failure('INVALID_FORMAT');
  return {keyId: envelope.keyId, nonce: base64(envelope.nonce, 12),
    tag: base64(envelope.authTag, 16), ciphertext: base64(envelope.ciphertext)};
}
function nativeStorage() {
  try {
    const storage = process._linkedBinding('electron_browser_workbuddy_storage');
    if (typeof storage.loggerGet !== 'function') failure('RUNTIME_UNAVAILABLE');
    return storage;
  } catch (_) { failure('RUNTIME_UNAVAILABLE'); }
}
function decrypt(envelope) {
  let payload;
  try { payload = JSON.parse(nativeStorage().loggerGet()); }
  catch (_) { failure('RUNTIME_UNAVAILABLE'); }
  let key;
  let plaintext;
  try {
    if (!object(payload) || payload.version !== 1) failure('RUNTIME_UNAVAILABLE');
    let secret;
    try { secret = base64(payload.atRestSecretKey, 32); }
    catch (_) { failure('RUNTIME_UNAVAILABLE'); }
    const empty = secret.every(b => b === 0);
    secret.fill(0);
    if (empty) failure('RUNTIME_UNAVAILABLE');
    key = crypto.createHash('sha256').update(payload.atRestSecretKey, 'utf8').digest();
    payload = null;
    if (crypto.createHash('sha256').update(key).digest('hex').slice(0, 16) !== envelope.keyId)
      failure('KEY_MISMATCH');
    const lp = s => {
      const bytes = Buffer.from(s, 'utf8');
      const length = Buffer.alloc(4); length.writeUInt32BE(bytes.length);
      return Buffer.concat([length, bytes]);
    };
    const aad = Buffer.concat([Buffer.from('WB-AAD\0', 'ascii'), Buffer.from([1]),
      lp('WBEV1'), lp('sym-v1'), Buffer.from([0, 0, 0, 1]), lp(envelope.keyId), Buffer.from([2, 0, 0])]);
    try {
      const cipher = crypto.createDecipheriv('aes-256-gcm', key, envelope.nonce, {authTagLength: 16});
      cipher.setAAD(aad); cipher.setAuthTag(envelope.tag);
      plaintext = Buffer.concat([cipher.update(envelope.ciphertext), cipher.final()]);
    } catch (_) { failure('DECRYPT_FAILED'); }
    const token = utf8(plaintext);
    if (!token.length || token.length > 32768 || !/^[A-Za-z0-9._~+\/-]+=*$/.test(token))
      failure('INVALID_FORMAT');
    return token;
  } finally {
    if (key) key.fill(0);
    if (plaintext) plaintext.fill(0);
  }
}
let chunks = [], size = 0;
function reply(value) {
  process.stdout.write(JSON.stringify({version: 1, ...value}), () => process.exit(value.ok ? 0 : 1));
}
process.stdin.on('data', chunk => {
  size += chunk.length;
  if (size > inputLimit) reply({ok: false, reason: 'INVALID_FORMAT'});
  else chunks.push(chunk);
});
process.stdin.on('error', () => reply({ok: false, reason: 'HELPER_PROTOCOL'}));
process.stdin.on('end', () => {
  try {
    const request = JSON.parse(utf8(Buffer.concat(chunks))); chunks = [];
    if (!object(request) || request.version !== 1) failure('HELPER_PROTOCOL');
    if (request.operation === 'probe') {
      nativeStorage();
      if (!crypto.getCiphers().includes('aes-256-gcm')) failure('RUNTIME_UNAVAILABLE');
      reply({ok: true, electron: process.versions.electron || 'unknown'});
    } else if (request.operation === 'decrypt') {
      reply({ok: true, accessToken: decrypt(decode(request.value))});
    } else failure('HELPER_PROTOCOL');
  } catch (e) {
    const reasons = ['INVALID_FORMAT','UNSUPPORTED_ENVELOPE','RUNTIME_UNAVAILABLE',
      'KEY_MISMATCH','DECRYPT_FAILED','HELPER_PROTOCOL'];
    reply({ok: false, reason: reasons.includes(e.reason) ? e.reason : 'HELPER_PROTOCOL'});
  }
});
"""


class AuthError(Exception):
    """只有固定的、非敏感的消息允许跨凭据边界。"""

    def __init__(self, reason, result="AUTH_ERROR"):
        self.reason = reason
        self.result = result
        super().__init__(AUTH_REASONS.get(reason, "本地未找到有效登录会话，请先登录客户端"))

    def output(self):
        return {"result": self.result, "reason": self.reason, "report": str(self), "needs_attention": True}


# ---- 全局：解密出的 token 仅存于此内存集合，用于输出前脱敏 ----
_sensitive_values = set()
_started_at = None
_budget_seconds = DEFAULT_BUDGET_SECONDS


def _redact(text):
    """把可能出现的 token 替换掉。正常情况下 token 根本不会进入输出，这是兜底。"""
    for v in _sensitive_values:
        if v and v in text:
            text = text.replace(v, "[REDACTED]")
    return text


def _start_budget():
    global _started_at
    _started_at = time.monotonic()


def _budget_left():
    if _started_at is None:
        return _budget_seconds
    return _budget_seconds - (time.monotonic() - _started_at)


# ---------- 凭据定位 / 解密 ----------

def _valid_token(token):
    return (isinstance(token, str) and 0 < len(token) <= TOKEN_LIMIT
            and re.fullmatch(r"[A-Za-z0-9._~+/-]+=*", token) is not None)


def _validate_session(session):
    if not isinstance(session, dict):
        raise AuthError("INVALID_FORMAT")
    for field in ("auth", "account"):
        if session.get(field) is None:
            raise AuthError("MISSING_SESSION", "NO_SESSION")
        if not isinstance(session[field], dict):
            raise AuthError("INVALID_FORMAT")
    tok = session["auth"].get("accessToken")
    if tok in (None, "") or session["account"].get("uid") in (None, ""):
        raise AuthError("MISSING_SESSION", "NO_SESSION")
    endpoint = session["auth"].get("endpoint")
    if endpoint not in (None, ""):
        if not isinstance(endpoint, str) or re.search(r"[\s\x00-\x1f\x7f]", endpoint):
            raise AuthError("INVALID_FORMAT")
        try:
            parsed = urllib.parse.urlsplit(endpoint)
            if parsed.scheme != "https" or not parsed.hostname or parsed.username or parsed.password \
                    or parsed.query or parsed.fragment:
                raise ValueError()
            parsed.port
        except ValueError:
            raise AuthError("INVALID_FORMAT") from None


def _token_format(value):
    """区分明文 accessToken 与 sym-v1 加密信封。"""
    if isinstance(value, str):
        if not _valid_token(value):
            raise AuthError("INVALID_FORMAT")
        return "plaintext"
    if not isinstance(value, dict):
        raise AuthError("INVALID_FORMAT")
    if (set(value) != {"$wbEncrypted", "envelope"} or
            type(value.get("$wbEncrypted")) is not int or value["$wbEncrypted"] != 1):
        raise AuthError("UNSUPPORTED_ENVELOPE")
    try:
        encoded = value["envelope"]
        if not isinstance(encoded, str) or not 0 < len(encoded) <= AUTH_INPUT_LIMIT - 1024:
            raise ValueError()
        raw = base64.b64decode(encoded, validate=True)
        if base64.b64encode(raw).decode("ascii") != encoded:
            raise ValueError()
        envelope = json.loads(raw.decode("utf-8"))
        if not isinstance(envelope, dict) or type(envelope.get("suite")) is not int:
            raise ValueError()
        if envelope["suite"] != 1:
            raise AuthError("UNSUPPORTED_ENVELOPE")
        if set(envelope) != {"suite", "keyId", "nonce", "authTag", "ciphertext"}:
            raise ValueError()
        if not isinstance(envelope["keyId"], str) or not re.fullmatch(r"[0-9a-f]{16}", envelope["keyId"]):
            raise ValueError()
        for field, length in (("nonce", 12), ("authTag", 16), ("ciphertext", None)):
            data = envelope[field]
            if not isinstance(data, str):
                raise ValueError()
            decoded = base64.b64decode(data, validate=True)
            if base64.b64encode(decoded).decode("ascii") != data or (length is not None and len(decoded) != length):
                raise ValueError()
        return "sym-v1"
    except (ValueError, TypeError, KeyError):
        raise AuthError("INVALID_FORMAT") from None


def _mac_runtime(bundle):
    try:
        with open(os.path.join(bundle, "Contents", "Info.plist"), "rb") as f:
            name = plistlib.load(f).get("CFBundleExecutable")
        if not isinstance(name, str) or not name or name in (".", "..") or "/" in name or "\\" in name:
            return None
        return os.path.join(bundle, "Contents", "MacOS", name)
    except (OSError, ValueError, TypeError, AttributeError):
        return None


def _registry_runtime_path(value, icon=False):
    if not isinstance(value, str) or re.search(r"[\x00-\x1f\x7f]", value):
        return None
    value = value.strip()
    if value.startswith('"'):
        suffix = r"(?:\s*,\s*-?\d+)?" if icon else ""
        m = re.fullmatch(r'"([^"]+)"' + suffix, value)
        if not m:
            return None
        value = m[1]
    elif '"' in value:
        return None
    elif icon:
        value = re.sub(r",\s*-?\d+$", "", value).rstrip()
    if not ntpath.splitdrive(value)[0] or not ntpath.isabs(value):
        return None
    if not icon:
        value = ntpath.join(value, "WorkBuddy.exe")
    value = ntpath.normpath(value)
    if ntpath.basename(value).casefold() != "workbuddy.exe":
        return None
    return value


def _windows_registry_runtimes():
    if sys.platform != "win32":
        return
    try:
        import winreg
    except ImportError:
        return
    subkey = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    seen = set()
    for hive in (winreg.HKEY_CURRENT_USER, winreg.HKEY_LOCAL_MACHINE):
        for view in (winreg.KEY_WOW64_64KEY, winreg.KEY_WOW64_32KEY):
            try:
                with winreg.OpenKey(hive, subkey, 0, winreg.KEY_READ | view) as root:
                    count = winreg.QueryInfoKey(root)[0]
                    for index in range(count):
                        try:
                            with winreg.OpenKey(root, winreg.EnumKey(root, index),
                                                0, winreg.KEY_READ) as entry:
                                name = None
                                try:
                                    name, _ = winreg.QueryValueEx(entry, "DisplayName")
                                except OSError:
                                    continue
                                if not name or not re.fullmatch(
                                        r"WorkBuddy(?:\s+\d+(?:\.\d+)*(?:[-+][0-9A-Za-z.-]+)?)?",
                                        name.strip(), re.IGNORECASE):
                                    continue
                                for field in ("InstallLocation", "DisplayIcon"):
                                    try:
                                        val, _ = winreg.QueryValueEx(entry, field)
                                    except OSError:
                                        continue
                                    path = _registry_runtime_path(val, icon=field == "DisplayIcon")
                                    if path and ntpath.normcase(path) not in seen:
                                        seen.add(ntpath.normcase(path))
                                        if os.path.isfile(path):
                                            yield path
                        except OSError:
                            continue
            except OSError:
                continue


def find_workbuddy_runtime():
    override = os.environ.get("WORKBUDDY_EXE")
    if override:
        path = os.path.abspath(os.path.expanduser(override))
        if not os.path.isfile(path) or (os.name != "nt" and not os.access(path, os.X_OK)):
            raise AuthError("INVALID_RUNTIME_PATH")
        return path
    home = os.path.expanduser("~")
    candidates = []
    if sys.platform == "win32":
        local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
        candidates.append(os.path.join(local, "Programs", "WorkBuddy", "WorkBuddy.exe"))
        for name in ("ProgramFiles", "ProgramFiles(x86)"):
            if os.environ.get(name):
                candidates.append(os.path.join(os.environ[name], "WorkBuddy", "WorkBuddy.exe"))
    elif sys.platform == "darwin":
        candidates = [_mac_runtime(os.path.join(root, "WorkBuddy.app"))
                      for root in ("/Applications", os.path.join(home, "Applications"))]
    for path in candidates:
        if path and os.path.isfile(path) and (os.name == "nt" or os.access(path, os.X_OK)):
            return os.path.abspath(path)
    if sys.platform == "win32":
        for registered in _windows_registry_runtimes():
            return registered
    raise AuthError("RUNTIME_NOT_FOUND")


def _run_auth_helper(exe, request):
    data = json.dumps(dict(request, version=1), ensure_ascii=True).encode("ascii")
    if len(data) > AUTH_INPUT_LIMIT:
        raise AuthError("INVALID_FORMAT")
    timeout = min(AUTH_HELPER_TIMEOUT, _budget_left())
    if timeout <= 0:
        raise AuthError("HELPER_TIMEOUT")
    env = {k: v for k, v in os.environ.items()
           if not k.upper().startswith(("NODE_", "ELECTRON_", "WORKBUDDY_"))}
    env["ELECTRON_RUN_AS_NODE"] = "1"   # 让客户端二进制退化成 node 来跑 -e 助手脚本
    try:
        process = subprocess.Popen([exe, "-e", AUTH_HELPER_JS], stdin=subprocess.PIPE,
                                   stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                   env=env, shell=False,
                                   creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except OSError:
        raise AuthError("RUNTIME_UNAVAILABLE") from None
    output = {}
    failed = threading.Event()

    def read_pipe(name, pipe, limit):
        try:
            captured = pipe.read(limit + 1)
            if len(captured) > limit:
                failed.set()
                process.kill()
            else:
                output[name] = captured
        except OSError:
            failed.set()

    def write_pipe():
        try:
            process.stdin.write(data)
            process.stdin.close()
        except OSError:
            failed.set()

    workers = [threading.Thread(target=read_pipe, args=("stdout", process.stdout, AUTH_OUTPUT_LIMIT), daemon=True),
               threading.Thread(target=read_pipe, args=("stderr", process.stderr, 8192), daemon=True),
               threading.Thread(target=write_pipe, daemon=True)]
    deadline = time.monotonic() + timeout
    try:
        for w in workers:
            w.start()
        try:
            process.wait(timeout=max(0.001, deadline - time.monotonic()))
        except subprocess.TimeoutExpired:
            raise AuthError("HELPER_TIMEOUT") from None
        for w in workers:
            w.join(max(0, deadline - time.monotonic()))
        if any(w.is_alive() for w in workers):
            raise AuthError("HELPER_TIMEOUT")
        if failed.is_set():
            raise AuthError("HELPER_PROTOCOL")
        try:
            reply = json.loads(output.get("stdout", b"").decode("utf-8"))
        except (ValueError, UnicodeError):
            raise AuthError("HELPER_PROTOCOL") from None
        if not isinstance(reply, dict) or type(reply.get("version")) is not int or reply["version"] != 1:
            raise AuthError("HELPER_PROTOCOL")
        if reply.get("ok") is False and process.returncode == 1:
            reason = reply.get("reason")
            raise AuthError(reason if isinstance(reason, str) and reason in AUTH_REASONS else "HELPER_PROTOCOL")
        if reply.get("ok") is not True or process.returncode != 0:
            raise AuthError("HELPER_PROTOCOL")
        if request["operation"] == "decrypt":
            if set(reply) != {"version", "ok", "accessToken"} or not _valid_token(reply.get("accessToken")):
                raise AuthError("HELPER_PROTOCOL")
        elif (set(reply) != {"version", "ok", "electron"} or not isinstance(reply.get("electron"), str)
                or re.fullmatch(r"[0-9A-Za-z.+-]{1,64}", reply["electron"]) is None):
            raise AuthError("HELPER_PROTOCOL")
        return reply
    finally:
        if process.poll() is None:
            process.kill()
        process.wait()
        for w in workers:
            if w.ident is not None:
                w.join(1)
        if not any(w.is_alive() for w in workers):
            for pipe in (process.stdin, process.stdout, process.stderr):
                try:
                    pipe.close()
                except Exception:
                    pass


def resolve_session(session):
    _validate_session(session)
    token = session["auth"]["accessToken"]
    if _token_format(token) != "plaintext":
        token = _run_auth_helper(find_workbuddy_runtime(), {"operation": "decrypt", "value": token})["accessToken"]
    _sensitive_values.add(token)
    return dict(session, auth=dict(session["auth"], accessToken=token))


def find_auth_file():
    override = os.environ.get("WORKBUDDY_AUTH_FILE")
    if override:
        return (override if os.path.exists(override) else None), [override]
    home = os.path.expanduser("~")
    local = os.environ.get("LOCALAPPDATA") or os.path.join(home, "AppData", "Local")
    xdg = os.environ.get("XDG_DATA_HOME") or os.path.join(home, ".local", "share")
    candidates = [
        os.path.join(local, AUTH_BASENAME),
        os.path.join(home, "Library", "Application Support", AUTH_BASENAME),
        os.path.join(xdg, CLI_AUTH_BASENAME),
        os.path.join(home, ".config", AUTH_BASENAME),
        os.path.join(home, ".workbuddy", "auth", "workbuddy-desktop.info"),
    ]
    for c in candidates:
        if os.path.exists(c):
            return c, candidates
    return None, candidates


def load_session_retry(auth_file, attempts=3, delay=2.0):
    last = None
    for i in range(attempts):
        try:
            with open(auth_file, "r", encoding="utf-8") as f:
                return json.load(f)
        except PermissionError as e:
            last = e
            if i < attempts - 1:
                time.sleep(delay)
    raise last


def build_headers(session):
    _validate_session(session)
    auth = session.get("auth") or {}
    account = session.get("account") or {}
    token = auth.get("accessToken")
    uid = account.get("uid")
    if not _valid_token(token):
        raise AuthError("INVALID_FORMAT")
    headers = {
        "Accept": "application/json",
        "Authorization": "Bearer %s" % token,   # token 只进请求头，绝不记录/打印
        "Content-Type": "application/json",
        "X-User-Id": uid,
        "User-Agent": "WorkBuddy",
    }
    if account.get("enterpriseId"):
        headers["X-Enterprise-Id"] = account["enterpriseId"]
        headers["X-Tenant-Id"] = account["enterpriseId"]
    if auth.get("domain"):
        headers["X-Domain"] = auth["domain"]
    return headers


# ---------- HTTP ----------

def _request(url, headers, method="GET", payload=None, timeout=REQUEST_TIMEOUT):
    body = None
    if payload is not None:
        body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, headers=headers, method=method)
    ctx = ssl.create_default_context()
    try:
        with urllib.request.urlopen(req, timeout=timeout, context=ctx) as resp:
            raw = resp.read().decode("utf-8")
            try:
                return resp.status, json.loads(raw)
            except Exception:
                return resp.status, {"raw": raw[:500]}
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8", "replace")
        try:
            return e.code, json.loads(raw)
        except Exception:
            return e.code, {"raw": raw[:500]}
    except urllib.error.URLError as e:
        return CODE_NO_NETWORK, {"error": str(e.reason)}
    except Exception as e:
        return CODE_NO_NETWORK, {"error": str(e)}


def _retry_delays(code):
    if code == CODE_NO_NETWORK:
        return NETWORK_RETRY_DELAYS
    if code >= 500:
        return SERVER_RETRY_DELAYS
    return ()


def _request_with_retry(url, headers, method="GET", payload=None, retry=True):
    if _budget_left() <= 1:
        return CODE_BUDGET_OUT, {"error": "已达本次运行时间预算，跳过剩余请求"}
    code, body = _request(url, headers, method=method, payload=payload,
                          timeout=max(1, min(REQUEST_TIMEOUT, _budget_left())))
    if not retry:
        return code, body
    attempts = {}
    while True:
        delays = _retry_delays(code)
        if not delays:
            return code, body
        used = attempts.get(delays, 0)
        if used >= len(delays):
            return code, body
        delay = delays[used]
        attempts[delays] = used + 1
        if _budget_left() <= delay + REQUEST_TIMEOUT:
            return code, body
        time.sleep(delay)
        code, body = _request(url, headers, method=method, payload=payload,
                              timeout=max(1, min(REQUEST_TIMEOUT, _budget_left())))


def post(url, headers, payload=None, retry=False):
    """POST 默认不重试：写操作若在服务端处理完成后才超时，重试会重复提交。"""
    return _request_with_retry(url, headers, method="POST", payload=payload, retry=retry)


def get(url, headers):
    return _request_with_retry(url, headers, method="GET", retry=True)


# ---------- 小工具 ----------

def dig(obj, key):
    if isinstance(obj, dict):
        if key in obj and obj[key] is not None:
            return obj[key]
        for k in ("data", "result", "resp", "response"):
            if k in obj and isinstance(obj[k], dict):
                r = dig(obj[k], key)
                if r is not None:
                    return r
    return None


def as_int(v, default=0):
    try:
        return int(v)
    except (TypeError, ValueError, OverflowError):
        return default


def fmt_credit(v):
    try:
        return int(v)
    except (TypeError, ValueError, OverflowError):
        return v


def _http_label(code):
    if code == CODE_NO_NETWORK:
        return "网络不可达"
    if code == CODE_BUDGET_OUT:
        return "时间预算耗尽"
    return "HTTP %s" % code


def _is_already_checked_in(cbody):
    if cbody is None:
        return True
    if isinstance(cbody, dict):
        msg = cbody.get("msg") or ""
        if cbody.get("code") == 10001 or "已签" in msg:
            return True
    return False


def _log_step(log, step, method, path, code, body):
    """记录一次原始请求/返回。只记 path 与 body，绝不记请求头（含 token）。"""
    log.append({"step": step, "method": method, "path": path, "http": code, "body": body})


def _auth_failure(code):
    if code == 401:
        return {"result": "AUTH_REJECTED", "http": code, "needs_attention": True,
                "report": "服务端拒绝认证（HTTP 401），请检查客户端登录状态"}
    return {"result": "FORBIDDEN", "http": code, "needs_attention": True,
            "report": "服务端拒绝此操作（HTTP 403），请检查账号权限或活动条件"}


def _already_report(status, via=None):
    today_credit = dig(status, "today_credit") or dig(status, "daily_credit")
    streak_days = dig(status, "streak_days")
    total_credits = dig(status, "total_credits")
    inner = []
    if today_credit is not None:
        inner.append("今日 +%s" % fmt_credit(today_credit))
    if streak_days is not None:
        inner.append("连续 %s 天" % streak_days)
    if total_credits is not None:
        inner.append("累计 %s 积分" % fmt_credit(total_credits))
    prefix = via or "今日已签过"
    report = "%s（%s）" % (prefix, "，".join(inner)) if inner else prefix
    return {"result": "ALREADY", "report": report, "today_credit": today_credit,
            "streak_days": streak_days, "total_credits": total_credits}


# ---------- 1) 签到：权威结论 ----------

def run_checkin(headers, endpoint, log):
    """查状态 -> 未签才领。返回 (退出码, 结果dict)。签到成功=退出码0。"""
    scode, sbody = post(endpoint + "/v2/billing/meter/checkin-activity-status", headers, retry=True)
    _log_step(log, "签到-查状态", "POST", "/v2/billing/meter/checkin-activity-status", scode, sbody)

    if scode == CODE_BUDGET_OUT:
        return 1, {"result": "TIMEOUT", "report": "已达时间预算，签到跳过，下次自动重试"}
    if scode == CODE_NO_NETWORK:
        return 1, {"result": "NETWORK", "report": "网络不可达，签到跳过（%s）" % (sbody.get("error") or "")}
    if scode in (401, 403):
        return 1, _auth_failure(scode)
    if not (200 <= scode < 300):
        return 1, {"result": "ERROR", "report": "签到接口返回异常（HTTP %s）" % scode, "http": scode}

    status = sbody if isinstance(sbody, dict) else {}
    if dig(status, "active") is False:
        return 0, {"result": "INACTIVE", "report": "签到活动未开启", "active": False}
    if dig(status, "today_checked_in") in (True, 1):
        return 0, _already_report(status)

    ccode, cbody = post(endpoint + "/v2/billing/meter/daily-checkin", headers, retry=True)
    _log_step(log, "签到-领取", "POST", "/v2/billing/meter/daily-checkin", ccode, cbody)

    if ccode in (CODE_NO_NETWORK, CODE_BUDGET_OUT):
        return 1, {"result": "NETWORK" if ccode == CODE_NO_NETWORK else "TIMEOUT",
                   "report": "领取请求未能送达，下次自动重试"}
    if ccode in (401, 403):
        return 1, _auth_failure(ccode)
    if _is_already_checked_in(cbody):
        return 0, _already_report(status, via="今日已签过（服务端判定已领取）")

    credit = dig(cbody, "credit")
    if credit is not None:
        out = {"result": "CLAIMED", "credit": credit,
               "report": "成功领取 %s 积分" % fmt_credit(credit)}
        for key in ("streak_days", "total_credits", "is_streak_day", "next_streak_day"):
            out[key] = dig(status, key)
        return 0, out
    if isinstance(cbody, dict) and ("code" in cbody or "msg" in cbody):
        return 1, {"result": "ERROR", "http": ccode,
                   "report": "领取失败：%s（HTTP %s）" % (cbody.get("msg") or ("code %s" % cbody.get("code")), ccode)}
    return 1, {"result": "UNKNOWN", "http": ccode,
               "report": "未识别的领取返回，请检查接口"}


# ---------- 2) 派猫猫旅行：先「领到家的」，再「判断派不派新趟」，两段分开 ----------

def travel_claim_arrived(headers, base, log):
    """第一步：领掉已经到家的旅行积分（只领，不在这里决定派不派）。"""
    scode, sbody = get(base + "/buddy/travel/status", headers)
    _log_step(log, "旅行-查状态", "GET", "/v2/activity/growth/buddy/travel/status", scode, sbody)
    if scode == CODE_NO_NETWORK:
        return {"ok": False, "skip": True, "note": "网络不可达，旅行跳过"}
    if scode == CODE_BUDGET_OUT:
        return {"ok": False, "skip": True, "note": "时间预算耗尽，旅行跳过"}
    if scode in (401, 403):
        return {"ok": False, "auth": True, "note": "认证/权限拒绝，旅行跳过"}
    if not (200 <= scode < 300):
        return {"ok": False, "note": "查旅行状态失败：%s" % _http_label(scode)}

    state = dig(sbody, "state")
    daily_limit = bool(dig(sbody, "daily_limit_reached"))
    result = {"state_after": state, "daily_limit": daily_limit, "status_body": sbody, "ok": True}

    if state == "arrived":
        record_id = dig(sbody, "record_id")
        ccode, cbody = post(base + "/buddy/travel/claim", headers, {"record_id": record_id})
        _log_step(log, "旅行-领到家礼物", "POST", "/v2/activity/growth/buddy/travel/claim", ccode, cbody)
        if 200 <= ccode < 300 and dig(cbody, "reward_credit") is not None:
            got = as_int(dig(cbody, "reward_credit"))
            result.update(state_after="idle", claimed_credit=got,
                          note="领到旅行礼物 +%s 积分" % fmt_credit(got))
        else:
            msg = (dig(cbody, "msg") or "") if isinstance(cbody, dict) else ""
            # 领失败不置 idle，避免覆盖未领取的奖励、也不会去派新趟
            result.update(ok=False, note="领旅行礼物失败：%s" % (msg or _http_label(ccode)))
    elif state == "traveling":
        result["note"] = "Buddy 旅行中（%s）" % (dig(sbody, "location") or {}).get("name", "?")
    elif state == "idle":
        result["note"] = "旅行空闲，可派新趟"
    else:
        result["note"] = "旅行状态：%s" % state
    return result


def travel_try_dispatch(headers, base, claim, log):
    """第二步：单独判断能不能派新的一趟。今天已经派过（traveling）就不派。"""
    state = claim.get("state_after")
    status_body = claim.get("status_body")
    if state == "traveling":
        return {"ok": True, "note": "今日已派过，Buddy 在路上，跳过派发"}
    if state != "idle":
        return {"ok": True, "note": "当前不可派（state=%s）" % state}
    if claim.get("daily_limit"):
        return {"ok": True, "note": "今日旅行名额已用完，不派"}

    ccode, cbody = get(base + "/buddy/travel/config", headers)
    _log_step(log, "旅行-查可派地点", "GET", "/v2/activity/growth/buddy/travel/config", ccode, cbody)
    if not (200 <= ccode < 300):
        return {"ok": False, "note": "查旅行配置失败：%s" % _http_label(ccode)}
    locs = dig(cbody, "locations")
    if not (locs and isinstance(locs[0], dict)):
        return {"ok": False, "note": "旅行配置无可用地点"}
    loc = locs[0]

    dcode, dbody = post(base + "/buddy/travel/depart", headers, {"location_id": loc.get("id")})
    _log_step(log, "旅行-派新一趟", "POST", "/v2/activity/growth/buddy/travel/depart", dcode, dbody)
    if 200 <= dcode < 300:
        loc_name = (dig(dbody, "location") or {}).get("name", "?")
        dur = dig(dbody, "duration_hours") or (dig(dbody, "location") or {}).get("duration_hours", "?")
        return {"ok": True, "dispatched": True,
                "note": "派 Buddy 去%s（%s 小时后回）" % (loc_name, dur)}
    msg = dig(dbody, "msg") or ""
    return {"ok": False, "note": "派 Buddy 失败：%s" % (msg or _http_label(dcode))}


def run_doctor():
    auth_file, looked = find_auth_file()
    if not auth_file:
        return {"result": "NO_AUTH", "report": "未找到登录凭据文件", "looked_in": looked}
    try:
        session = load_session_retry(auth_file)
        _validate_session(session)
        kind = _token_format(session["auth"]["accessToken"])
        out = {"result": "AUTH_READY", "credential_file": auth_file, "credential_format": kind,
               "report": "本地凭据格式有效（%s）；未联网" % kind}
        if kind == "sym-v1":
            runtime = find_workbuddy_runtime()
            probe = _run_auth_helper(runtime, {"operation": "probe"})
            out.update(runtime=runtime, electron_version=probe.get("electron"),
                       report="已识别加密凭据，运行时具备解密能力（未取密钥、未联网）")
        return out
    except AuthError as e:
        return e.output()
    except Exception as e:
        return {"result": "ERROR", "report": "doctor 异常（%s）" % type(e).__name__}


def run():
    _start_budget()
    auth_file, looked = find_auth_file()
    if not auth_file:
        return {"result": "NO_AUTH", "report": "未找到登录凭据文件，请先登录 WorkBuddy 客户端",
                "looked_in": looked, "success": False}
    log = []
    # 解密/取 token（失败在这里就返回，根本进不到请求阶段）
    try:
        session = resolve_session(load_session_retry(auth_file))
        headers = build_headers(session)
    except AuthError as e:
        return {"result": e.result, "report": e.output()["report"], "success": False}
    endpoint = (session["auth"].get("endpoint") or DEFAULT_ENDPOINT)

    # ===== 第一步：签到（权威结论）=====
    ccode, checkout = run_checkin(headers, endpoint, log)
    checkin_result = checkout.get("result")
    success = (ccode == 0)   # 签到成功即算成功

    # ===== 第二步：派猫猫旅行（整体隔离，绝不影响上面的签到结论）=====
    # 只有在服务端可达且已认证时才跑旅行；否则旅行也不可能成功。
    travel = {"report": "未运行", "result": "SKIPPED"}
    if checkin_result not in ("NETWORK", "TIMEOUT", "AUTH_REJECTED", "FORBIDDEN", "NO_SESSION", "AUTH_ERROR"):
        try:
            base = endpoint + "/v2/activity/growth"
            claim = travel_claim_arrived(headers, base, log)          # 先：领到家的旅行积分
            disp = travel_try_dispatch(headers, base, claim, log)      # 再：单独判断派不派新趟
            travel = {
                "claim": claim.get("note"),
                "dispatch": disp.get("note"),
                "claimed_credit": claim.get("claimed_credit"),
                "result": "OK" if (claim.get("ok") and disp.get("ok")) else "PARTIAL",
            }
        except Exception as e:
            travel = {"result": "ERROR", "report": "旅行模块异常（%s: %s）" % (type(e).__name__, e)}
    else:
        travel = {"result": checkin_result, "report": "服务端不可达或认证未通过，旅行跳过"}

    travel_report = travel.get("report")
    if not travel_report:
        travel_report = "；".join(x for x in (travel.get("claim"), travel.get("dispatch")) if x)

    report = checkout.get("report", "")
    if travel.get("claim") or travel.get("dispatch"):
        report = (report + "；" if report else "") + travel_report

    return {
        "success": success,
        "checkin_result": checkin_result,
        "report": report,
        "checkin": checkout,
        "travel": travel,
        "needs_attention": (not success) or (travel.get("result") in ("ERROR",)),
        "raw": log,
    }


def main():
    action = sys.argv[1] if len(sys.argv) > 1 else "run"
    try:
        if action == "--doctor":
            out = run_doctor()
        elif action in ("run", ""):
            out = run()
        else:
            out = {"result": "ERROR", "report": "未知命令：%s" % action}
    except AuthError as e:
        out = e.output()
        out["success"] = False
    except Exception as e:
        out = {"result": "ERROR", "report": "脚本运行异常（%s）" % type(e).__name__, "success": False}
    # 脱敏后打印：token 从不进入输出，这里再兜底一次
    print(_redact(json.dumps(out, ensure_ascii=False)))
    return 0 if out.get("success") else 1


if __name__ == "__main__":
    sys.exit(main())
