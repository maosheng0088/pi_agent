"""Pi adapter for the original 加约存档测PO重复 read-only business program.

Original configuration, Feishu readers and sheet filters are reused. The original
auth/run/notifier modules are never imported. No business writes or external
notifications are available through this adapter's HTTP boundary.
"""
from __future__ import annotations

import argparse
import ast
import contextlib
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import date, datetime, timedelta, timezone
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import threading
import time
import types
from urllib.parse import unquote, urlparse
import uuid


CST = timezone(timedelta(hours=8))
MAX_REPORT_BYTES = 1024 * 1024
MAX_SUMMARY_BYTES = 15000
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
IGNORED_STATUSES = frozenset(("CLOSED", "DELETED", "CANCELLED"))
SOURCE_FILES = ("config.py", "exceptions.py", "feishu_base.py", "feishu_sheets.py", "sheets_reader.py")
CONFIG_NAMES = frozenset((
    "FEISHU_APP_ID", "FEISHU_APP_SECRET", "FEISHU_HOST", "ACCOUNTS_TABLE_APP_TOKEN",
    "ACCOUNTS_TABLE_ID", "ACCOUNTS_VIEW_ID", "ACCOUNTS_FIELD_NAME", "ACCOUNTS_FIELD_EMAIL",
    "ACCOUNTS_FIELD_PASSWORD", "ACCOUNTS_FIELD_PORT", "SHEET_SCHEMAS", "ANOMALY_MIN_APPOINTMENTS",
    "SIGNIN_URL", "REQUEST_URL", "HOMEV2_URL", "REQUIRED_COOKIES", "COOKIE_DEFAULTS",
    "SEARCH_SHIPMENTID_URL", "SEARCH_TYPE_PRO", "HTTP_HEADERS"))
ERROR_LABELS = {
    "registration_invalid": "任务注册配置无效", "source_unavailable": "原程序源码不存在或不完整",
    "source_load_failed": "原程序读取模块无法加载", "configuration_missing": "原程序必需配置缺失",
    "dependency_missing": "运行依赖未就绪", "network_mode_invalid": "本任务只支持直连网络配置",
    "endpoint_not_allowed": "请求不在允许的只读官方接口范围内", "deadline_exceeded": "超过本次检查时限",
    "network_failed": "业务网络请求失败", "auth_required": "Amazon 登录或访问校验未通过",
    "http_error": "业务接口返回错误状态", "response_invalid": "业务接口返回格式无效",
    "response_too_large": "业务响应超过大小限制", "request_limit": "本次请求数量超过处理上限",
    "accounts_load_failed": "读取飞书承运人失败", "no_accounts": "飞书没有承运人记录",
    "account_invalid": "承运人配置无效", "duplicate_port": "承运人浏览器端口重复",
    "months_missing": "必需月份工作表缺失", "sheets_read_failed": "业务工作表读取失败",
    "rows_invalid": "业务来源行格式无效", "no_schemas": "没有配置业务表读取规则",
    "browser_busy": "其他检查仍在使用 Amazon 专属浏览器，本次等待已超时",
    "login_failed": "承运人登录刷新失败", "query_failed": "预约查询失败",
    "result_too_large": "运行报告超过大小限制", "result_invalid": "运行报告格式无效",
    "check_failed": "检查未能完成", "run_id_already_exists": "本次执行编号已有结果，拒绝覆盖旧记录",
}
LOGIN_PROGRESS_LABELS = {
    "login_started": "开始检查专属 Chromium 登录。",
    "configuration": "检查承运人登录配置。",
    "browser_attach": "连接承运人专属 Chromium。",
    "browser_tab_create": "打开专属登录页面。",
    "signin_navigation": "正在加载 Amazon 登录页面。",
    "signin_state": "检查 Amazon 登录页面状态。",
    "account_selection": "自动选择已配置的承运人账户。",
    "email_input": "填写已配置的登录账号。",
    "password_input": "填写已配置的登录密码。",
    "form_submit": "提交登录信息，等待 Amazon 响应。",
    "request_navigation": "正在加载预约工作台。",
    "request_state": "验证预约工作台登录状态。",
    "language_switch": "切换并验证中文查询界面。",
    "search_navigation": "正在加载预约查询页面。",
    "search_state": "验证预约查询页面状态。",
    "cookie_export": "提取本次已验证的登录会话。",
    "session_save": "保存刷新后的登录会话。",
    "verification_required": "等待管理员完成验证码或二次验证，完成后自动继续。",
    "session_refreshed": "登录校验通过，查询会话已刷新。",
}


class CheckError(Exception):
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def safe_text(value, maximum=120):
    if isinstance(value, bool) or not isinstance(value, (str, int)):
        return ""
    return re.sub(r"[\x00-\x1f\x7f]", "", str(value)).strip()[:maximum]


def login_progress_logger(log, index, total):
    previous = None
    def progress(event):
        nonlocal previous
        if not isinstance(event, dict):
            return
        phase = event.get("phase")
        if not isinstance(phase, str) or phase not in LOGIN_PROGRESS_LABELS:
            phase = event.get("stage")
        if not isinstance(phase, str) or phase not in LOGIN_PROGRESS_LABELS or phase == previous:
            return
        previous = phase
        # Event fields may contain browser/private diagnostics. Only the fixed
        # stage label and our own numeric progress can enter print logs.
        log(f"[po-duplicate] 登录 {index}/{total}：{LOGIN_PROGRESS_LABELS[phase]}", flush=True)
    return progress


