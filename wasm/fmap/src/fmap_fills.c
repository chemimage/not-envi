/** File-session fill policy. No host imports, I/O, or asynchronous pointers.
 *
 * Admitted demand count/bytes and provider concurrency are independent limits.
 * Parked descriptors and delivered leases use reusable high-water metadata,
 * shared with mapping allocations, never resident slots or I/O buffers. Lists
 * are deliberately simple: selection/ID lookup is linear, not a speed claim.
 * Fill and demand IDs are never reused within a module instance. Retired reads stay
 * charged through settlement, including across clear. Only prepare() can grant
 * a synchronous write pointer, after checking epoch, slot and reservation.
 */
#include "fmap_internal.h"

#define PARKED 1u
#define ADMITTED 2u
#define READY 3u
#define LEASE 4u
#define ERROR 5u
#define CHUNK 32u

enum {
    /* Cumulative fill activity. */
    READS,
    DEDUP,
    HITS,
    MISSES,
    FAILURES,
    CANCELS,
    FALLBACKS,
    COPIED,

    /* High water marks for provider I/O and admitted demand. */
    PEAK_ACTIVE,
    PEAK_ACTIVE_BYTES,
    PEAK_QUEUED,
    PEAK_QUEUED_BYTES,

    /* Current provider I/O and admitted demand. */
    ACTIVE,
    ACTIVE_BYTES,
    QUEUED,
    QUEUED_BYTES,

    /* Current and peak parked descriptors. */
    PARKED_COUNT,
    PEAK_PARKED,

    /* Metadata storage and outstanding demand/lease accounting. */
    METADATA_BYTES,
    LIVE_DEMANDS,
    PEAK_DEMANDS,

    /* Array bound; not a statistic. Keep indices aligned with STAT_NAMES in JS. */
    COUNT_STATS
};
typedef struct record record;
typedef struct demand {
    struct demand *next;
    record *record;
    uint64_t page;
    uint32_t id, offset, length, grain, priority, state, slot;
    int32_t error;
    uint32_t failure_id;
} demand;
struct record {
    record *next;
    uint64_t page, order, skipped_poll;
    uint32_t active, full;
};
typedef struct fill {
    struct fill *next;
    record *record;
    uint64_t page, epoch;
    uint32_t id, slot, start, length, full, cache_generation;
} fill;

static demand *g_demands, *g_free_demands;
static record *g_records, *g_free_records;
static fill *g_fills, *g_free_fills;
static uint64_t g_file_size, g_epoch, g_order, g_poll, g_stats[COUNT_STATS];
static uint32_t g_page_size, g_concurrency, g_max_count, g_max_bytes;
static uint32_t g_next_demand, g_next_fill, g_configured;
/* Fixed ABI snapshots: command [id,slot,start,length,fileOffset:u64];
 * event [id,slot,offset,length,error:i32,failureId]. No pointer survives a call
 * that can allocate metadata or an await in the JS adapter. */
static struct { uint32_t id, slot, start, length; uint64_t offset; } g_command;
static uint32_t g_event[6];

void fmap_fills_storage_init(void) {
    g_demands = g_free_demands = (demand *)0;
    g_records = g_free_records = (record *)0;
    g_fills = g_free_fills = (fill *)0;
    g_configured = 0;
    g_epoch = g_order = g_poll = 0;
    fmap_clear_bytes((uint8_t *)g_stats, sizeof(g_stats));
}

int fmap_fills_busy(void) { return g_demands || g_fills; }

/* Separate reusable node pools avoid moving live reservations on memory.grow.
 * Their sizes track peak simultaneous descriptors, records and draining reads.
 * They can grow until the shared wasm32 memory limit; admission does not bound
 * total parked metadata or JS Promise storage. Expose both live and high water. */
