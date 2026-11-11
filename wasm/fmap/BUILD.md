# fmap C/WASM core

The fmap core is freestanding C compiled directly to WebAssembly. It owns a
fixed resident page pool, page metadata, pin counts, LRU selection, counters,
one page-sized scratch region for exact cold reads, and a bounded Float32
output buffer. Browser code remains responsible for file range I/O.

## Pinned build

The build is pinned to WASI SDK 24.0 (Clang/LLVM 18.1.2). The core does not use
WASI or libc; the SDK supplies a reproducible Windows Clang and `wasm-ld`.

Download and extract the official
[`wasi-sdk-24.0-x86_64-windows.tar.gz`](https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-x86_64-windows.tar.gz).
Its SHA-256 must be
`0f934c6e7e171b5627c81b697a9e57e96d65cd889f56ce6077350de48978afd3`.
After extracting it, run from the repository root:

```powershell
$env:FMAP_CLANG = "C:\path\to\wasi-sdk-24.0-x86_64-windows\bin\clang.exe"
node scripts/build-fmap-wasm.mjs
```

The script rejects a compiler that does not report Clang 18.1.2, builds the
freestanding module, runs the direct ABI suite, verifies the WASM magic bytes,
and writes:

- `wasm/fmap/pkg/fmap_core.wasm`
- `wasm/fmap/pkg/fmap_core.build.json`

Run the ABI suite independently with:

```powershell
node scripts/test-fmap-core.mjs
```

## Generated artifact policy

The `.wasm` file and build manifest are committed so the JavaScript build can
remain offline and reproduce the single-file application. Do not hand-edit
them. Regenerate both through the build script after changing `fmap_core.c`,
then review the recorded compiler, command, exports, size, and SHA-256.

This core is single-threaded and does not require `SharedArrayBuffer` or
cross-origin isolation. It grows linear memory once to establish the requested
fixed pool. Reinitializing reuses the same heap base and does not accumulate
resident pools; WASM memory itself cannot shrink.
