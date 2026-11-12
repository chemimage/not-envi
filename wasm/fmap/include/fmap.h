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

#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

/* Status values shared by cache, mapping and fill operations. */
#define FMAP_OK 0
#define FMAP_ERR_NOT_INITIALIZED -1
#define FMAP_ERR_ALL_PINNED -2
#define FMAP_ERR_INVALID_SLOT -3
#define FMAP_ERR_INVALID_LENGTH -4
#define FMAP_ERR_OUT_OF_BOUNDS -5
#define FMAP_ERR_INVALID_CONFIG -6
#define FMAP_ERR_UNSUPPORTED_TYPE -7
#define FMAP_ERR_FRAGMENT_CAPACITY -8
#define FMAP_ERR_CANCELLED -9
#define FMAP_ERR_IO -10

/* Pool, resident pages, numeric extraction and cache diagnostics. */
int32_t fmap_init(uint32_t page_size, uint32_t slot_count);
int32_t fmap_reset(void);
uint32_t fmap_generation(void);
uint32_t fmap_page_size(void);
uint32_t fmap_slot_count(void);
uint32_t fmap_resident_bytes(void);
uint32_t fmap_pinned_bytes(void);
int32_t fmap_acquire_page(uint64_t page_index);
int32_t fmap_find_page(uint64_t page_index);
int32_t fmap_commit_page(uint32_t slot_index, uint32_t valid_bytes);
int32_t fmap_commit_range(uint32_t slot_index, uint32_t offset, uint32_t length);
int32_t fmap_range_valid(uint32_t slot_index, uint32_t offset, uint32_t length);
int32_t fmap_release_page(uint32_t slot_index);
int32_t fmap_touch_page(uint32_t slot_index);
int32_t fmap_evict_page(uint64_t page_index);
uint32_t fmap_slot_ptr(uint32_t slot_index);
uint32_t fmap_slot_valid_bytes(uint32_t slot_index);
uint32_t fmap_slot_range_count(uint32_t slot_index);
uint32_t fmap_slot_range_offset(uint32_t slot_index, uint32_t range_index);
uint32_t fmap_slot_range_length(uint32_t slot_index, uint32_t range_index);
uint32_t fmap_slot_pin_count(uint32_t slot_index);
uint64_t fmap_slot_page(uint32_t slot_index);
uint32_t fmap_scratch_ptr(void);
uint32_t fmap_scratch_capacity_bytes(void);
uint32_t fmap_output_ptr(void);
uint32_t fmap_output_capacity_f32(void);
uint32_t fmap_output_f64_ptr(void);
uint32_t fmap_output_f64_capacity(void);
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
uint64_t fmap_hits(void);
uint64_t fmap_misses(void);
uint64_t fmap_evictions(void);

/* File-session fill policy, read commands, events and leases. */
int32_t fmap_fill_init(uint64_t file_size, uint32_t concurrency, uint32_t max_count, uint32_t max_bytes);
int32_t fmap_fill_submit(uint64_t page, uint32_t offset, uint32_t length, uint32_t grain, uint32_t priority);
void fmap_fill_cancel(uint32_t id);
uint32_t fmap_fill_event(void);
void fmap_fill_release(uint32_t id);
uint32_t fmap_fill_poll(void);
uint32_t fmap_fill_prepare(uint32_t id);
void fmap_fill_complete(uint32_t id, uint32_t success);
void fmap_fill_clear(void);
int32_t fmap_fill_concurrency(uint32_t concurrency);
uint64_t fmap_fill_stat(uint32_t index);

/* Sparse virtual mappings and gap search. */
int32_t fmap_map_region(uint64_t start, uint64_t length, uint64_t file_offset, uint64_t id);
int32_t fmap_unmap_region(uint64_t id);
uint64_t fmap_lookup_mapping(uint64_t address);
uint64_t fmap_mapping_start(uint64_t id);
uint64_t fmap_mapping_end(uint64_t id);
uint64_t fmap_mapping_file_offset(uint64_t id);
uint32_t fmap_mapping_count(void);
uint32_t fmap_mapping_bytes(void);
void fmap_mapping_reset(void);
uint64_t fmap_mapping_find_gap(uint64_t length, uint64_t alignment, uint64_t minimum, uint64_t limit);
uint32_t fmap_mapping_gap_nodes_visited(void);
uint32_t fmap_mapping_gap_entries_visited(void);

/* Resident-page index diagnostics. */
uint64_t fmap_page_index_lookups(void);
uint64_t fmap_page_index_probes(void);
uint32_t fmap_page_index_last_probes(void);
uint32_t fmap_page_index_peak_probes(void);
uint32_t fmap_page_index_capacity(void);
uint32_t fmap_page_index_bytes(void);

#ifdef __cplusplus
}
#endif

#endif
