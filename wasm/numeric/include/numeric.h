/* Freestanding scalar decoding, shared by extraction and reduction modules.
 * Type identifiers match the supported ENVI scalar codes. The caller must
 * supply enough readable bytes; these functions own no storage or cache. */
#ifndef HYVE_NUMERIC_H
#define HYVE_NUMERIC_H
#include <stdint.h>
#ifdef __cplusplus
extern "C" {
#endif

enum numeric_type {
    NUMERIC_UINT8 = 1, NUMERIC_INT16 = 2, NUMERIC_INT32 = 3,
    NUMERIC_FLOAT32 = 4, NUMERIC_FLOAT64 = 5, NUMERIC_UINT16 = 12,
    NUMERIC_UINT32 = 13, NUMERIC_INT64 = 14, NUMERIC_UINT64 = 15
};
uint32_t numeric_type_size(uint32_t type);
float numeric_decode_f32(const uint8_t *source, uint32_t little_endian);
double numeric_decode(const uint8_t *source, uint32_t type, uint32_t little_endian);

#ifdef __cplusplus
}
#endif
#endif
