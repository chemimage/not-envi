/**
 * @file fmap_core.c
 * Fixed resident page pool and typed numeric extraction for the fmap worker.
 *
 * This freestanding module performs no file I/O and has no host imports.
 * Logical page IDs are u64; exported pointers address only WASM linear memory.
 * Cache metadata scales with resident slots; sparse mapping metadata scales
 * with live ranges and their allocation high-water mark, not backing file size.
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

#define FMAP_VALID_INTERVAL_CAPACITY 64u

#define ENVI_TYPE_UINT8 1u
#define ENVI_TYPE_INT16 2u
#define ENVI_TYPE_INT32 3u
#define ENVI_TYPE_FLOAT32 4u
#define ENVI_TYPE_FLOAT64 5u
#define ENVI_TYPE_UINT16 12u
#define ENVI_TYPE_UINT32 13u
#define ENVI_TYPE_INT64 14u
#define ENVI_TYPE_UINT64 15u

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

/* Sparse virtual mapping metadata is separate from evictable resident slots.
 * This is an original Maple-style range B-tree, not the Linux implementation.
 * A wide balanced node stores ordered non-overlapping half-open ranges. A
 * secondary ID hash resolves handle lifetimes without walking all mappings.
 * Metadata is allocated after the fixed pool; freed nodes are reused. */
#define MAP_DEGREE 8u
#define MAP_KEYS (2u * MAP_DEGREE - 1u)
typedef struct {
    uint64_t start, end, file_offset, id;
} fmap_mapping;
typedef struct fmap_map_node {
    uint32_t count, leaf;
    struct fmap_map_node *next_free;
    fmap_mapping entries[MAP_KEYS];
    struct fmap_map_node *children[MAP_KEYS + 1u];
} fmap_map_node;
typedef struct { uint64_t id, start; } fmap_map_id;
static fmap_map_node *g_map_root, *g_map_free;
static fmap_map_id *g_map_ids;
static uint32_t g_map_capacity, g_map_count, g_map_free_count;
static uint64_t g_map_heap_base, g_map_heap_end;
static void mapping_reset_internal(void);

static uint64_t align_up_u64(uint64_t value, uint32_t alignment) {
    uint64_t mask = (uint64_t)alignment - 1u;
    return (value + mask) & ~mask;
}

static int ensure_linear_memory(uint64_t required_end) {
    uint64_t current_pages = (uint64_t)__builtin_wasm_memory_size(0);
    uint64_t current_bytes = current_pages * WASM_PAGE_BYTES;
    uint64_t missing;
    uint64_t grow_pages;
    if (required_end <= current_bytes) return FMAP_OK;
    missing = required_end - current_bytes;
    grow_pages = (missing + WASM_PAGE_BYTES - 1u) / WASM_PAGE_BYTES;
    if (grow_pages > U32_MAX_VALUE) return FMAP_ERR_INVALID_CONFIG;
    if (__builtin_wasm_memory_grow(0, (uint32_t)grow_pages) == (uint32_t)-1) {
        return FMAP_ERR_INVALID_CONFIG;
    }
    return FMAP_OK;
}

static void clear_bytes(uint8_t *bytes, uint32_t length) {
    uint32_t index;
    for (index = 0; index < length; index++) bytes[index] = 0;
}

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
    uint32_t index;
    for (index = 0; index < g_slot_count; index++) {
        if (g_slots[index].occupied && g_slots[index].page_index == page_index) {
            return (int32_t)index;
        }
    }
    return -1;
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

static float decode_f32(const uint8_t *source, uint32_t little_endian) {
    uint32_t bits;
    union { uint32_t bits; float value; } decoded;
    if (little_endian) {
        bits = (uint32_t)source[0]
            | ((uint32_t)source[1] << 8)
            | ((uint32_t)source[2] << 16)
            | ((uint32_t)source[3] << 24);
    } else {
        bits = ((uint32_t)source[0] << 24)
            | ((uint32_t)source[1] << 16)
            | ((uint32_t)source[2] << 8)
            | (uint32_t)source[3];
    }
    decoded.bits = bits;
    return decoded.value;
}

