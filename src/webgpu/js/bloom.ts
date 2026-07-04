/**
 * Maximum number of mipmap levels allocated for the bloom texture chain.
 */
const MAX_LEVELS = 9;

/**
 * WGSL Shader source containing shaders for Downsampling, Bloom Filtering, Upsampling, and final Compositing.
 */
const WGSL_SHADERS = `
struct VertexOutput {
  @builtin(position) Position: vec4<f32>,
};

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  // Generate a full-screen triangle quad from a single vertex index.
  var pos = vec2<f32>(
    f32((VertexIndex << 1u) & 2u) - 1.0,
    f32(VertexIndex & 2u) - 1.0
  );
  out.Position = vec4<f32>(pos, 0.0, 1.0);
  return out;
}

@group(0) @binding(0) var source_texture: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;

struct DownsampleUniforms {
  source_delta_uv: vec2<f32>,
};
@group(0) @binding(2) var<uniform> u_downsample: DownsampleUniforms;

// Binomial filter coefficients for a 4x4 downsample kernel [1, 3, 3, 1] / 8.
const WEIGHTS = vec4<f32>(1.0, 3.0, 3.0, 1.0) / 8.0;

/**
 * Downsample shader using a 4x4 binomial sample grid.
 * Offsets sample centers by 1.5 texels to perform box-filtered downsampling using bilinear interpolation.
 */
@fragment
fn downsample_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let ij = floor(in.Position.xy);
  // Shift by 1.5 texels to align sample points with the higher resolution pixels.
  let source_ij = ij * 2.0 - vec2<f32>(1.5);
  let source_uv = source_ij * u_downsample.source_delta_uv;
  var color = vec3<f32>(0.0);
  
  // Convolve the 4x4 grid of texels.
  for (var i = 0; i < 4; i++) {
    let wi = WEIGHTS[i];
    for (var j = 0; j < 4; j++) {
      let wj = WEIGHTS[j];
      let delta_uv = vec2<f32>(f32(i), f32(j)) * u_downsample.source_delta_uv;
      color += wi * wj * textureSampleLevel(source_texture, linear_sampler, source_uv + delta_uv, 0.0).rgb;
    }
  }
  // Clamp intensity to float16 maximum (6.55e4) to prevent numerical overflow in rgba16float textures.
  return vec4<f32>(min(color, vec3<f32>(6.55e4)), 1.0);
}

struct BloomUniforms {
  source_delta_uv: vec2<f32>,
  _pad: vec2<f32>,
  // Offsets (xy) and weights (z) for a 5x5 Gaussian/bloom filter kernel.
  source_samples_uvw: array<vec4<f32>, 25>,
};
@group(0) @binding(2) var<uniform> u_bloom: BloomUniforms;

/**
 * Applies a 5x5 convolution filter using weights packed into uniforms.
 * Isolates and broadens light spots across intermediate mipmap resolutions.
 */
@fragment
fn bloom_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let source_uv = (in.Position.xy + vec2<f32>(1.0)) * u_bloom.source_delta_uv;
  var color = vec3<f32>(0.0);
  for (var i = 0; i < 25; i++) {
    let uvw = u_bloom.source_samples_uvw[i];
    color += uvw.z * textureSampleLevel(source_texture, linear_sampler, source_uv + uvw.xy, 0.0).rgb;
  }
  return vec4<f32>(min(color, vec3<f32>(6.55e4)), 1.0);
}

// Weights representing a 2x2 tent upsampling filter grid.
const UPSAMPLE_WEIGHTS = array<vec4<f32>, 4>(
  vec4<f32>(1.0, 3.0, 3.0, 9.0) / 16.0,
  vec4<f32>(3.0, 1.0, 9.0, 3.0) / 16.0,
  vec4<f32>(3.0, 9.0, 1.0, 3.0) / 16.0,
  vec4<f32>(9.0, 3.0, 3.0, 1.0) / 16.0
);

/**
 * Upsamples a lower-resolution texture by interpolating pixel values.
 * Uses pixel coordinate parity (modulo 2) to select specific tent-filter weights.
 */
@fragment
fn upsample_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let ij = floor(in.Position.xy);
  // Compute coordinate centers in the lower-resolution source.
  let source_ij = floor((ij - vec2<f32>(1.0)) * 0.5) + vec2<f32>(0.5);
  let source_uv = source_ij * u_downsample.source_delta_uv;
  
  // Sample a 2x2 block of source pixels.
  let c0 = textureSampleLevel(source_texture, linear_sampler, source_uv, 0.0).rgb;
  let c1 = textureSampleLevel(source_texture, linear_sampler, source_uv + vec2<f32>(u_downsample.source_delta_uv.x, 0.0), 0.0).rgb;
  let c2 = textureSampleLevel(source_texture, linear_sampler, source_uv + vec2<f32>(0.0, u_downsample.source_delta_uv.y), 0.0).rgb;
  let c3 = textureSampleLevel(source_texture, linear_sampler, source_uv + u_downsample.source_delta_uv, 0.0).rgb;
  
  // Resolve index based on pixel location parity (x-mod-2, y-mod-2).
  let mx = u32(ij.x % 2.0);
  let my = u32(ij.y % 2.0);
  let idx = mx + 2u * my;
  let weight = UPSAMPLE_WEIGHTS[idx];
  
  let color = weight.x * c0 + weight.y * c1 + weight.z * c2 + weight.w * c3;
  return vec4<f32>(min(color, vec3<f32>(6.55e4)), 1.0);
}

struct RenderUniforms {
  source_delta_uv: vec2<f32>,
  bloom_delta_uv: vec2<f32>,
  intensity: f32,
  exposure: f32,
  high_contrast: u32,
  _pad: u32,
  source_samples_uvw: array<vec4<f32>, 25>,
};
@group(0) @binding(2) var<uniform> u_render: RenderUniforms;
@group(0) @binding(3) var bloom_texture: texture_2d<f32>;

/**
 * Standard exponential tonemapping curve: V = pow(1 - exp(-C), 1/2.2)
 * Smoothly compresses high dynamic values and applies a 2.2 gamma correction.
 */
fn toneMap(color: vec3<f32>) -> vec3<f32> {
  return pow(vec3<f32>(1.0) - exp(-color), vec3<f32>(1.0 / 2.2));
}

/**
 * ACES Filmic tonemapping curve.
 * Approximates professional cinematographic film contrast curves.
 */
fn toneMapACES(color_in: vec3<f32>) -> vec3<f32> {
  var color = color_in;
  const A = 2.51;
  const B = 0.03;
  const C = 2.43;
  const D = 0.59;
  const E = 0.14;
  color = (color * (A * color + B)) / (color * (C * color + D) + E);
  return pow(color, vec3<f32>(1.0 / 2.2));
}

/**
 * Composites the final output frame.
 * Samples the original rendering and blends it with the blurred bloom glow texture.
 * Applies exposure scaling, intensity blending, brightness clamping, and final tonemapping.
 */
@fragment
fn render_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let source_uv = (in.Position.xy + vec2<f32>(1.0)) * u_render.source_delta_uv;
  var color = textureSampleLevel(bloom_texture, linear_sampler, 0.5 * in.Position.xy * u_render.bloom_delta_uv, 0.0).rgb;
  
  // Extract high frequency components from source.
  for (var i = 0; i < 25; i++) {
    let uvw = u_render.source_samples_uvw[i];
    color += uvw.z * textureSampleLevel(source_texture, linear_sampler, source_uv + uvw.xy, 0.0).rgb;
  }
  
  let source_color = textureSampleLevel(source_texture, linear_sampler, source_uv, 0.0).rgb;
  // Blend source and bloom textures.
  var final_color = mix(source_color, color, u_render.intensity) * u_render.exposure;
  final_color = min(final_color, vec3<f32>(10.0)); // Clamp maximum brightness to 10.0.
  
  // Apply the selected tonemapping algorithm.
  if (u_render.high_contrast == 1u) {
    final_color = toneMapACES(final_color);
  } else {
    final_color = toneMap(final_color);
  }
  return vec4<f32>(final_color, 1.0);
}
`;

