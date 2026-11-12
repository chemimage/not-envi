#include <numeric.h>

float numeric_decode_f32(const uint8_t *source, uint32_t little_endian) {
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
    uint64_t mask = width == 8u ? UINT64_MAX : ((1ull << (width * 8u)) - 1u);
    uint64_t magnitude;
    if ((bits & sign_bit) == 0) return (double)bits;
    magnitude = ((~bits) & mask) + 1u;
    return -(double)magnitude;
}

uint32_t numeric_type_size(uint32_t data_type) {
    switch (data_type) {
        case NUMERIC_UINT8: return 1;
        case NUMERIC_INT16:
        case NUMERIC_UINT16: return 2;
        case NUMERIC_INT32:
        case NUMERIC_FLOAT32:
        case NUMERIC_UINT32: return 4;
        case NUMERIC_FLOAT64:
        case NUMERIC_INT64:
        case NUMERIC_UINT64: return 8;
        default: return 0;
    }
}

double numeric_decode(const uint8_t *source, uint32_t data_type, uint32_t little_endian) {
    union { uint64_t bits; double value; } decoded_f64;
    switch (data_type) {
        case NUMERIC_UINT8: return (double)source[0];
        case NUMERIC_INT16: return decode_signed(decode_uint(source, 2, little_endian), 2);
        case NUMERIC_INT32: return decode_signed(decode_uint(source, 4, little_endian), 4);
        case NUMERIC_FLOAT32: return (double)numeric_decode_f32(source, little_endian);
        case NUMERIC_FLOAT64:
            decoded_f64.bits = decode_uint(source, 8, little_endian);
            return decoded_f64.value;
        case NUMERIC_UINT16: return (double)decode_uint(source, 2, little_endian);
        case NUMERIC_UINT32: return (double)decode_uint(source, 4, little_endian);
        case NUMERIC_INT64: return decode_signed(decode_uint(source, 8, little_endian), 8);
        case NUMERIC_UINT64: return (double)decode_uint(source, 8, little_endian);
        default: return 0;
    }
}

