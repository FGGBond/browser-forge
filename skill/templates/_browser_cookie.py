#!/usr/bin/env python3
# _browser_cookie.py — 从本机 Edge/Chrome 提取目标域名的 Cookie
#
# 用法: python3 _browser_cookie.py --domain example.jd.com
# 输出: Cookie header 字符串（stdout），如 "key1=val1; key2=val2"
#
# 产出 skill 时，Agent 应基于录制物料中识别的目标域名，
# 实现对应的 Cookie 提取逻辑。参考 knowledge/auth-patterns.md 方案二。

import argparse, sys, os, sqlite3, shutil, tempfile

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--domain', required=True, help='目标域名，如 example.jd.com')
    args = parser.parse_args()

    cookie_header = extract_cookies(args.domain)
    if not cookie_header:
        print(f"未找到域名 {args.domain} 的 Cookie，请确认已在 Edge/Chrome 中登录", file=sys.stderr)
        sys.exit(1)
    print(cookie_header)

def extract_cookies(domain):
    # macOS Edge Cookie 路径
    edge_path = os.path.expanduser("~/Library/Application Support/Microsoft Edge/Default/Cookies")
    chrome_path = os.path.expanduser("~/Library/Application Support/Google/Chrome/Default/Cookies")

    for db_path in [edge_path, chrome_path]:
        if not os.path.exists(db_path):
            continue
        try:
            # 复制数据库避免文件锁
            with tempfile.NamedTemporaryFile(suffix='.db', delete=False) as tmp:
                shutil.copy2(db_path, tmp.name)
                tmp_path = tmp.name
            conn = sqlite3.connect(tmp_path)
            cursor = conn.execute(
                "SELECT name, value FROM cookies WHERE host_key LIKE ?",
                (f'%{domain}%',)
            )
            cookies = {row[0]: row[1] for row in cursor.fetchall()}
            conn.close()
            os.unlink(tmp_path)
            if cookies:
                return '; '.join(f'{k}={v}' for k, v in cookies.items())
        except Exception as e:
            print(f"读取 {db_path} 失败: {e}", file=sys.stderr)
    return None

if __name__ == '__main__':
    main()
