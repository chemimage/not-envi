/**
 * @file fmap_core.c
 * Fixed resident page pool and typed numeric extraction for the fmap worker.
 *
 * This freestanding module performs no file I/O and has no host imports.
 * Logical page IDs are u64; exported pointers address only WASM linear memory.
 * Cache metadata scales with resident slots. Sparse virtual mappings live in
 * fmap_mappings.c and share the coordinated linear-memory layout.
 *
 * Acquire pins a slot; full-page commit supplies its exact valid-byte count,
 * while range commits retain sparse fills without validating unread holes.
 * Validity uses a fixed interval table per resident slot. Fragment-capacity
 * exhaustion is explicit so the host can replace the sparse page with a full
 * refill instead of growing metadata. Release permits LRU reuse. All-pinned
 * acquisition returns FMAP_ERR_ALL_PINNED instead of growing the pool. The
 * bridge must release on every error path and retain no slot pointer across
 * release, reset, or reinitialization.
 *
 * Sparse reads use the separate page-sized scratch region. Extraction writes
 * the shared bounded output region in either Float32 (compatibility ABI) or
 * Float64 (generic ENVI ABI) form. Both regions must be consumed synchronously
 * before yielding to another worker job.
 *
 * Initialization/reinitialization can grow linear memory; eviction and smaller
 * configurations cannot shrink it. See BUILD.md for the pinned compiler and
 * generated-artifact policy. Remaining work: github.com/chemimage/Hyve/issues/20.
 */

#include "fmap_internal.h"
#include <numeric.h>

#define FMAP_VALID_INTERVAL_CAPACITY 64u

typedef struct {
    uint32_t start;
    uint32_t end;
} fmap_valid_interval;

typedef struct {
    uint64_t page_index;
    uint64_t last_touch;
    uint32_t valid_bytes;
    uint32_t pin_count;
    uint32_t occupied;
    uint32_t interval_count;
    fmap_valid_interval intervals[FMAP_VALID_INTERVAL_CAPACITY];
} fmap_slot;

extern uint8_t __heap_base;

static fmap_slot *g_slots;
static uint8_t *g_bytes;
static uint8_t *g_scratch;
static float *g_output;
static double *g_output_f64;
static uint32_t g_page_size;
static uint32_t g_slot_count;
static uint32_t g_output_count;
static uint32_t g_output_f64_count;
static uint32_t g_output_bytes;
static uint32_t g_initialized;
static uint32_t g_generation;
static uint64_t g_tick;
static uint64_t g_hits;
static uint64_t g_misses;
static uint64_t g_evictions;
static void clear_slot(fmap_slot *slot) {
    slot->page_index = 0;
    slot->last_touch = 0;
    slot->valid_bytes = 0;
    slot->pin_count = 0;
    slot->occupied = 0;
    slot->interval_count = 0;
}

static uint32_t range_is_valid(const fmap_slot *slot, uint32_t offset, uint32_t length) {
    uint32_t end = offset + length;
    uint32_t index;
    if (length == 0) return 1;
    for (index = 0; index < slot->interval_count; index++) {
        const fmap_valid_interval *interval = &slot->intervals[index];
        if (offset < interval->start) return 0;
        if (offset < interval->end) return end <= interval->end;
    }
    return 0;
}

static int32_t commit_valid_range(fmap_slot *slot, uint32_t offset, uint32_t length) {
    uint32_t end = offset + length;
    uint32_t first = 0;
    uint32_t after;
    uint32_t index;
    uint32_t merged_start = offset;
    uint32_t merged_end = end;
    uint32_t removed;
    uint32_t new_count;
    if (length == 0) return FMAP_OK;

    while (first < slot->interval_count && slot->intervals[first].end < offset) first++;
    after = first;
    while (after < slot->interval_count && slot->intervals[after].start <= merged_end) {
        if (slot->intervals[after].start < merged_start) merged_start = slot->intervals[after].start;
        if (slot->intervals[after].end > merged_end) merged_end = slot->intervals[after].end;
        after++;
    }
    removed = after - first;
    if (removed == 0 && slot->interval_count == FMAP_VALID_INTERVAL_CAPACITY) {
        return FMAP_ERR_FRAGMENT_CAPACITY;
    }
    new_count = slot->interval_count - removed + 1u;
    if (after > first) {
        for (index = after; index < slot->interval_count; index++) {
            slot->intervals[first + 1u + index - after] = slot->intervals[index];
        }
    } else {
        for (index = slot->interval_count; index > first; index--) {
            slot->intervals[index] = slot->intervals[index - 1u];
        }
    }
    slot->intervals[first].start = merged_start;
    slot->intervals[first].end = merged_end;
    slot->interval_count = new_count;
    if (merged_end > slot->valid_bytes) slot->valid_bytes = merged_end;
    return FMAP_OK;
}

