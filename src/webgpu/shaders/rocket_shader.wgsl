const PI: f32 = 3.141592653589793;

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
  n: vec3<f32>,
  tx: vec3<f32>,
  ty: vec3<f32>,
  occlusion: f32,
  alpha_sq: f32,
  albedo: vec3<f32>,
  f0: vec3<f32>,
};

fn ComputeNormal(uv: vec2<f32>, normal_in: vec3<f32>, tangent_in: vec3<f32>) -> vec3<f32> {
  let n = textureSample(normal_map_texture, linear_sampler, uv).xyz * 2.0 - vec3<f32>(1.0);
  let ez = normalize(normal_in);
  let ex = normalize(tangent_in);
  let ey = cross(ez, ex);
  return normalize(n.x * ex + n.y * ey + n.z * ez);
}

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
  surface.alpha_sq = alpha * alpha;

  let DIELECTRIC_F0 = 0.04;
  let METAL_ALBEDO = vec3<f32>(0.0);
  let color = textureSample(base_color_texture, linear_sampler, uv).rgb;
  surface.albedo = mix(color * (1.0 - DIELECTRIC_F0), METAL_ALBEDO, metallic);
  surface.f0 = mix(vec3<f32>(DIELECTRIC_F0), color, metallic);
  
  return surface;
}

fn GetVector(surface: Surface, cos_theta: f32, sin_theta: f32, phi: f32) -> vec3<f32> {
  let vx = sin_theta * cos(phi);
  let vy = sin_theta * sin(phi);
  let vz = cos_theta;
  return vx * surface.tx + vy * surface.ty + vz * surface.n;
}

fn Fresnel(f0: vec3<f32>, v_dot_h: f32) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - v_dot_h, 5.0);
}

fn MicroFacetVisibility(alpha_sq: f32, n_dot_l: f32, n_dot_v: f32) -> f32 {
  let a = n_dot_l * sqrt(n_dot_v * n_dot_v * (1.0 - alpha_sq) + alpha_sq);
  let b = n_dot_v * sqrt(n_dot_l * n_dot_l * (1.0 - alpha_sq) + alpha_sq);
  return 0.5 / (a + b);
}

fn MicroFacetDistribution(alpha_sq: f32, n_dot_h: f32) -> f32 {
  let a = n_dot_h * n_dot_h * (alpha_sq - 1.0) + 1.0;
  return alpha_sq / (PI * a * a);
}

const ENV_MAP_SIZE: f32 = 64.0;

fn ImageBasedLighting(surface: Surface, v: vec3<f32>) -> vec3<f32> {
  let N_Z = 3;
  const N_PHI = 8;
  let OMEGA_SAMPLE = 2.0 * PI / f32(N_Z * N_PHI);
  let OMEGA_TEXEL = 4.0 * PI / (6.0 * ENV_MAP_SIZE * ENV_MAP_SIZE);
  let LOD = 0.5 * log2(OMEGA_SAMPLE / OMEGA_TEXEL);
  let n_dot_v = clamp(dot(surface.n, v), 0.0, 1.0);
  var diffuse = vec3<f32>(0.0);
  var specular = vec3<f32>(0.0);
  
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

  let SAMPLE_COUNT = 24;
  var importance_specular = vec3<f32>(0.0);
  for (var i = 0; i < SAMPLE_COUNT; i++) {
    let vdc = VAN_DER_CORPUT[i];
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

    let pdf = D * n_dot_h / (4.0 * v_dot_h);
    let omega_sample_inverse = pdf * f32(SAMPLE_COUNT);
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
