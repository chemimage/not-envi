#include <emscripten.h>
#include <tiffio.h>
#include <stdint.h>
#include <stdlib.h>
#include <string.h>
#include <stdio.h>
#include <stdarg.h>

/* TIFF syntax, directory validation, predictors and codecs belong to libtiff.
 * This adapter owns only bounded client I/O and the application ABI. */
#define MAX_BLOCK (32u * 1024u * 1024u)
#define MAX_METADATA (16u * 1024u * 1024u)
#define MAX_SAFE_INTEGER 9007199254740991ULL
static TIFF *image;
static uint64_t position;
static uint32_t metadata_limit = MAX_METADATA;
static char last_error[1024];

EM_ASYNC_JS(int, host_read, (double offset, uint32_t destination, uint32_t count), {
    try {
        const bytes = await Module.io.read(offset, count);
        HEAPU8.set(bytes, destination);
        return bytes.length;
    } catch (error) { Module.io.error = error; return -1; }
});
EM_JS(int, host_write, (double offset, uint32_t source, uint32_t count), {
    return Module.io.write(offset, HEAPU8.subarray(source, source + count));
});
EM_JS(double, host_size, (), { return Module.io.size; });
EM_JS(void, emit_scalar, (uint32_t tag, double value), { Module.tag(tag, value); });
EM_JS(void, emit_array, (uint32_t tag, uint32_t kind, uint32_t count, uint32_t pointer), {
    const view = new DataView(HEAPU8.buffer, pointer, count * kind);
    const values = kind === 8 ? new Float64Array(count) : new Uint32Array(count);
    for (let i = 0; i < count; i++) {
        const value = kind === 8 ? Number(view.getBigUint64(i * 8, true)) : kind === 4 ? view.getUint32(i * 4, true) : view.getUint16(i * 2, true);
        if (!Number.isSafeInteger(value)) throw new RangeError('TIFF metadata exceeds the exact integer range.');
        values[i] = value;
    }
    Module.tag(tag, kind === 8 && values.every(value => value <= 0xffffffff) ? Uint32Array.from(values) : values);
});
EM_JS(void, emit_string, (uint32_t tag, uint32_t pointer), { Module.tag(tag, UTF8ToString(pointer)); });
EM_JS(void, emit_bytes, (uint32_t tag, uint32_t count, uint32_t pointer), { Module.tag(tag, HEAPU8.slice(pointer, pointer + count)); });

