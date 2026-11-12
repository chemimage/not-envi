#ifndef FMAP_MAPPINGS_H
#define FMAP_MAPPINGS_H
#include <stdint.h>
#include <fmap/status.h>
#ifdef __cplusplus
extern "C" {
#endif

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

#ifdef __cplusplus
}
#endif
#endif
