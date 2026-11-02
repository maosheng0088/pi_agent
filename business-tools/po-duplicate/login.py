"""PO duplicate checker login mapping; original credentials remain private."""
from __future__ import annotations

import importlib.util
from pathlib import Path
from types import SimpleNamespace


_helper_path = Path(__file__).resolve().parent.parent / "unit-count" / "login_refresh.py"
_spec = importlib.util.spec_from_file_location("po_duplicate_browser_login", _helper_path)
_helper = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_helper)

LoginRefreshError = _helper.LoginRefreshError
ERROR_LABELS = _helper.ERROR_LABELS
LOGIN_STAGES = _helper.LOGIN_STAGES


def refresh_account_session(account, config, deadline, on_attention=None, **kwargs):
    """Preserve original phase3 login and cookies_<raw-port>.json identity.

    `account` can be original phase1's normalized 加约存档/邮箱/... record, a
    name/email/password/port record, or raw Feishu fields described by config.
    Never import original auth/run: they contain input(), external notifications
    and development cookie fallback that must not enter a scheduled Pi job.
    """
    if not isinstance(account, dict):
        raise LoginRefreshError("login_configuration_invalid")
    try:
        source = account.get("fields", account)
        if not isinstance(source, dict):
            raise ValueError()
        name = source.get("name", source.get("加约存档", source.get(getattr(config, "ACCOUNTS_FIELD_NAME", "加约存档"))))
        email = source.get("email", source.get("邮箱", source.get(getattr(config, "ACCOUNTS_FIELD_EMAIL", "账号"))))
        password = source.get("password", source.get("密码", source.get(getattr(config, "ACCOUNTS_FIELD_PASSWORD", "密码"))))
        raw_port = source.get("port", source.get("浏览器端口", source.get(getattr(config, "ACCOUNTS_FIELD_PORT", "浏览器端口"))))
        # Original auth/cache identity is the port label, not carrier-name_port.
        label = str(raw_port).strip() if raw_port is not None else ""
        shim = SimpleNamespace(**{key: getattr(config, key) for key in (
            "COOKIES_PATH", "SIGNIN_URL", "REQUEST_URL", "HOMEV2_URL", "REQUIRED_COOKIES", "COOKIE_DEFAULTS")})
        shim.SEARCH_URL = "https://carriercentral.amazon.com/search"
        shim.carrier_key = lambda carrier: str(carrier["port"]).strip()
        normalized = {"name": name if isinstance(name, str) and name.strip() else "承运人 " + label,
                      "email": email, "password": password, "port": label}
    except Exception:
        raise LoginRefreshError("login_configuration_invalid") from None
    kwargs["locale"] = "zh_CN"
    return _helper.refresh_carrier_session(normalized, shim, deadline,
        on_attention=on_attention, **kwargs)
