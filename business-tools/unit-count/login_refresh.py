"""Restore the original Carrier Central browser login before HTTP checks.

This module deliberately does not import the original auth.py: it contains input(),
sys.exit() and its own outbound notifications. Only Pi owns task state/notifications.
The browser remains open for legitimate human verification; this module never solves
CAPTCHA/OTP and never prints credentials, cookies, URLs or exception details.
"""
from __future__ import annotations

import hashlib
import json
import math
import os
from pathlib import Path
import re
import socket
import tempfile
import time
from urllib.parse import parse_qs, urlparse
import uuid


ERROR_LABELS = {
    "login_credentials_missing": "承运人登录账号或密码未配置",
    "browser_port_invalid": "承运人专属浏览器端口无效",
    "browser_profile_mismatch": "浏览器端口或账户与承运人配置不一致",
    "browser_profile_unverified": "无法确认专属浏览器配置，未操作现有浏览器",
    "browser_dependency_missing": "登录浏览器依赖未安装",
    "browser_start_failed": "专属登录浏览器启动失败",
    "browser_navigation_failed": "Amazon 登录页面未能正常加载",
    "login_failed": "Amazon 未接受登录信息或账户登录需要处理",
    "login_timeout": "Amazon 登录未能在时限内完成",
    "verification_timeout": "等待管理员完成 Amazon 验证超时",
    "login_account_selection_failed": "未能自动切换到已配置的 Amazon 账户",
    "session_unverified": "Amazon 登录或访问校验未通过",
    "login_cookies_incomplete": "Amazon 登录完成但必需的会话信息不完整",
    "login_language_unverified": "Amazon 查询语言会话未能完成校验",
    "login_configuration_invalid": "原程序登录配置不完整或无效",
    "login_save_failed": "已登录但会话信息未能安全保存",
    "attention_notification_failed": "管理员验证提醒未能送达",
    "deadline_exceeded": "超过本次检查时限",
}

LOGIN_STAGES = frozenset({
    "configuration", "browser_attach", "browser_tab_create", "signin_navigation",
    "signin_state", "account_selection", "email_input", "password_input", "form_submit",
    "request_navigation", "request_state", "language_switch", "search_navigation",
    "search_state", "cookie_export", "session_save",
})


class LoginRefreshError(Exception):
    """Only fixed safe error codes/messages may leave the login boundary."""

    def __init__(self, code, stage="configuration"):
        self.code = code if code in ERROR_LABELS else "session_unverified"
        self.stage = stage if stage in LOGIN_STAGES else "configuration"
        super().__init__(ERROR_LABELS[self.code])


_STATE_SCRIPT = r"""
return (() => {
  const visible = el => !!el && !!(el.getClientRects().length) &&
    getComputedStyle(el).visibility !== 'hidden';
  const one = selectors => [...document.querySelectorAll(selectors)].find(visible);
  const email = one('#ap_email, input[name="email"]');
  const password = one('#ap_password, input[name="password"]');
  const verification = !!one('#auth-mfa-otpcode, #cvf-input-code, #captchacharacters, '
    + '#auth-captcha-image, input[name="otpCode"], input[name="code"], '
    + 'iframe[src*="captcha"], input[autocomplete="one-time-code"]');
  const identity = one('#auth-email-claim, [data-current-user-email], #account-email, '
    + '#user-email, #nav-usernameMenu');
  const hiddenEmail = document.querySelector('#ap_email, input[name="email"]');
  const claim = identity ? (identity.getAttribute('data-current-user-email') ||
    identity.getAttribute('data-email') || identity.textContent || '') :
    (hiddenEmail ? hiddenEmail.value || '' : '');
  const emailPattern = /[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/i;
  const match = claim.match(emailPattern) || (hiddenEmail && String(hiddenEmail.value || '').match(emailPattern));
  return {
    email: !!email, password: !!password, verification,
    login_error: !!one('#auth-error-message-box, '
      + '#auth-password-error, #auth-email-invalid-claim-alert'),
    chooser: !!one('#ap-account-switcher-container, #ap-account-switcher-scroller, '
      + '.cvf-account-switcher') || [...document.querySelectorAll('h1')].some(el =>
        visible(el) && /^(?:切换账户|切換帳戶|Switch accounts)$/i.test(el.textContent.trim())),
    identity: match ? match[0] : '',
    portal: !!one('#requestUrlDiv, [ng-controller], [data-ng-controller], '
      + 'a[href*="/ap/signout"], a[href*="/search"], a[href*="/request"], '
      + '#freight_dropdown, #searchForm, #search-form'),
    ready: document.readyState !== 'loading'
  };
})();
"""


