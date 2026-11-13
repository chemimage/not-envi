#include <emscripten.h>
#include <emscripten/heap.h>
#include <tiffio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

#define LIMIT (32u * 1024u * 1024u)
#define CACHE_LIMIT (64u * 1024u * 1024u)
#define CACHE_SLOTS 256
static TIFF *image;
static uint64_t position;
static uint32_t width, height, tile_width, tile_height;
static uint16_t samples, bits, sample_format, compression;
static uint8_t *output, *row_buffer;
static size_t output_capacity, row_capacity;
static char last_error[1024];
static uint64_t sub_offsets[16];
static uint16_t sub_count;
static uint32_t peak_heap;
typedef struct { uint8_t *data; uint64_t directory; uint32_t block, size, stamp; } cached_block;
static cached_block blocks[CACHE_SLOTS];
static uint32_t cache_bytes, stamp, decode_calls;

EM_JS(int, host_read, (double offset, uint32_t destination, uint32_t count), {
  try { const bytes = Module.io.read(offset, count); HEAPU8.set(bytes, destination); return bytes.length; }
  catch (error) { Module.io.error = String(error); return -1; }
});
EM_JS(int, host_write, (double offset, uint32_t source, uint32_t count), {
  return Module.io.write(offset, HEAPU8.subarray(source, source + count));
});
EM_JS(double, host_size, (), { return Module.io.size; });

