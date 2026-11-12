#ifndef FMAP_DIAGNOSTICS_H
#define FMAP_DIAGNOSTICS_H
#include <stdint.h>
#include <fmap/status.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Cache and resident-page index diagnostics. */
uint64_t fmap_hits(void);
uint64_t fmap_misses(void);
uint64_t fmap_evictions(void);

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
