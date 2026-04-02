class GeotiffFallbackBackend {
  constructor(file, tiff, GeoTIFFImage) {
    this.file = file;
    this.tiff = tiff;
    this.GeoTIFFImage = GeoTIFFImage;
    this.littleEndian = !!tiff?.littleEndian;
    this.bigTiff = !!tiff?.bigTiff;
  }

  async getImageCount() {
    if (typeof this.tiff?.getImageCount === "function") {
      return this.tiff.getImageCount();
    }
    return 0;
  }

  async getImage(index = 0) {
    return this.tiff.getImage(index);
  }

  async parseFileDirectoryAt(offset) {
    const parsed = await this.tiff.parseFileDirectoryAt(offset);
    const image = this.#buildImageFromParsedIfd(parsed);
    return {
      ...parsed,
      image
    };
  }

  close() {
    if (typeof this.tiff?.close === "function") {
      this.tiff.close();
    }
  }

  #buildImageFromParsedIfd(parsed) {
    if (parsed?.image) return parsed.image;
    if (!parsed?.fileDirectory || !this.GeoTIFFImage || !this.tiff?.source) return null;
    return new this.GeoTIFFImage(
      parsed.fileDirectory,
      parsed.geoKeyDirectory || null,
      this.tiff.dataView || null,
      !!this.tiff.littleEndian,
      !!this.tiff.cache,
      this.tiff.source
    );
  }
}

export async function openGeotiffFallback(file) {
  const { GeoTIFFImage, fromBlob } = await import("geotiff");
  const tiff = await fromBlob(file);
  return new GeotiffFallbackBackend(file, tiff, GeoTIFFImage);
}