#define NODE_POOL(type, name) \
static type *new_##name(void) { \
    type *node; uint32_t i; \
    if (!g_free_##name) { \
        node = (type *)fmap_metadata_allocate(CHUNK * sizeof(type)); \
        if (!node) return (type *)0; \
        g_stats[METADATA_BYTES] += CHUNK * sizeof(type); \
        for (i = 0; i < CHUNK; i++) { node[i].next = g_free_##name; g_free_##name = &node[i]; } \
    } \
    node = g_free_##name; g_free_##name = node->next; \
    fmap_clear_bytes((uint8_t *)node, sizeof(type)); return node; \
}
NODE_POOL(demand, demands)
NODE_POOL(record, records)
NODE_POOL(fill, fills)

static void peaks(void) {
    if (g_stats[ACTIVE] > g_stats[PEAK_ACTIVE]) g_stats[PEAK_ACTIVE] = g_stats[ACTIVE];
    if (g_stats[ACTIVE_BYTES] > g_stats[PEAK_ACTIVE_BYTES]) g_stats[PEAK_ACTIVE_BYTES] = g_stats[ACTIVE_BYTES];
    if (g_stats[QUEUED] > g_stats[PEAK_QUEUED]) g_stats[PEAK_QUEUED] = g_stats[QUEUED];
    if (g_stats[QUEUED_BYTES] > g_stats[PEAK_QUEUED_BYTES]) g_stats[PEAK_QUEUED_BYTES] = g_stats[QUEUED_BYTES];
    if (g_stats[PARKED_COUNT] > g_stats[PEAK_PARKED]) g_stats[PEAK_PARKED] = g_stats[PARKED_COUNT];
    if (g_stats[LIVE_DEMANDS] > g_stats[PEAK_DEMANDS]) g_stats[PEAK_DEMANDS] = g_stats[LIVE_DEMANDS];
}
static demand *find_demand(uint32_t id) {
    demand *d;
    for (d = g_demands; d; d = d->next) if (d->id == id) return d;
    return (demand *)0;
}
static fill *find_fill(uint32_t id) {
    fill *f;
    for (f = g_fills; f; f = f->next) if (f->id == id) return f;
    return (fill *)0;
}
static void remove_demand(demand *d) {
    demand **link = &g_demands;
    while (*link != d) link = &(*link)->next;
    *link = d->next;
    d->next = g_free_demands; g_free_demands = d;
    g_stats[LIVE_DEMANDS]--;
}
static int has_waiters(record *r) {
    demand *d;
    for (d = g_demands; d; d = d->next) if (d->state == ADMITTED && d->record == r) return 1;
    return 0;
}
static void cleanup(void) {
    record **link = &g_records;
    while (*link) {
        record *r = *link;
        if (!r->active && !has_waiters(r)) {
            *link = r->next; r->next = g_free_records; g_free_records = r;
        } else link = &r->next;
    }
}
static void unqueue(demand *d) {
    if (d->state == PARKED) g_stats[PARKED_COUNT]--;
    if (d->state == ADMITTED) { g_stats[QUEUED]--; g_stats[QUEUED_BYTES] -= d->length; }
    d->record = (record *)0;
}
static void reject(demand *d, int32_t error, uint32_t failure_id) {
    unqueue(d); d->state = ERROR; d->error = error; d->failure_id = failure_id;
}
static int ready(demand *d) {
    int32_t slot = fmap_find_page(d->page);
    if (slot < 0 || fmap_range_valid((uint32_t)slot, d->offset, d->length) != 1) return 0;
    slot = fmap_acquire_page(d->page);
    if (slot < 0) return 0;
    unqueue(d); d->slot = (uint32_t)slot; d->state = READY;
    return 1;
}
static record *page_record(uint64_t page) {
    record *r;
    for (r = g_records; r; r = r->next) if (r->page == page) return r;
    return (record *)0;
}
static void admit(void) {
    demand *d, *candidate, *displace;
    for (;;) {
        candidate = (demand *)0;
        for (d = g_demands; d; d = d->next) {
            if (d->state == PARKED && (!candidate || d->priority < candidate->priority ||
                (d->priority == candidate->priority && d->id < candidate->id))) candidate = d;
        }
        if (!candidate) break;
        while (g_stats[QUEUED] >= g_max_count || g_stats[QUEUED_BYTES] + candidate->length > g_max_bytes) {
            displace = (demand *)0;
            for (d = g_demands; d; d = d->next) {
                if (d->state != ADMITTED || d->priority <= candidate->priority || d->record->active) continue;
                if (!displace || (displace->page == candidate->page && d->page != candidate->page) ||
                    ((displace->page == candidate->page) == (d->page == candidate->page) && d->id > displace->id)) displace = d;
            }
            if (!displace) break;
            unqueue(displace); displace->state = PARKED; g_stats[PARKED_COUNT]++;
        }
        if (g_stats[QUEUED] >= g_max_count || g_stats[QUEUED_BYTES] + candidate->length > g_max_bytes) break;
        if (ready(candidate)) { g_stats[HITS]++; continue; }
        record *r = page_record(candidate->page);
        if (!r) {
            r = new_records();
            if (!r) { reject(candidate, FMAP_ERR_INVALID_CONFIG, 0); continue; }
            r->page = candidate->page; r->order = ++g_order;
            r->next = g_records; g_records = r;
        }
        unqueue(candidate); candidate->state = ADMITTED; candidate->record = r;
        g_stats[QUEUED]++; g_stats[QUEUED_BYTES] += candidate->length;
        peaks();
    }
    cleanup();
}

