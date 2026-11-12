/* Standalone consumer: numeric + reduction, with no fmap dependency. */
#include <reduction.h>
#define EXPORT(name) __attribute__((export_name(name)))
static uint8_t input[4096];
static double results[2][REDUCTION_RESULT_VALUES];
EXPORT("input_ptr") uint32_t input_ptr(void) { return (uint32_t)(uintptr_t)input; }
EXPORT("result_ptr") uint32_t result_ptr(uint32_t index) {
    return index < 2 ? (uint32_t)(uintptr_t)results[index] : 0;
}
EXPORT("reduce") int32_t reduce(uint32_t index, uint32_t offset, uint32_t count,
    uint32_t stride, uint32_t type, uint32_t little_endian, uint32_t bins, double min, double max) {
    if (index > 1) return -99;
    return reduction_numeric(input, sizeof(input), offset, count, stride, type,
        little_endian, 1, bins, min, max, results[index]);
}