def now_iso():
    return datetime.now(CST).isoformat(timespec="seconds")


def validate_run_id(value):
    if not isinstance(value, str) or not RUN_ID.fullmatch(value) or value.lower() == "latest":
        raise CheckError("registration_invalid")
    return value


def parse_cell_range(value, *, require_sheet=False):
    if not isinstance(value, str):
        return None
    match = re.fullmatch(r"(?:(?P<sheet>[A-Za-z0-9_-]{1,120})!)?(?P<col>[A-Z]{1,3})(?P<row>[1-9][0-9]{0,6})(?::(?P<endcol>[A-Z]{1,3})(?P<endrow>[1-9][0-9]{0,6}))?", value)
    if not match or require_sheet and not match["sheet"]:
        return None
    column = lambda letters: sum((ord(char) - 64) * (26 ** index) for index, char in enumerate(reversed(letters)))
    start_col, end_col = column(match["col"]), column(match["endcol"] or match["col"])
    start_row, end_row = int(match["row"]), int(match["endrow"] or match["row"])
    if start_col > end_col or start_row > end_row or end_col > 18278 or end_row > 1000000:
        return None
    return {"sheet": match["sheet"], "startCol": start_col, "endCol": end_col, "startRow": start_row, "endRow": end_row}


def _load_module(filename, name, *, package=None):
    spec = importlib.util.spec_from_file_location(name, filename)
    module = importlib.util.module_from_spec(spec)
    if package:
        sys.modules[name] = module
    prior = sys.dont_write_bytecode
    try:
        sys.dont_write_bytecode = True
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            spec.loader.exec_module(module)
    finally:
        sys.dont_write_bytecode = prior
    return module


def _constant(node, assignments=None, stack=()):
    """Read trusted literal settings without executing config.py or its fallbacks."""
    if len(stack) > 20:
        raise ValueError()
    if isinstance(node, ast.Name) and assignments is not None and node.id not in stack and node.id in assignments:
        return _constant(assignments[node.id], assignments, stack + (node.id,))
    if isinstance(node, ast.BinOp) and isinstance(node.op, ast.Add):
        left, right = _constant(node.left, assignments, stack), _constant(node.right, assignments, stack)
        if isinstance(left, str) and isinstance(right, str):
            return left + right
        raise ValueError()
    if isinstance(node, ast.Dict):
        return {_constant(key, assignments, stack): _constant(value, assignments, stack) for key, value in zip(node.keys, node.values)}
    if isinstance(node, (ast.List, ast.Tuple, ast.Set)):
        values = [_constant(value, assignments, stack) for value in node.elts]
        return tuple(values) if isinstance(node, ast.Tuple) else set(values) if isinstance(node, ast.Set) else values
    return ast.literal_eval(node)


def read_config(source_dir):
    try:
        tree = ast.parse((source_dir / "config.py").read_text(encoding="utf-8-sig"))
        settings, assignments = {}, {}
        for node in tree.body:
            target = node.target if isinstance(node, ast.AnnAssign) else node.targets[0] if isinstance(node, ast.Assign) and len(node.targets) == 1 else None
            if isinstance(target, ast.Name):
                assignments[target.id] = node.value
        for name in CONFIG_NAMES:
            if name in assignments:
                settings[name] = _constant(assignments[name], assignments, (name,))
        required = CONFIG_NAMES - {"FEISHU_HOST", "HTTP_HEADERS", "ACCOUNTS_VIEW_ID"}
        if any(name not in settings for name in required):
            raise ValueError()
        if any(not isinstance(settings.get(name), str) or not settings[name].strip() for name in (
                "FEISHU_APP_ID", "FEISHU_APP_SECRET", "ACCOUNTS_TABLE_APP_TOKEN", "ACCOUNTS_TABLE_ID")):
            raise ValueError()
        settings.setdefault("FEISHU_HOST", "https://open.feishu.cn")
        if urlparse(settings["FEISHU_HOST"]).hostname not in ("open.feishu.cn", "open.larksuite.com"):
            raise CheckError("endpoint_not_allowed")
        if type(settings["ANOMALY_MIN_APPOINTMENTS"]) is not int or not 2 <= settings["ANOMALY_MIN_APPOINTMENTS"] <= 100:
            raise ValueError()
        settings["PROJECT_DIR"] = source_dir
        settings["SECRETS_DIR"] = source_dir / "secrets"
        settings["COOKIES_PATH"] = source_dir / "secrets" / "cookies.json"
        settings["TOKEN_PATH"] = source_dir / "secrets" / "app_action_token.json"
        return types.SimpleNamespace(**settings)
    except CheckError:
        raise
    except Exception:
        raise CheckError("configuration_missing") from None


