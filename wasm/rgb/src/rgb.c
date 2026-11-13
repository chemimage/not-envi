#include <stdint.h>
#include <wasm_simd128.h>

typedef struct { double min, max, brightness, gain, contrast; } Tone;
static double clamp(double v) { return v < 0.0 ? 0.0 : v > 1.0 ? 1.0 : v; }
// Explicit NaN propagation matches JS Math.min/max; the final byte is zero.
static unsigned map(double v, const Tone *p) {
  double x = (v - p->min) / (p->max - p->min);
  if (__builtin_isnan(x)) return 0;
  x = clamp(x);
  x = (x - 0.5) * p->contrast + 0.5;
  x = (x + p->brightness) * p->gain;
  if (__builtin_isnan(x)) return 0;
  x = clamp(x) * 255.0;
  double lo = __builtin_floor(x);
  return (unsigned)lo + (x - lo >= 0.5);
}

static void scalar(const float *r, const float *g, const float *b, uint32_t *out,
            const Tone *p, int width, int x, int y, int rw, int rh, int transparent) {
  for (int row = y; row < y + rh; row++) for (int i = row * width + x; i < row * width + x + rw; i++) {
    if (transparent && (!__builtin_isfinite(r[i]) || !__builtin_isfinite(g[i]) || !__builtin_isfinite(b[i]))) out[i] = 0;
    else out[i] = map(r[i], p) | (map(g[i], p + 1) << 8) | (map(b[i], p + 2) << 16) | 0xff000000u;
  }
}

typedef struct { v128_t min, span, brightness, gain, contrast; } VectorTone;
static VectorTone prepare(const Tone *p) {
  return (VectorTone){wasm_f64x2_splat(p->min), wasm_f64x2_splat(p->max - p->min),
    wasm_f64x2_splat(p->brightness), wasm_f64x2_splat(p->gain), wasm_f64x2_splat(p->contrast)};
}
static v128_t map2(v128_t v, VectorTone p) {
  const v128_t zero = wasm_f64x2_splat(0), one = wasm_f64x2_splat(1), half = wasm_f64x2_splat(0.5);
  v = wasm_f64x2_div(wasm_f64x2_sub(v, p.min), p.span);
  v128_t valid = wasm_f64x2_eq(v, v);
  v = wasm_f64x2_pmin(one, wasm_f64x2_pmax(zero, v));
  v = wasm_f64x2_add(wasm_f64x2_mul(wasm_f64x2_sub(v, half), p.contrast), half);
  v = wasm_f64x2_mul(wasm_f64x2_add(v, p.brightness), p.gain);
  valid = wasm_v128_and(valid, wasm_f64x2_eq(v, v));
  v = wasm_f64x2_mul(wasm_f64x2_pmin(one, wasm_f64x2_pmax(zero, v)), wasm_f64x2_splat(255));
  v128_t lo = wasm_f64x2_floor(v);
  v128_t rounded = wasm_f64x2_add(lo, wasm_v128_and(wasm_f64x2_ge(wasm_f64x2_sub(v, lo), half), one));
  // Rounded values are integral in [0,255]. Adding 2^52 exposes that integer
  // in the low mantissa bits, avoiding a saturating SIMD float conversion.
  rounded = wasm_f64x2_add(rounded, wasm_f64x2_splat(4503599627370496.0));
  rounded = wasm_v128_and(rounded, valid);
  return wasm_i32x4_shuffle(rounded, rounded, 0, 2, 0, 2);
}

static void simd(const float *r, const float *g, const float *b, uint32_t *out,
          const Tone *p, int width, int x, int y, int rw, int rh, int transparent) {
  VectorTone pr = prepare(p), pg = prepare(p + 1), pb = prepare(p + 2);
  for (int row = y; row < y + rh; row++) {
    int i = row * width + x, end = i + rw;
    for (; i + 1 < end; i += 2) {
      v128_t vr = wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(r + i));
      v128_t vg = wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(g + i));
      v128_t vb = wasm_f64x2_promote_low_f32x4(wasm_v128_load64_zero(b + i));
      v128_t pixels = wasm_v128_or(wasm_i32x4_splat(0xff000000u), wasm_v128_or(map2(vr, pr),
        wasm_v128_or(wasm_i32x4_shl(map2(vg, pg), 8), wasm_i32x4_shl(map2(vb, pb), 16))));
      if (transparent) {
        v128_t limit = wasm_f64x2_splat(3.4028234663852886e38);
        v128_t valid = wasm_v128_and(wasm_f64x2_le(wasm_f64x2_abs(vr), limit),
          wasm_v128_and(wasm_f64x2_le(wasm_f64x2_abs(vg), limit), wasm_f64x2_le(wasm_f64x2_abs(vb), limit)));
        pixels = wasm_v128_and(pixels, wasm_i32x4_shuffle(valid, valid, 0, 2, 0, 2));
      }
      wasm_v128_store64_lane(out + i, pixels, 0);
    }
    if (i < end) scalar(r, g, b, out, p, width, i - row * width, row, 1, 1, transparent);
  }
}

#define RGB_CAPACITY 16384
static float input[3][RGB_CAPACITY];
static uint32_t rgba[RGB_CAPACITY];
static Tone tones[3];
__attribute__((export_name("rgb_input"))) uintptr_t rgb_input(unsigned channel) { return (uintptr_t)input[channel < 3 ? channel : 0]; }
__attribute__((export_name("rgb_output"))) uintptr_t rgb_output(void) { return (uintptr_t)rgba; }
__attribute__((export_name("rgb_tones"))) uintptr_t rgb_tones(void) { return (uintptr_t)tones; }
__attribute__((export_name("rgb_capacity"))) unsigned rgb_capacity(void) { return RGB_CAPACITY; }
__attribute__((export_name("rgb_color"))) int rgb_color(unsigned width, unsigned height, int transparent) {
  if (!width || width > RGB_CAPACITY || !height || height > RGB_CAPACITY / width) return -1;
  simd(input[0], input[1], input[2], rgba, tones, (int)width, 0, 0, (int)width, (int)height, transparent);
  return 0;
}