EXPORT("fmap_fill_init")
int32_t fmap_fill_init(uint64_t file_size, uint32_t concurrency, uint32_t max_count, uint32_t max_bytes) {
    if (!fmap_page_size() || !concurrency || !max_count || !max_bytes || g_configured) return FMAP_ERR_INVALID_CONFIG;
    g_file_size = file_size; g_page_size = fmap_page_size(); g_concurrency = concurrency;
    g_max_count = max_count; g_max_bytes = max_bytes; g_epoch = 1; g_configured = 1;
    return FMAP_OK;
}

EXPORT("fmap_fill_submit")
int32_t fmap_fill_submit(uint64_t page, uint32_t offset, uint32_t length, uint32_t grain, uint32_t priority) {
    demand *d, *other;
    uint64_t base;
    if (!g_configured) return FMAP_ERR_NOT_INITIALIZED;
    if (!length || length > g_page_size || offset > g_page_size - length || grain > g_page_size) return FMAP_ERR_INVALID_LENGTH;
    if (page > g_file_size / g_page_size) return FMAP_ERR_OUT_OF_BOUNDS;
    base = page * g_page_size;
    if (base > g_file_size || (uint64_t)offset + length > g_file_size - base) return FMAP_ERR_OUT_OF_BOUNDS;
    if (g_next_demand == 0x7fffffffu) return FMAP_ERR_INVALID_CONFIG;
    int32_t slot = fmap_find_page(page);
    int hit = slot >= 0 && fmap_range_valid((uint32_t)slot, offset, length) == 1;
    if (!hit && length > g_max_bytes) return FMAP_ERR_INVALID_LENGTH;
    d = new_demands();
    if (!d) return FMAP_ERR_INVALID_CONFIG;
    d->id = ++g_next_demand; d->page = page; d->offset = offset; d->length = length;
    d->grain = grain; d->priority = priority == 1; d->state = PARKED;
    d->next = g_demands; g_demands = d; g_stats[PARKED_COUNT]++; g_stats[LIVE_DEMANDS]++;
    if (hit) { ready(d); g_stats[HITS]++; }
    else {
        g_stats[MISSES]++;
        if (page_record(page)) g_stats[DEDUP]++;
        else for (other = d->next; other; other = other->next) {
            if (other->state == PARKED && other->page == page) { g_stats[DEDUP]++; break; }
        }
        admit();
    }
    peaks();
    return (int32_t)d->id;
}

EXPORT("fmap_fill_cancel")
void fmap_fill_cancel(uint32_t id) {
    demand *d = find_demand(id);
    if (!d || (d->state != PARKED && d->state != ADMITTED)) return;
    g_stats[CANCELS]++; reject(d, FMAP_ERR_CANCELLED, 0); admit(); peaks();
}