class StrictHttp:
    """Direct, TLS-verified, bounded JSON transport. Only token POST and read GET."""
    def __init__(self, deadline, *, session_factory=None, clock=time.monotonic, sleep=time.sleep):
        if session_factory is None:
            try:
                import requests
                session_factory = requests.Session
            except ImportError:
                raise CheckError("dependency_missing") from None
        self.deadline, self.clock, self.sleep = deadline, clock, sleep
        self.session_factory = session_factory
        self.local = threading.local()
        self.sessions, self.calls = [], 0
        self.guard = threading.Lock()

    def _session(self):
        if not hasattr(self.local, "session"):
            session = self.session_factory()
            session.trust_env = False
            session.verify = True
            if hasattr(session, "proxies"):
                session.proxies.clear()
            with self.guard:
                self.sessions.append(session)
            self.local.session = session
        return self.local.session

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def request(self, method, url, **kwargs):
        try:
            parsed = urlparse(url)
            port = parsed.port
        except (TypeError, ValueError):
            raise CheckError("endpoint_not_allowed") from None
        feishu = parsed.hostname in ("open.feishu.cn", "open.larksuite.com")
        token = feishu and parsed.path == "/open-apis/auth/v3/tenant_access_token/internal"
        allowed_get = method == "GET" and (feishu and parsed.path.startswith(("/open-apis/bitable/v1/", "/open-apis/sheets/"))
            or parsed.hostname == "carriercentral.amazon.com" and parsed.path.endswith("/search/shipmentid"))
        if parsed.scheme != "https" or parsed.username or parsed.password or port not in (None, 443) or not (allowed_get or method == "POST" and token):
            raise CheckError("endpoint_not_allowed")
        for attempt in range(4):
            remaining = self.deadline - self.clock()
            if remaining <= 0:
                raise CheckError("deadline_exceeded")
            with self.guard:
                self.calls += 1
                if self.calls > 50000:
                    raise CheckError("request_limit")
            response = None
            try:
                session = self._session()
                if hasattr(session, "cookies"):
                    session.cookies.clear()
                options = dict(kwargs)
                options.update(timeout=(min(5, remaining), min(15, remaining)), allow_redirects=False, stream=True, verify=True, proxies={})
                response = session.request(method, url, **options)
                status = response.status_code
                if status in (301, 302, 303, 307, 308, 401, 403):
                    raise CheckError("auth_required" if not feishu else "http_error")
                if status == 429 or status >= 500:
                    raise CheckError("http_error")
                if status != 200:
                    raise CheckError("http_error")
                body = bytearray()
                for chunk in response.iter_content(chunk_size=65536):
                    if self.clock() >= self.deadline:
                        raise CheckError("deadline_exceeded")
                    body.extend(chunk)
                    if len(body) > 8 * 1024 * 1024:
                        raise CheckError("response_too_large")
                try:
                    payload = json.loads(body.decode("utf-8-sig"))
                except (ValueError, UnicodeError):
                    raise CheckError("response_invalid") from None
                if feishu and (not isinstance(payload, dict) or type(payload.get("code")) is not int or payload["code"] != 0):
                    raise CheckError("response_invalid")
                if feishu:
                    data = payload.get("data")
                    if token:
                        valid = isinstance(payload.get("tenant_access_token"), str) and bool(payload["tenant_access_token"])
                    elif parsed.path.endswith("/records"):
                        valid = isinstance(data, dict) and isinstance(data.get("items"), list)
                        valid = valid and (not data.get("has_more") or isinstance(data.get("page_token"), str) and bool(data["page_token"]))
                    elif parsed.path.endswith("/sheets/query"):
                        valid = isinstance(data, dict) and isinstance(data.get("sheets"), list)
                    elif "/values/" in parsed.path:
                        value_range = data.get("valueRange") if isinstance(data, dict) else None
                        returned_range = parse_cell_range(value_range.get("range"), require_sheet=True) if isinstance(value_range, dict) else None
                        requested_sheet = unquote(parsed.path.split("/values/", 1)[1]).split("!", 1)[0]
                        valid = returned_range is not None and returned_range["sheet"] == requested_sheet and "values" in value_range and isinstance(value_range["values"], list)
                        valid = valid and all(isinstance(row, list) for row in value_range["values"])
                    else:
                        valid = isinstance(data, dict)
                    if not valid:
                        raise CheckError("response_invalid")
                return types.SimpleNamespace(status_code=status, json=lambda: payload, raise_for_status=lambda: None)
            except CheckError as error:
                retry = error.code in ("network_failed", "http_error", "response_invalid")
                if not retry or attempt == 3:
                    raise
            except Exception:
                if attempt == 3:
                    raise CheckError("network_failed") from None
            finally:
                if response is not None:
                    response.close()
                if hasattr(self.local, "session") and hasattr(self.local.session, "cookies"):
                    self.local.session.cookies.clear()
            remaining = self.deadline - self.clock()
            if remaining <= 0:
                raise CheckError("deadline_exceeded")
            self.sleep(min(0.5 * (attempt + 1), remaining))
        raise CheckError("network_failed")

    def close(self):
        for session in self.sessions:
            session.close()