/**
 * Table storing pre-calculated filter coefficients optimized for different display heights.
 * Each entry maps a vertical height resolution to a 5x5 convolution weight matrix.
 */
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

/**
 * Bloom implements downsampling, upsampling, and compositing steps
 * to overlay realistic light bloom on bright scene components.
 */
export class Bloom {
  private device: GPUDevice;
  private canvasFormat: GPUTextureFormat;
  private width: number;
  private height: number;
  private numLevels: number;

  private linearSampler: GPUSampler;
  private shaderModule: GPUShaderModule;

  private downsampleUniformBuffers: GPUBuffer[] = [];
  private bloomUniformBuffers: GPUBuffer[] = [];
  private upsampleUniformBuffers: GPUBuffer[] = [];
  private renderUniformBuffer: GPUBuffer;

  private downsampleBindGroupLayout: GPUBindGroupLayout;
  private bloomBindGroupLayout: GPUBindGroupLayout;
  private upsampleBindGroupLayout: GPUBindGroupLayout;
  private renderBindGroupLayout: GPUBindGroupLayout;

  private downsamplePipeline: GPURenderPipeline;
  private bloomPipeline: GPURenderPipeline;
  private upsamplePipeline: GPURenderPipeline;
  private renderPipeline: GPURenderPipeline;

