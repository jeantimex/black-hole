/**
 * @file rocket_manager.ts
 * @brief Manages the rocket PBR mesh loading, textures, environment reflections, and volumetric exhaust rendering.
 *
 * Architecture & Mathematics:
 *
 * 1. Environment Map Generation (Reflection Probe):
 *    - To reflect the relativistic black hole scene on the rocket's metallic hull, we render the scene from
 *      the rocket's local origin into a 6-faced environment cubemap (`env_map_texture`) every frame.
 *    - For each face (Positive/Negative X, Y, Z), we map the camera's local frame vectors (e_w, e_h, e_d)
 *      to match the physical coordinate axes of the cubemap target.
 *
 * 2. Model-View-Projection Matrix Derivation:
 *    - The rocket orbits the black hole. The camera circles/follows the rocket based on user yaw/pitch controls.
 *    - We construct the 4x4 Model-View matrix representing the camera orientation and translation relative to the rocket:
 *        R_{cam} = \text{RotationMatrix}(\text{yaw}, \text{pitch})
 *        T_{cam} = \text{TranslationMatrix}(0, 0, -camera\_distance)
 *    - The projection matrix `projMatrix` uses a standard perspective projection mapping:
 *        P = \begin{pmatrix} f/a & 0 & 0 & 0 \\ 0 & f & 0 & 0 \\ 0 & 0 & b & c \\ 0 & 0 & -1 & 0 \end{pmatrix}
 *      where f = 1/\tan(FOV_y/2), a = \text{aspect\_ratio}, and b, c are near/far plane depth-clipping coefficients.
 *    - We multiply the matrices (projMatrix * modelViewMatrix) to get `model_view_proj_matrix` which is sent to the shaders.
 *    - The camera's Cartesian position in object space is extracted from the inverse of the view matrix.
 *
 * 3. Volumetric Exhaust Flame:
 *    - The exhaust is drawn using a bounding cylinder shell of radius `RADIUS` and height `DZ = Z_MAX - Z_MIN`.
 *    - We generate vertices for the cylinder wall and circular caps.
 *    - In `drawExhaust()`, the radial (`kR`) and longitudinal (`kZ`) decay factors of the exponential density profile
 *      are oscillated over time using cosine noise to simulate jet engine nozzle turbulence.
 *    - The exhaust is rendered in two passes with additive blending (`gl.blendFunc(gl.ONE, gl.ONE)`):
 *        Pass 1: Render back-facing polygons (`gl.cullFace(gl.BACK)`).
 *        Pass 2: Render front-facing polygons (`gl.cullFace(gl.FRONT)`).
 *      This accumulates emissions along both entry and exit path segments inside the cylinder bounds.
 */

import { Model } from '../../common/model';

const NEAR_PLANE = 0.1;
const FAR_PLANE = 100.0;

const ENV_MAP_LEVELS = 7;
const ENV_MAP_SIZE = 1 << (ENV_MAP_LEVELS - 1);

const EXHAUST_RADIUS = 0.514;
const EXHAUST_Z_MIN = -20.0;
const EXHAUST_Z_MAX = -2.1;

/**
 * @brief Helper utility to create and compile a WebGL shader.
 */
const createShader = function(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  return shader;
};

/**
 * @brief Loads the binary rocket mesh data consisting of float vertices and integer indices.
 */
