/**
 * @file shader_manager.ts
 * @brief Manages WebGL shader program compilation, macro options injection, and procedural accretion disk ring parameters.
 *
 * Physics & Mathematics:
 *
 * Relativistic Precession in Schwarzschild Geometry:
 * - Orbiting dust particles in the accretion disk follow geodesics. In general relativity, orbits around a
 *   black hole are not closed ellipses (like in Newtonian gravity); they exhibit relativistic precession (similar to Mercury's perihelion shift, but much stronger).
 * - The orbit path in terms of inverse radius coordinate u(\theta) satisfies:
 *     d\theta/du = 1 / \sqrt{2u^3 - u^2 + (M/L^2)u - (E^2-1)/2L^2}
 * - For bound eccentric orbits oscillating between minimum radius r_1 (maximum inverse radius u_2 = 1/r_1)
 *   and maximum radius r_2 (minimum inverse radius u_1 = 1/r_2), the equation of motion is written as:
 *     (du/d\theta)^2 = (u - u_1) * (u_2 - u) * (u_3 - u)
 *   where:
 *     - u_1, u_2 are the turning points (roots of the radial velocity equation).
 *     - u_3 = 1 - u_1 - u_2 is the third root of the cubic geodesic polynomial.
 * - The precession angle (change in angular coordinate \theta per radial oscillation cycle) is given by:
 *     \Delta\theta = 2 \int_{u_1}^{u_2} \frac{du}{\sqrt{(u - u_1)(u_2 - u)(u_3 - u)}}
 *   By making the substitution y^2 = (u - u_1)/(u_2 - u_1), this integral is converted to the complete elliptic integral
 *   of the first kind K(k^2):
 *     \Delta\theta = \frac{4}{\sqrt{u_3 - u_1}} \int_0^1 \frac{dy}{\sqrt{(1 - y^2)(1 - k^2 y^2)}} = \frac{4 K(k^2)}{\sqrt{u_3 - u_1}}
 *   where the elliptic modulus squared is:
 *     k^2 = (u_2 - u_1) / (u_3 - u_1)
 * - The orbital precession ratio (frequency ratio of radial to angular motion) is:
 *     d\theta / d\phi = \frac{\pi}{\Delta\theta} = \frac{\pi \sqrt{u_3 - u_1}}{4 K(k^2)}
 * - In `computeDthetaDphi`, we solve the elliptic integral K(k^2) numerically using the midpoint rule with N = 100,000 steps.
 *
 * Procedural Disk Rings Generation:
 * - Accretion disk dust is generated as concentric rings from r_min = 3.0 (the ISCO boundary) to r_max = 12.0.
 * - Each ring is given a slight eccentricity e \in [0, 0.1] and random initial phase \phi_0.
 * - The computed parameters (u_1, u_2, \phi_0, d\theta/d\phi) are formatted and injected as a constant array
 *   `DISC_PARTICLE_PARAMS` directly into the GLSL fragment shader source before compilation.
 */

import { Model } from '../../common/model';
import { TextureManager } from './texture_manager';

const MAX_STAR_TEXTURE_LOD = 6;

/**
 * @brief Generates procedural accretion disk particle configurations.
 * @details Computes orbital parameters and relativistic precession rates for individual rings,
 *          returning them as a stringified GLSL array block.
 */
