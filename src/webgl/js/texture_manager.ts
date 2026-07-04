/**
 * @file texture_manager.ts
 * @brief Manages loading and binding of precomputed geodesic tables, black body tables, Doppler LUTs, and Gaia star catalog tiles.
 *
 * Architecture & Mathematics:
 *
 * 1. Geodesic Lookup Tables (LUTs):
 *    - `deflection.dat`: Contains precomputed deflection angles \Delta\phi and elapsed coordinate times \Delta t
 *      for various values of energy e^2 and radial coordinate u. Loaded into `rayDeflectionTexture` (RG32F).
 *    - `inverse_radius.dat`: Contains precomputed radial positions u and travel times t as functions of
 *      deflection angle \phi. Loaded into `rayInverseRadiusTexture` (RG32F).
 *    - Together, these LUTs enable O(1) evaluation of Schwarzschild geodesics per fragment.
 *
 * 2. Shared Exponent HDR Texture Format (RGB9_E5):
 *    - The Gaia star map and galaxy nebulae textures require High Dynamic Range (HDR) to store realistic star intensities.
 *    - Standard 32-bit floating-point format (RGBA32F) consumes too much memory (16 bytes/pixel).
 *    - We use the `gl.RGB9_E5` format (data format type `gl.UNSIGNED_INT_5_9_9_9_REV`). This format packs
 *      three 9-bit mantissas (for R, G, B) and a single shared 5-bit exponent into a single 32-bit word (4 bytes/pixel).
 *      This provides wide dynamic range representation while saving 75% video memory.
 *
 * 3. Star Catalog Tile Loading Queue:
 *    - The star catalog cubemap is huge (2048x2048 per face).
 *    - We partition the texture into smaller tiles at different mipmap levels (l = 0 to 4).
 *    - The tiles are loaded progressively using an asynchronous pipeline, restricted to 6 concurrent network requests
 *      to avoid choking the network socket pool.
 *    - As each tile completes loading, we update regions of the cubemaps (`galaxyTexture`, `starTexture`, and `starTexture2`)
 *      using `gl.texSubImage2D`.
 *    - `getMinLoadedStarTextureLod()` monitors loading progress and returns the finest fully loaded mipmap level,
 *      ensuring no black areas are rendered.
 */

const MAX_STAR_TEXTURE_LOD = 6;

/**
 * @brief Returns WebGL target constants for the 6 faces of a cubemap.
 */
const cubeMapTargets = function(gl: WebGL2RenderingContext): number[] {
  return [
    gl.TEXTURE_CUBE_MAP_POSITIVE_X,
    gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
    gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
    gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
    gl.TEXTURE_CUBE_MAP_NEGATIVE_Z
  ];
};

/**
 * @brief Utility to allocate a WebGL texture with default filtering and wrapping modes.
 */
const createTexture = function(gl: WebGL2RenderingContext, target: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Could not create WebGL texture");
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(target, texture);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
};

const resolveUrl = function(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  return import.meta.env.BASE_URL + url;
};

/**
 * @brief Asynchronously fetches binary float32 data from a URL.
 */
const loadTextureData = function(textureDataUrl: string, callback: (data: Float32Array) => void): void {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', resolveUrl(textureDataUrl));
  xhr.responseType = 'arraybuffer';
  xhr.onload = () => {
    const data = new DataView(xhr.response);
    const array = new Float32Array(data.byteLength / Float32Array.BYTES_PER_ELEMENT);
    for (let i = 0; i < array.length; ++i) {
      array[i] = data.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true);
    }
    callback(array);
  };
  xhr.send();
};

/**
 * @brief Asynchronously fetches binary uint32 data (packed RGB9_E5 texels) from a URL.
 */
