import { Model } from '../../common/model';
import { Bloom } from './bloom';
import { TextureManager } from './texture_manager';
import { ShaderManager } from './shader_manager';
import { RocketManager } from './rocket_manager';

/**
 * CameraView coordinates the primary WebGPU frame cycle, managing the canvas context,
 * rendering passes (scene backdrop raymarching, local reflection cube map, rocket model overlay,
 * and HDR bloom post-processing), relativistic orbital calculations, and user mouse drag inputs.
 */
export class CameraView {
  model: Model;
  rootElement: HTMLElement;
  device: GPUDevice;
  devicePixelRatio: number;
  canvas: HTMLCanvasElement;
  errorPanel: HTMLElement;
  errorPanelShown: boolean;

  context: GPUCanvasContext;
  canvasFormat: GPUTextureFormat;
  uniformBuffer: GPUBuffer;
  bindGroupLayout: GPUBindGroupLayout;
  pipelineLayout: GPUPipelineLayout;

  pipeline: GPURenderPipeline | null = null;
  bindGroup: GPUBindGroup | null = null;
  cachedSkyTexture: GPUTexture | null = null;

  textureManager: TextureManager;
  shaderManager: ShaderManager;
  rocketManager: RocketManager;
  bloom: Bloom;

  private lastTauSeconds: number;
  private lastFrameTime: number | undefined = undefined;
  private numFrames = 0;

  private drag = false;
  private previousMouseX: number | undefined = undefined;
  private previousMouseY: number | undefined = undefined;
  private hidden = false;

  // Packed parameters representing accretion disk particle geodesics.
  discParticles: Float32Array;

