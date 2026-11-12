#ifndef FMAP_NUMERIC_H
#define FMAP_NUMERIC_H
#include <stdint.h>
#include <fmap/status.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Numeric extraction into the bounded fmap output buffer. */
int32_t fmap_extract_f32(
    uint32_t slot_index,
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t little_endian
);
int32_t fmap_extract_f32_le(
    uint32_t slot_index,
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes
);
int32_t fmap_extract_numeric(
    uint32_t slot_index,
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t data_type,
    uint32_t little_endian
);
int32_t fmap_extract_scratch_f32(
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t little_endian,
    uint32_t valid_bytes
);
int32_t fmap_extract_scratch_numeric(
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t data_type,
    uint32_t little_endian,
    uint32_t valid_bytes
);

#ifdef __cplusplus
}
#endif
#endif