const generateDiscParticleParams = function(): string {
  const rMin = 3.0; // Inner disk boundary (ISCO)
  const rMax = 12.0; // Outer disk boundary
  
  /**
   * @brief Numerically computes the complete elliptic integral of the first kind K(k^2).
   * @param u1 Root 1 (minimum inverse radius).
   * @param u2 Root 2 (maximum inverse radius).
   * @param u3 Root 3 of cubic geodesic polynomial.
   * @return Relativistic precession ratio dtheta/dphi.
   */
  const computeDthetaDphi = function(u1: number, u2: number, u3: number): number {
    const k2 = (u2 - u1) / (u3 - u1); // Modulus k^2 of the elliptic integral
    const N = 100000;
    let K = 0.0;
    
    // Midpoint Riemann sum calculation of K(k^2) = \int_0^1 1 / \sqrt{(1-y^2)(1-k^2 y^2)} dy
    for (let i = 0; i < N; ++i) {
      const dy = 1.0 / N;
      const y = (i + 0.5) / N;
      K += dy / Math.sqrt((1 - y * y) * (1 - k2 * y * y));
    }
    
    // Precession ratio: d\theta/d\phi = \pi \sqrt{u_3 - u_1} / 4K
    return Math.PI * Math.sqrt(u3 - u1) / (4 * K);
  };

  let ringParams = '';
  let numRings = 0;
  for (let r1 = rMin; r1 < rMax; r1 += 0.75) {
    const e = 0.1 * Math.random(); // Orbital eccentricity
    const r2 = r1 * (1.0 + e) / (1.0 - e);
    const u1 = 1 / r2;
    const u2 = 1 / r1;
    const u3 = 1 - u1 - u2; // Third root in normalized general relativity coordinates
    const phi0 = 2 * Math.PI * Math.random(); // Random orbital starting phase
    const dThetaDphi = computeDthetaDphi(u1, u2, u3);

    const x = u1.toPrecision(3);
    const y = u2.toPrecision(3);
    const z = phi0.toPrecision(3);
    const w = dThetaDphi.toPrecision(3);
    ringParams += `${numRings == 0 ? '' : ',\n'}vec4(${x}, ${y}, ${z}, ${w})`;
    numRings += 1;
  }

  // Format array definition string to inject into GLSL source
  return `
      const float INNER_DISC_R = ${rMin.toPrecision(3)};
      const float OUTER_DISC_R = ${rMax.toPrecision(3)};
      const int NUM_DISC_PARTICLES = ${numRings};
      const vec4 DISC_PARTICLE_PARAMS[${numRings}] = vec4[${numRings}] (
        ${ringParams}
      );`;
};

/**
 * @brief Helper utility to compile a shader and log detailed compilation errors.
 */
const createShader = function(gl: WebGL2RenderingContext, type: number, source: string): WebGLShader {
  const shader = gl.createShader(type);
  if (!shader) throw new Error("Could not create WebGL shader");
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  const compiled = gl.getShaderParameter(shader, gl.COMPILE_STATUS);
  if (!compiled) {
    const log = gl.getShaderInfoLog(shader);
    console.error("Shader compilation error:", log);
  }
  return shader;
};

export interface WebGLDemoProgram extends WebGLProgram {
  vertexAttrib?: number;
  cameraSize?: WebGLUniformLocation | null;
  cameraPosition?: WebGLUniformLocation | null;
  p?: WebGLUniformLocation | null;
  kS?: WebGLUniformLocation | null;
  eTau?: WebGLUniformLocation | null;
  eW?: WebGLUniformLocation | null;
  eH?: WebGLUniformLocation | null;
  eD?: WebGLUniformLocation | null;
  rayDeflectionTexture?: WebGLUniformLocation | null;
  rayInverseRadiusTexture?: WebGLUniformLocation | null;
  galaxyCubeTexture?: WebGLUniformLocation | null;
  starCubeTexture?: WebGLUniformLocation | null;
  starCubeTexture2?: WebGLUniformLocation | null;
  starsOrientation?: WebGLUniformLocation | null;
  minStarsLod?: WebGLUniformLocation | null;
  blackBodyTexture?: WebGLUniformLocation | null;
  dopplerTexture?: WebGLUniformLocation | null;
  noiseTexture?: WebGLUniformLocation | null;
  discParams?: WebGLUniformLocation | null;
}

export class ShaderManager {
  private model: Model;
  private textureManager: TextureManager;
  private gl: WebGL2RenderingContext;

  private programs: Record<string, WebGLDemoProgram> = {};
  program: WebGLDemoProgram | null = null;

  constructor(model: Model, textureManager: TextureManager, gl: WebGL2RenderingContext) {
    this.model = model;
    this.textureManager = textureManager;
    this.gl = gl;
    this.programs = {};
    this.program = null;
  }

