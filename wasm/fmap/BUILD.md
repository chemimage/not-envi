# fmap WASM core

The fmap core is a dependency-free Rust `cdylib`. It owns a fixed resident
page pool, page metadata, pin counts, LRU selection, counters, and a bounded
Float32 extraction buffer. Browser code remains responsible for range I/O.

## Pinned build

The checked-in `rust-toolchain.toml` pins Rust 1.85.1 and the
`wasm32-unknown-unknown` target. Install rustup, then run from the repository
root:

```powershell
node scripts/build-fmap-wasm.mjs
```

The script runs native Rust unit tests, builds the release WASM, verifies its
magic bytes, removes non-runtime custom sections, runs an ABI smoke test, and
writes:

- `wasm/fmap/pkg/fmap_core.wasm`
- `wasm/fmap/pkg/fmap_core.build.json`

Set `FMAP_CARGO` to an explicit Cargo executable when it is not on `PATH`.
The script sets `RUSTUP_TOOLCHAIN=1.85.1` for every Cargo subprocess and rejects
a Cargo toolchain whose `rustc` is not exactly 1.85.1. This avoids a newer
repository-root default overriding the crate's nested `rust-toolchain.toml`.

## Generated artifact policy

The `.wasm` file and build manifest are committed so the normal JavaScript
build can remain offline and reproduce the single-file application. Do not
hand-edit them. Regenerate both through the build script after changing Rust
sources, and review the SHA-256 and exported surface recorded in the manifest.
The SHA verifies the exact artifact consumed by a given build. Rust's wasm
code generation is not assumed to be byte-identical across host operating
systems, even with the compiler version pinned; CI rebuilds and smoke-tests the
module instead of comparing its hash with an artifact produced on another host.

This first core is single-threaded and does not require `SharedArrayBuffer` or
cross-origin isolation. Its WASM memory can grow while initializing the fixed
pool but cannot shrink; changing the budget is expected to recreate the worker.
