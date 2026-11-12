#ifndef FMAP_REDUCTION_H
#define FMAP_REDUCTION_H
#include <stdint.h>
#include <fmap/status.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Synchronous, pinned-span reductions. bins=0 computes statistics only;
 * bins=1..256 additionally uses caller-specified min/max edges. as_f32
 * preserves the viewer's Float32 analysis contract for non-Float32 sources.
 * Result is 261 doubles: min/max/count/sum/sumSq, then 256 bin counts.
 * Consume before another reduction call; no input pointer survives release. */
uint32_t fmap_reduction_ptr(void);
int32_t fmap_reduce_numeric(uint32_t slot, uint32_t offset, uint32_t count,
    uint32_t stride, uint32_t type, uint32_t little_endian, uint32_t as_f32,
    uint32_t bins, double min, double max);
int32_t fmap_reduce_scratch_numeric(uint32_t offset, uint32_t count,
    uint32_t stride, uint32_t type, uint32_t little_endian, uint32_t as_f32,
    uint32_t bins, double min, double max, uint32_t valid_bytes);

#ifdef __cplusplus
}
#endif
#endif
