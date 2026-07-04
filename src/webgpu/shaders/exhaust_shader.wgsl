struct ExhaustUniforms {
  model_view_proj_matrix: mat4x4<f32>,
  camera: vec3<f32>,
  _pad1: f32,
  intensity: vec3<f32>,
  _pad2: f32,
  k_r: vec3<f32>,
  _pad3: f32,
  k_z: vec3<f32>,
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
  let dir = normalize(in.position - u_uniforms.camera);
  let a = dot(dir.xy, dir.xy);
  let b = dot(u_uniforms.camera.xy, dir.xy);
  let c = dot(u_uniforms.camera.xy, u_uniforms.camera.xy);
  let discriminant = b * b - a * (c - RADIUS * RADIUS);
  
  if (discriminant >= 0.0) {
    var t_min = max((-b - sqrt(discriminant)) / a, 0.0);
    var t_max = (-b + sqrt(discriminant)) / a;
    if (dir.z > 0.0) {
      t_min = max(t_min, (Z_MIN - u_uniforms.camera.z) / dir.z);
      t_max = min(t_max, (Z_MAX - u_uniforms.camera.z) / dir.z);
    } else {
      t_min = max(t_min, (Z_MAX - u_uniforms.camera.z) / dir.z);
      t_max = min(t_max, (Z_MIN - u_uniforms.camera.z) / dir.z);
    }
    
    if (t_min < t_max) {
      const N = 16;
      var emitted = vec3<f32>(0.0);
      let dt = (t_max - t_min) / f32(N);
      var t = t_min + 0.5 * dt;
      for (var i = 0; i < N; i++) {
        let r2 = ((a * t + 2.0 * b) * t) + c;
        let z = u_uniforms.camera.z + t * dir.z;
        emitted += exp(- u_uniforms.k_r * r2 - u_uniforms.k_z * (Z_MAX - z));
        t += dt;
      }
      return vec4<f32>(u_uniforms.intensity * emitted * dt, 0.0);
    }
  }
  return vec4<f32>(0.0);
}