static int32_t find_page(uint64_t page_index) {
    return fmap_page_index_find(page_index);
}

static void touch_slot(uint32_t slot_index) {
    g_tick++;
    if (g_tick == 0) g_tick = 1;
    g_slots[slot_index].last_touch = g_tick;
}

static int32_t choose_victim(void) {
    int32_t victim = -1;
    uint64_t oldest = U64_MAX_VALUE;
    uint32_t index;
    for (index = 0; index < g_slot_count; index++) {
        fmap_slot *slot = &g_slots[index];
        if (slot->pin_count != 0) continue;
        if (!slot->occupied) return (int32_t)index;
        if (slot->last_touch < oldest) {
            oldest = slot->last_touch;
            victim = (int32_t)index;
        }
    }
    return victim;
}

static uint32_t slot_is_valid(uint32_t slot_index) {
    return g_initialized && slot_index < g_slot_count && g_slots[slot_index].occupied;
}

static int32_t extract_f32(
    const uint8_t *source,
    uint32_t valid_bytes,
    const fmap_slot *slot,
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t little_endian
) {
    uint32_t output_index;
    if (count > g_output_count || (count > 1 && stride_bytes == 0)) {
        return FMAP_ERR_INVALID_LENGTH;
    }
    for (output_index = 0; output_index < count; output_index++) {
        uint64_t relative = (uint64_t)byte_offset + (uint64_t)output_index * stride_bytes;
        if (relative + 4u > valid_bytes) return FMAP_ERR_OUT_OF_BOUNDS;
        if (slot && !range_is_valid(slot, (uint32_t)relative, 4u)) return FMAP_ERR_OUT_OF_BOUNDS;
        g_output[output_index] = numeric_decode_f32(source + (uint32_t)relative, little_endian);
    }
    return (int32_t)count;
}

static int32_t extract_numeric(
    const uint8_t *source,
    uint32_t valid_bytes,
    const fmap_slot *slot,
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t data_type,
    uint32_t little_endian
) {
    uint32_t element_size = numeric_type_size(data_type);
    uint32_t output_index;
    if (element_size == 0) return FMAP_ERR_UNSUPPORTED_TYPE;
    if (count > g_output_f64_count || (count > 1 && stride_bytes == 0)) {
        return FMAP_ERR_INVALID_LENGTH;
    }
    for (output_index = 0; output_index < count; output_index++) {
        uint64_t relative = (uint64_t)byte_offset + (uint64_t)output_index * stride_bytes;
        if (relative > valid_bytes || element_size > (uint64_t)valid_bytes - relative) {
            return FMAP_ERR_OUT_OF_BOUNDS;
        }
        if (slot && !range_is_valid(slot, (uint32_t)relative, element_size)) {
            return FMAP_ERR_OUT_OF_BOUNDS;
        }
        g_output_f64[output_index] = numeric_decode(
            source + (uint32_t)relative,
            data_type,
            little_endian
        );
    }
    return (int32_t)count;
}