  constructor(model: Model, rootElement: HTMLElement, device: GPUDevice) {
    this.model = model;
    this.rootElement = rootElement;
    this.device = device;
    this.devicePixelRatio = this.getDevicePixelRatio();

    const canvasEl = rootElement.querySelector('#camera_view');
    const errEl = rootElement.querySelector('#cv_error_panel');
    if (!canvasEl) throw new Error("camera_view canvas not found");
    if (!errEl) throw new Error("cv_error_panel not found");

    this.canvas = canvasEl as HTMLCanvasElement;
    this.canvas.style.width = `${rootElement.clientWidth}px`;
    this.canvas.style.height = `${rootElement.clientHeight}px`;
    this.canvas.width = rootElement.clientWidth * this.devicePixelRatio;
    this.canvas.height = rootElement.clientHeight * this.devicePixelRatio;
    this.errorPanel = errEl as HTMLElement;
    this.errorPanelShown = false;

    // WebGPU Context Setup
    const ctx = this.canvas.getContext('webgpu');
    if (!ctx) throw new Error("Could not get WebGPU context");
    this.context = ctx;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();
    this.context.configure({
      device: this.device,
      format: this.canvasFormat,
      alphaMode: 'opaque'
    });

    // Allocate uniform buffer (432 bytes layout matching shader parameters).
    this.uniformBuffer = this.device.createBuffer({
      size: 432,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    // Create bind group layouts defining bindings (LUTs, samplers, cubemaps, uniforms).
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

    // Initialize sub-managers.
    this.textureManager = new TextureManager(rootElement, this.device);
    this.shaderManager = new ShaderManager(model, this.textureManager, this.device);
    this.rocketManager = new RocketManager(model, this);
    this.bloom = new Bloom(this.device, this.canvasFormat, this.canvas.width, this.canvas.height);

    this.lastTauSeconds = Date.now() / 1000.0;
    this.lastFrameTime = undefined;
    this.numFrames = 0;

    this.drag = false;
    this.previousMouseX = undefined;
    this.previousMouseY = undefined;
    this.hidden = false;

    // Accretion disk particles parameters generation (matching GLSL shader_manager.js).
    // Uses numerical integration of elliptic integrals to compute relativistic orbital phases.
    const rMin = 3.0;
    const rMax = 12.0;
    
    /**
     * Integrates K(k) = integral_0^1 (dy / sqrt((1-y^2)(1 - k^2 * y^2)))
     * to resolve azimuthal orbit progress limits (dTheta/dPhi) under General Relativity.
     */
    const computeDthetaDphi = function(u1: number, u2: number, u3: number): number {
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

    // Pack 12 particles, each with [u1, u2, phi0, dThetaDphi] data.
    this.discParticles = new Float32Array(12 * 4);
    let idx = 0;
    let seed = 42;
    const random = () => {
      let x = Math.sin(seed++) * 10000;
      return x - Math.floor(x);
    };

    for (let r1 = rMin; r1 < rMax; r1 += 0.75) {
      const e = 0.1 * random(); // Eccentricity variation
      const r2 = r1 * (1.0 + e) / (1.0 - e);
      const u1 = 1 / r2;
      const u2 = 1 / r1;
      const u3 = 1 - u1 - u2; // Schwarzschild orbital constraint u1 + u2 + u3 = 1
      const phi0 = 2 * Math.PI * random();
      const dThetaDphi = computeDthetaDphi(u1, u2, u3);

      this.discParticles[idx++] = u1;
      this.discParticles[idx++] = u2;
      this.discParticles[idx++] = phi0;
      this.discParticles[idx++] = dThetaDphi;
    }

    // Window event listeners.
    window.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', () => this.onMouseUp());
    window.addEventListener('resize', () => this.onResize());
    document.addEventListener('visibilitychange', () => {
      this.hidden = document.hidden;
      if (!this.hidden) {
        this.lastFrameTime = undefined;
      }
    });

    // Start render loop.
    requestAnimationFrame(() => this.onRender());
  }

  /** Retrieves or rebuilds the BindGroup mapping WebGPU textures and uniform buffers. */
  getBindGroup(): GPUBindGroup | null {
    const tm = this.textureManager;
    const rayDeflectionTexture = tm.rayDeflectionTexture;
    const rayInverseRadiusTexture = tm.rayInverseRadiusTexture;
    const noiseTexture = tm.noiseTexture;
    const starTexture = tm.starTexture;
    const starTexture2 = tm.starTexture2;
    const blackbodyTexture = tm.blackbodyTexture;
    const dopplerTexture = tm.dopplerTexture;

    if (!rayDeflectionTexture ||
        !rayInverseRadiusTexture ||
        !noiseTexture ||
        !starTexture ||
        !starTexture2 ||
        !blackbodyTexture ||
        !dopplerTexture) {
      return null;
    }

    // Toggle grid environment maps vs stars map.
    const skyTexture = this.model.grid.getValue() ?
        this.textureManager.gridTexture : this.textureManager.galaxyTexture;

    if (!skyTexture) return null;

    if (this.bindGroup && this.cachedSkyTexture === skyTexture) {
      return this.bindGroup;
    }

    this.cachedSkyTexture = skyTexture;
    this.bindGroup = this.device.createBindGroup({
      layout: this.bindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: this.uniformBuffer } },
        { binding: 1, resource: this.textureManager.linearSampler },
        { binding: 2, resource: rayDeflectionTexture.createView() },
        { binding: 3, resource: rayInverseRadiusTexture.createView() },
        { binding: 4, resource: skyTexture.createView({ dimension: 'cube' }) },
        { binding: 5, resource: starTexture.createView({ dimension: 'cube' }) },
        { binding: 6, resource: starTexture2.createView({ dimension: 'cube' }) },
        { binding: 7, resource: blackbodyTexture.createView() },
        { binding: 8, resource: dopplerTexture.createView() },
        { binding: 9, resource: noiseTexture.createView() },
        { binding: 10, resource: this.textureManager.nearestSampler }
      ]
    });
    return this.bindGroup;
  }

