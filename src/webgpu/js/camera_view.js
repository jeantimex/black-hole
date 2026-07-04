(function(model, Bloom, TextureManager, ShaderManager, RocketManager) {

class CameraView {
  constructor(model, rootElement, device) {
    this.model = model;
    this.rootElement = rootElement;
    this.device = device;
    this.devicePixelRatio = this.getDevicePixelRatio();
    this.canvas = rootElement.querySelector('#camera_view');
    this.canvas.style.width = `${rootElement.clientWidth}px`;
    this.canvas.style.height = `${rootElement.clientHeight}px`;
    this.canvas.width = rootElement.clientWidth * this.devicePixelRatio;
    this.canvas.height = rootElement.clientHeight * this.devicePixelRatio;
    this.errorPanel = rootElement.querySelector('#cv_error_panel');
    this.errorPanelShown = false;

    // WebGPU Context Setup
    this.context = this.canvas.getContext('webgpu');
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.canvasFormat,
      alphaMode: 'opaque'
    });

    // Uniform buffer (432 bytes size)
    this.uniformBuffer = this.device.createBuffer({
      size: 432,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Bind group layout (matches bind_group entry configuration in shader)
    this.bindGroupLayout = this.device.createBindGroupLayout({
      entries: [
        { binding: 0, visibility: GPUShaderStage.VERTEX | GPUShaderStage.FRAGMENT, buffer: { type: 'uniform' } },
        { binding: 1, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'filtering' } },
        { binding: 2, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 3, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 4, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 5, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 6, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: 'cube' } },
        { binding: 7, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 8, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '3d' } },
        { binding: 9, visibility: GPUShaderStage.FRAGMENT, texture: { sampleType: 'float', viewDimension: '2d' } },
        { binding: 10, visibility: GPUShaderStage.FRAGMENT, sampler: { type: 'non-filtering' } }
      ]
    });

    this.pipelineLayout = this.device.createPipelineLayout({
      bindGroupLayouts: [this.bindGroupLayout]
    });

    this.pipeline = null;
    this.bindGroup = null;
    this.cachedSkyTexture = null;

    this.textureManager = new TextureManager(rootElement, this.device);
    this.shaderManager = new ShaderManager(model, this.textureManager, this.device);
    this.rocketManager = new RocketManager(model, this.device);
    this.bloom = new Bloom(this.device, this.canvas.width, this.canvas.height);

    this.lastTauSeconds = Date.now() / 1000.0;
    this.lastFrameTime = undefined;
    this.numFrames = 0;

    this.drag = false;
    this.previousMouseX = undefined;
    this.previousMouseY = undefined;
    this.hidden = false;

    // Accretion disk particles parameters generation (matching GLSL shader_manager.js)
    const rMin = 3.0;
    const rMax = 12.0;
    const computeDthetaDphi = function(u1, u2, u3) {
      const k2 = (u2 - u1) / (u3 - u1);
      const N = 10000;
      let K = 0.0;
      for (let i = 0; i < N; ++i) {
        const dy = 1.0 / N;
        const y = (i + 0.5) / N;
        K += dy / Math.sqrt((1 - y * y) * (1 - k2 * y * y));
      }
      return Math.PI * Math.sqrt(u3 - u1) / (4 * K);
    };

    this.discParticles = new Float32Array(12 * 4);
    let idx = 0;
    let seed = 42;
    const random = () => {
      let x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    };

    for (let r1 = rMin; r1 < rMax; r1 += 0.75) {
      const e = 0.1 * random();
      const r2 = r1 * (1.0 + e) / (1.0 - e);
      const u1 = 1 / r2;
      const u2 = 1 / r1;
      const u3 = 1 - u1 - u2;
      const phi0 = 2 * Math.PI * random();
      const dThetaDphi = computeDthetaDphi(u1, u2, u3);

      this.discParticles[idx++] = u1;
      this.discParticles[idx++] = u2;
      this.discParticles[idx++] = phi0;
      this.discParticles[idx++] = dThetaDphi;
    }

    window.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', (e) => this.onMouseUp(e));
    window.addEventListener('resize', (e) => this.onResize(e));
    document.addEventListener('visibilitychange', (e) => {
      this.hidden = document.hidden;
      if (!this.hidden) {
        this.lastFrameTime = undefined;
      }
    });

    requestAnimationFrame(() => this.onRender());
  }

  getBindGroup() {
    const tm = this.textureManager;
    if (!tm.rayDeflectionTexture ||
        !tm.rayInverseRadiusTexture ||
        !tm.noiseTexture ||
        !tm.galaxyTexture ||
        !tm.starTexture ||
        !tm.starTexture2 ||
        !tm.blackbodyTexture ||
        !tm.dopplerTexture) {
      if (!this.lastLoggedBindGroupState || Date.now() - this.lastLoggedBindGroupState > 2000) {
        this.lastLoggedBindGroupState = Date.now();
        console.log("BindGroup waiting for textures:", {
          deflection: !!tm.rayDeflectionTexture,
          inverseRadius: !!tm.rayInverseRadiusTexture,
          noise: !!tm.noiseTexture,
          galaxy: !!tm.galaxyTexture,
          star: !!tm.starTexture,
          star2: !!tm.starTexture2,
          blackbody: !!tm.blackbodyTexture,
          doppler: !!tm.dopplerTexture
        });
      }
      return null;
    }

    const skyTexture = this.model.grid.getValue() ?
        this.textureManager.gridTexture : this.textureManager.galaxyTexture;

    if (this.bindGroup && this.cachedSkyTexture === skyTexture) {
      return this.bindGroup;
    }

    this.cachedSkyTexture = skyTexture;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.textureManager.linearSampler },
        { binding: 2, resource: this.textureManager.rayDeflectionTexture.createView() },
        { binding: 3, resource: this.textureManager.rayInverseRadiusTexture.createView() },
        { binding: 4, resource: skyTexture.createView({ dimension: 'cube' }) },
        { binding: 5, resource: this.textureManager.starTexture.createView({ dimension: 'cube' }) },
        { binding: 6, resource: this.textureManager.starTexture2.createView({ dimension: 'cube' }) },
        { binding: 7, resource: this.textureManager.blackbodyTexture.createView() },
        { binding: 8, resource: this.textureManager.dopplerTexture.createView() },
        { binding: 9, resource: this.textureManager.noiseTexture.createView() },
        { binding: 10, resource: this.textureManager.nearestSampler }
      ]
    });
    return this.bindGroup;
  }

  updateUniforms() {
    const model = this.model;
    const data = new Float32Array(108);

    // camera_position: vec4
    data[0] = model.t;
    data[1] = model.r;
    data[2] = model.worldTheta;
    data[3] = model.worldPhi;

    // p: vec3 + padding
    data[4] = model.p[0];
    data[5] = model.p[1];
    data[6] = model.p[2];
    data[7] = 0.0;

    // k_s: vec4
    data[8] = model.kS[0];
    data[9] = model.kS[1];
    data[10] = model.kS[2];
    data[11] = model.kS[3];

    // e_tau: vec3 + padding
    data[12] = model.eTau[1];
    data[13] = model.eTau[2];
    data[14] = model.eTau[3];
    data[15] = 0.0;

    // e_w: vec3 + padding
    data[16] = model.eW[1];
    data[17] = model.eW[2];
    data[18] = model.eW[3];
    data[19] = 0.0;

    // e_h: vec3 + padding
    data[20] = model.eH[1];
    data[21] = model.eH[2];
    data[22] = model.eH[3];
    data[23] = 0.0;

    // e_d: vec3 + padding
    data[24] = model.eD[1];
    data[25] = model.eD[2];
    data[26] = model.eD[3];
    data[27] = 0.0;

    // stars_orientation: mat3x3 columns
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

    // camera_size: vec3 + padding
    const tanFovY = Math.tan(model.fovY / 2);
    const focalLength = this.canvas.height / (2 * tanFovY);
    data[40] = this.canvas.width / 2;
    data[41] = this.canvas.height / 2;
    data[42] = focalLength;
    data[43] = 0.0;

    // disc_params: vec3 + padding
    data[44] = model.discDensity.getValue();
    data[45] = model.discOpacity.getValue();
    data[46] = model.discTemperature.getValue();
    data[47] = 0.0;

    // scalars & flags
    data[48] = model.exposure.getValue();
    data[49] = model.bloom.getValue();

    const minLod = model.grid.getValue() ? 0.0 : this.textureManager.getMinLoadedStarTextureLod();
    data[50] = minLod;

    const uintView = new Uint32Array(data.buffer);
    uintView[51] = model.lensing.getValue() ? 1 : 0;
    uintView[52] = model.doppler.getValue() ? 1 : 0;
    uintView[53] = model.grid.getValue() ? 1 : 0;
    uintView[54] = model.stars.getValue() ? 1 : 0;
    uintView[55] = model.highContrast.getValue() ? 1 : 0;

    // fovY & padding to float 60
    data[56] = model.fovY;
    data[57] = 0.0;
    data[58] = 0.0;
    data[59] = 0.0;

    // disc_particles
    data.set(this.discParticles, 60);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);

    if (!this.firstUniformsLogged) {
      this.firstUniformsLogged = true;
      console.log("CameraView: First uniform values:", Array.from(data.slice(0, 60)));
    }
  }

  onRender() {
    if (this.hidden) {
      return;
    }

    const shaderModule = this.shaderManager.getProgram();
    if (!shaderModule) {
      if (!this.lastLoggedState || Date.now() - this.lastLoggedState > 2000) {
        this.lastLoggedState = Date.now();
        console.log("Waiting for textures/shader... deflection:", 
          !!this.textureManager.rayDeflectionTexture, 
          "inverseRadius:", !!this.textureManager.rayInverseRadiusTexture);
      }
      requestAnimationFrame(() => this.onRender());
      return;
    }

    if (!this.pipeline) {
      console.log("CameraView: Creating WebGPU render pipeline...");
      this.pipeline = this.device.createRenderPipeline({
        label: 'BlackHoleRenderPipeline',
        layout: this.pipelineLayout,
        vertex: {
          module: shaderModule,
          entryPoint: 'vert_main'
        },
        fragment: {
          module: shaderModule,
          entryPoint: 'frag_main',
          targets: [{ format: this.canvasFormat }]
        },
        primitive: {
          topology: 'triangle-strip'
        }
      });
      console.log("CameraView: WebGPU render pipeline created successfully!");
    }

    const bindGroup = this.getBindGroup();
    if (!bindGroup) {
      requestAnimationFrame(() => this.onRender());
      return;
    }

    if (!this.firstFrameRendered) {
      this.firstFrameRendered = true;
      console.log("CameraView: First frame render call starting! Canvas size:", this.canvas.width, "x", this.canvas.height);
    }

    if (this.devicePixelRatio != this.getDevicePixelRatio()) {
      this.onResize();
    }

    const tauSeconds = Date.now() / 1000.0;
    const dTauSeconds = tauSeconds - this.lastTauSeconds;
    this.lastTauSeconds = tauSeconds;

    // Update uniforms
    this.updateUniforms();

    // Begin WebGPU Render Pass
    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();
    
    const renderPassDescriptor = {
      colorAttachments: [{
        view: textureView,
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.draw(4, 1, 0, 0); // draw fullscreen quad (4 vertices)
    passEncoder.end();

    this.device.queue.submit([commandEncoder.finish()]);

    this.model.updateOrbit(dTauSeconds);

    requestAnimationFrame(() => this.onRender());
    this.checkFrameRate();
  }

  checkFrameRate() {
    this.numFrames += 1;
    const time = Date.now();
    if (!this.lastFrameTime) {
      this.lastFrameTime = time;
      this.numFrames = 0;
    }
    if (time > this.lastFrameTime + 1000) {
      if (this.numFrames <= 10 && this.model.stars.getValue() && 
          !this.errorPanelShown) {
        this.model.stars.setValue(false);
        this.errorPanel.innerHTML = 'Stars have been automatically disabled ' +
            'to improve performance. You can re-enable them from the left ' +
            'hand side panel.';
        this.errorPanel.classList.toggle('cv-hidden');
        this.errorPanel.classList.toggle('cv-warning');
        this.errorPanelShown = true;
      }
      this.lastFrameTime = time;
      this.numFrames = 0;
    }
  }

  onMouseDown(event) {
    this.previousMouseX = event.screenX;
    this.previousMouseY = event.screenY;
    this.drag = (event.target.tagName != 'INPUT') && !event.ctrlKey;
  }

  onMouseMove(event) {
    const mouseX = event.screenX;
    const mouseY = event.screenY;
    if (this.drag) {
      const kScale = 500;
      let yaw = this.model.cameraYaw.getValue();
      let pitch = this.model.cameraPitch.getValue();
      yaw += (this.previousMouseX - mouseX) / kScale;
      pitch -= (this.previousMouseY - mouseY) / kScale;
      this.model.cameraYaw.setValue(
          yaw - 2 * Math.PI * Math.floor(yaw / (2 * Math.PI)));
      this.model.cameraPitch.setValue(pitch);
    }
    this.previousMouseX = mouseX;
    this.previousMouseY = mouseY;
  }

  onMouseUp(event) {
    this.drag = false;
  }

  onResize(event) {
    const rootElement = this.rootElement;
    this.devicePixelRatio = this.getDevicePixelRatio();
    this.canvas.style.width = `${rootElement.clientWidth}px`;
    this.canvas.style.height = `${rootElement.clientHeight}px`;
    this.canvas.width = rootElement.clientWidth * this.devicePixelRatio;
    this.canvas.height = rootElement.clientHeight * this.devicePixelRatio;
    this.bloom.resize(this.canvas.width, this.canvas.height);
  }

  getDevicePixelRatio() {
    return this.model.highDefinition.getValue() ? window.devicePixelRatio : 1;
  }
}

window.addEventListener('DOMContentLoaded', async () => {
  if (window.BlackHoleShaderDemoApp.cameraViewInitialized) return;
  window.BlackHoleShaderDemoApp.cameraViewInitialized = true;

  window.addEventListener('error', (event) => {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'JS Error: ' + event.message;
      errorPanel.classList.toggle('cv-hidden', false);
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'Promise Error: ' + event.reason;
      errorPanel.classList.toggle('cv-hidden', false);
    }
  });

  if (!navigator.gpu) {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'WebGPU is not supported in this browser. Please use a WebGPU-enabled browser (like Chrome or Edge).';
      errorPanel.classList.toggle('cv-hidden', false);
    }
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'Failed to request WebGPU adapter.';
      errorPanel.classList.toggle('cv-hidden', false);
    }
    return;
  }

  const requiredFeatures = [];
  if (adapter.features.has('float32-filterable')) {
    requiredFeatures.push('float32-filterable');
  }
  const device = await adapter.requestDevice({ requiredFeatures });
  new CameraView(model, document.body, device);
});

})(BlackHoleShaderDemoApp.model,
    BlackHoleShaderDemoApp.Bloom,
    BlackHoleShaderDemoApp.TextureManager,
    BlackHoleShaderDemoApp.ShaderManager,
    BlackHoleShaderDemoApp.RocketManager);
