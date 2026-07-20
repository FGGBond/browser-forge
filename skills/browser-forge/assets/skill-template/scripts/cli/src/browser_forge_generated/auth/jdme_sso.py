"""京ME cookie discovery and a redaction-safe SSO state machine."""

from __future__ import annotations

import http.cookiejar
import base64
import hashlib
import json
import os
import platform
import ssl
import sqlite3
import subprocess
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .cookie_jar import CookieRecord, cookies_for_host
from .session_store import DEFAULT_TTL_SECONDS, AuthSession, SessionStore

_ERRORS = {
    "JDME_NOT_LOGGED_IN": ("京ME desktop sign-in is unavailable.", True),
    "SSO_EXCHANGE_FAILED": ("京ME SSO exchange was rejected.", True),
    "TARGET_SESSION_FAILED": ("The target session could not be established.", True),
    "TARGET_NOT_ALLOWED": ("The target is outside the manifest allowlist.", False),
    "TLS_REQUIRED": ("京ME SSO requires HTTPS for non-loopback endpoints.", False),
    "TLS_ERROR": ("京ME SSO could not establish a verified TLS connection.", False),
    "JDME_DATABASE_ERROR": ("The 京ME cookie database could not be read safely.", False),
    "JDME_DECRYPTION_ERROR": ("The 京ME cookie value could not be decrypted safely.", False),
}


class JdmeSsoError(RuntimeError):
    def __init__(self, code: str):
        message, recoverable = _ERRORS.get(code, ("京ME SSO failed.", False))
        super().__init__(message)
        self.code = code
        self.recoverable = recoverable
        self.remediation = "Sign in to 京ME and retry with --refresh-auth."


@dataclass(frozen=True)
class JdmeEndpoints:
    get_code_url: str = "https://api.m.jd.com/api/?functionId=eopen.getCode"
    union_login_url: str = "https://ssa.jd.com/sso/jdmeUnionLogin"
    probe_url: str | None = None


@dataclass(frozen=True, repr=False)
class _LocalCookie:
    name: str
    value: str
    domain: str
    path: str
    secure: bool
    expires_at: float | None


class _Redirects(urllib.request.HTTPRedirectHandler):
    def __init__(self):
        self.urls: list[str] = []
        super().__init__()

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        self.urls.append(urllib.parse.urljoin(request.full_url, newurl))
        return super().redirect_request(request, fp, code, msg, headers, newurl)


def _host(value: str) -> str:
    return (urllib.parse.urlsplit(value).hostname or "").rstrip(".").lower()


def _allowed(host: str, domains: Iterable[str]) -> bool:
    for item in domains:
        text = str(item).strip().lower()
        domain = _host(text if "://" in text else "//" + text)
        if domain and (host == domain or host.endswith("." + domain)):
            return True
    return False


def _loopback(url: str) -> bool:
    return _host(url) in {"127.0.0.1", "::1", "localhost"}


def _check_tls(url: str) -> None:
    if urllib.parse.urlsplit(url).scheme.lower() != "https" and not _loopback(url):
        raise JdmeSsoError("TLS_REQUIRED")


def _check_control(url: str, host: str) -> None:
    _check_tls(url)
    if _host(url) != host and not _loopback(url):
        raise JdmeSsoError("TARGET_NOT_ALLOWED")


