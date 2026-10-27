#!/usr/bin/env python3
"""Deterministic local build and unsigned widget staging for TizenTube.

This script intentionally stops at `build/wgt/`. Signing requires a user-local
Tizen certificate profile and must never be committed to this repository.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
MODS = ROOT / 'mods'
STANDALONE = ROOT / 'standalone'
SERVICE = STANDALONE / 'service'
MEMBERS = [
    'config.xml',
    'index.html',
    'icon.png',
    'icon_16b9.png',
    'service/index.js',
    'service/local-proxy.js',
    'service/bounded-https.js',
    'service/userscript.js',
    'service/build.json',
]
FORBIDDEN_SUBSTRINGS = [
    'cdn.jsdelivr.net/npm',
    'api.github.com/repos',
    '/api/branding?',
    'InstallAppFromURL',
    '/cors-bypass/',
]
FORBIDDEN_REGEXES = [
    re.compile(r'/Users/[A-Za-z0-9._-]+'),
    re.compile(r'\b192\.168\.\d{1,3}\.\d{1,3}\b'),
]
FORBIDDEN_TOKEN_HASHES = {
    '57de4cf40144bdf7d00010f2f5557a7d642c2b9705309bfade167dd313e2ca93',
    '12205573eeb3019dfdd06d43becd71ba57a26c3ca614c57adb5bf4e7f8b87a21',
    'f3bc466d7a3172222cb4ff44ad364b22ae790cefa58cbcc80cd0ed29f6748c3a',
    '610f3c1e36d9a474a6fcf8e1b1d15c6dace5e32557dca84a39a3c138bb94aedd',
    '552005325c6984c17f79dbfab8eac55e2d0e52776479b29630aac5f8a45c9189',
    'c3f29928a6d11fab7e2f7663e875372f423738e02493563b25dc57b113cb3320',
    '647a09dda9e1f4cf377938ef2811dcd36074eec39ca12c44a9bafb030bc71f44',
    'd26bd47d4e0135372ea58f4218e7232740e8c81378c1be6f22aceaf06a38d8db',
}
TOKEN_SPLIT_RE = re.compile(r'[A-Za-z0-9_-]{4,}')


def check_text_clean(text: str, label: str) -> None:
    for token in FORBIDDEN_SUBSTRINGS:
        if token in text:
            sys.exit(f'Refusing to package: {label} contains {token}')
    for rx in FORBIDDEN_REGEXES:
        m = rx.search(text)
        if m:
            sys.exit(f'Refusing to package: {label} matches forbidden pattern {m.group(0)!r}')
    for word in set(TOKEN_SPLIT_RE.findall(text.lower())):
        if hashlib.sha256(word.encode('utf-8')).hexdigest() in FORBIDDEN_TOKEN_HASHES:
            sys.exit(f'Refusing to package: {label} contains forbidden internal identifier {word!r}')


def run(args, **kw):
    print('+', ' '.join(str(a) for a in args), flush=True)
    subprocess.run(args, check=True, **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--with-qa', action='store_true')
    ap.add_argument('--skip-tests', action='store_true')
    a = ap.parse_args()

    if not (MODS / 'node_modules').is_dir():
        run(['npm', 'ci', '--ignore-scripts', '--prefix', str(MODS)])
    env = dict(os.environ, TT_WITH_QA='1' if a.with_qa else '0')
    run(['npm', 'run', 'build', '--prefix', str(MODS)], env=env)

    bundle = (ROOT / 'dist/userScript.js').read_bytes()
    text = bundle.decode('utf-8', 'replace')
    check_text_clean(text, 'dist/userScript.js')
    shutil.copyfile(ROOT / 'dist/userScript.js', SERVICE / 'userscript.js')
    version = json.loads((ROOT / 'package.json').read_text()).get('version', '0')
    manifest = {
        'upstream': 'reisxd/TizenTube@f99945a84ff767bf14ad8c1146e8e3fd49a3d628',
        'version': version + ('-qa' if a.with_qa else ''),
        'userscript_sha256': hashlib.sha256(bundle).hexdigest(),
        'third_party_queries': False,
        'dynamic_code_downloads': False,
        'rate_cap_shim_max_height': 1080,
    }
    (SERVICE / 'build.json').write_text(json.dumps(manifest, indent=2) + '\n')

    if not a.skip_tests:
        run(['node', '--test', str(ROOT / 'test')])

    out = ROOT / 'build/wgt'
    if out.exists():
        shutil.rmtree(out)
    for m in MEMBERS:
        source_file = STANDALONE / m
        if m.endswith(('.xml', '.html', '.js', '.json')):
            check_text_clean(source_file.read_text('utf-8', 'replace'), m)
        (out / m).parent.mkdir(parents=True, exist_ok=True)
        shutil.copyfile(source_file, out / m)
    shutil.copyfile(ROOT / 'LICENSE', out / 'LICENSE')
    sums = {m: hashlib.sha256((out / m).read_bytes()).hexdigest() for m in MEMBERS + ['LICENSE']}
    (ROOT / 'build/package-members.json').write_text(json.dumps(sums, indent=2) + '\n')
    print('Staged', out, '\nuserscript sha256', manifest['userscript_sha256'])
    print('Next: tizen package -t wgt -s <your-profile> -- build/wgt')


if __name__ == '__main__':
    main()
