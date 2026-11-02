"""Unattended UnitCount checks. Original business source is loaded, never changed."""
from __future__ import annotations

import argparse
import ast
import contextlib
import html
import importlib.util
import io
import json
import math
import os
from pathlib import Path
import re
import sys
import time
import types
import uuid
from datetime import datetime, timedelta, timezone
from urllib.parse import urlparse


CST = timezone(timedelta(hours=8))
TARGET_STATUSES = {"ARRIVAL_SCHEDULED", "PENDING_SCHEDULE"}
REQUIRED_FILES = ("config.py", "feishu_base.py", "search.py", "time_window.py")
RUN_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
INIT_PATTERNS = (
    re.compile(r'''data-ng-init=['"]Init\(\s*'(.+?)'\s*,''', re.DOTALL),
    re.compile(r'''data-ng-init=['"]Init\(\s*&#39;(.+?)&#39;\s*,''', re.DOTALL),
)
ERROR_LABELS = {
    "auth_required": "Amazon 登录或访问校验未通过，不能仅据此判定登录过期",
    "cookies_missing": "缺少已保存的登录状态",
    "cookies_invalid": "已保存的登录状态文件无效",
    "unit_count_invalid": "件数缺失或不是有效数字",
    "shipments_missing": "预约下缺少可检查的 shipment",
    "detail_parse_failed": "预约详情无法解析",
    "detail_failed": "预约详情检查失败",
    "search_failed": "预约搜索失败",
    "search_schema_invalid": "预约搜索结果格式无效",
    "appointment_fields_invalid": "预约关键字段缺失或无效",
    "appointment_status_missing": "预约状态缺失",
    "carrier_record_invalid": "承运人配置无效",
    "carrier_check_failed": "承运人检查失败",
    "carriers_load_failed": "读取飞书承运人失败",
    "no_carriers": "飞书没有可用的承运人记录",
    "configuration_missing": "原程序必需配置缺失",
    "source_unavailable": "原程序源码不存在或不完整",
    "source_load_failed": "原程序客户端加载失败",
    "dependency_missing": "Python 依赖未安装",
    "endpoint_not_allowed": "请求地址不在允许的官方域名内",
    "deadline_exceeded": "超过本次检查时限",
    "network_failed": "业务网络请求失败",
    "http_error": "业务接口返回错误状态",
    "response_too_large": "业务响应超过大小限制",
    "request_limit": "本次请求次数超过限制",
    "carrier_limit": "承运人数量超过本次处理上限",
    "notification_configuration_missing": "企业微信通知配置缺失",
    "notification_failed": "企业微信通知失败",
    "check_already_running": "已有 UnitCount 检查正在运行，请稍后查看结果",
    "browser_busy": "Amazon 专属浏览器正由其他检查使用，本次等待已超时",
    "browser_lock_unavailable": "Amazon 浏览器互斥模块未能加载",
    "network_mode_invalid": "网络模式配置无效",
    "login_mode_invalid": "登录流程配置无效",
    "check_failed": "检查未能完成",
}


class CheckError(Exception):
    """Only a fixed, safe error code may cross the business-client boundary."""
    def __init__(self, code):
        self.code = code
        super().__init__(code)


def now_iso():
    return datetime.now(CST).isoformat(timespec="seconds")


@contextlib.contextmanager
def shared_browser_lock(deadline, log=print):
    """Coordinate the full check with other Carrier Central business programs."""
    path = Path(__file__).resolve().parent.parent / "amazon_browser_lock.py"
    try:
        spec = importlib.util.spec_from_file_location("unit_count_shared_browser_lock", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
    except Exception:
        raise CheckError("browser_lock_unavailable") from None
    try:
        with module.exclusive_browser_lock(module.DEFAULT_LOCK_PATH, deadline, log):
            yield
    except module.BrowserBusyError:
        raise CheckError("browser_busy") from None


@contextlib.contextmanager
def exclusive_check_lock(output_dir):
    """Kernel-backed nonblocking lock; process termination releases it automatically."""
    output_dir.mkdir(parents=True, exist_ok=True)
    handle = (output_dir / ".unit-count.lock").open("a+b")
    acquired = False
    try:
        if os.name == "nt":
            import msvcrt
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"0")
                handle.flush()
            handle.seek(0)
            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError:
                raise CheckError("check_already_running") from None
        else:
            import fcntl
            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError:
                raise CheckError("check_already_running") from None
        acquired = True
        yield
    finally:
        if acquired:
            if os.name == "nt":
                import msvcrt
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)
        handle.close()


