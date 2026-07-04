// =====================================================================================
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