const loadIntTextureData = function(textureDataUrl: string, callback: (data: Uint32Array) => void): void {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', resolveUrl(textureDataUrl));
  xhr.responseType = 'arraybuffer';
  xhr.onload = () => {
    const data = new DataView(xhr.response);
    const array = new Uint32Array(data.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    for (let i = 0; i < array.length; ++i) {
      array[i] = data.getUint32(i * Uint32Array.BYTES_PER_ELEMENT, true);
    }
    callback(array);
  };
  xhr.send();
};

/**
 * @brief Loads a noise texture map used to generate accretion disk dust turbulences.
 */
const loadNoiseTexture = function(gl: WebGL2RenderingContext, glExt: any, textureUrl: string): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Could not create noise texture");
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameterf(gl.TEXTURE_2D, glExt.TEXTURE_MAX_ANISOTROPY_EXT, 
                   gl.getParameter(glExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
  const image = new Image();
  image.addEventListener('load', function() {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
  });
  image.src = import.meta.env.BASE_URL + textureUrl;
  return texture;
};

interface SizedWebGLTexture extends WebGLTexture {
  width?: number;
  height?: number;
}

interface StarTile {
  l: number;
  ti: number;
  tj: number;
  i: number;
  target: number;
  url: string;
}

export class TextureManager {
  private loadingPanel: HTMLElement;
  private loadingBar: HTMLElement;
  private gl: WebGL2RenderingContext;

  rayDeflectionTexture: SizedWebGLTexture | null = null;
  rayInverseRadiusTexture: SizedWebGLTexture | null = null;
  blackbodyTexture: WebGLTexture | null = null;
  dopplerTexture: WebGLTexture | null = null;
  gridTexture: WebGLTexture | null = null;
  galaxyTexture: WebGLTexture | null = null;
  starTexture: WebGLTexture | null = null;
  starTexture2: WebGLTexture | null = null;
  noiseTexture: WebGLTexture | null = null;

  private tilesQueue: StarTile[] = [];
  private numTilesLoaded = 0;
  private numTilesLoadedPerLevel = [0, 0, 0, 0, 0];
  private numPendingRequests = 0;

  constructor(rootElement: HTMLElement, gl: WebGL2RenderingContext) {
    const panel = rootElement.querySelector('#cv_loading_panel');
    const bar = rootElement.querySelector('#cv_loading_bar');
    if (!panel) throw new Error("cv_loading_panel not found");
    if (!bar) throw new Error("cv_loading_bar not found");

    this.loadingPanel = panel as HTMLElement;
    this.loadingBar = bar as HTMLElement;
    this.gl = gl;

    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    this.loadTextures(ext);
    this.loadStarTextures(ext);
    this.noiseTexture = loadNoiseTexture(gl, ext, 'noise_texture.png');

    document.body.addEventListener('keypress', (e) => this.onKeyPress(e)); 
  }

  /**
   * @brief Allocates and loads precomputed lookup data files.
   */
  private loadTextures(ext: any): void {
    const gl = this.gl;

    // Load precomputed deflection angles LUT
    loadTextureData('deflection.dat', (data) => {
      this.rayDeflectionTexture = createTexture(gl, gl.TEXTURE_2D);
      this.rayDeflectionTexture.width = data[0];
      this.rayDeflectionTexture.height = data[1];
      // Store in high-precision float RG32F buffer
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, data[0], data[1], 0, 
                    gl.RG, gl.FLOAT, data.slice(2));
    });

    // Load precomputed inverse radius coordinate paths LUT
    loadTextureData('inverse_radius.dat', (data) => {
      this.rayInverseRadiusTexture = createTexture(gl, gl.TEXTURE_2D);
      this.rayInverseRadiusTexture.width = data[0];
      this.rayInverseRadiusTexture.height = data[1];
      // Store in high-precision float RG32F buffer
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, data[0], data[1], 0,
                    gl.RG, gl.FLOAT, data.slice(2));
    });

    // Load relativistic Doppler shift 3D color lookup table
    this.dopplerTexture = createTexture(gl, gl.TEXTURE_3D);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    loadTextureData('doppler.dat', (data) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_3D, this.dopplerTexture);
      gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGB32F, 64, 32, 64, 0, 
                    gl.RGB, gl.FLOAT, data);
    });

    // Load precomputed Planck blackbody radiation spectrum 1D LUT
    this.blackbodyTexture = createTexture(gl, gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    loadTextureData('black_body.dat', (data) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.blackbodyTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, 128, 1, 0,
                    gl.RGB, gl.FLOAT, data);
    });

    // Allocate and generate procedurally a grid calibration pattern cubemap
    this.gridTexture = createTexture(gl, gl.TEXTURE_CUBE_MAP);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 10, gl.R8, 512, 512);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);   
    gl.texParameterf(gl.TEXTURE_CUBE_MAP, ext.TEXTURE_MAX_ANISOTROPY_EXT, 
                     gl.getParameter(ext.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
    const gridData = new Uint8Array(512 * 512);
    for (let j = 0; j < 512; ++j) {
      const jmod = (j + 2) % 32;
      for (let i = 0; i < 512; ++i) {
        const imod = (i + 2) % 32;
        gridData[i + j * 512] = (imod < 4 || jmod < 4) ? 255 : 0;
      }
    }
    for (let target of cubeMapTargets(gl)) {
      gl.texSubImage2D(target, 0, 0, 0, 512, 512, 
                       gl.RED, gl.UNSIGNED_BYTE, gridData, 0);
    }
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP);
  }

  /**
   * @brief Allocates texture objects for the Gaia star catalog and registers tile load requests.
   */
  private loadStarTextures(glExt: any): void {
    const gl = this.gl;

    // Allocate background galaxy cubemap
    this.galaxyTexture = createTexture(gl, gl.TEXTURE_CUBE_MAP);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.galaxyTexture);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 12, gl.RGB9_E5, 2048, 2048);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);   
    gl.texParameterf(gl.TEXTURE_CUBE_MAP, glExt.TEXTURE_MAX_ANISOTROPY_EXT, 
                     gl.getParameter(glExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));

    // Allocate high-frequency stars cubemap (first 6 mipmap levels)
    this.starTexture = createTexture(gl, gl.TEXTURE_CUBE_MAP);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.starTexture);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, MAX_STAR_TEXTURE_LOD + 1, gl.RGB9_E5, 2048, 2048);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LOD, MAX_STAR_TEXTURE_LOD);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, MAX_STAR_TEXTURE_LOD);

    // Allocate remaining low-resolution mipmap levels of the stars cubemap
    this.starTexture2 = createTexture(gl, gl.TEXTURE_CUBE_MAP);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.starTexture2);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 11 - MAX_STAR_TEXTURE_LOD, gl.RGB9_E5, 
                    2048 / (1 << (MAX_STAR_TEXTURE_LOD + 1)),
                    2048 / (1 << (MAX_STAR_TEXTURE_LOD + 1)));
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameterf(gl.TEXTURE_CUBE_MAP, glExt.TEXTURE_MAX_ANISOTROPY_EXT, 
                     gl.getParameter(glExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));

    // Define and queue URL addresses for all Gaia catalog tiles
    const base = 'gaia_sky_map';
    const prefixes = ['pos-x', 'neg-x', 'pos-y', 'neg-y', 'pos-z', 'neg-z'];
    const targets = cubeMapTargets(gl);
    for (let l = 0; l <= 4; ++l) {
      for (let i = 0; i < 6; ++i) {
        const size = 2048 / (1 << l);
        const tileSize = Math.min(256, size);
        const numTiles = size / tileSize;
        for (let tj = 0; tj < numTiles; ++tj) {
          for (let ti = 0; ti < numTiles; ++ti) {
            const target = targets[i];
            const url = `${base}/${prefixes[i]}-${l}-${ti}-${tj}.dat`;
            this.tilesQueue.push({l, ti, tj, i, target, url});
          }
        }
      }
    }
    this.updateLoadingBar();
    this.loadStarTextureTiles();
  }

  /**
   * @brief Dequeues and launches async requests for tiles, capping at 6 concurrent connections.
   */
  private loadStarTextureTiles(): void {
    while (this.tilesQueue.length > 0 && this.numPendingRequests < 6) {
      const tile = this.tilesQueue.pop();
      if (tile) {
        this.loadStarTextureTile(tile.l, tile.ti, tile.tj, tile.i, tile.target, tile.url);
      }
    }
  }

  /**
   * @brief Fetches a single star tile dat block and updates region allocations in GPU memory.
   */
  private loadStarTextureTile(l: number, ti: number, tj: number, _i: number, target: number, url: string): void {
    const gl = this.gl;
    const size = 2048 / (1 << l);
    loadIntTextureData(url, (data) => {
      gl.activeTexture(gl.TEXTURE0);
      let start = 0;
      let level = l;
      let tileSize = Math.min(256, size);
      
      // The dat file packs texels for multiple mipmap sub-levels. Loop through them:
      while (start < data.length) {
        // 1. Upload to the diffuse galaxy/nebulae cubemap
        gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.galaxyTexture);
        gl.texSubImage2D(target, level, ti * tileSize, tj * tileSize, 
            tileSize, tileSize, gl.RGB, gl.UNSIGNED_INT_5_9_9_9_REV, 
            data.subarray(start, start + tileSize * tileSize), 0);
        start += tileSize * tileSize;
        
        // 2. Upload to the point star catalog cubemaps (split across starTexture and starTexture2)
        if (level <= MAX_STAR_TEXTURE_LOD) {
          gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.starTexture);
          gl.texSubImage2D(target, level, ti * tileSize, tj * tileSize, 
              tileSize, tileSize, gl.RGB, gl.UNSIGNED_INT_5_9_9_9_REV,
              data.subarray(start, start + tileSize * tileSize), 0);
        } else {
          gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.starTexture2);
          gl.texSubImage2D(target, level - (MAX_STAR_TEXTURE_LOD + 1), 
              ti * tileSize, tj * tileSize, tileSize, tileSize,
              gl.RGB, gl.UNSIGNED_INT_5_9_9_9_REV, 
              data.subarray(start, start + tileSize * tileSize), 0);
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

  private updateLoadingBar(): void {
    this.loadingBar.style.width = `${this.numTilesLoaded / 516 * 100}%`;
    if (this.numTilesLoaded == 516) {
      this.loadingPanel.classList.toggle('cv-loaded', true);
    }
  } 

  /**
   * @brief Queries the status of star catalog loading to return the highest fully loaded LOD level.
   */
  getMinLoadedStarTextureLod(): number {
    if (this.numTilesLoadedPerLevel[0] == 384) {
      return 0;
    } else if (this.numTilesLoadedPerLevel[1] == 96) {
      return 1;
    } else if (this.numTilesLoadedPerLevel[2] == 24) {
      return 2;
    } else if (this.numTilesLoadedPerLevel[3] == 6) {
      return 3;
    }
    return 4;
  }

  onKeyPress(event: KeyboardEvent): void {
    if (event.key == ' ') {
      this.loadingPanel.classList.toggle('cv-hidden');
    }
  }
}
