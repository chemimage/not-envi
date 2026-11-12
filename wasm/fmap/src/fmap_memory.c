/** Shared linear-memory growth and byte helpers; owns no cache or mapping state. */
#include "fmap_internal.h"

/* A shared arena after the fixed cache layout. Mapping reset returns its
 * blocks without rewinding over live fill descriptors. Each module retains
 * its own reusable node pools; pool reinitialization resets the whole arena. */
typedef struct metadata_block {
    struct metadata_block *next;
    uint32_t capacity;
} metadata_block;
static metadata_block *g_metadata_free;
static uint64_t g_metadata_end;

void fmap_metadata_init(uint64_t heap_base) {
    g_metadata_end = fmap_align_up_u64(heap_base, 8);
    g_metadata_free = (metadata_block *)0;
}

void *fmap_metadata_allocate(uint32_t bytes) {
    metadata_block **link = &g_metadata_free, *block;
    uint64_t size = fmap_align_up_u64(bytes, 8);
    while (*link && (*link)->capacity < size) link = &(*link)->next;
    if (*link) {
        block = *link; *link = block->next;
    } else {
        uint64_t end = g_metadata_end + sizeof(metadata_block) + size;
        if (end > U32_MAX_VALUE || fmap_ensure_linear_memory(end) != FMAP_OK) return (void *)0;
        block = (metadata_block *)(uint32_t)g_metadata_end;
        block->capacity = (uint32_t)size;
        g_metadata_end = end;
    }
    block->next = (metadata_block *)0;
    fmap_clear_bytes((uint8_t *)(block + 1), bytes);
    return block + 1;
}

void fmap_metadata_free(void *pointer) {
    metadata_block *block = (metadata_block *)pointer - 1;
    block->next = g_metadata_free; g_metadata_free = block;
}

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