  /** Packs Schwarzschild physics constants, matrices, and parameters into the uniform buffer. */
  updateUniforms(): void {
    const model = this.model;
    const data = new Float32Array(108);

    data[0] = model.t; // proper time tau
    data[1] = model.r; // radial coordinate r
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

    // Local basis axes.
    data[12] = model.eTau[1];
    data[13] = model.eTau[2];
    data[14] = model.eTau[3];
    data[15] = 0.0;

    data[16] = model.eW[1];
    data[17] = model.eW[2];
    data[18] = model.eW[3];
    data[19] = 0.0;

    data[20] = model.eH[1];
    data[21] = model.eH[2];
    data[22] = model.eH[3];
    data[23] = 0.0;

    data[24] = model.eD[1];
    data[25] = model.eD[2];
    data[26] = model.eD[3];
    data[27] = 0.0;

    // Starfield coordinate rotation matrix.
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

    // Screen viewport centers and focal length details.
    const tanFovY = Math.tan(model.fovY / 2);
    const focalLength = this.canvas.height / (2 * tanFovY);
    data[40] = this.canvas.width / 2;
    data[41] = this.canvas.height / 2;
    data[42] = focalLength;
    data[43] = 0.0;

    data[44] = model.discDensity.getValue();
    data[45] = model.discOpacity.getValue();
    data[46] = model.discTemperature.getValue();
    data[47] = 0.0;

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

    data[56] = model.fovY;
    data[57] = 0.0;
    data[58] = 0.0;
    data[59] = 0.0;

    // Pack accretion disk particles.
    data.set(this.discParticles, 60);

    this.device.queue.writeBuffer(this.uniformBuffer, 0, data);
  }