def safe_text(value, limit=100):
    if not isinstance(value, (str, int)) or isinstance(value, bool):
        return ""
    return re.sub(r"[\x00-\x1f\x7f]", "", str(value)).strip()[:limit]


def numeric(value):
    return (type(value) is int and value >= 0) or (
        type(value) is float and math.isfinite(value) and value >= 0)


def extract_appointment(source):
    for pattern in INIT_PATTERNS:
        match = pattern.search(source)
        if match:
            try:
                result = json.loads(html.unescape(match.group(1)))
                return result if isinstance(result, dict) else None
            except (TypeError, ValueError):
                return None
    return None


def inspect_shipments(appointment):
    """Return exact numeric zeroes and invalid fields; missing data is never OK."""
    shipments = appointment.get("shipments") if isinstance(appointment, dict) else None
    if not isinstance(shipments, list) or not shipments:
        return {"shipments": 0, "zeros": [], "invalid": 0, "error": "shipments_missing"}
    zeros = []
    invalid = 0
    for shipment in shipments:
        info = shipment.get("shipmentCountInfo") if isinstance(shipment, dict) else None
        value = info.get("unitCount") if isinstance(info, dict) else None
        if not numeric(value):
            invalid += 1
            continue
        if value == 0:
            item = {"unitCount": value}
            for key in ("progressiveNumber", "shipmentId"):
                item[key] = safe_text(shipment.get(key))
            for key in ("palletCount", "cartonCount"):
                if numeric(info.get(key)):
                    item[key] = info[key]
            zeros.append(item)
    return {"shipments": len(shipments), "zeros": zeros, "invalid": invalid,
            "error": "unit_count_invalid" if invalid else None}


class BoundedHttp:
    """Requests facade for original clients: limits, no auth redirects, no raw errors."""
    def __init__(self, requests_module, deadline, allowed_hosts):
        self.requests = requests_module
        self.deadline = deadline
        self.allowed_hosts = set(allowed_hosts)
        self.calls = 0

    def get(self, url, **kwargs):
        return self.request("GET", url, **kwargs)

    def post(self, url, **kwargs):
        return self.request("POST", url, **kwargs)

    def request(self, method, url, **kwargs):
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname not in self.allowed_hosts:
            raise CheckError("endpoint_not_allowed")
        self.calls += 1
        if self.calls > 20000:
            raise CheckError("request_limit")
        for attempt in range(2):
            remaining = self.deadline - time.monotonic()
            if remaining <= 2:
                raise CheckError("deadline_exceeded")
            kwargs["timeout"] = (min(8, remaining), min(20, remaining))
            kwargs["allow_redirects"] = False
            kwargs["stream"] = True
            try:
                response = self.requests.request(method, url, **kwargs)
                if response.status_code in (301, 302, 303, 307, 308, 401, 403):
                    response.close()
                    raise CheckError("auth_required")
                if response.status_code in (429, 502, 503, 504) and attempt == 0:
                    response.close()
                    time.sleep(min(1, max(0, remaining - 2)))
                    continue
                content = bytearray()
                try:
                    for chunk in response.iter_content(chunk_size=65536):
                        if time.monotonic() >= self.deadline:
                            raise CheckError("deadline_exceeded")
                        content.extend(chunk)
                        if len(content) > 8 * 1024 * 1024:
                            raise CheckError("response_too_large")
                    response._content = bytes(content)
                    response._content_consumed = True
                finally:
                    response.close()
                if response.status_code >= 400:
                    raise CheckError("http_error")
                if parsed.hostname == "carriercentral.amazon.com":
                    sample = bytes(content[:50000]).lower()
                    if b"ap/signin" in sample or b'name="password"' in sample or b"authportal" in sample:
                        raise CheckError("auth_required")
                return response
            except CheckError:
                raise
            except Exception:
                if attempt == 0 and self.deadline - time.monotonic() > 3:
                    time.sleep(1)
                    continue
                raise CheckError("network_failed") from None
        raise CheckError("network_failed")


