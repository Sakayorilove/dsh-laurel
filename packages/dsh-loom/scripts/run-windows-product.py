#!/usr/bin/env python3
"""WSL launch of the existing Windows product Node; no Windows development build."""
import json, os, subprocess
from pathlib import Path
root = Path(__file__).resolve().parent.parent
node = os.environ.get('LOOM_WINDOWS_NODE', '/mnt/c/Users/<你的用户>/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe')
test_path = subprocess.check_output(['wslpath', '-w', str(root / 'tests/windows-runtime-product.mjs')], text=True).strip()
result = subprocess.run([node, test_path], env=os.environ.copy(), capture_output=True, text=True, timeout=180)
print(result.stdout, end='')
print(result.stderr, end='')
if result.returncode == 0:
    evidence = json.loads(result.stdout)
    evidence['packageVersion'] = json.loads((root / 'package.json').read_text())['version']
    target = root / '.verification/windows-wsl-product.json'
    target.parent.mkdir(exist_ok=True)
    target.write_text(json.dumps(evidence, ensure_ascii=False, indent=2) + '\n')
raise SystemExit(result.returncode)
