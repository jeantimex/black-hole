(function() {

const NEAR_PLANE = 0.1;
const FAR_PLANE = 100.0;

const ENV_MAP_LEVELS = 7;
const ENV_MAP_SIZE = 1 << (ENV_MAP_LEVELS - 1); // 64

const EXHAUST_RADIUS = 0.514;
const EXHAUST_Z_MIN = -20.0;
const EXHAUST_Z_MAX = -2.1;

const MIPMAP_WGSL = `
struct VertexOutput {
  @builtin(position) Position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  var pos = vec2<f32>(
    f32((VertexIndex << 1u) & 2u) - 1.0,
    f32(VertexIndex & 2u) - 1.0
  );
  out.Position = vec4<f32>(pos, 0.0, 1.0);
  out.uv = pos * 0.5 + 0.5;
  out.uv.y = 1.0 - out.uv.y; // Invert Y for texture coordinates
  return out;
}

@group(0) @binding(0) var src_tex: texture_2d<f32>;
@group(0) @binding(1) var linear_sampler: sampler;

@fragment
fn frag_main(in: VertexOutput) -> @location(0) vec4<f32> {
  return textureSample(src_tex, linear_sampler, in.uv);
}
`;

const loadRocketMesh = function(rocketDataUrl, callback) {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', rocketDataUrl);
  xhr.responseType = 'arraybuffer';
  xhr.onload = (event) => {
    if (xhr.status !== 200) {
      console.error("Failed to load rocket mesh binary:", rocketDataUrl, "status:", xhr.status);
      return;
    }
    const data = new DataView(xhr.response);
    const numVertexFloats = data.getUint32(0, true);
    const numIndices = data.getUint32(Uint32Array.BYTES_PER_ELEMENT, true);

    let offset = 2 * Uint32Array.BYTES_PER_ELEMENT;
    const vertices = new Float32Array(numVertexFloats);
    for (let i = 0; i < numVertexFloats; ++i) {
      vertices[i] = data.getFloat32(i * Float32Array.BYTES_PER_ELEMENT + offset, true);
    }
 
    offset += numVertexFloats * Float32Array.BYTES_PER_ELEMENT;
    const indices = new Uint32Array(numIndices);
    for (let i = 0; i < numIndices; ++i) {
      indices[i] = data.getUint32(i * Uint32Array.BYTES_PER_ELEMENT + offset, true);
    }
    callback(vertices, indices);
  };
  xhr.send();
};

const loadRocketTexture = function(device, textureUrl) {
  const texture = device.createTexture({
    size: [1, 1, 1],
    format: 'rgba8unorm',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
  });
  const placeholderData = new Uint8Array([255, 255, 255, 255]);
  device.queue.writeTexture({ texture }, placeholderData, { bytesPerRow: 4 }, [1, 1, 1]);

  const wrapper = { texture: texture };

  const image = new Image();
  image.addEventListener('load', async () => {
    try {
      const imageBitmap = await createImageBitmap(image);
      const mipLevels = Math.floor(Math.log2(Math.max(imageBitmap.width, imageBitmap.height))) + 1;
      const newTexture = device.createTexture({
        label: textureUrl,
        size: [imageBitmap.width, imageBitmap.height, 1],
        mipLevelCount: mipLevels,
        format: 'rgba8unorm',
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST | GPUTextureUsage.RENDER_ATTACHMENT
      });

      // Mipmap generation using Canvas API for absolute robustness
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      let levelWidth = imageBitmap.width;
      let levelHeight = imageBitmap.height;
      let level = 0;
      while (levelWidth >= 1 && levelHeight >= 1) {
        canvas.width = levelWidth;
        canvas.height = levelHeight;
        ctx.drawImage(imageBitmap, 0, 0, levelWidth, levelHeight);
        const bitmap = await createImageBitmap(canvas);
        device.queue.copyExternalImageToTexture(
          { source: bitmap },
          { texture: newTexture, mipLevel: level },
          [levelWidth, levelHeight]
        );
        if (levelWidth === 1 && levelHeight === 1) break;
        levelWidth = Math.max(1, Math.floor(levelWidth / 2));
        levelHeight = Math.max(1, Math.floor(levelHeight / 2));
        level++;
      }
      wrapper.texture = newTexture;
    } catch (e) {
      console.error("Failed to load/generate mipmaps for rocket texture:", textureUrl, e);
    }
  });
  image.src = textureUrl;
  return wrapper;
};

class RocketManager {
  constructor(model, cameraView) {
    this.model = model;
    this.cameraView = cameraView;
    this.device = cameraView.device;

    this.rocketUniformBuffer = this.device.createBuffer({
      size: 80,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.exhaustUniformBuffer = this.device.createBuffer({
      size: 128,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.envMapUniformBuffers = [];
    for (let i = 0; i < 6; ++i) {
      this.envMapUniformBuffers.push(this.device.createBuffer({
        size: 432,
        usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
      }));
    }

    this.baseColorTextureWrapper = loadRocketTexture(this.device, 'rocket_base_color.png');
    this.occlusionRoughnessMetallicTextureWrapper = loadRocketTexture(this.device, 'rocket_occlusion_roughness_metallic.png');
    this.normalMapTextureWrapper = loadRocketTexture(this.device, 'rocket_normal.png');

    this.envMapBindGroups = null;
    this.cachedEnvMapSkyTexture = null;

    this.rocketVertexBuffer = null;
    this.rocketIndexBuffer = null;
    this.rocketIndexCount = 0;

    this.exhaustVertexBuffer = null;
    this.exhaustIndexBuffer = null;
    this.exhaustIndexCount = 0;

    this.createEnvMapTexture();
    this.createRocketPipeline();
    this.createExhaustPipeline();
    this.createMipmapPipeline();

    loadRocketMesh('rocket.dat', (vertices, indices) => this.createRocketBuffers(vertices, indices));
    this.createExhaustBuffers();
  }

  createEnvMapTexture() {
    this.envMapTexture = this.device.createTexture({
      label: 'RocketEnvMapCubeTexture',
      size: [ENV_MAP_SIZE, ENV_MAP_SIZE, 6],
      mipLevelCount: ENV_MAP_LEVELS,
      format: 'rgba16float',
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.RENDER_ATTACHMENT
    });
  }

  createRocketPipeline() {
    const tm = this.cameraView.textureManager;

    this.rocketBindGroupLayout = this.device.createBindGroupLayout({
      label: 'RocketBindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } }
      ]
    });

    const rocketShaderModule = this.device.createShaderModule({
      label: 'RocketShader',
      code: document.querySelector('#rocket_shader').textContent
    });

    this.rocketPipeline = this.device.createRenderPipeline({
      label: 'RocketPipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.rocketBindGroupLayout] }),
      vertex: {
        module: rocketShaderModule,
        entryPoint: 'vert_main',
        buffers: [{
          arrayStride: 52,
          attributes: [
            { shaderLocation: 0, offset: 0, format: 'float32x3' },
            { shaderLocation: 1, offset: 12, format: 'float32x3' },
            { shaderLocation: 2, offset: 24, format: 'float32x4' },
            { shaderLocation: 3, offset: 40, format: 'float32x2' },
            { shaderLocation: 4, offset: 48, format: 'float32' }
          ]
        }]
      },
      fragment: {
        module: rocketShaderModule,
        entryPoint: 'frag_main',
        targets: [{ format: 'rgba16float' }]
      },
      primitive: {
        topology: 'triangle-list',
        frontFace: 'ccw',
        cullMode: 'back'
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: true,
        depthCompare: 'less'
      }
    });
  }

  createExhaustPipeline() {
    this.exhaustBindGroupLayout = this.device.createBindGroupLayout({
      label: 'ExhaustBindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } }
      ]
    });

    const exhaustShaderModule = this.device.createShaderModule({
      label: 'ExhaustShader',
      code: document.querySelector('#exhaust_shader').textContent
    });

    const pipelineLayout = this.device.createPipelineLayout({ bindGroupLayouts: [this.exhaustBindGroupLayout] });

    const exhaustDesc = (cullMode) => ({
      label: `ExhaustPipeline_${cullMode}`,
      layout: pipelineLayout,
      vertex: {
        module: exhaustShaderModule,
        entryPoint: 'vert_main',
        buffers: [{
          arrayStride: 12,
          attributes: [{ shaderLocation: 0, offset: 0, format: 'float32x3' }]
        }]
      },
      fragment: {
        module: exhaustShaderModule,
        entryPoint: 'frag_main',
        targets: [{
          format: 'rgba16float',
          blend: {
            color: { srcFactor: 'one', dstFactor: 'one', operation: 'add' },
            alpha: { srcFactor: 'one', dstFactor: 'one', operation: 'add' }
          }
        }]
      },
      primitive: {
        topology: 'triangle-list',
        frontFace: 'ccw',
        cullMode: cullMode
      },
      depthStencil: {
        format: 'depth24plus',
        depthWriteEnabled: false,
        depthCompare: 'less'
      }
    });

    this.exhaustPipelineFront = this.device.createRenderPipeline(exhaustDesc('front'));
    this.exhaustPipelineBack = this.device.createRenderPipeline(exhaustDesc('back'));

    this.exhaustBindGroup = this.device.createBindGroup({
      label: 'ExhaustBindGroup',
      layout: this.exhaustBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.exhaustUniformBuffer } }
      ]
    });
  }

  createMipmapPipeline() {
    this.mipmapBindGroupLayout = this.device.createBindGroupLayout({
      label: 'MipmapDownsampleBindGroupLayout',
      entries: [
        { binding: 0, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } }
      ]
    });

    const mipmapModule = this.device.createShaderModule({
      label: 'MipmapShader',
      code: MIPMAP_WGSL
    });

    this.mipmapPipeline = this.device.createRenderPipeline({
      label: 'MipmapPipeline',
      layout: this.device.createPipelineLayout({ bindGroupLayouts: [this.mipmapBindGroupLayout] }),
      vertex: { module: mipmapModule, entryPoint: 'vert_main' },
      fragment: {
        module: mipmapModule,
        entryPoint: 'frag_main',
        targets: [{ format: 'rgba16float' }]
      },
      primitive: { topology: 'triangle-strip' }
    });
  }

  createRocketBuffers(vertices, indices) {
    this.rocketVertexBuffer = this.device.createBuffer({
      label: 'RocketVertexBuffer',
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.rocketVertexBuffer, 0, vertices);

    this.rocketIndexBuffer = this.device.createBuffer({
      label: 'RocketIndexBuffer',
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.rocketIndexBuffer, 0, indices);
    this.rocketIndexCount = indices.length;
  }

  createExhaustBuffers() {
    const NUM_CIRCUMFERENCE_SAMPLES = 32;

    const vertices = new Float32Array(6 * (NUM_CIRCUMFERENCE_SAMPLES + 1));
    for (let i = 0; i <= NUM_CIRCUMFERENCE_SAMPLES; ++i) {
      const r = i == 0 ? 0 : EXHAUST_RADIUS;
      const alpha = (2 * Math.PI * i) / NUM_CIRCUMFERENCE_SAMPLES;
      vertices[6 * i] = r * Math.cos(alpha); 
      vertices[6 * i + 1] = r * Math.sin(alpha); 
      vertices[6 * i + 2] = EXHAUST_Z_MIN;
      vertices[6 * i + 3] = r * Math.cos(alpha); 
      vertices[6 * i + 4] = r * Math.sin(alpha); 
      vertices[6 * i + 5] = EXHAUST_Z_MAX;     
    }

    this.exhaustVertexBuffer = this.device.createBuffer({
      label: 'ExhaustVertexBuffer',
      size: vertices.byteLength,
      usage: GPUBufferUsage.VERTEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.exhaustVertexBuffer, 0, vertices);

    const indices = new Uint32Array(12 * NUM_CIRCUMFERENCE_SAMPLES);
    for (let i = 1; i <= NUM_CIRCUMFERENCE_SAMPLES; ++i) {
      const j = (i % NUM_CIRCUMFERENCE_SAMPLES) + 1;
      indices[12 * i - 12] = 0;
      indices[12 * i - 11] = 2 * j;
      indices[12 * i - 10] = 2 * i;
      indices[12 * i - 9] = 2 * i;
      indices[12 * i - 8] = 2 * j;
      indices[12 * i - 7] = 2 * j + 1;
      indices[12 * i - 6] = 2 * j + 1;
      indices[12 * i - 5] = 2 * i + 1;
      indices[12 * i - 4] = 2 * i;
      indices[12 * i - 3] = 1;
      indices[12 * i - 2] = 2 * i + 1;
      indices[12 * i - 1] = 2 * j + 1;
    }

    this.exhaustIndexBuffer = this.device.createBuffer({
      label: 'ExhaustIndexBuffer',
      size: indices.byteLength,
      usage: GPUBufferUsage.INDEX | GPUBufferUsage.COPY_DST
    });
    this.device.queue.writeBuffer(this.exhaustIndexBuffer, 0, indices);
    this.exhaustIndexCount = indices.length;
  }

  getRocketBindGroup() {
    const tm = this.cameraView.textureManager;
    const baseColor = this.baseColorTextureWrapper.texture;
    const metallic = this.occlusionRoughnessMetallicTextureWrapper.texture;
    const normal = this.normalMapTextureWrapper.texture;

    if (this.rocketBindGroup &&
        this.cachedBaseColor === baseColor &&
        this.cachedMetallic === metallic &&
        this.cachedNormal === normal) {
      return this.rocketBindGroup;
    }

    this.cachedBaseColor = baseColor;
    this.cachedMetallic = metallic;
    this.cachedNormal = normal;

    this.rocketBindGroup = this.device.createBindGroup({
      label: 'RocketBindGroup',
      layout: this.rocketBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.rocketUniformBuffer } },
        { binding: 1, resource: tm.linearSampler },
        { binding: 2, resource: baseColor.createView() },
        { binding: 3, resource: metallic.createView() },
        { binding: 4, resource: normal.createView() },
        { binding: 5, resource: this.envMapTexture.createView({ dimension: 'cube' }) }
      ]
    });
    return this.rocketBindGroup;
  }

  getEnvMapBindGroups() {
    const tm = this.cameraView.textureManager;
    const skyTexture = this.model.grid.getValue() ? tm.gridTexture : tm.galaxyTexture;

    if (this.envMapBindGroups && this.cachedEnvMapSkyTexture === skyTexture) {
      return this.envMapBindGroups;
    }

    this.cachedEnvMapSkyTexture = skyTexture;
    this.envMapBindGroups = [];

    for (let face = 0; face < 6; ++face) {
      const bg = this.device.createBindGroup({
        label: `RocketEnvMapBindGroup_Face${face}`,
        layout: this.cameraView.bindGroupLayout,
        entries: [
          { binding: 0, resource: { buffer: this.envMapUniformBuffers[face] } },
          { binding: 1, resource: tm.linearSampler },
          { binding: 2, resource: tm.rayDeflectionTexture.createView() },
          { binding: 3, resource: tm.rayInverseRadiusTexture.createView() },
          { binding: 4, resource: skyTexture.createView({ dimension: 'cube' }) },
          { binding: 5, resource: tm.starTexture.createView({ dimension: 'cube' }) },
          { binding: 6, resource: tm.starTexture2.createView({ dimension: 'cube' }) },
          { binding: 7, resource: tm.blackbodyTexture.createView() },
          { binding: 8, resource: tm.dopplerTexture.createView() },
          { binding: 9, resource: tm.noiseTexture.createView() },
          { binding: 10, resource: tm.nearestSampler }
        ]
      });
      this.envMapBindGroups.push(bg);
    }
    return this.envMapBindGroups;
  }

  updateEnvMapUniforms(faceIndex, eW, eH, eD) {
    const model = this.model;
    const data = new Float32Array(108);

    data[0] = model.t;
    data[1] = model.r;
    data[2] = model.worldTheta;
    data[3] = model.worldPhi;

    data[4] = model.p[0];
    data[5] = model.p[1];
    data[6] = model.p[2];
    data[7] = 0.0;

    data[8] = model.kS[0];
    data[9] = model.kS[1];
    data[10] = model.kS[2];
    data[11] = model.kS[3];

    data[12] = model.rocketTau[1];
    data[13] = model.rocketTau[2];
    data[14] = model.rocketTau[3];
    data[15] = 0.0;

    data[16] = eW[0];
    data[17] = eW[1];
    data[18] = eW[2];
    data[19] = 0.0;

    data[20] = eH[0];
    data[21] = eH[1];
    data[22] = eH[2];
    data[23] = 0.0;

    data[24] = eD[0];
    data[25] = eD[1];
    data[26] = eD[2];
    data[27] = 0.0;

    data[28] = model.starsMatrix[0];
    data[29] = model.starsMatrix[3];
    data[30] = model.starsMatrix[6];
    data[31] = 0.0;

    data[32] = model.starsMatrix[1];
    data[33] = model.starsMatrix[4];
    data[34] = model.starsMatrix[7];
    data[35] = 0.0;

    data[36] = model.starsMatrix[2];
    data[37] = model.starsMatrix[5];
    data[38] = model.starsMatrix[8];
    data[39] = 0.0;

    data[40] = 32.0;
    data[41] = 32.0;
    data[42] = 32.0;
    data[43] = 0.0;

    data[44] = model.discDensity.getValue();
    data[45] = model.discOpacity.getValue();
    data[46] = model.discTemperature.getValue();
    data[47] = 0.0;

    data[48] = model.exposure.getValue();
    data[49] = model.bloom.getValue();

    const minLod = model.grid.getValue() ? 0.0 : this.cameraView.textureManager.getMinLoadedStarTextureLod();
    data[50] = minLod;

    const uintView = new Uint32Array(data.buffer);
    uintView[51] = model.lensing.getValue() ? 1 : 0;
    uintView[52] = model.doppler.getValue() ? 1 : 0;
    uintView[53] = model.grid.getValue() ? 1 : 0;
    uintView[54] = model.stars.getValue() ? 1 : 0;
    uintView[55] = model.highContrast.getValue() ? 1 : 0;

    data[56] = model.fovY;
    data[57] = 0.0;
    data[58] = 0.0;
    data[59] = 0.0;

    data.set(this.cameraView.discParticles, 60);

    this.device.queue.writeBuffer(this.envMapUniformBuffers[faceIndex], 0, data);
  }

  setCameraUniforms(modelViewProjMatrix, cameraPos) {
    const yaw = this.model.cameraYaw.getValue() + this.model.cameraYawOffset -
        this.model.rocketYaw;
    const cameraDist = this.model.rocketDistance.getValue() / 2;
    const offsetDist = 0.4 * cameraDist;
    const tx = -offsetDist * Math.sin(this.model.rocketYaw);
    const tz = offsetDist * Math.cos(this.model.rocketYaw);
    const cy = Math.cos(yaw);
    const sy = Math.sin(yaw);
    const cp = Math.cos(this.model.cameraPitch.getValue());
    const sp = Math.sin(this.model.cameraPitch.getValue());
    const modelViewMatrix = [
      [      cy,  0,      -sy,                    cy * tx      - sy * tz],
      [-sy * sp, cp, -cy * sp,             - sy * sp * tx - cy * sp * tz],
      [ sy * cp, sp,  cy * cp, -cameraDist + sy * cp * tx + cy * cp * tz],
      [       0,  0,        0,                                         1]
    ];

    const f = 1 / Math.tan(this.model.fovY / 2);
    const a = this.cameraView.canvas.width / this.cameraView.canvas.height;
    const b = -(FAR_PLANE + NEAR_PLANE) / (FAR_PLANE - NEAR_PLANE);
    const c = -2 * FAR_PLANE * NEAR_PLANE / (FAR_PLANE - NEAR_PLANE);
    const projMatrix = [
      [f / a, 0,  0, 0],
      [    0, f,  0, 0],
      [    0, 0,  b, c],
      [    0, 0, -1, 0]
    ];

    const mvp = new Float32Array(16);
    for (let i = 0; i < 4; ++i) {
      for (let j = 0; j < 4; ++j) {
        let val = 0;
        for (let k = 0; k < 4; ++k) {
          val += projMatrix[i][k] * modelViewMatrix[k][j];
        }
        mvp[j * 4 + i] = val;
      }
    }
    modelViewProjMatrix.set(mvp);

    const camera = [0, 0, 0];
    for (let i = 0; i < 3; ++i) {
      for (let j = 0; j < 3; ++j) {
        camera[i] -= modelViewMatrix[j][i] * modelViewMatrix[j][3];
      }
    }
    cameraPos[0] = camera[0];
    cameraPos[1] = camera[1];
    cameraPos[2] = camera[2];
  }

  renderEnvMap(commandEncoder) {
    const model = this.model;
    const envMapBindGroups = this.getEnvMapBindGroups();
    if (!envMapBindGroups) return;

    // Calculate directions for the 6 faces (matching WebGL)
    const faces = [
      // POSITIVE_X: eW = -rocketD, eH = -rocketH, eD = -rocketW
      {
        eW: [-model.rocketD[1], -model.rocketD[2], -model.rocketD[3]],
        eH: [-model.rocketH[1], -model.rocketH[2], -model.rocketH[3]],
        eD: [-model.rocketW[1], -model.rocketW[2], -model.rocketW[3]]
      },
      // NEGATIVE_X: eW = rocketD, eH = -rocketH, eD = rocketW
      {
        eW: [model.rocketD[1], model.rocketD[2], model.rocketD[3]],
        eH: [-model.rocketH[1], -model.rocketH[2], -model.rocketH[3]],
        eD: [model.rocketW[1], model.rocketW[2], model.rocketW[3]]
      },
      // POSITIVE_Y: eW = rocketW, eH = rocketD, eD = -rocketH
      {
        eW: [model.rocketW[1], model.rocketW[2], model.rocketW[3]],
        eH: [model.rocketD[1], model.rocketD[2], model.rocketD[3]],
        eD: [-model.rocketH[1], -model.rocketH[2], -model.rocketH[3]]
      },
      // NEGATIVE_Y: eW = rocketW, eH = -rocketD, eD = rocketH
      {
        eW: [model.rocketW[1], model.rocketW[2], model.rocketW[3]],
        eH: [-model.rocketD[1], -model.rocketD[2], -model.rocketD[3]],
        eD: [model.rocketH[1], model.rocketH[2], model.rocketH[3]]
      },
      // POSITIVE_Z: eW = rocketW, eH = -rocketH, eD = -rocketD
      {
        eW: [model.rocketW[1], model.rocketW[2], model.rocketW[3]],
        eH: [-model.rocketH[1], -model.rocketH[2], -model.rocketH[3]],
        eD: [-model.rocketD[1], -model.rocketD[2], -model.rocketD[3]]
      },
      // NEGATIVE_Z: eW = -rocketW, eH = -rocketH, eD = rocketD
      {
        eW: [-model.rocketW[1], -model.rocketW[2], -model.rocketW[3]],
        eH: [-model.rocketH[1], -model.rocketH[2], -model.rocketH[3]],
        eD: [model.rocketD[1], model.rocketD[2], model.rocketD[3]]
      }
    ];

    // Render the black hole scene into the 6 faces at mipLevel 0
    for (let face = 0; face < 6; ++face) {
      this.updateEnvMapUniforms(face, faces[face].eW, faces[face].eH, faces[face].eD);

      const passEncoder = commandEncoder.beginRenderPass({
        label: `RocketEnvMapPass_Face${face}`,
        colorAttachments: [{
          view: this.envMapTexture.createView({
            dimension: '2d',
            baseMipLevel: 0,
            mipLevelCount: 1,
            baseArrayLayer: face,
            arrayLayerCount: 1
          }),
          loadOp: 'clear',
          clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
          storeOp: 'store'
        }]
      });
      passEncoder.setPipeline(this.cameraView.pipeline);
      passEncoder.setBindGroup(0, envMapBindGroups[face]);
      passEncoder.setViewport(0, 0, ENV_MAP_SIZE, ENV_MAP_SIZE, 0, 1);
      passEncoder.draw(4, 1, 0, 0);
      passEncoder.end();
    }

    // Generate mipmaps procedurally for the cubemap
    for (let level = 1; level < ENV_MAP_LEVELS; ++level) {
      const size = ENV_MAP_SIZE >> level;
      for (let face = 0; face < 6; ++face) {
        const bg = this.device.createBindGroup({
          layout: this.mipmapBindGroupLayout,
          entries: [
            {
              binding: 0,
              resource: this.envMapTexture.createView({
                dimension: '2d',
                baseMipLevel: level - 1,
                mipLevelCount: 1,
                baseArrayLayer: face,
                arrayLayerCount: 1
              })
            },
            { binding: 1, resource: this.cameraView.textureManager.linearSampler }
          ]
        });

        const passEncoder = commandEncoder.beginRenderPass({
          label: `RocketEnvMapMipmapPass_Level${level}_Face${face}`,
          colorAttachments: [{
            view: this.envMapTexture.createView({
              dimension: '2d',
              baseMipLevel: level,
              mipLevelCount: 1,
              baseArrayLayer: face,
              arrayLayerCount: 1
            }),
            loadOp: 'clear',
            clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
            storeOp: 'store'
          }]
        });
        passEncoder.setPipeline(this.mipmapPipeline);
        passEncoder.setBindGroup(0, bg);
        passEncoder.setViewport(0, 0, size, size, 0, 1);
        passEncoder.draw(4, 1, 0, 0);
        passEncoder.end();
      }
    }
  }

  drawRocket(passEncoder) {
    if (!this.rocketVertexBuffer || this.rocketIndexCount === 0) return;
    const bindGroup = this.getRocketBindGroup();
    if (!bindGroup) return;

    // Update uniform buffer
    const data = new Float32Array(20);
    this.setCameraUniforms(data.subarray(0, 16), data.subarray(16, 19));
    this.device.queue.writeBuffer(this.rocketUniformBuffer, 0, data);

    // Draw mesh
    passEncoder.setPipeline(this.rocketPipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setVertexBuffer(0, this.rocketVertexBuffer);
    passEncoder.setIndexBuffer(this.rocketIndexBuffer, 'uint32');
    passEncoder.drawIndexed(this.rocketIndexCount, 1, 0, 0, 0);
  }

  drawExhaust(passEncoder, tauSeconds, gForce) {
    if (!this.exhaustVertexBuffer || this.exhaustIndexCount === 0) return;

    // Calculate dynamic parameters matching WebGL
    const intensityVal = 0.1 * Math.pow(gForce, 0.75);
    const intensity = [46 / 255 * intensityVal, 176 / 255 * intensityVal, intensityVal];

    const time = tauSeconds * 100.0;
    const kR1 = 6.75 + 0.5 * Math.cos(time);
    const kR2 = 5.75 + 0.5 * Math.cos((time + 1) / Math.sqrt(2));
    const kR3 = 4.75 + 0.5 * Math.cos((time + 2) / Math.sqrt(3));
    const R2 = EXHAUST_RADIUS * EXHAUST_RADIUS;
    const kR = [kR1 / R2, kR2 / R2, kR3 / R2];

    const kZ1 = 27.0 + 2.0 * Math.cos((time + 1) / Math.sqrt(2));
    const kZ2 = 23.0 + 2.0 * Math.cos((time + 2) / Math.sqrt(3));
    const kZ3 = 19.0 + 2.0 * Math.cos(time);
    const DZ = EXHAUST_Z_MAX - EXHAUST_Z_MIN;
    const kZ = [kZ1 / DZ, kZ2 / DZ, kZ3 / DZ];

    // Update uniform buffer
    const data = new Float32Array(32);
    this.setCameraUniforms(data.subarray(0, 16), data.subarray(16, 19));
    data[20] = intensity[0];
    data[21] = intensity[1];
    data[22] = intensity[2];
    data[24] = kR[0];
    data[25] = kR[1];
    data[26] = kR[2];
    data[28] = kZ[0];
    data[29] = kZ[1];
    data[30] = kZ[2];
    this.device.queue.writeBuffer(this.exhaustUniformBuffer, 0, data);

    // Draw plume
    passEncoder.setBindGroup(0, this.exhaustBindGroup);
    passEncoder.setVertexBuffer(0, this.exhaustVertexBuffer);
    passEncoder.setIndexBuffer(this.exhaustIndexBuffer, 'uint32');

    // Draw back faces
    passEncoder.setPipeline(this.exhaustPipelineBack);
    passEncoder.drawIndexed(this.exhaustIndexCount, 1, 0, 0, 0);

    // Draw front faces
    passEncoder.setPipeline(this.exhaustPipelineFront);
    passEncoder.drawIndexed(this.exhaustIndexCount, 1, 0, 0, 0);
  }
}

BlackHoleShaderDemoApp.RocketManager = RocketManager;
})();