/* Poll ready/error events. READY transfers its reserved pin into a lease whose
 * opaque demand ID is released through the same module, never directly in JS. */
EXPORT("fmap_fill_event")
uint32_t fmap_fill_event(void) {
    demand *d;
    for (d = g_demands; d; d = d->next) {
        if (d->state != READY && d->state != ERROR) continue;
        g_event[0] = d->id; g_event[1] = d->slot; g_event[2] = d->offset; g_event[3] = d->length;
        g_event[4] = (uint32_t)d->error; g_event[5] = d->failure_id;
        if (d->state == READY) d->state = LEASE; else remove_demand(d);
        return (uint32_t)g_event;
    }
    return 0;
}
EXPORT("fmap_fill_release")
void fmap_fill_release(uint32_t id) {
    demand *d = find_demand(id);
    if (!d || d->state != LEASE) return;
    fmap_release_page(d->slot); remove_demand(d);
}

static uint32_t record_priority(record *r) {
    uint32_t priority = 1;
    demand *d;
    for (d = g_demands; d; d = d->next) {
        if ((d->state == ADMITTED || d->state == PARKED) && d->page == r->page && d->priority == 0) priority = 0;
    }
    return priority;
}
/* Find the first missing interval of a request from the C validity table. */
static int first_hole(uint32_t slot, demand *d, uint32_t *start, uint32_t *end) {
    uint32_t cursor = d->offset, limit = cursor + d->length;
    uint32_t i, count = fmap_slot_range_count(slot);
    for (i = 0; i < count; i++) {
        uint32_t a = fmap_slot_range_offset(slot, i), b = a + fmap_slot_range_length(slot, i);
        if (b <= cursor) continue;
        if (a > cursor) { *start = cursor; *end = a < limit ? a : limit; return 1; }
        cursor = b;
        if (cursor >= limit) return 0;
    }
    *start = cursor; *end = limit;
    return cursor < limit;
}

EXPORT("fmap_fill_poll")
uint32_t fmap_fill_poll(void) {
    record *r, *best;
    demand *d;
    uint32_t best_priority, priority, start, end, a, b, grain, changed;
    if (!g_configured) return 0;
    g_poll++;
    admit();
    while (g_stats[ACTIVE] < g_concurrency) {
        best = (record *)0; best_priority = 2;
        for (r = g_records; r; r = r->next) {
            if (r->active || r->skipped_poll == g_poll || !has_waiters(r)) continue;
            priority = record_priority(r);
            if (!best || priority < best_priority || (priority == best_priority && r->order < best->order)) {
                best = r; best_priority = priority;
            }
        }
        if (!best) return 0;
        int32_t slot = fmap_acquire_page(best->page);
        if (slot == FMAP_ERR_ALL_PINNED) { best->skipped_poll = g_poll; continue; }
        if (slot < 0) {
            for (d = g_demands; d; d = d->next) if (d->state == ADMITTED && d->record == best) reject(d, slot, 0);
            admit(); continue;
        }
        for (d = g_demands; d; d = d->next) if (d->state == ADMITTED && d->record == best) ready(d);
        if (!has_waiters(best)) { fmap_release_page((uint32_t)slot); admit(); continue; }
        uint64_t left = g_file_size - best->page * g_page_size;
        uint32_t page_length = left < g_page_size ? (uint32_t)left : g_page_size;
        start = g_page_size; end = grain = 0;
        for (d = g_demands; d; d = d->next) {
            if (d->state != ADMITTED || d->record != best) continue;
            if (d->grain > grain) grain = d->grain;
            if (first_hole((uint32_t)slot, d, &a, &b) && a < start) { start = a; end = b; }
        }
        /* Extend the first hole across touching/overlapping demands. Fixed
         * point handles unordered descriptors without a JS interval sort. */
        do {
            changed = 0;
            for (d = g_demands; d; d = d->next) {
                if (d->state == ADMITTED && d->record == best && first_hole((uint32_t)slot, d, &a, &b)
                    && a <= end && b > end) { end = b; changed = 1; }
            }
        } while (changed);
        if (best->full) { start = 0; end = page_length; }
        else if (grain) {
            start = start / grain * grain;
            uint64_t expanded = ((uint64_t)end + grain - 1u) / grain * grain;
            end = expanded < page_length ? (uint32_t)expanded : page_length;
        }
        fill *f = g_next_fill < 0x7fffffffu ? new_fills() : (fill *)0;
        if (!f) {
            for (d = g_demands; d; d = d->next) if (d->state == ADMITTED && d->record == best) reject(d, FMAP_ERR_INVALID_CONFIG, 0);
            fmap_release_page((uint32_t)slot); admit(); continue;
        }
        f->id = ++g_next_fill; f->record = best; f->page = best->page; f->epoch = g_epoch;
        f->cache_generation = fmap_generation(); f->slot = (uint32_t)slot;
        f->start = start; f->length = end - start; f->full = best->full;
        f->next = g_fills; g_fills = f; best->active = f->id;
        g_stats[READS]++; g_stats[ACTIVE]++; g_stats[ACTIVE_BYTES] += f->length; peaks();
        g_command.id = f->id; g_command.slot = f->slot; g_command.start = start; g_command.length = f->length;
        g_command.offset = f->page * g_page_size + start;
        return (uint32_t)&g_command;
    }
    return 0;
}