_ACCOUNT_CHOICE_SCRIPT = r"""
const wanted = String(arguments[0]).trim().toLowerCase();
const visible = el => !!el && !!el.getClientRects().length &&
  getComputedStyle(el).visibility !== 'hidden';
const emailPattern = /[a-z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}/ig;
const candidates = [...document.querySelectorAll('div.a-column.a-span3, '
  + '[data-account-email], [data-email]')].filter(visible);
const matches = candidates.filter(el => {
  const claim = el.getAttribute('data-account-email') || el.getAttribute('data-email') || '';
  const emails = [...new Set(((claim + ' ' + el.textContent).match(emailPattern) || [])
    .map(value => value.toLowerCase()))];
  return emails.length === 1 && emails[0] === wanted;
});
// Nested matching wrappers are one card, not independent choices.
const leaves = matches.filter(el => !matches.some(other => other !== el && el.contains(other)));
if (leaves.length !== 1) return leaves.length ? 'ambiguous' : 'not_found';
leaves[0].click();
return 'selected';
"""


def _safe_carrier(name):
    # Configuration names are not credentials, nevertheless keep notices bounded.
    return re.sub(r"[^\w\u4e00-\u9fff .-]", "", str(name))[:80] or "承运人"


def _port(value):
    if isinstance(value, bool) or not re.fullmatch(r"[0-9]{4,5}", str(value or "")):
        raise LoginRefreshError("browser_port_invalid")
    value = int(value)
    if not 1024 <= value <= 65535:
        raise LoginRefreshError("browser_port_invalid")
    return value


def _profile_path(port):
    # This is the original DrissionPage default, not the user's Chrome profile.
    return (Path(tempfile.gettempdir()) / "DrissionPage" / "userData" / str(port)).resolve()


def _check_existing_port(port, profile):
    """Reject other applications/profiles before DrissionPage can attach/relaunch."""
    with socket.socket() as sock:
        sock.settimeout(0.3)
        if sock.connect_ex(("127.0.0.1", port)):
            return
    try:
        import psutil
        listeners = [c for c in psutil.net_connections(kind="tcp")
                     if c.status == psutil.CONN_LISTEN and c.laddr.port == port]
        if not listeners or any(not c.pid for c in listeners):
            raise LoginRefreshError("browser_profile_unverified")
        for pid in {c.pid for c in listeners}:
            process = psutil.Process(pid)
            if process.name().lower() not in {"chrome.exe", "chromium.exe", "msedge.exe",
                                               "chrome", "chromium", "msedge"}:
                raise LoginRefreshError("browser_profile_mismatch")
            args = process.cmdline()
            if (f"--remote-debugging-port={port}" not in args or
                    any(a.startswith("--headless") for a in args)):
                raise LoginRefreshError("browser_profile_mismatch")
            paths = [a.split("=", 1)[1].strip('"') for a in args
                     if a.startswith("--user-data-dir=")]
            if len(paths) != 1 or Path(paths[0]).resolve() != profile:
                raise LoginRefreshError("browser_profile_mismatch")
    except LoginRefreshError:
        raise
    except Exception:
        raise LoginRefreshError("browser_profile_unverified") from None