  private downsampleBindGroups: GPUBindGroup[] = [];
  private bloomBindGroups: GPUBindGroup[] = [];
  private upsampleBindGroups: GPUBindGroup[] = [];

  // Arrays of Float32Arrays storing compiled 5x5 convolution weight offsets.
  private bloomFilters: Float32Array[] = [];

  mipmapTextures: GPUTexture[] = [];
  filterTextures: (GPUTexture | null)[] = [];
  depthTexture: GPUTexture | null = null;

  constructor(device: GPUDevice, canvasFormat: GPUTextureFormat, width: number, height: number) {
    this.device = device;
    this.canvasFormat = canvasFormat;
    this.width = width;
    this.height = height;
    this.numLevels = 0;

    this.linearSampler = device.createSampler({
      addressModeU: 'clamp-to-edge',
      addressModeV: 'clamp-to-edge',
      minFilter: 'linear',
      magFilter: 'linear',
    });

    this.shaderModule = device.createShaderModule({
      label: 'BloomShaders',
      code: WGSL_SHADERS
    });

    this.downsampleUniformBuffers = [];
    this.bloomUniformBuffers = [];
    this.upsampleUniformBuffers = [];
    for (let i = 0; i < MAX_LEVELS; ++i) {
      this.downsampleUniformBuffers.push(device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }));
      this.bloomUniformBuffers.push(device.createBuffer({
        size: 416, // Large enough to store 25 sample points (offset_x, offset_y, weight, pad)
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }));
      this.upsampleUniformBuffers.push(device.createBuffer({
        size: 16,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }));
    }
    this.renderUniformBuffer = device.createBuffer({
      size: 432,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Setup layouts.
    this.downsampleBindGroupLayout = device.createBindGroupLayout({
      label: 'BloomDownsampleBindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
      ]
    });

    this.bloomBindGroupLayout = device.createBindGroupLayout({
      label: 'BloomFilterBindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
      ]
    });

    this.upsampleBindGroupLayout = device.createBindGroupLayout({
      label: 'BloomUpsampleBindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
      ]
    });

    this.renderBindGroupLayout = device.createBindGroupLayout({
      label: 'BloomRenderBindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } }
      ]
    });

    const pipelineLayout = (layout: GPUBindGroupLayout) => device.createPipelineLayout({ bindGroupLayouts: [layout] });

    // Initialize rendering pipelines.
    this.downsamplePipeline = device.createRenderPipeline({
      label: 'BloomDownsamplePipeline',
      layout: pipelineLayout(this.downsampleBindGroupLayout),
      vertex: { module: this.shaderModule, entryPoint: 'vert_main' },
      fragment: {
        module: this.shaderModule,
        entryPoint: 'downsample_main',
        targets: [{ format: 'rgba16float' }]
      },
      primitive: { topology: 'triangle-strip' }
    });

    this.bloomPipeline = device.createRenderPipeline({
      label: 'BloomFilterPipeline',
      layout: pipelineLayout(this.bloomBindGroupLayout),
      vertex: { module: this.shaderModule, entryPoint: 'vert_main' },
      fragment: {
        module: this.shaderModule,
        entryPoint: 'bloom_main',
        targets: [{ format: 'rgba16float' }]
      },
      primitive: { topology: 'triangle-strip' }
    });

    this.upsamplePipeline = device.createRenderPipeline({
      label: 'BloomUpsamplePipeline',
      layout: pipelineLayout(this.upsampleBindGroupLayout),
      vertex: { module: this.shaderModule, entryPoint: 'vert_main' },
      fragment: {
        module: this.shaderModule,
        entryPoint: 'upsample_main',
        targets: [{
          format: 'rgba16float',
          // Configure additive blend factors to combine upsampled frames with lower levels.
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
          }
        }]
      },
      primitive: { topology: 'triangle-strip' }
    });

    this.renderPipeline = device.createRenderPipeline({
      label: 'BloomRenderPipeline',
      layout: pipelineLayout(this.renderBindGroupLayout),
      vertex: { module: this.shaderModule, entryPoint: 'vert_main' },
      fragment: {
        module: this.shaderModule,
        entryPoint: 'render_main',
        targets: [{ format: this.canvasFormat }]
      },
      primitive: { topology: 'triangle-strip' }
    });

    this.mipmapTextures = [];
    this.filterTextures = [];
    this.depthTexture = null;

    this.resize(width, height);
  }

  /**
   * Reallocates rendering textures and compiles 5x5 convolution weight arrays
   * whenever the display viewport size is changed.
   */
  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;

    if (this.mipmapTextures.length > 0) {
      for (let t of this.mipmapTextures) { if (t) t.destroy(); }
      for (let t of this.filterTextures) { if (t) t.destroy(); }
      if (this.depthTexture) this.depthTexture.destroy();
    }

    this.mipmapTextures = [];
    this.filterTextures = [];

    let level = 0;
    let w = width;
    let h = height;

    // Allocate downsampled mipmap texture layers.
    while (h > 2 && level < MAX_LEVELS) {
      // Add a 2-pixel margin around downsampled textures to prevent edge artifacts.
      const mipW = w + 2;
      const mipH = h + 2;

      const mipmapTexture = this.device.createTexture({
        label: `BloomMipmapTexture_Level${level}`,
        size: [mipW, mipH, 1],
        format: 'rgba16float',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
      });
      this.mipmapTextures.push(mipmapTexture);

      if (level > 0) {
        const filterTexture = this.device.createTexture({
          label: `BloomFilterTexture_Level${level}`,
          size: [w, h, 1],
          format: 'rgba16float',
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
        });
        this.filterTextures.push(filterTexture);
      } else {
        this.filterTextures.push(null);
      }

      level += 1;
      w = Math.ceil(w / 2);
      h = Math.ceil(h / 2);
    }
    this.numLevels = level;

    this.depthTexture = this.device.createTexture({
      label: 'BloomDepthTexture',
      size: [this.mipmapTextures[0].width, this.mipmapTextures[0].height, 1],
      format: 'depth24plus',
      usage: GPUTextureUsage.RENDER_ATTACHMENT
    });

    // Locate the closest matching filter height configuration in the BLOOM_FILTERS catalog.
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

    // Compile 25-point sample arrays for each mipmap level.
    // The filter coefficients are symmetric: weight at (x, y) equals weight at (abs(x), abs(y)).
    // Triangular indexing translates ix, iy into a single index of 6 values.
    const filters = BLOOM_FILTERS[nearest_size_index + 1] as number[][];
    for (let i = 0; i < this.numLevels; ++i) {
      const bloomFilter = [];
      const mWidth = this.mipmapTextures[i].width;
      const mHeight = this.mipmapTextures[i].height;
      for (let y = -2; y <= 2; ++y) {
        const iy = Math.abs(y);
        for (let x = -2; x <= 2; ++x) {
          const ix = Math.abs(x);
          const index = ix < iy ? (iy * (iy + 1)) / 2 + ix : (ix * (ix + 1)) / 2 + iy;
          const wt = filters[i][index];
          // Store relative offsets (x/width, y/height), weight, and padding.
          bloomFilter.push(x / mWidth, y / mHeight, wt, 0.0);
        }
      }
      this.bloomFilters.push(new Float32Array(bloomFilter));
    }

    this.createBindGroups();
  }

  /** Constructs BindGroups representing references for each level. */
  private createBindGroups(): void {
    this.downsampleBindGroups = [];
    this.bloomBindGroups = [];
    this.upsampleBindGroups = [];

    for (let level = 1; level < this.numLevels; ++level) {
      const bg = this.device.createBindGroup({
        layout: this.downsampleBindGroupLayout,
        entries: [
          { binding: 0, resource: this.mipmapTextures[level - 1].createView() },
          { binding: 1, resource: this.linearSampler },
          { binding: 2, resource: { buffer: this.downsampleUniformBuffers[level] } }
        ]
      });
      this.downsampleBindGroups[level] = bg;
    }

    for (let level = 1; level < this.numLevels; ++level) {
      const bg = this.device.createBindGroup({
        layout: this.bloomBindGroupLayout,
        entries: [
          { binding: 0, resource: this.mipmapTextures[level].createView() },
          { binding: 1, resource: this.linearSampler },
          { binding: 2, resource: { buffer: this.bloomUniformBuffers[level] } }
        ]
      });
      this.bloomBindGroups[level] = bg;
    }

    for (let level = 1; level < this.numLevels - 1; ++level) {
      const filterTex = this.filterTextures[level + 1];
      if (!filterTex) continue;
      const bg = this.device.createBindGroup({
        layout: this.upsampleBindGroupLayout,
        entries: [
          { binding: 0, resource: filterTex.createView() },
          { binding: 1, resource: this.linearSampler },
          { binding: 2, resource: { buffer: this.upsampleUniformBuffers[level] } }
        ]
      });
      this.upsampleBindGroups[level] = bg;
    }
  }

  /** Retrieves the target GPUTextureView where the main scene should render before applying bloom. */
  begin(): GPUTextureView {
    return this.mipmapTextures[0].createView();
  }

  /**
   * Performs the downsample, filter, upsample, and composite passes.
   */
  end(commandEncoder: GPUCommandEncoder, canvasTextureView: GPUTextureView, intensity: number, exposure: number, highContrast: boolean): void {
    // 1. Pack downsampling pixel coordinate delta variables.
    for (let level = 1; level < this.numLevels; ++level) {
      const sourceW = this.mipmapTextures[level - 1].width;
      const sourceH = this.mipmapTextures[level - 1].height;
      const data = new Float32Array([1.0 / sourceW, 1.0 / sourceH, 0.0, 0.0]);
      this.device.queue.writeBuffer(this.downsampleUniformBuffers[level], 0, data);
    }

    // 2. Pack 5x5 bloom filter weights.
    for (let level = 1; level < this.numLevels; ++level) {
      const sourceW = this.mipmapTextures[level].width;
      const sourceH = this.mipmapTextures[level].height;
      
      const bloomData = new Float32Array(4 + 100);
      bloomData[0] = 1.0 / sourceW;
      bloomData[1] = 1.0 / sourceH;
      bloomData.set(this.bloomFilters[level], 4);
      
      this.device.queue.writeBuffer(this.bloomUniformBuffers[level], 0, bloomData);
    }

    // 3. Pack upsampling delta variables.
    for (let level = this.numLevels - 2; level >= 1; --level) {
      const filterTex = this.filterTextures[level + 1];
      if (!filterTex) continue;
      const sourceW = filterTex.width;
      const sourceH = filterTex.height;
      const data = new Float32Array([1.0 / sourceW, 1.0 / sourceH, 0.0, 0.0]);
      this.device.queue.writeBuffer(this.upsampleUniformBuffers[level], 0, data);
    }

    // 4. Pack compositor uniforms.
    const sourceW = this.mipmapTextures[0].width;
    const sourceH = this.mipmapTextures[0].height;
    const filterTex1 = this.filterTextures[1];
    if (!filterTex1) return;
    const bloomW = filterTex1.width;
    const bloomH = filterTex1.height;

    const renderData = new Float32Array(8 + 100);
    renderData[0] = 1.0 / sourceW;
    renderData[1] = 1.0 / sourceH;
    renderData[2] = 1.0 / bloomW;
    renderData[3] = 1.0 / bloomH;
    renderData[4] = intensity;
    renderData[5] = exposure;
    
    const uintView = new Uint32Array(renderData.buffer);
    uintView[6] = highContrast ? 1 : 0;
    uintView[7] = 0;
    
    if (this.numLevels > 0) {
      renderData.set(this.bloomFilters[0], 8);
    }
    this.device.queue.writeBuffer(this.renderUniformBuffer, 0, renderData);

    // 5. Downsampling passes: Downsample source to lower levels (level 1 to numLevels-1).
    for (let level = 1; level < this.numLevels; ++level) {
      const targetW = this.mipmapTextures[level].width - 2;
      const targetH = this.mipmapTextures[level].height - 2;

      const passEncoder = commandEncoder.beginRenderPass({
        label: `BloomDownsamplePass_Level${level}`,
        colorAttachments: [{
          view: this.mipmapTextures[level].createView(),
          loadOp: 'clear',
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          storeOp: 'store'
        }]
      });
      passEncoder.setPipeline(this.downsamplePipeline);
      passEncoder.setBindGroup(0, this.downsampleBindGroups[level]);
      // Viewport offset is 1 pixel to skip the margin borders.
      passEncoder.setViewport(1, 1, targetW, targetH, 0, 1);
      passEncoder.draw(4, 1, 0, 0);
      passEncoder.end();
    }

    // 6. Filtering passes: Apply 5x5 filters (level 1 to numLevels-1).
    for (let level = 1; level < this.numLevels; ++level) {
      const filterTex = this.filterTextures[level];
      if (!filterTex) continue;
      const targetW = filterTex.width;
      const targetH = filterTex.height;

      const passEncoder = commandEncoder.beginRenderPass({
        label: `BloomFilterPass_Level${level}`,
        colorAttachments: [{
          view: filterTex.createView(),
          loadOp: 'clear',
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          storeOp: 'store'
        }]
      });
      passEncoder.setPipeline(this.bloomPipeline);
      passEncoder.setBindGroup(0, this.bloomBindGroups[level]);
      passEncoder.setViewport(0, 0, targetW, targetH, 0, 1);
      passEncoder.draw(4, 1, 0, 0);
      passEncoder.end();
    }

    // 7. Upsampling passes: Combine levels back up (numLevels-2 down to 1).
    for (let level = this.numLevels - 2; level >= 1; --level) {
      const filterTex = this.filterTextures[level];
      if (!filterTex) continue;
      const targetW = filterTex.width;
      const targetH = filterTex.height;

      const passEncoder = commandEncoder.beginRenderPass({
        label: `BloomUpsamplePass_Level${level}`,
        colorAttachments: [{
          view: filterTex.createView(),
          loadOp: 'load', // Additively blend to existing colors
          storeOp: 'store'
        }]
      });
      passEncoder.setPipeline(this.upsamplePipeline);
      passEncoder.setBindGroup(0, this.upsampleBindGroups[level]);
      passEncoder.setViewport(0, 0, targetW, targetH, 0, 1);
      passEncoder.draw(4, 1, 0, 0);
      passEncoder.end();
    }

    // 8. Composite pass: Tonemap and write final pixels to canvas output.
    const compositeBindGroup = this.device.createBindGroup({
      label: 'BloomCompositeBindGroup',
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: this.mipmapTextures[0].createView() },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: { buffer: this.renderUniformBuffer } },
        { binding: 3, resource: filterTex1.createView() }
      ]
    });

    const passEncoder = commandEncoder.beginRenderPass({
      label: 'BloomCompositePass',
      colorAttachments: [{
        view: canvasTextureView,
        loadOp: 'clear',
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
        storeOp: 'store'
      }]
    });
    passEncoder.setPipeline(this.renderPipeline);
    passEncoder.setBindGroup(0, compositeBindGroup);
    passEncoder.setViewport(0, 0, this.width, this.height, 0, 1);
    passEncoder.draw(4, 1, 0, 0);
    passEncoder.end();
  }
}