def load_bundle(source_dir, deadline):
    if not all((source_dir / name).is_file() for name in SOURCE_FILES):
        raise CheckError("source_unavailable")
    config = read_config(source_dir)
    name = "_pi_po_duplicate_" + uuid.uuid4().hex
    package = types.ModuleType(name)
    package.__path__ = [str(source_dir)]
    sys.modules[name] = package
    config_module = types.ModuleType(name + ".config")
    config_module.__dict__.update(vars(config))
    sys.modules[config_module.__name__] = config_module
    modules = {}
    http = StrictHttp(deadline)
    try:
        for filename in ("exceptions.py", "feishu_base.py", "feishu_sheets.py", "sheets_reader.py"):
            key = filename[:-3]
            modules[key] = _load_module(source_dir / filename, name + "." + key, package=name)
        modules["feishu_base"].requests = http
        modules["feishu_sheets"]._make_session = lambda: http
        base = modules["feishu_base"].FeishuBaseClient(config.FEISHU_APP_ID, config.FEISHU_APP_SECRET,
            host=config.FEISHU_HOST, app_token=config.ACCOUNTS_TABLE_APP_TOKEN, table_id=config.ACCOUNTS_TABLE_ID)
        sheets = modules["feishu_sheets"].FeishuSheetsClient(config.FEISHU_APP_ID, config.FEISHU_APP_SECRET, host=config.FEISHU_HOST)
        login = _load_module(Path(__file__).with_name("login.py"), name + "_login")
        ERROR_LABELS.update(login.ERROR_LABELS)
        return {"config": config, "base": base, "sheets": sheets, "reader": modules["sheets_reader"],
            "login": login.refresh_account_session, "lookup": lambda cookies, fba: lookup_appointments(http, config, cookies, fba), "http": http}
    except Exception:
        http.close()
        raise CheckError("source_load_failed") from None


def lookup_appointments(http, config, cookies, fba):
    headers = {str(key): value for key, value in getattr(config, "HTTP_HEADERS", {}).items()
        if str(key).lower() in ("accept", "accept-language", "user-agent", "origin", "referer", "content-type", "x-requested-with", "priority")}
    headers["referer"] = "https://carriercentral.amazon.com/search"
    payload = http.get(config.SEARCH_SHIPMENTID_URL,
        params={"type": config.SEARCH_TYPE_PRO, "id": fba}, cookies=cookies, headers=headers).json()
    appointments = payload if isinstance(payload, list) else payload.get("data") if isinstance(payload, dict) else None
    if not isinstance(appointments, list):
        raise CheckError("response_invalid")
    for item in appointments:
        if not isinstance(item, dict) or not isinstance(item.get("appointmentStatus"), str) or not item["appointmentStatus"].strip():
            raise CheckError("response_invalid")
        if not safe_text(item.get("appointmentReferenceCode")):
            raise CheckError("response_invalid")
    return appointments


def new_report(run_id):
    return {"schemaVersion": 1, "taskType": "po-duplicate-check", "runId": validate_run_id(run_id), "status": "failed",
        "complete": False, "businessOutcome": "failed", "startedAt": now_iso(), "finishedAt": None, "timezone": "Asia/Shanghai",
        "execution": {"loginMode": "browser-refresh", "loginBrowser": "chromium-drissionpage", "queryTransport": "python-requests", "networkMode": "direct"},
        "notification": "pi-only", "counts": {key: 0 for key in ("accounts", "accountsReady", "accountsFailed", "accountsSkipped", "schemas", "schemasRead",
            "monthsMissing", "sheetsRead", "rowsSelected", "rows", "rowsComplete", "rowsFailed", "queryPairsExpected", "queryPairsSucceeded", "queryPairsFailed", "queryPairsSkipped",
            "appointmentsReturned", "appointmentsEffective", "appointmentsIgnored", "duplicateRows", "duplicateAccountPairs")},
        "sources": [], "records": [], "findings": [], "failures": [], "summary": "检查尚未完成。"}


def add_failure(report, stage, code, **fields):
    record = {"stage": stage, "code": safe_text(code, 80) or "check_failed"}
    record.update({key: safe_text(value) for key, value in fields.items() if key in ("carrier", "schema", "sheetId", "fba")})
    if len(report["failures"]) < 1000:
        report["failures"].append(record)
    report["failureCount"] = report.get("failureCount", 0) + 1


def normalize_accounts(records, config, report):
    if not isinstance(records, list) or not records:
        raise CheckError("no_accounts")
    if len(records) > 1000:
        raise CheckError("request_limit")
    report["counts"]["accounts"] = len(records)
    normalized, ports = [], set()
    for index, row in enumerate(records, 1):
        fields = row.get("fields") if isinstance(row, dict) else None
        fields = fields if isinstance(fields, dict) else {}
        email = fields.get(config.ACCOUNTS_FIELD_EMAIL)
        email = email.get("text") if isinstance(email, dict) else email
        password = fields.get(config.ACCOUNTS_FIELD_PASSWORD)
        raw_port = fields.get(config.ACCOUNTS_FIELD_PORT)
        port = str(raw_port).strip() if raw_port is not None and not isinstance(raw_port, bool) else ""
        carrier = safe_text(fields.get(config.ACCOUNTS_FIELD_NAME)) or "承运人#" + str(index)
        if not isinstance(email, str) or not email.strip() or not isinstance(password, str) or not password or not port.isdigit() or not 1 <= int(port) <= 65535:
            report["counts"]["accountsFailed"] += 1
            add_failure(report, "accounts", "account_invalid", carrier=carrier)
            continue
        if port in ports:
            report["counts"]["accountsFailed"] += 1
            add_failure(report, "accounts", "duplicate_port", carrier=carrier)
            continue
        ports.add(port)
        normalized.append({"加约存档": carrier, "邮箱": email, "密码": password, "浏览器端口": port})
    if not normalized:
        raise CheckError("no_accounts")
    return normalized


