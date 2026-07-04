/**
 * @file bloom.ts
 * @brief High-Dynamic Range (HDR) Bloom post-processing effect using downsampling/upsampling pyramids.
 *
 * Architecture & Mathematics of Dual Filtering Bloom:
 * - Bloom simulates the physical lens-flare/light-bleeding effect of bright light sources in high-contrast scenes.
 * - To perform this in real-time, we construct a texture pyramid (mipmap chain) of the source HDR frame.
 *
 * 1. Downsampling Phase (Binomial Tent Filter):
 *    - We reduce resolution progressively by factor of 2.
 *    - To avoid aliasing (pixel flickering) on high-frequency details, we use a 4x4 filter kernel.
 *    - The filter weights are derived from the tensor product of 1D binomial coefficients:
 *        W_{2D} = \frac{1}{8}[1, 3, 3, 1] \otimes \frac{1}{8}[1, 3, 3, 1]
 *      which approximates a smooth Gaussian kernel.
 *    - The output HDR colors are clamped to float16 range limits (`MAX_FLOAT16` = 65500) to prevent NaN/overflow.
 *
 * 2. Bloom Filtering Phase:
 *    - A 5x5 convolution blur is applied at each pyramid level using precomputed Gaussian weights (derived from
 *      the physical line-spread function of the human eye, specified in `BLOOM_FILTERS` array).
 *    - This simulates the scattering (diffraction) of light in the ocular media.
 *
 * 3. Upsampling Phase (Bilinear Tent Filter):
 *    - We upsample and accumulate the blurred frames from the bottom (lowest resolution) of the pyramid to the top.
 *    - Tent filter weights are defined in the shader code:
 *        W = \frac{1}{16} \begin{pmatrix} 9 & 3 \\ 3 & 1 \end{pmatrix} (bilinear interpolation weights).
 *    - Additive blending (`gl.blendFunc(gl.ONE, gl.ONE)`) accumulates bloom radiance from all scales.
 *
 * 4. Tone Mapping Phase (ACES or Exponential):
 *    - High-range radiance is converted to standard dynamic range (SDR) display colors.
 *    - ACES Filmic Tone Mapping Curve:
 *        f(x) = \frac{x * (A * x + B)}{x * (C * x + D) + E}
 *        where A = 2.51, B = 0.03, C = 2.43, D = 0.59, E = 0.14.
 *        This mimics film response, producing high-contrast black points and pleasing highlight roll-offs.
 *    - Exponential Tone Mapping:
 *        f(x) = 1.0 - \exp(-x * \text{exposure})
 *    - Gamma correction is applied using a 2.2 exponent curve: C_{out} = C^{1 / 2.2}.
 */

