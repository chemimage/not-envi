#include <reduction.h>

int32_t reduction_numeric(
    const uint8_t *source, uint32_t valid_bytes,
    uint32_t byte_offset, uint32_t count, uint32_t stride_bytes,
    uint32_t data_type, uint32_t little_endian, uint32_t as_f32,
    uint32_t bins, double min, double max, double result[REDUCTION_RESULT_VALUES]
) {
    uint32_t size = numeric_type_size(data_type);
    if (!size) return REDUCTION_ERR_TYPE;
    if (count > INT32_MAX || bins > REDUCTION_MAX_BINS || (count > 1 && stride_bytes < size)) return REDUCTION_ERR_LENGTH;
    if (bins && (!__builtin_isfinite(min) || !__builtin_isfinite(max) || max < min)) {
        return REDUCTION_ERR_CONFIG;
    }
    for (uint32_t i = 0; i < REDUCTION_RESULT_VALUES; i++) result[i] = 0;
    result[0] = __builtin_inf();
    result[1] = -__builtin_inf();
    double scale = bins ? (double)(bins - 1) / (max - min) : 0;
    for (uint32_t i = 0; i < count; i++) {
        uint64_t at = (uint64_t)byte_offset + (uint64_t)i * stride_bytes;
        if (at > valid_bytes || size > (uint64_t)valid_bytes - at) return REDUCTION_ERR_BOUNDS;
        double value = numeric_decode(source + (uint32_t)at, data_type, little_endian);
        if (as_f32) value = (double)(float)value;
        if (!__builtin_isfinite(value)) continue;
        if (value < result[0]) result[0] = value;
        if (value > result[1]) result[1] = value;
        result[2] += 1;
        result[3] += value;
        result[4] += value * value;
        if (bins) {
            double bin = __builtin_floor((value - min) * scale);
            /* Match JS's ignored NaN index for a constant too large for
             * min + 1e-6 to change its double representation. */
            if (bin != bin) continue;
            if (bin < 0) bin = 0;
            if (bin > bins - 1) bin = bins - 1;
            result[5 + (uint32_t)bin] += 1;
        }
    }
    return (int32_t)count;
}