  /** Primary frame render loop callback. */
  onRender(): void {
    if (this.hidden) {
      return;
    }

    // Wait until main WGSL shader code is compiled and loaded.
    const shaderModule = this.shaderManager.getProgram();
    if (!shaderModule) {
      requestAnimationFrame(() => this.onRender());
      return;
    }

    // Lazy compile the main backdrop raymarching pipeline.
    if (!this.pipeline) {
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
          targets: [{ format: 'rgba16float' }]
        },
        primitive: {
          topology: 'triangle-strip'
        }
      });
    }

    const bindGroup = this.getBindGroup();
    if (!bindGroup) {
      requestAnimationFrame(() => this.onRender());
      return;
    }

    const tauSeconds = Date.now() / 1000.0;
    const dTauSeconds = (tauSeconds - this.lastTauSeconds);
    this.lastTauSeconds = tauSeconds;

    this.updateUniforms();

    const commandEncoder = this.device.createCommandEncoder();
    const textureView = this.context.getCurrentTexture().createView();
    
    // Render local environment map reflections if rocket model is active.
    if (this.model.rocket.getValue()) {
      this.rocketManager.renderEnvMap(commandEncoder);
    }
    
    // Draw the black hole raymarching backdrop into the first level of the bloom textures.
    const targetView = this.bloom.begin();
    
    const renderPassDescriptor: GPURenderPassDescriptor = {
      colorAttachments: [{
        view: targetView,
        clearValue: { r: 0.0, g: 0.0, b: 0.0, a: 1.0 },
        loadOp: 'clear',
        storeOp: 'store'
      }]
    };

    const passEncoder = commandEncoder.beginRenderPass(renderPassDescriptor);
    passEncoder.setPipeline(this.pipeline);
    passEncoder.setBindGroup(0, bindGroup);
    passEncoder.setViewport(1, 1, this.canvas.width, this.canvas.height, 0, 1);
    passEncoder.draw(4, 1, 0, 0);
    passEncoder.end();

    // Render the rocket and its flame overlay using a depth stencil attachment for proper depth culling.
    if (this.model.rocket.getValue()) {
      const rocketPassDescriptor: GPURenderPassDescriptor = {
        colorAttachments: [{
          view: targetView,
          loadOp: 'load', // overlay on top of raymarching background
          storeOp: 'store'
        }],
        depthStencilAttachment: {
          view: this.bloom.depthTexture!.createView(),
          depthClearValue: 1.0,
          depthLoadOp: 'clear',
          depthStoreOp: 'discard'
        }
      };

      const rocketPass = commandEncoder.beginRenderPass(rocketPassDescriptor);
      rocketPass.setViewport(1, 1, this.canvas.width, this.canvas.height, 0, 1);
      this.rocketManager.drawRocket(rocketPass);
      if (this.model.gForce > 0) {
        this.rocketManager.drawExhaust(rocketPass, tauSeconds, this.model.gForce);
      }
      rocketPass.end();
    }

    // Complete the bloom post-processing chain and render final composited image to canvas view.
    this.bloom.end(
      commandEncoder,
      textureView,
      this.model.bloom.getValue(),
      this.model.exposure.getValue(),
      this.model.highContrast.getValue()
    );

    this.device.queue.submit([commandEncoder.finish()]);

    // Integrate the physical orbit coordinates forward in time.
    this.model.updateOrbit(dTauSeconds);

    requestAnimationFrame(() => this.onRender());
    this.checkFrameRate();
  }

  /**
   * Monitors performance and disables complex star textures if the frame rate drops below 10 FPS
   * to protect browser stability.
   */
  private checkFrameRate(): void {
    const time = Date.now();
    if (!this.lastFrameTime) {
      this.lastFrameTime = time;
      this.numFrames = 0;
    }
    this.numFrames += 1;
    if (time > this.lastFrameTime + 1000) {
      if (this.numFrames <= 10 && this.model.stars.getValue() && 
          !this.errorPanelShown) {
        this.model.stars.setValue(false);
        this.errorPanel.innerHTML = 'Stars have been automatically disabled ' +
            'to improve performance. You can re-enable them from the left ' +
            'hand side panel.';
        this.errorPanel.classList.toggle('cv-hidden', false);
        this.errorPanel.classList.toggle('cv-warning', true);
        this.errorPanelShown = true;
      }
      this.lastFrameTime = time;
      this.numFrames = 0;
    }
  }

  /** Initiates camera angle updates upon standard mouse dragging. */
  private onMouseDown(event: MouseEvent): void {
    this.previousMouseX = event.screenX;
    this.previousMouseY = event.screenY;
    const target = event.target as HTMLElement;
    // Drag camera rotation unless clicking on inputs or holding Ctrl.
    this.drag = (target.tagName != 'INPUT') && !event.ctrlKey;
  }

  /** Rotates view yaw and pitch coordinates while dragging. */
  private onMouseMove(event: MouseEvent): void {
    const mouseX = event.screenX;
    const mouseY = event.screenY;
    if (this.drag) {
      const kScale = 500;
      let yaw = this.model.cameraYaw.getValue();
      let pitch = this.model.cameraPitch.getValue();
      const prevX = this.previousMouseX ?? mouseX;
      const prevY = this.previousMouseY ?? mouseY;
      yaw += (prevX - mouseX) / kScale;
      pitch -= (prevY - mouseY) / kScale;
      // Clamp yaw angular coordinate between 0 and 2*PI.
      this.model.cameraYaw.setValue(
          yaw - 2 * Math.PI * Math.floor(yaw / (2 * Math.PI)));
      this.model.cameraPitch.setValue(pitch);
    }
    this.previousMouseX = mouseX;
    this.previousMouseY = mouseY;
  }

  private onMouseUp(): void {
    this.drag = false;
  }

  /** Resizes all canvas assets and bloom attachments matching new dimensions. */
  private onResize(): void {
    const rootElement = this.rootElement;
    this.devicePixelRatio = this.getDevicePixelRatio();
    this.canvas.style.width = `${rootElement.clientWidth}px`;
    this.canvas.style.height = `${rootElement.clientHeight}px`;
    this.canvas.width = rootElement.clientWidth * this.devicePixelRatio;
    this.canvas.height = rootElement.clientHeight * this.devicePixelRatio;
    this.bloom.resize(this.canvas.width, this.canvas.height);
  }

  private getDevicePixelRatio(): number {
    return this.model.highDefinition.getValue() ? window.devicePixelRatio : 1;
  }
}