EXPORT("fmap_init")
int32_t fmap_init(uint32_t page_size, uint32_t slot_count) {
    uint64_t heap_start;
    uint64_t slots_start;
    uint64_t index_start, index_bytes;
    uint64_t bytes_start;
    uint64_t scratch_start;
    uint64_t output_start;
    uint64_t resident_bytes;
    uint64_t output_count;
    uint64_t required_end;
    uint32_t index;

    if (page_size == 0 || slot_count == 0 || fmap_fills_busy()) return FMAP_ERR_INVALID_CONFIG;
    resident_bytes = (uint64_t)page_size * slot_count;
    output_count = page_size / 4u;
    if (output_count == 0) output_count = 1;
    heap_start = (uint64_t)(uint32_t)&__heap_base;
    slots_start = fmap_align_up_u64(heap_start, 8);
    index_start = fmap_align_up_u64(slots_start + (uint64_t)sizeof(fmap_slot) * slot_count, 8);
    index_bytes = fmap_page_index_required_bytes(slot_count);
    if (!index_bytes) return FMAP_ERR_INVALID_CONFIG;
    bytes_start = fmap_align_up_u64(index_start + index_bytes, 8);
    scratch_start = fmap_align_up_u64(bytes_start + resident_bytes, 8);
    output_start = fmap_align_up_u64(scratch_start + page_size, 8);
    required_end = output_start + (page_size < 8u ? 8u : page_size);
    if (required_end > U32_MAX_VALUE) return FMAP_ERR_INVALID_CONFIG;
    if (fmap_ensure_linear_memory(required_end) != FMAP_OK) return FMAP_ERR_INVALID_CONFIG;

    g_slots = (fmap_slot *)(uint32_t)slots_start;
    g_bytes = (uint8_t *)(uint32_t)bytes_start;
    g_scratch = (uint8_t *)(uint32_t)scratch_start;
    g_output = (float *)(uint32_t)output_start;
    g_output_f64 = (double *)(uint32_t)output_start;
    g_page_size = page_size;
    g_slot_count = slot_count;
    g_output_count = (uint32_t)output_count;
    g_output_f64_count = page_size / 8u;
    if (g_output_f64_count == 0) g_output_f64_count = 1;
    g_output_bytes = page_size < 8u ? 8u : page_size;
    g_initialized = 1;
    g_generation++;
    if (g_generation == 0) g_generation = 1;
    g_tick = 0;
    g_hits = 0;
    g_misses = 0;
    g_evictions = 0;
    fmap_page_index_init(index_start, slot_count);
    for (index = 0; index < slot_count; index++) clear_slot(&g_slots[index]);
    fmap_clear_bytes(g_bytes, (uint32_t)resident_bytes);
    fmap_clear_bytes(g_scratch, g_page_size);
    fmap_clear_bytes((uint8_t *)g_output, g_output_bytes);
    fmap_metadata_init(required_end);
    fmap_mappings_init();
    fmap_fills_storage_init();
    return FMAP_OK;
}

int32_t fmap_cache_reset(void) {
    uint32_t index;
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    fmap_page_index_reset();
    for (index = 0; index < g_slot_count; index++) clear_slot(&g_slots[index]);
    fmap_clear_bytes(g_bytes, g_page_size * g_slot_count);
    fmap_clear_bytes(g_scratch, g_page_size);
    fmap_clear_bytes((uint8_t *)g_output, g_output_bytes);
    g_generation++;
    if (g_generation == 0) g_generation = 1;
    g_tick = 0;
    g_hits = 0;
    g_misses = 0;
    g_evictions = 0;
    return FMAP_OK;
}

EXPORT("fmap_reset")
int32_t fmap_reset(void) {
    if (fmap_fills_busy()) return FMAP_ERR_INVALID_CONFIG;
    return fmap_cache_reset();
}

EXPORT("fmap_generation") uint32_t fmap_generation(void) { return g_initialized ? g_generation : 0; }
EXPORT("fmap_page_size") uint32_t fmap_page_size(void) { return g_initialized ? g_page_size : 0; }
EXPORT("fmap_slot_count") uint32_t fmap_slot_count(void) { return g_initialized ? g_slot_count : 0; }
EXPORT("fmap_resident_bytes") uint32_t fmap_resident_bytes(void) {
    return g_initialized ? g_page_size * g_slot_count : 0;
}

EXPORT("fmap_pinned_bytes")
uint32_t fmap_pinned_bytes(void) {
    uint32_t pinned = 0;
    uint32_t index;
    if (!g_initialized) return 0;
    for (index = 0; index < g_slot_count; index++) {
        if (g_slots[index].pin_count > 0) pinned++;
    }
    return pinned * g_page_size;
}

EXPORT("fmap_acquire_page")
int32_t fmap_acquire_page(uint64_t page_index) {
    int32_t found;
    int32_t victim;
    fmap_slot *slot;
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    found = find_page(page_index);
    if (found >= 0) {
        g_hits++;
        slot = &g_slots[(uint32_t)found];
        if (slot->pin_count != U32_MAX_VALUE) slot->pin_count++;
        touch_slot((uint32_t)found);
        return found;
    }
    g_misses++;
    victim = choose_victim();
    if (victim < 0) return FMAP_ERR_ALL_PINNED;
    slot = &g_slots[(uint32_t)victim];
    if (slot->occupied) {
        fmap_page_index_remove(slot->page_index);
        g_evictions++;
    }
    clear_slot(slot);
    slot->page_index = page_index;
    slot->pin_count = 1;
    slot->occupied = 1;
    fmap_page_index_insert(page_index, (uint32_t)victim);
    touch_slot((uint32_t)victim);
    return victim;
}

