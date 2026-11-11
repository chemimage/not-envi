/** Shared deterministic full-key mixer; no cache or mapping state. */
#include "fmap_internal.h"

uint32_t fmap_hash_u64(uint64_t value) {
    /* Complete MurmurHash3 fmix64 finalizer, then reduce to a 32-bit hash.
     * Austin Appleby's original implementation is public domain:
     * https://github.com/aappleby/smhasher/blob/master/src/MurmurHash3.cpp
     * No seed is used: the complete 64-bit key is the deterministic input.
     * Both users compare full keys after hashing to resolve collisions.
     * This established mixer is not claimed to be an optimal hash policy. */
    value ^= value >> 33;
    value *= 0xff51afd7ed558ccdull;
    value ^= value >> 33;
    value *= 0xc4ceb9fe1a85ec53ull;
    value ^= value >> 33;
    return (uint32_t)value;
}
