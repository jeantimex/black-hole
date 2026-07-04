import { Model } from '../../common/model';
import { Bloom } from './bloom';
import { TextureManager } from './texture_manager';
import { ShaderManager } from './shader_manager';
import { RocketManager } from './rocket_manager';

const createQuadVertexBuffer = function(gl: WebGL2RenderingContext): WebGLBuffer {
  const vertexBuffer = gl.createBuffer();
  if (!vertexBuffer) throw new Error("Could not create quad vertex buffer");
  gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
  gl.bufferData(gl.ARRAY_BUFFER,
       new Float32Array([-1, -1, +1, -1, -1, +1, +1, +1]), gl.STATIC_DRAW);
  return vertexBuffer;
};

export class CameraView {
  private model: Model;
  private rootElement: HTMLElement;
  private devicePixelRatio: number;
  private canvas: HTMLCanvasElement;
  private errorPanel: HTMLElement;
  private errorPanelShown: boolean;

  private gl: WebGL2RenderingContext;
  private vertexBuffer: WebGLBuffer;
  
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

  constructor(model: Model, rootElement: HTMLElement) {
    this.model = model;
    this.rootElement = rootElement;
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

    const glContext = this.canvas.getContext('webgl2');
    if (!glContext) {
      throw new Error("Could not get WebGL2 context");
    }
    this.gl = glContext;

    if (!this.initGl()) {
      throw new Error("Failed to initialize WebGL2 extensions");
    }

    this.vertexBuffer = createQuadVertexBuffer(this.gl);
    this.textureManager = new TextureManager(rootElement, this.gl);
    this.shaderManager = new ShaderManager(model, this.textureManager, this.gl);
    this.rocketManager = new RocketManager(model, this.gl);
    this.bloom = new Bloom(this.gl, this.canvas.width, this.canvas.height);

    this.lastTauSeconds = Date.now() / 1000.0;
    this.lastFrameTime = undefined;
    this.numFrames = 0;

    this.drag = false;
    this.previousMouseX = undefined;
    this.previousMouseY = undefined;
    this.hidden = false;

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

    requestAnimationFrame(() => this.onRender());
  }

  private initGl(): boolean {
    if (!this.gl ||
        !this.gl.getExtension('OES_texture_float_linear') ||
        !this.gl.getExtension('EXT_texture_filter_anisotropic') ||
        !this.gl.getExtension('EXT_color_buffer_float') ||
        !this.gl.getExtension('EXT_float_blend')) {
      this.errorPanel.innerHTML = 'Unfortunately your browser doesn\'t ' + 
          'support WebGL 2 or the WebGL 2 extensions required for this demo.';
      this.errorPanel.classList.toggle('cv-hidden', false);
      return false;
    }
    this.errorPanel.addEventListener('click', () => {
      this.errorPanel.classList.toggle('cv-hidden', true);
    });
    return true;
  }

