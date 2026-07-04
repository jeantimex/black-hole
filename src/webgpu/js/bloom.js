(function() {

const BLOOM_FILTERS = [
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

const MAX_LEVELS = 9;

const WGSL_SHADERS = `
struct VertexOutput {
  @builtin(position) Position: vec4<f32>,
};

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
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

const WEIGHTS = vec4<f32>(1.0, 3.0, 3.0, 1.0) / 8.0;

@fragment
fn downsample_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let ij = floor(in.Position.xy);
  let source_ij = ij * 2.0 - vec2<f32>(1.5);
  let source_uv = source_ij * u_downsample.source_delta_uv;
  var color = vec3<f32>(0.0);
  for (var i = 0; i < 4; i++) {
    let wi = WEIGHTS[i];
    for (var j = 0; j < 4; j++) {
      let wj = WEIGHTS[j];
      let delta_uv = vec2<f32>(f32(i), f32(j)) * u_downsample.source_delta_uv;
      color += wi * wj * textureSampleLevel(source_texture, linear_sampler, source_uv + delta_uv, 0.0).rgb;
    }
  }
  return vec4<f32>(min(color, vec3<f32>(6.55e4)), 1.0);
}

struct BloomUniforms {
  source_delta_uv: vec2<f32>,
  _pad: vec2<f32>,
  source_samples_uvw: array<vec4<f32>, 25>,
};
@group(0) @binding(2) var<uniform> u_bloom: BloomUniforms;

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

const UPSAMPLE_WEIGHTS = array<vec4<f32>, 4>(
  vec4<f32>(1.0, 3.0, 3.0, 9.0) / 16.0,
  vec4<f32>(3.0, 1.0, 9.0, 3.0) / 16.0,
  vec4<f32>(3.0, 9.0, 1.0, 3.0) / 16.0,
  vec4<f32>(9.0, 3.0, 3.0, 1.0) / 16.0
);

@fragment
fn upsample_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let ij = floor(in.Position.xy);
  let source_ij = floor((ij - vec2<f32>(1.0)) * 0.5) + vec2<f32>(0.5);
  let source_uv = source_ij * u_downsample.source_delta_uv;
  
  let c0 = textureSampleLevel(source_texture, linear_sampler, source_uv, 0.0).rgb;
  let c1 = textureSampleLevel(source_texture, linear_sampler, source_uv + vec2<f32>(u_downsample.source_delta_uv.x, 0.0), 0.0).rgb;
  let c2 = textureSampleLevel(source_texture, linear_sampler, source_uv + vec2<f32>(0.0, u_downsample.source_delta_uv.y), 0.0).rgb;
  let c3 = textureSampleLevel(source_texture, linear_sampler, source_uv + u_downsample.source_delta_uv, 0.0).rgb;
  
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

fn toneMap(color: vec3<f32>) -> vec3<f32> {
  return pow(vec3<f32>(1.0) - exp(-color), vec3<f32>(1.0 / 2.2));
}

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

@fragment
fn render_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let source_uv = (in.Position.xy + vec2<f32>(1.0)) * u_render.source_delta_uv;
  var color = textureSampleLevel(bloom_texture, linear_sampler, 0.5 * in.Position.xy * u_render.bloom_delta_uv, 0.0).rgb;
  
  for (var i = 0; i < 25; i++) {
    let uvw = u_render.source_samples_uvw[i];
    color += uvw.z * textureSampleLevel(source_texture, linear_sampler, source_uv + uvw.xy, 0.0).rgb;
  }
  
  let source_color = textureSampleLevel(source_texture, linear_sampler, source_uv, 0.0).rgb;
  var final_color = mix(source_color, color, u_render.intensity) * u_render.exposure;
  final_color = min(final_color, vec3<f32>(10.0));
  
  if (u_render.high_contrast == 1u) {
    final_color = toneMapACES(final_color);
  } else {
    final_color = toneMap(final_color);
  }
  return vec4<f32>(final_color, 1.0);
}
`;

class Bloom {
  constructor(device, canvasFormat, width, height) {
    this.device = device;
    this.canvasFormat = canvasFormat;
    this.width = width;
    this.height = height;

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
        size: 416,
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

    const pipelineLayout = (layout) => device.createPipelineLayout({ bindGroupLayouts: [layout] });

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

    this.mipmapTextures = null;
    this.filterTextures = null;
    this.depthTexture = null;

    this.resize(width, height);
  }

  resize(width, height) {
    this.width = width;
    this.height = height;

    if (this.mipmapTextures) {
      for (let t of this.mipmapTextures) { if (t) t.destroy(); }
      for (let t of this.filterTextures) { if (t) t.destroy(); }
      if (this.depthTexture) this.depthTexture.destroy();
    }

    this.mipmapTextures = [];
    this.filterTextures = [];

    let level = 0;
    let w = width;
    let h = height;

    while (h > 2 && level < MAX_LEVELS) {
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

    this.bloomFilters = [];
    let nearest_size_index = 0;
    let nearest_size = BLOOM_FILTERS[nearest_size_index];
    for (let i = 2; i < BLOOM_FILTERS.length; i += 2) {
      if (Math.abs(BLOOM_FILTERS[i] - height) < Math.abs(nearest_size - height)) {
        nearest_size_index = i;
        nearest_size = BLOOM_FILTERS[i];
      }
    }

    const filters = BLOOM_FILTERS[nearest_size_index + 1];
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
          bloomFilter.push(x / mWidth, y / mHeight, wt, 0.0);
        }
      }
      this.bloomFilters.push(new Float32Array(bloomFilter));
    }

    this.createBindGroups();
  }

  createBindGroups() {
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
      const bg = this.device.createBindGroup({
        layout: this.upsampleBindGroupLayout,
        entries: [
          { binding: 0, resource: this.filterTextures[level + 1].createView() },
          { binding: 1, resource: this.linearSampler },
          { binding: 2, resource: { buffer: this.upsampleUniformBuffers[level] } }
        ]
      });
      this.upsampleBindGroups[level] = bg;
    }
  }

  begin() {
    return this.mipmapTextures[0].createView();
  }

  end(commandEncoder, canvasTextureView, intensity, exposure, highContrast) {
    for (let level = 1; level < this.numLevels; ++level) {
      const sourceW = this.mipmapTextures[level - 1].width;
      const sourceH = this.mipmapTextures[level - 1].height;
      const data = new Float32Array([1.0 / sourceW, 1.0 / sourceH, 0.0, 0.0]);
      this.device.queue.writeBuffer(this.downsampleUniformBuffers[level], 0, data);
    }

    for (let level = 1; level < this.numLevels; ++level) {
      const sourceW = this.mipmapTextures[level].width;
      const sourceH = this.mipmapTextures[level].height;
      
      const bloomData = new Float32Array(4 + 100);
      bloomData[0] = 1.0 / sourceW;
      bloomData[1] = 1.0 / sourceH;
      bloomData.set(this.bloomFilters[level], 4);
      
      this.device.queue.writeBuffer(this.bloomUniformBuffers[level], 0, bloomData);
    }

    for (let level = this.numLevels - 2; level >= 1; --level) {
      const sourceW = this.filterTextures[level + 1].width;
      const sourceH = this.filterTextures[level + 1].height;
      const data = new Float32Array([1.0 / sourceW, 1.0 / sourceH, 0.0, 0.0]);
      this.device.queue.writeBuffer(this.upsampleUniformBuffers[level], 0, data);
    }

    const sourceW = this.mipmapTextures[0].width;
    const sourceH = this.mipmapTextures[0].height;
    const bloomW = this.filterTextures[1].width;
    const bloomH = this.filterTextures[1].height;

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
      passEncoder.setViewport(1, 1, targetW, targetH, 0, 1);
      passEncoder.draw(4, 1, 0, 0);
      passEncoder.end();
    }

    for (let level = 1; level < this.numLevels; ++level) {
      const targetW = this.filterTextures[level].width;
      const targetH = this.filterTextures[level].height;

      const passEncoder = commandEncoder.beginRenderPass({
        label: `BloomFilterPass_Level${level}`,
        colorAttachments: [{
          view: this.filterTextures[level].createView(),
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

    for (let level = this.numLevels - 2; level >= 1; --level) {
      const targetW = this.filterTextures[level].width;
      const targetH = this.filterTextures[level].height;

      const passEncoder = commandEncoder.beginRenderPass({
        label: `BloomUpsamplePass_Level${level}`,
        colorAttachments: [{
          view: this.filterTextures[level].createView(),
          loadOp: 'load',
          storeOp: 'store'
        }]
      });
      passEncoder.setPipeline(this.upsamplePipeline);
      passEncoder.setBindGroup(0, this.upsampleBindGroups[level]);
      passEncoder.setViewport(0, 0, targetW, targetH, 0, 1);
      passEncoder.draw(4, 1, 0, 0);
      passEncoder.end();
    }

    const compositeBindGroup = this.device.createBindGroup({
      label: 'BloomCompositeBindGroup',
      layout: this.renderBindGroupLayout,
      entries: [
        { binding: 0, resource: this.mipmapTextures[0].createView() },
        { binding: 1, resource: this.linearSampler },
        { binding: 2, resource: { buffer: this.renderUniformBuffer } },
        { binding: 3, resource: this.filterTextures[1].createView() }
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

BlackHoleShaderDemoApp.Bloom = Bloom;
})();