def _decode_nested(value: str) -> list[str]:
    results = [urllib.parse.unquote(value)]
    try:
        import base64

        padded = value + "=" * (-len(value) % 4)
        results.append(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        pass
    return results


def discover_client_id(urls: Iterable[str]) -> str | None:
    """Discover an OIDC client ID from redirect URLs, including encoded URIs."""

    pending = list(urls)
    seen: set[str] = set()
    while pending:
        url = pending.pop(0)
        if url in seen:
            continue
        seen.add(url)
        query = urllib.parse.parse_qs(urllib.parse.urlsplit(url).query)
        if query.get("client_id", [""])[0]:
            return query["client_id"][0]
        for key in ("redirect_uri", "redirect"):
            for value in query.get(key, []):
                pending.extend(_decode_nested(value))
    return None


def db_candidates(
    *,
    home: Path | None = None,
    system: str | None = None,
    environ: dict[str, str] | os._Environ[str] | None = None,
    wsl_users: Iterable[Path] | None = None,
) -> tuple[Path, ...]:
    """Return deterministic JDME Chromium cookie locations for this user."""

    home = Path.home() if home is None else Path(home)
    system = platform.system() if system is None else system
    environ = os.environ if environ is None else environ
    roots: list[Path] = []
    if system == "Darwin":
        roots.append(home / "Library" / "Application Support")
    elif system == "Windows":
        for key in ("APPDATA", "LOCALAPPDATA"):
            if environ.get(key):
                roots.append(Path(environ[key]))
        roots.extend((home / "AppData" / "Roaming", home / "AppData" / "Local"))
    else:
        if environ.get("XDG_CONFIG_HOME"):
            roots.append(Path(environ["XDG_CONFIG_HOME"]))
        roots.append(home / ".config")
        users = list(wsl_users or ())
        if not users and environ.get("WSL_DISTRO_NAME"):
            for drive in Path("/mnt").glob("*"):
                directory = drive / "Users"
                try:
                    users.extend(path for path in directory.iterdir() if path.is_dir())
                except (OSError, PermissionError):
                    continue
        for user in users:
            roots.extend((Path(user) / "AppData" / "Roaming", Path(user) / "AppData" / "Local"))

    apps = ("ME", "ME Meeting", "com.jd.me", "JDME", "jdme", "京ME")
    subs = ("Cookies", "Network/Cookies", "Default/Cookies", "Default/Network/Cookies")
    paths: list[Path] = []
    for root in roots:
        for app in apps:
            for sub in subs:
                path = root / app / sub
                if path not in paths:
                    paths.append(path)
    return tuple(paths)


def open_jdme_db(path: Path) -> sqlite3.Connection:
    """Open a Chromium DB in immutable read-only mode to avoid client locks."""

    uri = path.resolve().as_uri() + "?mode=ro&immutable=1"
    return sqlite3.connect(uri, uri=True)


def find_jdme_db(candidates: Iterable[Path] | None = None) -> Path | None:
    paths = db_candidates() if candidates is None else candidates
    for path in paths:
        try:
            if not path.is_file():
                continue
            with open_jdme_db(path) as db:
                row = db.execute(
                    "SELECT 1 FROM cookies WHERE name = 'me_token' LIMIT 1"
                ).fetchone()
            if row is not None:
                return path
        except (OSError, sqlite3.Error):
            continue
    return None


def _mac_key() -> bytes | None:
    for service in ("ME Safe Storage", "JDME Safe Storage", "Chromium Safe Storage"):
        try:
            result = subprocess.run(
                ["security", "find-generic-password", "-s", service, "-w"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
        except (OSError, subprocess.SubprocessError):
            continue
        if result.returncode == 0 and result.stdout.strip():
            return hashlib.pbkdf2_hmac(
                "sha1", result.stdout.strip().encode("utf-8"), b"saltysalt", 1003, 16
            )
    return None


def _dpapi(data: bytes) -> bytes | None:
    try:
        import ctypes
        import ctypes.wintypes

        class Blob(ctypes.Structure):
            _fields_ = [
                ("size", ctypes.wintypes.DWORD),
                ("data", ctypes.POINTER(ctypes.c_char)),
            ]

        source = ctypes.create_string_buffer(data)
        incoming = Blob(len(data), ctypes.cast(source, ctypes.POINTER(ctypes.c_char)))
        outgoing = Blob()
        ok = ctypes.windll.crypt32.CryptUnprotectData(
            ctypes.byref(incoming), None, None, None, None, 0, ctypes.byref(outgoing)
        )
        if not ok:
            return None
        value = ctypes.string_at(outgoing.data, outgoing.size)
        ctypes.windll.kernel32.LocalFree(outgoing.data)
        return value
    except (AttributeError, OSError, ValueError):
        return None


def _win_key(path: Path) -> bytes | None:
    directory = path.parent
    for _ in range(6):
        state = directory / "Local State"
        try:
            encoded = json.loads(state.read_text(encoding="utf-8"))["os_crypt"]["encrypted_key"]
            raw = base64.b64decode(encoded)
            return _dpapi(raw[5:] if raw.startswith(b"DPAPI") else raw)
        except (OSError, KeyError, TypeError, ValueError, json.JSONDecodeError):
            pass
        if directory.parent == directory:
            break
        directory = directory.parent
    return None


def _os_key(path: Path) -> bytes | None:
    system = platform.system()
    if system == "Darwin":
        return _mac_key()
    if system == "Windows":
        return _win_key(path)
    return hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1, 16)


def decrypt_cookie(value: bytes, path: Path) -> str | None:
    """Decrypt a Chromium v10 value using only the current user's OS key."""

    if not value:
        return None
    if not value.startswith(b"v10"):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return None
    key = _os_key(path)
    if key is None:
        return None
    try:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        payload = value[3:]
        return AESGCM(key).decrypt(payload[:12], payload[12:], None).decode("utf-8")
    except (ImportError, ValueError, UnicodeDecodeError):
        return None


def _read_local(path: Path, decrypt: Callable[[bytes, Path], str | None]) -> list[_LocalCookie]:
    try:
        with open_jdme_db(path) as db:
            columns = {row[1] for row in db.execute("PRAGMA table_info(cookies)")}
            secure = "is_secure" if "is_secure" in columns else "secure"
            expires = "expires_utc" if "expires_utc" in columns else "expires"
            rows = db.execute(
                f"SELECT name, value, encrypted_value, host_key, path, {secure}, {expires} "
                "FROM cookies WHERE name IN ('me_token', 'focus-team-id', 'jdsec_client_info')"
            ).fetchall()
    except (OSError, sqlite3.Error):
        raise JdmeSsoError("JDME_DATABASE_ERROR") from None

    found = []
    for name, plain, encrypted, domain, path_value, secure_value, expires_value in rows:
        value = str(plain or "")
        if not value and encrypted:
            try:
                value = decrypt(bytes(encrypted), path) or ""
            except Exception:
                raise JdmeSsoError("JDME_DECRYPTION_ERROR") from None
        if value:
            found.append(_LocalCookie(
                name=str(name),
                value=value,
                domain=str(domain),
                path=str(path_value or "/"),
                secure=bool(secure_value),
                expires_at=float(expires_value) if expires_value else None,
            ))
    return found


def _response(
    opener,
    request: urllib.request.Request,
    error_code: str,
) -> tuple[int, str, bytes]:
    try:
        with opener.open(request, timeout=30) as response:
            return response.status, response.geturl(), response.read()
    except urllib.error.HTTPError as error:
        return error.code, error.geturl(), error.read()
    except urllib.error.URLError as error:
        if isinstance(error.reason, ssl.SSLError):
            raise JdmeSsoError("TLS_ERROR") from None
        raise JdmeSsoError(error_code) from None
    except OSError:
        raise JdmeSsoError(error_code) from None


def _device(path: Path) -> dict[str, str]:
    info = {
        "account": os.environ.get("USER", os.environ.get("USERNAME", "")),
        "uuid": "",
        "eid": "",
    }
    directory = path.parent
    for _ in range(5):
        for filename, source, target in (
            ("global.json", "DeviceId", "uuid"),
            ("login.json", "KEY_RISK_JS_EID", "eid"),
        ):
            try:
                value = json.loads((directory / filename).read_text(encoding="utf-8")).get(source, "")
                if value:
                    info[target] = str(value)
            except (OSError, TypeError, ValueError, json.JSONDecodeError):
                pass
        if directory.parent == directory:
            break
        directory = directory.parent
    return info


def _os_info() -> tuple[str, str]:
    system = platform.system()
    if system == "Darwin":
        return "mac", "Mac.local"
    if system == "Windows":
        return "windows", "Win.local"
    return "linux", "Linux.local"


def _record(item: http.cookiejar.Cookie) -> CookieRecord:
    return CookieRecord(
        name=item.name,
        value=item.value,
        domain=item.domain,
        path=item.path or "/",
        secure=bool(item.secure),
        expires_at=item.expires,
        host_only=not item.domain_specified,
    )


class JdmeSsoProvider:
    def __init__(
        self,
        skill_id: str,
        *,
        allowed_domains: tuple[str, ...] | list[str],
        endpoints: JdmeEndpoints | None = None,
        cookie_db_finder: Callable[[], Path | None] | None = None,
        decryptor: Callable[[bytes, Path], str | None] | None = None,
        cache_root: str | Path | None = None,
        ttl_seconds: int = DEFAULT_TTL_SECONDS,
        now: Callable[[], float] = time.time,
    ):
        self.skill_id = skill_id
        self.allowed_domains = tuple(allowed_domains)
        self.endpoints = endpoints or JdmeEndpoints()
        self.find_db = cookie_db_finder or find_jdme_db
        self.decryptor = decryptor or decrypt_cookie
        self.ttl_seconds = ttl_seconds
        self.now = now
        self.store = SessionStore(
            skill_id,
            {"provider": "jdme_sso", "domains": list(self.allowed_domains)},
            root=cache_root,
            ttl_seconds=ttl_seconds,
            now=now,
        )

    def resolve(self, target_url: str, force_refresh: bool = False) -> AuthSession:
        target_host = _host(target_url)
        if not _allowed(target_host, self.allowed_domains):
            raise JdmeSsoError("TARGET_NOT_ALLOWED")
        _check_tls(target_url)
        _check_control(self.endpoints.get_code_url, "api.m.jd.com")
        _check_control(self.endpoints.union_login_url, "ssa.jd.com")
        probe_url = self.endpoints.probe_url or target_url
        _check_tls(probe_url)
        if not _allowed(_host(probe_url), self.allowed_domains):
            raise JdmeSsoError("TARGET_NOT_ALLOWED")

        if force_refresh:
            self.store.delete(target_url)
        else:
            cached = self.store.load(target_url)
            if cached is not None:
                return cached

        db_path = self.find_db()
        if db_path is None or not Path(db_path).is_file():
            raise JdmeSsoError("JDME_NOT_LOGGED_IN")
        local = _read_local(Path(db_path), self.decryptor)
        token = next((item.value for item in local if item.name == "me_token"), "")
        if not token:
            raise JdmeSsoError("JDME_NOT_LOGGED_IN")

        device = _device(Path(db_path))
        client, brand = _os_info()
        request_id = uuid.uuid4().hex[:20]
        body_value = json.dumps(
            {"appKey": "sL5qtKu71X8H25ysaaHB", "requestId": request_id, "jdmeAppId": "ee"},
            separators=(",", ":"),
        )
        form = urllib.parse.urlencode({
            "appName": "JDME",
            "appid": "JDME_DESKTOP",
            "body": body_value,
            "client": client,
            "clientVersion": "7.20.64",
            "d_brand": brand,
            "d_model": "",
            "eid": device["eid"],
            "functionId": "eopen.getCode",
            "lang": "zh_CN",
            "loginType": "15",
            "networkType": "unknown",
            "osVersion": "",
            "t": str(int(self.now() * 1000)),
            "uuid": device["uuid"] or uuid.uuid4().hex,
        }).encode("utf-8")
        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Cookie": "; ".join(f"{item.name}={item.value}" for item in local),
            "X-Sso-DeviceAccountName": device["account"],
            "X-Sso-DeviceDomain": "360BUYAD",
            "functionId": "eopen.getCode",
            "loginType": "15",
            "x-device-type": client,
            "x-language": "zh_CN",
            "x-team-id": next((item.value for item in local if item.name == "focus-team-id"), ""),
            "x-tenant-code": "CN.JD.GROUP",
        }
        plain = urllib.request.build_opener()
        request = urllib.request.Request(
            self.endpoints.get_code_url,
            data=form,
            headers=headers,
            method="POST",
        )
        status, _, body = _response(plain, request, "SSO_EXCHANGE_FAILED")
        try:
            payload: Any = json.loads(body.decode("utf-8"))
            auth_code = payload["data"]["code"] if payload.get("code") == 0 else ""
        except (KeyError, TypeError, ValueError, UnicodeDecodeError):
            auth_code = ""
        if status < 200 or status >= 300 or not auth_code:
            raise JdmeSsoError("SSO_EXCHANGE_FAILED")

        jar = http.cookiejar.CookieJar()
        redirects = _Redirects()
        opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar), redirects)
        redirects.urls.clear()
        target_req = urllib.request.Request(target_url, method="GET")
        status, final_url, _ = _response(opener, target_req, "TARGET_SESSION_FAILED")
        if status < 200 or status >= 400:
            raise JdmeSsoError("TARGET_SESSION_FAILED")
        client_id = discover_client_id([target_url, *redirects.urls, final_url])
        if not client_id:
            raise JdmeSsoError("TARGET_SESSION_FAILED")

        union_form = urllib.parse.urlencode({
            "jme_auth_code": auth_code,
            "name": "sL5qtKu71X8H25ysaaHB",
            "source": "ssa",
            "client_id": client_id,
        }).encode("utf-8")
        redirects.urls.clear()
        union_req = urllib.request.Request(
            self.endpoints.union_login_url,
            data=union_form,
            headers={"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8"},
            method="POST",
        )
        status, final_url, _ = _response(opener, union_req, "SSO_EXCHANGE_FAILED")
        if status < 200 or status >= 300:
            union_path = urllib.parse.urlsplit(self.endpoints.union_login_url).path
            final_path = urllib.parse.urlsplit(final_url).path
            code = "SSO_EXCHANGE_FAILED" if final_path == union_path else "TARGET_SESSION_FAILED"
            raise JdmeSsoError(code)
        if not any(item.name == "sso.jd.com" for item in jar):
            raise JdmeSsoError("SSO_EXCHANGE_FAILED")

        probe_req = urllib.request.Request(probe_url, method="GET")
        status, final_url, _ = _response(opener, probe_req, "TARGET_SESSION_FAILED")
        if status < 200 or status >= 300 or "ssa.jd.com/sso/login" in final_url:
            raise JdmeSsoError("TARGET_SESSION_FAILED")

        records = tuple(cookies_for_host([_record(item) for item in jar], target_url, now=self.now()))
        if not records:
            raise JdmeSsoError("TARGET_SESSION_FAILED")
        expiries = [item.expires_at for item in records if item.expires_at is not None]
        expires_at = self.now() + self.ttl_seconds
        if expiries:
            expires_at = min(expires_at, *expiries)
        session = AuthSession(
            provider="jdme_sso",
            target_url=target_url,
            cookie_jar=records,
            fallback_used=False,
            expires_at=expires_at,
        )
        self.store.save(session)
        return session