def _default_browser_factory(port, timeout):
    try:
        from DrissionPage import Chromium, ChromiumOptions
    except ImportError:
        raise LoginRefreshError("browser_dependency_missing", "browser_attach") from None
    profile = _profile_path(port)
    try:
        _check_existing_port(port, profile)
    except LoginRefreshError as error:
        error.stage = "browser_attach"
        raise
    try:
        options = ChromiumOptions(read_file=False)
        options.set_local_port(port)
        options.set_user_data_path(profile)
        options.headless(False)
        options.set_timeouts(base=min(5, timeout), page_load=min(30, timeout), script=min(5, timeout))
        return Chromium(options)
    except Exception:
        raise LoginRefreshError("browser_start_failed", "browser_attach") from None


def _state(tab, stage="signin_state", *, deadline=None, clock=time.monotonic, sleep=time.sleep):
    # CDP root/context IDs can be briefly unavailable across a real page switch.
    # Retry read-only observation, never resubmit a password/click as a retry.
    stop = min(clock() + 8, float(deadline) if deadline is not None else math.inf)
    while True:
        left = stop - clock()
        if left <= 0:
            raise LoginRefreshError("browser_navigation_failed", stage)
        try:
            result = tab.run_js(_STATE_SCRIPT, timeout=min(3, left))
            if isinstance(result, dict):
                return result
        except Exception:
            pass
        if clock() >= stop:
            raise LoginRefreshError("browser_navigation_failed", stage) from None
        sleep(min(0.2, stop - clock()))


def _element(tab, selector):
    try:
        return tab.ele("css:" + selector, timeout=0.1)
    except Exception:
        return None


def _interactive_element(tab, selector):
    try:
        # Match the DOM reader's visible input, not a hidden first duplicate.
        for element in tab.eles("css:" + selector, timeout=0.2):
            try:
                if element.states.is_clickable:
                    return element
            except Exception:
                continue
    except Exception:
        pass
    return None


def _click(tab, selectors, stage="form_submit"):
    for selector in selectors:
        element = _interactive_element(tab, selector)
        if element:
            try:
                if element.click() is False:
                    raise ValueError()
                return True
            except Exception:
                raise LoginRefreshError("browser_navigation_failed", stage) from None
    return False


def _input(tab, selector, value, stage):
    element = _interactive_element(tab, selector)
    if not element:
        raise LoginRefreshError("browser_navigation_failed", stage)
    try:
        element.input(value, clear=True)
    except Exception:
        raise LoginRefreshError("browser_navigation_failed", stage) from None


def _choose_configured_account(tab, email):
    address = _url(tab)
    if address.scheme != "https" or address.hostname not in {"carriercentral.amazon.com", "www.amazon.com", "amazon.com"}:
        raise LoginRefreshError("browser_navigation_failed", "account_selection")
    try:
        result = tab.run_js(_ACCOUNT_CHOICE_SCRIPT, email, timeout=3)
        return result == "selected"
    except Exception:
        raise LoginRefreshError("login_account_selection_failed", "account_selection") from None


def _navigate(tab, url, remaining, stage="signin_navigation"):
    try:
        result = tab.get(url, timeout=max(0.1, min(30, remaining)), retry=0)
        if result is False:
            raise ValueError()
    except Exception:
        raise LoginRefreshError("browser_navigation_failed", stage) from None


def _url(tab, stage="signin_state"):
    try:
        return urlparse(str(tab.url))
    except Exception:
        raise LoginRefreshError("browser_navigation_failed", stage) from None


def _portal(tab, state, stage="signin_state"):
    url = _url(tab, stage)
    return (url.scheme == "https" and url.hostname == "carriercentral.amazon.com" and
            url.path.rstrip("/") in {"/request", "/search"} and
            not any(state.get(k) for k in ("email", "password", "verification", "chooser", "login_error")) and
            state.get("ready") and state.get("portal"))


def _raw_cookies(tab):
    try:
        result = tab.cookies().as_dict()
        if not isinstance(result, dict):
            raise ValueError()
        return result
    except Exception:
        raise LoginRefreshError("login_cookies_incomplete", "cookie_export") from None