static uint64_t decode_uint(const uint8_t *source, uint32_t width, uint32_t little_endian) {
    uint64_t value = 0;
    uint32_t index;
    if (little_endian) {
        for (index = 0; index < width; index++) value |= (uint64_t)source[index] << (index * 8u);
    } else {
        for (index = 0; index < width; index++) value = (value << 8u) | source[index];
    }
    return value;
}

static double decode_signed(uint64_t bits, uint32_t width) {
    uint64_t sign_bit = 1ull << (width * 8u - 1u);
    uint64_t mask = width == 8u ? U64_MAX_VALUE : ((1ull << (width * 8u)) - 1u);
    uint64_t magnitude;
    if ((bits & sign_bit) == 0) return (double)bits;
    magnitude = ((~bits) & mask) + 1u;
    return -(double)magnitude;
}

static uint32_t numeric_type_size(uint32_t data_type) {
    switch (data_type) {
        case ENVI_TYPE_UINT8: return 1;
        case ENVI_TYPE_INT16:
        case ENVI_TYPE_UINT16: return 2;
        case ENVI_TYPE_INT32:
        case ENVI_TYPE_FLOAT32:
        case ENVI_TYPE_UINT32: return 4;
        case ENVI_TYPE_FLOAT64:
        case ENVI_TYPE_INT64:
        case ENVI_TYPE_UINT64: return 8;
        default: return 0;
    }
}