static tmsize_t reader(thandle_t client, void *buffer, tmsize_t count) {
    (void)client;
    if (count < 0 || count > metadata_limit || position > MAX_SAFE_INTEGER) return -1;
    int result = host_read((double)position, (uint32_t)(uintptr_t)buffer, count);
    if (result > 0) position += result;
    return result;
}
static tmsize_t writer(thandle_t client, void *buffer, tmsize_t count) {
    (void)client;
    if (count < 0 || count > MAX_BLOCK) return -1;
    int result = host_write((double)position, (uint32_t)(uintptr_t)buffer, count);
    if (result > 0) position += result;
    return result;
}
static toff_t seeker(thandle_t client, toff_t offset, int whence) {
    (void)client;
    uint64_t base = whence == SEEK_SET ? 0 : whence == SEEK_CUR ? position : (uint64_t)host_size();
    int64_t delta = (int64_t)offset;
    if (base > MAX_SAFE_INTEGER || (delta >= 0 && (uint64_t)delta > MAX_SAFE_INTEGER - base)) return (toff_t)-1;
    if (delta < 0 && (uint64_t)(-(delta + 1)) + 1 > base) return (toff_t)-1;
    position = delta < 0 ? base - ((uint64_t)(-(delta + 1)) + 1) : base + (uint64_t)delta;
    return position;
}
static int closer(thandle_t client) { (void)client; return 0; }
static toff_t sizer(thandle_t client) { (void)client; return (toff_t)host_size(); }
static int error_handler(TIFF *tif, void *user, const char *module, const char *format, va_list args) {
    (void)tif; (void)user; (void)module;
    vsnprintf(last_error, sizeof(last_error), format, args);
    return 1;
}
static int warning_handler(TIFF *tif, void *user, const char *module, const char *format, va_list args) {
    (void)tif; (void)user; (void)module; (void)format; (void)args;
    return 1;
}
static TIFF *open_client(const char *mode) {
    position = 0;
    last_error[0] = 0;
    TIFFOpenOptions *options = TIFFOpenOptionsAlloc();
    TIFFOpenOptionsSetMaxSingleMemAlloc(options, metadata_limit);
    TIFFOpenOptionsSetMaxCumulatedMemAlloc(options, metadata_limit);
    TIFFOpenOptionsSetErrorHandlerExtR(options, error_handler, NULL);
    TIFFOpenOptionsSetWarningHandlerExtR(options, warning_handler, NULL);
    TIFF *result = TIFFClientOpenExt("Hyve client I/O", mode, (thandle_t)1, reader, writer, seeker, closer, sizer, NULL, NULL, options);
    TIFFOpenOptionsFree(options);
    return result;
}
EMSCRIPTEN_KEEPALIVE const char *hyve_error(void) { return last_error; }
EMSCRIPTEN_KEEPALIVE void hyve_close(void) {
    if (image) TIFFClose(image);
    image = NULL;
}
EMSCRIPTEN_KEEPALIVE double hyve_offset(void) { return image ? (double)TIFFCurrentDirOffset(image) : 0; }
EMSCRIPTEN_KEEPALIVE int hyve_big_tiff(void) { return image && TIFFIsBigTIFF(image); }
EMSCRIPTEN_KEEPALIVE int hyve_little_endian(void) { return image && !TIFFIsByteSwapped(image); }
EMSCRIPTEN_KEEPALIVE int hyve_open(uint32_t limit) {
    hyve_close();
    metadata_limit = limit && limit <= MAX_METADATA ? limit : MAX_METADATA;
    /* wasm32 cannot represent a >2 GiB strip buffer. Chopping lets libtiff
     * validate such raw files; JS proves/coalesces contiguous raw byte ranges. */
    image = open_client("rCm");
    return image != NULL;
}
static int array(uint32_t tag, uint32_t kind, uint32_t count, const void *pointer) {
    if ((uint64_t)kind * count > metadata_limit) return 0;
    emit_array(tag, kind, count, (uint32_t)(uintptr_t)pointer);
    return 1;
}
EMSCRIPTEN_KEEPALIVE int hyve_directory(double offset) {
    if (!image || offset < 0 || offset > MAX_SAFE_INTEGER || !TIFFSetSubDirectory(image, (uint64_t)offset)) return 0;
    uint32_t value32;
    uint16_t value16;
    const uint32_t longs[] = {TIFFTAG_SUBFILETYPE, TIFFTAG_IMAGEWIDTH, TIFFTAG_IMAGELENGTH, TIFFTAG_ROWSPERSTRIP, TIFFTAG_TILEWIDTH, TIFFTAG_TILELENGTH};
    const uint32_t shorts[] = {TIFFTAG_BITSPERSAMPLE, TIFFTAG_SAMPLESPERPIXEL, TIFFTAG_SAMPLEFORMAT, TIFFTAG_COMPRESSION, TIFFTAG_PHOTOMETRIC, TIFFTAG_PLANARCONFIG, TIFFTAG_FILLORDER, TIFFTAG_ORIENTATION};
    for (unsigned i = 0; i < sizeof(longs) / sizeof(*longs); i++) if (TIFFGetField(image, longs[i], &value32)) emit_scalar(longs[i], value32);
    for (unsigned i = 0; i < sizeof(shorts) / sizeof(*shorts); i++) if (TIFFGetFieldDefaulted(image, shorts[i], &value16)) emit_scalar(shorts[i], value16);
    uint16_t compression;
    TIFFGetFieldDefaulted(image, TIFFTAG_COMPRESSION, &compression);
    if ((compression == COMPRESSION_LZW || compression == COMPRESSION_ADOBE_DEFLATE || compression == COMPRESSION_DEFLATE)
        && TIFFGetFieldDefaulted(image, TIFFTAG_PREDICTOR, &value16)) emit_scalar(TIFFTAG_PREDICTOR, value16);
    uint16_t samples;
    TIFFGetFieldDefaulted(image, TIFFTAG_SAMPLESPERPIXEL, &samples);
    if (!samples || samples > 4096) { snprintf(last_error, sizeof(last_error), "SamplesPerPixel exceeds supported limit of 4096"); return 0; }
    uint64_t *values64;
    uint32_t blocks = TIFFIsTiled(image) ? TIFFNumberOfTiles(image) : TIFFNumberOfStrips(image);
    if ((uint64_t)blocks * 16 > metadata_limit) { snprintf(last_error, sizeof(last_error), "TIFF metadata exceeds parsing limit for block columns"); return 0; }
    uint32_t offsets_tag = TIFFIsTiled(image) ? TIFFTAG_TILEOFFSETS : TIFFTAG_STRIPOFFSETS;
    uint32_t counts_tag = TIFFIsTiled(image) ? TIFFTAG_TILEBYTECOUNTS : TIFFTAG_STRIPBYTECOUNTS;
    if (!TIFFGetField(image, offsets_tag, &values64) || !array(offsets_tag, 8, blocks, values64)) return 0;
    if (!TIFFGetField(image, counts_tag, &values64) || !array(counts_tag, 8, blocks, values64)) return 0;
    uint16_t count;
    if (TIFFGetField(image, TIFFTAG_SUBIFD, &count, &values64) && !array(TIFFTAG_SUBIFD, 8, count, values64)) return 0;
    uint16_t page, total;
    if (TIFFGetField(image, TIFFTAG_PAGENUMBER, &page, &total)) { uint16_t pages[] = {page, total}; array(TIFFTAG_PAGENUMBER, 2, 2, pages); }
    const uint32_t strings[] = {TIFFTAG_IMAGEDESCRIPTION, TIFFTAG_PAGENAME};
    for (unsigned i = 0; i < sizeof(strings) / sizeof(*strings); i++) {
        char *text;
        if (TIFFGetField(image, strings[i], &text)) emit_string(strings[i], (uint32_t)(uintptr_t)text);
    }
    uint32_t byte_count; void *bytes;
    if (TIFFGetField(image, TIFFTAG_JPEGTABLES, &byte_count, &bytes)) {
        if (byte_count > metadata_limit) return 0;
        emit_bytes(TIFFTAG_JPEGTABLES, byte_count, (uint32_t)(uintptr_t)bytes);
    }
    return 1;
}
EMSCRIPTEN_KEEPALIVE double hyve_next(void) {
    if (!image || TIFFLastDirectory(image)) return 0;
    if (TIFFReadDirectory(image)) return (double)TIFFCurrentDirOffset(image);
    if (!last_error[0]) snprintf(last_error, sizeof(last_error), "TIFF contains a cyclic or invalid next IFD chain.");
    return -1;
}

