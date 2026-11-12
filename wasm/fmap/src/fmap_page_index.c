/** Bounded resident-page lookup. Eviction policy remains in fmap_core.c. */
#include "fmap_internal.h"

typedef struct {
    uint64_t page_index;
    uint32_t slot_plus_one;
} fmap_page_entry;

static fmap_page_entry *g_page_entries;
static uint32_t g_page_capacity;
static uint64_t g_page_lookups, g_page_probes;
static uint32_t g_page_last_probes, g_page_peak_probes;

static uint32_t page_capacity(uint32_t slot_count) {
    uint64_t capacity = 2;
    while (capacity < (uint64_t)slot_count * 2u) capacity *= 2u;
    return capacity <= U32_MAX_VALUE ? (uint32_t)capacity : 0;
}

uint64_t fmap_page_index_required_bytes(uint32_t slot_count) {
    if (!slot_count) return 0;
    return (uint64_t)page_capacity(slot_count) * sizeof(fmap_page_entry);
}

void fmap_page_index_reset(void) {
    if (g_page_capacity) fmap_clear_bytes((uint8_t *)g_page_entries,
        g_page_capacity * sizeof(fmap_page_entry));
    g_page_lookups = 0;
    g_page_probes = 0;
    g_page_last_probes = 0;
    g_page_peak_probes = 0;
}

void fmap_page_index_init(uint64_t base, uint32_t slot_count) {
    g_page_entries = (fmap_page_entry *)(uint32_t)base;
    /* A power of two permits masking; at least twice the slot count keeps
     * maximum occupancy <= 50%. This is a bounded policy, not a tuned optimum. */
    g_page_capacity = page_capacity(slot_count);
    fmap_page_index_reset();
}

static uint32_t page_entry_slot(uint64_t page_index, uint32_t *probes) {
    uint32_t slot = fmap_hash_u64(page_index) & (g_page_capacity - 1u);
    *probes = 1;
    while (g_page_entries[slot].slot_plus_one && g_page_entries[slot].page_index != page_index) {
        slot = (slot + 1u) & (g_page_capacity - 1u);
        (*probes)++;
    }
    return slot;
}

int32_t fmap_page_index_find(uint64_t page_index) {
    uint32_t probes, slot = page_entry_slot(page_index, &probes);
    g_page_lookups++;
    g_page_probes += probes;
    g_page_last_probes = probes;
    if (probes > g_page_peak_probes) g_page_peak_probes = probes;
    return g_page_entries[slot].slot_plus_one ? (int32_t)(g_page_entries[slot].slot_plus_one - 1u) : -1;
}

void fmap_page_index_insert(uint64_t page_index, uint32_t slot_index) {
    uint32_t probes, slot = page_entry_slot(page_index, &probes);
    g_page_entries[slot].page_index = page_index;
    g_page_entries[slot].slot_plus_one = slot_index + 1u;
}

void fmap_page_index_remove(uint64_t page_index) {
    uint32_t probes, mask = g_page_capacity - 1u;
    uint32_t hole = page_entry_slot(page_index, &probes), next;
    if (!g_page_entries[hole].slot_plus_one) return;
    next = (hole + 1u) & mask;
    /* Backward-shift deletion preserves probe chains without accumulating
     * tombstones or periodically allocating/rehashing after cache churn. */
    while (g_page_entries[next].slot_plus_one) {
        uint32_t home = fmap_hash_u64(g_page_entries[next].page_index) & mask;
        if (((next - home) & mask) >= ((next - hole) & mask)) {
            g_page_entries[hole] = g_page_entries[next];
            hole = next;
        }
        next = (next + 1u) & mask;
    }
    g_page_entries[hole].page_index = 0;
    g_page_entries[hole].slot_plus_one = 0;
}

/* Counts include only find/acquire/explicit-evict lookup probes, not index
 * maintenance or choose_victim's separate linear LRU scan. */
EXPORT("fmap_page_index_lookups") uint64_t fmap_page_index_lookups(void) { return g_page_lookups; }
EXPORT("fmap_page_index_probes") uint64_t fmap_page_index_probes(void) { return g_page_probes; }
EXPORT("fmap_page_index_last_probes") uint32_t fmap_page_index_last_probes(void) { return g_page_last_probes; }
EXPORT("fmap_page_index_peak_probes") uint32_t fmap_page_index_peak_probes(void) { return g_page_peak_probes; }
EXPORT("fmap_page_index_capacity") uint32_t fmap_page_index_capacity(void) { return g_page_capacity; }
EXPORT("fmap_page_index_bytes") uint32_t fmap_page_index_bytes(void) {
    return g_page_capacity * sizeof(fmap_page_entry);
}
