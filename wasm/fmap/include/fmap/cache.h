#ifndef FMAP_CACHE_H
#define FMAP_CACHE_H
#include <stdint.h>
#include <fmap/status.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Pool, resident pages and bounded extraction scratch/output storage. */
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

#ifdef __cplusplus
}
#endif
#endif
