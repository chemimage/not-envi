#ifndef FMAP_FILLS_H
#define FMAP_FILLS_H
#include <stdint.h>
#include <fmap/status.h>
#ifdef __cplusplus
extern "C" {
#endif

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

#ifdef __cplusplus
}
#endif
#endif