// Array containing precomputed eye-spread function kernels at different screen resolutions.
// These coefficients model the optical diffraction pattern (PSF) of the human eye.
const BLOOM_FILTERS: (number | number[][])[] = [
  600,
  [[0.537425,0.0200663,0.00720805,0.00159719,0.000907315,0.000275641],
   [0.102792,0.0185013,0.00291111,0.000519003,0.000519003,0.000519003],
   [0.0704669,0.0181097,0.00232751,0.00232751,0.0015737,0.0015737],
   [0.0117432,0.0117432,0.00226476,0.00154524,0.00116041,0.00116041],
   [0.00746695,0.00746695,0.00171226,0.00104832,0.000766638,0.000766638],
   [0.00478257,0.00478257,0.00100513,0.000818812,0.000397319,0.000397319],
   [0.0037712,0.0037712,0.000490892,0.000490892,0.000490892,0.000490892],
   [0.00108603,0.00108603,0.000924505,0.000924505,0.000141375,0],
   [0.000604275,0.000604275,0.000604275,0.000604275,0.000604275,0.000604275]],
  800,
  [[0.368483,0.0216534,0.00816305,0.00188928,0.00108659,0.0003135],
   [0.136249,0.0234538,0.0044714,0.00035596,0.00035596,0.00035596],
   [0.115467,0.0273797,0.00361202,0.00361202,0.0024381,0.0024381],
   [0.0185586,0.0185586,0.00364918,0.00244913,0.00186549,0.00186549],
   [0.0120676,0.0120676,0.00279834,0.00169769,0.00125113,0.00125113],
   [0.00782081,0.00782081,0.00165563,0.00133947,0.000653398,0.000653398],
   [0.00620986,0.00620986,0.0008107,0.0008107,0.0008107,0.0008107],
   [0.0017856,0.0017856,0.00153169,0.00153169,0.000231589,0],
   [0.000999842,0.000999842,0.000999842,0.000999842,0.000999842,0.000999842]],
  1000,
  [[0.256172,0.0203539,0.00797156,0.00192098,0.00111651,0.000302982],
   [0.153181,0.0252457,0.0056879,5.24724e-05,5.24724e-05,5.24724e-05],
   [0.154089,0.0348566,0.00470551,0.00470551,0.00317819,0.00317819],
   [0.0246407,0.0246407,0.00494194,0.00326092,0.00251954,0.00251954],
   [0.0163845,0.0163845,0.00384115,0.00230972,0.00171517,0.00171517],
   [0.010743,0.010743,0.00229079,0.00184054,0.000902617,0.000902617],
   [0.00858938,0.00858938,0.00112463,0.00112463,0.00112463,0.00112463],
   [0.00246603,0.00246603,0.0021316,0.0021316,0.000318642,0],
   [0.00138965,0.00138965,0.00138965,0.00138965,0.00138965,0.00138965]],
  1200,
  [[0.183275,0.0181576,0.00737853,0.00184847,0.00110057,0.000302961],
   [0.155444,0.026573,0.00631122,0,0,0],
   [0.175386,0.0406837,0.00558637,0.00558637,0.00379344,0.00379344],
   [0.0298822,0.0298822,0.00611926,0.00396558,0.00310871,0.00310871],
   [0.0203221,0.0203221,0.00481554,0.00287054,0.00214781,0.00214781],
   [0.0134794,0.0134794,0.00289524,0.00230992,0.00113896,0.00113896],
   [0.0108519,0.0108519,0.00142504,0.00142504,0.00142504,0.00142504],
   [0.00311065,0.00311065,0.0027096,0.0027096,0.000400402,0],
   [0.00176416,0.00176416,0.00176416,0.00176416,0.00176416,0.00176416]],
  1400,
  [[0.13507,0.015829,0.00665188,0.0017314,0.00105678,0.000303019],
   [0.150222,0.0270593,0.00654101,0,0,0],
   [0.188342,0.0450054,0.00639373,0.0062499,0.00430739,0.00430739],
   [0.034393,0.034393,0.00718937,0.00457886,0.00363942,0.00363942],
   [0.0239205,0.0239205,0.00572745,0.00338534,0.00255211,0.00255211],
   [0.016048,0.016048,0.00347179,0.00275076,0.00136368,0.00136368],
   [0.013009,0.013009,0.00171332,0.00171332,0.00171332,0.00171332],
   [0.00372297,0.00372297,0.00326808,0.00326808,0.000477361,0],
   [0.00212503,0.00212503,0.00212503,0.00212503,0.00212503,0.00212503]],
  1600,
  [[0.102246,0.013671,0.00592138,0.00159768,0.00100127,0.000299669],
   [0.14157,0.026801,0.00657111,0,0,0],
   [0.19617,0.0482116,0.00708177,0.0067665,0.00473424,0.00473424],
   [0.0382986,0.0382986,0.00816852,0.00511466,0.00412131,0.00412131],
   [0.0272343,0.0272343,0.00658764,0.00386174,0.00293299,0.00293299],
   [0.0184784,0.0184784,0.00402643,0.00316811,0.00157908,0.00157908],
   [0.0150825,0.0150825,0.00199223,0.00199223,0.00199223,0.00199223],
   [0.00430923,0.00430923,0.00381212,0.00381212,0.00055036,0],
   [0.00247558,0.00247558,0.00247558,0.00247558,0.00247558,0.00247558]],
];

// Maximum number of texture downsampling levels
const MAX_LEVELS = 9;

// Maximum float value supported in float16 texture buffers to prevent saturation anomalies
const MAX_FLOAT16 = '6.55e4';