def load_original(source_dir, deadline, network_mode="system"):
    """Load only read-only clients. auth/backup/notify are deliberately not imported."""
    if network_mode not in ("system", "direct"):
        raise CheckError("network_mode_invalid")
    if not all((source_dir / name).is_file() for name in REQUIRED_FILES):
        raise CheckError("source_unavailable")
    try:
        import requests
    except ImportError:
        raise CheckError("dependency_missing") from None
    package_name = "_pi_unit_count_source_" + uuid.uuid4().hex
    package = types.ModuleType(package_name)
    package.__path__ = [str(source_dir)]
    sys.modules[package_name] = package
    modules = {}
    for filename in ("config.py", "time_window.py", "feishu_base.py", "search.py"):
        name = filename[:-3]
        spec = importlib.util.spec_from_file_location(package_name + "." + name, source_dir / filename)
        module = importlib.util.module_from_spec(spec)
        sys.modules[spec.name] = module
        prior_bytecode_setting = sys.dont_write_bytecode
        try:
            sys.dont_write_bytecode = True
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                spec.loader.exec_module(module)
        except Exception:
            raise CheckError("source_load_failed") from None
        finally:
            sys.dont_write_bytecode = prior_bytecode_setting
        modules[name] = module
    config = modules["config"]
    required = ("FEISHU_APP_ID", "FEISHU_APP_SECRET", "BITABLE_APP_TOKEN", "BITABLE_TABLE_ID")
    if any(not getattr(config, field, None) for field in required):
        raise CheckError("configuration_missing")
    host = urlparse(getattr(config, "FEISHU_HOST", "https://open.feishu.cn")).hostname
    if host not in ("open.feishu.cn", "open.larksuite.com"):
        raise CheckError("endpoint_not_allowed")
    transport = requests
    if network_mode == "direct":
        # This task alone may opt out of environment/Windows proxy discovery.
        # TLS verification remains enabled; no global environment or proxy is changed.
        transport = requests.Session()
        transport.trust_env = False
        transport.verify = True
    http = BoundedHttp(transport, deadline, {host, "carriercentral.amazon.com", "qyapi.weixin.qq.com"})
    modules["search"].requests = http
    modules["feishu_base"].requests = http
    modules["http"] = http
    return modules


def load_carrier_records(modules):
    config = modules["config"]
    client = modules["feishu_base"].FeishuBaseClient(
        app_id=config.FEISHU_APP_ID, app_secret=config.FEISHU_APP_SECRET,
        host=config.FEISHU_HOST, app_token=config.BITABLE_APP_TOKEN,
        table_id=config.BITABLE_TABLE_ID)
    try:
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
            records = client.list_records()
    except CheckError:
        raise
    except Exception:
        raise CheckError("carriers_load_failed") from None
    if not isinstance(records, list) or not records:
        raise CheckError("no_carriers")
    if len(records) > 1000:
        raise CheckError("carrier_limit")
    return records


def appointment_identity(item):
    return {key: safe_text(item.get(key)) for key in
            ("fc", "readableAppointmentId", "appointmentId", "appointmentStatus", "formattedScheduledTime")}


def new_report(run_id):
    return {"schemaVersion": 1, "taskType": "unit-count-check", "runId": run_id,
            "status": "failed", "businessOutcome": "failed", "complete": False,
            "startedAt": now_iso(), "finishedAt": None, "timezone": "Asia/Shanghai",
            "window": None, "counts": {key: 0 for key in (
                "carriers", "carriersChecked", "carriersFailed", "carriersSkipped",
                "appointments", "checked", "normal", "abnormal", "failed", "skipped",
                "shipments", "zeroUnitShipments", "invalidUnitShipments")},
            "findings": [], "failures": [], "skipped": [], "carriers": [],
            "notification": "disabled", "summary": "检查尚未完成。"}


def add_failure(report, carrier, stage, code, item=None):
    failure = {"carrier": safe_text(carrier), "stage": stage, "code": code}
    if item:
        failure.update({key: safe_text(item.get(key)) for key in ("fc", "readableAppointmentId")})
    report["failures"].append(failure)


