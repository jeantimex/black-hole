(function() {

const MAX_STAR_TEXTURE_LOD = 6;

const loadTextureData = function(textureDataUrl, callback) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', textureDataUrl);
  xhr.responseType = 'arraybuffer';
  xhr.onload = (event) => {

    if (xhr.status !== 200) {
      console.error("XHR Failed to load Float data:", textureDataUrl, "status:", xhr.status);
      return;
    }
    try {
      const data = new DataView(xhr.response);
      const array = new Float32Array(data.byteLength / Float32Array.BYTES_PER_ELEMENT);
      for (let i = 0; i < array.length; ++i) {
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

const loadIntTextureData = function(textureDataUrl, callback) {
  const isTile = textureDataUrl.includes("gaia_sky_map");
  const xhr = new XMLHttpRequest();
  xhr.open('GET', textureDataUrl);
  xhr.responseType = 'arraybuffer';
  xhr.onload = (event) => {

    if (xhr.status !== 200) {
      console.error("XHR Failed to load Int data:", textureDataUrl, "status:", xhr.status);
      return;
    }
    try {
      const data = new DataView(xhr.response);
      const array = new Uint32Array(data.byteLength / Uint32Array.BYTES_PER_ELEMENT);
      for (let i = 0; i < array.length; ++i) {
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

const writeTextureWithPadding = function(device, texture, mipLevel, origin, srcTypedArray, width, height, depth, bytesPerPixel) {
  const actualBytesPerRow = width * bytesPerPixel;
  if (actualBytesPerRow % 256 === 0 || height <= 1) {
    device.queue.writeTexture(
      { texture, mipLevel, origin },
      srcTypedArray,
      { bytesPerRow: actualBytesPerRow, rowsPerImage: height },
      [width, height, depth]
    );
  } else {
    const alignedBytesPerRow = Math.ceil(actualBytesPerRow / 256) * 256;
    const alignedWordsPerRow = alignedBytesPerRow / srcTypedArray.BYTES_PER_ELEMENT;
    const srcWordsPerRow = actualBytesPerRow / srcTypedArray.BYTES_PER_ELEMENT;
    const paddedSize = alignedWordsPerRow * height * depth;
    const paddedData = new srcTypedArray.constructor(paddedSize);
    for (let d = 0; d < depth; ++d) {
      for (let y = 0; y < height; ++y) {
        const srcOffset = d * srcWordsPerRow * height + y * srcWordsPerRow;
        const dstOffset = d * alignedWordsPerRow * height + y * alignedWordsPerRow;
        paddedData.set(
          srcTypedArray.subarray(srcOffset, srcOffset + srcWordsPerRow),
          dstOffset
        );
      }
    }
    device.queue.writeTexture(
      { texture, mipLevel, origin },
      paddedData,
      { bytesPerRow: alignedBytesPerRow, rowsPerImage: height },
      [width, height, depth]
    );
  }
};

class TextureManager {
  constructor(rootElement, device) {
    this.loadingPanel = rootElement.querySelector('#cv_loading_panel');
    this.loadingBar = rootElement.querySelector('#cv_loading_bar');
    this.device = device;

    this.rayDeflectionTexture = null;
    this.rayInverseRadiusTexture = null;
    this.blackbodyTexture = null;
    this.dopplerTexture = null;
    this.gridTexture = null;
    this.galaxyTexture = null;
    this.starTexture = null;
    this.starTexture2 = null;
    this.noiseTexture = null;

    this.tilesQueue = [];
    this.numTilesLoaded = 0;
    this.numTilesLoadedPerLevel = [0, 0, 0, 0, 0];
    this.numPendingRequests = 0;

    // Create standard samplers
    this.linearSampler = device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      minFilter: 'linear',
      magFilter: 'linear',
      mipmapFilter: 'linear'
    });
    this.nearestSampler = device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      minFilter: 'nearest',
      magFilter: 'nearest'
    });

    this.loadTextures();
    this.loadStarTextures();
    this.loadNoiseTexture('noise_texture.png');

    document.body.addEventListener('keypress', (e) => this.onKeyPress(e));
  }

  loadTextures() {
    const device = this.device;

    loadTextureData('deflection.dat', (data) => {
      const width = Math.round(data[0]);
      const height = Math.round(data[1]);
      this.rayDeflectionTexture = device.createTexture({
        size: [width, height, 1],
        format: 'rg32float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      device.queue.writeTexture(
        { texture: this.rayDeflectionTexture },
        data.subarray(2),
        { bytesPerRow: width * 8, rowsPerImage: height },
        [width, height, 1]
      );
    });

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

    this.dopplerTexture = device.createTexture({
      size: [64, 32, 64],
      dimension: '3d',
      format: 'rgba32float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    loadTextureData('doppler.dat', (data) => {
      const rgbaData = new Float32Array(64 * 32 * 64 * 4);
      for (let i = 0; i < 64 * 32 * 64; ++i) {
        rgbaData[i * 4] = data[i * 3];
        rgbaData[i * 4 + 1] = data[i * 3 + 1];
        rgbaData[i * 4 + 2] = data[i * 3 + 2];
        rgbaData[i * 4 + 3] = 1.0;
      }
      device.queue.writeTexture(
        { texture: this.dopplerTexture },
        rgbaData,
        { bytesPerRow: 64 * 16, rowsPerImage: 32 },
        [64, 32, 64]
      );
    });

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
        { texture: this.blackbodyTexture },
        rgbaData,
        { bytesPerRow: 128 * 16, rowsPerImage: 1 },
        [128, 1, 1]
      );
    });

    this.gridTexture = device.createTexture({
      size: [512, 512, 6],
      mipLevelCount: 10,
      format: 'r8unorm',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    // Procedural grid mipmap generation
    for (let level = 0; level < 10; ++level) {
      const size = 512 >> level;
      const levelData = new Uint8Array(size * size);
      const scale = size / 512.0;
      for (let j = 0; j < size; ++j) {
        const jmod_scaled = Math.floor((j / scale + 2) % 32);
        for (let i = 0; i < size; ++i) {
          const imod_scaled = Math.floor((i / scale + 2) % 32);
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

  loadStarTextures() {
    const device = this.device;

    this.galaxyTexture = device.createTexture({
      size: [2048, 2048, 6],
      mipLevelCount: 12,
      format: 'rgb9e5ufloat',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    this.starTexture = device.createTexture({
      size: [2048, 2048, 6],
      mipLevelCount: MAX_STAR_TEXTURE_LOD + 1,
      format: 'rgb9e5ufloat',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    const starTexture2Size = 2048 / (1 << (MAX_STAR_TEXTURE_LOD + 1));
    this.starTexture2 = device.createTexture({
      size: [starTexture2Size, starTexture2Size, 6],
      mipLevelCount: 11 - MAX_STAR_TEXTURE_LOD,
      format: 'rgb9e5ufloat',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });

    const base = 'https://ebruneton.github.io/gaia_sky_map';
    const prefixes = ['pos-x', 'neg-x', 'pos-y', 'neg-y', 'pos-z', 'neg-z'];
    for (let l = 0; l <= 4; ++l) {
      for (let i = 0; i < 6; ++i) {
        const size = 2048 / (1 << l);
        const tileSize = Math.min(256, size);
        const numTiles = size / tileSize;
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

  loadStarTextureTiles() {
    while (this.tilesQueue.length > 0 && this.numPendingRequests < 6) {
      const tile = this.tilesQueue.pop();
      this.loadStarTextureTile(tile.l, tile.ti, tile.tj, tile.i, tile.url);
    }
  }

  loadStarTextureTile(l, ti, tj, i, url) {
    const device = this.device;
    const size = 2048 / (1 << l);
    loadIntTextureData(url, (data) => {
      let start = 0;
      let level = l;
      let tileSize = Math.min(256, size);
      while (start < data.length) {
        // Upload to galaxyTexture
        writeTextureWithPadding(
          device,
          this.galaxyTexture,
          level,
          { x: ti * tileSize, y: tj * tileSize, z: i },
          data.subarray(start, start + tileSize * tileSize),
          tileSize,
          tileSize,
          1,
          4
        );
        start += tileSize * tileSize;

        // Upload to starTexture / starTexture2
        if (level <= MAX_STAR_TEXTURE_LOD) {
          writeTextureWithPadding(
            device,
            this.starTexture,
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
            this.starTexture2,
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
        tileSize /= 2;
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

  loadNoiseTexture(textureUrl) {
    const device = this.device;
    const image = new Image();
    image.addEventListener('load', async () => {
      const imageBitmap = await createImageBitmap(image);
      this.noiseTexture = device.createTexture({
        size: [imageBitmap.width, imageBitmap.height, 1],
        format: 'rgba8unorm', // WebGPU standard format for images
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      });
      device.queue.copyExternalImageToTexture(
        { source: imageBitmap },
        { texture: this.noiseTexture },
        [imageBitmap.width, imageBitmap.height]
      );
    });
    image.src = textureUrl;
  }

  updateLoadingBar() {
    this.loadingBar.style.width = `${this.numTilesLoaded / 516 * 100}%`;
    if (this.numTilesLoaded == 516) {
      this.loadingPanel.classList.toggle('cv-loaded');
    }
  }

  getMinLoadedStarTextureLod() {
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

  onKeyPress(event) {
    if (event.key == ' ') {
      this.loadingPanel.classList.toggle('cv-hidden');
    }
  }
}

BlackHoleShaderDemoApp.TextureManager = TextureManager;
})();