// Vertices pass-through shader for drawing the screen-spanning quad
const VERTEX_SHADER =
  `#version 300 es
  layout(location=0) in vec4 vertex;
  void main() { gl_Position = vertex; }`;

// Downsampling fragment shader using a 4x4 binomial filter kernel
const DOWNSAMPLE_SHADER =
  `#version 300 es
  precision highp float;
  const vec4 WEIGHTS = vec4(1.0, 3.0, 3.0, 1.0) / 8.0;
  uniform sampler2D source;
  uniform vec2 source_delta_uv;
  layout(location=0) out vec4 frag_color;
  void main() { 
    vec2 ij = floor(gl_FragCoord.xy);
    vec2 source_ij = ij * 2.0 - vec2(1.5);
    vec2 source_uv = source_ij * source_delta_uv;
    vec3 color = vec3(0.0);
    for (int i = 0; i < 4; ++i) {
      float wi = WEIGHTS[i];
      for (int j = 0; j < 4; ++j) {
        float wj = WEIGHTS[j];
        vec2 delta_uv = vec2(i, j) * source_delta_uv;
        color += wi * wj * texture(source, source_uv + delta_uv).rgb;
      }
    }
    frag_color = vec4(min(color, ${MAX_FLOAT16}), 1.0);
  }`;

// Bloom blur fragment shader executing a 5x5 convolution blur
const BLOOM_SHADER =
  `#version 300 es
  precision highp float;
  uniform sampler2D source;
  uniform vec2 source_delta_uv;
  uniform vec3 source_samples_uvw[SIZE];
  layout(location=0) out vec4 frag_color;
  void main() { 
    vec2 source_uv = (gl_FragCoord.xy + vec2(1.0)) * source_delta_uv;
    vec3 color = vec3(0.0);
    for (int i = 0; i < SIZE; ++i) {
      vec3 uvw = source_samples_uvw[i];
      color += uvw.z * texture(source, source_uv + uvw.xy).rgb;
    }
    frag_color = vec4(min(color, ${MAX_FLOAT16}), 1.0);
  }`;

// Upsampling fragment shader performing bilinear tent interpolation blending
const UPSAMPLE_SHADER =
  `#version 300 es
  precision highp float;
  const vec4 WEIGHTS[4] = vec4[4] (
    vec4(1.0, 3.0, 3.0, 9.0) / 16.0,
    vec4(3.0, 1.0, 9.0, 3.0) / 16.0,
    vec4(3.0, 9.0, 1.0, 3.0) / 16.0,
    vec4(9.0, 3.0, 3.0, 1.0) / 16.0
  );
  uniform sampler2D source;
  uniform vec2 source_delta_uv;
  layout(location=0) out vec4 frag_color;
  void main() {
    vec2 ij = floor(gl_FragCoord.xy);
    vec2 source_ij = floor((ij - vec2(1.0)) * 0.5) + vec2(0.5);
    vec2 source_uv = source_ij * source_delta_uv;
    vec3 c0 = texture(source, source_uv).rgb;
    vec3 c1 = texture(source, source_uv + vec2(source_delta_uv.x, 0.0)).rgb;
    vec3 c2 = texture(source, source_uv + vec2(0.0, source_delta_uv.y)).rgb;
    vec3 c3 = texture(source, source_uv + source_delta_uv).rgb;
    vec4 weight = WEIGHTS[int(mod(ij.x, 2.0) + 2.0 * mod(ij.y, 2.0))];
    vec3 color = weight.x * c0 + weight.y * c1 + weight.z * c2 + weight.w * c3;
    frag_color = vec4(min(color, ${MAX_FLOAT16}), 1.0);
  }`;