EXPORT("fmap_find_page")
int32_t fmap_find_page(uint64_t page_index) {
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    return find_page(page_index);
}

EXPORT("fmap_commit_page")
int32_t fmap_commit_page(uint32_t slot_index, uint32_t valid_bytes) {
    if (!slot_is_valid(slot_index)) return FMAP_ERR_INVALID_SLOT;
    if (valid_bytes > g_page_size) return FMAP_ERR_INVALID_LENGTH;
    g_slots[slot_index].valid_bytes = valid_bytes;
    g_slots[slot_index].interval_count = valid_bytes == 0 ? 0 : 1;
    if (valid_bytes != 0) {
        g_slots[slot_index].intervals[0].start = 0;
        g_slots[slot_index].intervals[0].end = valid_bytes;
    }
    touch_slot(slot_index);
    return FMAP_OK;
}

EXPORT("fmap_commit_range")
int32_t fmap_commit_range(uint32_t slot_index, uint32_t offset, uint32_t length) {
    int32_t result;
    if (!slot_is_valid(slot_index)) return FMAP_ERR_INVALID_SLOT;
    if (length > g_page_size) return FMAP_ERR_INVALID_LENGTH;
    if (offset > g_page_size || length > g_page_size - offset) return FMAP_ERR_OUT_OF_BOUNDS;
    result = commit_valid_range(&g_slots[slot_index], offset, length);
    if (result == FMAP_OK) touch_slot(slot_index);
    return result;
}

EXPORT("fmap_range_valid")
int32_t fmap_range_valid(uint32_t slot_index, uint32_t offset, uint32_t length) {
    if (!slot_is_valid(slot_index)) return FMAP_ERR_INVALID_SLOT;
    if (length > g_page_size) return FMAP_ERR_INVALID_LENGTH;
    if (offset > g_page_size || length > g_page_size - offset) return FMAP_ERR_OUT_OF_BOUNDS;
    return range_is_valid(&g_slots[slot_index], offset, length) ? 1 : 0;
}

EXPORT("fmap_release_page")
int32_t fmap_release_page(uint32_t slot_index) {
    if (!slot_is_valid(slot_index) || g_slots[slot_index].pin_count == 0) {
        return FMAP_ERR_INVALID_SLOT;
    }
    g_slots[slot_index].pin_count--;
    touch_slot(slot_index);
    return FMAP_OK;
}

EXPORT("fmap_touch_page")
int32_t fmap_touch_page(uint32_t slot_index) {
    if (!slot_is_valid(slot_index)) return FMAP_ERR_INVALID_SLOT;
    touch_slot(slot_index);
    return FMAP_OK;
}

EXPORT("fmap_evict_page")
int32_t fmap_evict_page(uint64_t page_index) {
    int32_t found;
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    found = find_page(page_index);
    if (found < 0) return 0;
    if (g_slots[(uint32_t)found].pin_count > 0) return FMAP_ERR_ALL_PINNED;
    fmap_page_index_remove(page_index);
    clear_slot(&g_slots[(uint32_t)found]);
    g_evictions++;
    return 1;
}

EXPORT("fmap_slot_ptr")
uint32_t fmap_slot_ptr(uint32_t slot_index) {
    if (!g_initialized || slot_index >= g_slot_count) return 0;
    return (uint32_t)(g_bytes + (uint64_t)slot_index * g_page_size);
}

EXPORT("fmap_slot_valid_bytes")
uint32_t fmap_slot_valid_bytes(uint32_t slot_index) {
    return slot_is_valid(slot_index) ? g_slots[slot_index].valid_bytes : 0;
}

EXPORT("fmap_slot_range_count")
uint32_t fmap_slot_range_count(uint32_t slot_index) {
    return slot_is_valid(slot_index) ? g_slots[slot_index].interval_count : 0;
}

EXPORT("fmap_slot_range_offset")
uint32_t fmap_slot_range_offset(uint32_t slot_index, uint32_t range_index) {
    if (!slot_is_valid(slot_index) || range_index >= g_slots[slot_index].interval_count) return 0;
    return g_slots[slot_index].intervals[range_index].start;
}

