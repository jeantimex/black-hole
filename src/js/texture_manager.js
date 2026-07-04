
(function() {

function packRGB9E5(r, g, b) {
  const max_c = Math.max(r, g, b);
  if (max_c < 1e-5) return 0;
  let exp = Math.floor(Math.log2(max_c)) + 1;
  const biased_exp = Math.min(Math.max(exp + 15, 0), 31);
  const scale = Math.pow(2, biased_exp - 15 - 9);
  const rm = Math.min(Math.floor(r / scale), 511);
  const gm = Math.min(Math.floor(g / scale), 511);
  const bm = Math.min(Math.floor(b / scale), 511);
  return rm | (gm << 9) | (bm << 18) | (biased_exp << 27);
}

function generateStarTileData(l, ti, tj, faceIndex) {
  const size = 2048 / (1 << l);
  let totalWords = 0;
  let current_level = l;
  let current_level_size = size;
  
  while (current_level_size > 0) {
    const tile_size = Math.min(256, current_level_size);
    totalWords += 2 * tile_size * tile_size;
    if (size < 256) {
      current_level_size /= 2;
    } else {
      break;
    }
  }
  
  const data = new Uint32Array(totalWords);
  let start = 0;
  current_level = l;
  current_level_size = size;
  
  while (current_level_size > 0) {
    const tile_size = Math.min(256, current_level_size);
    
    // 1. Generate Galaxy Background (subtle nebula glow)
    for (let y = 0; y < tile_size; ++y) {
      for (let x = 0; x < tile_size; ++x) {
        const gx = (ti * tile_size + x) / (2048 >> current_level) - 0.5;
        const gy = (tj * tile_size + y) / (2048 >> current_level) - 0.5;
        const dist = Math.sqrt(gx * gx + gy * gy);
        const intensity = Math.exp(-dist * 6.0) * 0.12;
        
        const r = intensity * 0.4;
        const g = intensity * 0.3;
        const b = intensity * 0.7;
        
        data[start + x + y * tile_size] = packRGB9E5(r, g, b);
      }
    }
    start += tile_size * tile_size;
    
    // 2. Generate Stars
    for (let y = 0; y < tile_size; ++y) {
      for (let x = 0; x < tile_size; ++x) {
        const globalX = ti * tile_size + x;
        const globalY = tj * tile_size + y;
        const hash = Math.sin(globalX * 12.9898 + globalY * 78.233 + faceIndex * 37.1 + current_level * 59.3) * 43758.5453;
        const rand = hash - Math.floor(hash);
        
        if (rand > 0.997) { // 0.3% star density
          const brightness = 0.1 + (rand - 0.997) / 0.003 * 4.0;
          const colorRand = (rand * 10) - Math.floor(rand * 10);
          let r = brightness;
          let g = brightness;
          let b = brightness;
          if (colorRand < 0.2) {
            g *= 0.8; b *= 0.6;
          } else if (colorRand > 0.8) {
            r *= 0.8; g *= 0.9;
          }
          data[start + x + y * tile_size] = packRGB9E5(r, g, b);
        } else {
          data[start + x + y * tile_size] = 0;
        }
      }
    }
    start += tile_size * tile_size;
    
    if (size < 256) {
      current_level += 1;
      current_level_size /= 2;
    } else {
      break;
    }
  }
  return data;
}


// Max LOD for which the manul texture filtering method DefaultStarColor() in
// model.glsl must be used for stars. Above this level a default anisotropic
// texture filtering is used instead. Must be consistent with the same constant
// in shader_manager.js.
const MAX_STAR_TEXTURE_LOD = 6;

const cubeMapTargets = function(gl) {
  return [
      gl.TEXTURE_CUBE_MAP_POSITIVE_X,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_X,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Y,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_Y,
      gl.TEXTURE_CUBE_MAP_POSITIVE_Z,
      gl.TEXTURE_CUBE_MAP_NEGATIVE_Z];
};

const createTexture = function(gl, target) {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(target, texture);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
};

const loadTextureData = function(textureDataUrl, callback) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', textureDataUrl);
  xhr.responseType = 'arraybuffer';
  xhr.onload = (event) => {
    const data = new DataView(xhr.response);
    const array =
        new Float32Array(data.byteLength / Float32Array.BYTES_PER_ELEMENT);
    for (let i = 0; i < array.length; ++i) {
      array[i] = data.getFloat32(i * Float32Array.BYTES_PER_ELEMENT, true);
    }
    callback(array);
  };
  xhr.send();
};

const loadIntTextureData = function(textureDataUrl, callback) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', textureDataUrl);
  xhr.responseType = 'arraybuffer';
  xhr.onload = (event) => {
    const data = new DataView(xhr.response);
    const array =
        new Uint32Array(data.byteLength / Uint32Array.BYTES_PER_ELEMENT);
    for (let i = 0; i < array.length; ++i) {
      array[i] = data.getUint32(i * Uint32Array.BYTES_PER_ELEMENT, true);
    }
    callback(array);
  };
  xhr.send();
};

