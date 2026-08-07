"""京ME cookie discovery and a redaction-safe SSO state machine."""

from __future__ import annotations

import http.cookiejar
import base64
import hashlib
import ipaddress
import json
import os
import platform
import re
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

from .cookie_jar import CookieRecord, cookies_for_url
from .session_store import DEFAULT_TTL_SECONDS, AuthSession, SessionStore

_ERRORS = {
    "JDME_NOT_LOGGED_IN": ("京ME desktop sign-in is unavailable.", True),
    "SSO_EXCHANGE_FAILED": ("京ME SSO exchange was rejected.", True),
    "TARGET_SESSION_FAILED": ("The target session could not be established.", True),
    "TARGET_NOT_ALLOWED": ("The target is outside the manifest allowlist.", False),
    "TLS_REQUIRED": ("京ME SSO requires HTTPS for non-loopback endpoints.", False),
    "TLS_ERROR": ("京ME SSO could not establish a verified TLS connection.", False),
    "REDIRECT_SECURITY_ERROR": ("京ME SSO rejected an unsafe redirect.", False),
    "JDME_DATABASE_ERROR": ("The 京ME cookie database could not be read safely.", False),
    "JDME_DECRYPTION_ERROR": ("The 京ME cookie value could not be decrypted safely.", False),
    "JDME_DEPENDENCY_ERROR": ("京ME cookie decryption support is unavailable.", False),
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
    allow_insecure_loopback: bool = False


@dataclass(frozen=True, repr=False)
class _LocalCookie:
    name: str
    value: str
    domain: str
    path: str
    secure: bool
    expires_at: float | None


@dataclass(frozen=True)
class _RedirectEvent:
    source_url: str
    target_url: str


@dataclass(frozen=True)
class _SsaFlow:
    client_id: str
    redirect_uri: str
    state: str


_SENSITIVE_HEADERS = frozenset({
    "authorization",
    "proxy-authorization",
    "cookie",
    "functionid",
    "logintype",
    "x-device-type",
    "x-language",
    "x-sso-deviceaccountname",
    "x-sso-devicedomain",
    "x-team-id",
    "x-tenant-code",
})


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
    host = _host(url)
    if host == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _origin(url: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    scheme = parsed.scheme.lower()
    host = _host(url)
    try:
        port = parsed.port
    except ValueError:
        raise JdmeSsoError("REDIRECT_SECURITY_ERROR") from None
    if scheme not in {"http", "https"} or not host or parsed.username or parsed.password:
        raise JdmeSsoError("REDIRECT_SECURITY_ERROR")
    if port is None:
        port = 443 if scheme == "https" else 80
    return f"{scheme}://{host}:{port}"


def _check_tls(url: str, *, allow_insecure_loopback: bool = False) -> None:
    scheme = urllib.parse.urlsplit(url).scheme.lower()
    _origin(url)
    if scheme == "https":
        return
    if scheme == "http" and allow_insecure_loopback and _loopback(url):
        return
    if scheme != "https":
        raise JdmeSsoError("TLS_REQUIRED")


def _check_control(url: str, host: str, *, allow_insecure_loopback: bool) -> None:
    _check_tls(url, allow_insecure_loopback=allow_insecure_loopback)
    if _host(url) == host:
        return
    if not (allow_insecure_loopback and _loopback(url)):
        raise JdmeSsoError("TARGET_NOT_ALLOWED")


def validate_redirect_url(
    current_url: str,
    location: str,
    *,
    allowed_origins: Iterable[str],
    allow_insecure_loopback: bool,
) -> str:
    """Resolve and validate one redirect before urllib follows it."""

    target_url = urllib.parse.urljoin(current_url, location)
    current_scheme = urllib.parse.urlsplit(current_url).scheme.lower()
    target_scheme = urllib.parse.urlsplit(target_url).scheme.lower()
    if current_scheme == "https" and target_scheme != "https":
        raise JdmeSsoError("REDIRECT_SECURITY_ERROR")
    _check_tls(target_url, allow_insecure_loopback=allow_insecure_loopback)
    normalized = {_origin(item) for item in allowed_origins}
    if _origin(target_url) not in normalized:
        raise JdmeSsoError("REDIRECT_SECURITY_ERROR")
    return target_url


class _ScopedCookieProcessor(urllib.request.HTTPCookieProcessor):
    def __init__(self, cookiejar: http.cookiejar.CookieJar):
        self.set_cookie_sources: list[tuple[str, frozenset[str]]] = []
        super().__init__(cookiejar)

    def http_request(self, request):
        if getattr(request, "_jdme_forbid_cookies", False):
            return request
        return super().http_request(request)

    https_request = http_request

    def http_response(self, request, response):
        names = set()
        for header in response.headers.get_all("Set-Cookie") or ():
            name = header.split(";", 1)[0].partition("=")[0].strip()
            if name:
                names.add(name)
        result = super().http_response(request, response)
        if names:
            self.set_cookie_sources.append((request.full_url, frozenset(names)))
        return result

    https_response = http_response


class _SafeRedirects(urllib.request.HTTPRedirectHandler):
    def __init__(self, *, allowed_origins: Iterable[str], allow_insecure_loopback: bool):
        self.allowed_origins = tuple(allowed_origins)
        self.allow_insecure_loopback = allow_insecure_loopback
        self.events: list[_RedirectEvent] = []
        super().__init__()

    def redirect_request(self, request, fp, code, msg, headers, newurl):
        target_url = validate_redirect_url(
            request.full_url,
            newurl,
            allowed_origins=self.allowed_origins,
            allow_insecure_loopback=self.allow_insecure_loopback,
        )
        explicit_headers = {name.lower() for name in request.headers}
        cross_origin = _origin(request.full_url) != _origin(target_url)
        if cross_origin and explicit_headers & _SENSITIVE_HEADERS:
            raise JdmeSsoError("REDIRECT_SECURITY_ERROR")
        if getattr(request, "_jdme_sensitive_redirect", False) and code in {307, 308}:
            raise JdmeSsoError("REDIRECT_SECURITY_ERROR")

        redirected = super().redirect_request(request, fp, code, msg, headers, target_url)
        if redirected is None:
            return None
        for collection in (redirected.headers, redirected.unredirected_hdrs):
            for name in tuple(collection):
                if name.lower() in _SENSITIVE_HEADERS:
                    collection.pop(name, None)
        if getattr(request, "_jdme_sensitive_redirect", False):
            redirected._jdme_sensitive_redirect = True
        if (
            getattr(request, "_jdme_forbid_cookies", False)
            or getattr(request, "_jdme_no_redirect_jar", False)
        ):
            redirected._jdme_forbid_cookies = True
            redirected._jdme_no_redirect_jar = True
        self.events.append(_RedirectEvent(request.full_url, target_url))
        return redirected


def _decode_nested(value: str) -> list[str]:
    results = [urllib.parse.unquote(value)]
    try:
        import base64

        padded = value + "=" * (-len(value) % 4)
        results.append(base64.urlsafe_b64decode(padded).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        pass
    return results


def _nested_parameter(url: str, name: str) -> str | None:
    pending = [url]
    seen: set[str] = set()
    while pending:
        value = pending.pop(0)
        if value in seen:
            continue
        seen.add(value)
        query_text = urllib.parse.urlsplit(value).query or value.lstrip("?")
        query = urllib.parse.parse_qs(query_text)
        found = query.get(name, [""])[0]
        if found:
            return found
        for key in ("redirect_uri", "redirect"):
            for nested in query.get(key, []):
                pending.extend(_decode_nested(nested))
    return None


def _capture_ssa_flow(events: Iterable[_RedirectEvent], control_origin: str) -> _SsaFlow:
    authorize: _RedirectEvent | None = None
    login: _RedirectEvent | None = None
    for event in events:
        target = urllib.parse.urlsplit(event.target_url)
        source = urllib.parse.urlsplit(event.source_url)
        if _origin(event.target_url) == control_origin and target.path.rstrip("/") == "/oidc/authorize":
            authorize = event
        if (
            _origin(event.source_url) == control_origin
            and source.path.rstrip("/") == "/oidc/authorize"
            and _origin(event.target_url) == control_origin
            and target.path.rstrip("/") == "/sso/login"
        ):
            login = event
    if authorize is None or login is None:
        raise JdmeSsoError("TARGET_SESSION_FAILED")

    client_id = _nested_parameter(authorize.target_url, "client_id") or ""
    redirect_uri = urllib.parse.parse_qs(
        urllib.parse.urlsplit(login.target_url).query
    ).get("redirect_uri", [""])[0]
    state = _nested_parameter(login.target_url, "state") or ""
    authorize_state = _nested_parameter(authorize.target_url, "state") or ""
    if (
        not re.fullmatch(r"[A-Za-z0-9._-]{1,128}", client_id)
        or not redirect_uri
        or not state
        or (authorize_state and state != authorize_state)
    ):
        raise JdmeSsoError("TARGET_SESSION_FAILED")
    return _SsaFlow(client_id=client_id, redirect_uri=redirect_uri, state=state)


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
    access_failed = False
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
            access_failed = True
    if access_failed:
        raise JdmeSsoError("JDME_DATABASE_ERROR")
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


def _os_key(path: Path, *, system: str | None = None) -> bytes | None:
    system = platform.system() if system is None else system
    if system == "Darwin":
        return _mac_key()
    if system == "Windows":
        return _win_key(path)
    if system == "Linux":
        return hashlib.pbkdf2_hmac("sha1", b"peanuts", b"saltysalt", 1, 16)
    return None


def decrypt_cookie(
    value: bytes,
    path: Path,
    *,
    system: str | None = None,
    host_key: str | None = None,
    db_version: int | None = None,
) -> str | None:
    """Decrypt Chromium v10 cookies with the current platform's format."""

    if not value:
        return None
    if not value.startswith(b"v10"):
        try:
            return value.decode("utf-8")
        except UnicodeDecodeError:
            return None
    system = platform.system() if system is None else system
    key = _os_key(path, system=system)
    if key is None:
        raise JdmeSsoError("JDME_DECRYPTION_ERROR")
    try:
        from cryptography.hazmat.primitives import padding
        from cryptography.hazmat.primitives.ciphers import Cipher, algorithms, modes
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    except ImportError:
        raise JdmeSsoError("JDME_DEPENDENCY_ERROR") from None
    try:
        payload = value[3:]
        if system == "Windows":
            if len(payload) < 28:
                raise ValueError("invalid GCM payload")
            plaintext = AESGCM(key).decrypt(payload[:12], payload[12:], None)
        elif system in {"Darwin", "Linux"}:
            if not payload or len(payload) % 16:
                raise ValueError("invalid CBC payload")
            decryptor = Cipher(algorithms.AES(key), modes.CBC(b" " * 16)).decryptor()
            padded = decryptor.update(payload) + decryptor.finalize()
            unpadder = padding.PKCS7(128).unpadder()
            plaintext = unpadder.update(padded) + unpadder.finalize()
            if db_version is not None and db_version >= 24 and host_key:
                digest = hashlib.sha256(host_key.encode("utf-8")).digest()
                if not plaintext.startswith(digest):
                    raise ValueError("invalid host digest")
                plaintext = plaintext[len(digest):]
        else:
            raise ValueError("unsupported platform")
        return plaintext.decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        raise JdmeSsoError("JDME_DECRYPTION_ERROR") from None


def _cookie_expiry(value: Any) -> float | None:
    if not value:
        return None
    try:
        expiry = float(value)
    except (TypeError, ValueError):
        return None
    if expiry <= 0:
        return None
    if expiry > 20_000_000_000:
        expiry = expiry / 1_000_000 - 11_644_473_600
    return expiry


def _read_local(
    path: Path,
    decrypt: Callable[[bytes, Path], str | None],
    *,
    now: float,
) -> list[_LocalCookie]:
    try:
        with open_jdme_db(path) as db:
            try:
                db_version = int(db.execute("SELECT value FROM meta WHERE key = 'version'").fetchone()[0])
            except (TypeError, ValueError, sqlite3.Error):
                db_version = None
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
        normalized_domain = str(domain or "").lstrip(".").rstrip(".").lower()
        normalized_path = str(path_value or "/")
        expires_at = _cookie_expiry(expires_value)
        if (
            not _allowed(normalized_domain, ("jd.com",))
            or not normalized_path.startswith("/")
            or not bool(secure_value)
            or (expires_at is not None and expires_at <= now)
        ):
            continue
        value = str(plain or "")
        if not value and encrypted:
            try:
                try:
                    value = decrypt(bytes(encrypted), path, host_key=str(domain or ""), db_version=db_version) or ""
                except TypeError:
                    value = decrypt(bytes(encrypted), path) or ""
            except JdmeSsoError:
                raise
            except Exception:
                raise JdmeSsoError("JDME_DECRYPTION_ERROR") from None
            if not value:
                raise JdmeSsoError("JDME_DECRYPTION_ERROR")
        if value:
            if "\r" in value or "\n" in value:
                raise JdmeSsoError("JDME_DATABASE_ERROR")
            found.append(_LocalCookie(
                name=str(name),
                value=value,
                domain=str(domain).rstrip("."),
                path=normalized_path,
                secure=bool(secure_value),
                expires_at=expires_at,
            ))
    return found


def _tls_context() -> ssl.SSLContext:
    """Build a verifying TLS context that survives an empty system CA store.

    A bare Python install (e.g. python.org builds before running
    ``Install Certificates.command``) points at a CA file that does not exist,
    so every HTTPS handshake fails with ``CERTIFICATE_VERIFY_FAILED`` even
    though the certificates are valid. We keep verification ON — never disable
    it — but when the default trust store loads no certificates we fall back to
    ``certifi``'s bundle. ``SSL_CERT_FILE``/``SSL_CERT_DIR`` still take
    precedence because ``create_default_context`` honours them first.
    """

    context = ssl.create_default_context()
    try:
        loaded = context.cert_store_stats().get("x509_ca", 0)
    except Exception:
        loaded = 0
    if loaded == 0 and not (os.environ.get("SSL_CERT_FILE") or os.environ.get("SSL_CERT_DIR")):
        try:
            import certifi

            context.load_verify_locations(cafile=certifi.where())
        except Exception:
            pass
    return context


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


def _jar_cookie(
    item: _LocalCookie,
    *,
    test_domain: str | None = None,
    insecure_test_transport: bool = False,
) -> "http.cookiejar.Cookie":
    domain = test_domain or item.domain
    domain_specified = test_domain is None and item.domain.startswith(".")
    return http.cookiejar.Cookie(
        version=0,
        name=item.name,
        value=item.value,
        port=None,
        port_specified=False,
        domain=domain,
        domain_specified=domain_specified,
        domain_initial_dot=domain.startswith("."),
        path=item.path,
        path_specified=True,
        secure=item.secure and not insecure_test_transport,
        expires=int(item.expires_at) if item.expires_at is not None else None,
        discard=item.expires_at is None,
        comment=None,
        comment_url=None,
        rest={"HttpOnly": None},
        rfc2109=False,
    )


def _url_records(
    jar: http.cookiejar.CookieJar,
    url: str,
    *,
    now: float,
) -> tuple[CookieRecord, ...]:
    return tuple(cookies_for_url([_record(item) for item in jar], url, now=now))


def _add_query(url: str, **values: str) -> str:
    parsed = urllib.parse.urlsplit(url)
    query = urllib.parse.parse_qsl(parsed.query, keep_blank_values=True)
    query.extend(values.items())
    return urllib.parse.urlunsplit(parsed._replace(query=urllib.parse.urlencode(query)))


def _login_url(url: str, control_origin: str) -> bool:
    parsed = urllib.parse.urlsplit(url)
    return _origin(url) == control_origin and parsed.path.rstrip("/") == "/sso/login"


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
        allow_loopback = self.endpoints.allow_insecure_loopback
        _check_tls(target_url, allow_insecure_loopback=allow_loopback)
        _check_control(
            self.endpoints.get_code_url,
            "api.m.jd.com",
            allow_insecure_loopback=allow_loopback,
        )
        _check_control(
            self.endpoints.union_login_url,
            "ssa.jd.com",
            allow_insecure_loopback=allow_loopback,
        )
        probe_url = self.endpoints.probe_url or target_url
        _check_tls(probe_url, allow_insecure_loopback=allow_loopback)
        if (
            not _allowed(_host(probe_url), self.allowed_domains)
            or _origin(probe_url) != _origin(target_url)
        ):
            raise JdmeSsoError("TARGET_NOT_ALLOWED")

        if force_refresh:
            self.store.delete(target_url)
        else:
            cached = self.store.load(target_url)
            if cached is not None:
                return cached

        try:
            db_path = self.find_db()
        except JdmeSsoError:
            raise
        except (OSError, sqlite3.Error):
            raise JdmeSsoError("JDME_DATABASE_ERROR") from None
        if db_path is None:
            raise JdmeSsoError("JDME_NOT_LOGGED_IN")
        try:
            if not Path(db_path).is_file():
                raise JdmeSsoError("JDME_NOT_LOGGED_IN")
        except OSError:
            raise JdmeSsoError("JDME_DATABASE_ERROR") from None
        local = _read_local(Path(db_path), self.decryptor, now=self.now())
        token = next((item.value for item in local if item.name == "me_token"), "")
        if not token:
            raise JdmeSsoError("JDME_NOT_LOGGED_IN")

        jar = http.cookiejar.CookieJar()
        test_domain = _host(self.endpoints.get_code_url) if allow_loopback else None
        insecure_test_transport = (
            allow_loopback
            and urllib.parse.urlsplit(self.endpoints.get_code_url).scheme.lower() == "http"
        )
        for item in local:
            jar.set_cookie(_jar_cookie(
                item,
                test_domain=test_domain,
                insecure_test_transport=insecure_test_transport,
            ))
        allowed_origins = {
            _origin(target_url),
            _origin(self.endpoints.get_code_url),
            _origin(self.endpoints.union_login_url),
            _origin(probe_url),
        }
        redirects = _SafeRedirects(
            allowed_origins=allowed_origins,
            allow_insecure_loopback=allow_loopback,
        )
        cookie_processor = _ScopedCookieProcessor(jar)
        https_handler = urllib.request.HTTPSHandler(context=_tls_context())
        opener = urllib.request.build_opener(cookie_processor, redirects, https_handler)

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
            "X-Sso-DeviceAccountName": device["account"],
            "X-Sso-DeviceDomain": "360BUYAD",
            "functionId": "eopen.getCode",
            "loginType": "15",
            "x-device-type": client,
            "x-language": "zh_CN",
            "x-team-id": next((item.value for item in local if item.name == "focus-team-id"), ""),
            "x-tenant-code": "CN.JD.GROUP",
        }
        request = urllib.request.Request(
            self.endpoints.get_code_url,
            data=form,
            headers=headers,
            method="POST",
        )
        request._jdme_sensitive_redirect = True
        request._jdme_no_redirect_jar = True
        status, _, body = _response(opener, request, "SSO_EXCHANGE_FAILED")
        try:
            payload: Any = json.loads(body.decode("utf-8"))
            auth_code = payload["data"]["code"] if payload.get("code") == 0 else ""
        except (KeyError, TypeError, ValueError, UnicodeDecodeError):
            auth_code = ""
        if status < 200 or status >= 300 or not auth_code:
            raise JdmeSsoError("SSO_EXCHANGE_FAILED")

        discovery_start = len(redirects.events)
        target_req = urllib.request.Request(target_url, method="GET")
        status, final_url, _ = _response(opener, target_req, "TARGET_SESSION_FAILED")
        control_origin = _origin(self.endpoints.union_login_url)
        if status < 200 or status >= 300 or not _login_url(final_url, control_origin):
            raise JdmeSsoError("TARGET_SESSION_FAILED")
        flow = _capture_ssa_flow(redirects.events[discovery_start:], control_origin)

        union_form = urllib.parse.urlencode({
            "jme_auth_code": auth_code,
            "name": "sL5qtKu71X8H25ysaaHB",
            "source": "ssa",
        }).encode("utf-8")
        before_union = {
            (item.name, item.domain, item.path): item.value
            for item in _url_records(jar, target_url, now=self.now())
        }
        union_start = len(redirects.events)
        cookie_source_start = len(cookie_processor.set_cookie_sources)
        union_url = _add_query(self.endpoints.union_login_url, redirect_uri=flow.redirect_uri)
        union_req = urllib.request.Request(
            union_url,
            data=union_form,
            headers={
                "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
                "Origin": control_origin,
                "Referer": final_url,
            },
            method="POST",
        )
        union_req._jdme_sensitive_redirect = True
        status, final_url, _ = _response(opener, union_req, "SSO_EXCHANGE_FAILED")
        if status < 200 or status >= 300:
            union_path = urllib.parse.urlsplit(self.endpoints.union_login_url).path
            final_path = urllib.parse.urlsplit(final_url).path
            code = "SSO_EXCHANGE_FAILED" if final_path == union_path else "TARGET_SESSION_FAILED"
            raise JdmeSsoError(code)
        if not any(item.name == "sso.jd.com" for item in jar):
            raise JdmeSsoError("SSO_EXCHANGE_FAILED")

        target_origin = _origin(target_url)
        union_events = redirects.events[union_start:]
        callback_seen = any(_origin(event.target_url) == target_origin for event in union_events)
        target_cookie_name = "ssa." + flow.client_id
        callback_set_cookie = any(
            _origin(source_url) == target_origin and target_cookie_name in names
            for source_url, names in cookie_processor.set_cookie_sources[cookie_source_start:]
        )
        records = _url_records(jar, target_url, now=self.now())
        new_session_records = tuple(
            item
            for item in records
            if item.name == target_cookie_name
            and before_union.get((item.name, item.domain, item.path)) != item.value
        )

        probe_start = len(redirects.events)
        probe_req = urllib.request.Request(probe_url, method="GET")
        status, final_url, _ = _response(opener, probe_req, "TARGET_SESSION_FAILED")
        probe_events = redirects.events[probe_start:]
        probe_records = _url_records(jar, probe_url, now=self.now())
        if (
            status < 200
            or status >= 300
            or _origin(final_url) != target_origin
            or _login_url(final_url, control_origin)
            or any(_login_url(event.target_url, control_origin) for event in probe_events)
            or not callback_seen
            or not callback_set_cookie
            or not new_session_records
            or not any(item.name == target_cookie_name for item in probe_records)
        ):
            raise JdmeSsoError("TARGET_SESSION_FAILED")

        expiries = [item.expires_at for item in new_session_records if item.expires_at is not None]
        expires_at = self.now() + self.ttl_seconds
        if expiries:
            expires_at = min(expires_at, *expiries)
        session = AuthSession(
            provider="jdme_sso",
            target_url=target_url,
            cookie_jar=new_session_records,
            fallback_used=False,
            expires_at=expires_at,
        )
        self.store.save(session)
        return session