def login_adapter():
    path = Path(__file__).with_name("login_refresh.py")
    spec = importlib.util.spec_from_file_location("unit_count_login_refresh", path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    ERROR_LABELS.update(module.ERROR_LABELS)
    return module


def write_attention(output_dir, run_id, notice):
    """Bounded local signal for the trusted Pi task runner; no raw browser data."""
    carrier = re.sub(r"[^\w .-]", "", safe_text(notice.get("carrier"), 48)).strip(" ._-") or "承运人"
    event = {"schemaVersion": 1, "runId": validate_run_id(run_id),
             "status": "waiting_human", "kind": "verification_required",
             "carrier": carrier, "browser": "Chromium", "createdAt": now_iso(),
             "message": "请管理员在本机该承运人的专属 Chromium 窗口完成 Amazon 验证；完成后检查会自动继续。"}
    output_dir.mkdir(parents=True, exist_ok=True)
    path = output_dir / (run_id + ".attention.json")
    temporary = output_dir / ("." + run_id + ".attention." + uuid.uuid4().hex + ".tmp")
    try:
        temporary.write_text(json.dumps(event, ensure_ascii=False), encoding="utf-8")
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def check_carriers(report, modules, records, deadline, log=print, *,
                   login_mode="saved", login_timeout=600, on_attention=None):
    config = modules["config"]
    search = modules["search"]
    from_ms, to_ms, from_cst, to_cst = modules["time_window"].search_window_ms()
    report["window"] = {"from": from_cst.isoformat(), "to": to_cst.isoformat()}
    counts = report["counts"]
    counts["carriers"] = len(records)
    for index, record in enumerate(records, 1):
        before_failures = len(report["failures"])
        before_checked = counts["checked"]
        carrier = "承运人#" + str(index)
        fields = record.get("fields") if isinstance(record, dict) else None
        name = fields.get("承运人") if isinstance(fields, dict) else None
        if not isinstance(name, str) or not name.strip():
            counts["carriersFailed"] += 1
            add_failure(report, carrier, "carrier", "carrier_record_invalid")
            log(f"[carrier {index}/{len(records)}] 配置无效，需人工检查。", flush=True)
            continue
        carrier = safe_text(name)
        # Credentials are passed only into the login boundary, never logs/reports.
        carrier_config = {"name": name, "port": fields.get("浏览器端口")}
        try:
            key = config.carrier_key(carrier_config)
            secrets_dir = Path(config.COOKIES_PATH).parent.resolve()
            cookie_path = (secrets_dir / ("cookies_" + key + ".json")).resolve()
            if cookie_path.parent != secrets_dir:
                raise CheckError("carrier_record_invalid")
            if time.monotonic() >= deadline:
                raise CheckError("deadline_exceeded")
            if login_mode == "browser-refresh":
                adapter = modules.get("login_refresh") or login_adapter()
                log(f"[carrier {index}/{len(records)}] 检查专属 Chromium 登录并刷新会话。", flush=True)
                def progress(event):
                    phase = event.get("phase")
                    messages = {"verification_required": "等待管理员在本机浏览器完成验证，完成后自动继续。",
                                "session_refreshed": "登录校验通过，已刷新查询会话。"}
                    if phase in messages:
                        log(f"[carrier {index}/{len(records)}] " + messages[phase], flush=True)
                try:
                    refreshed = adapter.refresh_carrier_session(fields, config, deadline,
                        on_attention=on_attention, login_timeout=login_timeout, on_progress=progress)
                    cookies = refreshed["cookies"]
                    if Path(refreshed["cookie_path"]).resolve() != cookie_path:
                        raise CheckError("carrier_record_invalid")
                except adapter.LoginRefreshError as error:
                    ERROR_LABELS.update(adapter.ERROR_LABELS)
                    add_failure(report, carrier, "login", error.code)
                    stage = getattr(error, "stage", None)
                    if stage in getattr(adapter, "LOGIN_STAGES", ()):
                        report["failures"][-1]["loginStage"] = stage
                    counts["carriersFailed"] += 1
                    report["carriers"].append({"carrier": carrier, "login": "failed", "code": error.code,
                                               "checked": 0, "complete": False})
                    location = f"（步骤：{stage}）" if stage in getattr(adapter, "LOGIN_STAGES", ()) else ""
                    log(f"[carrier {index}/{len(records)}] 登录检查未完成：{error.code}{location}；未使用旧登录状态继续查询。", flush=True)
                    continue
                report.setdefault("loginSessions", []).append({"carrier": carrier, "status": "refreshed",
                    "browser": "chromium-drissionpage", "refreshedAt": now_iso()})
            elif login_mode != "saved":
                raise CheckError("login_mode_invalid")
            if not cookie_path.is_file():
                counts["carriersSkipped"] += 1
                report["skipped"].append({"carrier": carrier, "code": "cookies_missing"})
                add_failure(report, carrier, "cookies", "cookies_missing")
                log(f"[carrier {index}/{len(records)}] 缺少已保存的登录状态，已跳过；本轮不算检查正常。", flush=True)
                continue
            if cookie_path.stat().st_size > 1024 * 1024:
                raise CheckError("cookies_invalid")
            try:
                cookies = json.loads(cookie_path.read_text(encoding="utf-8-sig"))
            except (ValueError, OSError):
                raise CheckError("cookies_invalid") from None
            if not isinstance(cookies, dict) or not cookies or any(
                    not isinstance(k, str) or not isinstance(v, str) for k, v in cookies.items()):
                raise CheckError("cookies_invalid")
            log(f"[carrier {index}/{len(records)}] 查询预约。", flush=True)
            try:
                # Original prints HTTP status only; suppress all client output defensively.
                with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                    raw = search.search_createdate(cookies, from_ms, to_ms, timeout=20)
            except CheckError:
                raise
            except Exception:
                raise CheckError("search_failed") from None
            if not isinstance(raw, list) or len(raw) > 50000:
                raise CheckError("search_schema_invalid")
            counts["appointments"] += len(raw)
            candidates = []
            for raw_item in raw:
                if not isinstance(raw_item, dict):
                    counts["failed"] += 1
                    add_failure(report, carrier, "search", "appointment_fields_invalid")
                    continue
                status = raw_item.get("appointmentStatus")
                if not isinstance(status, str) or not status:
                    counts["failed"] += 1
                    add_failure(report, carrier, "search", "appointment_status_missing", raw_item)
                    continue
                if status not in TARGET_STATUSES:
                    counts["skipped"] += 1
                    continue
                extracted = search.extract_fields([raw_item], extra=("appointmentStatus", "formattedScheduledTime"))
                if not extracted:
                    counts["failed"] += 1
                    add_failure(report, carrier, "search", "appointment_fields_invalid", raw_item)
                    continue
                candidates.append(extracted[0])
            for item_index, item in enumerate(candidates, 1):
                try:
                    if time.monotonic() >= deadline:
                        raise CheckError("deadline_exceeded")
                    aid = item.get("appointmentId")
                    if not isinstance(aid, str) or not re.fullmatch(r"[A-Za-z0-9_-]{1,120}", aid):
                        raise CheckError("appointment_fields_invalid")
                    response = modules["http"].get(
                        "https://carriercentral.amazon.com/view", params={"id": aid},
                        cookies=cookies, headers={**config.HTTP_HEADERS,
                        "referer": "https://carriercentral.amazon.com/search"})
                    appointment = extract_appointment(response.text)
                    if appointment is None:
                        lower = response.text[:50000].lower()
                        if "ap/signin" in lower or 'name="password"' in lower or "authportal" in lower:
                            raise CheckError("auth_required")
                        raise CheckError("detail_parse_failed")
                    inspected = inspect_shipments(appointment)
                    counts["shipments"] += inspected["shipments"]
                    counts["zeroUnitShipments"] += len(inspected["zeros"])
                    counts["invalidUnitShipments"] += inspected["invalid"]
                    if inspected["zeros"]:
                        counts["abnormal"] += 1
                        finding = {"carrier": carrier, **appointment_identity(item),
                                   "zeroUnitShipmentCount": len(inspected["zeros"]),
                                   "zero_unit_shipments": inspected["zeros"][:50]}
                        if len(inspected["zeros"]) > 50:
                            finding["omittedShipmentDetails"] = len(inspected["zeros"]) - 50
                        report["findings"].append(finding)
                    if inspected["error"]:
                        raise CheckError(inspected["error"])
                    counts["checked"] += 1
                    if not inspected["zeros"]:
                        counts["normal"] += 1
                    log(f"[appointment {item_index}/{len(candidates)}] " +
                        (f"发现 {len(inspected['zeros'])} 条零件数异常。" if inspected["zeros"] else "检查正常。"), flush=True)
                except CheckError as error:
                    counts["failed"] += 1
                    add_failure(report, carrier, "detail", error.code, item)
                    log(f"[appointment {item_index}/{len(candidates)}] 未完成检查：{error.code}。", flush=True)
                except Exception:
                    counts["failed"] += 1
                    add_failure(report, carrier, "detail", "detail_failed", item)
                    log(f"[appointment {item_index}/{len(candidates)}] 未完成检查：detail_failed。", flush=True)
            if len(report["failures"]) == before_failures:
                counts["carriersChecked"] += 1
            else:
                counts["carriersFailed"] += 1
            report["carriers"].append({"carrier": carrier, "appointments": len(raw),
                "checked": counts["checked"] - before_checked,
                "complete": len(report["failures"]) == before_failures})
        except CheckError as error:
            counts["carriersFailed"] += 1
            add_failure(report, carrier, "carrier", error.code)
            log(f"[carrier {index}/{len(records)}] 未完成检查：{error.code}。", flush=True)
        except Exception:
            counts["carriersFailed"] += 1
            add_failure(report, carrier, "carrier", "carrier_check_failed")
            log(f"[carrier {index}/{len(records)}] 未完成检查：carrier_check_failed。", flush=True)


def finalize(report):
    counts = report["counts"]
    incomplete = bool(report["failures"]) or counts["carriers"] == 0
    report["complete"] = not incomplete
    if incomplete:
        report["status"] = "partial" if counts["checked"] or counts["abnormal"] else "failed"
        report["businessOutcome"] = "incomplete" if report["status"] == "partial" else "failed"
    else:
        report["status"] = "completed"
        report["businessOutcome"] = "abnormal" if counts["abnormal"] else "normal"
    report["finishedAt"] = now_iso()
    lead = {"normal": "检查完成，未发现 UnitCount 为 0。", "abnormal": "检查完成，发现 UnitCount 为 0 的预约。",
            "incomplete": "检查未全部完成，不能认定全部正常。", "failed": "检查失败，不能认定业务正常。"}[report["businessOutcome"]]
    report["summary"] = (f"{lead}\n承运人 {counts['carriers']} 个，完整检查 {counts['carriersChecked']} 个，"
        f"失败 {counts['carriersFailed']} 个，缺登录状态跳过 {counts['carriersSkipped']} 个。\n"
        f"预约 {counts['appointments']} 条，完整检查 {counts['checked']} 条，正常 {counts['normal']} 条，"
        f"零件数异常 {counts['abnormal']} 条，检查失败 {counts['failed']} 条，非目标状态跳过 {counts['skipped']} 条。\n"
        f"零件数 shipment {counts['zeroUnitShipments']} 条，件数缺失或无效 {counts['invalidUnitShipments']} 条。")
    report["summary"] += "\n检查时间（北京时间）：" + report["finishedAt"].replace("T", " ")
    if report.get("window"):
        report["summary"] += "\n查询范围：" + report["window"]["from"].replace("T", " ") + " 至 " + report["window"]["to"].replace("T", " ")
    if report["findings"]:
        def cell(value):
            return safe_text(value, 80).replace("\\", "\\\\").replace("|", "\\|").replace("`", "")
        lines = ["", "零件数异常明细：", "| 承运人 | FC | 预约号 | 异常 shipment 数 | shipment 参考号 |",
                 "| --- | --- | --- | ---: | --- |"]
        for finding in report["findings"][:10]:
            references = ", ".join(cell(item.get("progressiveNumber") or item.get("shipmentId"))
                for item in finding["zero_unit_shipments"][:3]) or "待查看详情"
            lines.append("| " + " | ".join((cell(finding["carrier"]), cell(finding["fc"]),
                cell(finding["readableAppointmentId"]), str(finding["zeroUnitShipmentCount"]), references)) + " |")
        if len(report["findings"]) > 10:
            lines.append("另有 " + str(len(report["findings"]) - 10) + " 条异常，请在智能体中查看完整报告。")
        report["summary"] += "\n" + "\n".join(lines)
    if report["failures"]:
        grouped = {}
        for failure in report["failures"]:
            carrier = failure.get("carrier") or "初始化/公共步骤"
            grouped.setdefault(carrier, set()).add(failure["code"])
        lines = ["", "需处理："]
        for carrier, codes in list(grouped.items())[:10]:
            labels = [ERROR_LABELS.get(code, "检查未完成，请查看管理员日志") for code in sorted(codes)[:4]]
            lines.append("- " + carrier + "：" + "；".join(labels) + "。")
        if len(grouped) > 10:
            lines.append("- 其余 " + str(len(grouped) - 10) + " 个承运人/步骤请查看完整报告。")
        report["summary"] += "\n" + "\n".join(lines)
    # Backend bounds UTF-8 bytes, not Python characters (Chinese often uses 3 bytes).
    encoded_summary = report["summary"].encode("utf-8")
    if len(encoded_summary) > 15000:
        suffix = "\n\n摘要已截断，完整明细请在智能体中查看运行报告。"
        budget = 15000 - len(suffix.encode("utf-8"))
        prefix = encoded_summary[:budget].decode("utf-8", errors="ignore")
        # Preserve complete Markdown rows/lines whenever there is a preceding newline.
        if "\n" in prefix:
            prefix = prefix.rsplit("\n", 1)[0]
        report["summary"] = prefix + suffix
    return report


def write_report(report, output_dir, update_latest=True):
    output_dir.mkdir(parents=True, exist_ok=True)
    destination = output_dir / (report["runId"] + ".json")
    if destination.exists():
        raise CheckError("run_id_already_exists")
    # Aggregate counts are exact; bound optional evidence to the backend's 1 MiB protocol.
    for name in ("findings", "failures", "skipped", "carriers"):
        if len(report[name]) > 1000:
            report.setdefault("omittedDetails", {})[name] = len(report[name]) - 1000
            report[name] = report[name][:1000]
    encoded = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    while len(encoded) > 900000:
        longest = max(("findings", "failures", "skipped", "carriers"), key=lambda name: len(report[name]))
        if not report[longest]:
            raise CheckError("result_too_large")
        report[longest].pop()
        omitted = report.setdefault("omittedDetails", {})
        omitted[longest] = omitted.get(longest, 0) + 1
        encoded = json.dumps(report, ensure_ascii=False, indent=2, allow_nan=False).encode("utf-8")
    temp = output_dir / ("." + report["runId"] + "." + uuid.uuid4().hex + ".tmp")
    try:
        temp.write_bytes(encoded)
        os.replace(temp, destination)
        if update_latest:
            latest_temp = output_dir / (".latest." + uuid.uuid4().hex + ".tmp")
            latest_temp.write_bytes(encoded)
            os.replace(latest_temp, output_dir / "latest.json")
    finally:
        if temp.exists():
            temp.unlink()
    return destination


def preflight(registration):
    source = Path(registration["sourceDir"])
    checks = {"python310OrNewer": sys.version_info >= (3, 10),
              "networkModeValid": registration.get("networkMode", "system") in ("system", "direct"),
              "requestsInstalled": importlib.util.find_spec("requests") is not None,
              "sourceFilesPresent": all((source / name).is_file() for name in REQUIRED_FILES),
              "sourceSyntaxValid": True,
              "savedCookieFilesPresent": bool(list((source / "secrets").glob("cookies_*.json")))}
    if checks["sourceFilesPresent"]:
        for filename in REQUIRED_FILES:
            try:
                ast.parse((source / filename).read_text(encoding="utf-8-sig"), filename=filename)
            except (OSError, SyntaxError, UnicodeError):
                checks["sourceSyntaxValid"] = False
    else:
        checks["sourceSyntaxValid"] = False
    login_mode = registration.get("loginMode", "browser-refresh")
    checks["loginModeValid"] = login_mode in ("browser-refresh", "saved")
    if login_mode == "browser-refresh":
        checks["loginAdapterPresent"] = Path(__file__).with_name("login_refresh.py").is_file()
        checks["browserDependencyInstalled"] = importlib.util.find_spec("DrissionPage") is not None
        checks["browserProfileInspectorInstalled"] = importlib.util.find_spec("psutil") is not None
    ready = all(value for key, value in checks.items()
                if key != "savedCookieFilesPresent" or login_mode == "saved")
    return {"schemaVersion": 1, "status": "ready" if ready else "blocked", "checks": checks,
            "summary": "静态预检通过；未访问飞书或 Amazon，尚未验证登录有效性。" if ready else
                       "静态预检未通过；未访问业务网络。", "businessNetworkUsed": False}


def notify_wecom(report, modules):
    if not report["findings"]:
        report["notification"] = "not_needed"
        return
    config = modules["config"]
    key = getattr(config, "WECOM_WEBHOOK_KEY", "")
    if not key:
        raise CheckError("notification_configuration_missing")
    try:
        response = modules["http"].post("https://qyapi.weixin.qq.com/cgi-bin/webhook/send",
            params={"key": key}, json={"msgtype": "text", "text": {"content": report["summary"][:1800]}})
        data = response.json()
        if not isinstance(data, dict) or data.get("errcode") != 0:
            raise CheckError("notification_failed")
    except CheckError:
        raise
    except Exception:
        raise CheckError("notification_failed") from None
    report["notification"] = "sent"


def validate_run_id(value):
    if not isinstance(value, str) or not RUN_ID.fullmatch(value) or value.lower() == "latest":
        raise CheckError("invalid_run_id")
    return value


def read_result(output_dir, run_id=None):
    name = validate_run_id(run_id) + ".json" if run_id is not None else "latest.json"
    path = output_dir / name
    if not path.is_file():
        return {"schemaVersion": 1, "status": "not_found" if run_id else "not_run",
                "summary": "未找到这次运行记录。" if run_id else "尚无运行记录。"}
    if path.stat().st_size > 1024 * 1024:
        raise CheckError("result_too_large")
    result = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(result, dict) or result.get("schemaVersion") != 1 or (
            run_id is not None and result.get("runId") != run_id):
        raise CheckError("result_invalid")
    return result


def emit(value):
    print(json.dumps(value, ensure_ascii=False, allow_nan=False), flush=True)


def main(argv=None):
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    parser = argparse.ArgumentParser(description="UnitCount unattended read-only checks")
    parser.add_argument("registration")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--preflight", action="store_true")
    mode.add_argument("--latest", action="store_true")
    mode.add_argument("--result")
    mode.add_argument("--check", action="store_true")
    args = parser.parse_args(argv)
    try:
        registration = json.loads(Path(args.registration).read_text(encoding="utf-8-sig"))
        if not isinstance(registration, dict) or not registration.get("sourceDir") or not registration.get("outputDir"):
            raise CheckError("registration_invalid")
        output_dir = Path(registration["outputDir"]).resolve()
        if args.preflight:
            result = preflight(registration)
            emit(result)
            return 0 if result["status"] == "ready" else 2
        if args.latest or args.result is not None:
            result = read_result(output_dir, args.result)
            emit(result)
            return 0 if result["status"] != "not_found" else 3
        run_id = validate_run_id(os.environ.get("PI_BUSINESS_RUN_ID") or os.environ.get("RPAC_EXECUTION_ID") or str(uuid.uuid4()))
        if (output_dir / (run_id + ".json")).exists():
            raise CheckError("run_id_already_exists")
        report = new_report(run_id)
        deadline = time.monotonic() + min(1500, max(30, int(registration.get("maxTotalSeconds", 1200))))
        login_mode = registration.get("loginMode", "browser-refresh")
        if login_mode not in ("browser-refresh", "saved"):
            raise CheckError("login_mode_invalid")
        login_timeout = min(900, max(1, int(registration.get("loginTimeoutSeconds", 600))))
        report["execution"] = {"loginMode": login_mode,
            "loginBrowser": "chromium-drissionpage" if login_mode == "browser-refresh" else None,
            "queryTransport": "python-requests"}
        print("[unit-count] 开始检查；先检查专属 Chromium 登录并刷新会话，再读取预约和 shipment。"
              if login_mode == "browser-refresh" else "[unit-count] 开始检查；仅使用已保存的登录状态。", flush=True)
        try:
            with exclusive_check_lock(output_dir), shared_browser_lock(deadline):
                modules = None
                try:
                    modules = load_original(Path(registration["sourceDir"]).resolve(), deadline,
                                            network_mode=registration.get("networkMode", "system"))
                    records = load_carrier_records(modules)
                    check_carriers(report, modules, records, deadline,
                        login_mode=login_mode, login_timeout=login_timeout,
                        on_attention=lambda notice: write_attention(output_dir, run_id, notice))
                except CheckError as error:
                    add_failure(report, "", "setup", error.code)
                except Exception:
                    add_failure(report, "", "setup", "check_failed")
                finalize(report)
                if registration.get("notifyWecom") is True and modules is not None:
                    try:
                        notify_wecom(report, modules)
                    except CheckError as error:
                        report["notification"] = "failed"
                        add_failure(report, "", "notification", error.code)
                        finalize(report)
                write_report(report, output_dir)
        except CheckError as error:
            if error.code not in {"check_already_running", "browser_busy"}:
                raise
            add_failure(report, "", "setup", error.code)
            finalize(report)
            write_report(report, output_dir, update_latest=error.code != "check_already_running")
        print("[unit-count] " + report["summary"].replace("\n", " "), flush=True)
        emit(report)
        return 0 if report["status"] == "completed" else 2
    except CheckError as error:
        emit({"schemaVersion": 1, "status": "failed", "code": error.code,
              "summary": "操作未完成：" + error.code + "。"})
        return 2
    except Exception:
        emit({"schemaVersion": 1, "status": "failed", "code": "operation_failed",
              "summary": "操作未完成，请检查管理员运行日志；未输出凭据或原始响应。"})
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
