/* Bounded resident page pool for Hyve's fmap backend. */

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
#define EXPORT(name) __attribute__((export_name(name), visibility("default")))

typedef struct {
    uint64_t page_index;
    uint64_t last_touch;
    uint32_t valid_bytes;
    uint32_t pin_count;
    uint32_t occupied;
    uint32_t reserved;
} fmap_slot;

extern uint8_t __heap_base;

static fmap_slot *g_slots;
static uint8_t *g_bytes;
static uint8_t *g_scratch;
static float *g_output;
static uint32_t g_page_size;
static uint32_t g_slot_count;
static uint32_t g_output_count;
static uint32_t g_initialized;
static uint32_t g_generation;
static uint64_t g_tick;
static uint64_t g_hits;
static uint64_t g_misses;
static uint64_t g_evictions;

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
    slot->reserved = 0;
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

static int32_t extract_f32(
    const uint8_t *source,
    uint32_t valid_bytes,
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
        g_output[output_index] = decode_f32(source + (uint32_t)relative, little_endian);
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
    output_start = align_up_u64(scratch_start + page_size, 4);
    required_end = output_start + output_count * sizeof(float);
    if (required_end > U32_MAX_VALUE) return FMAP_ERR_INVALID_CONFIG;
    if (ensure_linear_memory(required_end) != FMAP_OK) return FMAP_ERR_INVALID_CONFIG;

    g_slots = (fmap_slot *)(uint32_t)slots_start;
    g_bytes = (uint8_t *)(uint32_t)bytes_start;
    g_scratch = (uint8_t *)(uint32_t)scratch_start;
    g_output = (float *)(uint32_t)output_start;
    g_page_size = page_size;
    g_slot_count = slot_count;
    g_output_count = (uint32_t)output_count;
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
    clear_bytes((uint8_t *)g_output, g_output_count * sizeof(float));
    return FMAP_OK;
}

EXPORT("fmap_reset")
int32_t fmap_reset(void) {
    uint32_t index;
    if (!g_initialized) return FMAP_ERR_NOT_INITIALIZED;
    for (index = 0; index < g_slot_count; index++) clear_slot(&g_slots[index]);
    clear_bytes(g_bytes, g_page_size * g_slot_count);
    clear_bytes(g_scratch, g_page_size);
    clear_bytes((uint8_t *)g_output, g_output_count * sizeof(float));
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
    touch_slot(slot_index);
    return FMAP_OK;
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
    return extract_f32(g_scratch, valid_bytes, byte_offset, count, stride_bytes, little_endian);
}

EXPORT("fmap_hits") uint64_t fmap_hits(void) { return g_initialized ? g_hits : 0; }
EXPORT("fmap_misses") uint64_t fmap_misses(void) { return g_initialized ? g_misses : 0; }
EXPORT("fmap_evictions") uint64_t fmap_evictions(void) { return g_initialized ? g_evictions : 0; }