// Final composite rendering fragment shader with ACES filmic or exponential tone mapping
const RENDER_SHADER =
  `#version 300 es
  precision highp float;
  uniform sampler2D source;
  uniform vec2 source_delta_uv;
  uniform vec3 source_samples_uvw[SIZE];
  uniform sampler2D bloom;
  uniform vec2 bloom_delta_uv;
  uniform float intensity;
  uniform float exposure;
  uniform bool high_contrast;
  layout(location=0) out vec4 frag_color;

  // Standard exponential tone mapping: T(x) = 1 - e^-x
  vec3 toneMap(vec3 color) {
    return pow(vec3(1.0) - exp(-color), vec3(1.0 / 2.2));
  }
  
  // ACES Filmic Tone Mapping approximation curve
  vec3 toneMapACES(vec3 color) {
    const float A = 2.51;
    const float B = 0.03;
    const float C = 2.43;
    const float D = 0.59;
    const float E = 0.14;
    color = (color * (A * color + B)) / (color * (C * color + D) + E);
    return pow(color, vec3(1.0 / 2.2));
  }

  void main() {
    vec2 source_uv = (gl_FragCoord.xy + vec2(1.0)) * source_delta_uv;
    vec3 color = texture(bloom, 0.5 * gl_FragCoord.xy * bloom_delta_uv).rgb;
    for (int i = 0; i < SIZE; ++i) {
      vec3 uvw = source_samples_uvw[i];
      color += uvw.z * texture(source, source_uv + uvw.xy).rgb;
    }
    color = mix(texture(source, source_uv).rgb, color, intensity) * exposure;
    color = min(color, 10.0);
    if (high_contrast) {
      color = toneMapACES(color);
    } else {
      color = toneMap(color);
    }
    frag_color = vec4(color, 1.0);
  }`;

/**
 * @brief Helper utility to create and compile a WebGL shader.
 */
const createShader = function(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
};

/**
 * @brief Helper utility to create and configure a WebGL texture.
 */
