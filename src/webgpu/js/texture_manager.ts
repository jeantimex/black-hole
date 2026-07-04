/**
 * Maximum Level of Detail (LOD) level allocated for the high-resolution star textures.
 * Mipmaps beyond this level are stored in a secondary texture (starTexture2) to optimize allocation.
 */
const MAX_STAR_TEXTURE_LOD = 6;

const resolveUrl = function(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  return import.meta.env.BASE_URL + url;
};

/**
 * Loads binary floating-point texture tables via XMLHttpRequest.
 * Parses the ArrayBuffer into a Float32Array using little-endian encoding.
 */
const loadTextureData = function(textureDataUrl: string, callback: (data: Float32Array) => void): void {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', resolveUrl(textureDataUrl));
  xhr.responseType = 'arraybuffer';
  xhr.onload = () => {
    if (xhr.status !== 200) {
      console.error("XHR Failed to load Float data:", textureDataUrl, "status:", xhr.status);
      return;
    }
    try {
      const data = new DataView(xhr.response);
      const array = new Float32Array(data.byteLength / Float32Array.BYTES_PER_ELEMENT);
      for (let i = 0; i < array.length; ++i) {
        // 'true' indicates little-endian format
        array[i] = data.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true);
      }
      callback(array);
    } catch (e) {
      console.error("Error parsing Float data:", textureDataUrl, e);
    }
  };
  xhr.onerror = (e) => {
    console.error("XHR Network Error loading:", textureDataUrl, e);
  };
  xhr.send();
};

/**
 * Loads binary integer texture tables (such as Gaia star map tiles) via XMLHttpRequest.
 * Parses the ArrayBuffer into a Uint32Array using little-endian encoding.
 */
const loadIntTextureData = function(textureDataUrl: string, callback: (data: Uint32Array) => void): void {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', resolveUrl(textureDataUrl));
  xhr.responseType = 'arraybuffer';
  xhr.onload = () => {
    if (xhr.status !== 200) {
      console.error("XHR Failed to load Int data:", textureDataUrl, "status:", xhr.status);
      return;
    }
    try {
      const data = new DataView(xhr.response);
      const array = new Uint32Array(data.byteLength / Uint32Array.BYTES_PER_ELEMENT);
      for (let i = 0; i < array.length; ++i) {
        // 'true' indicates little-endian format
        array[i] = data.getUint32(i * Uint32Array.BYTES_PER_ELEMENT, true);
      }
      callback(array);
    } catch (e) {
      console.error("Error parsing Int data:", textureDataUrl, e);
    }
  };
  xhr.onerror = (e) => {
    console.error("XHR Network Error loading:", textureDataUrl, e);
  };
  xhr.send();
};

/**
 * WebGPU requires the `bytesPerRow` parameter in copy operations to be a multiple of 256 bytes.
 * This helper aligns and pads texture data rows to satisfy this WebGPU alignment requirement
 * if the natural layout (width * bytesPerPixel) is not a multiple of 256.
 */
const writeTextureWithPadding = function(
  device: GPUDevice,
  texture: GPUTexture,
  mipLevel: number,
  origin: GPUOrigin3D,
  srcTypedArray: Float32Array | Uint32Array | Uint8Array,
  width: number,
  height: number,
  depth: number,
  bytesPerPixel: number
): void {
  const actualBytesPerRow = width * bytesPerPixel;
  // If already aligned or height is 1, we can write directly without padding.
  if (actualBytesPerRow % 256 === 0 || height <= 1) {
    device.queue.writeTexture(
      { texture, mipLevel, origin },
      srcTypedArray,
      { bytesPerRow: actualBytesPerRow, rowsPerImage: height },
      [width, height, depth]
    );
  } else {
    // Calculate aligned row size (nearest multiple of 256 bytes above actualBytesPerRow)
    const alignedBytesPerRow = Math.ceil(actualBytesPerRow / 256) * 256;
    const alignedWordsPerRow = alignedBytesPerRow / srcTypedArray.BYTES_PER_ELEMENT;
    const srcWordsPerRow = actualBytesPerRow / srcTypedArray.BYTES_PER_ELEMENT;
    const paddedSize = alignedWordsPerRow * height * depth;
    
    // Instantiate matching typed array for padded storage.
    const paddedData = new (srcTypedArray.constructor as any)(paddedSize);
    for (let d = 0; d < depth; ++d) {
      for (let y = 0; y < height; ++y) {
        const srcOffset = d * srcWordsPerRow * height + y * srcWordsPerRow;
        const dstOffset = d * alignedWordsPerRow * height + y * alignedWordsPerRow;
        // Copy each row of pixels individually into the aligned memory layout.
        paddedData.set(
          srcTypedArray.subarray(srcOffset, srcOffset + srcWordsPerRow),
          dstOffset
        );
      }
    }
    // Upload aligned/padded buffer to the WebGPU queue.
    device.queue.writeTexture(
      { texture, mipLevel, origin },
      paddedData,
      { bytesPerRow: alignedBytesPerRow, rowsPerImage: height },
      [width, height, depth]
    );
  }
};

