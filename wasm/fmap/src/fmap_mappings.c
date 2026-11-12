/** Sparse mapping ranges, handle index, and gap summaries. No file I/O or resident-page ownership. */
#include "fmap_internal.h"

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
    uint64_t first_start, last_end, max_gap;
    fmap_mapping entries[MAP_KEYS];
    struct fmap_map_node *children[MAP_KEYS + 1u];
} fmap_map_node;
typedef struct { uint64_t id, start; } fmap_map_id;
static fmap_map_node *g_map_root, *g_map_free;
static fmap_map_id *g_map_ids;
static uint32_t g_map_capacity, g_map_count, g_map_free_count;
static uint32_t g_mapping_initialized;
static uint64_t g_map_heap_base, g_map_heap_end;
static uint32_t g_map_gap_nodes_visited, g_map_gap_entries_visited;
static void mapping_reset_internal(void);

void fmap_mappings_init(uint64_t heap_base) {
    g_mapping_initialized = 1;
    g_map_heap_base = fmap_align_up_u64(heap_base, 8);
    mapping_reset_internal();
}

static void mapping_reset_internal(void) {
    g_map_root = (fmap_map_node *)0;
    g_map_free = (fmap_map_node *)0;
    g_map_ids = (fmap_map_id *)0;
    g_map_capacity = 0;
    g_map_count = 0;
    g_map_free_count = 0;
    g_map_heap_end = g_map_heap_base;
    g_map_gap_nodes_visited = 0;
    g_map_gap_entries_visited = 0;
}

static void *mapping_allocate(uint32_t bytes) {
    uint64_t start = fmap_align_up_u64(g_map_heap_end, 8);
    uint64_t end = start + bytes;
    if (end > U32_MAX_VALUE || fmap_ensure_linear_memory(end) != FMAP_OK) return (void *)0;
    g_map_heap_end = end;
    fmap_clear_bytes((uint8_t *)(uint32_t)start, bytes);
    return (void *)(uint32_t)start;
}

static uint32_t mapping_id_slot(uint64_t id) {
    uint32_t slot = fmap_hash_u64(id) & (g_map_capacity - 1u);
    while (g_map_ids[slot].id && g_map_ids[slot].id != id) slot = (slot + 1u) & (g_map_capacity - 1u);
    return slot;
}

static int mapping_reserve_ids(void) {
    uint32_t index, old_capacity = g_map_capacity;
    fmap_map_id *old = g_map_ids, *next;
    uint32_t capacity;
    /* Power-of-two capacity permits masking. Grow before 75% occupancy to
     * retain empty probe slots; this is a policy choice, not a tuned optimum. */
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
        uint32_t home = fmap_hash_u64(g_map_ids[next].id) & mask;
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
    fmap_clear_bytes((uint8_t *)node, sizeof(fmap_map_node));
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

/* Recompute one wide node from its entries and immediate child summaries.
 * Only mutation paths and participating split/borrow/merge siblings refresh;
 * this never walks whole subtrees or allocates during an update. */
static void mapping_refresh(fmap_map_node *node) {
    uint32_t index;
    uint64_t previous_end, gap;
    node->max_gap = 0;
    if (!node->count) {
        if (!node->leaf) {
            node->first_start = node->children[0]->first_start;
            node->last_end = node->children[0]->last_end;
            node->max_gap = node->children[0]->max_gap;
        } else node->first_start = node->last_end = 0;
        return;
    }
    if (node->leaf) {
        node->first_start = node->entries[0].start;
        previous_end = node->entries[0].start;
    } else {
        node->first_start = node->children[0]->first_start;
        previous_end = node->children[0]->last_end;
        node->max_gap = node->children[0]->max_gap;
    }
    for (index = 0; index < node->count; index++) {
        gap = node->entries[index].start - previous_end;
        if (gap > node->max_gap) node->max_gap = gap;
        previous_end = node->entries[index].end;
        if (!node->leaf) {
            fmap_map_node *child = node->children[index + 1u];
            gap = child->first_start - previous_end;
            if (gap > node->max_gap) node->max_gap = gap;
            if (child->max_gap > node->max_gap) node->max_gap = child->max_gap;
            previous_end = child->last_end;
        }
    }
    node->last_end = previous_end;
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
    mapping_refresh(left);
    mapping_refresh(right);
    mapping_refresh(parent);
}

static void mapping_insert_nonfull(fmap_map_node *node, fmap_mapping value) {
    uint32_t index = node->count;
    while (index && value.start < node->entries[index - 1u].start) index--;
    if (node->leaf) {
        uint32_t j;
        for (j = node->count; j > index; j--) node->entries[j] = node->entries[j - 1u];
        node->entries[index] = value;
        node->count++;
    } else {
        if (node->children[index]->count == MAP_KEYS) {
            mapping_split(node, index);
            if (value.start > node->entries[index].start) index++;
        }
        mapping_insert_nonfull(node->children[index], value);
    }
    mapping_refresh(node);
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
    mapping_insert_nonfull(g_map_root, value);
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
    mapping_refresh(left);
    mapping_refresh(parent);
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
        mapping_refresh(node);
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
            mapping_refresh(sibling);
            mapping_refresh(child);
        } else if (index < node->count && node->children[index + 1u]->count >= MAP_DEGREE) {
            sibling = node->children[index + 1u];
            child->entries[child->count] = node->entries[index];
            if (!child->leaf) child->children[child->count + 1u] = sibling->children[0];
            node->entries[index] = sibling->entries[0];
            for (j = 1; j < sibling->count; j++) sibling->entries[j - 1u] = sibling->entries[j];
            if (!sibling->leaf) for (j = 1; j <= sibling->count; j++) sibling->children[j - 1u] = sibling->children[j];
            sibling->count--; child->count++;
            mapping_refresh(sibling);
            mapping_refresh(child);
        } else {
            if (index == node->count) index--;
            mapping_merge(node, index);
        }
    }
    mapping_delete(node->children[index], start);
    mapping_refresh(node);
}

