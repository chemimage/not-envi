/* Adapter between pinned fmap storage and the independent reduction kernel.
 * Public ABI names remain stable; only this adapter owns the synchronous
 * result buffer and translates component errors to fmap status codes. */
#include "fmap_internal.h"
#include <reduction.h>

static double g_result[REDUCTION_RESULT_VALUES];

static int32_t fmap_status(int32_t result) {
    switch (result) {
        case REDUCTION_ERR_TYPE: return FMAP_ERR_UNSUPPORTED_TYPE;
        case REDUCTION_ERR_LENGTH: return FMAP_ERR_INVALID_LENGTH;
        case REDUCTION_ERR_BOUNDS: return FMAP_ERR_OUT_OF_BOUNDS;
        case REDUCTION_ERR_CONFIG: return FMAP_ERR_INVALID_CONFIG;
        default: return result;
    }
}

EXPORT("fmap_reduction_ptr")
uint32_t fmap_reduction_ptr(void) { return (uint32_t)(uintptr_t)g_result; }

EXPORT("fmap_reduce_numeric")
int32_t fmap_reduce_numeric(
    uint32_t slot, uint32_t offset, uint32_t count, uint32_t stride,
    uint32_t type, uint32_t little_endian, uint32_t as_f32,
    uint32_t bins, double min, double max
) {
    uint32_t pointer = fmap_slot_ptr(slot);
    if (!pointer || !fmap_slot_pin_count(slot)) return FMAP_ERR_INVALID_SLOT;
    uint32_t size = numeric_type_size(type);
    if (!size) return FMAP_ERR_UNSUPPORTED_TYPE;
    uint32_t valid = fmap_slot_valid_bytes(slot);
    if (count) {
        uint64_t end = (uint64_t)offset + (uint64_t)(count - 1) * stride + size;
        if (end > valid) return FMAP_ERR_OUT_OF_BOUNDS;
        /* A contiguous valid span is common. Sparse strides need only their
         * actual sample bytes valid, so unread gaps still remain permitted. */
        if (fmap_range_valid(slot, offset, (uint32_t)end - offset) != 1) {
            for (uint32_t i = 0; i < count; i++) {
                if (fmap_range_valid(slot, offset + i * stride, size) != 1) return FMAP_ERR_OUT_OF_BOUNDS;
            }
        }
    }
    int32_t result = fmap_status(reduction_numeric((const uint8_t *)(uintptr_t)pointer,
        valid, offset, count, stride, type, little_endian, as_f32, bins, min, max, g_result));
    if (result >= 0) fmap_touch_page(slot);
    return result;
}

EXPORT("fmap_reduce_scratch_numeric")
int32_t fmap_reduce_scratch_numeric(
    uint32_t offset, uint32_t count, uint32_t stride,
    uint32_t type, uint32_t little_endian, uint32_t as_f32,
    uint32_t bins, double min, double max, uint32_t valid_bytes
) {
    uint32_t pointer = fmap_scratch_ptr();
    if (!pointer) return FMAP_ERR_NOT_INITIALIZED;
    if (valid_bytes > fmap_scratch_capacity_bytes()) return FMAP_ERR_INVALID_LENGTH;
    return fmap_status(reduction_numeric((const uint8_t *)(uintptr_t)pointer, valid_bytes,
        offset, count, stride, type, little_endian, as_f32, bins, min, max, g_result));
}
