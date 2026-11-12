#ifndef FMAP_STATUS_H
#define FMAP_STATUS_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

/* Status values shared by cache, mapping and fill operations. */
#define FMAP_OK 0
#define FMAP_ERR_NOT_INITIALIZED -1
#define FMAP_ERR_ALL_PINNED -2
#define FMAP_ERR_INVALID_SLOT -3
#define FMAP_ERR_INVALID_LENGTH -4
#define FMAP_ERR_OUT_OF_BOUNDS -5
#define FMAP_ERR_INVALID_CONFIG -6
#define FMAP_ERR_UNSUPPORTED_TYPE -7
#define FMAP_ERR_FRAGMENT_CAPACITY -8
#define FMAP_ERR_CANCELLED -9
#define FMAP_ERR_IO -10

#ifdef __cplusplus
}
#endif
#endif
