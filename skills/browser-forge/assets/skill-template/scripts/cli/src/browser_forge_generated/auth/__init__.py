"""Browser-backed authentication primitives for generated skills."""

from .browser_cookies import BrowserCookieError, BrowserCookieProvider
from .cookie_jar import CookieRecord, cookie_header_for_url, cookies_for_url
from .session_store import AuthSession, SessionStore

__all__ = [
    "AuthSession",
    "BrowserCookieError",
    "BrowserCookieProvider",
    "CookieRecord",
    "SessionStore",
    "cookie_header_for_url",
    "cookies_for_url",
]