EXPORT("fmap_slot_range_length")
uint32_t fmap_slot_range_length(uint32_t slot_index, uint32_t range_index) {
    const fmap_valid_interval *interval;
    if (!slot_is_valid(slot_index) || range_index >= g_slots[slot_index].interval_count) return 0;
    interval = &g_slots[slot_index].intervals[range_index];
    return interval->end - interval->start;
}

EXPORT("fmap_slot_pin_count")
uint32_t fmap_slot_pin_count(uint32_t slot_index) {
    return slot_is_valid(slot_index) ? g_slots[slot_index].pin_count : 0;
}

EXPORT("fmap_slot_page")
uint64_t fmap_slot_page(uint32_t slot_index) {
    return slot_is_valid(slot_index) ? g_slots[slot_index].page_index : U64_MAX_VALUE;
}

EXPORT("fmap_scratch_ptr") uint32_t fmap_scratch_ptr(void) {
    return g_initialized ? (uint32_t)g_scratch : 0;
}
EXPORT("fmap_scratch_capacity_bytes") uint32_t fmap_scratch_capacity_bytes(void) {
    return g_initialized ? g_page_size : 0;
}
EXPORT("fmap_output_ptr") uint32_t fmap_output_ptr(void) {
    return g_initialized ? (uint32_t)g_output : 0;
}
EXPORT("fmap_output_capacity_f32") uint32_t fmap_output_capacity_f32(void) {
    return g_initialized ? g_output_count : 0;
}
EXPORT("fmap_output_f64_ptr") uint32_t fmap_output_f64_ptr(void) {
    return g_initialized ? (uint32_t)g_output_f64 : 0;
}
EXPORT("fmap_output_f64_capacity") uint32_t fmap_output_f64_capacity(void) {
    return g_initialized ? g_output_f64_count : 0;
}

EXPORT("fmap_extract_f32")
int32_t fmap_extract_f32(
    uint32_t slot_index,
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t little_endian
) {
    int32_t result;
    if (!slot_is_valid(slot_index)) return FMAP_ERR_INVALID_SLOT;
    result = extract_f32(
        g_bytes + (uint64_t)slot_index * g_page_size,
        g_slots[slot_index].valid_bytes,
        &g_slots[slot_index],
        byte_offset,
        count,
        stride_bytes,
        little_endian
    );
    if (result >= 0) touch_slot(slot_index);
    return result;
}

EXPORT("fmap_extract_f32_le")
int32_t fmap_extract_f32_le(
    uint32_t slot_index,
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes
) {
    return fmap_extract_f32(slot_index, byte_offset, count, stride_bytes, 1);
}

EXPORT("fmap_extract_numeric")
int32_t fmap_extract_numeric(
    uint32_t slot_index,
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t data_type,
    uint32_t little_endian
) {
    int32_t result;
    if (!slot_is_valid(slot_index)) return FMAP_ERR_INVALID_SLOT;
    result = extract_numeric(
        g_bytes + (uint64_t)slot_index * g_page_size,
        g_slots[slot_index].valid_bytes,
        &g_slots[slot_index],
        byte_offset,
        count,
        stride_bytes,
        data_type,
        little_endian
    );
    if (result >= 0) touch_slot(slot_index);
    return result;
}

EXPORT("fmap_extract_scratch_f32")
int32_t fmap_extract_scratch_f32(
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t little_endian,
    uint32_t valid_bytes
) {
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    if (valid_bytes > g_page_size) return FMAP_ERR_INVALID_LENGTH;
    return extract_f32(
        g_scratch,
        valid_bytes,
        (const fmap_slot *)0,
        byte_offset,
        count,
        stride_bytes,
        little_endian
    );
}

EXPORT("fmap_extract_scratch_numeric")
int32_t fmap_extract_scratch_numeric(
    uint32_t byte_offset,
    uint32_t count,
    uint32_t stride_bytes,
    uint32_t data_type,
    uint32_t little_endian,
    uint32_t valid_bytes
) {
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    if (valid_bytes > g_page_size) return FMAP_ERR_INVALID_LENGTH;
    return extract_numeric(
        g_scratch,
        valid_bytes,
        (const fmap_slot *)0,
        byte_offset,
        count,
        stride_bytes,
        data_type,
        little_endian
    );
}

EXPORT("fmap_hits") uint64_t fmap_hits(void) { return g_initialized ? g_hits : 0; }
EXPORT("fmap_misses") uint64_t fmap_misses(void) { return g_initialized ? g_misses : 0; }
EXPORT("fmap_evictions") uint64_t fmap_evictions(void) { return g_initialized ? g_evictions : 0; }
