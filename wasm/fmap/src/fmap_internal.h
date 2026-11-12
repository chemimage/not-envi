/** Private cross-module helpers. Consumers include <fmap.h>, not this file. */
#ifndef FMAP_INTERNAL_H
#define FMAP_INTERNAL_H

#include <fmap.h>

/* Implementation constants and export annotations are not public API. */
#define WASM_PAGE_BYTES 65536u
#define U32_MAX_VALUE 0xffffffffu
#define U64_MAX_VALUE 0xffffffffffffffffull
#define EXPORT(name) __attribute__((export_name(name), visibility("default")))

/* Cache initialization establishes the fixed pool and shared metadata arena
 * before initializing mapping and fill state. */
void fmap_mappings_init(void);
uint64_t fmap_align_up_u64(uint64_t value, uint32_t alignment);
int fmap_ensure_linear_memory(uint64_t required_end);
void fmap_clear_bytes(uint8_t *bytes, uint32_t length);
uint32_t fmap_hash_u64(uint64_t value);
void *fmap_metadata_allocate(uint32_t bytes);
void fmap_metadata_free(void *pointer);
void fmap_metadata_init(uint64_t heap_base);
void fmap_fills_storage_init(void);
int fmap_fills_busy(void);

/* Only the fill policy may reset cache storage while retired reads drain. */
int32_t fmap_cache_reset(void);

/* Fixed-size resident-page index. Storage is reserved by the cache layout;
 * capacity depends only on pool slots, never on backing-file length. */
uint64_t fmap_page_index_required_bytes(uint32_t slot_count);
void fmap_page_index_init(uint64_t base, uint32_t slot_count);
void fmap_page_index_reset(void);
int32_t fmap_page_index_find(uint64_t page_index);
void fmap_page_index_insert(uint64_t page_index, uint32_t slot_index);
void fmap_page_index_remove(uint64_t page_index);

#endif
