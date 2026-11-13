"""Rebuild the pinned, restricted libtiff artifact outside the checkout."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess
import hashlib
import base64
import json
import re

parser = argparse.ArgumentParser()
parser.add_argument('--emsdk', required=True, type=Path)
parser.add_argument('--libtiff', required=True, type=Path)
parser.add_argument('--cmake', default='cmake')
parser.add_argument('--ninja', default='ninja')
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
root = args.output.resolve()
root.mkdir(parents=True, exist_ok=True)
repo = Path(__file__).resolve().parent.parent
sdk = args.emsdk.resolve()
source = args.libtiff.resolve()
env = dict(os.environ, EM_CONFIG=str(sdk / '.emscripten'))
emscripten = sdk / 'upstream/emscripten'
python = shutil.which('python') or 'python'

def run(*command):
    subprocess.run([str(part) for part in command], check=True, env=env)

version = subprocess.check_output([python, str(emscripten / 'emcc.py'), '--version'], text=True, env=env)
if not re.search(r'\b4\.0\.22\b', version):
    raise SystemExit('Expected Emscripten 4.0.22')

revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
if revision != 'd01a94be176f5f6a87f7ee1c0b32e65416aa2b4d':
    raise SystemExit('Expected libtiff v4.7.2 commit d01a94be176f5f6a87f7ee1c0b32e65416aa2b4d')
shutil.copy2(repo / 'wasm/libtiff/hyve_tiff.c', root / 'hyve_tiff.c')
probe = root / 'probe_z.c'
probe.write_text('#include <zlib.h>\nint main(void) { return zlibVersion()[0]; }\n')
run(python, emscripten / 'emcc.py', '--use-port=zlib', '-O2', '-c', probe, '-o', root / 'probe_z.o')
disabled = ('ccitt', 'thunder', 'next', 'logluv', 'mdi', 'pixarlog', 'libdeflate', 'jpeg', 'old-jpeg',
            'jbig', 'lerc', 'lzma', 'zstd', 'webp', 'tiff-tools', 'tiff-tests', 'tiff-docs',
            'tiff-contrib', 'tiff-install', 'tiff-cxx')
sysroot = emscripten / 'cache/sysroot'
run(python, emscripten / 'emcmake.py', args.cmake, '-S', source, '-B', root / 'build', '-G', 'Ninja',
    f'-DCMAKE_MAKE_PROGRAM={Path(args.ninja).resolve() if Path(args.ninja).exists() else args.ninja}',
    '-DCMAKE_BUILD_TYPE=Release', '-DCMAKE_C_FLAGS_RELEASE=-O3', '-DBUILD_SHARED_LIBS=OFF',
    '-Dzlib=ON', f'-DZLIB_INCLUDE_DIR={sysroot / "include"}',
    f'-DZLIB_LIBRARY={sysroot / "lib/wasm32-emscripten/libz.a"}',
    *(f'-D{feature}=OFF' for feature in disabled))
run(args.cmake, '--build', root / 'build', '--parallel', '8')
run(python, emscripten / 'emcc.py', root / 'hyve_tiff.c', root / 'build/libtiff/libtiff.a',
    '--use-port=zlib', '-O3', '-I', source / 'libtiff', '-I', root / 'build/libtiff',
    '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=web,worker', '-sFILESYSTEM=0',
    '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=2097152', '-sMAXIMUM_MEMORY=134217728',
    '-sMEMORY_GROWTH_GEOMETRIC_STEP=0', '-sMEMORY_GROWTH_LINEAR_STEP=65536', '-sABORTING_MALLOC=0',
    '-sSTACK_SIZE=131072', '-sWASM_BIGINT=1', '-sASYNCIFY=1', '-sASYNCIFY_STACK_SIZE=65536',
    '-sEXPORTED_FUNCTIONS=["_malloc","_free"]',
    '-sEXPORTED_RUNTIME_METHODS=["ccall","HEAPU8","UTF8ToString"]', '-o', root / 'libtiff.mjs')
pkg = repo / 'wasm/libtiff/pkg'
pkg.mkdir(parents=True, exist_ok=True)
glue = (root / 'libtiff.mjs').read_text()
(pkg / 'libtiff.mjs').write_text(glue, newline='\n')
binary = (root / 'libtiff.wasm').read_bytes()
(pkg / 'libtiff-bytes.js').write_text('export default "' + base64.b64encode(binary).decode() + '";\n', newline='\n')
scopes = ['wasm/libtiff/hyve_tiff.c', 'scripts/build-libtiff-wasm.py']
manifest = {'libtiff': revision, 'emscripten': '4.0.22', 'codecs': ['raw', 'PackBits', 'LZW', 'Deflate'],
            'wasmBytes': len(binary)}
manifest['files'] = {str(file.relative_to(repo)).replace('\\', '/'): hashlib.sha256(file.read_text().replace('\r\n', '\n').encode()).hexdigest()
    for file in [*(repo / name for name in scopes), pkg / 'libtiff.mjs', pkg / 'libtiff-bytes.js']}
(pkg / 'libtiff.build.json').write_text(json.dumps(manifest, indent=2) + '\n', newline='\n')
