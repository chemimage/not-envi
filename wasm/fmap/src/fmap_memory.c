/** Shared linear-memory growth and byte helpers; owns no cache or mapping state. */
#include "fmap_internal.h"

uint64_t fmap_align_up_u64(uint64_t value, uint32_t alignment) {
    uint64_t mask = (uint64_t)alignment - 1u;
    return (value + mask) & ~mask;
}

int fmap_ensure_linear_memory(uint64_t required_end) {
    uint64_t current_pages = (uint64_t)__builtin_wasm_memory_size(0);
    uint64_t current_bytes = current_pages * WASM_PAGE_BYTES;
    uint64_t missing;
    uint64_t grow_pages;
    if (required_end <= current_bytes) return FMAP_OK;
    missing = required_end - current_bytes;
    grow_pages = (missing + WASM_PAGE_BYTES - 1u) / WASM_PAGE_BYTES;
    if (grow_pages > U32_MAX_VALUE) return FMAP_ERR_INVALID_CONFIG;
    if (__builtin_wasm_memory_grow(0, (uint32_t)grow_pages) == (uint32_t)-1) {
        return FMAP_ERR_INVALID_CONFIG;
    }
    return FMAP_OK;
}

void fmap_clear_bytes(uint8_t *bytes, uint32_t length) {
    uint32_t index;
    for (index = 0; index < length; index++) bytes[index] = 0;
}

