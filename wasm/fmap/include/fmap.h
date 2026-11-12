/** Public C declarations for the freestanding fmap WebAssembly ABI.
 *
 * Browser consumers instantiate fmap_core.wasm and call instance.exports;
 * they do not load this header. C callers include <fmap.h> with this directory
 * on their include path. Pointer-valued uint32_t results are addresses in the
 * module's linear memory, not host pointers. Keep views synchronous: allocating
 * calls may grow memory, and reset/release invalidate the associated storage.
 * See ../BUILD.md for ownership, status and command/event layout contracts.
 */
#ifndef FMAP_H
#define FMAP_H

/* Compatibility umbrella: callers may include one functional header instead.
 * Reduction declarations are fmap lease adapters; the independent kernel API
 * is <reduction.h> from wasm/reduction. */
#include <fmap/status.h>
#include <fmap/cache.h>
#include <fmap/numeric.h>
#include <fmap/reduction.h>
#include <fmap/fills.h>
#include <fmap/mappings.h>
#include <fmap/diagnostics.h>

#endif