class CompleteWidthSheetReader:
    """Read-only view preserving empty trailing columns used by extra filters.

    Feishu omits empty trailing cells. The original loader pads only its base
    columns, letting a missing extra-filter column fall through. Padding to the
    actual requested width makes an absent Q value blank, so Q=YES rejects it.
    """
    def __init__(self, client):
        self.client = client

    def list_sheets(self, *args, **kwargs):
        return self.client.list_sheets(*args, **kwargs)

    def get_last_data_row(self, *args, **kwargs):
        return self.client.get_last_data_row(*args, **kwargs)

    def read_values(self, range_, **kwargs):
        requested = parse_cell_range(range_)
        if not requested:
            raise CheckError("rows_invalid")
        result = self.client.read_values(range_, **kwargs)
        values = result.get("values") if isinstance(result, dict) else None
        if not isinstance(values, list) or any(not isinstance(row, list) for row in values):
            raise CheckError("rows_invalid")
        width = requested["endCol"] - requested["startCol"] + 1
        return {**result, "values": [list(row) + [""] * max(0, width - len(row)) for row in values]}


def select_targets(bundle, report, *, today=None, log=print):
    config, reader, client = bundle["config"], bundle["reader"], CompleteWidthSheetReader(bundle["sheets"])
    schemas = config.SHEET_SCHEMAS
    if not isinstance(schemas, list) or not schemas:
        raise CheckError("no_schemas")
    today = today or datetime.now(CST).date()
    class BusinessDate(date):
        @classmethod
        def today(cls):
            return today
    original_date = reader.date
    reader.date = BusinessDate
    unique = {}
    try:
        for index, schema in enumerate(schemas, 1):
            report["counts"]["schemas"] += 1
            label = safe_text(schema.get("name")) if isinstance(schema, dict) else ""
            try:
                resolved = reader.resolve_monthly_sheets(schema, client, today=today)
                missing = resolved.get("missing", [])
                report["counts"]["monthsMissing"] += len(missing)
                if missing:
                    add_failure(report, "sheets", "months_missing", schema=label)
                source = {"schema": label, "months": [safe_text(value) for value in resolved.get("picked", [])], "missing": [safe_text(value) for value in missing], "sheetsRead": 0}
                report["sources"].append(source)
                for sheet_id in resolved["sheet_ids"]:
                    try:
                        rows = reader.load_rows(schema, sheets_client=client, sheet_ids=[sheet_id])
                        if not isinstance(rows, list):
                            raise CheckError("rows_invalid")
                        source["sheetsRead"] += 1
                        report["counts"]["sheetsRead"] += 1
                        report["counts"]["rowsSelected"] += len(rows)
                        for row in rows:
                            if not isinstance(row, dict) or not safe_text(row.get("FBA号")) or type(row.get("源行号")) is not int:
                                raise CheckError("rows_invalid")
                            # The source omitted sheet_id, merging identical row
                            # numbers/FBA across two monthly sheets. Keep both.
                            key = (label, str(sheet_id), row["源行号"], row["FBA号"])
                            unique.setdefault(key, {"schema": label, "sheetId": safe_text(sheet_id), "sourceRow": row["源行号"],
                                "container": safe_text(row.get("柜号")), "customer": safe_text(row.get("客户")), "warehouse": safe_text(row.get("目的仓")),
                                "fba": safe_text(row["FBA号"]), "receivedDate": safe_text(row.get("收货日期")), "details": {}, "errors": {}, "duplicateAccounts": []})
                            if len(unique) > 20000:
                                raise CheckError("request_limit")
                    except Exception as error:
                        add_failure(report, "sheets", error.code if isinstance(error, CheckError) else "sheets_read_failed", schema=label, sheetId=sheet_id)
                report["counts"]["schemasRead"] += 1
                log(f"[po-duplicate] 业务表 {index}/{len(schemas)} 已读取，缺失月份 {len(missing)} 个。", flush=True)
            except Exception as error:
                add_failure(report, "sheets", error.code if isinstance(error, CheckError) else "sheets_read_failed", schema=label)
    finally:
        reader.date = original_date
    report["records"] = list(unique.values())
    report["counts"]["rows"] = len(unique)
    return report["records"]


def appointment_view(item):
    return {key: safe_text(item.get(key)) for key in ("fc", "appointmentReferenceCode", "appointmentStatus")}