static tmsize_t reader(thandle_t client, void *buffer, tmsize_t count) {
  (void)client;
  if (count < 0 || count > LIMIT) return -1;
  int result = host_read((double)position, (uint32_t)(uintptr_t)buffer, (uint32_t)count);
  if (result > 0) position += (uint32_t)result;
  return result;
}
static tmsize_t writer(thandle_t client, void *buffer, tmsize_t count) {
  (void)client;
  if (count < 0 || count > LIMIT) return -1;
  int result = host_write((double)position, (uint32_t)(uintptr_t)buffer, (uint32_t)count);
  if (result > 0) position += (uint32_t)result;
  return result;
}
static toff_t seeker(thandle_t client, toff_t offset, int origin) {
  (void)client;
  int64_t base = origin == SEEK_SET ? 0 : origin == SEEK_CUR ? (int64_t)position : (int64_t)host_size();
  int64_t target = base + (int64_t)offset;
  if (target < 0 || (uint64_t)target > 9007199254740991ULL) return (toff_t)-1;
  position = (uint64_t)target; return position;
}
static int closer(thandle_t client) { (void)client; return 0; }
static toff_t sizer(thandle_t client) { (void)client; return (toff_t)host_size(); }
static int report_error(TIFF *tif, void *user, const char *module, const char *format, va_list args) {
  (void)tif; (void)user; (void)module;
  vsnprintf(last_error, sizeof(last_error), format, args); return 1;
}
static int ignore_warning(TIFF *tif, void *user, const char *module, const char *format, va_list args) {
  (void)tif; (void)user; (void)module; (void)format; (void)args; return 1;
}
static TIFF *open_client(const char *mode) {
  position = 0; last_error[0] = 0;
  TIFFOpenOptions *options = TIFFOpenOptionsAlloc();
  TIFFOpenOptionsSetMaxSingleMemAlloc(options, LIMIT);
  TIFFOpenOptionsSetMaxCumulatedMemAlloc(options, 96u * 1024u * 1024u);
  TIFFOpenOptionsSetErrorHandlerExtR(options, report_error, NULL);
  TIFFOpenOptionsSetWarningHandlerExtR(options, ignore_warning, NULL);
  TIFF *result = TIFFClientOpenExt("browser-file", mode, (thandle_t)1, reader, writer, seeker, closer, sizer, NULL, NULL, options);
  TIFFOpenOptionsFree(options); return result;
}
static void observe_heap(void) {
  uint32_t size = emscripten_get_heap_size(); if (size > peak_heap) peak_heap = size;
}
static int resize(uint8_t **buffer, size_t *capacity, size_t needed) {
  if (needed > LIMIT) { snprintf(last_error, sizeof(last_error), "Prototype allocation exceeds 32 MiB"); return 0; }
  if (*capacity >= needed) return 1;
  void *next = realloc(*buffer, needed); if (!next) return 0;
  *buffer = next; *capacity = needed; observe_heap(); return 1;
}
static void clear_blocks(void) {
  for (int i=0; i<CACHE_SLOTS; i++) { free(blocks[i].data); memset(&blocks[i], 0, sizeof(blocks[i])); }
  cache_bytes = 0; stamp = 0; decode_calls = 0;
}
EMSCRIPTEN_KEEPALIVE void probe_close(void) {
  if (image) TIFFClose(image);
  image = NULL; clear_blocks(); free(output); output = NULL; output_capacity = 0;
  free(row_buffer); row_buffer = NULL; row_capacity = 0;
}
static int metadata(void) {
  if (!TIFFGetField(image, TIFFTAG_IMAGEWIDTH, &width) || !TIFFGetField(image, TIFFTAG_IMAGELENGTH, &height)) return 0;
  TIFFGetFieldDefaulted(image, TIFFTAG_SAMPLESPERPIXEL, &samples);
  TIFFGetFieldDefaulted(image, TIFFTAG_BITSPERSAMPLE, &bits);
  TIFFGetFieldDefaulted(image, TIFFTAG_SAMPLEFORMAT, &sample_format);
  TIFFGetFieldDefaulted(image, TIFFTAG_COMPRESSION, &compression);
  uint16_t planar; TIFFGetFieldDefaulted(image, TIFFTAG_PLANARCONFIG, &planar);
  if (planar != PLANARCONFIG_CONTIG || (samples != 1 && samples != 3) || (bits != 8 && bits != 32)) return 0;
  if (TIFFIsTiled(image)) {
    TIFFGetField(image, TIFFTAG_TILEWIDTH, &tile_width); TIFFGetField(image, TIFFTAG_TILELENGTH, &tile_height);
  } else { tile_width = width; TIFFGetFieldDefaulted(image, TIFFTAG_ROWSPERSTRIP, &tile_height); }
  observe_heap(); return 1;
}
EMSCRIPTEN_KEEPALIVE int probe_open(void) {
  probe_close(); peak_heap = emscripten_get_heap_size();
  image = open_client("rCm"); // bounded strip chopping; whole-file mapping disabled.
  if (!image || !metadata()) return 0;
  uint64_t *offsets = NULL; sub_count = 0;
  if (TIFFGetField(image, TIFFTAG_SUBIFD, &sub_count, &offsets)) {
    if (sub_count > 16) sub_count = 16;
    memcpy(sub_offsets, offsets, sub_count * sizeof(uint64_t));
  }
  return 1;
}
EMSCRIPTEN_KEEPALIVE int probe_directory(uint32_t level) {
  if (!image) return 0;
  int ok = level && sub_count ? (level <= sub_count && TIFFSetSubDirectory(image, sub_offsets[level - 1])) : TIFFSetDirectory(image, level);
  return ok && metadata();
}
EMSCRIPTEN_KEEPALIVE double probe_info(int field) {
  if (field == 0) return width; if (field == 1) return height; if (field == 2) return samples;
  if (field == 3) return bits; if (field == 4) return compression; if (field == 5) return TIFFIsTiled(image);
  if (field == 6) return tile_width; if (field == 7) return tile_height; if (field == 8) return sample_format;
  if (field == 9) return peak_heap; if (field == 10) return cache_bytes; if (field == 11) return decode_calls;
  if (field == 12) return sub_count; return -1;
}
EMSCRIPTEN_KEEPALIVE const char *probe_error(void) { return last_error; }
EMSCRIPTEN_KEEPALIVE uint32_t probe_output(void) { return (uint32_t)(uintptr_t)output; }
EMSCRIPTEN_KEEPALIVE double probe_block_offset(uint32_t block) { return (double)TIFFGetStrileOffset(image, block); }
EMSCRIPTEN_KEEPALIVE double probe_block_bytes(uint32_t block) { return (double)TIFFGetStrileByteCount(image, block); }
EMSCRIPTEN_KEEPALIVE uint32_t probe_block_size(void) {
  uint64_t bytes = TIFFIsTiled(image) ? TIFFTileSize64(image) : TIFFStripSize64(image);
  return bytes <= LIMIT ? (uint32_t)bytes : 0;
}
static cached_block *get_block(uint32_t index) {
  uint64_t directory = TIFFCurrentDirOffset(image);
  uint32_t size = probe_block_size(); if (!size) return NULL;
  for (int i=0; i<CACHE_SLOTS; i++) if (blocks[i].data && blocks[i].directory == directory && blocks[i].block == index) {
    blocks[i].stamp = ++stamp; return &blocks[i];
  }
  int victim = -1;
  while (cache_bytes + size > CACHE_LIMIT) {
    victim = -1;
    for (int i=0; i<CACHE_SLOTS; i++) if (blocks[i].data && (victim < 0 || blocks[i].stamp < blocks[victim].stamp)) victim = i;
    if (victim < 0) return NULL;
    cache_bytes -= blocks[victim].size; free(blocks[victim].data); memset(&blocks[victim], 0, sizeof(blocks[victim]));
  }
  {
    victim = 0;
    for (int i=0; i<CACHE_SLOTS; i++) {
      if (!blocks[i].data) { victim = i; break; }
      if (blocks[i].stamp < blocks[victim].stamp) victim = i;
    }
    cache_bytes -= blocks[victim].size; free(blocks[victim].data); memset(&blocks[victim], 0, sizeof(blocks[victim]));
  }
  cached_block *entry = &blocks[victim];
  entry->data = malloc(size); if (!entry->data) return NULL;
  tmsize_t result = TIFFIsTiled(image) ? TIFFReadEncodedTile(image, index, entry->data, size) : TIFFReadEncodedStrip(image, index, entry->data, size);
  if (result < 0) { free(entry->data); entry->data = NULL; return NULL; }
  entry->directory = directory; entry->block = index; entry->size = size; entry->stamp = ++stamp;
  cache_bytes += size; decode_calls++; observe_heap(); return entry;
}
EMSCRIPTEN_KEEPALIVE int probe_window(uint32_t x, uint32_t y, uint32_t w, uint32_t h, uint32_t step) {
  const uint32_t pixel_bytes = samples * (bits / 8);
  if (!image || !w || !h || !step || (uint64_t)x + (uint64_t)(w-1)*step >= width || (uint64_t)y + (uint64_t)(h-1)*step >= height) return -1;
  uint64_t bytes = (uint64_t)w*h*pixel_bytes;
  if (bytes > LIMIT || !resize(&output, &output_capacity, (size_t)bytes)) return -1;
  memset(output, 0, (size_t)bytes);
  if (!TIFFIsTiled(image) && compression == COMPRESSION_NONE) {
    uint64_t row_size = TIFFScanlineSize64(image);
    if (row_size > LIMIT || !resize(&row_buffer, &row_capacity, row_size)) return -1;
    for (uint32_t oy=0; oy<h; oy++) {
      if (TIFFReadScanline(image, row_buffer, y + oy*step, 0) < 0) return -1;
      for (uint32_t ox=0; ox<w; ox++) memcpy(output + ((size_t)oy*w+ox)*pixel_bytes, row_buffer+(size_t)(x+ox*step)*pixel_bytes, pixel_bytes);
    }
    observe_heap(); return (int)bytes;
  }
  for (uint32_t by=y/tile_height; by<=(y+(h-1)*step)/tile_height; by++) for (uint32_t bx=x/tile_width; bx<=(x+(w-1)*step)/tile_width; bx++) {
    uint32_t x0=bx*tile_width, y0=by*tile_height;
    uint32_t first_x=x0>x ? (x0-x+step-1)/step : 0, first_y=y0>y ? (y0-y+step-1)/step : 0;
    if (first_x>=w || first_y>=h || x+first_x*step>=x0+tile_width || y+first_y*step>=y0+tile_height) continue;
    uint32_t index = TIFFIsTiled(image) ? TIFFComputeTile(image, x0, y0, 0, 0) : TIFFComputeStrip(image, y0, 0);
    cached_block *block = get_block(index); if (!block) return -1;
    for (uint32_t oy=first_y; oy<h && y+oy*step<y0+tile_height; oy++) for (uint32_t ox=first_x; ox<w && x+ox*step<x0+tile_width; ox++) {
      size_t at=((size_t)(y+oy*step-y0)*tile_width+(x+ox*step-x0))*pixel_bytes;
      if (at+pixel_bytes > block->size) return -1;
      memcpy(output+((size_t)oy*w+ox)*pixel_bytes, block->data+at, pixel_bytes);
    }
  }
  return (int)bytes;
}
EMSCRIPTEN_KEEPALIVE int probe_decode_user(uint32_t block, uint32_t input, uint32_t count) {
  uint32_t size = probe_block_size(); if (!size || !resize(&output, &output_capacity, size)) return -1;
  if (!TIFFReadFromUserBuffer(image, block, (void *)(uintptr_t)input, count, output, size)) return -1;
  observe_heap(); return size;
}