EXPORT("fmap_map_region")
int32_t fmap_map_region(uint64_t start, uint64_t length, uint64_t file_offset, uint64_t id) {
    fmap_mapping value;
    if (!g_mapping_initialized) return FMAP_ERR_NOT_INITIALIZED;
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
    if (!g_mapping_initialized) return FMAP_ERR_NOT_INITIALIZED;
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

/* Maximum raw-gap summaries prune subtrees that cannot fit the requested
 * length. Arbitrary alignment may reject otherwise large raw gaps, so this is
 * still O(R) worst-case time, with O(log R) stack and no per-hole allocation. */
static void mapping_find_gap_node(fmap_map_node *node, fmap_gap_search *search) {
    uint32_t index;
    if (!node || search->done) return;
    g_map_gap_nodes_visited++;
    if (node->last_end <= search->candidate) return;
    if (node->first_start >= search->candidate
        && search->length <= node->first_start - search->candidate) {
        search->result = search->candidate;
        search->done = 1;
        return;
    }
    if (node->max_gap < search->length) {
        search->candidate = mapping_align(node->last_end, search->alignment);
        if (search->candidate >= search->limit
            || search->length > search->limit - search->candidate) search->done = 1;
        return;
    }
    for (index = 0; index <= node->count && !search->done; index++) {
        fmap_mapping *entry;
        if (!node->leaf) mapping_find_gap_node(node->children[index], search);
        if (search->done || index == node->count) break;
        entry = &node->entries[index];
        g_map_gap_entries_visited++;
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
    g_map_gap_nodes_visited = 0;
    g_map_gap_entries_visited = 0;
    if (!g_mapping_initialized || !length || !alignment || minimum >= limit) return U64_MAX_VALUE;
    search.candidate = mapping_align(minimum, alignment);
    if (search.candidate >= limit || length > limit - search.candidate) return U64_MAX_VALUE;
    search.length = length; search.alignment = alignment; search.limit = limit;
    search.result = U64_MAX_VALUE; search.done = 0;
    mapping_find_gap_node(g_map_root, &search);
    if (!search.done) return search.candidate;
    return search.result;
}

EXPORT("fmap_mapping_gap_nodes_visited") uint32_t fmap_mapping_gap_nodes_visited(void) {
    return g_map_gap_nodes_visited;
}
EXPORT("fmap_mapping_gap_entries_visited") uint32_t fmap_mapping_gap_entries_visited(void) {
    return g_map_gap_entries_visited;
}