const createTexture = function(gl: WebGL2RenderingContext, textureUnit: number, target: number): WebGLTexture {
  const texture = gl.createTexture();
  if (!texture) throw new Error("Could not create texture");
  gl.activeTexture(textureUnit);
  gl.bindTexture(target, texture);
  gl.texParameteri(target, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  gl.texParameteri(target, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(target, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
};

interface SizeableTexture {
  texture: WebGLTexture;
  width: number;
  height: number;
}

interface CustomWebGLProgram extends WebGLProgram {
  sourceDeltaUvUniform?: WebGLUniformLocation | null;
  intensityUniform?: WebGLUniformLocation | null;
  exposureUniform?: WebGLUniformLocation | null;
  highContrastUniform?: WebGLUniformLocation | null;
  bloomDeltaUvUniform?: WebGLUniformLocation | null;
}

export class Bloom {
  private gl: WebGL2RenderingContext;
  private width: number;
  private height: number;

  private vertexBuffer: WebGLBuffer | null;
  private downsampleProgram: CustomWebGLProgram;
  private bloomProgram: CustomWebGLProgram;
  private upsampleProgram: CustomWebGLProgram;
  private renderProgram: CustomWebGLProgram;

  private numLevels = 0;
  private mipmapTextures: SizeableTexture[] = [];
  private filterTextures: (SizeableTexture | null)[] = [];
  private bloomFilters: number[][][] = [];

  private mipmapFbos: WebGLFramebuffer[] = [];
  private filterFbos: (WebGLFramebuffer | null)[] = [];
  private depthBuffer: WebGLRenderbuffer | null = null;

  constructor(gl: WebGL2RenderingContext, width: number, height: number) {
    this.gl = gl;
    this.width = width;
    this.height = height;

    // Enable floating point color attachments and blending extensions
    gl.getExtension('OES_texture_float_linear');
    gl.getExtension('EXT_color_buffer_float');
    gl.getExtension('EXT_float_blend');

    // Create a screen quad vertex buffer
    this.vertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, +1, -1, -1, +1, +1, +1]), gl.STATIC_DRAW);

    const vertexShader = createShader(gl, gl.VERTEX_SHADER, VERTEX_SHADER);

    const createAndLinkProgram = (fragSource: string): CustomWebGLProgram => {
      const p = gl.createProgram() as CustomWebGLProgram;
      if (!p) throw new Error("Could not create program");
      gl.attachShader(p, vertexShader);
      gl.attachShader(p, createShader(gl, gl.FRAGMENT_SHADER, fragSource));
      gl.linkProgram(p);
      return p;
    };

    // Initialize Downsample Shader Program
    this.downsampleProgram = createAndLinkProgram(DOWNSAMPLE_SHADER);
    gl.useProgram(this.downsampleProgram);
    gl.uniform1i(gl.getUniformLocation(this.downsampleProgram, 'source'), 0);
    this.downsampleProgram.sourceDeltaUvUniform = gl.getUniformLocation(this.downsampleProgram, 'source_delta_uv');

    // Initialize Bloom Blur Shader Program (5x5 filter kernel size = 25 samples)
    this.bloomProgram = createAndLinkProgram(BLOOM_SHADER.replace(/SIZE/g, '25'));
    gl.useProgram(this.bloomProgram);
    gl.uniform1i(gl.getUniformLocation(this.bloomProgram, 'source'), 0);
    this.bloomProgram.sourceDeltaUvUniform = gl.getUniformLocation(this.bloomProgram, 'source_delta_uv');

    // Initialize Upsample Shader Program
    this.upsampleProgram = createAndLinkProgram(UPSAMPLE_SHADER);
    gl.useProgram(this.upsampleProgram);
    gl.uniform1i(gl.getUniformLocation(this.upsampleProgram, 'source'), 0);
    this.upsampleProgram.sourceDeltaUvUniform = gl.getUniformLocation(this.upsampleProgram, 'source_delta_uv');

    // Initialize Final Composite Rendering Shader Program
    this.renderProgram = createAndLinkProgram(RENDER_SHADER.replace(/SIZE/g, '25'));
    gl.useProgram(this.renderProgram);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, 'source'), 0);
    gl.uniform1i(gl.getUniformLocation(this.renderProgram, 'bloom'), 1);
    this.renderProgram.intensityUniform = gl.getUniformLocation(this.renderProgram, 'intensity');
    this.renderProgram.exposureUniform = gl.getUniformLocation(this.renderProgram, 'exposure');
    this.renderProgram.highContrastUniform = gl.getUniformLocation(this.renderProgram, 'high_contrast');
    this.renderProgram.sourceDeltaUvUniform = gl.getUniformLocation(this.renderProgram, 'source_delta_uv');
    this.renderProgram.bloomDeltaUvUniform = gl.getUniformLocation(this.renderProgram, 'bloom_delta_uv');

    this.numLevels = 0;
    this.mipmapTextures = [];
    this.filterTextures = [];
    this.bloomFilters = [];

    // Allocate textures for downsampling and upsampling mipmap levels
    for (let i = 0; i < MAX_LEVELS; ++i) {
      const mipmapTexture = createTexture(gl, gl.TEXTURE0, gl.TEXTURE_2D);
      this.mipmapTextures.push({ texture: mipmapTexture, width: 0, height: 0 });
      if (i > 0) {
        const filterTexture = createTexture(gl, gl.TEXTURE0, gl.TEXTURE_2D);
        if (i == 1) {
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
          gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
        }
        this.filterTextures.push({ texture: filterTexture, width: 0, height: 0 });
      } else {
        this.filterTextures.push(null);
      }
    }

    this.mipmapFbos = [];
    this.filterFbos = [];
    this.depthBuffer = null;

    // Attach allocated textures to framebuffers
    for (let i = 0; i < MAX_LEVELS; ++i) {
      const mipmapFbo = gl.createFramebuffer();
      if (!mipmapFbo) throw new Error("Could not create framebuffer");
      this.mipmapFbos.push(mipmapFbo);
      gl.bindFramebuffer(gl.FRAMEBUFFER, mipmapFbo);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.mipmapTextures[i].texture, 0);
      if (i > 0) {
        const filterFbo = gl.createFramebuffer();
        if (!filterFbo) throw new Error("Could not create framebuffer");
        this.filterFbos.push(filterFbo);
        gl.bindFramebuffer(gl.FRAMEBUFFER, filterFbo);
        const filterTex = this.filterTextures[i];
        if (filterTex) {
          gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, filterTex.texture, 0);
        }
      } else {
        // Allocate depth buffer for the base level
        this.depthBuffer = gl.createRenderbuffer();
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.mipmapTextures[0].width, this.mipmapTextures[0].height);
        gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_ATTACHMENT, gl.RENDERBUFFER, this.depthBuffer);
        this.filterFbos.push(null);
      }
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);

    this.resize(width, height);
  }

  /**
   * @brief Resizes textures and recalculates bloom filter weights based on new viewport size.
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;

    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);
    let level = 0;
    let w = width;
    let h = height;

    // Reallocate mipmap dimensions. Keep textures slightly padded (+2) to support bilinear samples safely.
    while (h > 2 && level < MAX_LEVELS) {
      const mipmapTex = this.mipmapTextures[level];
      gl.bindTexture(gl.TEXTURE_2D, mipmapTex.texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w + 2, h + 2, 0, gl.RGBA, gl.FLOAT, null);
      mipmapTex.width = w + 2;
      mipmapTex.height = h + 2;

      const filterTex = this.filterTextures[level];
      if (level > 0 && filterTex) {
        gl.bindTexture(gl.TEXTURE_2D, filterTex.texture);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.FLOAT, null);
        filterTex.width = w;
        filterTex.height = h;
      } else if (level === 0) {
        gl.bindRenderbuffer(gl.RENDERBUFFER, this.depthBuffer);
        gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH_COMPONENT16, this.mipmapTextures[0].width, this.mipmapTextures[0].height);
      }

      level += 1;
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
    this.numLevels = level;

    // Find the precomputed bloom kernel matches closest to current viewport height
    this.bloomFilters = [];
    let nearest_size_index = 0;
    let nearest_size = BLOOM_FILTERS[nearest_size_index] as number;
    for (let i = 2; i < BLOOM_FILTERS.length; i += 2) {
      const currentSize = BLOOM_FILTERS[i] as number;
      if (Math.abs(currentSize - height) < Math.abs(nearest_size - height)) {
        nearest_size_index = i;
        nearest_size = currentSize;
      }
    }

    // Populate bloom filter textures offsets and weights for 5x5 convolution blur
    const filters = BLOOM_FILTERS[nearest_size_index + 1] as number[][];
    for (let i = 0; i < this.numLevels; ++i) {
      const bloomFilter: number[][] = [];
      const mWidth = this.mipmapTextures[i].width;
      const mHeight = this.mipmapTextures[i].height;
      for (let y = -2; y <= 2; ++y) {
        const iy = Math.abs(y);
        for (let x = -2; x <= 2; ++x) {
          const ix = Math.abs(x);
          const index = ix < iy ? (iy * (iy + 1)) / 2 + ix : (ix * (ix + 1)) / 2 + iy;
          const wt = filters[i][index];
          // Store uv offset and weight
          bloomFilter.push([x / mWidth, y / mHeight, wt]);
        }
      }
      this.bloomFilters.push(bloomFilter);
    }
  }

  /**
   * @brief Prepares the WebGL state to record the high-range scene rendering.
   */
  begin(): void {
    const gl = this.gl;
    // Bind base FBO (Level 0)
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.mipmapFbos[0]);
    gl.viewport(1, 1, this.mipmapTextures[0].width - 2, this.mipmapTextures[0].height - 2);
  }

  /**
   * @brief Executes downsampling, bloom blurs, upsampling pyramid, and tone mapping passes.
   */
  end(intensity: number, exposure: number, highContrast: boolean): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0);

    // --- Downsampling Pyramid Construction ---
    let program = this.downsampleProgram;
    gl.useProgram(program);
    for (let level = 1; level < this.numLevels; ++level) {
      const targetTexture = this.mipmapTextures[level];
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.mipmapFbos[level]);
      gl.viewport(1, 1, targetTexture.width - 2, targetTexture.height - 2);
      gl.bindTexture(gl.TEXTURE_2D, this.mipmapTextures[level - 1].texture);
      if (program.sourceDeltaUvUniform) {
        gl.uniform2f(program.sourceDeltaUvUniform, 
            1.0 / this.mipmapTextures[level - 1].width,
            1.0 / this.mipmapTextures[level - 1].height);
      }
      this.drawQuad(program);
    }

    // --- Bloom Convolution Blur Pass ---
    program = this.bloomProgram;
    gl.useProgram(program);
    for (let level = 1; level < this.numLevels; ++level) {
      const targetTexture = this.filterTextures[level];
      if (!targetTexture) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.filterFbos[level]);
      gl.viewport(0, 0, targetTexture.width, targetTexture.height);
      gl.bindTexture(gl.TEXTURE_2D, this.mipmapTextures[level].texture);
      if (program.sourceDeltaUvUniform) {
        gl.uniform2f(program.sourceDeltaUvUniform, 
            1.0 / this.mipmapTextures[level].width,
            1.0 / this.mipmapTextures[level].height);
      }
      // Send 25 precomputed filter sample weights and offsets
      for (let i = 0; i < 25; ++i) {
        gl.uniform3f(gl.getUniformLocation(program, `source_samples_uvw[${i}]`),
            this.bloomFilters[level][i][0],
            this.bloomFilters[level][i][1], 
            this.bloomFilters[level][i][2]);
      }
      this.drawQuad(program);
    }

    // --- Upsampling and Accumulation Pass ---
    program = this.upsampleProgram;
    gl.activeTexture(gl.TEXTURE0);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE); // Additive blending for light leakage accumulation
    gl.useProgram(program);
    for (let level = this.numLevels - 2; level >= 1; --level) {
      const targetTexture = this.filterTextures[level];
      if (!targetTexture) continue;
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.filterFbos[level]);
      gl.viewport(0, 0, targetTexture.width, targetTexture.height);
      const filterTexNext = this.filterTextures[level + 1];
      if (filterTexNext) {
        gl.bindTexture(gl.TEXTURE_2D, filterTexNext.texture);
        if (program.sourceDeltaUvUniform) {
          gl.uniform2f(program.sourceDeltaUvUniform, 
              1.0 / filterTexNext.width,
              1.0 / filterTexNext.height);
        }
      }
      this.drawQuad(program);
    }
    gl.disable(gl.BLEND);

    // --- Final Composite and Tone Mapping Pass ---
    gl.bindFramebuffer(gl.FRAMEBUFFER, null); // Render directly to the screen/canvas backbuffer
    gl.viewport(0, 0, this.width, this.height);

    program = this.renderProgram;
    gl.useProgram(program);
    
    // Bind original scene texture
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.mipmapTextures[0].texture);
    
    // Bind accumulated bloom texture
    gl.activeTexture(gl.TEXTURE1);
    const filterTex1 = this.filterTextures[1];
    if (filterTex1) {
      gl.bindTexture(gl.TEXTURE_2D, filterTex1.texture);
    }
    if (program.sourceDeltaUvUniform) {
      gl.uniform2f(program.sourceDeltaUvUniform, 
          1.0 / this.mipmapTextures[0].width, 
          1.0 / this.mipmapTextures[0].height);
    }
    if (program.bloomDeltaUvUniform && filterTex1) {
      gl.uniform2f(program.bloomDeltaUvUniform, 
          1.0 / filterTex1.width,
          1.0 / filterTex1.height);
    }
    if (this.numLevels > 0) {
      for (let i = 0; i < 25; ++i) {
        gl.uniform3f(gl.getUniformLocation(program, `source_samples_uvw[${i}]`),
            this.bloomFilters[0][i][0],
            this.bloomFilters[0][i][1], 
            this.bloomFilters[0][i][2]);
      }
    }
    if (program.intensityUniform) gl.uniform1f(program.intensityUniform, intensity);
    if (program.exposureUniform) gl.uniform1f(program.exposureUniform, exposure);
    if (program.highContrastUniform) gl.uniform1i(program.highContrastUniform, highContrast ? 1 : 0);
    
    this.drawQuad(program);
  }

  /**
   * @brief Helper to bind screen-quad vertices and execute glDrawArrays.
   */
  private drawQuad(program: WebGLProgram): void {
    const gl = this.gl;
    const vertexAttrib = gl.getAttribLocation(program, 'vertex');
    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    gl.vertexAttribPointer(
        vertexAttrib,
        2,
        gl.FLOAT,
        false,
        0,
        0);
    gl.enableVertexAttribArray(vertexAttrib);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}