static int current(fill *f) {
    return f && f->epoch == g_epoch && f->cache_generation == fmap_generation()
        && f->record->active == f->id && fmap_slot_page(f->slot) == f->page;
}
EXPORT("fmap_fill_prepare")
uint32_t fmap_fill_prepare(uint32_t id) {
    fill *f = find_fill(id);
    return current(f) ? fmap_slot_ptr(f->slot) + f->start : 0;
}
EXPORT("fmap_fill_complete")
void fmap_fill_complete(uint32_t id, uint32_t success) {
    fill *f = find_fill(id), **link;
    demand *d;
    if (!f) return;
    if (current(f)) {
        record *r = f->record;
        int32_t status = FMAP_ERR_IO;
        if (success) {
            g_stats[COPIED] += f->length;
            status = f->full ? fmap_commit_page(f->slot, f->length) : fmap_commit_range(f->slot, f->start, f->length);
        }
        if (status == FMAP_ERR_FRAGMENT_CAPACITY) { r->full = 1; g_stats[FALLBACKS]++; }
        else if (status != FMAP_OK) {
            g_stats[FAILURES]++;
            for (d = g_demands; d; d = d->next) if (d->state == ADMITTED && d->record == r) reject(d, status, id);
        } else {
            r->full = 0;
            for (d = g_demands; d; d = d->next) if (d->state == ADMITTED && d->record == r) ready(d);
        }
        fmap_release_page(f->slot); r->active = 0;
    }
    g_stats[ACTIVE]--; g_stats[ACTIVE_BYTES] -= f->length;
    link = &g_fills; while (*link != f) link = &(*link)->next;
    *link = f->next; f->next = g_free_fills; g_free_fills = f;
    admit(); peaks();
}

EXPORT("fmap_fill_clear")
void fmap_fill_clear(void) {
    demand *d = g_demands;
    g_epoch++;
    while (d) {
        demand *next = d->next;
        if (d->state == LEASE) remove_demand(d);
        else reject(d, FMAP_ERR_CANCELLED, 0);
        d = next;
    }
    while (g_records) {
        record *r = g_records; g_records = r->next;
        r->next = g_free_records; g_free_records = r;
    }
    fmap_cache_reset(); peaks();
}
EXPORT("fmap_fill_concurrency")
int32_t fmap_fill_concurrency(uint32_t concurrency) {
    if (!concurrency) return FMAP_ERR_INVALID_CONFIG;
    g_concurrency = concurrency; return FMAP_OK;
}
EXPORT("fmap_fill_stat")
uint64_t fmap_fill_stat(uint32_t index) { return index < COUNT_STATS ? g_stats[index] : 0; }
