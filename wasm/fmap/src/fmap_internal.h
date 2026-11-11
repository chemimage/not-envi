/** Internal freestanding types and module boundaries; no resident/mapping state escapes. */
#ifndef FMAP_INTERNAL_H
#define FMAP_INTERNAL_H

typedef unsigned char uint8_t;
typedef unsigned int uint32_t;
typedef unsigned long long uint64_t;
typedef int int32_t;

#define WASM_PAGE_BYTES 65536u
#define U32_MAX_VALUE 0xffffffffu
#define U64_MAX_VALUE 0xffffffffffffffffull
#define FMAP_OK 0
#define FMAP_ERR_NOT_INITIALIZED -1
#define FMAP_ERR_ALL_PINNED -2
#define FMAP_ERR_INVALID_SLOT -3
#define FMAP_ERR_INVALID_LENGTH -4
#define FMAP_ERR_OUT_OF_BOUNDS -5
#define FMAP_ERR_INVALID_CONFIG -6
#define FMAP_ERR_UNSUPPORTED_TYPE -7
#define FMAP_ERR_FRAGMENT_CAPACITY -8
#define EXPORT(name) __attribute__((export_name(name), visibility("default")))

/* The cache establishes the fixed pool first, then gives mapping metadata the
 * following address. A successful pool reinitialization resets mapping state. */
void fmap_mappings_init(uint64_t heap_base);
uint64_t fmap_align_up_u64(uint64_t value, uint32_t alignment);
int fmap_ensure_linear_memory(uint64_t required_end);
void fmap_clear_bytes(uint8_t *bytes, uint32_t length);

#endif
