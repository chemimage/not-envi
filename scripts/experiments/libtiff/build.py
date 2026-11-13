"""Build the isolated reader experiment; never used by Hyve's production build."""
import argparse
import os
from pathlib import Path
import shutil
import subprocess

parser = argparse.ArgumentParser()
parser.add_argument('--emsdk', required=True, type=Path)
parser.add_argument('--libtiff', required=True, type=Path)
parser.add_argument('--cmake', default='cmake')
parser.add_argument('--ninja', default='ninja')
parser.add_argument('--output', required=True, type=Path)
args = parser.parse_args()
root = args.output.resolve()
root.mkdir(parents=True, exist_ok=True)
sdk = args.emsdk.resolve()
source = args.libtiff.resolve()
env = dict(os.environ, EM_CONFIG=str(sdk / '.emscripten'))
emscripten = sdk / 'upstream/emscripten'
python = shutil.which('python') or 'python'

def run(*command):
    subprocess.run([str(part) for part in command], check=True, env=env)

revision = subprocess.check_output(['git', '-C', str(source), 'rev-parse', 'HEAD'], text=True).strip()
if revision != 'd01a94be176f5f6a87f7ee1c0b32e65416aa2b4d':
    raise SystemExit('Expected libtiff v4.7.2 commit d01a94be176f5f6a87f7ee1c0b32e65416aa2b4d')
for name in ('probe.c', 'libtiff.worker.mjs'):
    original = Path(__file__).parent / name
    if original.resolve() != (root / name).resolve():
        shutil.copy2(original, root / name)
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
for variant, optimization, definitions in [('probe', '-O3', []), ('reader', '-O3', ['-DPROBE_READER_ONLY=1']),
                                          ('small', '-Oz', ['-DPROBE_READER_ONLY=1'])]:
    run(python, emscripten / 'emcc.py', root / 'probe.c', root / 'build/libtiff/libtiff.a',
        '--use-port=zlib', optimization, *definitions, '-I', source / 'libtiff', '-I', root / 'build/libtiff',
        '-sMODULARIZE=1', '-sEXPORT_ES6=1', '-sENVIRONMENT=worker', '-sFILESYSTEM=0',
        '-sALLOW_MEMORY_GROWTH=1', '-sINITIAL_MEMORY=16777216', '-sMAXIMUM_MEMORY=268435456',
        '-sSTACK_SIZE=131072', '-sWASM_BIGINT=1', '-sEXPORTED_FUNCTIONS=["_malloc","_free"]',
        '-sEXPORTED_RUNTIME_METHODS=["HEAPU8","UTF8ToString"]', '-o', root / f'libtiff-{variant}.mjs')
