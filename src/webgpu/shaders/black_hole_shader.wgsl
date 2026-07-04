// WGSL translation of the Black Hole Ray Tracing shader
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
  @location(0) view_dir: vec3<f32>,
};

// Generates screen-aligned quad vertices and sets the initial direction of rays
// ejected from the camera lens into the relativistic observer's local coordinate frame (tetrad).
@vertex
fn vert_main(@builtin(vertex_index) VertexIndex: u32) -> VertexOutput {
  var out: VertexOutput;
  var pos = vec2<f32>(
    f32((VertexIndex << 1u) & 2u) - 1.0,
    f32(VertexIndex & 2u) - 1.0
  );
  out.Position = vec4<f32>(pos, 0.0, 1.0);
  out.view_dir = vec3<f32>(pos * u_uniforms.camera_size.xy, -u_uniforms.camera_size.z);
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
fn frag_main(@location(0) view_dir: vec3<f32>) -> @location(0) vec4<f32> {
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
