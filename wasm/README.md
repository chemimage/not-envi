# C modules and the browser WASM bundle

The C source modules have separate APIs and responsibilities. They are linked
at build time into one runtime `fmap_core.wasm` with one linear memory. The
browser still loads that existing artifact; its export names remain compatible.

| Module | Public headers | Responsibility | C dependencies |
| --- | --- | --- | --- |
| `numeric` | `numeric/include/numeric.h` | Scalar type sizes and endian-aware decoding; no storage or cache | none |
| `reduction` | `reduction/include/reduction.h` | Range, moments and histogram kernels over caller-owned spans/results; no global result or allocation | numeric |
| `fmap` | `fmap/include/fmap.h`, `fmap/include/fmap/*.h` | Paging, mapping, fill policy, extraction and adapters to resident storage | numeric; reduction through its adapter |

`fmap/src/fmap_reduction.c` is the boundary between the pager and the independent
kernel. It checks slot pinning, sparse validity and scratch bounds, supplies a
synchronous result buffer, maps component errors to fmap status codes and
touches successfully consumed pages. The reduction kernel knows nothing about
slots, leases, mappings, files, workers or JS. Another C consumer can use it
with a decoded TIFF span or a different memory provider and its own result
buffer, without linking fmap.

## Public fmap headers

`#include <fmap.h>` remains supported as an umbrella. Consumers can instead
include just the relevant functional header:

- `<fmap/status.h>`: shared fmap status codes.
- `<fmap/cache.h>`: cache lifecycle, resident pages and scratch/output storage.
- `<fmap/numeric.h>`: extraction adapters writing bounded fmap output buffers.
- `<fmap/reduction.h>`: pinned-page/scratch reduction adapters and their result ABI.
- `<fmap/fills.h>`: demand admission, provider commands and lease lifecycle.
- `<fmap/mappings.h>`: sparse virtual regions and address/gap lookup.
- `<fmap/diagnostics.h>`: cache and page-index counters.

The C extraction adapter `<fmap/numeric.h>` differs from `<numeric.h>`: the
former operates on fmap slots/output storage, while the latter only decodes
caller-supplied bytes. Likewise, `<fmap/reduction.h>` is the compatibility
adapter ABI; `<reduction.h>` is the independent kernel API. Private fmap
implementation helpers remain under `fmap/src`.

## Build-time linking and HTML packaging

Run `npm run build:fmap` with the pinned Clang 18.1.2 compiler described in
[fmap/BUILD.md](fmap/BUILD.md). The build discovers the C sources and public/private
headers across all three modules. Clang/LLD links their translation units with
LTO into the existing `fmap/pkg/fmap_core.wasm`. The manifest records the linked
modules and hashes every contributing source/header; Vite checks the same
module scopes and rejects stale artifacts, including changes outside fmap.

`npm run build` subsequently embeds this linked artifact and its worker in the
offline HTML. HTML packaging does not concatenate or dynamically link WASM
binaries. Source module separation does not require separate WASM instances.

Keeping one instance preserves direct span access and a single coordinated
memory layout. Multiple instances could share an imported memory, but would
need an explicit data/stack layout, allocator/growth ownership and ABI contract.
Separate private memories would require transferring/copying the bytes into the
compute instance. Neither complication is needed for this source/API split.

## Checks

The pinned build also compiles every public header independently as C11 and
C++17, then builds a small standalone numeric/reduction consumer **without any
fmap source or fmap include path**. That consumer checks strided/endian inputs,
independent caller-owned results and component errors. Existing actual-WASM,
worker, numeric parity and offline tests exercise the linked bundle through
the same browser ABI.

The numeric kernel and reduction results preserve the contracts and selective
enablement in [the reduction study](../docs/fmap-reductions.md). Linking modules
does not remove the cost of a second histogram pass, make fptrs resident
pointers, introduce SIMD or complete the shared application budget.