def collect(report, bundle, sessions, deadline, *, clock=time.monotonic, max_workers=4, log=print):
    records, counts = report["records"], report["counts"]
    expected = len(records) * len(sessions)
    account_count = max(counts["accounts"], len(sessions))
    counts["queryPairsExpected"] = len(records) * account_count
    counts["queryPairsSkipped"] = len(records) * (account_count - len(sessions))
    if expected > 20000:
        raise CheckError("request_limit")
    threshold = bundle["config"].ANOMALY_MIN_APPOINTMENTS
    report["duplicateThreshold"] = threshold
    pending = {}
    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        for index, record in enumerate(records):
            for port, session in sessions.items():
                if clock() >= deadline:
                    raise CheckError("deadline_exceeded")
                pending[executor.submit(bundle["lookup"], session["cookies"], record["fba"])] = (index, port)
        completed = 0
        for future in as_completed(pending):
            index, port = pending[future]
            record, carrier = records[index], sessions[port]["carrier"]
            try:
                appointments = future.result()
                if clock() >= deadline:
                    raise CheckError("deadline_exceeded")
                if not isinstance(appointments, list) or any(not isinstance(value, dict) for value in appointments):
                    raise CheckError("response_invalid")
                visible = [appointment_view(value) for value in appointments]
                active = [value for value in visible if value["appointmentStatus"] not in IGNORED_STATUSES]
                record["details"][port] = {"carrier": carrier, "appointments": visible, "effectiveCount": len(active)}
                counts["queryPairsSucceeded"] += 1
                counts["appointmentsReturned"] += len(visible)
                counts["appointmentsEffective"] += len(active)
                counts["appointmentsIgnored"] += len(visible) - len(active)
                if len(active) >= threshold:
                    record["duplicateAccounts"].append(port)
                    counts["duplicateAccountPairs"] += 1
                    report["findings"].append({"schema": record["schema"], "sheetId": record["sheetId"], "sourceRow": record["sourceRow"],
                        "container": record["container"], "customer": record["customer"], "warehouse": record["warehouse"], "fba": record["fba"],
                        "carrier": carrier, "port": port, "effectiveCount": len(active), "appointments": active})
            except Exception as error:
                code = error.code if isinstance(error, CheckError) else "query_failed"
                record["errors"][port] = code
                counts["queryPairsFailed"] += 1
                add_failure(report, "query", code, carrier=carrier, schema=record["schema"], sheetId=record["sheetId"], fba=record["fba"])
            completed += 1
            if completed == expected or completed % max(1, expected // 20) == 0:
                log(f"[po-duplicate] 预约查询进度 {completed}/{expected}，成功 {counts['queryPairsSucceeded']}，失败 {counts['queryPairsFailed']}。", flush=True)
    counts["duplicateRows"] = sum(bool(row["duplicateAccounts"]) for row in records)
    counts["rowsComplete"] = sum(not row["errors"] and len(row["details"]) == account_count for row in records)
    counts["rowsFailed"] = len(records) - counts["rowsComplete"]


def summarize(report):
    counts = report["counts"]
    if report["status"] == "failed":
        lead = "本次检查未能完成，不能判定是否存在重复预约。"
    elif report["status"] == "partial":
        lead = "本次检查不完整，已有结果如下；未检查部分不能判定正常。"
    elif not counts["rows"]:
        lead = "业务表读取完成，没有符合筛选条件的 FBA；本轮未发起预约查询。"
    elif counts["duplicateRows"]:
        lead = "检查完成，发现同一承运人下的 FBA 关联多个有效预约。"
    else:
        lead = "检查完成，未发现同一承运人下的重复有效预约。"
    lines = [lead, f"承运人 {counts['accounts']} 个，登录刷新成功 {counts['accountsReady']} 个，失败 {counts['accountsFailed']} 个。",
        f"业务来源 FBA {counts['rows']} 条；查询成功 {counts['queryPairsSucceeded']} 次，失败 {counts['queryPairsFailed']} 次，因账号不可用未查 {counts['queryPairsSkipped']} 次。",
        f"重复 FBA 来源行 {counts['duplicateRows']} 条，异常承运人查询 {counts['duplicateAccountPairs']} 次。",
        f"有效预约命中 {counts['appointmentsEffective']} 次（按来源行和账号累计），已关闭、已删除或已取消预约跳过 {counts['appointmentsIgnored']} 次。",
        f"检查时间（北京时间）：{report['finishedAt']}"]
    if counts["monthsMissing"]:
        lines.append(f"缺少必需月份工作表 {counts['monthsMissing']} 个。")
    if report["failures"]:
        reasons = list(dict.fromkeys(ERROR_LABELS.get(item["code"], "检查失败，请查看管理员运行记录") for item in report["failures"]))
        lines.append("未完成原因：" + "；".join(reasons[:6]) + "。")
    if report["findings"]:
        lines.extend(("", "重复预约明细：", "| FBA | 承运人 | 有效预约数 | 预约号 | 来源行 |", "| --- | --- | ---: | --- | --- |"))
        for finding in report["findings"][:12]:
            cell = lambda value: safe_text(value, 160).replace("|", "\\|")
            refs = ", ".join(item["appointmentReferenceCode"] for item in finding["appointments"][:8])
            lines.append(f"| {cell(finding['fba'])} | {cell(finding['carrier'])} | {finding['effectiveCount']} | {cell(refs)} | {cell(finding['schema'])} / R{finding['sourceRow']} |")
        if len(report["findings"]) > 12:
            lines.append(f"另有 {len(report['findings']) - 12} 条异常，请查询本次完整运行报告。")
    summary = "\n".join(lines)
    while len(summary.encode("utf-8")) > MAX_SUMMARY_BYTES:
        lines.pop()
        summary = "\n".join(lines)
    return summary


def write_attention(output_dir, run_id, notice):
    carrier = re.sub(r"[^\w .-]", "", safe_text(notice.get("carrier"), 48)).strip(" ._-") or "承运人"
    event = {"schemaVersion": 1, "runId": validate_run_id(run_id), "status": "waiting_human", "kind": "verification_required",
        "carrier": carrier, "browser": "Chromium", "createdAt": now_iso(), "message": "请管理员完成该承运人专属 Chromium 窗口中的验证码或二次验证，完成后自动继续。"}
    atomic_json(output_dir / (run_id + ".attention.json"), event)


def perform_check(registration, run_id, *, bundle_loader=load_bundle, lock_factory=None, clock=time.monotonic, today=None, log=print):
    report = new_report(run_id)
    deadline = clock() + min(3300, max(30, int(registration.get("maxTotalSeconds", 3000))))
    bundle = None
    try:
        if registration.get("networkMode", "direct") != "direct":
            raise CheckError("network_mode_invalid")
        if lock_factory is None:
            lock = _load_module(Path(__file__).parent.parent / "amazon_browser_lock.py", "po_duplicate_browser_lock")
            lock_factory = lambda until: lock.exclusive_browser_lock(lock.DEFAULT_LOCK_PATH, until, log=log)
        log("[po-duplicate] 开始只读检查，先等待专属浏览器，再读取业务表、刷新登录和查询预约。", flush=True)
        with lock_factory(deadline):
            bundle = bundle_loader(Path(registration["sourceDir"]).resolve(), deadline)
            config = bundle["config"]
            try:
                records = bundle["base"].list_records(view_id=getattr(config, "ACCOUNTS_VIEW_ID", None), limit=1001)
            except Exception:
                raise CheckError("accounts_load_failed") from None
            accounts = normalize_accounts(records, config, report)
            log(f"[po-duplicate] 承运人配置已读取，共 {report['counts']['accounts']} 个，配置可用 {len(accounts)} 个。", flush=True)
            rows = select_targets(bundle, report, today=today, log=log)
            sessions = {}
            if rows:
                for index, account in enumerate(accounts, 1):
                    carrier = account["加约存档"]
                    log(f"[po-duplicate] 刷新承运人登录 {index}/{len(accounts)}。", flush=True)
                    try:
                        refreshed = bundle["login"](account, config, deadline,
                            on_attention=lambda notice: write_attention(Path(registration["outputDir"]), run_id, notice),
                            on_progress=login_progress_logger(log, index, len(accounts)),
                            login_timeout=min(900, max(1, int(registration.get("loginTimeoutSeconds", 600)))))
                        cookies = refreshed.get("cookies")
                        if not isinstance(cookies, dict) or not cookies:
                            raise CheckError("login_failed")
                        sessions[account["浏览器端口"]] = {"cookies": cookies, "carrier": carrier}
                        report["counts"]["accountsReady"] += 1
                    except Exception as error:
                        report["counts"]["accountsFailed"] += 1
                        code = getattr(error, "code", "login_failed")
                        add_failure(report, "login", code if isinstance(code, str) else "login_failed", carrier=carrier)
                if not sessions:
                    raise CheckError("login_failed")
                collect(report, bundle, sessions, deadline, clock=clock,
                    max_workers=min(8, max(1, int(registration.get("maxWorkers", 4)))), log=log)
            else:
                report["counts"]["accountsSkipped"] = len(accounts)
                log("[po-duplicate] 没有符合条件的 FBA，未发起登录或预约查询。", flush=True)
            complete = report.get("failureCount", 0) == 0
            report["status"] = "completed" if complete else "partial" if report["counts"]["schemasRead"] or report["counts"]["queryPairsSucceeded"] else "failed"
            report["complete"] = complete
            report["businessOutcome"] = "no_targets" if complete and not rows else "duplicates_found" if report["findings"] else "normal" if complete else "incomplete"
    except Exception as error:
        code = getattr(error, "code", "check_failed")
        add_failure(report, "check", code if isinstance(code, str) else "check_failed")
        report["status"] = "partial" if report["counts"]["queryPairsSucceeded"] else "failed"
        report["businessOutcome"] = "incomplete" if report["status"] == "partial" else "failed"
    finally:
        if bundle and bundle.get("http"):
            bundle["http"].close()
    report["finishedAt"] = now_iso()
    report["summary"] = summarize(report)
    log(f"[po-duplicate] 本次检查结束：{report['status']}；重复来源行 {report['counts']['duplicateRows']}，失败查询 {report['counts']['queryPairsFailed']}。", flush=True)
    return report


def atomic_json(destination, value):
    destination.parent.mkdir(parents=True, exist_ok=True)
    temp = destination.parent / ("." + destination.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temp.open("x", encoding="utf-8") as handle:
            json.dump(value, handle, ensure_ascii=False, allow_nan=False)
            handle.flush()
        os.replace(temp, destination)
    finally:
        temp.unlink(missing_ok=True)


def persist_report(output_dir, report):
    # Counts always describe all processed records. Bounded report details state
    # their omissions explicitly instead of silently rewriting business totals.
    value = json.loads(json.dumps(report, ensure_ascii=False, allow_nan=False))
    for name in ("records", "findings", "failures"):
        if len(value[name]) > 1000:
            value.setdefault("omittedDetails", {})[name] = len(value[name]) - 1000
            value[name] = value[name][:1000]
    while len(json.dumps(value, ensure_ascii=False, allow_nan=False).encode("utf-8")) > 900000:
        name = max(("records", "findings", "failures"), key=lambda key: len(value[key]))
        if not value[name]:
            raise CheckError("result_too_large")
        value[name].pop()
        value.setdefault("omittedDetails", {})[name] = value.get("omittedDetails", {}).get(name, 0) + 1
    destination = output_dir / (validate_run_id(value["runId"]) + ".json")
    if destination.exists():
        raise CheckError("run_id_already_exists")
    atomic_json(destination, value)
    atomic_json(output_dir / "latest.json", value)
    return destination


def read_result(output_dir, run_id=None):
    file = output_dir / ((validate_run_id(run_id) + ".json") if run_id else "latest.json")
    if not file.is_file():
        return {"schemaVersion": 1, "status": "not_found" if run_id else "not_run", "summary": "未找到本次运行记录。" if run_id else "尚无运行记录。"}
    if file.is_symlink() or file.stat().st_size > MAX_REPORT_BYTES:
        raise CheckError("result_invalid")
    try:
        value = json.loads(file.read_text(encoding="utf-8"))
        if not isinstance(value, dict) or value.get("schemaVersion") != 1 or value.get("status") not in ("completed", "partial", "failed") or run_id and value.get("runId") != run_id:
            raise ValueError()
        return value
    except Exception:
        raise CheckError("result_invalid") from None


def preflight(registration):
    source = Path(registration["sourceDir"])
    checks = {"python310OrNewer": sys.version_info >= (3, 10), "networkModeValid": registration.get("networkMode", "direct") == "direct",
        "sourceFilesPresent": all((source / name).is_file() for name in SOURCE_FILES), "sourceSyntaxValid": True,
        "literalConfigurationValid": False, "requestsInstalled": importlib.util.find_spec("requests") is not None,
        "browserDependencyInstalled": importlib.util.find_spec("DrissionPage") is not None, "profileInspectorInstalled": importlib.util.find_spec("psutil") is not None,
        "loginAdapterPresent": Path(__file__).with_name("login.py").is_file(), "sharedBrowserLockPresent": (Path(__file__).parent.parent / "amazon_browser_lock.py").is_file()}
    if checks["sourceFilesPresent"]:
        try:
            for name in SOURCE_FILES:
                ast.parse((source / name).read_text(encoding="utf-8-sig"))
            read_config(source)
            checks["literalConfigurationValid"] = True
        except (SyntaxError, UnicodeError, OSError):
            checks["sourceSyntaxValid"] = False
        except CheckError:
            pass
    else:
        checks["sourceSyntaxValid"] = False
    ready = all(checks.values())
    return {"schemaVersion": 1, "status": "ready" if ready else "blocked", "checks": checks, "businessNetworkUsed": False,
        "summary": "静态预检通过；未访问业务网络，尚未验证账号和业务数据。" if ready else "静态预检未通过；未访问业务网络。"}


def main(argv=None):
    for stream in (sys.stdout, sys.stderr):
        if hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="Pi managed read-only duplicate appointment check")
    parser.add_argument("registration")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--check", action="store_true")
    mode.add_argument("--latest", action="store_true")
    mode.add_argument("--result")
    args = parser.parse_args(argv)
    try:
        registration_file = Path(args.registration)
        if registration_file.stat().st_size > 65536:
            raise CheckError("registration_invalid")
        registration = json.loads(registration_file.read_text(encoding="utf-8-sig"))
        if not isinstance(registration, dict) or any(not isinstance(registration.get(key), str) or not Path(registration[key]).is_absolute() for key in ("sourceDir", "outputDir")):
            raise CheckError("registration_invalid")
        output_dir = Path(registration["outputDir"]).resolve()
        if args.preflight:
            result = preflight(registration)
        elif args.latest or args.result:
            result = read_result(output_dir, args.result)
        else:
            run_id = validate_run_id(os.environ.get("PI_BUSINESS_RUN_ID") or os.environ.get("RPAC_EXECUTION_ID") or str(uuid.uuid4()))
            if (output_dir / (run_id + ".json")).exists():
                raise CheckError("run_id_already_exists")
            result = perform_check(registration, run_id)
            persist_report(output_dir, result)
            result = read_result(output_dir, run_id)
        print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
        return 0 if result["status"] in ("ready", "completed", "not_run") else 3 if result["status"] == "not_found" else 2
    except Exception as error:
        code = getattr(error, "code", "check_failed")
        print(json.dumps({"schemaVersion": 1, "status": "failed", "code": code, "summary": ERROR_LABELS.get(code, "任务处理失败，请查看管理员运行记录。")}, ensure_ascii=False), flush=True)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