def _matches_locale(cookies, locale):
    # An URL query/default value is not evidence that the browser switched locale.
    # magicarp_locale is the actual Carrier Central setting used by the original.
    primary = cookies.get("magicarp_locale")
    expected = locale.casefold()
    if not isinstance(primary, str) or primary.replace("-", "_").casefold() != expected:
        return False
    amazon_locale = cookies.get("lc-main")
    return amazon_locale is None or (isinstance(amazon_locale, str) and
                                     amazon_locale.replace("-", "_").casefold() == expected)


def _english_locale(cookies):
    return _matches_locale(cookies, "en_US")


def _set_locale_preferences(tab, locale="en_US"):
    # Exact original backup._switch_to_en_us fallback; these are non-secret
    # presentation preferences, never authentication/session cookie fabrication.
    try:
        for name, value in (("magicarp_locale", locale), ("lc-main", locale),
                            ("magicarp_current_country", "US")):
            result = tab.run_cdp("Network.setCookie", name=name, value=value,
                                 domain=".carriercentral.amazon.com", path="/",
                                 httpOnly=False, secure=True)
            if isinstance(result, dict) and result.get("success") is False:
                raise ValueError()
    except Exception:
        raise LoginRefreshError("login_language_unverified", "language_switch") from None


def _atomic_json(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporary.open("x", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        try:
            temporary.unlink(missing_ok=True)
        except OSError:
            pass


def refresh_carrier_session(carrier_fields, config, deadline, on_attention=None, *,
                            browser_factory=None, clock=time.monotonic, sleep=time.sleep,
                            login_timeout=600, poll_interval=1, on_progress=None, locale="en_US"):
    """Login/refresh one carrier, export cookies, then let the caller check data.

    `deadline` is an absolute monotonic timestamp shared with the whole task.
    Raw Feishu fields or normalized name/email/password/port records are supported.
    `on_attention` is called once per login when human verification is needed.
    Tests may inject a browser factory, clock and sleep; no real browser is needed.
    """
    if not isinstance(carrier_fields, dict):
        raise LoginRefreshError("login_configuration_invalid")
    name = carrier_fields.get("name", carrier_fields.get(getattr(config, "FEISHU_FIELD_NAME", "承运人")))
    # Credentials are read only here and never copied into return values/notices/errors.
    email = carrier_fields.get("email", carrier_fields.get(getattr(config, "FEISHU_FIELD_EMAIL", "账号")))
    password = carrier_fields.get("password", carrier_fields.get(getattr(config, "FEISHU_FIELD_PASSWORD", "密码")))
    # Match original run_all.load_carriers exactly: the Feishu 账号 column is a
    # link field {link: ..., text: email}. Only its display text is a login name;
    # never use/fetch the URL or stringify an arbitrary field object.
    if isinstance(email, dict):
        email = email.get("text")
    raw_port = carrier_fields.get("port", carrier_fields.get(getattr(config, "FEISHU_FIELD_PORT", "浏览器端口")))
    port = _port(raw_port)
    if not isinstance(email, str) or not email.strip() or not isinstance(password, str) or not password:
        raise LoginRefreshError("login_credentials_missing")
    email = email.strip()
    if not isinstance(name, str) or not name.strip():
        raise LoginRefreshError("login_configuration_invalid")
    try:
        key = config.carrier_key({"name": name, "port": raw_port})
        if not isinstance(key, str) or not key or len(key) > 160 or re.search(r'[<>:"/\\|?*\x00-\x1f]', key):
            raise ValueError()
        secrets_dir = Path(config.COOKIES_PATH).parent.resolve()
        cookie_path = (secrets_dir / f"cookies_{key}.json").resolve()
        token_path = (secrets_dir / f"app_action_token_{key}.json").resolve()
        if cookie_path.parent != secrets_dir or token_path.parent != secrets_dir:
            raise ValueError()
        urls = {name: str(getattr(config, name)) for name in
                ("SIGNIN_URL", "REQUEST_URL", "HOMEV2_URL", "SEARCH_URL")}
        for value in urls.values():
            parsed = urlparse(value)
            if parsed.scheme != "https" or parsed.hostname != "carriercentral.amazon.com" or parsed.username:
                raise ValueError()
        required = tuple(config.REQUIRED_COOKIES)
        defaults = dict(config.COOKIE_DEFAULTS)
        if not required or not all(isinstance(x, str) for x in required):
            raise ValueError()
        if locale not in {"en_US", "zh_CN"} or not math.isfinite(float(deadline)) or not 1 <= float(login_timeout) <= 900:
            raise ValueError()
    except Exception:
        raise LoginRefreshError("login_configuration_invalid") from None

    binding_path = secrets_dir / f"unit_count_browser_{port}.json"
    binding = {"carrier_key": key, "account_fingerprint": hashlib.sha256(email.casefold().encode()).hexdigest()}
    try:
        if binding_path.exists() and json.loads(binding_path.read_text(encoding="utf-8")) != binding:
            raise LoginRefreshError("browser_profile_mismatch")
    except LoginRefreshError:
        raise
    except Exception:
        raise LoginRefreshError("browser_profile_unverified") from None

    stop = min(float(deadline), clock() + float(login_timeout))
    verification_seen = False
    announced = False
    submitted_email = False
    submitted_password = False
    password_submitted_at = None
    account_transition_started = None
    switched_home = False
    # Only fixed bounded messages cross into task logging.
    def progress(phase):
        if on_progress:
            try:
                on_progress({"carrier": _safe_carrier(name), "phase": phase,
                             "browser": "Chromium"})
            except Exception:
                pass

    def remaining():
        left = stop - clock()
        if left <= 0:
            code = "verification_timeout" if verification_seen else "login_timeout"
            if clock() >= float(deadline) and not verification_seen:
                code = "deadline_exceeded"
            raise LoginRefreshError(code)
        return left

    def attention(phase="verification_required"):
        nonlocal announced, verification_seen
        verification_seen = True
        if announced:
            return
        announced = True
        if on_attention:
            notice = {"carrier": _safe_carrier(name), "phase": phase, "browser": "Chromium",
                      "message": "请管理员在本机该承运人的专属 Chromium 窗口完成 Amazon 验证；完成后检查会自动继续。"}
            try:
                on_attention(notice)
            except Exception:
                raise LoginRefreshError("attention_notification_failed") from None
        progress(phase)

    progress("login_started")
    progress("browser_attach")
    try:
        browser = (browser_factory or _default_browser_factory)(port, remaining())
    except LoginRefreshError:
        raise
    except Exception:
        raise LoginRefreshError("browser_start_failed", "browser_attach") from None
    progress("browser_tab_create")
    try:
        tab = browser.new_tab()
    except Exception:
        raise LoginRefreshError("browser_start_failed", "browser_tab_create") from None

    def read_state(stage):
        progress(stage)
        return _state(tab, stage, deadline=stop, clock=clock, sleep=sleep)

    def navigate(url, stage):
        progress(stage)
        _navigate(tab, url, remaining(), stage)

    # A new tab belongs to this run; no existing user tab is navigated or closed.
    # Do not quit the browser/tab on failure: the administrator may be verifying.
    navigate(urls["SIGNIN_URL"], "signin_navigation")
    while True:
        remaining()
        state = read_state("signin_state")
        url = _url(tab, "signin_state")
        if url.scheme != "https" or url.hostname not in {"carriercentral.amazon.com", "www.amazon.com", "amazon.com"}:
            raise LoginRefreshError("browser_navigation_failed", "signin_state")
        if account_transition_started is not None:
            if state.get("chooser"):
                if clock() - account_transition_started >= 15:
                    raise LoginRefreshError("login_account_selection_failed", "account_selection")
                sleep(min(max(0.05, poll_interval), remaining()))
                continue
            account_transition_started = None
        if state.get("identity") and state["identity"].casefold() != email.casefold():
            progress("account_selection")
            if state.get("chooser"):
                if (_choose_configured_account(tab, email) or
                        _click(tab, ("#ap-account-switcher-add-account-link", "#ap-account-switcher-alternate-account-link"), "account_selection")):
                    submitted_email = submitted_password = False
                    password_submitted_at = None
                    account_transition_started = clock()
                else:
                    raise LoginRefreshError("login_account_selection_failed", "account_selection")
                sleep(min(poll_interval, remaining()))
                continue
            if state.get("password") and _click(tab, ("#ap_change_login_claim", "#ap_switch_account_link", "#ap-account-switcher-link"), "account_selection"):
                submitted_email = submitted_password = False
                password_submitted_at = None
                sleep(min(poll_interval, remaining()))
                continue
            raise LoginRefreshError("browser_profile_mismatch", "account_selection")
        if _portal(tab, state):
            break
        if state.get("verification") or re.search(r"/(?:ap/(?:mfa|cvf|challenge)|errors/validateCaptcha)(?:/|$)", url.path, re.I):
            attention()
        elif state.get("login_error"):
            raise LoginRefreshError("login_failed", "form_submit")
        elif state.get("chooser"):
            progress("account_selection")
            # Match the configured full email, never an arbitrary first account.
            if not (_choose_configured_account(tab, email) or
                    _click(tab, ("#ap-account-switcher-add-account-link", "#ap-account-switcher-alternate-account-link"), "account_selection")):
                raise LoginRefreshError("login_account_selection_failed", "account_selection")
            submitted_email = submitted_password = False
            password_submitted_at = None
            account_transition_started = clock()
        elif state.get("email") and not submitted_email:
            progress("email_input")
            _input(tab, "#ap_email, input[name=\"email\"]", email, "email_input")
            progress("form_submit")
            if not _click(tab, ("#continue", 'input[type="submit"]', 'button[type="submit"]')):
                raise LoginRefreshError("login_failed", "form_submit")
            submitted_email = True
        elif state.get("password") and not submitted_password:
            # A visible password page without an account claim is ambiguous.
            # Return to explicit email entry instead of using a saved account blindly.
            if not submitted_email and not state.get("identity"):
                progress("account_selection")
                if _click(tab, ("#ap_change_login_claim", "#ap_switch_account_link", "#ap-account-switcher-link"), "account_selection"):
                    sleep(min(poll_interval, remaining()))
                    continue
                raise LoginRefreshError("login_account_selection_failed", "account_selection")
            else:
                progress("password_input")
                _input(tab, "#ap_password, input[name=\"password\"]", password, "password_input")
                progress("form_submit")
                if not _click(tab, ("#signInSubmit", 'input[type="submit"]', 'button[type="submit"]')):
                    raise LoginRefreshError("login_failed", "form_submit")
                submitted_password = True
                password_submitted_at = clock()
        elif url.scheme == "https" and url.hostname == "carriercentral.amazon.com" and url.path.rstrip("/") == "/homeV2":
            if not switched_home:
                progress("request_navigation")
                if not _click(tab, ("div.a-switch.a-declarative", ".a-switch", 'a[href="/request"]'), "request_navigation"):
                    navigate(urls["REQUEST_URL"], "request_navigation")
                switched_home = True
        elif submitted_password and password_submitted_at is not None and clock() - password_submitted_at >= 15:
            # Only positively recognized OTP/CAPTCHA ever asks a human to act.
            # Unknown login states fail clearly instead of inventing verification.
            raise LoginRefreshError("login_failed", "signin_state")
        sleep(min(max(0.05, poll_interval), remaining()))

    def verified_after_navigation(stage):
        """Challenges may occur again when opening the authenticated application."""
        application_ready_by = min(stop, clock() + 15)
        while True:
            remaining()
            current = read_state(stage)
            address = _url(tab, stage)
            if current.get("identity") and current["identity"].casefold() != email.casefold():
                raise LoginRefreshError("browser_profile_mismatch", stage)
            if _portal(tab, current, stage):
                return current
            if (current.get("verification") or re.search(
                    r"/(?:ap/(?:mfa|cvf|challenge)|errors/validateCaptcha)(?:/|$)", address.path, re.I)):
                attention()
            elif not current.get("ready") or (not any(current.get(key_name) for key_name in
                    ("email", "password", "chooser", "login_error")) and clock() < application_ready_by):
                pass
            else:
                raise LoginRefreshError("session_unverified", stage)
            sleep(min(max(0.05, poll_interval), remaining()))

    # Original /request verification is retained. A target URL alone is not proof:
    # the DOM must also contain the authenticated application and no login fields.
    navigate(urls["REQUEST_URL"], "request_navigation")
    verified_after_navigation("request_state")
    token = None
    div = _element(tab, "#requestUrlDiv")
    if div:
        try:
            value = div.attr("data-request-url") or ""
            token = parse_qs(urlparse(value.replace("@appaction=", "&appaction=")).query).get("appActionToken", [None])[0]
        except Exception:
            token = None

    # UnitCount's original opens /search before switching English. PO duplicate's
    # original switches zh_CN on the verified /request and reopens /request.
    # Keep both exact business variants; the default remains UnitCount en_US.
    if locale == "en_US":
        navigate(urls["SEARCH_URL"], "search_navigation")
        verified_after_navigation("search_state")
    final_url = urls["SEARCH_URL"] if locale == "en_US" else urls["REQUEST_URL"]
    final_navigation = "search_navigation" if locale == "en_US" else "request_navigation"
    final_state = "search_state" if locale == "en_US" else "request_state"
    progress("language_switch")
    clicked_language = _click(tab, ("a#" + locale, "#" + locale,
        'a[href*="language=' + locale + '"]'), "language_switch")
    if clicked_language:
        # The original waits for #en_US -> /search before doing any further GET.
        # Navigating immediately could cancel the language-cookie refresh.
        language_ready_by = min(stop, clock() + 15)
        while True:
            remaining()
            current = read_state("language_switch")
            address = _url(tab, "language_switch")
            if current.get("verification") or re.search(
                    r"/(?:ap/(?:mfa|cvf|challenge)|errors/validateCaptcha)(?:/|$)", address.path, re.I):
                attention()
            elif (_portal(tab, current, "language_switch") and
                    (locale == "zh_CN" or address.path.rstrip("/") == "/search") and
                    _matches_locale(_raw_cookies(tab), locale)):
                break
            elif clock() >= language_ready_by:
                raise LoginRefreshError("login_language_unverified", "language_switch")
            sleep(min(max(0.05, poll_interval), remaining()))
    else:
        _set_locale_preferences(tab, locale)
    navigate(final_url, final_navigation)
    verified_after_navigation(final_state)
    progress("cookie_export")
    try:
        all_cookies = _raw_cookies(tab)
        if not _matches_locale(all_cookies, locale):
            raise LoginRefreshError("login_language_unverified", "cookie_export")
        cookies = {k: v for k, v in all_cookies.items() if k in required and isinstance(v, str) and v}
        # Preserve the original non-secret locale defaults; never synthesize tokens.
        locale_keys = {"x-hng", "magicarp_current_country", "magicarp_locale", "lc-main"}
        for key_name in required:
            if key_name not in cookies and key_name in locale_keys and isinstance(defaults.get(key_name), str):
                cookies[key_name] = defaults[key_name]
        if any(k not in cookies for k in required):
            raise LoginRefreshError("login_cookies_incomplete", "cookie_export")
    except LoginRefreshError:
        raise
    except Exception:
        raise LoginRefreshError("login_cookies_incomplete", "cookie_export") from None
    remaining()
    progress("session_save")
    try:
        _atomic_json(token_path, {"appActionToken": token})
        _atomic_json(binding_path, binding)
        # Save cookies last. An interrupted/failed refresh never replaces the cache
        # with half-written JSON or unverified credentials.
        _atomic_json(cookie_path, cookies)
    except Exception:
        raise LoginRefreshError("login_save_failed", "session_save") from None
    progress("session_refreshed")
    # Only this run's successful tab is closed. Keep the persistent browser and
    # every pre-existing tab; failure/verification tabs remain available to humans.
    try:
        tab.close()
    except Exception:
        pass
    return {"cookie_path": cookie_path, "cookies": cookies, "token_path": token_path,
            "app_action_token": token, "carrier_key": key, "browser": "chromium-drissionpage"}