const loadRocketMesh = function(rocketDataUrl: string, callback: (vertices: Float32Array, indices: Uint32Array) => void): void {
  const xhr = new XMLHttpRequest();
  xhr.open('GET', rocketDataUrl);
  xhr.responseType = 'arraybuffer';
  xhr.onload = () => {
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

/**
 * @brief Loads a rocket texture map and sets anisotropic filtering properties.
 */
const loadRocketTexture = function(gl: WebGL2RenderingContext, textureUrl: string): WebGLTexture {
  const glExt = gl.getExtension('EXT_texture_filter_anisotropic');
  const texture = gl.createTexture();
  if (!texture) throw new Error("Could not create WebGL texture");
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  if (glExt) {
    gl.texParameterf(gl.TEXTURE_2D, glExt.TEXTURE_MAX_ANISOTROPY_EXT, 
                     gl.getParameter(glExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
  }
  const image = new Image();
  image.addEventListener('load', function() {
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGB, gl.RGB, gl.UNSIGNED_BYTE, image);
    gl.generateMipmap(gl.TEXTURE_2D);
  });
  image.src = textureUrl;
  return texture;
};

interface WebGLRocketProgram extends WebGLProgram {
  positionAttrib?: number;
  normalAttrib?: number;
  tangentAttrib?: number;
  uvAttrib?: number;
  ambientOcclusionAttrib?: number;
  modelViewProjMatrix?: WebGLUniformLocation | null;
  camera?: WebGLUniformLocation | null;
  baseColorTexture?: WebGLUniformLocation | null;
  occlusionRoughnessMetallicTexture?: WebGLUniformLocation | null;
  normalMapTexture?: WebGLUniformLocation | null;
  envMapTexture?: WebGLUniformLocation | null;
  intensity?: WebGLUniformLocation | null;
  kZ?: WebGLUniformLocation | null;
  kR?: WebGLUniformLocation | null;
}

interface WebGLSizedBuffer extends WebGLBuffer {
  size?: number;
}

export class RocketManager {
  private model: Model;
  private gl: WebGL2RenderingContext;

  rocketProgram!: WebGLRocketProgram;
  exhaustProgram!: WebGLRocketProgram;
  envMapTexture!: WebGLTexture;
  envMapFbo!: WebGLFramebuffer;

  private rocketVertexBuffer: WebGLBuffer | null = null;
  private rocketIndexBuffer: WebGLSizedBuffer | null = null;
  private exhaustVertexBuffer: WebGLBuffer | null = null;
  private exhaustIndexBuffer: WebGLSizedBuffer | null = null;

  private baseColorTexture: WebGLTexture;
  private occlusionRoughnessMetallicTexture: WebGLTexture;
  private normalMapTexture: WebGLTexture;

  constructor(model: Model, gl: WebGL2RenderingContext) {
    this.model = model;
    this.gl = gl;

    // Load PBR texture maps
    this.baseColorTexture = loadRocketTexture(gl, 'rocket_base_color.png');
    this.occlusionRoughnessMetallicTexture = loadRocketTexture(gl, 'rocket_occlusion_roughness_metallic.png');
    this.normalMapTexture = loadRocketTexture(gl, 'rocket_normal.png');

    this.createRocketProgram(gl);
    this.createExhaustProgram(gl);
    this.createEnvMap(gl);
    
    // Load binary mesh data asynchronously
    loadRocketMesh('rocket.dat', (vertices, indices) => this.createRocketBuffers(vertices, indices));
    this.createExhaustBuffers(gl);
  }

  /**
   * @brief Allocates texture storage for the environment reflection cube-map.
   */
  private createEnvMap(gl: WebGL2RenderingContext): void {
    const tex = gl.createTexture();
    if (!tex) throw new Error("Could not create WebGL environment cube map");
    this.envMapTexture = tex;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.envMapTexture);
    gl.texStorage2D(gl.TEXTURE_CUBE_MAP, ENV_MAP_LEVELS, gl.RGBA16F, ENV_MAP_SIZE, ENV_MAP_SIZE);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_CUBE_MAP, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    
    const glExt = gl.getExtension('EXT_texture_filter_anisotropic');
    if (glExt) {
      gl.texParameterf(gl.TEXTURE_CUBE_MAP, glExt.TEXTURE_MAX_ANISOTROPY_EXT, 
                       gl.getParameter(glExt.MAX_TEXTURE_MAX_ANISOTROPY_EXT));
    }

    const fbo = gl.createFramebuffer();
    if (!fbo) throw new Error("Could not create WebGL framebuffer");
    this.envMapFbo = fbo;

    gl.bindFramebuffer(gl.FRAMEBUFFER, this.envMapFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_CUBE_MAP_POSITIVE_X, this.envMapTexture, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  /**
   * @brief Creates and compiles the rocket mesh PBR shader program.
   */
  private createRocketProgram(gl: WebGL2RenderingContext): void {
    const vertexShaderEl = document.querySelector("#rocket_vertex_shader");
    const fragmentShaderEl = document.querySelector("#rocket_fragment_shader");
    if (!vertexShaderEl || !fragmentShaderEl) {
      throw new Error("Missing rocket shader script elements");
    }

    const vertexShader = createShader(
        gl, 
        gl.VERTEX_SHADER,
        `#version 300 es
        precision highp float;
        ${vertexShaderEl.innerHTML}`);
    const fragmentShader = createShader(
        gl,
        gl.FRAGMENT_SHADER,
        `#version 300 es
        precision highp float;
        const float ENV_MAP_SIZE = float(${ENV_MAP_SIZE});
        ${fragmentShaderEl.innerHTML}`);

    const program = gl.createProgram() as WebGLRocketProgram;
    if (!program) throw new Error("Could not create WebGL program");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);    

    program.positionAttrib = gl.getAttribLocation(program, 'position_attribute');
    program.normalAttrib = gl.getAttribLocation(program, 'normal_attribute');
    program.tangentAttrib = gl.getAttribLocation(program, 'tangent_attribute');
    program.uvAttrib = gl.getAttribLocation(program, 'uv_attribute');
    program.ambientOcclusionAttrib = gl.getAttribLocation(program, 'ambient_occlusion_attribute');
    program.modelViewProjMatrix = gl.getUniformLocation(program, 'model_view_proj_matrix');
    program.camera = gl.getUniformLocation(program, 'camera');
    program.baseColorTexture = gl.getUniformLocation(program, 'base_color_texture');
    program.occlusionRoughnessMetallicTexture = gl.getUniformLocation(program, 'occlusion_roughness_metallic_texture');
    program.normalMapTexture = gl.getUniformLocation(program, 'normal_map_texture');
    program.envMapTexture = gl.getUniformLocation(program, 'env_map_texture');
    this.rocketProgram = program;
  }

  /**
   * @brief Creates and compiles the volumetric engine exhaust shader program.
   */
  private createExhaustProgram(gl: WebGL2RenderingContext): void {
    const vertexShaderEl = document.querySelector("#exhaust_vertex_shader");
    const fragmentShaderEl = document.querySelector("#exhaust_fragment_shader");
    if (!vertexShaderEl || !fragmentShaderEl) {
      throw new Error("Missing exhaust shader script elements");
    }

    const vertexShader = createShader(
        gl, 
        gl.VERTEX_SHADER,
        `#version 300 es
        precision highp float;
        ${vertexShaderEl.innerHTML}`);
    const fragmentShader = createShader(
        gl,
        gl.FRAGMENT_SHADER,
        `#version 300 es
        precision highp float;
        const float RADIUS = float(${EXHAUST_RADIUS});
        const float Z_MIN = float(${EXHAUST_Z_MIN});
        const float Z_MAX = float(${EXHAUST_Z_MAX});
        ${fragmentShaderEl.innerHTML}`);

    const program = gl.createProgram() as WebGLRocketProgram;
    if (!program) throw new Error("Could not create WebGL program");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);    

    program.positionAttrib = gl.getAttribLocation(program, 'position_attribute');
    program.modelViewProjMatrix = gl.getUniformLocation(program, 'model_view_proj_matrix');
    program.camera = gl.getUniformLocation(program, 'camera');
    program.intensity = gl.getUniformLocation(program, 'intensity');
    program.kZ = gl.getUniformLocation(program, 'k_z');
    program.kR = gl.getUniformLocation(program, 'k_r');
    this.exhaustProgram = program;
  }

  private createRocketBuffers(vertices: Float32Array, indices: Uint32Array): void {
    const gl = this.gl;

    this.rocketVertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.rocketVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    this.rocketIndexBuffer = gl.createBuffer() as WebGLSizedBuffer;
    if (!this.rocketIndexBuffer) throw new Error("Could not create index buffer");
    this.rocketIndexBuffer.size = indices.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.rocketIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);    
  }

  /**
   * @brief Procedurally constructs the vertices and triangles defining the exhaust plume cylinder.
   */
  private createExhaustBuffers(gl: WebGL2RenderingContext): void {
    const NUM_CIRCUMFERENCE_SAMPLES = 32;

    const vertices = new Float32Array(6 * (NUM_CIRCUMFERENCE_SAMPLES + 1));
    for (let i = 0; i <= NUM_CIRCUMFERENCE_SAMPLES; ++i) {
      const r = i == 0 ? 0 : EXHAUST_RADIUS; // First index centers the circular caps (r = 0)
      const alpha = (2 * Math.PI * i) / NUM_CIRCUMFERENCE_SAMPLES;
      
      // Node position at Z_MIN cap:
      vertices[6 * i] = r * Math.cos(alpha); 
      vertices[6 * i + 1] = r * Math.sin(alpha); 
      vertices[6 * i + 2] = EXHAUST_Z_MIN;
      
      // Node position at Z_MAX cap:
      vertices[6 * i + 3] = r * Math.cos(alpha); 
      vertices[6 * i + 4] = r * Math.sin(alpha); 
      vertices[6 * i + 5] = EXHAUST_Z_MAX;     
    }

    this.exhaustVertexBuffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.exhaustVertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, vertices, gl.STATIC_DRAW);

    // Build index list defining triangles for cylinder caps and walls
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
    this.exhaustIndexBuffer = gl.createBuffer() as WebGLSizedBuffer;
    if (!this.exhaustIndexBuffer) throw new Error("Could not create index buffer");
    this.exhaustIndexBuffer.size = indices.length;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.exhaustIndexBuffer);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, indices, gl.STATIC_DRAW);    
  }

  /**
   * @brief Renders the black hole scene into the 6 faces of the reflection cubemap FBO.
   * @details Shifts the camera basis vectors (eW, eH, eD) to capture the surrounding
   *          hemispheres from the rocket's current frame.
   */
  renderEnvMap(program: any, quadVertexBuffer: WebGLBuffer | null): void {
    const gl = this.gl;
    const model = this.model;

    // Cache current canvas viewport and framebuffer settings
    const currentViewport = gl.getParameter(gl.VIEWPORT);
    const currentFbo = gl.getParameter(gl.FRAMEBUFFER_BINDING);
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.envMapFbo);
    gl.viewport(0, 0, ENV_MAP_SIZE, ENV_MAP_SIZE);

    gl.useProgram(program);
    gl.uniform3f(program.cameraSize, 
        ENV_MAP_SIZE / 2, ENV_MAP_SIZE / 2, ENV_MAP_SIZE / 2);
        
    // Rocket's local temporal basis vector (4-velocity) is bound to eTau
    gl.uniform3f(program.eTau,
        model.rocketTau[1], model.rocketTau[2], model.rocketTau[3]);

    gl.bindBuffer(gl.ARRAY_BUFFER, quadVertexBuffer);
    gl.vertexAttribPointer(program.vertexAttrib, 2, gl.FLOAT, false, 0, 0);
    gl.enableVertexAttribArray(program.vertexAttrib);

    // --- Face 1: Positive X ---
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,   
        gl.TEXTURE_CUBE_MAP_POSITIVE_X, this.envMapTexture, 0);
    gl.uniform3f(program.eW,
        -model.rocketD[1], -model.rocketD[2], -model.rocketD[3]);
    gl.uniform3f(program.eH,
        -model.rocketH[1], -model.rocketH[2], -model.rocketH[3]);
    gl.uniform3f(program.eD,
        -model.rocketW[1], -model.rocketW[2], -model.rocketW[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Face 2: Negative X ---
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,   
        gl.TEXTURE_CUBE_MAP_NEGATIVE_X, this.envMapTexture, 0);
    gl.uniform3f(program.eW,
        model.rocketD[1], model.rocketD[2], model.rocketD[3]);
    gl.uniform3f(program.eH,
        -model.rocketH[1], -model.rocketH[2], -model.rocketH[3]);
    gl.uniform3f(program.eD,
        model.rocketW[1], model.rocketW[2], model.rocketW[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Face 3: Positive Y ---
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,   
        gl.TEXTURE_CUBE_MAP_POSITIVE_Y, this.envMapTexture, 0);
    gl.uniform3f(program.eW,
        model.rocketW[1], model.rocketW[2], model.rocketW[3]);
    gl.uniform3f(program.eH,
        model.rocketD[1], model.rocketD[2], model.rocketD[3]);
    gl.uniform3f(program.eD,
        -model.rocketH[1], -model.rocketH[2], -model.rocketH[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Face 4: Negative Y ---
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,   
        gl.TEXTURE_CUBE_MAP_NEGATIVE_Y, this.envMapTexture, 0);
    gl.uniform3f(program.eW,
        model.rocketW[1], model.rocketW[2], model.rocketW[3]);
    gl.uniform3f(program.eH,
        -model.rocketD[1], -model.rocketD[2], -model.rocketD[3]);
    gl.uniform3f(program.eD,
        model.rocketH[1], model.rocketH[2], model.rocketH[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Face 5: Positive Z ---
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,   
        gl.TEXTURE_CUBE_MAP_POSITIVE_Z, this.envMapTexture, 0);
    gl.uniform3f(program.eW,
        model.rocketW[1], model.rocketW[2], model.rocketW[3]);
    gl.uniform3f(program.eH,
        -model.rocketH[1], -model.rocketH[2], -model.rocketH[3]);
    gl.uniform3f(program.eD,
        -model.rocketD[1], -model.rocketD[2], -model.rocketD[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // --- Face 6: Negative Z ---
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0,   
        gl.TEXTURE_CUBE_MAP_NEGATIVE_Z, this.envMapTexture, 0);
    gl.uniform3f(program.eW,
        -model.rocketW[1], -model.rocketW[2], -model.rocketW[3]);
    gl.uniform3f(program.eH,
        -model.rocketH[1], -model.rocketH[2], -model.rocketH[3]);
    gl.uniform3f(program.eD,
        model.rocketD[1], model.rocketD[2], model.rocketD[3]);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);

    // Restore cached viewport state
    gl.disableVertexAttribArray(program.vertexAttrib);
    gl.bindFramebuffer(gl.FRAMEBUFFER, currentFbo);
    gl.viewport(currentViewport[0], currentViewport[1], currentViewport[2], currentViewport[3]);
  }

  /**
   * @brief Draws the rocket PBR mesh.
   */
  drawRocket(): void {
    if (!this.rocketVertexBuffer || !this.rocketIndexBuffer?.size) return;

    const gl = this.gl;
    // Clear depth and configure depth testing for 3D occlusion
    gl.clear(gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    // Bind texture coordinates to appropriate texture registers
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.baseColorTexture);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, this.occlusionRoughnessMetallicTexture);
    gl.activeTexture(gl.TEXTURE2);
    gl.bindTexture(gl.TEXTURE_2D, this.normalMapTexture);
    
    // Bind generated environment reflection map to cube unit 3
    gl.activeTexture(gl.TEXTURE3);
    gl.bindTexture(gl.TEXTURE_CUBE_MAP, this.envMapTexture);
    gl.generateMipmap(gl.TEXTURE_CUBE_MAP); // Re-generate mipmaps for fuzzy specular reflections

    const program = this.rocketProgram;
    gl.useProgram(program);
    if (program.baseColorTexture) gl.uniform1i(program.baseColorTexture, 0);
    if (program.occlusionRoughnessMetallicTexture) gl.uniform1i(program.occlusionRoughnessMetallicTexture, 1);
    if (program.normalMapTexture) gl.uniform1i(program.normalMapTexture, 2);
    if (program.envMapTexture) gl.uniform1i(program.envMapTexture, 3);
    this.setCameraUniforms(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.rocketVertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.rocketIndexBuffer);
    
    // Vertex data layout: (pos:3, normal:3, tangent:4, uv:2, ao:1) -> 13 floats * 4 bytes = 52 stride
    const stride = (3 + 3 + 4 + 1 + 2) * 4;
    
    if (program.positionAttrib !== undefined && program.positionAttrib >= 0) {
      gl.vertexAttribPointer(program.positionAttrib, 3, gl.FLOAT, false, stride, 0);
      gl.enableVertexAttribArray(program.positionAttrib);
    }
    if (program.normalAttrib !== undefined && program.normalAttrib >= 0) {
      gl.vertexAttribPointer(program.normalAttrib, 3, gl.FLOAT, false, stride, 3 * 4);
      gl.enableVertexAttribArray(program.normalAttrib);
    }
    if (program.tangentAttrib !== undefined && program.tangentAttrib >= 0) {
      gl.vertexAttribPointer(program.tangentAttrib, 4, gl.FLOAT, false, stride, 6 * 4);
      gl.enableVertexAttribArray(program.tangentAttrib);
    }
    if (program.uvAttrib !== undefined && program.uvAttrib >= 0) {
      gl.vertexAttribPointer(program.uvAttrib, 2, gl.FLOAT, false, stride, 10 * 4);
      gl.enableVertexAttribArray(program.uvAttrib);
    }
    if (program.ambientOcclusionAttrib !== undefined && program.ambientOcclusionAttrib >= 0) {
      gl.vertexAttribPointer(program.ambientOcclusionAttrib, 1, gl.FLOAT, false, stride, 12 * 4);
      gl.enableVertexAttribArray(program.ambientOcclusionAttrib);
    }

    gl.drawElements(gl.TRIANGLES, this.rocketIndexBuffer.size, gl.UNSIGNED_INT, 0);

    if (program.positionAttrib !== undefined && program.positionAttrib >= 0) gl.disableVertexAttribArray(program.positionAttrib);
    if (program.normalAttrib !== undefined && program.normalAttrib >= 0) gl.disableVertexAttribArray(program.normalAttrib);
    if (program.tangentAttrib !== undefined && program.tangentAttrib >= 0) gl.disableVertexAttribArray(program.tangentAttrib);
    if (program.uvAttrib !== undefined && program.uvAttrib >= 0) gl.disableVertexAttribArray(program.uvAttrib);
    if (program.ambientOcclusionAttrib !== undefined && program.ambientOcclusionAttrib >= 0) gl.disableVertexAttribArray(program.ambientOcclusionAttrib);
    
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);
  }

  /**
   * @brief Renders the engine flame using volume numerical integration.
   * @details Performs double-pass drawing of the cylinder shell boundaries with additive blending
   *          to integrate light emission along both front and back cylinder segments.
   */
  drawExhaust(time: number, gForce: number): void {
    if (!this.rocketVertexBuffer || !this.exhaustIndexBuffer?.size) return;

    const gl = this.gl;
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFunc(gl.ONE, gl.ONE); // Additive blending
    gl.enable(gl.CULL_FACE);

    const program = this.exhaustProgram;
    gl.useProgram(program);

    // Compute jet flame intensity scaled by thrust force
    const intensity = 0.1 * Math.pow(gForce, 0.75);
    if (program.intensity) {
      gl.uniform3f(program.intensity, 
          46 / 255 * intensity, 176 / 255 * intensity, intensity);
    }

    // Oscillate radial and longitudinal decay coefficients to simulate flame turbulence
    time *= 100;
    const kR1 = 6.75 + 0.5 * Math.cos(time);
    const kR2 = 5.75 + 0.5 * Math.cos((time + 1) / Math.sqrt(2));
    const kR3 = 4.75 + 0.5 * Math.cos((time + 2) / Math.sqrt(3));
    const R2 = EXHAUST_RADIUS * EXHAUST_RADIUS;
    if (program.kR) gl.uniform3f(program.kR, kR1 / R2, kR2 / R2, kR3 / R2);

    const kZ1 = 27 + 2 * Math.cos((time + 1) / Math.sqrt(2));
    const kZ2 = 23 + 2 * Math.cos((time + 2) / Math.sqrt(3));
    const kZ3 = 19 + 2 * Math.cos(time);
    const DZ = EXHAUST_Z_MAX - EXHAUST_Z_MIN;
    if (program.kZ) gl.uniform3f(program.kZ, kZ1 / DZ, kZ2 / DZ, kZ3 / DZ);
    
    this.setCameraUniforms(program);

    gl.bindBuffer(gl.ARRAY_BUFFER, this.exhaustVertexBuffer);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.exhaustIndexBuffer);
    if (program.positionAttrib !== undefined && program.positionAttrib >= 0) {
      gl.vertexAttribPointer(program.positionAttrib, 3, gl.FLOAT, false, 0, 0);
      gl.enableVertexAttribArray(program.positionAttrib);
    }

    // Pass 1: Render back faces (calculates emission from mid-point to back edge of cylinder)
    gl.cullFace(gl.BACK);
    gl.drawElements(gl.TRIANGLES, this.exhaustIndexBuffer.size, gl.UNSIGNED_INT, 0);

    // Pass 2: Render front faces (calculates emission from front edge of cylinder to mid-point)
    gl.cullFace(gl.FRONT);
    gl.drawElements(gl.TRIANGLES, this.exhaustIndexBuffer.size, gl.UNSIGNED_INT, 0);

    if (program.positionAttrib !== undefined && program.positionAttrib >= 0) {
      gl.disableVertexAttribArray(program.positionAttrib);
    }
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.BLEND);
    gl.disable(gl.CULL_FACE);
    gl.cullFace(gl.BACK);
  }

  /**
   * @brief Builds and uploads camera rotation, translation and perspective projection matrices.
   */
  private setCameraUniforms(program: WebGLRocketProgram): void {
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
    
    // Construct 4x4 View matrix combining camera rotation and position offsets
    const modelViewMatrix = [
      [      cy,  0,      -sy,                    cy * tx      - sy * tz],
      [-sy * sp, cp, -cy * sp,             - sy * sp * tx - cy * sp * tz],
      [ sy * cp, sp,  cy * cp, -cameraDist + sy * cp * tx + cy * cp * tz],
      [       0,  0,        0,                                         1]
    ];

    // Construct perspective projection matrix
    const f = 1 / Math.tan(this.model.fovY / 2);
    const a = document.body.clientWidth / document.body.clientHeight;
    const b = -(FAR_PLANE + NEAR_PLANE) / (FAR_PLANE - NEAR_PLANE);
    const c = -2 * FAR_PLANE * NEAR_PLANE / (FAR_PLANE - NEAR_PLANE);
    const projMatrix = [
      [f / a, 0,  0, 0],
      [    0, f,  0, 0],
      [    0, 0,  b, c],
      [    0, 0, -1, 0]
    ];

    // Compute Model-View-Projection Matrix: MVP = P * MV
    const modelViewProjMatrix = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
    for (let i = 0; i < 4; ++i) {
      for (let j = 0; j < 4; ++j) {
        for (let k = 0; k < 4; ++k) {
          modelViewProjMatrix[i + 4 * j] += projMatrix[i][k] * modelViewMatrix[k][j];
        }
      }
    }
    
    if (program.modelViewProjMatrix) {
      this.gl.uniformMatrix4fv(program.modelViewProjMatrix, false, modelViewProjMatrix);
    }

    // Extract camera position coordinate in object space from the inverse of the view matrix
    const camera = [0, 0, 0, 1];
    for (let i = 0; i < 3; ++i) {
      for (let j = 0; j < 3; ++j) {
        camera[i] -= modelViewMatrix[j][i] * modelViewMatrix[j][3];
      }
    }
    if (program.camera) {
      this.gl.uniform3f(program.camera, camera[0], camera[1], camera[2]);
    }
  }
}