#ifndef PROBE_READER_ONLY
EMSCRIPTEN_KEEPALIVE int probe_fixture(int codec, int predictor, int float_data, int channels, int tiled, int pyramid, int noise) {
  probe_close();
  TIFF *out = open_client("wl"); if (!out) return 0;
  uint64_t children[2] = {0,0};
  for (int level=0; level<(pyramid ? 3 : 1); level++) {
    uint32_t dim=1024u>>level, bw=tiled ? 128 : dim, bh=tiled ? 128 : 16;
    uint32_t bps=float_data ? 4 : 1;
    TIFFSetField(out, TIFFTAG_IMAGEWIDTH, dim); TIFFSetField(out, TIFFTAG_IMAGELENGTH, dim);
    TIFFSetField(out, TIFFTAG_SAMPLESPERPIXEL, channels); TIFFSetField(out, TIFFTAG_BITSPERSAMPLE, bps*8);
    TIFFSetField(out, TIFFTAG_SAMPLEFORMAT, float_data ? SAMPLEFORMAT_IEEEFP : SAMPLEFORMAT_UINT);
    TIFFSetField(out, TIFFTAG_PHOTOMETRIC, channels==3 ? PHOTOMETRIC_RGB : PHOTOMETRIC_MINISBLACK);
    TIFFSetField(out, TIFFTAG_PLANARCONFIG, PLANARCONFIG_CONTIG); TIFFSetField(out, TIFFTAG_COMPRESSION, codec);
    if (predictor>1) TIFFSetField(out, TIFFTAG_PREDICTOR, predictor);
    if (level) TIFFSetField(out, TIFFTAG_SUBFILETYPE, FILETYPE_REDUCEDIMAGE);
    if (!level && pyramid==2) TIFFSetField(out, TIFFTAG_SUBIFD, 2, children);
    if (tiled) { TIFFSetField(out, TIFFTAG_TILEWIDTH, bw); TIFFSetField(out, TIFFTAG_TILELENGTH, bh); }
    else TIFFSetField(out, TIFFTAG_ROWSPERSTRIP, bh);
    size_t size=(size_t)bw*bh*channels*bps;
    uint8_t *data=malloc(size); if (!data) { TIFFClose(out); return 0; }
    for (uint32_t y=0; y<dim; y+=bh) for (uint32_t x=0; x<dim; x+=bw) {
      for (uint32_t yy=0; yy<bh; yy++) for (uint32_t xx=0; xx<bw; xx++) for(int c=0;c<channels;c++) {
        uint32_t gx=(x+xx)<<level, gy=(y+yy)<<level;
        size_t i=((size_t)yy*bw+xx)*channels+c;
        uint32_t v=(gx*13+gy*7+((gx>>5)^(gy>>4))*31+c*53);
        if (noise) { v=(gy*1024+gx+1+c*77); v=(v^(v>>16))*0x45d9f3b; v=(v^(v>>16))*0x45d9f3b; v=v^(v>>16); }
        if (float_data) ((float *)data)[i]=(float)gx/1024.0f+(float)gy/2048.0f+(float)c*0.125f;
        else data[i]=(uint8_t)v;
      }
      uint32_t index=tiled ? TIFFComputeTile(out,x,y,0,0) : TIFFComputeStrip(out,y,0);
      tmsize_t written=tiled ? TIFFWriteEncodedTile(out,index,data,size) : TIFFWriteEncodedStrip(out,index,data,size);
      if (written<0) { free(data); TIFFClose(out); return 0; }
    }
    free(data);
    if (!TIFFWriteDirectory(out)) { TIFFClose(out); return 0; }
  }
  TIFFClose(out); observe_heap(); return 1;
}
#endif