/** Metadata detailing an individual star tile to load. */
interface StarTile {
  l: number;    // LOD level
  ti: number;   // Tile index x
  tj: number;   // Tile index y
  i: number;    // Cube face (0-5)
  url: string;  // Target URL
}

/**
 * TextureManager orchestrates downloading, caching, formatting,
 * and loading WebGPU textures, textures look-up tables (LUTs), and samplers.
 */
export class TextureManager {
  private loadingPanel: HTMLElement;
  private loadingBar: HTMLElement;
  private device: GPUDevice;

  // Look-up textures for Schwarzschild raymarching deflection
  rayDeflectionTexture: GPUTexture | null = null;
  rayInverseRadiusTexture: GPUTexture | null = null;
  
  // Physics look-up tables (LUTs)
  blackbodyTexture: GPUTexture | null = null;
  dopplerTexture: GPUTexture | null = null;
  
  // Coordinate reference systems
  gridTexture: GPUTexture | null = null;
  
  // Gaia sky map starfield data textures
  galaxyTexture: GPUTexture | null = null;
  starTexture: GPUTexture | null = null;
  starTexture2: GPUTexture | null = null;
  
  // High-frequency noise texture
  noiseTexture: GPUTexture | null = null;

  linearSampler: GPUSampler;
  nearestSampler: GPUSampler;

  // Queue to control the loading flow of Gaia star map tiles.
  private tilesQueue: StarTile[] = [];
  private numTilesLoaded = 0;
  private numTilesLoadedPerLevel = [0, 0, 0, 0, 0];
  private numPendingRequests = 0;

  constructor(rootElement: HTMLElement, device: GPUDevice) {
    const panel = rootElement.querySelector('#cv_loading_panel');
    const bar = rootElement.querySelector('#cv_loading_bar');
    if (!panel) throw new Error("cv_loading_panel not found");
    if (!bar) throw new Error("cv_loading_bar not found");

    this.loadingPanel = panel as HTMLElement;
    this.loadingBar = bar as HTMLElement;
    this.device = device;

    // Set up linear sampler with interpolation.
    this.linearSampler = device.createSampler({
      label: 'TextureManagerLinearSampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'linear'
    });
    
    // Set up nearest-neighbor sampler (essential for pixelated deflection tables).
    this.nearestSampler = device.createSampler({
      label: 'TextureManagerNearestSampler',
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      minFilter: 'nearest',
      magFilter: 'nearest'
    });

    // Populate textures.
    this.loadTextures();
    this.loadStarTextures();
    this.loadNoiseTexture('noise_texture.png');

    document.body.addEventListener('keypress', (e) => this.onKeyPress(e));
  }