  /**
   * @brief Dynamically selects or compiles the shader program based on active rendering settings.
   * @details Macro options (LENSING, DOPPLER, GRID, STARS) are prepended to the fragment shader.
   *          This triggers recompilation when features are toggled, preventing branches inside the rendering loop.
   */
  getProgram(): WebGLDemoProgram | null {
    const options =
        `#define LENSING ${this.model.lensing.getValue() ? 1 : 0}
        #define DOPPLER ${this.model.doppler.getValue() ? 1 : 0}
        #define GRID ${this.model.grid.getValue() ? 1 : 0}
        #define STARS ${this.model.stars.getValue() ? 1 : 0}`;
    
    this.program = this.programs[options] || null;
    if (this.program ||
        !this.textureManager.rayDeflectionTexture ||
        !this.textureManager.rayInverseRadiusTexture) {
      return this.program;
    }

    // Build the GLSL header including uniform dimensions and settings macros
    const header = 
        `#version 300 es
        precision highp float;
        #define IN(x) const in x
        #define OUT(x) out x
        ${options}
        const float pi = ${Math.PI};
        const float rad = 1.0;
        const int RAY_DEFLECTION_TEXTURE_WIDTH = 
            ${this.textureManager.rayDeflectionTexture.width};
        const int RAY_DEFLECTION_TEXTURE_HEIGHT =
            ${this.textureManager.rayDeflectionTexture.height};
        const int RAY_INVERSE_RADIUS_TEXTURE_WIDTH = 
            ${this.textureManager.rayInverseRadiusTexture.width};
        const int RAY_INVERSE_RADIUS_TEXTURE_HEIGHT = 
            ${this.textureManager.rayInverseRadiusTexture.height};
        const float STARS_CUBE_MAP_SIZE =
            float(${this.model.grid.getValue() ? 128 : 2048});
        const float MAX_FOOTPRINT_SIZE = float(4);
        const float MAX_FOOTPRINT_LOD =
            float(${this.model.grid.getValue() ? 0 : MAX_STAR_TEXTURE_LOD});\n`;

    const gl = this.gl;
    const vertexShaderEl = document.querySelector("#vertex_shader");
    const blackHoleShaderEl = document.querySelector("#black_hole_shader");
    const fragmentShaderEl = document.querySelector("#fragment_shader");

    if (!vertexShaderEl || !blackHoleShaderEl || !fragmentShaderEl) {
      throw new Error("One or more required shaders are missing from the DOM");
    }

    const vertexShader = createShader(
        gl, 
        gl.VERTEX_SHADER,
        `#version 300 es
        precision highp float;
        ${vertexShaderEl.innerHTML}`);

    // Assemble and compile fragment shader: Injecting header configuration,
    // procedural disk parameters, core library functions, and final composite logic
    const fragmentShader = createShader(
        gl,
        gl.FRAGMENT_SHADER,
        `${header}
        ${generateDiscParticleParams()} 
        ${blackHoleShaderEl.innerHTML}
        ${fragmentShaderEl.innerHTML}`);

    const program = gl.createProgram() as WebGLDemoProgram;
    if (!program) throw new Error("Could not create WebGL program");
    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);

    const linked = gl.getProgramParameter(program, gl.LINK_STATUS);
    if (!linked) {
      const log = gl.getProgramInfoLog(program);
      console.error("Program link error:", log);
    }
    
    // Store attribute and uniform bindings
    program.vertexAttrib = gl.getAttribLocation(program, 'vertex');
    program.cameraSize = gl.getUniformLocation(program, 'camera_size');
    program.cameraPosition = gl.getUniformLocation(program, 'camera_position');
    program.p = gl.getUniformLocation(program, 'p');
    program.kS = gl.getUniformLocation(program, 'k_s');
    program.eTau = gl.getUniformLocation(program, 'e_tau');
    program.eW = gl.getUniformLocation(program, 'e_w');
    program.eH = gl.getUniformLocation(program, 'e_h');
    program.eD = gl.getUniformLocation(program, 'e_d');
    program.rayDeflectionTexture = gl.getUniformLocation(program, 'ray_deflection_texture');
    program.rayInverseRadiusTexture = gl.getUniformLocation(program, 'ray_inverse_radius_texture');
    program.galaxyCubeTexture = gl.getUniformLocation(program, 'galaxy_cube_texture');
    program.starCubeTexture = gl.getUniformLocation(program, 'star_cube_texture');
    program.starCubeTexture2 = gl.getUniformLocation(program, 'star_cube_texture2');
    program.starsOrientation = gl.getUniformLocation(program, 'stars_orientation');
    program.minStarsLod = gl.getUniformLocation(program, 'min_stars_lod');
    program.blackBodyTexture = gl.getUniformLocation(program, 'black_body_texture');
    program.dopplerTexture = gl.getUniformLocation(program, 'doppler_texture');
    program.noiseTexture = gl.getUniformLocation(program, 'noise_texture');
    program.discParams = gl.getUniformLocation(program, 'disc_params');

    this.programs[options] = program;
    this.program = program;
    return program;
  }
}