static double decode_numeric(const uint8_t *source, uint32_t data_type, uint32_t little_endian) {
    union { uint64_t bits; double value; } decoded_f64;
    switch (data_type) {
        case ENVI_TYPE_UINT8: return (double)source[0];
        case ENVI_TYPE_INT16: return decode_signed(decode_uint(source, 2, little_endian), 2);
        case ENVI_TYPE_INT32: return decode_signed(decode_uint(source, 4, little_endian), 4);
        case ENVI_TYPE_FLOAT32: return (double)decode_f32(source, little_endian);
        case ENVI_TYPE_FLOAT64:
            decoded_f64.bits = decode_uint(source, 8, little_endian);
            return decoded_f64.value;
        case ENVI_TYPE_UINT16: return (double)decode_uint(source, 2, little_endian);
        case ENVI_TYPE_UINT32: return (double)decode_uint(source, 4, little_endian);
        case ENVI_TYPE_INT64: return decode_signed(decode_uint(source, 8, little_endian), 8);
        case ENVI_TYPE_UINT64: return (double)decode_uint(source, 8, little_endian);
        default: return 0;
    }
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
        g_output[output_index] = decode_f32(source + (uint32_t)relative, little_endian);
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
        g_output_f64[output_index] = decode_numeric(
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
    uint64_t bytes_start;
    uint64_t scratch_start;
    uint64_t output_start;
    uint64_t resident_bytes;
    uint64_t output_count;
    uint64_t required_end;
    uint32_t index;

    if (page_size == 0 || slot_count == 0) return FMAP_ERR_INVALID_CONFIG;
    resident_bytes = (uint64_t)page_size * slot_count;
    output_count = page_size / 4u;
    if (output_count == 0) output_count = 1;
    heap_start = (uint64_t)(uint32_t)&__heap_base;
    slots_start = align_up_u64(heap_start, 8);
    bytes_start = align_up_u64(slots_start + (uint64_t)sizeof(fmap_slot) * slot_count, 8);
    scratch_start = align_up_u64(bytes_start + resident_bytes, 8);
    output_start = align_up_u64(scratch_start + page_size, 8);
    required_end = output_start + (page_size < 8u ? 8u : page_size);
    if (required_end > U32_MAX_VALUE) return FMAP_ERR_INVALID_CONFIG;
    if (ensure_linear_memory(required_end) != FMAP_OK) return FMAP_ERR_INVALID_CONFIG;

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
    for (index = 0; index < slot_count; index++) clear_slot(&g_slots[index]);
    clear_bytes(g_bytes, (uint32_t)resident_bytes);
    clear_bytes(g_scratch, g_page_size);
    clear_bytes((uint8_t *)g_output, g_output_bytes);
    g_map_heap_base = align_up_u64(required_end, 8);
    mapping_reset_internal();
    return FMAP_OK;
}

static void mapping_reset_internal(void) {
    g_map_root = (fmap_map_node *)0;
    g_map_free = (fmap_map_node *)0;
    g_map_ids = (fmap_map_id *)0;
    g_map_capacity = 0;
    g_map_count = 0;
    g_map_free_count = 0;
    g_map_heap_end = g_map_heap_base;
}

static void *mapping_allocate(uint32_t bytes) {
    uint64_t start = align_up_u64(g_map_heap_end, 8);
    uint64_t end = start + bytes;
    if (end > U32_MAX_VALUE || ensure_linear_memory(end) != FMAP_OK) return (void *)0;
    g_map_heap_end = end;
    clear_bytes((uint8_t *)(uint32_t)start, bytes);
    return (void *)(uint32_t)start;
}

static uint32_t mapping_hash(uint64_t id) {
    id ^= id >> 33;
    id *= 0xff51afd7ed558ccdull;
    id ^= id >> 33;
    return (uint32_t)id;
}

static uint32_t mapping_id_slot(uint64_t id) {
    uint32_t slot = mapping_hash(id) & (g_map_capacity - 1u);
    while (g_map_ids[slot].id && g_map_ids[slot].id != id) slot = (slot + 1u) & (g_map_capacity - 1u);
    return slot;
}

static int mapping_reserve_ids(void) {
    uint32_t index, old_capacity = g_map_capacity;
    fmap_map_id *old = g_map_ids, *next;
    uint32_t capacity;
    if (old_capacity && (uint64_t)(g_map_count + 1u) * 4u < (uint64_t)old_capacity * 3u) return FMAP_OK;
    capacity = old_capacity ? old_capacity * 2u : 32u;
    if (capacity < old_capacity || (uint64_t)capacity * sizeof(fmap_map_id) > U32_MAX_VALUE) return FMAP_ERR_INVALID_CONFIG;
    next = (fmap_map_id *)mapping_allocate(capacity * sizeof(fmap_map_id));
    if (!next) return FMAP_ERR_INVALID_CONFIG;
    g_map_ids = next;
    g_map_capacity = capacity;
    for (index = 0; index < old_capacity; index++) {
        if (old[index].id) g_map_ids[mapping_id_slot(old[index].id)] = old[index];
    }
    return FMAP_OK;
}

static void mapping_remove_id(uint64_t id) {
    uint32_t mask = g_map_capacity - 1u;
    uint32_t hole = mapping_id_slot(id), next = (hole + 1u) & mask;
    while (g_map_ids[next].id) {
        uint32_t home = mapping_hash(g_map_ids[next].id) & mask;
        if (((next - home) & mask) >= ((next - hole) & mask)) {
            g_map_ids[hole] = g_map_ids[next];
            hole = next;
        }
        next = (next + 1u) & mask;
    }
    g_map_ids[hole].id = 0;
    g_map_ids[hole].start = 0;
}

static fmap_map_node *mapping_node(void) {
    fmap_map_node *node = g_map_free;
    g_map_free = node->next_free;
    g_map_free_count--;
    clear_bytes((uint8_t *)node, sizeof(fmap_map_node));
    node->leaf = 1;
    return node;
}

static void mapping_free_node(fmap_map_node *node) {
    node->next_free = g_map_free;
    g_map_free = node;
    g_map_free_count++;
}

/* Reserve a complete split path before mutating the tree. A failed memory.grow
 * leaves all published ranges intact, rather than failing halfway through. */
static int mapping_reserve_nodes(void) {
    uint32_t needed = 2;
    fmap_map_node *node = g_map_root;
    while (node) { needed++; node = node->leaf ? (fmap_map_node *)0 : node->children[0]; }
    while (g_map_free_count < needed) {
        node = (fmap_map_node *)mapping_allocate(sizeof(fmap_map_node));
        if (!node) return FMAP_ERR_INVALID_CONFIG;
        mapping_free_node(node);
    }
    return FMAP_OK;
}

static fmap_mapping *mapping_exact(uint64_t start) {
    fmap_map_node *node = g_map_root;
    while (node) {
        uint32_t index = 0;
        while (index < node->count && node->entries[index].start < start) index++;
        if (index < node->count && node->entries[index].start == start) return &node->entries[index];
        node = node->leaf ? (fmap_map_node *)0 : node->children[index];
    }
    return (fmap_mapping *)0;
}

static fmap_mapping *mapping_at(uint64_t address) {
    fmap_map_node *node = g_map_root;
    while (node) {
        uint32_t index = 0;
        while (index < node->count && address >= node->entries[index].end) index++;
        if (index < node->count && address >= node->entries[index].start) return &node->entries[index];
        node = node->leaf ? (fmap_map_node *)0 : node->children[index];
    }
    return (fmap_mapping *)0;
}

static uint32_t mapping_overlaps(uint64_t start, uint64_t end) {
    fmap_map_node *node = g_map_root;
    while (node) {
        uint32_t index = 0;
        while (index < node->count && node->entries[index].end <= start) index++;
        if (index < node->count && node->entries[index].start < end) return 1;
        node = node->leaf ? (fmap_map_node *)0 : node->children[index];
    }
    return 0;
}

static void mapping_split(fmap_map_node *parent, uint32_t index) {
    fmap_map_node *left = parent->children[index], *right = mapping_node();
    uint32_t j;
    right->leaf = left->leaf;
    right->count = MAP_DEGREE - 1u;
    for (j = 0; j < MAP_DEGREE - 1u; j++) right->entries[j] = left->entries[j + MAP_DEGREE];
    if (!left->leaf) for (j = 0; j < MAP_DEGREE; j++) right->children[j] = left->children[j + MAP_DEGREE];
    left->count = MAP_DEGREE - 1u;
    for (j = parent->count + 1u; j > index + 1u; j--) parent->children[j] = parent->children[j - 1u];
    parent->children[index + 1u] = right;
    for (j = parent->count; j > index; j--) parent->entries[j] = parent->entries[j - 1u];
    parent->entries[index] = left->entries[MAP_DEGREE - 1u];
    parent->count++;
}

static void mapping_insert(fmap_mapping value) {
    fmap_map_node *node;
    if (!g_map_root) g_map_root = mapping_node();
    if (g_map_root->count == MAP_KEYS) {
        node = mapping_node();
        node->leaf = 0;
        node->children[0] = g_map_root;
        g_map_root = node;
        mapping_split(node, 0);
    }
    node = g_map_root;
    for (;;) {
        uint32_t index = node->count;
        while (index && value.start < node->entries[index - 1u].start) index--;
        if (node->leaf) {
            uint32_t j;
            for (j = node->count; j > index; j--) node->entries[j] = node->entries[j - 1u];
            node->entries[index] = value;
            node->count++;
            return;
        }
        if (node->children[index]->count == MAP_KEYS) {
            mapping_split(node, index);
            if (value.start > node->entries[index].start) index++;
        }
        node = node->children[index];
    }
}

static void mapping_merge(fmap_map_node *parent, uint32_t index) {
    fmap_map_node *left = parent->children[index], *right = parent->children[index + 1u];
    uint32_t j, base = left->count;
    left->entries[base] = parent->entries[index];
    for (j = 0; j < right->count; j++) left->entries[base + 1u + j] = right->entries[j];
    if (!left->leaf) for (j = 0; j <= right->count; j++) left->children[base + 1u + j] = right->children[j];
    left->count += right->count + 1u;
    for (j = index + 1u; j < parent->count; j++) parent->entries[j - 1u] = parent->entries[j];
    for (j = index + 2u; j <= parent->count; j++) parent->children[j - 1u] = parent->children[j];
    parent->count--;
    mapping_free_node(right);
}

static void mapping_delete(fmap_map_node *node, uint64_t start) {
    uint32_t index = 0, j;
    while (index < node->count && node->entries[index].start < start) index++;
    if (index < node->count && node->entries[index].start == start) {
        if (node->leaf) {
            for (j = index + 1u; j < node->count; j++) node->entries[j - 1u] = node->entries[j];
            node->count--;
        } else {
            fmap_map_node *left = node->children[index], *right = node->children[index + 1u], *cursor;
            if (left->count >= MAP_DEGREE) {
                cursor = left;
                while (!cursor->leaf) cursor = cursor->children[cursor->count];
                node->entries[index] = cursor->entries[cursor->count - 1u];
                mapping_delete(left, node->entries[index].start);
            } else if (right->count >= MAP_DEGREE) {
                cursor = right;
                while (!cursor->leaf) cursor = cursor->children[0];
                node->entries[index] = cursor->entries[0];
                mapping_delete(right, node->entries[index].start);
            } else {
                mapping_merge(node, index);
                mapping_delete(left, start);
            }
        }
        return;
    }
    if (node->leaf) return;
    if (node->children[index]->count < MAP_DEGREE) {
        fmap_map_node *child = node->children[index], *sibling;
        if (index && node->children[index - 1u]->count >= MAP_DEGREE) {
            sibling = node->children[index - 1u];
            for (j = child->count; j; j--) child->entries[j] = child->entries[j - 1u];
            if (!child->leaf) for (j = child->count + 1u; j; j--) child->children[j] = child->children[j - 1u];
            child->entries[0] = node->entries[index - 1u];
            if (!child->leaf) child->children[0] = sibling->children[sibling->count];
            node->entries[index - 1u] = sibling->entries[sibling->count - 1u];
            sibling->count--; child->count++;
        } else if (index < node->count && node->children[index + 1u]->count >= MAP_DEGREE) {
            sibling = node->children[index + 1u];
            child->entries[child->count] = node->entries[index];
            if (!child->leaf) child->children[child->count + 1u] = sibling->children[0];
            node->entries[index] = sibling->entries[0];
            for (j = 1; j < sibling->count; j++) sibling->entries[j - 1u] = sibling->entries[j];
            if (!sibling->leaf) for (j = 1; j <= sibling->count; j++) sibling->children[j - 1u] = sibling->children[j];
            sibling->count--; child->count++;
        } else {
            if (index == node->count) index--;
            mapping_merge(node, index);
        }
    }
    mapping_delete(node->children[index], start);
}

EXPORT("fmap_map_region")
int32_t fmap_map_region(uint64_t start, uint64_t length, uint64_t file_offset, uint64_t id) {
    fmap_mapping value;
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    if (!id || !length || start > U64_MAX_VALUE - length || file_offset > U64_MAX_VALUE - length) return FMAP_ERR_INVALID_LENGTH;
    if (g_map_capacity && g_map_ids[mapping_id_slot(id)].id) return FMAP_ERR_INVALID_CONFIG;
    if (mapping_overlaps(start, start + length)) return FMAP_ERR_OUT_OF_BOUNDS;
    if (mapping_reserve_ids() != FMAP_OK || mapping_reserve_nodes() != FMAP_OK) return FMAP_ERR_INVALID_CONFIG;
    value.start = start; value.end = start + length; value.file_offset = file_offset; value.id = id;
    mapping_insert(value);
    g_map_ids[mapping_id_slot(id)].id = id;
    g_map_ids[mapping_id_slot(id)].start = start;
    g_map_count++;
    return FMAP_OK;
}

EXPORT("fmap_unmap_region")
int32_t fmap_unmap_region(uint64_t id) {
    uint32_t slot;
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    if (!id || !g_map_capacity) return FMAP_ERR_OUT_OF_BOUNDS;
    slot = mapping_id_slot(id);
    if (!g_map_ids[slot].id) return FMAP_ERR_OUT_OF_BOUNDS;
    mapping_delete(g_map_root, g_map_ids[slot].start);
    mapping_remove_id(id);
    g_map_count--;
    if (g_map_root && !g_map_root->count) {
        fmap_map_node *old = g_map_root;
        g_map_root = old->leaf ? (fmap_map_node *)0 : old->children[0];
        mapping_free_node(old);
    }
    return FMAP_OK;
}

static fmap_mapping *mapping_by_id(uint64_t id) {
    uint32_t slot;
    if (!id || !g_map_capacity) return (fmap_mapping *)0;
    slot = mapping_id_slot(id);
    return g_map_ids[slot].id ? mapping_exact(g_map_ids[slot].start) : (fmap_mapping *)0;
}

EXPORT("fmap_lookup_mapping") uint64_t fmap_lookup_mapping(uint64_t address) {
    fmap_mapping *entry = mapping_at(address);
    return entry ? entry->id : 0;
}
EXPORT("fmap_mapping_start") uint64_t fmap_mapping_start(uint64_t id) {
    fmap_mapping *entry = mapping_by_id(id);
    return entry ? entry->start : 0;
}
EXPORT("fmap_mapping_end") uint64_t fmap_mapping_end(uint64_t id) {
    fmap_mapping *entry = mapping_by_id(id);
    return entry ? entry->end : 0;
}
EXPORT("fmap_mapping_file_offset") uint64_t fmap_mapping_file_offset(uint64_t id) {
    fmap_mapping *entry = mapping_by_id(id);
    return entry ? entry->file_offset : 0;
}
EXPORT("fmap_mapping_count") uint32_t fmap_mapping_count(void) { return g_map_count; }
EXPORT("fmap_mapping_bytes") uint32_t fmap_mapping_bytes(void) { return (uint32_t)(g_map_heap_end - g_map_heap_base); }
EXPORT("fmap_mapping_reset") void fmap_mapping_reset(void) { mapping_reset_internal(); }

typedef struct {
    uint64_t candidate, length, alignment, limit, result;
    uint32_t done;
} fmap_gap_search;

static uint64_t mapping_align(uint64_t value, uint64_t alignment) {
    uint64_t remainder = value % alignment;
    uint64_t increment = remainder ? alignment - remainder : 0;
    return value > U64_MAX_VALUE - increment ? U64_MAX_VALUE : value + increment;
}

/* Ordered sparse traversal: O(R) worst-case time and O(log R) stack, without
 * allocating metadata for holes. Subtree maximum-gap augmentation could prune
 * this search later; current map/unmap and address lookups remain balanced. */
static void mapping_find_gap_node(fmap_map_node *node, fmap_gap_search *search) {
    uint32_t index;
    if (!node || search->done) return;
    for (index = 0; index <= node->count && !search->done; index++) {
        fmap_mapping *entry;
        if (!node->leaf) mapping_find_gap_node(node->children[index], search);
        if (search->done || index == node->count) break;
        entry = &node->entries[index];
        if (entry->end <= search->candidate) continue;
        if (entry->start >= search->candidate
            && search->length <= entry->start - search->candidate) {
            search->result = search->candidate;
            search->done = 1;
            return;
        }
        search->candidate = mapping_align(entry->end, search->alignment);
        if (search->candidate >= search->limit
            || search->length > search->limit - search->candidate) search->done = 1;
    }
}

EXPORT("fmap_mapping_find_gap")
uint64_t fmap_mapping_find_gap(uint64_t length, uint64_t alignment, uint64_t minimum, uint64_t limit) {
    fmap_gap_search search;
    if (!g_initialized || !length || !alignment || minimum >= limit) return U64_MAX_VALUE;
    search.candidate = mapping_align(minimum, alignment);
    if (search.candidate >= limit || length > limit - search.candidate) return U64_MAX_VALUE;
    search.length = length; search.alignment = alignment; search.limit = limit;
    search.result = U64_MAX_VALUE; search.done = 0;
    mapping_find_gap_node(g_map_root, &search);
    if (!search.done) return search.candidate;
    return search.result;
}

EXPORT("fmap_reset")
int32_t fmap_reset(void) {
    uint32_t index;
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    for (index = 0; index < g_slot_count; index++) clear_slot(&g_slots[index]);
    clear_bytes(g_bytes, g_page_size * g_slot_count);
    clear_bytes(g_scratch, g_page_size);
    clear_bytes((uint8_t *)g_output, g_output_bytes);
    g_generation++;
    if (g_generation == 0) g_generation = 1;
    g_tick = 0;
    g_hits = 0;
    g_misses = 0;
    g_evictions = 0;
    return FMAP_OK;
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
    if (slot->occupied) g_evictions++;
    clear_slot(slot);
    slot->page_index = page_index;
    slot->pin_count = 1;
    slot->occupied = 1;
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