  private onRender(): void {
    if (this.hidden) {
      return;
    }
    const program = this.shaderManager.getProgram();
    if (!program) {
      requestAnimationFrame(() => this.onRender());
      return;
    }
    if (this.devicePixelRatio != this.getDevicePixelRatio()) {
      this.onResize();      
    }

    const tauSeconds = Date.now() / 1000.0;
    const dTauSeconds = tauSeconds - this.lastTauSeconds;
    this.lastTauSeconds = tauSeconds;

    const tanFovY = Math.tan(this.model.fovY / 2);
    const focalLength = this.canvas.height / (2 * tanFovY);

    const gl = this.gl; 
    
    const rayDeflectionTexture = this.textureManager.rayDeflectionTexture;
    const rayInverseRadiusTexture = this.textureManager.rayInverseRadiusTexture;
    const galaxyTexture = this.textureManager.galaxyTexture;
    const gridTexture = this.textureManager.gridTexture;
    const starTexture = this.textureManager.starTexture;
    const starTexture2 = this.textureManager.starTexture2;
    const blackbodyTexture = this.textureManager.blackbodyTexture;
    const dopplerTexture = this.textureManager.dopplerTexture;
    const noiseTexture = this.textureManager.noiseTexture;

    if (!rayDeflectionTexture || !rayInverseRadiusTexture || !starTexture || !starTexture2 || !blackbodyTexture || !dopplerTexture || !noiseTexture) {
      requestAnimationFrame(() => this.onRender());
      return;
    }

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, rayDeflectionTexture);      

    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, rayInverseRadiusTexture);

    gl.activeTexture(gl.TEXTURE2);
    if (this.model.grid.getValue()) {
      if (gridTexture) gl.bindTexture(gl.TEXTURE_CUBE_MAP, gridTexture);
    } else {
      if (galaxyTexture) gl.bindTexture(gl.TEXTURE_CUBE_MAP, galaxyTexture);
    }
    
    const minLod = this.model.grid.getValue() ? 0 : this.textureManager.getMinLoadedStarTextureLod();
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_LOD, minLod);

    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, starTexture);

    gl.activeTexture(gl.TEXTURE4);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, starTexture2);

    gl.activeTexture(gl.TEXTURE5);
    gl.bindTexture(gl.TEXTURE_2D, blackbodyTexture);

    gl.activeTexture(gl.TEXTURE6);
    gl.bindTexture(gl.TEXTURE_3D, dopplerTexture);

    gl.activeTexture(gl.TEXTURE7);
    gl.bindTexture(gl.TEXTURE_2D, noiseTexture);

    gl.useProgram(program);
    if (program.cameraSize) {
      gl.uniform3f(program.cameraSize, this.canvas.width / 2, this.canvas.height / 2, focalLength);
    }
    if (program.cameraPosition) {
      gl.uniform4f(program.cameraPosition, this.model.t, this.model.r, this.model.worldTheta, this.model.worldPhi);
    }
    if (program.p) {
      gl.uniform3f(program.p, this.model.p[0], this.model.p[1], this.model.p[2]);
    }
    if (program.kS) {
      gl.uniform4f(program.kS, this.model.kS[0], this.model.kS[1], this.model.kS[2], this.model.kS[3]);
    }
    if (program.eTau) {
      gl.uniform3f(program.eTau, this.model.eTau[1], this.model.eTau[2], this.model.eTau[3]);
    }
    if (program.eW) {
      gl.uniform3f(program.eW, this.model.eW[1], this.model.eW[2], this.model.eW[3]);
    }
    if (program.eH) {
      gl.uniform3f(program.eH, this.model.eH[1], this.model.eH[2], this.model.eH[3]);
    }
    if (program.eD) {
      gl.uniform3f(program.eD, this.model.eD[1], this.model.eD[2], this.model.eD[3]);
    }
    if (program.rayDeflectionTexture) gl.uniform1i(program.rayDeflectionTexture, 0);
    if (program.rayInverseRadiusTexture) gl.uniform1i(program.rayInverseRadiusTexture, 1); 
    if (program.galaxyCubeTexture) gl.uniform1i(program.galaxyCubeTexture, 2);
    if (program.starCubeTexture) gl.uniform1i(program.starCubeTexture, 3);
    if (program.starCubeTexture2) gl.uniform1i(program.starCubeTexture2, 4);
    
    if (program.starsOrientation) {
      gl.uniformMatrix3fv(program.starsOrientation, false, this.model.starsMatrix);
    }
    if (program.minStarsLod) gl.uniform1f(program.minStarsLod, minLod);
    if (program.blackBodyTexture) gl.uniform1i(program.blackBodyTexture, 5);
    if (program.dopplerTexture) gl.uniform1i(program.dopplerTexture, 6);
    if (program.noiseTexture) gl.uniform1i(program.noiseTexture, 7);
    
    if (program.discParams) {
      gl.uniform3f(program.discParams, 
          this.model.discDensity.getValue(),
          this.model.discOpacity.getValue(), 
          this.model.discTemperature.getValue());
    }

    this.bloom.begin();

    gl.bindBuffer(gl.ARRAY_BUFFER, this.vertexBuffer);
    if (program.vertexAttrib !== undefined && program.vertexAttrib >= 0) {
      gl.vertexAttribPointer(program.vertexAttrib, 2, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(program.vertexAttrib);
    }
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    if (program.vertexAttrib !== undefined && program.vertexAttrib >= 0) {
      gl.disableVertexAttribArray(program.vertexAttrib);
    }

    if (this.model.rocket.getValue()) {
      this.rocketManager.renderEnvMap(program, this.vertexBuffer);
      this.rocketManager.drawRocket();
      if (this.model.gForce > 0) {
        this.rocketManager.drawExhaust(tauSeconds, this.model.gForce);
      }
    }

    this.bloom.end(this.model.bloom.getValue(), this.model.exposure.getValue(),
        this.model.highContrast.getValue());

    this.model.updateOrbit(dTauSeconds);

    requestAnimationFrame(() => this.onRender());
    this.checkFrameRate();
  }

  private checkFrameRate(): void {
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
        this.errorPanel.classList.toggle('cv-hidden', false);
        this.errorPanel.classList.toggle('cv-warning', true);
        this.errorPanelShown = true;
      }
      this.lastFrameTime = time;
      this.numFrames = 0;
    }
  }

  private onMouseDown(event: MouseEvent): void {
    this.previousMouseX = event.screenX;
    this.previousMouseY = event.screenY;
    const target = event.target as HTMLElement;
    this.drag = (target.tagName != 'INPUT') && !event.ctrlKey;
  }

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
