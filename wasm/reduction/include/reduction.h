/* Source-independent, allocation-free reductions over a caller-owned span.
 * No file I/O, pager, mappings, global result buffer or WASM export policy. */
#ifndef HYVE_REDUCTION_H
#define HYVE_REDUCTION_H
#include <numeric.h>
#ifdef __cplusplus
extern "C" {
#endif

#define REDUCTION_MAX_BINS 256u
#define REDUCTION_RESULT_VALUES 261u
#define REDUCTION_ERR_TYPE -1
#define REDUCTION_ERR_LENGTH -2
#define REDUCTION_ERR_BOUNDS -3
#define REDUCTION_ERR_CONFIG -4

/* Success returns count (<= INT32_MAX). Result layout: min/max/finite count/
 * sum/sumSq, then 256 bin counts. as_f32 rounds values before reduction.
 * bins=0 computes only moments/range; otherwise min/max supply bin edges.
 * Empty results have +/-infinity bounds. All storage is supplied by caller;
 * source and result storage must not overlap. */
int32_t reduction_numeric(const uint8_t *source, uint32_t valid_bytes,
    uint32_t offset, uint32_t count, uint32_t stride, uint32_t type,
    uint32_t little_endian, uint32_t as_f32, uint32_t bins,
    double min, double max, double result[REDUCTION_RESULT_VALUES]);

#ifdef __cplusplus
}
#endif
#endif