const loadNoiseTexture = function(gl, glExt, textureUrl) {
  const texture = gl.createTexture();
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER,
                   gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameterf(gl.TEXTURE_2D, glExt.TEXTURE_MAX_ANISOTROPY_EXT, 
                   gl.getParameter(glExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
  const image = new Image();
  image.addEventListener('load', function() {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, gl.RED, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
  });
  image.src = textureUrl;
  return texture;
}


class TextureManager {
  constructor(rootElement, gl) {
    this.loadingPanel = rootElement.querySelector('#cv_loading_panel');
    this.loadingBar = rootElement.querySelector('#cv_loading_bar');
    this.gl = gl;

    this.rayDeflectionTexture = null;
    this.rayInverseRadiusTexture = null;
    this.blackbodyTexture = null;
    this.dopplerTexture = null;
    this.gridTexture = null;

    this.galaxyTexture = null;
    this.starTexture = null;
    this.starTexture2 = null;
    this.tilesQueue = [];
    this.numTilesLoaded = 0;
    this.numTilesLoadedPerLevel = [0, 0, 0, 0, 0];
    this.numPendingRequests = 0;

    const ext = gl.getExtension('EXT_texture_filter_anisotropic');
    this.loadTextures(ext);
    this.loadStarTextures(ext);
    this.noiseTexture = loadNoiseTexture(gl, ext, 'noise_texture.png');

    document.body.addEventListener('keypress', (e) => this.onKeyPress(e)); 
  }

  loadTextures(ext) {
    const gl = this.gl;

    loadTextureData('deflection.dat', (data) => {
      this.rayDeflectionTexture = createTexture(gl, gl.TEXTURE_2D);
      this.rayDeflectionTexture.width = data[0];
      this.rayDeflectionTexture.height = data[1];
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, data[0], data[1], 0, 
                    gl.RG, gl.FLOAT, data.slice(2));
    });

    loadTextureData('inverse_radius.dat', (data) => {
      this.rayInverseRadiusTexture = createTexture(gl, gl.TEXTURE_2D);
      this.rayInverseRadiusTexture.width = data[0];
      this.rayInverseRadiusTexture.height = data[1];
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RG32F, data[0], data[1], 0,
                    gl.RG, gl.FLOAT, data.slice(2));
    });

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

    this.blackbodyTexture = createTexture(gl, gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    loadTextureData('black_body.dat', (data) => {
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.blackbodyTexture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB32F, 128, 1, 0,
                    gl.RGB, gl.FLOAT, data);
    });

    this.gridTexture = createTexture(gl, gl.TEXTURE_CUBE_MAP);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 10, gl.R8, 512, 512);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, 
                     gl.LINEAR_MIPMAP_LINEAR);
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

  loadStarTextures(glExt) {
    const gl = this.gl;

    this.galaxyTexture = createTexture(gl, gl.TEXTURE_CUBE_MAP);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.galaxyTexture);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 12, gl.RGB9_E5, 2048, 2048);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER,
                     gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);   
    gl.texParameterf(gl.TEXTURE_CUBE_MAP, glExt.TEXTURE_MAX_ANISOTROPY_EXT, 
                     gl.getParameter(glExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));

    this.starTexture = createTexture(gl, gl.TEXTURE_CUBE_MAP);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.starTexture);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, MAX_STAR_TEXTURE_LOD + 1, gl.RGB9_E5, 
                    2048, 2048);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, 
                     gl.NEAREST_MIPMAP_NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LOD, 
                     MAX_STAR_TEXTURE_LOD);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAX_LEVEL, 
                     MAX_STAR_TEXTURE_LOD);

    this.starTexture2 = createTexture(gl, gl.TEXTURE_CUBE_MAP);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.starTexture2);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, 11 - MAX_STAR_TEXTURE_LOD, gl.RGB9_E5, 
                    2048 / (1 << (MAX_STAR_TEXTURE_LOD + 1)),
                    2048 / (1 << (MAX_STAR_TEXTURE_LOD + 1)));
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, 
                     gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameterf(gl.TEXTURE_CUBE_MAP, glExt.TEXTURE_MAX_ANISOTROPY_EXT, 
                     gl.getParameter(glExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));

    const base = '../../gaia_sky_map';
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



  loadStarTextureTiles() {
    while (this.tilesQueue.length > 0 && this.numPendingRequests < 6) {
      const tile = this.tilesQueue.pop();
      this.numPendingRequests += 1;
      // Process asynchronously via setTimeout to keep UI responsive
      setTimeout(() => {
        this.loadStarTextureTile(
            tile.l, tile.ti, tile.tj, tile.i, tile.target, tile.url);
      }, 0);
    }
  }

  loadStarTextureTile(l, ti, tj, i, target, url) {
    const gl = this.gl;
    const size = 2048 / (1 << l);
    const data = generateStarTileData(l, ti, tj, i);
    
    gl.activeTexture(gl.TEXTURE0);
    let start = 0;
    let level = l;
    let tileSize = Math.min(256, size);
    while (start < data.length) {
      gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.galaxyTexture);
      gl.texSubImage2D(target, level, ti * tileSize, tj * tileSize, 
          tileSize, tileSize, gl.RGB, gl.UNSIGNED_INT_5_9_9_9_REV, 
          data.subarray(start, start + tileSize * tileSize), 0);
      start += tileSize * tileSize;
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
  }

  updateLoadingBar() {
    this.loadingBar.style.width = `${this.numTilesLoaded / 516 * 100}%`;
    if (this.numTilesLoaded == 516) {
      this.loadingPanel.classList.toggle('cv-loaded');
    }
  } 

  getMinLoadedStarTextureLod() {
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

  onKeyPress(event) {
    if (event.key == ' ') {
      this.loadingPanel.classList.toggle('cv-hidden');
    }
  }
}

BlackHoleShaderDemoApp.TextureManager = TextureManager;
})();