/* Use the standard writer to describe an already-fetched block to the standard
 * reader. No application TIFF encoder/parser is needed for this codec bridge. */
EMSCRIPTEN_KEEPALIVE int hyve_codec(uint32_t width, uint32_t rows, uint32_t bits, uint32_t samples,
    uint32_t format, uint32_t compression, uint32_t predictor, uint32_t fill_order, uint32_t little_endian) {
    hyve_close();
    metadata_limit = MAX_METADATA;
    TIFF *out = open_client(little_endian ? "wl" : "wb");
    if (!out) return 0;
    int ok = TIFFSetField(out, TIFFTAG_IMAGEWIDTH, width)
        && TIFFSetField(out, TIFFTAG_IMAGELENGTH, rows)
        && TIFFSetField(out, TIFFTAG_ROWSPERSTRIP, rows)
        && TIFFSetField(out, TIFFTAG_BITSPERSAMPLE, bits)
        && TIFFSetField(out, TIFFTAG_SAMPLESPERPIXEL, samples)
        && TIFFSetField(out, TIFFTAG_SAMPLEFORMAT, format)
        && TIFFSetField(out, TIFFTAG_COMPRESSION, compression)
        && TIFFSetField(out, TIFFTAG_PHOTOMETRIC, samples >= 3 ? PHOTOMETRIC_RGB : PHOTOMETRIC_MINISBLACK)
        && TIFFSetField(out, TIFFTAG_PLANARCONFIG, PLANARCONFIG_CONTIG)
        && TIFFSetField(out, TIFFTAG_FILLORDER, fill_order);
    if (predictor != 1) ok = ok && TIFFSetField(out, TIFFTAG_PREDICTOR, predictor);
    uint8_t dummy = 0;
    ok = ok && TIFFWriteRawStrip(out, 0, &dummy, 1) == 1 && TIFFWriteDirectory(out);
    TIFFClose(out);
    if (!ok) return 0;
    image = open_client("rcm");
    return image != NULL;
}
EMSCRIPTEN_KEEPALIVE int hyve_decode(uint32_t input, uint32_t input_size, uint32_t output, uint32_t output_size) {
    if (!image || input_size > MAX_BLOCK || output_size > MAX_BLOCK) return 0;
    if (!TIFFReadFromUserBuffer(image, 0, (void *)(uintptr_t)input, input_size, (void *)(uintptr_t)output, output_size)) return 0;
    /* Dataset buffers retain file byte order, as do uncompressed range reads. */
    if (TIFFIsByteSwapped(image)) {
        uint16_t bits;
        TIFFGetFieldDefaulted(image, TIFFTAG_BITSPERSAMPLE, &bits);
        if (bits == 16) TIFFSwabArrayOfShort((uint16_t *)(uintptr_t)output, output_size / 2);
        else if (bits == 32) TIFFSwabArrayOfLong((uint32_t *)(uintptr_t)output, output_size / 4);
        else if (bits == 64) TIFFSwabArrayOfDouble((double *)(uintptr_t)output, output_size / 8);
    }
    return 1;
}
