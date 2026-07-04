var V=Object.defineProperty;var O=(h,e,t)=>e in h?V(h,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):h[e]=t;var o=(h,e,t)=>O(h,typeof e!="symbol"?e+"":e,t);import{a as q,M as z,U as H,S as W}from"./settings_panel-i3tiS7Ws.js";const Y=`// WGSL translation of the Black Hole Ray Tracing shader
//
// =====================================================================================
// PHYSICS & MATHEMATICS BACKGROUND OF THE BLACK HOLE RAYTRACER
// =====================================================================================
//
// 1. SCHWARZSCHILD GEOMETRY & COORDINATES
// -------------------------------------------------------------------------------------
// This shader simulates the ray tracing of light in the vicinity of a static, uncharged
// spherically symmetric black hole of mass M, described by the Schwarzschild metric:
//
//   ds² = -(1 - r_s / r) c² dt² + (1 - r_s / r)⁻¹ dr² + r² (dθ² + sin²θ dφ²)
//
// where:
//   - r_s = 2GM/c² is the Schwarzschild radius (normalized to 1.0 in this shader).
//   - (t, r, θ, φ) are Schwarzschild coordinates.
//
// 2. PHOTON GEODESIC EQUATIONS (LIGHT PROPAGATION)
// -------------------------------------------------------------------------------------
// Light travels along null geodesics (ds² = 0). Using the Euler-Lagrange equations, we
// find two constants of motion due to time-translation symmetry and rotational symmetry:
//   - Relativistic Energy:          E = (1 - r_s / r) dt/dλ
//   - Relativistic Angular Momentum: L = r² dφ/dλ (assuming equatorial plane θ = π/2)
//
// Defining the dimensionless inverse radius u = r_s / r, the geodesic equation is:
//
//   (du/dφ)² + u²(1 - u) = (r_s / b)² ≡ e²
//
// where:
//   - b = L/E is the impact parameter (perpendicular distance of the light ray to BH at infinity).
//   - e² is the inverse squared impact parameter (normalized by r_s²).
//
// 3. PHOTON CAPTURE & CRITICAL ORBIT
// -------------------------------------------------------------------------------------
// The effective potential has a maximum at r_crit = 1.5 * r_s = 3M (the photon sphere).
// The critical impact parameter for photon capture is:
//
//   b_crit = 3√3 / 2 * r_s ≈ 2.598 * r_s  =>  e²_crit = 4/27 ≈ 0.148148 (kMu in code)
//
//   - If e² > 4/27 (b < b_crit): The light ray crosses the photon sphere and falls
//     into the event horizon (u -> 1).
//   - If e² < 4/27 (b > b_crit): The light ray reaches a point of closest approach
//     (periapsis, where du/dφ = 0) and escapes back to infinity.
//
// 4. PRECOMPUTED LOOKUP FIELDS (O(1) RUNTIME INTERPOLATION)
// -------------------------------------------------------------------------------------
// Integrating the geodesic equation du/dφ at runtime for every pixel is too expensive.
// Instead, we precompute the integrals and store them in two lookup textures:
//   - ray_deflection_texture: Maps (e², u) to the total deflection angle Δφ.
//   - ray_inverse_radius_texture: Maps (e², φ) to the current inverse radius u.
//
// This shader decodes these coordinates, samples the textures, and reconstructs
// the warped geodesics instantaneously.
//
// 5. RELATIVISTIC DOPPLER EFFECT & GRAVITATIONAL REDSHIFT
// -------------------------------------------------------------------------------------
// The frequency ratio g = ν_observed / ν_emitted is given by the general relativistic
// projection of the photon's four-momentum p_μ onto the observer's and emitter's four-velocities:
//
//   g = (p_μ U^μ)_receiver / (p_μ U^μ)_emitter
//
//   - Gravitational Redshift: Relates to the metric coefficient √(-g_tt) = √(1 - r_s/r).
//   - Kinematic Doppler Shift: Relates to the relative velocity of the accretion disk gas
//     moving at circular Keplerian speed v = 1 / √(2r - 3) in the static frame.
//   - Relativistic Beaming (Aberration): Concentrates light in the direction of motion.
//
// 6. ACCRETION DISK TEMPERATURE PROFILE (SHAKURA-SUNYAEV / NOVIKOV-THORNE)
// -------------------------------------------------------------------------------------
// The accretion disk temperature profile for a thin disk in general relativity is:
//
//   T(r) ∝ r⁻³/⁴ (1 - √(3/r))¹/⁴
//
// where r = 3 (or 6M in physical units) is the Innermost Stable Circular Orbit (ISCO).
// Gas inside the ISCO falls rapidly into the black hole and emits negligible radiation.
//
// =====================================================================================

struct Uniforms {
  camera_position: vec4<f32>,   // Observer's coordinate state: (t, r, world_theta, world_phi)
  p: vec3<f32>,                 // Relativistic momentum vector of the observer (3-momentum)
  k_s: vec4<f32>,               // Four-velocity coefficients / constants of motion of observer
  e_tau: vec3<f32>,             // Local observer tetrad axis: time-like direction
  e_w: vec3<f32>,               // Local observer tetrad axis: radial/yaw direction
  e_h: vec3<f32>,               // Local observer tetrad axis: pitch direction
  e_d: vec3<f32>,               // Local observer tetrad axis: roll/forward direction
  stars_orientation0: vec4<f32>, // Columns of rotation matrix for stars background orientation
  stars_orientation1: vec4<f32>,
  stars_orientation2: vec4<f32>,
  camera_size: vec3<f32>,       // Width, Height, Focal Length of the viewport
  disc_params: vec3<f32>,       // Accretion disk settings: (density, opacity, temperature)
  _pad: f32,
  exposure: f32,                // Camera exposure multiplier
  bloom: f32,                   // Bloom intensity factor
  min_stars_lod: f32,           // Minimum level-of-detail for stars mapping
  lensing: u32,                 // Toggle boolean for Gravitational Lensing (0 or 1)
  doppler: u32,                 // Toggle boolean for Relativistic Doppler effect (0 or 1)
  grid: u32,                    // Toggle boolean for coordinate Grid rendering (0 or 1)
  stars: u32,                   // Toggle boolean for background Stars rendering (0 or 1)
  high_contrast: u32,           // Toggle boolean for ACES Film tone mapping (0 or 1)
  fovY: f32,                    // Field of view in Y direction
  projection_mode: u32,         // 0 = perspective, 1 = NASA 360 fish-eye
  _pad2: vec2<f32>,
  disc_particles: array<vec4<f32>, 12>, // Accretion disk density perturbation orbits
};

@group(0) @binding(0) var<uniform> u_uniforms: Uniforms;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var ray_deflection_texture: texture_2d<f32>;
@group(0) @binding(3) var ray_inverse_radius_texture: texture_2d<f32>;
@group(0) @binding(4) var galaxy_cube_texture: texture_cube<f32>;
@group(0) @binding(5) var star_cube_texture: texture_cube<f32>;
@group(0) @binding(6) var star_cube_texture2: texture_cube<f32>;
@group(0) @binding(7) var black_body_texture: texture_2d<f32>;
@group(0) @binding(8) var doppler_texture: texture_3d<f32>;
@group(0) @binding(9) var noise_texture: texture_2d<f32>;
@group(0) @binding(10) var nearest_sampler: sampler;

const pi: f32 = 3.14159265359;
const rad: f32 = 1.0;
const kMu: f32 = 0.14814814814; // Critical orbit parameter e² = 4/27

const RAY_DEFLECTION_TEXTURE_WIDTH = 512;
const RAY_DEFLECTION_TEXTURE_HEIGHT = 512;
const RAY_INVERSE_RADIUS_TEXTURE_WIDTH = 64;
const RAY_INVERSE_RADIUS_TEXTURE_HEIGHT = 32;

const INNER_DISC_R = 3.0;  // Innermost stable circular orbit (ISCO) boundary (3 * r_s)
const OUTER_DISC_R = 12.0; // Outer physical boundary of the accretion disk
const NUM_DISC_PARTICLES = 12;

struct VertexOutput {
  @builtin(position) Position: vec4<f32>,
  @location(0) screen_pos: vec2<f32>,
};

// Generates screen-aligned quad vertices and sets the initial position of rays.
@vertex
fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  var pos = vec2<f32>(
    f32((VertexIndex << 1u) & 2u) - 1.0,
    f32(VertexIndex & 2u) - 1.0
  );
  out.Position = vec4<f32>(pos, 0.0, 1.0);
  out.screen_pos = pos;
  return out;
}

fn modulo(x: f32, y: f32) -> f32 {
  return x - y * floor(x / y);
}

fn modulo2(x: vec2<f32>, y: vec2<f32>) -> vec2<f32> {
  return x - y * floor(x / y);
}

// Maps the orbit parameter e² (inverse squared impact parameter) to the U-coordinate
// of the deflection lookup texture. Uses logarithmic mapping to allocate more texels
// near the critical threshold e² ≈ 4/27 (photon sphere limit) where deflection changes rapidly.
fn GetRayDeflectionTextureUFromEsquare(e_square: f32) -> f32 {
  if (e_square < kMu) {
    return 0.5 - sqrt(-log(1.0 - e_square / kMu) * (1.0 / 50.0));
  } else {
    return 0.5 + sqrt(-log(1.0 - kMu / e_square) * (1.0 / 50.0));
  }
}

// Computes the Schwarzschild coordinate u of the periapsis (closest approach)
// for a light ray with parameter e² < 4/27. Obtained by solving du/dφ = 0,
// which is the root of the cubic equation u²(1 - u) = e².
fn GetUapsisFromEsquare(e_square: f32) -> f32 {
  let x = (2.0 / kMu) * e_square - 1.0;
  return 1.0 / 3.0 + (2.0 / 3.0) * sin(asin(x) * (1.0 / 3.0));
}

// Maps the current Schwarzschild coordinate u and parameter e² to the V-coordinate
// of the deflection lookup texture. Handles unstable orbits (e² > 4/27) and stable
// orbits (e² < 4/27) differently to ensure maximum texture density in key regions.
fn GetRayDeflectionTextureVFromEsquareAndU(e_square: f32, u: f32) -> f32 {
  if (e_square > kMu) {
    let x = select(sqrt(u - 2.0 / 3.0), -sqrt(2.0 / 3.0 - u), u < 2.0 / 3.0);
    return (sqrt(2.0 / 3.0) + x) / (sqrt(2.0 / 3.0) + sqrt(1.0 / 3.0));
  } else {
    return 1.0 - sqrt(max(1.0 - u / GetUapsisFromEsquare(e_square), 0.0));
  }
}

// Converts a normalized range coordinate [0, 1] to texel coordinates,
// avoiding edge artifacts and clamp clamping by offsetting by half a texel.
fn GetTextureCoordFromUnitRange(x: f32, texture_size: i32) -> f32 {
  return 0.5 / f32(texture_size) + x * (1.0 - 1.0 / f32(texture_size));
}

struct DeflectionResult {
  deflection: vec2<f32>, // (total deflection angle, travel time integral)
  apsis: vec2<f32>,      // (deflection at closest approach, travel time at closest approach)
}

// Looks up the deflection and travel time integrals for a light ray from the lookup texture.
fn LookupRayDeflection(e_square: f32, u: f32) -> DeflectionResult {
  var res: DeflectionResult;
  let tex_u = GetTextureCoordFromUnitRange(
    GetRayDeflectionTextureUFromEsquare(e_square),
    RAY_DEFLECTION_TEXTURE_WIDTH
  );
  let tex_v = GetTextureCoordFromUnitRange(
    GetRayDeflectionTextureVFromEsquareAndU(e_square, u),
    RAY_DEFLECTION_TEXTURE_HEIGHT
  );
  let tex_v_apsis = GetTextureCoordFromUnitRange(1.0, RAY_DEFLECTION_TEXTURE_HEIGHT);
  res.apsis = textureSampleLevel(ray_deflection_texture, linear_sampler, vec2<f32>(tex_u, tex_v_apsis), 0.0).rg;
  res.deflection = textureSampleLevel(ray_deflection_texture, linear_sampler, vec2<f32>(tex_u, tex_v), 0.0).rg;
  return res;
}

// Computes the maximum angular path φ limit for an unstable ray (e² > 4/27)
// before it crosses the event horizon. Used to map the parameter domain.
fn GetPhiUbFromEsquare(e_square: f32) -> f32 {
  return (1.0 + e_square) / (1.0 / 3.0 + 2.0 * e_square * sqrt(e_square)) * rad;
}

// Maps e² to the U-coordinate of the inverse radius (1/r) lookup texture.
fn GetRayInverseRadiusTextureUFromEsquare(e_square: f32) -> f32 {
  return 1.0 / (1.0 + 6.0 * e_square);
}

// Reconstructs the inverse radius u (meaning 1/r) of a light ray at a specific deflection angle φ.
fn LookupRayInverseRadius(e_square: f32, phi: f32) -> vec2<f32> {
  let tex_u = GetTextureCoordFromUnitRange(
    GetRayInverseRadiusTextureUFromEsquare(e_square),
    RAY_INVERSE_RADIUS_TEXTURE_WIDTH
  );
  let tex_v = GetTextureCoordFromUnitRange(phi / GetPhiUbFromEsquare(e_square), RAY_INVERSE_RADIUS_TEXTURE_HEIGHT);
  return textureSampleLevel(ray_inverse_radius_texture, linear_sampler, vec2<f32>(tex_u, tex_v), 0.0).rg;
}

// Utility function to compute a smooth analytical pulse. Used to anti-alias accretion disk boundaries.
fn FilteredPulse(edge0: f32, edge1: f32, x: f32, fw_in: f32) -> f32 {
  var fw = max(fw_in, 1e-6);
  let x0 = x - fw * 0.5;
  let x1 = x0 + fw;
  return max(0.0, (min(x1, edge1) - max(x0, edge0)) / fw);
}

struct EuclideanResult {
  deflection: f32,
  u0: f32,
  phi0: f32,
  t0: f32,
  u1: f32,
  phi1: f32,
  t1: f32,
}

// Baseline Euclidean trace calculation (gravitational lensing disabled).
// Solves light propagation in straight lines to provide a comparison.
fn TraceRayEuclidean(p_r: f32, delta: f32, alpha: f32, u_ic: f32, u_oc: f32) -> EuclideanResult {
  var res: EuclideanResult;
  let cos_delta = cos(delta);
  let sin_delta = sin(delta);
  let tan_alpha = tan(alpha);
  let det = 1.0 - p_r * p_r * sin_delta * sin_delta;
  res.deflection = select(0.0, -1.0, det > 0.0 && cos_delta < 0.0);
  res.u0 = -1.0;
  res.u1 = -1.0;
  res.phi0 = 0.0;
  res.t0 = 0.0;
  res.phi1 = 0.0;
  res.t1 = 0.0;
  let t = p_r / (sin_delta / tan_alpha - cos_delta);
  let r = length(vec2<f32>(p_r + t * cos_delta, t * sin_delta));
  if (t >= 0.0 && r * u_oc <= 1.0 && r * u_ic >= 1.0 && (res.deflection == 0.0 || t < p_r)) {
    res.u0 = 1.0 / r;
    res.phi0 = alpha;
    res.t0 = t;
  }
  return res;
}

struct TraceResult {
  deflection: f32, // Overall angular deflection of the ray
  u0: f32,         // First intersection point inverse radius (1/r)
  phi0: f32,       // First intersection point angle
  t0: f32,         // First intersection point coordinate time
  alpha0: f32,     // Anti-aliasing factor for first intersection
  u1: f32,         // Second intersection point inverse radius (1/r) (for looped ray paths)
  phi1: f32,       // Second intersection point angle
  t1: f32,         // Second intersection point coordinate time
  alpha1: f32,     // Anti-aliasing factor for second intersection
}

// Integrates geodesic propagation of the ray, determining if it collides with
// the accretion disk, loops around the black hole, or escapes to the cosmic background.
fn TraceRay(u: f32, u_dot: f32, e_square: f32, delta: f32, alpha: f32, u_ic: f32, u_oc: f32, fwidth_e_square: f32) -> TraceResult {
  var res: TraceResult;
  res.u0 = -1.0;
  res.u1 = -1.0;
  res.phi0 = 0.0;
  res.t0 = 0.0;
  res.alpha0 = 0.0;
  res.phi1 = 0.0;
  res.t1 = 0.0;
  res.alpha1 = 0.0;

  if (u_uniforms.lensing == 1u) {
    // If the ray crosses the event horizon threshold, it is swallowed by the black hole.
    if (e_square < kMu && u > 2.0 / 3.0) {
      res.deflection = -1.0;
      return res;
    }
    let deflection_lookup = LookupRayDeflection(e_square, u);
    var ray_deflection = deflection_lookup.deflection.x;
    if (u_dot > 0.0) {
      // Reconstruct ray deflection angle using symmetry: if traveling outwards, we subtract from total periapsis deflection.
      ray_deflection = select(-1.0 * rad, 2.0 * deflection_lookup.apsis.x - ray_deflection, e_square < kMu);
    }
    res.deflection = ray_deflection;

    let s = sign(u_dot);
    var phi = deflection_lookup.deflection.x + select(delta, pi - delta, s == 1.0) + s * alpha;
    let phi_apsis = deflection_lookup.apsis.x + pi / 2.0;
    res.phi0 = modulo(modulo(phi, pi) + pi, pi);
    let ui0 = LookupRayInverseRadius(e_square, res.phi0);
    if (res.phi0 < phi_apsis) {
      let side = s * (ui0.x - u);
      if (side > 1e-3 || (side > -1e-3 && alpha < delta)) {
        res.u0 = ui0.x;
        res.phi0 = alpha + phi - res.phi0;
        res.t0 = s * (ui0.y - deflection_lookup.deflection.y);
      }
    }
    // Calculate secondary intersection (for rays that orbit around the back of the black hole)
    phi = 2.0 * phi_apsis - phi;
    res.phi1 = modulo(modulo(phi, pi) + pi, pi);
    let ui1 = LookupRayInverseRadius(e_square, res.phi1);
    if (e_square < kMu && s == 1.0 && res.phi1 < phi_apsis) {
      res.u1 = ui1.x;
      res.phi1 = alpha + phi - res.phi1;
      res.t1 = 2.0 * deflection_lookup.apsis.y - ui1.y - deflection_lookup.deflection.y;
    }

    let fw0 = 0.01;
    let fw1 = 0.01;
    res.alpha0 = FilteredPulse(u_oc, u_ic, res.u0, fw0);
    res.alpha1 = FilteredPulse(u_oc, u_ic, res.u1, fw1);

    // Apply special filtering at the critical boundary to prevent pixelated noise at the Einstein ring.
    if (s == 1.0 && abs(e_square - kMu) < min(fwidth_e_square, kMu)) {
      if (res.alpha0 < 0.99) { res.u0 = 2.0 / (1.0 / u_ic + 1.0 / u_oc); }
      if (res.alpha1 < 0.99) { res.u1 = 2.0 / (1.0 / u_ic + 1.0 / u_oc); }
    }
  } else {
    // Non-relativistic straight-line ray projection
    res.alpha0 = 1.0;
    res.alpha1 = 1.0;
    let eucl = TraceRayEuclidean(1.0 / u, delta, alpha, u_ic, u_oc);
    res.deflection = eucl.deflection;
    res.u0 = eucl.u0;
    res.phi0 = eucl.phi0;
    res.t0 = eucl.t0;
    res.u1 = eucl.u1;
    res.phi1 = eucl.phi1;
    res.t1 = eucl.t1;
  }
  return res;
}

fn RayTrace(u: f32, u_dot: f32, e_square: f32, delta: f32, alpha: f32, u_ic: f32, u_oc: f32, fwidth_e_square: f32) -> TraceResult {
  return TraceRay(u, u_dot, e_square, delta, alpha, u_ic, u_oc, fwidth_e_square);
}

fn getStarsOrientation() -> mat3x3<f32> {
  return mat3x3<f32>(
    u_uniforms.stars_orientation0.xyz,
    u_uniforms.stars_orientation1.xyz,
    u_uniforms.stars_orientation2.xyz
  );
}

// Samples the background cosmic galaxy cubemap. If coordinate grid mode is active,
// returns the red channel as a grid overlay, otherwise scales down the galaxy brightness.
fn GalaxyColor(dir_in: vec3<f32>, ddx: vec3<f32>, ddy: vec3<f32>) -> vec3<f32> {
  let dir = getStarsOrientation() * dir_in;
  let ddx_rot = getStarsOrientation() * ddx;
  let ddy_rot = getStarsOrientation() * ddy;
  if (u_uniforms.grid == 1u) {
    return textureSampleGrad(galaxy_cube_texture, linear_sampler, dir, ddx_rot, ddy_rot).rrr;
  } else {
    return textureSampleGrad(galaxy_cube_texture, linear_sampler, dir, ddx_rot, ddy_rot).rgb * 6.78494e-5;
  }
}

// Samples the low-resolution background star map when drawing coarse levels of detail.
fn StarTextureColor(dir: vec3<f32>, lod: f32) -> vec3<f32> {
  if (u_uniforms.grid == 1u) {
    return vec3<f32>(0.8);
  } else {
    let level = max(0.0, lod - (6.0 + 1.0)); // MAX_STAR_TEXTURE_LOD is 6
    return textureSampleLevel(star_cube_texture2, linear_sampler, dir, level).rgb;
  }
}

struct StarColorResult {
  color: vec3<f32>,
  sub_position: vec2<f32>,
}

// Samples individual star metadata from the high-resolution texture. Each texel represents
// a star catalog entry containing sub-pixel coordinates for anti-aliased sub-pixel rendering.
fn StarTextureColorLod(dir: vec3<f32>, lod: f32) -> StarColorResult {
  var res: StarColorResult;
  if (u_uniforms.grid == 1u) {
    res.sub_position = vec2<f32>(0.0);
    res.color = vec3<f32>(100.0);
  } else {
    let color = textureSampleLevel(star_cube_texture, nearest_sampler, dir, lod).rgb;
    let bits_r = i32(bitcast<u32>(color.r));
    let bits_b = i32(bitcast<u32>(color.b));
    let sub_x = f32((bits_r >> 8) % 257) / 257.0 - 0.5;
    let sub_y = f32((bits_b >> 8) % 257) / 257.0 - 0.5;
    res.sub_position = vec2<f32>(sub_x, sub_y);
    res.color = color;
  }
  return res;
}

fn inverseMat2(m: mat2x2<f32>) -> mat2x2<f32> {
  let det = m[0][0] * m[1][1] - m[0][1] * m[1][0];
  let invDet = 1.0 / det;
  return mat2x2<f32>(
    vec2<f32>(m[1][1] * invDet, -m[0][1] * invDet),
    vec2<f32>(-m[1][0] * invDet, m[0][0] * invDet)
  );
}

// Computes background star antialiased colors. Applies anisotropic filtering
// using coordinate projection matrices. Gravitational lensing dramatically magnifies
// background star intensities; the amplification factor is scaled and applied here.
fn DefaultStarColor(dir_in: vec3<f32>, dx_dir_in: vec3<f32>, dy_dir_in: vec3<f32>, lensing_amplification_factor: f32, min_lod: f32) -> vec3<f32> {
  var dir = dir_in;
  var dx_dir = dx_dir_in;
  var dy_dir = dy_dir_in;

  let abs_dir = abs(dir);
  let max_abs_dir_comp = max(abs_dir.x, max(abs_dir.y, abs_dir.z));
  if (max_abs_dir_comp == abs_dir.x) {
    dir = dir.zyx;
    dx_dir = dx_dir.zyx;
    dy_dir = dy_dir.zyx;
  } else if (max_abs_dir_comp == abs_dir.y) {
    dir = dir.xzy;
    dx_dir = dx_dir.xzy;
    dy_dir = dy_dir.xzy;
  }

  let inv_dir_z = 1.0 / dir.z;
  let uv = dir.xy * inv_dir_z;
  let dx_uv = (dx_dir.xy - uv * dx_dir.z) * inv_dir_z;
  let dy_uv = (dy_dir.xy - uv * dy_dir.z) * inv_dir_z;

  let stars_cube_map_size = select(2048.0, 128.0, u_uniforms.grid == 1u);
  let max_footprint_lod = select(6.0, 0.0, u_uniforms.grid == 1u);

  let d_uv = max(abs(dx_uv + dy_uv), abs(dx_uv - dy_uv));
  let fwidth_val = (0.5 * stars_cube_map_size / 4.0) * d_uv;
  let lod = max(ceil(max(log2(fwidth_val.x), log2(fwidth_val.y))), min_lod);
  let lod_width = (0.5 * stars_cube_map_size) / pow(2.0, lod);
  if (lod > max_footprint_lod) {
    return StarTextureColor(dir, lod);
  }

  let to_screen_pixel_coords = inverseMat2(mat2x2<f32>(dx_uv, dy_uv));
  let ij0 = vec2<i32>(floor((uv - d_uv) * lod_width));
  let ij1 = vec2<i32>(floor((uv + d_uv) * lod_width));
  var color_sum = vec3<f32>(0.0);

  for (var j = ij0.y; j <= ij1.y; j++) {
    for (var i = ij0.x; i <= ij1.x; i++) {
      let texel_uv = (vec2<f32>(f32(i), f32(j)) + vec2<f32>(0.5)) / lod_width;
      var texel_dir = vec3<f32>(texel_uv * dir.z, dir.z);
      if (max_abs_dir_comp == abs_dir.x) {
        texel_dir = texel_dir.zyx;
      } else if (max_abs_dir_comp == abs_dir.y) {
        texel_dir = texel_dir.xzy;
      }
      let star_lookup = StarTextureColorLod(texel_dir, lod);
      let star_uv = uv - texel_uv + star_lookup.sub_position / lod_width;
      let star_pixel_coords = to_screen_pixel_coords * star_uv;
      let overlap = max(vec2<f32>(1.0) - abs(star_pixel_coords), vec2<f32>(0.0));
      color_sum += star_lookup.color * overlap.x * overlap.y;
    }
  }
  return color_sum * lensing_amplification_factor;
}

fn StarColor(dir_in: vec3<f32>, dx_dir: vec3<f32>, dy_dir: vec3<f32>, lensing_amplification_factor: f32) -> vec3<f32> {
  if (u_uniforms.stars == 1u) {
    let dir = getStarsOrientation() * dir_in;
    let dx = getStarsOrientation() * dx_dir;
    let dy = getStarsOrientation() * dy_dir;
    return DefaultStarColor(dir, dx, dy, lensing_amplification_factor, u_uniforms.min_stars_lod);
  } else {
    return vec3<f32>(0.0);
  }
}

// Shifts the incoming color spectrum based on the relativistic Doppler factor.
// Looks up color modifications from a precalculated spectral shift texture
// which maps original RGB components to their blue-shifted/red-shifted values.
fn DefaultDoppler(rgb: vec3<f32>, doppler_factor: f32) -> vec3<f32> {
  let sum = rgb.r + rgb.g + rgb.b;
  if (sum == 0.0) {
    return vec3<f32>(0.0);
  }
  var tex_coord: vec3<f32>;
  tex_coord.x = rgb.r / sum;
  tex_coord.y = 2.0 * rgb.g / sum;
  tex_coord.z = (1.0 / 3.0) * atan((1.0 / 0.21) * log(doppler_factor)) + 0.5;
  return sum * textureSampleLevel(doppler_texture, linear_sampler, tex_coord, 0.0).rgb;
}

fn Doppler(rgb: vec3<f32>, doppler_factor: f32) -> vec3<f32> {
  if (u_uniforms.doppler == 1u) {
    return DefaultDoppler(rgb, doppler_factor);
  } else {
    return rgb;
  }
}

// Samples blackbody thermal radiation emission spectra at a specific temperature.
fn BlackBodyColor(temperature: f32) -> vec3<f32> {
  let tex_u = (1.0 / 6.0) * log(temperature * (1.0 / 100.0));
  return textureSampleLevel(black_body_texture, linear_sampler, vec2<f32>(tex_u, 0.5), 0.0).rgb;
}

fn Noise(uv: vec2<f32>) -> f32 {
  return 3.0 * (textureSampleLevel(noise_texture, linear_sampler, uv, 0.0).r - 0.5) + 1.0;
}

// Computes the color emission and density of a thin, turbulent accretion disk.
// Uses the Shakura-Sunyaev temperature profile:
//   T_disk(r) ∝ r⁻³/⁴ (1 - √(3/r))¹/⁴
// where the ISCO (Innermost Stable Circular Orbit) is located at r = 3 (since r_s = 1).
fn DefaultDiscColor(p: vec2<f32>, p_t: f32, top_side: bool, doppler_factor: f32, disc_temperature: f32) -> vec4<f32> {
  let p_r = length(p);
  let p_phi = atan2(p.y, p.x);

  // Accumulate density from Keplerian orbiting gaseous dust particle paths
  var density = 0.0;
  for (var i = 0; i < NUM_DISC_PARTICLES; i++) {
    let params = u_uniforms.disc_particles[i];
    let u1 = params.x;
    let u2 = params.y;
    let phi0 = params.z;
    let dtheta_dphi = params.w;
    let u_avg = (u1 + u2) * 0.5;
    let dphi_dt = u_avg * sqrt(0.5 * u_avg); // Keplerian angular frequency dφ/dt = √(GM/r³)
    let phi = dphi_dt * p_t + phi0;
    let a = modulo(p_phi - phi, 2.0 * pi);
    let s = sin(dtheta_dphi * (a + phi));
    let r = 1.0 / (u1 + (u2 - u1) * s * s);
    let d = vec2<f32>(a - pi, r - p_r) * vec2<f32>(1.0 / pi, 0.5);
    let noise = Noise(modulo2(d * vec2<f32>(p_r / OUTER_DISC_R, 1.0), vec2<f32>(1.0)));
    density += smoothstep(1.0, 0.0, length(d)) * noise;
  }

  // Shakura-Sunyaev Black Hole accretion disk thermal profile calculations
  let r_max = 49.0 / 12.0; // Point of peak temperature profile
  let temperature_profile_max = pow((1.0 - sqrt(3.0 / r_max)) / (r_max * r_max * r_max), 0.25);
  let temperature_profile = pow((1.0 - sqrt(3.0 / p_r)) / (p_r * p_r * p_r), 0.25);
  let temperature = disc_temperature * temperature_profile * (1.0 / temperature_profile_max);

  // Blackbody emission modulated by Doppler factor (gravitational redshift + kinematic shift)
  let color = max(density, 0.0) * BlackBodyColor(temperature * doppler_factor);
  
  // Boundary alpha smoothing (smoothly fades out at outer edge and inside ISCO boundary)
  let alpha = smoothstep(INNER_DISC_R, INNER_DISC_R * 1.2, p_r) * smoothstep(OUTER_DISC_R, OUTER_DISC_R / 1.2, p_r);
  return vec4<f32>(color * alpha, alpha);
}

// Renders a grid pattern over the accretion disk for coordinate visualization.
fn GridDiscColor(p: vec2<f32>, t: f32, top_side: bool, doppler_factor: f32, temperature: f32) -> vec4<f32> {
  let p_r = length(p);
  if (p_r <= INNER_DISC_R || p_r >= OUTER_DISC_R) {
    return vec4<f32>(0.0);
  }
  let u_avg = 1.0 / 6.0;
  let dphi_dt = u_avg * sqrt(0.5 * u_avg) / (2.0 * pi);
  let p_phi = atan2(p.y, p.x) - t * dphi_dt;
  let value_phi = select(1.0, 0.0, modulo(p_phi / pi * 16.0, 1.0) < 0.2);
  let value_r = select(1.0, 0.0, modulo(p_r / 2.0, 1.0) < 0.2);
  let color = BlackBodyColor(temperature * doppler_factor);
  let pattern = 0.2 + 0.8 * value_phi * value_r;
  return vec4<f32>(color * select(1.2 - pattern, pattern, top_side), 1.0);
}

fn DiscColor(p: vec2<f32>, t: f32, top_side: bool, doppler_factor_in: f32) -> vec4<f32> {
  let density = u_uniforms.disc_params.x;
  let opacity = u_uniforms.disc_params.y;
  let temperature = u_uniforms.disc_params.z;
  let doppler_factor = select(doppler_factor_in, 1.0, u_uniforms.doppler == 0u);
  
  var color: vec4<f32>;
  if (u_uniforms.grid == 1u) {
    color = GridDiscColor(p, t, top_side, doppler_factor, temperature);
  } else {
    color = DefaultDiscColor(p, t, top_side, doppler_factor, temperature);
  }
  return vec4<f32>(density * color.rgb, opacity * color.a);
}

// =====================================================================================
// MAIN RELATIVISTIC RAYTRACER (SCENE RENDERING)
// =====================================================================================
// Orchestrates the ray tracing and PBR composition of the black hole, accretion disk,
// lensed background stars, and cosmic dust.
//
// Relativistic momentum vector projections are calculated to determine the initial
// light ray angles. We trace geodesics using our lookup-textures, then compute
// gravitational redshift / kinematic Doppler factors to blend background light
// and accretion disk gas emissions realistically.
// =====================================================================================
fn SceneColor(camera_position: vec4<f32>, p: vec3<f32>, k_s: vec4<f32>, e_tau: vec3<f32>, e_w: vec3<f32>, e_h: vec3<f32>, e_d: vec3<f32>, view_dir: vec3<f32>) -> vec3<f32> {
  let q = normalize(view_dir);
  let q_dx = dpdx(q);
  let q_dy = dpdy(q);
  let d = -e_tau + q.x * e_w + q.y * e_h + q.z * e_d;

  let e_x_prime = normalize(p);
  let e_z_prime = normalize(cross(e_x_prime, d));
  let e_y_prime = normalize(cross(e_z_prime, e_x_prime));

  let e_z = vec3<f32>(0.0, 0.0, 1.0);
  var t_vec = normalize(cross(e_z, e_z_prime));
  if (dot(t_vec, e_y_prime) < 0.0) {
    t_vec = -t_vec;
  }

  // Calculate coordinates in the local orbital plane
  let alpha = acos(clamp(dot(e_x_prime, t_vec), -1.0, 1.0));
  let delta = acos(clamp(dot(e_x_prime, normalize(d)), -1.0, 1.0));

  let u = 1.0 / camera_position[1];
  let u_dot = -u / tan(delta);
  let e_square = u_dot * u_dot + u * u * (1.0 - u);
  let e = -sqrt(e_square);

  let U_IC = 1.0 / INNER_DISC_R;
  let U_OC = 1.0 / OUTER_DISC_R;
  
  let fwidth_e_square = fwidth(e_square);
  let deflection_res = RayTrace(u, u_dot, e_square, delta, alpha, U_IC, U_OC, fwidth_e_square);
  let u0 = deflection_res.u0;
  let phi0 = deflection_res.phi0;
  let t0 = deflection_res.t0;
  let alpha0 = deflection_res.alpha0;
  let u1 = deflection_res.u1;
  let phi1 = deflection_res.phi1;
  let t1 = deflection_res.t1;
  let alpha1 = deflection_res.alpha1;
  let deflection = deflection_res.deflection;

  // Relativistic projection of photon momentum (four-momentum integration)
  let l = vec4<f32>(e / (1.0 - u), -u_dot, 0.0, u * u);
  let g_k_l_receiver = k_s.x * l.x * (1.0 - u) - k_s.y * l.y / (1.0 - u) - u * dot(e_tau, e_y_prime) * l.w / (u * u);

  let delta_prime = delta + max(deflection, 0.0);
  let d_prime = cos(delta_prime) * e_x_prime + sin(delta_prime) * e_y_prime;
  let d_prime_dx = dpdx(d_prime);
  let d_prime_dy = dpdy(d_prime);

  var color = vec3<f32>(0.0);
  if (deflection >= 0.0) {
    let g_k_l_source = e;
    let doppler_factor = g_k_l_receiver / g_k_l_source;

    // Calculate lensing amplification by evaluating pixel footprint divergence:
    //   Amplification = Area_Observer / Area_Source
    let omega = length(cross(q_dx, q_dy));
    let omega_prime = length(cross(d_prime_dx, d_prime_dy));

    var lensing_amplification_factor = omega / omega_prime;
    lensing_amplification_factor = min(lensing_amplification_factor, 1e6);

    let pixel_area = max(omega * (1024.0 * 1024.0), 1.0);

    color += GalaxyColor(d_prime, d_prime_dx, d_prime_dy);
    color += StarColor(d_prime, d_prime_dx, d_prime_dy, lensing_amplification_factor / pixel_area);
    color = Doppler(color, doppler_factor);
  }
  
  // Composite accretion disk intersections (under side / far side loop intersection)
  if (u1 >= 0.0 && alpha1 > 0.0) {
    let g_k_l_source = e * sqrt(2.0 / (2.0 - 3.0 * u1)) - u1 * sqrt(u1 / (2.0 - 3.0 * u1)) * dot(e_z, e_z_prime);
    let doppler_factor = g_k_l_receiver / g_k_l_source;
    let top_side = (modulo(abs(phi1 - alpha), 2.0 * pi) < 1e-3) == (e_x_prime.z > 0.0);

    let i1 = (e_x_prime * cos(phi1) + e_y_prime * sin(phi1)) / u1;
    let disc_color = DiscColor(i1.xy, camera_position[0] - t1, top_side, doppler_factor);
    color = color * (1.0 - disc_color.a) + alpha1 * disc_color.rgb;
  }
  
  // Composite accretion disk intersections (top side / near side direct intersection)
  if (u0 >= 0.0 && alpha0 > 0.0) {
    let g_k_l_source = e * sqrt(2.0 / (2.0 - 3.0 * u0)) - u0 * sqrt(u0 / (2.0 - 3.0 * u0)) * dot(e_z, e_z_prime);
    let doppler_factor = g_k_l_receiver / g_k_l_source;
    let top_side = (modulo(abs(phi0 - alpha), 2.0 * pi) < 1e-3) == (e_x_prime.z > 0.0);

    let i0 = (e_x_prime * cos(phi0) + e_y_prime * sin(phi0)) / u0;
    let disc_color = DiscColor(i0.xy, camera_position[0] - t0, top_side, doppler_factor);
    color = color * (1.0 - disc_color.a) + alpha0 * disc_color.rgb;
  }
  return color;
}

@fragment
fn frag_main(@location(0) screen_pos: vec2<f32>) -> @location(0) vec4<f32> {
  var view_dir: vec3<f32>;
  if (u_uniforms.projection_mode == 1u) {
    let r = length(screen_pos);
    if (r > 1.0) {
      return vec4<f32>(0.0, 0.0, 0.0, 1.0); // Output black outside the 360-degree dome
    }
    let theta = r * pi;
    let phi = atan2(screen_pos.y, screen_pos.x);
    // In our local frame, -z is forward, x is right/yaw, y is pitch.
    view_dir = vec3<f32>(sin(theta) * cos(phi), sin(theta) * sin(phi), -cos(theta));
  } else {
    view_dir = vec3<f32>(screen_pos * u_uniforms.camera_size.xy, -u_uniforms.camera_size.z);
  }

  let color = SceneColor(
    u_uniforms.camera_position,
    u_uniforms.p,
    u_uniforms.k_s,
    u_uniforms.e_tau,
    u_uniforms.e_w,
    u_uniforms.e_h,
    u_uniforms.e_d,
    view_dir
  );
  return vec4<f32>(color, 1.0);
}
`,X=`// =====================================================================================
// PHYSICALLY BASED RENDERING (PBR) & COOK-TORRANCE SHADING MODEL
// =====================================================================================
//
// This shader implements a complete microfacet Cook-Torrance BRDF (Bidirectional
// Reflectance Distribution Function) for rendering the spacecraft model.
//
// 1. SPECULAR MICROFACET SHADING MODEL
// -------------------------------------------------------------------------------------
// The specular component of the BRDF is modeled as:
//
//   f_specular = D * F * V
//
// where:
//   - D: Microfacet Distribution Function (GGX / Trowbridge-Reitz NDF)
//   - F: Fresnel Reflection Coefficient (Schlick's approximation)
//   - V: Geometric Visibility Factor (correlated Smith shadow-masking function)
//
// 2. FRESNEL REFLECTION - SCHLICK'S APPROXIMATION
// -------------------------------------------------------------------------------------
// Reflectance increases dramatically at grazing angles:
//
//   F(F0, v_dot_h) = F0 + (1 - F0) * (1 - v_dot_h)⁵
//
// where F0 is the base reflectance at normal incidence (0.04 for dielectrics).
//
// 3. MICROFACET DISTRIBUTION - GGX (TROWBRIDGE-REITZ NDF)
// -------------------------------------------------------------------------------------
// Describes the statistical distribution of microfacet normal orientations relative to half vector h:
//
//   D(n_dot_h) = α² / (π * [ (n_dot_h)² * (α² - 1) + 1 ]²)
//
// where α = roughness² (visual roughness squared to ensure linear control).
//
// 4. GEOMETRIC MASKING & SHADOWING - CORRELATED SMITH GGX
// -------------------------------------------------------------------------------------
// Accounts for occlusion between neighboring microfacets. Using height-correlated Smith:
//
//   V(n_dot_l, n_dot_v) = 0.5 / ( n_dot_l * √(n_dot_v² * (1 - α²) + α²) + n_dot_v * √(n_dot_l² * (1 - α²) + α²) )
//
// 5. IMAGE-BASED LIGHTING (IBL) & MONTE CARLO INTEGRATION
// -------------------------------------------------------------------------------------
// Instead of simple point lights, the rocket is illuminated by the surrounding environment
// map. The incoming radiance is integrated over the hemisphere using Monte Carlo sampling.
//
// For high-roughness surfaces:
//   - Integrates the hemisphere uniformly using N_Z * N_PHI = 24 samples.
//   - To prevent aliasing, the MIPMAP level is calculated analytically based on sample solid angle:
//       LOD = 0.5 * log2(Ω_sample / Ω_texel)
//
// For low-roughness surfaces (roughness² < 0.0625):
//   - Uniform sampling gets noisy. Instead, we use Importance Sampling.
//   - We generate random coordinates using the Van der Corput low-discrepancy sequence.
//   - Half vectors h are sampled from the GGX PDF using the inverse CDF mapping:
//       cos(θ) = √[ (1 - u) / ((α² - 1)*u + 1) ]
//   - The sample ray l is obtained by reflecting view vector v about h: l = reflect(-v, h).
//   - The resulting sample is weighted by its Probability Density Function (PDF):
//       PDF = D * (n_dot_h) / (4 * (v_dot_h))
//
// =====================================================================================

const PI: f32 = 3.141592653589793;

// Van der Corput low-discrepancy sequence for quasi-random Monte Carlo sampling
const VAN_DER_CORPUT = array<f32, 32>(
  0.00000, 0.50000, 0.25000, 0.75000, 0.12500, 0.62500, 0.37500, 0.87500,
  0.06250, 0.56250, 0.31250, 0.81250, 0.18750, 0.68750, 0.43750, 0.93750,
  0.03125, 0.53125, 0.28125, 0.78125, 0.15625, 0.65625, 0.40625, 0.90625,
  0.09375, 0.59375, 0.34375, 0.84375, 0.21875, 0.71875, 0.46875, 0.96875
);

struct RocketUniforms {
  model_view_proj_matrix: mat4x4<f32>,
  camera: vec3<f32>,
};

@group(0) @binding(0) var<uniform> u_uniforms: RocketUniforms;
@group(0) @binding(1) var linear_sampler: sampler;
@group(0) @binding(2) var base_color_texture: texture_2d<f32>;
@group(0) @binding(3) var occlusion_roughness_metallic_texture: texture_2d<f32>;
@group(0) @binding(4) var normal_map_texture: texture_2d<f32>;
@group(0) @binding(5) var env_map_texture: texture_cube<f32>;

struct VertexInput {
  @location(0) position_attribute: vec3<f32>,
  @location(1) normal_attribute: vec3<f32>,
  @location(2) tangent_attribute: vec4<f32>,
  @location(3) uv_attribute: vec2<f32>,
  @location(4) ambient_occlusion_attribute: f32,
};

struct VertexOutput {
  @builtin(position) Position: vec4<f32>,
  @location(0) position: vec3<f32>,
  @location(1) normal: vec3<f32>,
  @location(2) tangent: vec3<f32>,
  @location(3) uv: vec2<f32>,
  @location(4) ambient_occlusion: f32,
};

@vertex
fn vert_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = in.position_attribute;
  out.normal = in.normal_attribute;
  out.tangent = in.tangent_attribute.xyz;
  out.uv = in.uv_attribute;
  out.ambient_occlusion = in.ambient_occlusion_attribute;
  out.Position = u_uniforms.model_view_proj_matrix * vec4<f32>(in.position_attribute, 1.0);
  return out;
}

struct Surface {
  n: vec3<f32>,       // Normal vector in tangent space
  tx: vec3<f32>,      // Tangent vector
  ty: vec3<f32>,      // Bitangent vector
  occlusion: f32,    // Ambient occlusion factor
  alpha_sq: f32,     // α² parameter (roughness⁴)
  albedo: vec3<f32>,  // Diffuse color component
  f0: vec3<f32>,      // Specular reflectance at normal incidence
};

// Computes perturbed normals in tangent space using normal map samples.
fn ComputeNormal(uv: vec2<f32>, normal_in: vec3<f32>, tangent_in: vec3<f32>) -> vec3<f32> {
  let n = textureSample(normal_map_texture, linear_sampler, uv).xyz * 2.0 - vec3<f32>(1.0);
  let ez = normalize(normal_in);
  let ex = normalize(tangent_in);
  let ey = cross(ez, ex);
  return normalize(n.x * ex + n.y * ey + n.z * ez);
}

// Extracts PBR surface properties (albedo, roughness, metallic, normal, occlusion)
// from the material textures.
fn ComputeSurface(uv: vec2<f32>, normal_in: vec3<f32>, tangent_in: vec3<f32>, ambient_occlusion_in: f32) -> Surface {
  var surface: Surface;
  surface.n = ComputeNormal(uv, normal_in, tangent_in);
  surface.ty = normalize(cross(surface.n, tangent_in));
  surface.tx = cross(surface.ty, surface.n);

  let occlusion_roughness_metallic = textureSample(occlusion_roughness_metallic_texture, linear_sampler, uv).rgb;
  surface.occlusion = occlusion_roughness_metallic.r * ambient_occlusion_in;
  let roughness = occlusion_roughness_metallic.g;
  let metallic = occlusion_roughness_metallic.b;
  let alpha = roughness * roughness;
  surface.alpha_sq = alpha * alpha; // α²

  let DIELECTRIC_F0 = 0.04;
  let METAL_ALBEDO = vec3<f32>(0.0);
  let color = textureSample(base_color_texture, linear_sampler, uv).rgb;
  // Non-metals use dielectric color, metals discard diffuse and use color as f0 specular.
  surface.albedo = mix(color * (1.0 - DIELECTRIC_F0), METAL_ALBEDO, metallic);
  surface.f0 = mix(vec3<f32>(DIELECTRIC_F0), color, metallic);
  
  return surface;
}

// Reconstructs a direction vector from spherical angles (theta, phi) relative to the surface normal.
fn GetVector(surface: Surface, cos_theta: f32, sin_theta: f32, phi: f32) -> vec3<f32> {
  let vx = sin_theta * cos(phi);
  let vy = sin_theta * sin(phi);
  let vz = cos_theta;
  return vx * surface.tx + vy * surface.ty + vz * surface.n;
}

// Schlick's approximation of the Fresnel reflection coefficient.
fn Fresnel(f0: vec3<f32>, v_dot_h: f32) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - v_dot_h, 5.0);
}

// GGX height-correlated Smith shadow-masking function: V = G / (4 * (n·l) * (n·v))
fn MicroFacetVisibility(alpha_sq: f32, n_dot_l: f32, n_dot_v: f32) -> f32 {
  let a = n_dot_l * sqrt(n_dot_v * n_dot_v * (1.0 - alpha_sq) + alpha_sq);
  let b = n_dot_v * sqrt(n_dot_l * n_dot_l * (1.0 - alpha_sq) + alpha_sq);
  return 0.5 / (a + b);
}

// Trowbridge-Reitz / GGX Microfacet Normal Distribution Function (NDF)
fn MicroFacetDistribution(alpha_sq: f32, n_dot_h: f32) -> f32 {
  let a = n_dot_h * n_dot_h * (alpha_sq - 1.0) + 1.0;
  return alpha_sq / (PI * a * a);
}

const ENV_MAP_SIZE: f32 = 64.0;

// Performs hemispherical numerical integration over the environmental map
// to shade the spacecraft based on material roughness and metallic inputs.
fn ImageBasedLighting(surface: Surface, v: vec3<f32>) -> vec3<f32> {
  let N_Z = 3;
  const N_PHI = 8;
  let OMEGA_SAMPLE = 2.0 * PI / f32(N_Z * N_PHI);
  let OMEGA_TEXEL = 4.0 * PI / (6.0 * ENV_MAP_SIZE * ENV_MAP_SIZE);
  let LOD = 0.5 * log2(OMEGA_SAMPLE / OMEGA_TEXEL);
  let n_dot_v = clamp(dot(surface.n, v), 0.0, 1.0);
  var diffuse = vec3<f32>(0.0);
  var specular = vec3<f32>(0.0);
  
  // Numerical hemispherical integration for diffuse and coarse specular highlights
  for (var i = 0; i < N_Z; i++) {
    let cos_theta = (f32(i) + 0.5) / f32(N_Z);
    let sin_theta = sqrt(1.0 - cos_theta * cos_theta);
    for (var j = 0; j < N_PHI; j++) {
      let phi = f32(j) * (2.0 * PI / f32(N_PHI));
      let l = GetVector(surface, cos_theta, sin_theta, phi);
      let L = textureSampleLevel(env_map_texture, linear_sampler, l, LOD).rgb;

      let h = normalize(v + l);
      let n_dot_l = cos_theta;
      let n_dot_h = clamp(dot(surface.n, h), 0.0, 1.0);
      let v_dot_h = clamp(dot(v, h), 0.0, 1.0);
      let F = Fresnel(surface.f0, v_dot_h);
      let V = MicroFacetVisibility(surface.alpha_sq, n_dot_l, n_dot_v);
      let D = MicroFacetDistribution(surface.alpha_sq, n_dot_h);

      diffuse += surface.albedo * L * (vec3<f32>(1.0) - F) * n_dot_l;
      specular += L * F * (V * D * n_dot_l);
    }
  }
  diffuse *= OMEGA_SAMPLE / PI;
  specular *= OMEGA_SAMPLE;

  // Monte Carlo Importance Sampling for smooth, low-roughness specular reflections (shiny surfaces)
  let SAMPLE_COUNT = 24;
  var importance_specular = vec3<f32>(0.0);
  for (var i = 0; i < SAMPLE_COUNT; i++) {
    let vdc = VAN_DER_CORPUT[i];
    // Inverse CDF mapping for GGX microfacet distribution
    let z_sq = (1.0 - vdc) / ((surface.alpha_sq - 1.0) * vdc + 1.0);
    let cos_theta = sqrt(z_sq);
    let sin_theta = sqrt(1.0 - z_sq);
    let phi = f32(i) * (2.0 * PI / f32(SAMPLE_COUNT));
    let h = GetVector(surface, cos_theta, sin_theta, phi);

    let l = reflect(-v, h);
    let n_dot_l = dot(surface.n, l);
    if (n_dot_l <= 0.0) { continue; }

    let n_dot_h = clamp(dot(surface.n, h), 0.0, 1.0);
    let v_dot_h = clamp(dot(v, h), 0.0, 1.0);
    let F = Fresnel(surface.f0, v_dot_h);
    let V = MicroFacetVisibility(surface.alpha_sq, n_dot_l, n_dot_v);
    let D = MicroFacetDistribution(surface.alpha_sq, n_dot_h);

    // Probability Density Function:
    let pdf = D * n_dot_h / (4.0 * v_dot_h);
    let omega_sample_inverse = pdf * f32(SAMPLE_COUNT);
    // Dynamic LOD selection based on PDF to sample envmap smoothly
    let lod = -0.5 * log2(omega_sample_inverse * OMEGA_TEXEL);
    let L = textureSampleLevel(env_map_texture, linear_sampler, l, lod).rgb;

    importance_specular += L * F * (V * D * n_dot_l / pdf);
  }
  importance_specular *= (1.0 / f32(SAMPLE_COUNT));

  return diffuse + select(specular, importance_specular, surface.alpha_sq < 0.0625);
}

@fragment
fn frag_main(in: VertexOutput) -> @location(0) vec4<f32> {
  let surface = ComputeSurface(in.uv, in.normal, in.tangent, in.ambient_occlusion);
  let v = normalize(u_uniforms.camera - in.position);
  return vec4<f32>(ImageBasedLighting(surface, v) * surface.occlusion, 1.0);
}
`,j=`// =====================================================================================
// ROCKET PLUME VOLUMETRIC EXHAUST SHADER
// =====================================================================================
//
// 1. PLUME GEOMETRY & BOUNDS
// -------------------------------------------------------------------------------------
// The rocket engine plume is modeled mathematically as a finite cylinder of radius R 
// aligned with the local Z-axis of the rocket body, extending from Z_MIN to Z_MAX:
//
//   Cylinder space: x² + y² ≤ R²   and   Z_MIN ≤ z ≤ Z_MAX
//
// 2. RAY-CYLINDER INTERSECTION
// -------------------------------------------------------------------------------------
// For each pixel fragment, a ray is projected from the camera point C in direction d:
//
//   P(t) = C + t * d
//
// Substituting the ray equation into the 2D projection of the cylinder (XY plane):
//
//   (C_x + t*d_x)² + (C_y + t*d_y)² = R²
//
// Expanding and rearranging as a quadratic equation in t:
//
//   a*t² + 2b*t + c = 0
//
// where:
//   - a = d_x² + d_y² ≡ dot(d_xy, d_xy)
//   - b = C_x*d_x + C_y*d_y ≡ dot(C_xy, d_xy)
//   - c = C_x² + C_y² - R² ≡ dot(C_xy, C_xy) - R²
//
// The discriminant is:
//
//   D = b² - a*(c - R²)
//
//   - If D < 0: The ray misses the cylinder.
//   - If D ≥ 0: The ray intersects the cylinder at entry/exit distances:
//
//       t_entry = (-b - √D) / a
//       t_exit  = (-b + √D) / a
//
// 3. Z-BOUND CLIPPING
// -------------------------------------------------------------------------------------
// The infinite cylinder intersection segment [t_entry, t_exit] is clipped by the Z boundaries:
//
//   z_ray(t) = C_z + t * d_z
//
// We solve for t where z_ray(t) = Z_MIN and z_ray(t) = Z_MAX, then intersect these intervals.
//
// 4. VOLUMETRIC RAYMARCHING INTEGRATION
// -------------------------------------------------------------------------------------
// Once the segment [t_min, t_max] inside the physical plume is determined, we numerically
// integrate the gas emission along the ray using N = 16 steps.
// At each sample position P(t), the emission intensity drops off:
//   - Radially: decays exponentially with r² (where r² = x² + y²)
//   - Along the length: decays exponentially with distance from the engine nozzle (Z_MAX)
//
//   I(r, z) = e^(-k_r * r² - k_z * (Z_MAX - z))
//
// =====================================================================================

struct ExhaustUniforms {
  model_view_proj_matrix: mat4x4<f32>,
  camera: vec3<f32>, // Camera position relative to the rocket local coordinate space
  _pad1: f32,
  intensity: vec3<f32>, // Emission color intensity scalar
  _pad2: f32,
  k_r: vec3<f32>, // Radial density decay coefficient
  _pad3: f32,
  k_z: vec3<f32>, // Longitudinal density decay coefficient
};

@group(0) @binding(0) var<uniform> u_uniforms: ExhaustUniforms;

struct VertexInput {
  @location(0) position_attribute: vec3<f32>,
};

struct VertexOutput {
  @builtin(position) Position: vec4<f32>,
  @location(0) position: vec3<f32>,
};

@vertex
fn vert_main(in: VertexInput) -> VertexOutput {
  var out: VertexOutput;
  out.position = in.position_attribute;
  out.Position = u_uniforms.model_view_proj_matrix * vec4<f32>(in.position_attribute, 1.0);
  return out;
}

const RADIUS: f32 = 0.514;
const Z_MIN: f32 = -20.0;
const Z_MAX: f32 = -2.1;

@fragment
fn frag_main(in: VertexOutput) -> @location(0) vec4<f32> {
  // Normalize the viewing ray direction vector
  let dir = normalize(in.position - u_uniforms.camera);
  
  // Set up quadratic coefficients for infinite cylinder intersection in 2D
  let a = dot(dir.xy, dir.xy);
  let b = dot(u_uniforms.camera.xy, dir.xy);
  let c = dot(u_uniforms.camera.xy, u_uniforms.camera.xy);
  let discriminant = b * b - a * (c - RADIUS * RADIUS);
  
  if (discriminant >= 0.0) {
    var t_min = max((-b - sqrt(discriminant)) / a, 0.0);
    var t_max = (-b + sqrt(discriminant)) / a;
    
    // Clip the entry and exit t parameters using the finite Z boundary limits [Z_MIN, Z_MAX]
    if (dir.z > 0.0) {
      t_min = max(t_min, (Z_MIN - u_uniforms.camera.z) / dir.z);
      t_max = min(t_max, (Z_MAX - u_uniforms.camera.z) / dir.z);
    } else {
      t_min = max(t_min, (Z_MAX - u_uniforms.camera.z) / dir.z);
      t_max = min(t_max, (Z_MIN - u_uniforms.camera.z) / dir.z);
    }
    
    // Perform volume raymarching integration if the ray segment is inside the plume
    if (t_min < t_max) {
      const N = 16;
      var emitted = vec3<f32>(0.0);
      let dt = (t_max - t_min) / f32(N);
      var t = t_min + 0.5 * dt;
      for (var i = 0; i < N; i++) {
        // Calculate squared radial distance: r² = x² + y² = a*t² + 2b*t + c
        let r2 = ((a * t + 2.0 * b) * t) + c;
        let z = u_uniforms.camera.z + t * dir.z;
        // Integrate exponential density decay: radial decay (k_r) + longitudinal decay (k_z)
        emitted += exp(- u_uniforms.k_r * r2 - u_uniforms.k_z * (Z_MAX - z));
        t += dt;
      }
      return vec4<f32>(u_uniforms.intensity * emitted * dt, 0.0);
    }
  }
  return vec4<f32>(0.0);
}
`,Z=299792458;class ${constructor(e,t){o(this,"model");o(this,"canvas");o(this,"ctx");o(this,"elRadius");o(this,"elRadiusRs");o(this,"elSpeed");o(this,"elGForce");o(this,"elGlobalTime");o(this,"elLocalTime");o(this,"elTimeDilation");o(this,"elProjMode");o(this,"elWarningBanner");o(this,"btnProjToggle");o(this,"btnAutoPlunge");o(this,"btnMissionReset");o(this,"btnAdvancedSettings");o(this,"lastRadius",0);this.model=t,this.model.addListener(this),this.elRadius=e.querySelector("#hud_radius"),this.elRadiusRs=e.querySelector("#hud_radius_rs"),this.elSpeed=e.querySelector("#hud_speed"),this.elGForce=e.querySelector("#hud_gforce"),this.elGlobalTime=e.querySelector("#hud_global_time"),this.elLocalTime=e.querySelector("#hud_local_time"),this.elTimeDilation=e.querySelector("#hud_time_dilation"),this.elProjMode=e.querySelector("#hud_proj_mode"),this.elWarningBanner=e.querySelector("#nasa_warning_banner"),this.canvas=e.querySelector("#hud_radar_canvas");const i=this.canvas.getContext("2d");if(!i)throw new Error("NASA HUD: Canvas context 2D not supported");this.ctx=i,this.btnProjToggle=e.querySelector("#btn_projection_toggle"),this.btnAutoPlunge=e.querySelector("#btn_auto_plunge"),this.btnMissionReset=e.querySelector("#btn_mission_reset"),this.btnAdvancedSettings=e.querySelector("#btn_advanced_settings"),this.initEventListeners(),this.onSettingsChange(),this.onOrbitChange()}initEventListeners(){this.btnProjToggle&&this.btnProjToggle.addEventListener("click",()=>{const e=this.model.nasaFisheye.getValue();this.model.nasaFisheye.setValue(!e)}),this.btnAutoPlunge&&this.btnAutoPlunge.addEventListener("click",()=>{this.triggerAutoPlunge()}),this.btnMissionReset&&this.btnMissionReset.addEventListener("click",()=>{this.resetToStableOrbit()}),this.btnAdvancedSettings&&this.btnAdvancedSettings.addEventListener("click",()=>{const e=document.querySelector("#settings_panel");if(e){const t=e.style.display==="none";e.style.display=t?"block":"none",this.btnAdvancedSettings.textContent=t?"HIDE CONTROL PANEL":"SHOW CONTROL PANEL"}})}triggerAutoPlunge(){this.model.setState("STOPPED"),this.model.startRadius.setValue(25),this.model.startSpeed.setValue(.12),this.model.startDirection.setValue(-130*Math.PI/180),this.model.orbitInclination.setValue(35*Math.PI/180),this.model.blackHoleMass.setIndex(this.model.blackHoleMass.getSize()-1),this.model.nasaFisheye.setValue(!1),this.model.setState("PLAYING")}resetToStableOrbit(){this.model.setState("STOPPED"),this.model.startRadius.setValue(6),this.model.startSpeed.setValue(.33),this.model.startDirection.setValue(90*Math.PI/180),this.model.nasaFisheye.setValue(!1),this.model.setState("PLAYING")}onSettingsChange(){const e=this.model.nasaFisheye.getValue();this.btnProjToggle&&(this.btnProjToggle.textContent=e?"ACTIVATE PERSPECTIVE":"ACTIVATE 360° FISH-EYE"),this.elProjMode&&(this.elProjMode.textContent=e?"360° EQUIDISTANT":"PERSPECTIVE")}onOrbitChange(){const e=this.model.r,t=this.model.speedMetersPerSecond/Z,i=this.model.gForce,r=this.model.globalElapsedTimeSeconds,n=this.model.localElapsedTimeSeconds,a=this.model.timeDilationFactor,c=this.model.nasaFisheye.getValue(),s=e*127e5;this.elRadius&&(this.elRadius.textContent=s>=1e6?`${(s/1e6).toFixed(2)}M km`:`${s.toLocaleString(void 0,{maximumFractionDigits:0})} km`),this.elRadiusRs&&(this.elRadiusRs.textContent=`${e.toFixed(3)} r_s`),this.elSpeed&&(this.elSpeed.textContent=`${t.toFixed(4)} c (${(t*299792.458).toLocaleString(void 0,{maximumFractionDigits:0})} km/s)`),this.elGForce&&(this.elGForce.textContent=i>=1e6?`${(i/1e6).toFixed(2)}M g`:`${i.toLocaleString(void 0,{maximumFractionDigits:1})} g`),this.elGlobalTime&&(this.elGlobalTime.textContent=`${r.toFixed(2)} s`),this.elLocalTime&&(this.elLocalTime.textContent=`${n.toFixed(2)} s`),this.elTimeDilation&&(this.elTimeDilation.textContent=a>1e3?"∞ (Frozen)":a.toFixed(3)),this.model.state===q.PLAYING&&e<=4&&this.lastRadius>4&&!c&&this.model.nasaFisheye.setValue(!0),this.lastRadius=e,this.elWarningBanner&&(this.elWarningBanner.className="hud-warning-banner",e<=1.01?(this.elWarningBanner.textContent="[ CRITICAL ERROR: SIGNAL LOST / BEYOND EVENT HORIZON ]",this.elWarningBanner.classList.add("hud-warning-active")):e<1.1?(this.elWarningBanner.textContent="[ CRITICAL: EVENT HORIZON CROSSING IMMINENT ]",this.elWarningBanner.classList.add("hud-warning-active")):e<1.5?(this.elWarningBanner.textContent="[ WARNING: INSIDE THE PHOTON SPHERE ]",this.elWarningBanner.classList.add("hud-warning-warn")):e<3?(this.elWarningBanner.textContent="[ WARNING: PASSING ISCO LIMIT ]",this.elWarningBanner.classList.add("hud-warning-warn")):(this.elWarningBanner.textContent="[ STATUS: SYSTEM OPERATIONAL ]",this.elWarningBanner.classList.add("hud-hidden"))),this.drawRadar()}drawRadar(){const e=this.ctx,t=this.canvas.width,i=this.canvas.height,r=t/2,n=i/2;e.clearRect(0,0,t,i),e.strokeStyle="rgba(0, 229, 255, 0.08)",e.lineWidth=1,e.beginPath(),e.arc(r,n,r*.9,0,2*Math.PI),e.arc(r,n,r*.6,0,2*Math.PI),e.arc(r,n,r*.3,0,2*Math.PI),e.stroke(),e.beginPath(),e.moveTo(0,n),e.lineTo(t,n),e.moveTo(r,0),e.lineTo(r,i),e.stroke();const c=r*.85/25;e.fillStyle="#000000",e.strokeStyle="#ff3d00",e.lineWidth=2,e.beginPath(),e.arc(r,n,1*c,0,2*Math.PI),e.fill(),e.stroke(),e.strokeStyle="#ffc400",e.lineWidth=1,e.setLineDash([4,4]),e.beginPath(),e.arc(r,n,1.5*c,0,2*Math.PI),e.stroke(),e.setLineDash([]);const u=e.createRadialGradient(r,n,3*c,r,n,12*c);u.addColorStop(0,"rgba(255, 61, 0, 0.45)"),u.addColorStop(.2,"rgba(255, 196, 0, 0.25)"),u.addColorStop(1,"rgba(255, 196, 0, 0.0)"),e.fillStyle=u,e.beginPath(),e.arc(r,n,12*c,0,2*Math.PI),e.arc(r,n,3*c,0,2*Math.PI,!0),e.fill();const s=this.model.phi,p=this.model.r,l=r+p*Math.cos(s)*c,g=n-p*Math.sin(s)*c,_=Math.floor(Date.now()/300)%2===0;e.fillStyle=_?"#00e5ff":"rgba(0, 229, 255, 0.3)",e.shadowColor="#00e5ff",e.shadowBlur=8,e.beginPath(),e.arc(l,g,5,0,2*Math.PI),e.fill(),e.shadowBlur=0,e.strokeStyle="rgba(0, 229, 255, 0.7)",e.lineWidth=1.5,e.beginPath(),e.moveTo(r,n),e.lineTo(l,g),e.stroke(),e.font='8px "Courier New", monospace',e.fillStyle="#ff3d00",e.fillText("HORIZON",r-20,n+3),e.fillStyle="#ffc400",e.fillText("PHOTON SPHERE",r+1.5*c+4,n+3),e.fillStyle="#88a",e.fillText("ISCO DISK",r+3*c+4,n-8)}}const D=9,K=`
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
`,P=[600,[[.537425,.0200663,.00720805,.00159719,907315e-9,275641e-9],[.102792,.0185013,.00291111,519003e-9,519003e-9,519003e-9],[.0704669,.0181097,.00232751,.00232751,.0015737,.0015737],[.0117432,.0117432,.00226476,.00154524,.00116041,.00116041],[.00746695,.00746695,.00171226,.00104832,766638e-9,766638e-9],[.00478257,.00478257,.00100513,818812e-9,397319e-9,397319e-9],[.0037712,.0037712,490892e-9,490892e-9,490892e-9,490892e-9],[.00108603,.00108603,924505e-9,924505e-9,141375e-9,0],[604275e-9,604275e-9,604275e-9,604275e-9,604275e-9,604275e-9]],800,[[.368483,.0216534,.00816305,.00188928,.00108659,3135e-7],[.136249,.0234538,.0044714,35596e-8,35596e-8,35596e-8],[.115467,.0273797,.00361202,.00361202,.0024381,.0024381],[.0185586,.0185586,.00364918,.00244913,.00186549,.00186549],[.0120676,.0120676,.00279834,.00169769,.00125113,.00125113],[.00782081,.00782081,.00165563,.00133947,653398e-9,653398e-9],[.00620986,.00620986,8107e-7,8107e-7,8107e-7,8107e-7],[.0017856,.0017856,.00153169,.00153169,231589e-9,0],[999842e-9,999842e-9,999842e-9,999842e-9,999842e-9,999842e-9]],1e3,[[.256172,.0203539,.00797156,.00192098,.00111651,302982e-9],[.153181,.0252457,.0056879,524724e-10,524724e-10,524724e-10],[.154089,.0348566,.00470551,.00470551,.00317819,.00317819],[.0246407,.0246407,.00494194,.00326092,.00251954,.00251954],[.0163845,.0163845,.00384115,.00230972,.00171517,.00171517],[.010743,.010743,.00229079,.00184054,902617e-9,902617e-9],[.00858938,.00858938,.00112463,.00112463,.00112463,.00112463],[.00246603,.00246603,.0021316,.0021316,318642e-9,0],[.00138965,.00138965,.00138965,.00138965,.00138965,.00138965]],1200,[[.183275,.0181576,.00737853,.00184847,.00110057,302961e-9],[.155444,.026573,.00631122,0,0,0],[.175386,.0406837,.00558637,.00558637,.00379344,.00379344],[.0298822,.0298822,.00611926,.00396558,.00310871,.00310871],[.0203221,.0203221,.00481554,.00287054,.00214781,.00214781],[.0134794,.0134794,.00289524,.00230992,.00113896,.00113896],[.0108519,.0108519,.00142504,.00142504,.00142504,.00142504],[.00311065,.00311065,.0027096,.0027096,400402e-9,0],[.00176416,.00176416,.00176416,.00176416,.00176416,.00176416]],1400,[[.13507,.015829,.00665188,.0017314,.00105678,303019e-9],[.150222,.0270593,.00654101,0,0,0],[.188342,.0450054,.00639373,.0062499,.00430739,.00430739],[.034393,.034393,.00718937,.00457886,.00363942,.00363942],[.0239205,.0239205,.00572745,.00338534,.00255211,.00255211],[.016048,.016048,.00347179,.00275076,.00136368,.00136368],[.013009,.013009,.00171332,.00171332,.00171332,.00171332],[.00372297,.00372297,.00326808,.00326808,477361e-9,0],[.00212503,.00212503,.00212503,.00212503,.00212503,.00212503]],1600,[[.102246,.013671,.00592138,.00159768,.00100127,299669e-9],[.14157,.026801,.00657111,0,0,0],[.19617,.0482116,.00708177,.0067665,.00473424,.00473424],[.0382986,.0382986,.00816852,.00511466,.00412131,.00412131],[.0272343,.0272343,.00658764,.00386174,.00293299,.00293299],[.0184784,.0184784,.00402643,.00316811,.00157908,.00157908],[.0150825,.0150825,.00199223,.00199223,.00199223,.00199223],[.00430923,.00430923,.00381212,.00381212,55036e-8,0],[.00247558,.00247558,.00247558,.00247558,.00247558,.00247558]]];class Q{constructor(e,t,i,r){o(this,"device");o(this,"canvasFormat");o(this,"width");o(this,"height");o(this,"numLevels");o(this,"linearSampler");o(this,"shaderModule");o(this,"downsampleUniformBuffers",[]);o(this,"bloomUniformBuffers",[]);o(this,"upsampleUniformBuffers",[]);o(this,"renderUniformBuffer");o(this,"downsampleBindGroupLayout");o(this,"bloomBindGroupLayout");o(this,"upsampleBindGroupLayout");o(this,"renderBindGroupLayout");o(this,"downsamplePipeline");o(this,"bloomPipeline");o(this,"upsamplePipeline");o(this,"renderPipeline");o(this,"downsampleBindGroups",[]);o(this,"bloomBindGroups",[]);o(this,"upsampleBindGroups",[]);o(this,"bloomFilters",[]);o(this,"mipmapTextures",[]);o(this,"filterTextures",[]);o(this,"depthTexture",null);this.device=e,this.canvasFormat=t,this.width=i,this.height=r,this.numLevels=0,this.linearSampler=e.createSampler({addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge",minFilter:"linear",magFilter:"linear"}),this.shaderModule=e.createShaderModule({label:"BloomShaders",code:K}),this.downsampleUniformBuffers=[],this.bloomUniformBuffers=[],this.upsampleUniformBuffers=[];for(let a=0;a<D;++a)this.downsampleUniformBuffers.push(e.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})),this.bloomUniformBuffers.push(e.createBuffer({size:416,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST})),this.upsampleUniformBuffers.push(e.createBuffer({size:16,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));this.renderUniformBuffer=e.createBuffer({size:432,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.downsampleBindGroupLayout=e.createBindGroupLayout({label:"BloomDownsampleBindGroupLayout",entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}}]}),this.bloomBindGroupLayout=e.createBindGroupLayout({label:"BloomFilterBindGroupLayout",entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}}]}),this.upsampleBindGroupLayout=e.createBindGroupLayout({label:"BloomUpsampleBindGroupLayout",entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}}]}),this.renderBindGroupLayout=e.createBindGroupLayout({label:"BloomRenderBindGroupLayout",entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}}]});const n=a=>e.createPipelineLayout({bindGroupLayouts:[a]});this.downsamplePipeline=e.createRenderPipeline({label:"BloomDownsamplePipeline",layout:n(this.downsampleBindGroupLayout),vertex:{module:this.shaderModule,entryPoint:"vert_main"},fragment:{module:this.shaderModule,entryPoint:"downsample_main",targets:[{format:"rgba16float"}]},primitive:{topology:"triangle-strip"}}),this.bloomPipeline=e.createRenderPipeline({label:"BloomFilterPipeline",layout:n(this.bloomBindGroupLayout),vertex:{module:this.shaderModule,entryPoint:"vert_main"},fragment:{module:this.shaderModule,entryPoint:"bloom_main",targets:[{format:"rgba16float"}]},primitive:{topology:"triangle-strip"}}),this.upsamplePipeline=e.createRenderPipeline({label:"BloomUpsamplePipeline",layout:n(this.upsampleBindGroupLayout),vertex:{module:this.shaderModule,entryPoint:"vert_main"},fragment:{module:this.shaderModule,entryPoint:"upsample_main",targets:[{format:"rgba16float",blend:{color:{srcFactor:"one",dstFactor:"one",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one",operation:"add"}}}]},primitive:{topology:"triangle-strip"}}),this.renderPipeline=e.createRenderPipeline({label:"BloomRenderPipeline",layout:n(this.renderBindGroupLayout),vertex:{module:this.shaderModule,entryPoint:"vert_main"},fragment:{module:this.shaderModule,entryPoint:"render_main",targets:[{format:this.canvasFormat}]},primitive:{topology:"triangle-strip"}}),this.mipmapTextures=[],this.filterTextures=[],this.depthTexture=null,this.resize(i,r)}resize(e,t){if(this.width=e,this.height=t,this.mipmapTextures.length>0){for(let s of this.mipmapTextures)s&&s.destroy();for(let s of this.filterTextures)s&&s.destroy();this.depthTexture&&this.depthTexture.destroy()}this.mipmapTextures=[],this.filterTextures=[];let i=0,r=e,n=t;for(;n>2&&i<D;){const s=r+2,p=n+2,l=this.device.createTexture({label:`BloomMipmapTexture_Level${i}`,size:[s,p,1],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});if(this.mipmapTextures.push(l),i>0){const g=this.device.createTexture({label:`BloomFilterTexture_Level${i}`,size:[r,n,1],format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT});this.filterTextures.push(g)}else this.filterTextures.push(null);i+=1,r=Math.ceil(r/2),n=Math.ceil(n/2)}this.numLevels=i,this.depthTexture=this.device.createTexture({label:"BloomDepthTexture",size:[this.mipmapTextures[0].width,this.mipmapTextures[0].height,1],format:"depth24plus",usage:GPUTextureUsage.RENDER_ATTACHMENT}),this.bloomFilters=[];let a=0,c=P[a];for(let s=2;s<P.length;s+=2){const p=P[s];Math.abs(p-t)<Math.abs(c-t)&&(a=s,c=p)}const u=P[a+1];for(let s=0;s<this.numLevels;++s){const p=[],l=this.mipmapTextures[s].width,g=this.mipmapTextures[s].height;for(let _=-2;_<=2;++_){const x=Math.abs(_);for(let d=-2;d<=2;++d){const f=Math.abs(d),m=f<x?x*(x+1)/2+f:f*(f+1)/2+x,v=u[s][m];p.push(d/l,_/g,v,0)}}this.bloomFilters.push(new Float32Array(p))}this.createBindGroups()}createBindGroups(){this.downsampleBindGroups=[],this.bloomBindGroups=[],this.upsampleBindGroups=[];for(let e=1;e<this.numLevels;++e){const t=this.device.createBindGroup({layout:this.downsampleBindGroupLayout,entries:[{binding:0,resource:this.mipmapTextures[e-1].createView()},{binding:1,resource:this.linearSampler},{binding:2,resource:{buffer:this.downsampleUniformBuffers[e]}}]});this.downsampleBindGroups[e]=t}for(let e=1;e<this.numLevels;++e){const t=this.device.createBindGroup({layout:this.bloomBindGroupLayout,entries:[{binding:0,resource:this.mipmapTextures[e].createView()},{binding:1,resource:this.linearSampler},{binding:2,resource:{buffer:this.bloomUniformBuffers[e]}}]});this.bloomBindGroups[e]=t}for(let e=1;e<this.numLevels-1;++e){const t=this.filterTextures[e+1];if(!t)continue;const i=this.device.createBindGroup({layout:this.upsampleBindGroupLayout,entries:[{binding:0,resource:t.createView()},{binding:1,resource:this.linearSampler},{binding:2,resource:{buffer:this.upsampleUniformBuffers[e]}}]});this.upsampleBindGroups[e]=i}}begin(){return this.mipmapTextures[0].createView()}end(e,t,i,r,n){for(let d=1;d<this.numLevels;++d){const f=this.mipmapTextures[d-1].width,m=this.mipmapTextures[d-1].height,v=new Float32Array([1/f,1/m,0,0]);this.device.queue.writeBuffer(this.downsampleUniformBuffers[d],0,v)}for(let d=1;d<this.numLevels;++d){const f=this.mipmapTextures[d].width,m=this.mipmapTextures[d].height,v=new Float32Array(104);v[0]=1/f,v[1]=1/m,v.set(this.bloomFilters[d],4),this.device.queue.writeBuffer(this.bloomUniformBuffers[d],0,v)}for(let d=this.numLevels-2;d>=1;--d){const f=this.filterTextures[d+1];if(!f)continue;const m=f.width,v=f.height,b=new Float32Array([1/m,1/v,0,0]);this.device.queue.writeBuffer(this.upsampleUniformBuffers[d],0,b)}const a=this.mipmapTextures[0].width,c=this.mipmapTextures[0].height,u=this.filterTextures[1];if(!u)return;const s=u.width,p=u.height,l=new Float32Array(108);l[0]=1/a,l[1]=1/c,l[2]=1/s,l[3]=1/p,l[4]=i,l[5]=r;const g=new Uint32Array(l.buffer);g[6]=n?1:0,g[7]=0,this.numLevels>0&&l.set(this.bloomFilters[0],8),this.device.queue.writeBuffer(this.renderUniformBuffer,0,l);for(let d=1;d<this.numLevels;++d){const f=this.mipmapTextures[d].width-2,m=this.mipmapTextures[d].height-2,v=e.beginRenderPass({label:`BloomDownsamplePass_Level${d}`,colorAttachments:[{view:this.mipmapTextures[d].createView(),loadOp:"clear",clearValue:{r:0,g:0,b:0,a:1},storeOp:"store"}]});v.setPipeline(this.downsamplePipeline),v.setBindGroup(0,this.downsampleBindGroups[d]),v.setViewport(1,1,f,m,0,1),v.draw(4,1,0,0),v.end()}for(let d=1;d<this.numLevels;++d){const f=this.filterTextures[d];if(!f)continue;const m=f.width,v=f.height,b=e.beginRenderPass({label:`BloomFilterPass_Level${d}`,colorAttachments:[{view:f.createView(),loadOp:"clear",clearValue:{r:0,g:0,b:0,a:1},storeOp:"store"}]});b.setPipeline(this.bloomPipeline),b.setBindGroup(0,this.bloomBindGroups[d]),b.setViewport(0,0,m,v,0,1),b.draw(4,1,0,0),b.end()}for(let d=this.numLevels-2;d>=1;--d){const f=this.filterTextures[d];if(!f)continue;const m=f.width,v=f.height,b=e.beginRenderPass({label:`BloomUpsamplePass_Level${d}`,colorAttachments:[{view:f.createView(),loadOp:"load",storeOp:"store"}]});b.setPipeline(this.upsamplePipeline),b.setBindGroup(0,this.upsampleBindGroups[d]),b.setViewport(0,0,m,v,0,1),b.draw(4,1,0,0),b.end()}const _=this.device.createBindGroup({label:"BloomCompositeBindGroup",layout:this.renderBindGroupLayout,entries:[{binding:0,resource:this.mipmapTextures[0].createView()},{binding:1,resource:this.linearSampler},{binding:2,resource:{buffer:this.renderUniformBuffer}},{binding:3,resource:u.createView()}]}),x=e.beginRenderPass({label:"BloomCompositePass",colorAttachments:[{view:t,loadOp:"clear",clearValue:{r:0,g:0,b:0,a:1},storeOp:"store"}]});x.setPipeline(this.renderPipeline),x.setBindGroup(0,_),x.setViewport(0,0,this.width,this.height,0,1),x.draw(4,1,0,0),x.end()}}const S=6,F=function(h){return h.startsWith("http://")||h.startsWith("https://")?h:"/black-hole/"+h},M=function(h,e){const t=new XMLHttpRequest;t.open("GET",F(h)),t.responseType="arraybuffer",t.onload=()=>{if(t.status!==200){console.error("XHR Failed to load Float data:",h,"status:",t.status);return}try{const i=new DataView(t.response),r=new Float32Array(i.byteLength/Float32Array.BYTES_PER_ELEMENT);for(let n=0;n<r.length;++n)r[n]=i.getFloat32(n*Float32Array.BYTES_PER_ELEMENT,!0);e(r)}catch(i){console.error("Error parsing Float data:",h,i)}},t.onerror=i=>{console.error("XHR Network Error loading:",h,i)},t.send()},J=function(h,e){const t=new XMLHttpRequest;t.open("GET",F(h)),t.responseType="arraybuffer",t.onload=()=>{if(t.status!==200){console.error("XHR Failed to load Int data:",h,"status:",t.status);return}try{const i=new DataView(t.response),r=new Uint32Array(i.byteLength/Uint32Array.BYTES_PER_ELEMENT);for(let n=0;n<r.length;++n)r[n]=i.getUint32(n*Uint32Array.BYTES_PER_ELEMENT,!0);e(r)}catch(i){console.error("Error parsing Int data:",h,i)}},t.onerror=i=>{console.error("XHR Network Error loading:",h,i)},t.send()},R=function(h,e,t,i,r,n,a,c,u){const s=n*u;if(s%256===0||a<=1)h.queue.writeTexture({texture:e,mipLevel:t,origin:i},r,{bytesPerRow:s,rowsPerImage:a},[n,a,c]);else{const p=Math.ceil(s/256)*256,l=p/r.BYTES_PER_ELEMENT,g=s/r.BYTES_PER_ELEMENT,_=l*a*c,x=new r.constructor(_);for(let d=0;d<c;++d)for(let f=0;f<a;++f){const m=d*g*a+f*g,v=d*l*a+f*l;x.set(r.subarray(m,m+g),v)}h.queue.writeTexture({texture:e,mipLevel:t,origin:i},x,{bytesPerRow:p,rowsPerImage:a},[n,a,c])}};class ee{constructor(e,t){o(this,"loadingPanel");o(this,"loadingBar");o(this,"device");o(this,"rayDeflectionTexture",null);o(this,"rayInverseRadiusTexture",null);o(this,"blackbodyTexture",null);o(this,"dopplerTexture",null);o(this,"gridTexture",null);o(this,"galaxyTexture",null);o(this,"starTexture",null);o(this,"starTexture2",null);o(this,"noiseTexture",null);o(this,"linearSampler");o(this,"nearestSampler");o(this,"tilesQueue",[]);o(this,"numTilesLoaded",0);o(this,"numTilesLoadedPerLevel",[0,0,0,0,0]);o(this,"numPendingRequests",0);const i=e.querySelector("#cv_loading_panel"),r=e.querySelector("#cv_loading_bar");if(!i)throw new Error("cv_loading_panel not found");if(!r)throw new Error("cv_loading_bar not found");this.loadingPanel=i,this.loadingBar=r,this.device=t,this.linearSampler=t.createSampler({label:"TextureManagerLinearSampler",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge",minFilter:"linear",magFilter:"linear",mipmapFilter:"linear"}),this.nearestSampler=t.createSampler({label:"TextureManagerNearestSampler",addressModeU:"clamp-to-edge",addressModeV:"clamp-to-edge",minFilter:"nearest",magFilter:"nearest"}),this.loadTextures(),this.loadStarTextures(),this.loadNoiseTexture("noise_texture.png"),document.body.addEventListener("keypress",n=>this.onKeyPress(n))}loadTextures(){const e=this.device;M("deflection.dat",t=>{const i=Math.round(t[0]),r=Math.round(t[1]);this.rayDeflectionTexture=e.createTexture({size:[i,r,1],format:"rg32float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),e.queue.writeTexture({texture:this.rayDeflectionTexture},t.subarray(2),{bytesPerRow:i*8,rowsPerImage:r},[i,r,1])}),M("inverse_radius.dat",t=>{const i=Math.round(t[0]),r=Math.round(t[1]);this.rayInverseRadiusTexture=e.createTexture({size:[i,r,1],format:"rg32float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),e.queue.writeTexture({texture:this.rayInverseRadiusTexture},t.subarray(2),{bytesPerRow:i*8,rowsPerImage:r},[i,r,1])}),this.dopplerTexture=e.createTexture({size:[64,32,64],dimension:"3d",format:"rgba32float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),M("doppler.dat",t=>{const i=new Float32Array(524288);for(let r=0;r<2048*64;++r)i[r*4]=t[r*3],i[r*4+1]=t[r*3+1],i[r*4+2]=t[r*3+2],i[r*4+3]=1;e.queue.writeTexture({texture:this.dopplerTexture},i,{bytesPerRow:1024,rowsPerImage:32},[64,32,64])}),this.blackbodyTexture=e.createTexture({size:[128,1,1],format:"rgba32float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),M("black_body.dat",t=>{const i=new Float32Array(512);for(let r=0;r<128;++r)i[r*4]=t[r*3],i[r*4+1]=t[r*3+1],i[r*4+2]=t[r*3+2],i[r*4+3]=1;e.queue.writeTexture({texture:this.blackbodyTexture},i,{bytesPerRow:2048,rowsPerImage:1},[128,1,1])}),this.gridTexture=e.createTexture({size:[512,512,6],mipLevelCount:10,format:"r8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});for(let t=0;t<10;++t){const i=512>>t,r=new Uint8Array(i*i),n=i/512;for(let a=0;a<i;++a){const c=Math.floor((a/n+2)%32);for(let u=0;u<i;++u){const s=Math.floor((u/n+2)%32);r[u+a*i]=s<4||c<4?255:0}}for(let a=0;a<6;++a)R(e,this.gridTexture,t,{x:0,y:0,z:a},r,i,i,1,1)}}loadStarTextures(){const e=this.device;this.galaxyTexture=e.createTexture({size:[2048,2048,6],mipLevelCount:12,format:"rgb9e5ufloat",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),this.starTexture=e.createTexture({size:[2048,2048,6],mipLevelCount:S+1,format:"rgb9e5ufloat",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});const t=2048/(1<<S+1);this.starTexture2=e.createTexture({size:[t,t,6],mipLevelCount:11-S,format:"rgb9e5ufloat",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});const i="gaia_sky_map",r=["pos-x","neg-x","pos-y","neg-y","pos-z","neg-z"];for(let n=0;n<=4;++n){const a=2048/(1<<n),c=Math.min(256,a),u=a/c;for(let s=0;s<6;++s)for(let p=0;p<u;++p)for(let l=0;l<u;++l){const g=`${i}/${r[s]}-${n}-${l}-${p}.dat`;this.tilesQueue.push({l:n,ti:l,tj:p,i:s,url:g})}}this.updateLoadingBar(),this.loadStarTextureTiles()}loadStarTextureTiles(){for(;this.tilesQueue.length>0&&this.numPendingRequests<6;){const e=this.tilesQueue.pop();e&&this.loadStarTextureTile(e.l,e.ti,e.tj,e.i,e.url)}}loadStarTextureTile(e,t,i,r,n){const a=this.device,c=2048/(1<<e);J(n,u=>{let s=0,p=e,l=Math.min(256,c);for(;s<u.length;)R(a,this.galaxyTexture,p,{x:t*l,y:i*l,z:r},u.subarray(s,s+l*l),l,l,1,4),s+=l*l,p<=S?R(a,this.starTexture,p,{x:t*l,y:i*l,z:r},u.subarray(s,s+l*l),l,l,1,4):R(a,this.starTexture2,p-(S+1),{x:t*l,y:i*l,z:r},u.subarray(s,s+l*l),l,l,1,4),s+=l*l,p+=1,l/=2;this.numTilesLoaded+=1,e<=S&&(this.numTilesLoadedPerLevel[e]+=1),this.numPendingRequests-=1,this.updateLoadingBar(),this.loadStarTextureTiles()}),this.numPendingRequests+=1}loadNoiseTexture(e){const t=this.device,i=new Image;i.addEventListener("load",async()=>{const r=await createImageBitmap(i);this.noiseTexture=t.createTexture({size:[r.width,r.height,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT}),t.queue.copyExternalImageToTexture({source:r},{texture:this.noiseTexture},[r.width,r.height])}),i.src="/black-hole/"+e}updateLoadingBar(){this.loadingBar.style.width=`${this.numTilesLoaded/516*100}%`,this.numTilesLoaded==516&&this.loadingPanel.classList.toggle("cv-loaded",!0)}getMinLoadedStarTextureLod(){return this.numTilesLoadedPerLevel[0]==384?0:this.numTilesLoadedPerLevel[1]==96?1:this.numTilesLoadedPerLevel[2]==24?2:this.numTilesLoadedPerLevel[3]==6?3:4}onKeyPress(e){e.key==" "&&this.loadingPanel.classList.toggle("cv-hidden")}}class te{constructor(e,t,i){o(this,"textureManager");o(this,"device");o(this,"shaderModule",null);this.textureManager=t,this.device=i,this.shaderModule=null}getProgram(){if(!this.textureManager.rayDeflectionTexture||!this.textureManager.rayInverseRadiusTexture)return null;if(!this.shaderModule){const e=document.querySelector("#black_hole_shader");if(!e)return console.error("ShaderManager: #black_hole_shader element not found in DOM!"),null;const t=e.textContent||"";this.shaderModule=this.device.createShaderModule({label:"BlackHoleShader",code:t}),this.shaderModule.getCompilationInfo().then(i=>{if(i.messages.length>0){const r=i.messages.filter(n=>n.type==="error");if(r.length>0){console.error("ShaderManager WGSL compile error: "+r[0].message);const n=document.querySelector("#cv_error_panel");n&&(n.innerHTML="WGSL Compile Error: "+r[0].message+" at line "+r[0].lineNum,n.classList.toggle("cv-hidden",!1))}}})}return this.shaderModule}}const G=.1,U=100,B=7,E=1<<B-1,I=.514,A=-20,N=-2.1,re=`
struct VertexOutput {
  @builtin(position) Position: vec4<f32>,
  @location(0) uv: vec2<f32>,
};

@vertex
fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  // Generate a full-screen quad from a single triangle index.
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
`,ne=function(h,e){const t=new XMLHttpRequest;t.open("GET","/black-hole/"+h),t.responseType="arraybuffer",t.onload=()=>{if(t.status!==200){console.error("Failed to load rocket mesh binary:",h,"status:",t.status);return}const i=new DataView(t.response),r=i.getUint32(0,!0),n=i.getUint32(Uint32Array.BYTES_PER_ELEMENT,!0);let a=2*Uint32Array.BYTES_PER_ELEMENT;const c=new Float32Array(r);for(let s=0;s<r;++s)c[s]=i.getFloat32(s*Float32Array.BYTES_PER_ELEMENT+a,!0);a+=r*Float32Array.BYTES_PER_ELEMENT;const u=new Uint32Array(n);for(let s=0;s<n;++s)u[s]=i.getUint32(s*Uint32Array.BYTES_PER_ELEMENT+a,!0);e(c,u)},t.send()},L=function(h,e){const t=h.createTexture({size:[1,1,1],format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST}),i=new Uint8Array([255,255,255,255]);h.queue.writeTexture({texture:t},i,{bytesPerRow:4},[1,1,1]);const r={texture:t},n=new Image;return n.addEventListener("load",async()=>{try{const a=await createImageBitmap(n),c=Math.floor(Math.log2(Math.max(a.width,a.height)))+1,u=h.createTexture({label:e,size:[a.width,a.height,1],mipLevelCount:c,format:"rgba8unorm",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT}),s=document.createElement("canvas"),p=s.getContext("2d");if(!p)throw new Error("Could not get 2D context");let l=a.width,g=a.height,_=0;for(;l>=1&&g>=1;){s.width=l,s.height=g,p.drawImage(a,0,0,l,g);const x=await createImageBitmap(s);if(h.queue.copyExternalImageToTexture({source:x},{texture:u,mipLevel:_},[l,g]),l===1&&g===1)break;l=Math.max(1,Math.floor(l/2)),g=Math.max(1,Math.floor(g/2)),_++}r.texture=u}catch(a){console.error("Failed to load/generate mipmaps for rocket texture:",e,a)}}),n.src="/black-hole/"+e,r};class ie{constructor(e,t){o(this,"model");o(this,"cameraView");o(this,"device");o(this,"rocketUniformBuffer");o(this,"exhaustUniformBuffer");o(this,"envMapUniformBuffers",[]);o(this,"baseColorTextureWrapper");o(this,"occlusionRoughnessMetallicTextureWrapper");o(this,"normalMapTextureWrapper");o(this,"envMapBindGroups",null);o(this,"cachedEnvMapSkyTexture",null);o(this,"rocketVertexBuffer",null);o(this,"rocketIndexBuffer",null);o(this,"rocketIndexCount",0);o(this,"exhaustVertexBuffer",null);o(this,"exhaustIndexBuffer",null);o(this,"exhaustIndexCount",0);o(this,"envMapTexture");o(this,"rocketBindGroupLayout");o(this,"rocketPipeline");o(this,"exhaustBindGroupLayout");o(this,"exhaustPipelineFront");o(this,"exhaustPipelineBack");o(this,"mipmapBindGroupLayout");o(this,"mipmapPipeline");o(this,"exhaustBindGroup");o(this,"rocketBindGroup",null);o(this,"cachedBaseColor",null);o(this,"cachedMetallic",null);o(this,"cachedNormal",null);this.model=e,this.cameraView=t,this.device=t.device,this.rocketUniformBuffer=this.device.createBuffer({size:80,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.exhaustUniformBuffer=this.device.createBuffer({size:128,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.envMapUniformBuffers=[];for(let i=0;i<6;++i)this.envMapUniformBuffers.push(this.device.createBuffer({size:432,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}));this.baseColorTextureWrapper=L(this.device,"rocket_base_color.png"),this.occlusionRoughnessMetallicTextureWrapper=L(this.device,"rocket_occlusion_roughness_metallic.png"),this.normalMapTextureWrapper=L(this.device,"rocket_normal.png"),this.envMapBindGroups=null,this.cachedEnvMapSkyTexture=null,this.rocketVertexBuffer=null,this.rocketIndexBuffer=null,this.rocketIndexCount=0,this.exhaustVertexBuffer=null,this.exhaustIndexBuffer=null,this.exhaustIndexCount=0,this.createEnvMapTexture(),this.createRocketPipeline(),this.createExhaustPipeline(),this.createMipmapPipeline(),ne("rocket.dat",(i,r)=>this.createRocketBuffers(i,r)),this.createExhaustBuffers()}createEnvMapTexture(){this.envMapTexture=this.device.createTexture({label:"RocketEnvMapCubeTexture",size:[E,E,6],mipLevelCount:B,format:"rgba16float",usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.RENDER_ATTACHMENT})}createRocketPipeline(){this.rocketBindGroupLayout=this.device.createBindGroupLayout({label:"RocketBindGroupLayout",entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:5,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"cube"}}]});const e=document.querySelector("#rocket_shader");if(!e)throw new Error("rocket_shader script element not found");const t=this.device.createShaderModule({label:"RocketShader",code:e.textContent||""});this.rocketPipeline=this.device.createRenderPipeline({label:"RocketPipeline",layout:this.device.createPipelineLayout({bindGroupLayouts:[this.rocketBindGroupLayout]}),vertex:{module:t,entryPoint:"vert_main",buffers:[{arrayStride:52,attributes:[{shaderLocation:0,offset:0,format:"float32x3"},{shaderLocation:1,offset:12,format:"float32x3"},{shaderLocation:2,offset:24,format:"float32x4"},{shaderLocation:3,offset:40,format:"float32x2"},{shaderLocation:4,offset:48,format:"float32"}]}]},fragment:{module:t,entryPoint:"frag_main",targets:[{format:"rgba16float"}]},primitive:{topology:"triangle-list",frontFace:"ccw",cullMode:"back"},depthStencil:{format:"depth24plus",depthWriteEnabled:!0,depthCompare:"less"}})}createExhaustPipeline(){this.exhaustBindGroupLayout=this.device.createBindGroupLayout({label:"ExhaustBindGroupLayout",entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}}]});const e=document.querySelector("#exhaust_shader");if(!e)throw new Error("exhaust_shader script element not found");const t=this.device.createShaderModule({label:"ExhaustShader",code:e.textContent||""}),i=this.device.createPipelineLayout({bindGroupLayouts:[this.exhaustBindGroupLayout]}),r=n=>({label:`ExhaustPipeline_${n}`,layout:i,vertex:{module:t,entryPoint:"vert_main",buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:"float32x3"}]}]},fragment:{module:t,entryPoint:"frag_main",targets:[{format:"rgba16float",blend:{color:{srcFactor:"one",dstFactor:"one",operation:"add"},alpha:{srcFactor:"one",dstFactor:"one",operation:"add"}}}]},primitive:{topology:"triangle-list",frontFace:"ccw",cullMode:n},depthStencil:{format:"depth24plus",depthWriteEnabled:!1,depthCompare:"less"}});this.exhaustPipelineFront=this.device.createRenderPipeline(r("front")),this.exhaustPipelineBack=this.device.createRenderPipeline(r("back")),this.exhaustBindGroup=this.device.createBindGroup({label:"ExhaustBindGroup",layout:this.exhaustBindGroupLayout,entries:[{binding:0,resource:{buffer:this.exhaustUniformBuffer}}]})}createMipmapPipeline(){this.mipmapBindGroupLayout=this.device.createBindGroupLayout({label:"MipmapDownsampleBindGroupLayout",entries:[{binding:0,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}}]});const e=this.device.createShaderModule({label:"MipmapShader",code:re});this.mipmapPipeline=this.device.createRenderPipeline({label:"MipmapPipeline",layout:this.device.createPipelineLayout({bindGroupLayouts:[this.mipmapBindGroupLayout]}),vertex:{module:e,entryPoint:"vert_main"},fragment:{module:e,entryPoint:"frag_main",targets:[{format:"rgba16float"}]},primitive:{topology:"triangle-strip"}})}createRocketBuffers(e,t){this.rocketVertexBuffer=this.device.createBuffer({label:"RocketVertexBuffer",size:e.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.rocketVertexBuffer,0,e),this.rocketIndexBuffer=this.device.createBuffer({label:"RocketIndexBuffer",size:t.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.rocketIndexBuffer,0,t),this.rocketIndexCount=t.length}createExhaustBuffers(){const t=new Float32Array(198);for(let r=0;r<=32;++r){const n=r==0?0:I,a=2*Math.PI*r/32;t[6*r]=n*Math.cos(a),t[6*r+1]=n*Math.sin(a),t[6*r+2]=A,t[6*r+3]=n*Math.cos(a),t[6*r+4]=n*Math.sin(a),t[6*r+5]=N}this.exhaustVertexBuffer=this.device.createBuffer({label:"ExhaustVertexBuffer",size:t.byteLength,usage:GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.exhaustVertexBuffer,0,t);const i=new Uint32Array(384);for(let r=1;r<=32;++r){const n=r%32+1;i[12*r-12]=0,i[12*r-11]=2*n,i[12*r-10]=2*r,i[12*r-9]=2*r,i[12*r-8]=2*n,i[12*r-7]=2*n+1,i[12*r-6]=2*n+1,i[12*r-5]=2*r+1,i[12*r-4]=2*r,i[12*r-3]=1,i[12*r-2]=2*r+1,i[12*r-1]=2*n+1}this.exhaustIndexBuffer=this.device.createBuffer({label:"ExhaustIndexBuffer",size:i.byteLength,usage:GPUBufferUsage.INDEX|GPUBufferUsage.COPY_DST}),this.device.queue.writeBuffer(this.exhaustIndexBuffer,0,i),this.exhaustIndexCount=i.length}getRocketBindGroup(){const e=this.cameraView.textureManager,t=this.baseColorTextureWrapper.texture,i=this.occlusionRoughnessMetallicTextureWrapper.texture,r=this.normalMapTextureWrapper.texture;return this.rocketBindGroup&&this.cachedBaseColor===t&&this.cachedMetallic===i&&this.cachedNormal===r?this.rocketBindGroup:(this.cachedBaseColor=t,this.cachedMetallic=i,this.cachedNormal=r,this.rocketBindGroup=this.device.createBindGroup({label:"RocketBindGroup",layout:this.rocketBindGroupLayout,entries:[{binding:0,resource:{buffer:this.rocketUniformBuffer}},{binding:1,resource:e.linearSampler},{binding:2,resource:t.createView()},{binding:3,resource:i.createView()},{binding:4,resource:r.createView()},{binding:5,resource:this.envMapTexture.createView({dimension:"cube"})}]}),this.rocketBindGroup)}getEnvMapBindGroups(){const e=this.cameraView.textureManager,t=this.model.grid.getValue()?e.gridTexture:e.galaxyTexture;if(!t||!e.starTexture||!e.starTexture2||!e.blackbodyTexture||!e.dopplerTexture||!e.noiseTexture)return null;if(this.envMapBindGroups&&this.cachedEnvMapSkyTexture===t)return this.envMapBindGroups;this.cachedEnvMapSkyTexture=t,this.envMapBindGroups=[];for(let i=0;i<6;++i){const r=this.device.createBindGroup({label:`RocketEnvMapBindGroup_Face${i}`,layout:this.cameraView.bindGroupLayout,entries:[{binding:0,resource:{buffer:this.envMapUniformBuffers[i]}},{binding:1,resource:e.linearSampler},{binding:2,resource:e.rayDeflectionTexture.createView()},{binding:3,resource:e.rayInverseRadiusTexture.createView()},{binding:4,resource:t.createView({dimension:"cube"})},{binding:5,resource:e.starTexture.createView({dimension:"cube"})},{binding:6,resource:e.starTexture2.createView({dimension:"cube"})},{binding:7,resource:e.blackbodyTexture.createView()},{binding:8,resource:e.dopplerTexture.createView()},{binding:9,resource:e.noiseTexture.createView()},{binding:10,resource:e.nearestSampler}]});this.envMapBindGroups.push(r)}return this.envMapBindGroups}updateEnvMapUniforms(e,t,i,r){const n=this.model,a=new Float32Array(108);a[0]=n.t,a[1]=n.r,a[2]=n.worldTheta,a[3]=n.worldPhi,a[4]=n.p[0],a[5]=n.p[1],a[6]=n.p[2],a[7]=0,a[8]=n.kS[0],a[9]=n.kS[1],a[10]=n.kS[2],a[11]=n.kS[3],a[12]=n.rocketTau[1],a[13]=n.rocketTau[2],a[14]=n.rocketTau[3],a[15]=0,a[16]=t[0],a[17]=t[1],a[18]=t[2],a[19]=0,a[20]=i[0],a[21]=i[1],a[22]=i[2],a[23]=0,a[24]=r[0],a[25]=r[1],a[26]=r[2],a[27]=0,a[28]=n.starsMatrix[0],a[29]=n.starsMatrix[3],a[30]=n.starsMatrix[6],a[31]=0,a[32]=n.starsMatrix[1],a[33]=n.starsMatrix[4],a[34]=n.starsMatrix[7],a[35]=0,a[36]=n.starsMatrix[2],a[37]=n.starsMatrix[5],a[38]=n.starsMatrix[8],a[39]=0,a[40]=32,a[41]=32,a[42]=32,a[43]=0,a[44]=n.discDensity.getValue(),a[45]=n.discOpacity.getValue(),a[46]=n.discTemperature.getValue(),a[47]=0,a[48]=n.exposure.getValue(),a[49]=n.bloom.getValue();const c=n.grid.getValue()?0:this.cameraView.textureManager.getMinLoadedStarTextureLod();a[50]=c;const u=new Uint32Array(a.buffer);u[51]=n.lensing.getValue()?1:0,u[52]=n.doppler.getValue()?1:0,u[53]=n.grid.getValue()?1:0,u[54]=n.stars.getValue()?1:0,u[55]=n.highContrast.getValue()?1:0,a[56]=n.fovY,a[57]=0,a[58]=0,a[59]=0,a.set(this.cameraView.discParticles,60),this.device.queue.writeBuffer(this.envMapUniformBuffers[e],0,a)}setCameraUniforms(e,t){const i=this.model.cameraYaw.getValue()+this.model.cameraYawOffset-this.model.rocketYaw,r=this.model.rocketDistance.getValue()/2,n=.4*r,a=-n*Math.sin(this.model.rocketYaw),c=n*Math.cos(this.model.rocketYaw),u=Math.cos(i),s=Math.sin(i),p=Math.cos(this.model.cameraPitch.getValue()),l=Math.sin(this.model.cameraPitch.getValue()),g=[[u,0,-s,u*a-s*c],[-s*l,p,-u*l,-s*l*a-u*l*c],[s*p,l,u*p,-r+s*p*a+u*p*c],[0,0,0,1]],_=1/Math.tan(this.model.fovY/2),x=this.cameraView.canvas.width/this.cameraView.canvas.height,d=-100.1/(U-G),f=-2*U*G/(U-G),m=[[_/x,0,0,0],[0,_,0,0],[0,0,d,f],[0,0,-1,0]],v=new Float32Array(16);for(let T=0;T<4;++T)for(let y=0;y<4;++y){let C=0;for(let w=0;w<4;++w)C+=m[T][w]*g[w][y];v[y*4+T]=C}e.set(v);const b=[0,0,0];for(let T=0;T<3;++T)for(let y=0;y<3;++y)b[T]-=g[y][T]*g[y][3];t[0]=b[0],t[1]=b[1],t[2]=b[2]}renderEnvMap(e){const t=this.model,i=this.getEnvMapBindGroups();if(!i)return;const r=[{eW:[-t.rocketD[1],-t.rocketD[2],-t.rocketD[3]],eH:[-t.rocketH[1],-t.rocketH[2],-t.rocketH[3]],eD:[-t.rocketW[1],-t.rocketW[2],-t.rocketW[3]]},{eW:[t.rocketD[1],t.rocketD[2],t.rocketD[3]],eH:[-t.rocketH[1],-t.rocketH[2],-t.rocketH[3]],eD:[t.rocketW[1],t.rocketW[2],t.rocketW[3]]},{eW:[t.rocketW[1],t.rocketW[2],t.rocketW[3]],eH:[t.rocketD[1],t.rocketD[2],t.rocketD[3]],eD:[-t.rocketH[1],-t.rocketH[2],-t.rocketH[3]]},{eW:[t.rocketW[1],t.rocketW[2],t.rocketW[3]],eH:[-t.rocketD[1],-t.rocketD[2],-t.rocketD[3]],eD:[t.rocketH[1],t.rocketH[2],t.rocketH[3]]},{eW:[t.rocketW[1],t.rocketW[2],t.rocketW[3]],eH:[-t.rocketH[1],-t.rocketH[2],-t.rocketH[3]],eD:[-t.rocketD[1],-t.rocketD[2],-t.rocketD[3]]},{eW:[-t.rocketW[1],-t.rocketW[2],-t.rocketW[3]],eH:[-t.rocketH[1],-t.rocketH[2],-t.rocketH[3]],eD:[t.rocketD[1],t.rocketD[2],t.rocketD[3]]}];for(let n=0;n<6;++n){this.updateEnvMapUniforms(n,r[n].eW,r[n].eH,r[n].eD);const a=e.beginRenderPass({label:`RocketEnvMapPass_Face${n}`,colorAttachments:[{view:this.envMapTexture.createView({dimension:"2d",baseMipLevel:0,mipLevelCount:1,baseArrayLayer:n,arrayLayerCount:1}),loadOp:"clear",clearValue:{r:0,g:0,b:0,a:1},storeOp:"store"}]});a.setPipeline(this.cameraView.pipeline),a.setBindGroup(0,i[n]),a.setViewport(0,0,E,E,0,1),a.draw(4,1,0,0),a.end()}for(let n=1;n<B;++n){const a=E>>n;for(let c=0;c<6;++c){const u=this.device.createBindGroup({layout:this.mipmapBindGroupLayout,entries:[{binding:0,resource:this.envMapTexture.createView({dimension:"2d",baseMipLevel:n-1,mipLevelCount:1,baseArrayLayer:c,arrayLayerCount:1})},{binding:1,resource:this.cameraView.textureManager.linearSampler}]}),s=e.beginRenderPass({label:`RocketEnvMapMipmapPass_Level${n}_Face${c}`,colorAttachments:[{view:this.envMapTexture.createView({dimension:"2d",baseMipLevel:n,mipLevelCount:1,baseArrayLayer:c,arrayLayerCount:1}),loadOp:"clear",clearValue:{r:0,g:0,b:0,a:1},storeOp:"store"}]});s.setPipeline(this.mipmapPipeline),s.setBindGroup(0,u),s.setViewport(0,0,a,a,0,1),s.draw(4,1,0,0),s.end()}}}drawRocket(e){if(!this.rocketVertexBuffer||this.rocketIndexCount===0)return;const t=this.getRocketBindGroup();if(!t)return;const i=new Float32Array(20);this.setCameraUniforms(i.subarray(0,16),i.subarray(16,19)),this.device.queue.writeBuffer(this.rocketUniformBuffer,0,i),e.setPipeline(this.rocketPipeline),e.setBindGroup(0,t),e.setVertexBuffer(0,this.rocketVertexBuffer),e.setIndexBuffer(this.rocketIndexBuffer,"uint32"),e.drawIndexed(this.rocketIndexCount,1,0,0,0)}drawExhaust(e,t,i){if(!this.exhaustVertexBuffer||this.exhaustIndexCount===0)return;const r=.1*Math.pow(i,.75),n=[46/255*r,176/255*r,r],a=t*100,c=6.75+.5*Math.cos(a),u=5.75+.5*Math.cos((a+1)/Math.sqrt(2)),s=4.75+.5*Math.cos((a+2)/Math.sqrt(3)),p=I*I,l=[c/p,u/p,s/p],g=27+2*Math.cos((a+1)/Math.sqrt(2)),_=23+2*Math.cos((a+2)/Math.sqrt(3)),x=19+2*Math.cos(a),d=N-A,f=[g/d,_/d,x/d],m=new Float32Array(32);this.setCameraUniforms(m.subarray(0,16),m.subarray(16,19)),m[20]=n[0],m[21]=n[1],m[22]=n[2],m[24]=l[0],m[25]=l[1],m[26]=l[2],m[28]=f[0],m[29]=f[1],m[30]=f[2],this.device.queue.writeBuffer(this.exhaustUniformBuffer,0,m),e.setVertexBuffer(0,this.exhaustVertexBuffer),e.setIndexBuffer(this.exhaustIndexBuffer,"uint32"),e.setBindGroup(0,this.exhaustBindGroup),e.setPipeline(this.exhaustPipelineBack),e.drawIndexed(this.exhaustIndexCount,1,0,0,0),e.setPipeline(this.exhaustPipelineFront),e.drawIndexed(this.exhaustIndexCount,1,0,0,0)}}class ae{constructor(e,t,i){o(this,"model");o(this,"rootElement");o(this,"device");o(this,"devicePixelRatio");o(this,"canvas");o(this,"errorPanel");o(this,"errorPanelShown");o(this,"context");o(this,"canvasFormat");o(this,"uniformBuffer");o(this,"bindGroupLayout");o(this,"pipelineLayout");o(this,"pipeline",null);o(this,"bindGroup",null);o(this,"cachedSkyTexture",null);o(this,"textureManager");o(this,"shaderManager");o(this,"rocketManager");o(this,"bloom");o(this,"lastTauSeconds");o(this,"lastFrameTime");o(this,"numFrames",0);o(this,"drag",!1);o(this,"previousMouseX");o(this,"previousMouseY");o(this,"hidden",!1);o(this,"discParticles");this.model=e,this.rootElement=t,this.device=i,this.devicePixelRatio=this.getDevicePixelRatio();const r=t.querySelector("#camera_view"),n=t.querySelector("#cv_error_panel");if(!r)throw new Error("camera_view canvas not found");if(!n)throw new Error("cv_error_panel not found");this.canvas=r,this.canvas.style.width=`${t.clientWidth}px`,this.canvas.style.height=`${t.clientHeight}px`,this.canvas.width=t.clientWidth*this.devicePixelRatio,this.canvas.height=t.clientHeight*this.devicePixelRatio,this.errorPanel=n,this.errorPanelShown=!1;const a=this.canvas.getContext("webgpu");if(!a)throw new Error("Could not get WebGPU context");this.context=a,this.canvasFormat=navigator.gpu.getPreferredCanvasFormat(),this.context.configure({device:this.device,format:this.canvasFormat,alphaMode:"opaque"}),this.uniformBuffer=this.device.createBuffer({size:432,usage:GPUBufferUsage.UNIFORM|GPUBufferUsage.COPY_DST}),this.bindGroupLayout=this.device.createBindGroupLayout({entries:[{binding:0,visibility:GPUShaderStage.VERTEX|GPUShaderStage.FRAGMENT,buffer:{type:"uniform"}},{binding:1,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"filtering"}},{binding:2,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:3,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:4,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"cube"}},{binding:5,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"cube"}},{binding:6,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"cube"}},{binding:7,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:8,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"3d"}},{binding:9,visibility:GPUShaderStage.FRAGMENT,texture:{sampleType:"float",viewDimension:"2d"}},{binding:10,visibility:GPUShaderStage.FRAGMENT,sampler:{type:"non-filtering"}}]}),this.pipelineLayout=this.device.createPipelineLayout({bindGroupLayouts:[this.bindGroupLayout]}),this.textureManager=new ee(t,this.device),this.shaderManager=new te(e,this.textureManager,this.device),this.rocketManager=new ie(e,this),this.bloom=new Q(this.device,this.canvasFormat,this.canvas.width,this.canvas.height),this.lastTauSeconds=Date.now()/1e3,this.lastFrameTime=void 0,this.numFrames=0,this.drag=!1,this.previousMouseX=void 0,this.previousMouseY=void 0,this.hidden=!1;const c=3,u=12,s=function(_,x,d){const f=(x-_)/(d-_),m=1e4;let v=0;for(let b=0;b<m;++b){const T=1/m,y=(b+.5)/m;v+=T/Math.sqrt((1-y*y)*(1-f*y*y))}return Math.PI*Math.sqrt(d-_)/(4*v)};this.discParticles=new Float32Array(48);let p=0,l=42;const g=()=>{let _=Math.sin(l++)*1e4;return _-Math.floor(_)};for(let _=c;_<u;_+=.75){const x=.1*g(),f=1/(_*(1+x)/(1-x)),m=1/_,v=1-f-m,b=2*Math.PI*g(),T=s(f,m,v);this.discParticles[p++]=f,this.discParticles[p++]=m,this.discParticles[p++]=b,this.discParticles[p++]=T}window.addEventListener("mousedown",_=>this.onMouseDown(_)),window.addEventListener("mousemove",_=>this.onMouseMove(_)),window.addEventListener("mouseup",()=>this.onMouseUp()),window.addEventListener("resize",()=>this.onResize()),document.addEventListener("visibilitychange",()=>{this.hidden=document.hidden,this.hidden||(this.lastFrameTime=void 0)}),requestAnimationFrame(()=>this.onRender())}getBindGroup(){const e=this.textureManager,t=e.rayDeflectionTexture,i=e.rayInverseRadiusTexture,r=e.noiseTexture,n=e.starTexture,a=e.starTexture2,c=e.blackbodyTexture,u=e.dopplerTexture;if(!t||!i||!r||!n||!a||!c||!u)return null;const s=this.model.grid.getValue()?this.textureManager.gridTexture:this.textureManager.galaxyTexture;return s?this.bindGroup&&this.cachedSkyTexture===s?this.bindGroup:(this.cachedSkyTexture=s,this.bindGroup=this.device.createBindGroup({layout:this.bindGroupLayout,entries:[{binding:0,resource:{buffer:this.uniformBuffer}},{binding:1,resource:this.textureManager.linearSampler},{binding:2,resource:t.createView()},{binding:3,resource:i.createView()},{binding:4,resource:s.createView({dimension:"cube"})},{binding:5,resource:n.createView({dimension:"cube"})},{binding:6,resource:a.createView({dimension:"cube"})},{binding:7,resource:c.createView()},{binding:8,resource:u.createView()},{binding:9,resource:r.createView()},{binding:10,resource:this.textureManager.nearestSampler}]}),this.bindGroup):null}updateUniforms(){const e=this.model,t=new Float32Array(108);t[0]=e.t,t[1]=e.r,t[2]=e.worldTheta,t[3]=e.worldPhi,t[4]=e.p[0],t[5]=e.p[1],t[6]=e.p[2],t[7]=0,t[8]=e.kS[0],t[9]=e.kS[1],t[10]=e.kS[2],t[11]=e.kS[3],t[12]=e.eTau[1],t[13]=e.eTau[2],t[14]=e.eTau[3],t[15]=0,t[16]=e.eW[1],t[17]=e.eW[2],t[18]=e.eW[3],t[19]=0,t[20]=e.eH[1],t[21]=e.eH[2],t[22]=e.eH[3],t[23]=0,t[24]=e.eD[1],t[25]=e.eD[2],t[26]=e.eD[3],t[27]=0,t[28]=e.starsMatrix[0],t[29]=e.starsMatrix[3],t[30]=e.starsMatrix[6],t[31]=0,t[32]=e.starsMatrix[1],t[33]=e.starsMatrix[4],t[34]=e.starsMatrix[7],t[35]=0,t[36]=e.starsMatrix[2],t[37]=e.starsMatrix[5],t[38]=e.starsMatrix[8],t[39]=0;const i=Math.tan(e.fovY/2),r=this.canvas.height/(2*i);t[40]=this.canvas.width/2,t[41]=this.canvas.height/2,t[42]=r,t[43]=0,t[44]=e.discDensity.getValue(),t[45]=e.discOpacity.getValue(),t[46]=e.discTemperature.getValue(),t[47]=0,t[48]=e.exposure.getValue(),t[49]=e.bloom.getValue();const n=e.grid.getValue()?0:this.textureManager.getMinLoadedStarTextureLod();t[50]=n;const a=new Uint32Array(t.buffer);a[51]=e.lensing.getValue()?1:0,a[52]=e.doppler.getValue()?1:0,a[53]=e.grid.getValue()?1:0,a[54]=e.stars.getValue()?1:0,a[55]=e.highContrast.getValue()?1:0,t[56]=e.fovY,a[57]=e.nasaFisheye.getValue()?1:0,t[58]=0,t[59]=0,t.set(this.discParticles,60),this.device.queue.writeBuffer(this.uniformBuffer,0,t)}onRender(){if(this.hidden)return;const e=this.shaderManager.getProgram();if(!e){requestAnimationFrame(()=>this.onRender());return}this.pipeline||(this.pipeline=this.device.createRenderPipeline({label:"BlackHoleRenderPipeline",layout:this.pipelineLayout,vertex:{module:e,entryPoint:"vert_main"},fragment:{module:e,entryPoint:"frag_main",targets:[{format:"rgba16float"}]},primitive:{topology:"triangle-strip"}}));const t=this.getBindGroup();if(!t){requestAnimationFrame(()=>this.onRender());return}const i=Date.now()/1e3,r=i-this.lastTauSeconds;this.lastTauSeconds=i,this.updateUniforms();const n=this.device.createCommandEncoder(),a=this.context.getCurrentTexture().createView();this.model.rocket.getValue()&&this.rocketManager.renderEnvMap(n);const c=this.bloom.begin(),u={colorAttachments:[{view:c,clearValue:{r:0,g:0,b:0,a:1},loadOp:"clear",storeOp:"store"}]},s=n.beginRenderPass(u);if(s.setPipeline(this.pipeline),s.setBindGroup(0,t),s.setViewport(1,1,this.canvas.width,this.canvas.height,0,1),s.draw(4,1,0,0),s.end(),this.model.rocket.getValue()){const p={colorAttachments:[{view:c,loadOp:"load",storeOp:"store"}],depthStencilAttachment:{view:this.bloom.depthTexture.createView(),depthClearValue:1,depthLoadOp:"clear",depthStoreOp:"discard"}},l=n.beginRenderPass(p);l.setViewport(1,1,this.canvas.width,this.canvas.height,0,1),this.rocketManager.drawRocket(l),this.model.gForce>0&&this.rocketManager.drawExhaust(l,i,this.model.gForce),l.end()}this.bloom.end(n,a,this.model.bloom.getValue(),this.model.exposure.getValue(),this.model.highContrast.getValue()),this.device.queue.submit([n.finish()]),this.model.updateOrbit(r),requestAnimationFrame(()=>this.onRender()),this.checkFrameRate()}checkFrameRate(){const e=Date.now();this.lastFrameTime||(this.lastFrameTime=e,this.numFrames=0),this.numFrames+=1,e>this.lastFrameTime+1e3&&(this.numFrames<=10&&this.model.stars.getValue()&&!this.errorPanelShown&&(this.model.stars.setValue(!1),this.errorPanel.innerHTML="Stars have been automatically disabled to improve performance. You can re-enable them from the left hand side panel.",this.errorPanel.classList.toggle("cv-hidden",!1),this.errorPanel.classList.toggle("cv-warning",!0),this.errorPanelShown=!0),this.lastFrameTime=e,this.numFrames=0)}onMouseDown(e){this.previousMouseX=e.screenX,this.previousMouseY=e.screenY;const t=e.target;this.drag=t.tagName!="INPUT"&&!e.ctrlKey}onMouseMove(e){const t=e.screenX,i=e.screenY;if(this.drag){let n=this.model.cameraYaw.getValue(),a=this.model.cameraPitch.getValue();const c=this.previousMouseX??t,u=this.previousMouseY??i;n+=(c-t)/500,a-=(u-i)/500,this.model.cameraYaw.setValue(n-2*Math.PI*Math.floor(n/(2*Math.PI))),this.model.cameraPitch.setValue(a)}this.previousMouseX=t,this.previousMouseY=i}onMouseUp(){this.drag=!1}onResize(){const e=this.rootElement;this.devicePixelRatio=this.getDevicePixelRatio(),this.canvas.style.width=`${e.clientWidth}px`,this.canvas.style.height=`${e.clientHeight}px`,this.canvas.width=e.clientWidth*this.devicePixelRatio,this.canvas.height=e.clientHeight*this.devicePixelRatio,this.bloom.resize(this.canvas.width,this.canvas.height)}getDevicePixelRatio(){return this.model.highDefinition.getValue()?window.devicePixelRatio:1}}function k(h,e,t){let i=document.getElementById(h);i||(i=document.createElement("script"),i.id=h,i.setAttribute("type",e),document.body.appendChild(i)),i.textContent=t}k("black_hole_shader","text/wgsl",Y);k("rocket_shader","text/wgsl",X);k("exhaust_shader","text/wgsl",j);window.addEventListener("DOMContentLoaded",async()=>{if(!navigator.gpu){const n=document.querySelector("#cv_error_panel");n&&(n.innerHTML="WebGPU is not supported in this browser. Please use a WebGPU-enabled browser (like Chrome or Edge).",n.classList.toggle("cv-hidden",!1));return}const h=await navigator.gpu.requestAdapter();if(!h){const n=document.querySelector("#cv_error_panel");n&&(n.innerHTML="Failed to request WebGPU adapter.",n.classList.toggle("cv-hidden",!1));return}const e=[];h.features.has("float32-filterable")&&e.push("float32-filterable");const t=await h.requestDevice({requiredFeatures:e}),i=new z;new H(i);const r=document.body.querySelector("#settings_panel");r&&new W(r,i),new $(document.body,i),window.addEventListener("error",n=>{const a=document.querySelector("#cv_error_panel");a&&(a.innerHTML="JS Error: "+n.message,a.classList.toggle("cv-hidden",!1))}),window.addEventListener("unhandledrejection",n=>{const a=document.querySelector("#cv_error_panel");a&&(a.innerHTML="Promise Error: "+n.reason,a.classList.toggle("cv-hidden",!1))}),new ae(i,document.body,t)});