  /**
   * Loads core LUT tables (Deflection, Inverse Radius, Doppler, Blackbody, Grid cube map).
   */
  private loadTextures(): void {
    const device = this.device;

    // 1. Ray deflection table.
    // Contains pre-calculated deflection angles derived from the Schwarzschild metric equations.
    loadTextureData('deflection.dat', (data) => {
      const width = Math.round(data[0]);
      const height = Math.round(data[1]);
      this.rayDeflectionTexture = device.createTexture({
        size: [width, height, 1],
        format: 'rg32float', // Dual channels for delta-theta and delta-phi deflection
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      device.queue.writeTexture(
        { texture: this.rayDeflectionTexture },
        data.subarray(2),
        { bytesPerRow: width * 8, rowsPerImage: height },
        [width, height, 1]
      );
    });

    // 2. Inverse radius deflection table.
    // Encodes inverse distance bounds used to adjust raymarching step sizes dynamically.
    loadTextureData('inverse_radius.dat', (data) => {
      const width = Math.round(data[0]);
      const height = Math.round(data[1]);
      this.rayInverseRadiusTexture = device.createTexture({
        size: [width, height, 1],
        format: 'rg32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      device.queue.writeTexture(
        { texture: this.rayInverseRadiusTexture },
        data.subarray(2),
        { bytesPerRow: width * 8, rowsPerImage: height },
        [width, height, 1]
      );
    });

    // 3. Doppler effect LUT (3D Texture).
    // Maps observer velocity beta (X), viewing angle theta (Y), and temperature (Z) to color variations.
    this.dopplerTexture = device.createTexture({
      size: [64, 32, 64],
      dimension: '3d',
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    loadTextureData('doppler.dat', (data) => {
      // Expand RGB data into RGBA floats to match GPU expectations.
      const rgbaData = new Float32Array(64 * 32 * 64 * 4);
      for (let i = 0; i < 64 * 32 * 64; ++i) {
        rgbaData[i * 4] = data[i * 3];
        rgbaData[i * 4 + 1] = data[i * 3 + 1];
        rgbaData[i * 4 + 2] = data[i * 3 + 2];
        rgbaData[i * 4 + 3] = 1.0;
      }
      device.queue.writeTexture(
        { texture: this.dopplerTexture! },
        rgbaData,
        { bytesPerRow: 64 * 16, rowsPerImage: 32 },
        [64, 32, 64]
      );
    });

    // 4. Blackbody spectrum LUT (1D Texture).
    // Stores color profiles matching specific thermal temperatures (Planck's Law).
    this.blackbodyTexture = device.createTexture({
      size: [128, 1, 1],
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    loadTextureData('black_body.dat', (data) => {
      const rgbaData = new Float32Array(128 * 4);
      for (let i = 0; i < 128; ++i) {
        rgbaData[i * 4] = data[i * 3];
        rgbaData[i * 4 + 1] = data[i * 3 + 1];
        rgbaData[i * 4 + 2] = data[i * 3 + 2];
        rgbaData[i * 4 + 3] = 1.0;
      }
      device.queue.writeTexture(
        { texture: this.blackbodyTexture! },
        rgbaData,
        { bytesPerRow: 128 * 16, rowsPerImage: 1 },
        [128, 1, 1]
      );
    });

    // 5. Grid helper lines texture (Cube Map).
    // Generates procedural coordinates marking angular structures for visual inspection of lensing.
    this.gridTexture = device.createTexture({
      size: [512, 512, 6],
      mipLevelCount: 10,
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    // Write grid line markings for all 10 mipmap levels, scaling line sizes to avoid aliasing.
    for (let level = 0; level < 10; ++level) {
      const size = 512 >> level;
      const levelData = new Uint8Array(size * size);
      const scale = size / 512.0;
      for (let j = 0; j < size; ++j) {
        const jmod_scaled = Math.floor((j / scale + 2) % 32);
        for (let i = 0; i < size; ++i) {
          const imod_scaled = Math.floor((i / scale + 2) % 32);
          // Highlight rows/columns that match modulo bounds, producing lines.
          levelData[i + j * size] = (imod_scaled < 4 || jmod_scaled < 4) ? 255 : 0;
        }
      }
      for (let face = 0; face < 6; ++face) {
        writeTextureWithPadding(
          device,
          this.gridTexture,
          level,
          { x: 0, y: 0, z: face },
          levelData,
          size,
          size,
          1,
          1
        );
      }
    }
  }

  /**
   * Initializes texture descriptors for the Gaia Sky Map, which uses
   * the 'rgb9e5ufloat' (shared-exponent float) format for HDR starfield representation.
   */
  private loadStarTextures(): void {
    const device = this.device;

    // Full sky map galaxy texture with 12 mipmap levels.
    this.galaxyTexture = device.createTexture({
      size: [2048, 2048, 6],
      mipLevelCount: 12,
      format: 'rgb9e5ufloat',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    // Star texture for LOD levels 0 through MAX_STAR_TEXTURE_LOD.
    this.starTexture = device.createTexture({
      size: [2048, 2048, 6],
      mipLevelCount: MAX_STAR_TEXTURE_LOD + 1,
      format: 'rgb9e5ufloat',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    // Star texture for high frequency LOD levels beyond MAX_STAR_TEXTURE_LOD.
    const starTexture2Size = 2048 / (1 << (MAX_STAR_TEXTURE_LOD + 1));
    this.starTexture2 = device.createTexture({
      size: [starTexture2Size, starTexture2Size, 6],
      mipLevelCount: 11 - MAX_STAR_TEXTURE_LOD,
      format: 'rgb9e5ufloat',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    // Queue up network requests for all star map tiles across 5 LOD levels (l=0 to l=4).
    const base = 'gaia_sky_map';
    const prefixes = ['pos-x', 'neg-x', 'pos-y', 'neg-y', 'pos-z', 'neg-z'];
    for (let l = 0; l <= 4; ++l) {
      const size = 2048 / (1 << l);
      const tileSize = Math.min(256, size);
      const numTiles = size / tileSize;
      for (let i = 0; i < 6; ++i) {
        for (let tj = 0; tj < numTiles; ++tj) {
          for (let ti = 0; ti < numTiles; ++ti) {
            const url = `${base}/${prefixes[i]}-${l}-${ti}-${tj}.dat`;
            this.tilesQueue.push({l, ti, tj, i, url});
          }
        }
      }
    }
    this.updateLoadingBar();
    this.loadStarTextureTiles();
  }

  /**
   * Concurrently processes up to 6 outstanding asset downloads.
   */
  private loadStarTextureTiles(): void {
    while (this.tilesQueue.length > 0 && this.numPendingRequests < 6) {
      const tile = this.tilesQueue.pop();
      if (tile) {
        this.loadStarTextureTile(tile.l, tile.ti, tile.tj, tile.i, tile.url);
      }
    }
  }

  /**
   * Asynchronously fetches a star map tile and maps it onto the appropriate mip level.
   */
  private loadStarTextureTile(l: number, ti: number, tj: number, i: number, url: string): void {
    const device = this.device;
    const size = 2048 / (1 << l);
    loadIntTextureData(url, (data) => {
      let start = 0;
      let level = l;
      let tileSize = Math.min(256, size);
      while (start < data.length) {
        // Upload tile portion to the main galaxy texture.
        writeTextureWithPadding(
          device,
          this.galaxyTexture!,
          level,
          { x: ti * tileSize, y: tj * tileSize, z: i },
          data.subarray(start, start + tileSize * tileSize),
          tileSize,
          tileSize,
          1,
          4 // 4 bytes per pixel for rgb9e5 shared-exponent formats.
        );
        start += tileSize * tileSize;

        // Populate the dedicated star level textures.
        if (level <= MAX_STAR_TEXTURE_LOD) {
          writeTextureWithPadding(
            device,
            this.starTexture!,
            level,
            { x: ti * tileSize, y: tj * tileSize, z: i },
            data.subarray(start, start + tileSize * tileSize),
            tileSize,
            tileSize,
            1,
            4
          );
        } else {
          writeTextureWithPadding(
            device,
            this.starTexture2!,
            level - (MAX_STAR_TEXTURE_LOD + 1),
            { x: ti * tileSize, y: tj * tileSize, z: i },
            data.subarray(start, start + tileSize * tileSize),
            tileSize,
            tileSize,
            1,
            4
          );
        }
        start += tileSize * tileSize;
        level += 1;
        tileSize /= 2; // Move down to the next mipmap size.
      }
      this.numTilesLoaded += 1;
      if (l <= MAX_STAR_TEXTURE_LOD) {
        this.numTilesLoadedPerLevel[l] += 1;
      }
      this.numPendingRequests -= 1;
      this.updateLoadingBar();
      this.loadStarTextureTiles();
    });
    this.numPendingRequests += 1;
  }

  /**
   * Loads high-frequency noise texture from a standard image element.
   * Copies the decoded ImageBitmap into a WebGPU texture destination.
   */
  private loadNoiseTexture(textureUrl: string): void {
    const device = this.device;
    const image = new Image();
    image.addEventListener('load', async () => {
      const imageBitmap = await createImageBitmap(image);
      this.noiseTexture = device.createTexture({
        size: [imageBitmap.width, imageBitmap.height, 1],
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      });
      device.queue.copyExternalImageToTexture(
        { source: imageBitmap },
        { texture: this.noiseTexture },
        [imageBitmap.width, imageBitmap.height]
      );
    });
    image.src = import.meta.env.BASE_URL + textureUrl;
  }

  /**
   * Refreshes the HTML loading bar display and updates visibility class once fully completed.
   */
  private updateLoadingBar(): void {
    this.loadingBar.style.width = `${this.numTilesLoaded / 516 * 100}%`;
    if (this.numTilesLoaded == 516) {
      this.loadingPanel.classList.toggle('cv-loaded', true);
    }
  }

  /**
   * Determines the lowest star LOD fully loaded.
   * Prevents shaders from sampling missing mipmaps.
   */
  getMinLoadedStarTextureLod(): number {
    if (this.numTilesLoadedPerLevel[0] == 384) {
      return 0.0;
    } else if (this.numTilesLoadedPerLevel[1] == 96) {
      return 1.0;
    } else if (this.numTilesLoadedPerLevel[2] == 24) {
      return 2.0;
    } else if (this.numTilesLoadedPerLevel[3] == 6) {
      return 3.0;
    }
    return 4.0;
  }

  onKeyPress(event: KeyboardEvent): void {
    if (event.key == ' ') {
      this.loadingPanel.classList.toggle('cv-hidden');
    }
  }
}

