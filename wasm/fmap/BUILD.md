# fmap C/WASM core

The fmap core is freestanding C compiled directly to WebAssembly. It owns a
fixed resident page pool, page metadata, pin counts, LRU selection, counters,
one page-sized scratch region for exact cold reads, and a bounded Float32
compatibility/Float64 numeric output buffer. The generic ABI decodes all nine
supported ENVI scalar types in either byte order; browser code remains
responsible for file range I/O.

`fmap_core.c` owns resident pages and numeric extraction; `fmap_page_index.c`
provides the pool-bounded page-ID lookup. `fmap_mappings.c` owns the sparse
mapping tree, handle index and gap summaries. `fmap_hash.c` shares the documented
ID mixer, and `fmap_memory.c` supplies shared memory helpers.
`fmap_internal.h` declares their small internal interface; mutable state stays
private to its owning module. Pool initialization establishes one layout and
places mapping allocations after the pool, scratch and output regions. Cache
reset preserves mappings; successful pool reinitialization resets them.
Page lookup uses a fixed hash table sized from resident slots, while eviction
victim selection retains its separate linear LRU scan.

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

For Linux CI the matching archive is
[`wasi-sdk-24.0-x86_64-linux.tar.gz`](https://github.com/WebAssembly/wasi-sdk/releases/download/wasi-sdk-24/wasi-sdk-24.0-x86_64-linux.tar.gz),
SHA-256 `c6c38aab56e5de88adf6c1ebc9c3ae8da72f88ec2b656fb024eda8d4167a0bc5`.
Set `FMAP_CLANG` to its `bin/clang` executable. CI checks the download hash before extraction.

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
them. Regenerate both through the build script after changing any C source or header,
then review the recorded compiler, command, exports, size, and SHA-256.
The build discovers and compiles every `.c` file under `wasm/fmap/src`, including
subdirectories. The manifest records every `.c` and `.h` path and its normalized
LF source hash, plus a deterministic hash of that complete sorted source set.
Build and Vite verification use the same discovery and hashing helper. Vite
rejects a stale binary after a source/header edit, addition, removal or rename
until the artifact is regenerated; CRLF versus LF checkouts hash identically.

This core is single-threaded and does not require `SharedArrayBuffer` or
cross-origin isolation. It grows linear memory once to establish the requested
fixed pool, and can grow further for sparse mapping metadata. Reinitializing
reuses the same heap base and does not accumulate resident pools; WASM memory
itself cannot shrink.
