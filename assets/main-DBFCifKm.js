var V=Object.defineProperty;var H=(i,e,t)=>e in i?V(i,e,{enumerable:!0,configurable:!0,writable:!0,value:t}):i[e]=t;var l=(i,e,t)=>H(i,typeof e!="symbol"?e+"":e,t);import{M as W,U as j,S as Y}from"./settings_panel-i3tiS7Ws.js";import{O as Z}from"./orbit_panel-BjfCWvSP.js";const $=`/**
 * @file exhaust_vertex_shader.glsl
 * @brief Vertex shader for the rocket's volume-rendered engine exhaust.
 *
 * Architecture & Mathematics:
 * - This shader processes the vertices defining the outer shell (cylindrical bounds) of the rocket exhaust.
 * - It projects the vertices into clip space using the model-view-projection matrix for rasterization.
 * - Crucially, it passes the raw local object-space \`position\` attribute to the fragment shader.
 * - In the fragment shader, this local coordinate is used to compute the ray direction in object space
 *   (i.e., relative to the exhaust cylinder's local frame) to perform volume raymarching through the flame density field.
 */

// Model-View-Projection matrix to transform vertices from object space to clip space
uniform mat4 model_view_proj_matrix;

// Local object-space vertex coordinate input
layout(location = 0) in vec3 position_attribute;

// Output local object-space coordinate to interpolate and pass to the fragment shader
out vec3 position;

void main() {
  // Pass the raw local object space position directly. It is interpolated and used in the
  // fragment shader to determine the ray entry and exit coordinates for volume raymarching.
  position = position_attribute;
  
  // Transform the object space position into clip space for rendering
  gl_Position = model_view_proj_matrix * vec4(position, 1.0);
}
`,Q=`/**
 * @file exhaust_fragment_shader.glsl
 * @brief Volumetric raymarching fragment shader for rendering the rocket's engine exhaust plume.
 *
 * Physics & Mathematics:
 * - The exhaust plume is modeled as a hot, emitting gas contained within a finite cylinder.
 * - The cylinder is centered along the local z-axis, with radius R (\`RADIUS\`) and extending from
 *   z = Z_MIN to z = Z_MAX.
 * - The emission density profile \\rho at any local coordinate (x, y, z) is modeled using an exponential decay:
 *     \\rho(r, z) = \\exp(-k_r * r^2 - k_z * (Z_MAX - z))
 *   where:
 *     - r^2 = x^2 + y^2 is the squared radial distance from the cylinder's axis.
 *     - (Z_MAX - z) is the distance from the engine nozzle (which sits at Z_MAX).
 *     - k_r and k_z are extinction/density coefficients that can be varied per color channel
 *       (r, g, b) to simulate chromatic absorption/emission effects (e.g. cooler outer boundaries).
 *
 * Ray-Cylinder Intersection Derivation:
 * - A ray is parameterized in object space as:
 *     \\vec{p}(t) = \\vec{o} + t \\vec{d}
 *   where:
 *     - \\vec{o} is the camera position in object space (\`camera\`).
 *     - \\vec{d} is the normalized direction vector from the camera to the current fragment (\`dir\`).
 * - To find the intersection of the ray with the infinite cylinder boundary x^2 + y^2 = R^2:
 *     (o_x + t d_x)^2 + (o_y + t d_y)^2 = R^2
 *   Expanding and grouping in terms of t:
 *     (d_x^2 + d_y^2) t^2 + 2 (o_x d_x + o_y d_y) t + (o_x^2 + o_y^2 - R^2) = 0
 *   This is a quadratic equation a t^2 + 2b t + c = 0, where:
 *     - a = d_x^2 + d_y^2  (dot(dir.xy, dir.xy))
 *     - b = o_x d_x + o_y d_y  (dot(camera.xy, dir.xy))
 *     - c = o_x^2 + o_y^2 - R^2  (dot(camera.xy, camera.xy) - RADIUS^2)
 *   The discriminant is:
 *     D = b^2 - a * c = b^2 - a * (o_x^2 + o_y^2 - R^2)
 *   If D >= 0, the ray intersects the infinite cylinder at:
 *     t = (-b \\pm \\sqrt{D}) / a
 *
 * Volume Boundary Clipping:
 * - We find the cylinder shell intersection times t_min = (-b - \\sqrt{D})/a and t_max = (-b + \\sqrt{D})/a.
 * - Since we only render in front of the camera, we clamp t_min to >= 0.
 * - The ray path must also be clipped to the finite z-interval [Z_MIN, Z_MAX]:
 *     z(t) = o_z + t d_z
 *   - If d_z > 0:
 *       t_min = \\max(t_min, (Z_MIN - o_z) / d_z)
 *       t_max = \\min(t_max, (Z_MAX - o_z) / d_z)
 *   - If d_z < 0 (pointing backward along z):
 *       t_min = \\max(t_min, (Z_MAX - o_z) / d_z)
 *       t_max = \\min(t_max, (Z_MIN - o_z) / d_z)
 * - If t_min < t_max, the ray segment inside the finite cylinder is valid.
 *
 * Volumetric Integration (Riemann Sum):
 * - The integral of emitted light along the ray path within the volume is:
 *     I = \\int_{t_{min}}^{t_{max}} \\text{intensity} * \\exp(-k_r * r(t)^2 - k_z * (Z_MAX - z(t))) dt
 * - We approximate this integral numerically by sampling at N = 16 discrete points.
 * - The step size is dt = (t_max - t_min) / N.
 * - For each step i \\in [0, N-1], we sample at the midpoint:
 *     t = t_min + (i + 0.5) * dt
 *   And accumulate the local emissions multiplied by dt.
 */

// Camera position in the rocket's local object space
uniform vec3 camera;

// Global scale factor for emission intensity (RGB)
uniform vec3 intensity;

// Radial decay coefficients (RGB) for the exponential density profile
uniform vec3 k_r;

// Longitudinal decay coefficients (RGB) along the length of the plume
uniform vec3 k_z;

// Interpolated local object-space coordinate of the fragment
in vec3 position;

// Output fragment color
layout(location = 0) out vec4 frag_color;

void main() {
  // Initialize output color as black/empty (no emission)
  frag_color = vec4(0.0);

  // Compute the ray direction in local object space
  vec3 dir = normalize(position - camera);
  
  // Solve the quadratic equation for ray-cylinder intersection: a*t^2 + 2*b*t + (c - R^2) = 0
  float a = dot(dir.xy, dir.xy);
  float b = dot(camera.xy, dir.xy);
  float c = dot(camera.xy, camera.xy);
  float discriminant = b * b - a * (c - RADIUS * RADIUS);
  
  if (discriminant >= 0.0) {
    // Ray intersects the infinite cylinder. Find entry and exit times.
    float t_min = max((-b - sqrt(discriminant)) / a, 0.0);
    float t_max = (-b + sqrt(discriminant)) / a;
    
    // Clip the intersection times to the cylinder's longitudinal boundaries [Z_MIN, Z_MAX]
    if (dir.z > 0.0) {
      t_min = max(t_min, (Z_MIN - camera.z) / dir.z);
      t_max = min(t_max, (Z_MAX - camera.z) / dir.z);
    } else {
      t_min = max(t_min, (Z_MAX - camera.z) / dir.z);
      t_max = min(t_max, (Z_MIN - camera.z) / dir.z);
    }
    
    // If the ray segment overlapping the cylinder volume is non-empty, perform numerical integration
    if (t_min < t_max) {
      const int N = 16;
      vec3 emitted = vec3(0.0);
      float dt = (t_max - t_min) / float(N);
      float t = t_min + 0.5 * dt; // Start at the midpoint of the first step
      
      // Perform Midpoint Riemann Sum to integrate emission along the ray segment
      for (int i = 0; i < N; ++i) {
        // Calculate r^2 at parameter t:
        // r^2 = (camera.x + t*dir.x)^2 + (camera.y + t*dir.y)^2
        //     = a*t^2 + 2*b*t + c (where a, b, c are the components computed above without the R^2 term)
        float r2 = ((a * t + 2.0 * b) * t) + c;
        
        // Calculate z at parameter t:
        float z = camera.z + t * dir.z;
        
        // Accumulate local emission: exp(-k_r * r^2 - k_z * (Z_MAX - z))
        emitted += exp(- k_r * r2 - k_z * (Z_MAX - z));
        
        // Move to the next step midpoint
        t += dt;
      }
      
      // The integrated color is scaled by intensity, the step size dt, and the accumulated density
      frag_color = vec4(intensity * emitted * dt, 0.0);
    }
  }
}
`,K=`/**
 * @file rocket_vertex_shader.glsl
 * @brief Vertex shader for the rocket 3D mesh rendering.
 *
 * Architecture & Mathematics:
 * - This shader prepares the geometry of the rocket mesh for Physically-Based Rendering (PBR)
 *   in the fragment shader.
 * - It takes vertex positions, normals, tangents, texture coordinates (uv), and pre-baked
 *   ambient occlusion values.
 * - It outputs these values in the object-space coordinate system of the rocket, which allows
 *   the fragment shader to compute local lighting (e.g. normal mapping, view-vector computation)
 *   without having to transform all calculations to world space.
 * - The vertex positions are projected to clip space using the Model-View-Projection matrix
 *   \`model_view_proj_matrix\` which defines the camera's perspective and translation.
 */

// Model-View-Projection matrix to transform local coordinates to clip space
uniform mat4 model_view_proj_matrix;

// Local object-space vertex position
layout(location = 0) in vec3 position_attribute;

// Geometric vertex normal (perpendicular to surface) in object space
layout(location = 1) in vec3 normal_attribute;

// Tangent vector used for constructing the local orthonormal tangent space basis (TBN)
layout(location = 2) in vec4 tangent_attribute;

// Texture coordinates for base color, normal map, and roughness/metalness maps
layout(location = 3) in vec2 uv_attribute;

// Precomputed ambient occlusion factor (0 = fully occluded/shadowed, 1 = unoccluded)
layout(location = 4) in float ambient_occlusion_attribute;

// Output variables interpolated across polygons and received by the fragment shader
out vec3 position;
out vec3 normal;
out vec3 tangent;
out vec2 uv;
out float ambient_occlusion;

void main() {
  // Pass object-space attributes directly. The fragment shader will interpolate these
  // vectors to compute view vectors, reflection directions, and tangent-space normal perturbations.
  position = position_attribute;
  normal = normal_attribute;
  
  // Tangent's w-component is used to determine bitangent sign, but here we extract xyz
  tangent = tangent_attribute.xyz;
  uv = uv_attribute;
  ambient_occlusion = ambient_occlusion_attribute;
  
  // Transform the local vertex coordinates to clip space for rasterization
  gl_Position = model_view_proj_matrix * vec4(position, 1.0);
}
`,J=`/**
 * @file rocket_fragment_shader.glsl
 * @brief Physically-Based Rendering (PBR) fragment shader for shading the rocket using the Cook-Torrance BRDF.
 *
 * Physics & Mathematics of the Cook-Torrance PBR Model:
 * - Surfaces are modeled as a collection of microscopic, perfectly reflective mirror-like facets (microfacets).
 * - The bidirectional reflectance distribution function (BRDF) f(l, v) describes how light from direction l
 *   reflects into viewing direction v:
 *     f(l, v) = f_diffuse + f_specular
 *
 * Diffuse Component (Lambertian):
 * - f_diffuse = (1 - F) * (albedo / \\pi)
 * - Under conservation of energy, the diffuse part represents light that penetrates the surface, scatters
 *   sub-surface, and re-emerges isotropically. The (1 - F) factor ensures that light reflected specularly is
 *   not also diffused.
 *
 * Specular Component (Microfacet Cook-Torrance):
 * - f_specular = D * F * G / (4 * (n \\cdot l) * (n \\cdot v))
 * - Let's define the terms:
 *   1. D: Microfacet Distribution Function (NDF). We use the Trowbridge-Reitz (GGX) distribution:
 *        D(h) = \\alpha^2 / (\\pi * ((n \\cdot h)^2 * (\\alpha^2 - 1) + 1)^2)
 *        where:
 *          - h = \\text{normalize}(v + l) is the half-vector between light and view directions.
 *          - \\alpha = \\text{roughness}^2 is the linear roughness squared.
 *          - D(h) measures the fraction of microfacets aligned with the half-vector h.
 *
 *   2. F: Fresnel Reflection Coefficient. We use the Fresnel-Schlick approximation:
 *        F(h, v) = F_0 + (1 - F_0) * (1 - (h \\cdot v))^5
 *        where:
 *          - F_0 is the specular reflectance at normal incidence.
 *          - For dielectrics, F_0 \\approx 0.04.
 *          - For metals, F_0 is equal to the base color of the metal, and the diffuse albedo becomes zero (metallic absorption).
 *
 *   3. G: Geometric Attenuation Factor. Combined with the 1 / (4 * (n \\cdot l) * (n \\cdot v)) denominator, we express it
 *      via the Visiblity function V = G / (4 * (n \\cdot l) * (n \\cdot v)). We use the Height-Correlated Smith Joint model:
 *        V(l, v) = 0.5 / (a + b)
 *        where:
 *          a = (n \\cdot l) * \\sqrt{(n \\cdot v)^2 * (1 - \\alpha^2) + \\alpha^2}
 *          b = (n \\cdot v) * \\sqrt{(n \\cdot l)^2 * (1 - \\alpha^2) + \\alpha^2}
 *          \\alpha^2 = \\text{roughness}^4.
 *
 * Image-Based Lighting (IBL) & Split-Sum Approximation:
 * - We integrate incoming light from the environment map texture (\`env_map_texture\`) over the hemisphere:
 *     L_{out}(v) = \\int f(l, v) * L_{in}(l) * (n \\cdot l) dl
 * - This is solved in two ways based on roughness:
 *   1. Large Roughness (Specular & Diffuse Integration):
 *      - We use numerical integration over a spherical grid of size N_Z * N_PHI = 24 samples.
 *      - The environment map is sampled at a low-resolution Mipmap level (LOD) representing the solid angle
 *        of the sample cone: LOD = 0.5 * log2(\\Omega_{sample} / \\Omega_{texel}).
 *   2. Small Roughness (Importance Specular Sampling):
 *      - When roughness is small (\\alpha^2 < 0.0625), uniform hemispherical sampling suffers from high variance (aliasing).
 *      - We use Quasi-Monte Carlo (QMC) Importance Sampling of the GGX NDF.
 *      - Points from the 1D Van der Corput low-discrepancy sequence (Hammersley sequence) are mapped to tangent-space
 *        half-vectors h distributed according to the GGX NDF:
 *          \\cos\\theta = \\sqrt{ (1 - u_1) / (u_1 * (\\alpha^2 - 1) + 1) }
 *          \\phi = 2 * \\pi * u_2
 *      - The reflection direction l = \\text{reflect}(-v, h) is computed, and the environment map is sampled.
 *      - The probability density function (PDF) of GGX is:
 *          pdf = D * (n \\cdot h) / (4 * (v \\cdot h))
 *      - To prevent aliasing, the Mipmap level (LOD) is selected dynamically using the inverse PDF:
 *          LOD = -0.5 * log2(pdf * SAMPLE_COUNT * \\Omega_{texel})
 */

const float PI = 3.141592653589793;

// First 32 terms of the 1D Van Der Corput low-discrepancy sequence (base 2).
// Used to construct Hammersley points on the unit square for low-variance Monte Carlo integration.
const float VAN_DER_CORPUT[32] = float[32](
  0.00000, 0.50000, 0.25000, 0.75000, 0.12500, 0.62500, 0.37500, 0.87500,
  0.06250, 0.56250, 0.31250, 0.81250, 0.18750, 0.68750, 0.43750, 0.93750,
  0.03125, 0.53125, 0.28125, 0.78125, 0.15625, 0.65625, 0.40625, 0.90625,
  0.09375, 0.59375, 0.34375, 0.84375, 0.21875, 0.71875, 0.46875, 0.96875
);

// Camera/observer coordinate in rocket object space
uniform vec3 camera;

// Textures mapping base color (albedo), occlusion/roughness/metallic factors, normals, and environment
uniform sampler2D base_color_texture;
uniform sampler2D occlusion_roughness_metallic_texture;
uniform sampler2D normal_map_texture;
uniform samplerCube env_map_texture;

// Inputs interpolated from the vertex shader
in vec3 position;           // Fragment position in object space.
in vec3 normal;             // Geometric surface normal in object space.
in vec3 tangent;            // Geometric surface tangent in object space.
in vec2 uv;                 // Texture coordinate.
in float ambient_occlusion; // Precomputed ambient occlusion (0 = full shade, 1 = no shade).

layout(location = 0) out vec4 frag_color;

// Local surface properties structure
struct Surface {
  vec3 n;              // Perturbed normal vector in object space.
  vec3 tx;             // Perturbed tangent vector (x-axis of tangent space) in object space.
  vec3 ty;             // Perturbed bitangent vector (y-axis of tangent space) in object space.
  float occlusion;     // Combined ambient occlusion (texel occlusion * vertex occlusion).
  float alpha_sq;      // Fourth power of roughness (\\alpha^2 = roughness^4), used in GGX math.
  vec3 albedo;         // Diffuse albedo color.
  vec3 f0;             // Specular reflectance at normal incidence.
};

/**
 * @brief Computes the perturbed normal in object space using tangent space normal mapping.
 * @return Normalized perturbed normal vector.
 */
vec3 ComputeNormal() {
  // Read tangent-space normal from normal map. The texture stores normal components in [0, 1].
  // We map them back to the [-1, 1] range.
  vec3 n = texture(normal_map_texture, uv).xyz * 2.0 - vec3(1.0);
  
  // Construct the geometric tangent space basis (TBN matrix) in object space.
  vec3 ez = normalize(normal);
  vec3 ex = normalize(tangent);
  vec3 ey = cross(ez, ex); // Bitangent
  
  // Transform the normal vector from tangent space to object space
  return normalize(n.x * ex + n.y * ey + n.z * ez);
}

/**
 * @brief Populates the Surface struct with materials data read from PBR maps.
 * @return Surface properties.
 */
Surface ComputeSurface() {
  Surface surface;
  surface.n = ComputeNormal();
  
  // Create an orthonormal basis in object space aligned with the perturbed normal.
  // Using Gram-Schmidt-like orthogonalization:
  surface.ty = normalize(cross(surface.n, tangent));
  surface.tx = cross(surface.ty, surface.n);

  // Read occlusion (Red channel), roughness (Green channel), and metallic (Blue channel) PBR values
  vec3 occlusion_roughness_metallic =
      texture(occlusion_roughness_metallic_texture, uv).rgb;
      
  // Combine texture-based ambient occlusion with geometry-based vertex occlusion
  surface.occlusion = occlusion_roughness_metallic.r * ambient_occlusion;
  
  float roughness = occlusion_roughness_metallic.g;
  float metallic = occlusion_roughness_metallic.b;
  
  // Compute linear roughness term alpha = roughness^2
  float alpha = roughness * roughness;
  // Store alpha_sq = roughness^4 for GGX equations
  surface.alpha_sq = alpha * alpha;

  const float DIELECTRIC_F0 = 0.04; // Standard reflectance value for common dielectrics
  const vec3 METAL_ALBEDO = vec3(0.0); // Metals have no diffuse reflection
  
  vec3 color = texture(base_color_texture, uv).rgb;
  
  // Linear interpolation based on metalness:
  // - Pure dielectrics: albedo = color * (1.0 - 0.04), normal incidence reflection F0 = 0.04.
  // - Pure metals: albedo = 0, F0 = color.
  surface.albedo = mix(color * (1.0 - DIELECTRIC_F0), METAL_ALBEDO, metallic);
  surface.f0 = mix(vec3(DIELECTRIC_F0), color, metallic);
  
  return surface;
}

/**
 * @brief Transforms spherical tangent-space coordinates to an object-space direction vector.
 * @param surface Surface basis reference.
 * @param cos_theta Cosine of polar angle theta.
 * @param sin_theta Sine of polar angle theta.
 * @param phi Azimuthal angle phi.
 * @return Normalized direction vector in object space.
 */
vec3 GetVector(Surface surface, float cos_theta, float sin_theta, float phi) {
  float vx = sin_theta * cos(phi);
  float vy = sin_theta * sin(phi);
  float vz = cos_theta;
  return vx * surface.tx + vy * surface.ty + vz * surface.n;
}

/**
 * @brief Computes Fresnel reflection coefficient using Fresnel-Schlick approximation.
 * @param f0 Reflectance at normal incidence.
 * @param v_dot_h Dot product between view vector v and microfacet half-vector h.
 * @return Fresnel reflectance vector.
 */
vec3 Fresnel(vec3 f0, float v_dot_h) {
  return f0 + (vec3(1.0) - f0) * pow(1.0 - v_dot_h, 5.0);
}

/**
 * @brief Computes the Height-Correlated Smith Joint visibility term.
 * @param alpha_sq Specular roughness squared (roughness^4).
 * @param n_dot_l Dot product between normal n and light vector l.
 * @param n_dot_v Dot product between normal n and view vector v.
 * @return Visiblity factor V = G / (4 * (n.l) * (n.v)).
 */
float MicroFacetVisibility(float alpha_sq, float n_dot_l, float n_dot_v) {
  float a = n_dot_l * sqrt(n_dot_v * n_dot_v * (1.0 - alpha_sq) + alpha_sq);
  float b = n_dot_v * sqrt(n_dot_l * n_dot_l * (1.0 - alpha_sq) + alpha_sq);
  return 0.5 / (a + b);
}

/**
 * @brief Computes Trowbridge-Reitz GGX Normal Distribution Function.
 * @param alpha_sq Specular roughness squared (roughness^4).
 * @param n_dot_h Dot product between normal n and microfacet half-vector h.
 * @return Distribution value D.
 */
float MicroFacetDistribution(float alpha_sq, float n_dot_h) {
  float a = n_dot_h * n_dot_h * (alpha_sq - 1.0) + 1.0;
  return alpha_sq / (PI * a * a);
}

/**
 * @brief Evaluates Image-Based-Lighting (IBL) for diffuse and specular reflections.
 * @param surface Surface properties.
 * @param v View/observer vector pointing towards camera.
 * @return Shaded color.
 */
vec3 ImageBasedLighting(Surface surface, vec3 v) {
  // --- Hemisphere Grid Sampling (Diffuse & Rough Specular) ---
  // We sample light directions uniformly over the hemisphere defined by the surface normal.
  const int N_Z = 3;   // Number of polar segments
  const int N_PHI = 8; // Number of azimuthal segments
  
  // Solid angle of a single hemispherical sample sector:
  const float OMEGA_SAMPLE = 2.0 * PI / float(N_Z * N_PHI);
  
  // Solid angle of a single pixel in the base environment map face (ENV_MAP_SIZE x ENV_MAP_SIZE):
  // Cubemap has 6 faces, total sphere area is 4*pi. A single face pixel has area approx 4*pi / (6 * w * h).
  const float OMEGA_TEXEL = 4.0 * PI / (6.0 * ENV_MAP_SIZE * ENV_MAP_SIZE);
  
  // Choose Mipmap LOD level based on sample area solid angle to prevent texture sampling aliasing.
  const float LOD = 0.5 * log2(OMEGA_SAMPLE / OMEGA_TEXEL);
  
  float n_dot_v = clamp(dot(surface.n, v), 0.0, 1.0);
  vec3 diffuse = vec3(0.0);
  vec3 specular = vec3(0.0);
  
  // Perform spherical coordinate integration
  for (int i = 0; i < N_Z; ++i) {
    // Polar angle theta mapping (cosine distributed):
    float cos_theta = (float(i) + 0.5) / float(N_Z);
    float sin_theta = sqrt(1.0 - cos_theta * cos_theta);
    
    for (int j = 0; j < N_PHI; ++j) {
      // Azimuthal angle phi mapping:
      float phi = float(j) * (2.0 * PI / float(N_PHI));
      
      // Transform angles to light direction l in object space
      vec3 l = GetVector(surface, cos_theta, sin_theta, phi);
      vec3 L = textureLod(env_map_texture, l, LOD).rgb;
      
      // Half-vector
      vec3 h = normalize(v + l);
      
      float n_dot_l = cos_theta;
      float n_dot_h = clamp(dot(surface.n, h), 0.0, 1.0);
      float v_dot_h = clamp(dot(v, h), 0.0, 1.0);
      
      // Compute PBR reflection factors:
      vec3 F = Fresnel(surface.f0, v_dot_h);
      float V = MicroFacetVisibility(surface.alpha_sq, n_dot_l, n_dot_v);
      float D = MicroFacetDistribution(surface.alpha_sq, n_dot_h);
      
      // Accumulate diffuse reflection: Lambertian diffuse scaled by (1 - F) (energy conservation)
      // and n_dot_l (Lambert's cosine law). The 1/pi factor is factored out at the end.
      diffuse += surface.albedo * L * (vec3(1.0) - F) * n_dot_l;
      
      // Accumulate specular reflection using Cook-Torrance model.
      // Denominator in Cook-Torrance (4 * n_dot_l * n_dot_v) is embedded in the Smith joint visibility V.
      specular += L * F * (V * D * n_dot_l);
    }
  }
  diffuse *= OMEGA_SAMPLE / PI;
  specular *= OMEGA_SAMPLE;

  // --- QMC Importance Sampling (Smooth Specular) ---
  // For highly reflective/smooth surfaces (roughness^4 < 0.0625), diffuse grid sampling is too coarse.
  // We use importance sampling of the specular lobes (GGX NDF) with a 24-point Hammersley set.
  const int SAMPLE_COUNT = 24;
  vec3 importance_specular = vec3(0.0);
  
  for (int i = 0; i < SAMPLE_COUNT; ++i) {
    // Low-discrepancy coordinates (u_1, u_2) on unit square:
    float vdc = VAN_DER_CORPUT[i]; // u_1
    float u_2 = float(i) * (1.0 / float(SAMPLE_COUNT));
    
    // Inverse GGX NDF mapping: maps u_1 and u_2 to half-vector angles (theta, phi) distributed matching NDF
    float z_sq = (1.0 - vdc) / ((surface.alpha_sq - 1.0) * vdc + 1.0);
    float cos_theta = sqrt(z_sq);
    float sin_theta = sqrt(1.0 - z_sq);
    float phi = u_2 * (2.0 * PI);
    
    // Get half-vector h in object space
    vec3 h = GetVector(surface, cos_theta, sin_theta, phi);
    
    // Reflection direction: l = 2 * (v.h) * h - v
    vec3 l = reflect(-v, h);
    float n_dot_l = dot(surface.n, l);
    if (n_dot_l <= 0.0) continue; // Skip light rays coming from below the horizon
    
    float n_dot_h = clamp(dot(surface.n, h), 0.0, 1.0);
    float v_dot_h = clamp(dot(v, h), 0.0, 1.0);
    
    // PBR terms
    vec3 F = Fresnel(surface.f0, v_dot_h);
    float V = MicroFacetVisibility(surface.alpha_sq, n_dot_l, n_dot_v);
    float D = MicroFacetDistribution(surface.alpha_sq, n_dot_h);
    
    // Probability Density Function (PDF) of GGX distribution
    float pdf = D * n_dot_h / (4.0 * v_dot_h);
    
    // Choose environment map Mipmap LOD level based on sample probability density (inverse weighting)
    // Smooth areas (high PDF) sample low LODs (sharp reflections); rougher areas (low PDF) sample high LODs.
    float omega_sample_inverse = pdf * float(SAMPLE_COUNT);
    float lod = -0.5 * log2(omega_sample_inverse * OMEGA_TEXEL);
    
    vec3 L = textureLod(env_map_texture, l, lod).rgb;
    
    // Specular accumulation weighted by the probability (divided by PDF)
    importance_specular += L * F * (V * D * n_dot_l / pdf);
  }
  importance_specular *= (1.0 / float(SAMPLE_COUNT));

  // Determine whether to use importance sampling or spherical grid sampling for specular reflections.
  // Cutoff is set to alpha_sq = 0.0625 (roughness = 0.5).
  return diffuse + (surface.alpha_sq < 0.0625 ? importance_specular : specular);
}

void main() {
  // Read material properties (albedo, roughness, metallic, normal, occlusion)
  Surface surface = ComputeSurface();
  
  // Normalized view vector from fragment to camera
  vec3 v = normalize(camera - position);
  
  // Compute illumination from Image-Based-Lighting environment map, attenuated by ambient occlusion
  frag_color = vec4(ImageBasedLighting(surface, v) * surface.occlusion, 1.0);
}
`,ee=`/**
 * @file vertex_shader.glsl
 * @brief Screen-aligned quad vertex shader with view-ray direction computation.
 *
 * Architecture & Physics:
 * - This shader takes a full-screen viewport quad (NDC coordinates covering [-1, 1] on x and y axes).
 * - It projects each screen vertex into the camera's local coordinate system.
 * - By interpolating these camera-space coordinates across the fragment shader, each fragment
 *   receives an accurate view direction vector \`view_dir\`.
 * - This \`view_dir\` represents the initial wavevector or momentum direction of light rays traced
 *   backwards (from the camera/observer to the light source/universe) in the relativistic raytracer.
 *
 * Mathematical derivation:
 * - Let a vertex have coordinates (x, y) in the normalized device coordinate range [-1, 1]^2.
 * - The uniform \`camera_size\` contains:
 *     - camera_size.x: Half-width of the viewport (w / 2).
 *     - camera_size.y: Half-height of the viewport (h / 2).
 *     - camera_size.z: Camera focal length (f) related to Field of View (FOV) by:
 *                      f = (h / 2) / tan(FOV_y / 2).
 * - The view direction vector \`view_dir\` in camera-space is:
 *     \\vec{v}_{cam} = (x * (w/2), y * (h/2), -f)
 * - Under this setup, the ratio of the components matches the tangent of the ray angles, ensuring
 *   correct perspective mapping. The negative z-component is the standard forward/look-at direction
 *   in WebGL's right-handed coordinate frame.
 */

// Camera dimensions: (half-width, half-height, focal length)
uniform vec3 camera_size;

// Screen-space vertex position input (typically a screen-spanning triangle/quad in NDC [-1, 1])
layout(location = 0) in vec4 vertex;

// Output camera-space view direction vector interpolated across the quad
out vec3 view_dir;

void main() {
  // Map NDC xy to physical camera sensor coordinates, setting Z to the negative focal length.
  view_dir = vec3(vertex.xy * camera_size.xy, -camera_size.z);
  
  // Pass through the vertex position directly (screen quad)
  gl_Position = vertex;
}
`,te=`/**
 * @file fragment_shader.glsl
 * @brief Main entry point shader for rendering the black hole environment.
 *
 * Architecture & Physics:
 * - This shader coordinates the raymarching pipeline. It sets up the parameters, imports the
 *   Schwarzschild geodesic tracing logic from \`black_hole_shader.glsl\`, and resolves flat-space vs.
 *   curved-space calculations.
 * - It defines the Euclidean (flat-space) ray-disk intersection helper to be used when gravitational
 *   lensing is disabled.
 * - It handles texture cube-map sampling for background starfields and nebulae, applies the
 *   relativistic Doppler shifts, and generates the procedural/grid texture on the accretion disk.
 *
 * Euclidean Ray-Disk Intersection (Flat Space):
 * - A straight line ray in coordinates is: \\vec{p}(t) = \\vec{p}_{cam} + t \\vec{d}_{ray}.
 * - The accretion disk lies in the plane z = 0.
 * - The intersection parameters with the disk plane are solved to check if they lie within the disk's
 *   inner and outer radii boundaries.
 */

// Camera position in Schwarzschild coordinate space: (t, r, \\theta, \\phi)
uniform vec4 camera_position;

// Camera position in Cartesian-like coordinate space: (x, y, z)
uniform vec3 p;

// Camera 4-velocity vector in Schwarzschild coordinates
uniform vec4 k_s;

// Orthonormal basis vectors (tetrad) representing the camera's reference frame:
// e_tau is the temporal axis (4-velocity), e_w (horizontal width), e_h (vertical height), e_d (view depth)
uniform vec3 e_tau, e_w, e_h, e_d;

// 2D precomputed geodesic deflection lookup table
uniform sampler2D ray_deflection_texture;

// 2D precomputed geodesic inverse radius lookup table
uniform sampler2D ray_inverse_radius_texture;

// Cube-map texture mapping background galaxy nebulae (radiance values)
uniform samplerCube galaxy_cube_texture;

// Cube-map textures containing Gaia star catalog intensities and coordinates
uniform samplerCube star_cube_texture;
uniform samplerCube star_cube_texture2;

// Orientation matrix representing the rotation of the background stars relative to the black hole
uniform mat3 stars_orientation;

// Minimum LOD to prevent sampling artifacts at high scaling
uniform float min_stars_lod;

// 1D black body spectrum lookup texture
uniform sampler2D black_body_texture;

// 3D Doppler spectral shift lookup texture
uniform highp sampler3D doppler_texture;

// 2D noise texture for procedural accretion disk dust rendering
uniform sampler2D noise_texture;

// Accretion disk settings: (density, opacity, temperature)
uniform vec3 disc_params;

// Interpolated camera-space view direction from the vertex shader
in vec3 view_dir;

// Final output fragment color
layout(location = 0) out vec4 frag_color;

/**
 * @brief Traces a straight ray in Euclidean space to find accretion disk plane intersections.
 * @details Used when LENSING=0. The ray is a straight line, ignoring space-time curvature.
 *          The intersection time t is computed relative to the disk's z=0 plane.
 * @param p_r Observer radial distance.
 * @param delta Angular coordinate of observer.
 * @param alpha Ray launch angle.
 * @param u_ic Inverse inner disc radius.
 * @param u_oc Inverse outer disc radius.
 * @param u0 Output: inverse radius of the first intersection.
 * @param phi0 Output: angle of the first intersection.
 * @param t0 Output: travel time to the intersection.
 * @param u1 Output: inverse radius of the second intersection (always -1 in flat space).
 * @param phi1 Output: angle of the second intersection (always -1 in flat space).
 * @param t1 Output: travel time of the second intersection (always -1 in flat space).
 * @return Deflection value (0 for straight paths, -1 if blocked).
 */
float TraceRayEuclidean(float p_r, float delta, float alpha, float u_ic,
                        float u_oc, out float u0, out float phi0, out float t0,
                        out float u1, out float phi1, out float t1) {
  float cos_delta = cos(delta);
  float sin_delta = sin(delta);
  float tan_alpha = tan(alpha);
  
  // Calculate ray-cylinder cylinder intersection discriminant
  float det = 1.0 - p_r * p_r * sin_delta * sin_delta;
  float deflection = det > 0.0 && cos_delta < 0.0 ? -1.0 : 0.0;
  u0 = -1.0;
  u1 = -1.0;
  
  // Straight line ray-plane intersection parameter t:
  float t = p_r / (sin_delta / tan_alpha - cos_delta);
  float r = length(vec2(p_r + t * cos_delta, t * sin_delta));
  
  // Check if intersection point lies within active disk radius bounds
  if (t >= 0.0 && r * u_oc <= 1.0 && r * u_ic >= 1.0 &&
      (deflection == 0.0 || t < p_r)) {
    u0 = 1.0 / r;
    phi0 = alpha;
    t0 = t;
  }
  return deflection;
}

/**
 * @brief Selects and executes the curved (relativistic) or flat (Euclidean) raytracer.
 */
float RayTrace(float u, float u_dot, float e_square, float delta, float alpha,
               float u_ic, float u_oc, out float u0, out float phi0,
               out float t0, out float alpha0, out float u1, out float phi1,
               out float t1, out float alpha1) {
#if (LENSING == 1)
  // Call general relativity geodesic integration trace
  return TraceRay(ray_deflection_texture, ray_inverse_radius_texture, u,
                  u_dot, e_square, delta, alpha, u_ic, u_oc, u0, phi0, t0,
                  alpha0, u1, phi1, t1, alpha1);
#else
  // Call flat space trace
  alpha0 = 1.0;
  alpha1 = 1.0;
  return TraceRayEuclidean(1.0 / u, delta, alpha, u_ic, u_oc, u0, phi0, t0,
                           u1, phi1, t1);
#endif
}

/**
 * @brief Samples the background galaxy nebulae cubemap.
 */
vec3 GalaxyColor(vec3 dir) {
  dir = stars_orientation * dir;
#if (GRID == 1)
  // Grid mode helper: render monochromatic intensity values
  return texture(galaxy_cube_texture, dir).rrr;
#else
  // Sample nebula radiance and scale to correct physical units
  return texture(galaxy_cube_texture, dir).rgb * 6.78494e-5;
#endif
}

/**
 * @brief Samples the high-frequency background stars cubemap (LOD query fallback).
 */
vec3 StarTextureColor(vec3 dir) {
#if (GRID == 1)
  return vec3(0.8);
#else
  return texture(star_cube_texture2, dir).rgb;
#endif
}

/**
 * @brief Samples individual star intensity and decodes its sub-texel offset position.
 */
vec3 StarTextureColor(vec3 dir, float lod, out vec2 sub_position) {
#if (GRID == 1)
  sub_position = vec2(0.0);
  return vec3(100.0);
#else
  vec3 color = textureLod(star_cube_texture, dir, lod).rgb;
  ivec2 bits = floatBitsToInt(color.rb);
  // Decode sub-texel coordinates packed in bit representation
  sub_position = vec2((bits >> 8) % 257) / 257.0 - vec2(0.5);
  return color;
#endif
}

/**
 * @brief Computes final background star contribution, multiplying by lensing magnification.
 */
vec3 StarColor(vec3 dir, float lensing_amplification_factor) {
#if (STARS == 1)
  dir = stars_orientation * dir;
  return DefaultStarColor(dir, lensing_amplification_factor, min_stars_lod);
#else
  return vec3(0.0);
#endif
}

/**
 * @brief Relativistically Doppler-shifts light spectra based on the relative frequency factor.
 */
vec3 Doppler(vec3 rgb, float doppler_factor) {
#if (DOPPLER == 1)
  return DefaultDoppler(doppler_texture, rgb, doppler_factor);
#else
  return rgb;
#endif
}

/**
 * @brief Renders a clean grid pattern over the accretion disk for visual/calibration reference.
 * @param p Position coordinates on the disk plane.
 * @param t Elapsed time parameter for rotating pattern.
 * @param top_side Indicates whether ray hit the top or bottom of the disk.
 * @param doppler_factor Relativistic Doppler shift scale.
 * @param temperature Base disk temperature.
 * @param black_body_texture 1D black body table.
 * @return Gridded disk color and opacity.
 */
vec4 GridDiscColor(vec2 p, float t, bool top_side, float doppler_factor,
                   float temperature, sampler2D black_body_texture) {
  float p_r = length(p);
  if (p_r <= INNER_DISC_R || p_r >= OUTER_DISC_R) {
    return vec4(0.0);
  }
  
  // Keplerian orbit frequency parameter:
  const float u_avg = 1.0 / 6.0;
  const float dphi_dt = u_avg * sqrt(0.5 * u_avg) / (2.0 * pi);
  float p_phi = atan(p.y, p.x) - t * dphi_dt;
  
  // Calculate polar grid patterns
  float value_phi = mod(p_phi / pi * 16.0, 1.0) < 0.2 ? 0.0 : 1.0;
  float value_r = mod(p_r / 2.0, 1.0) < 0.2 ? 0.0 : 1.0;
  
  // Get black body spectrum from Doppler shifted temperature
  vec3 color = BlackBodyColor(black_body_texture, temperature * doppler_factor);
  float pattern = 0.2 + 0.8 * value_phi * value_r;
  return vec4(color * (top_side ? pattern : 1.2 - pattern), 1.0);
}

/**
 * @brief Samples the noise texture to create gas turbulence.
 */
float Noise(vec2 uv) {
  return 3.0 * (texture(noise_texture, uv).r - 0.5) + 1.0;
}

/**
 * @brief Computes final color and opacity of the accretion disk.
 */
vec4 DiscColor(vec2 p, float t, bool top_side, float doppler_factor) {
  float density = disc_params.x;
  float opacity = disc_params.y;
  float temperature = disc_params.z;
#if (DOPPLER == 0)
  doppler_factor = 1.0;
#endif
#if (GRID == 1)
  vec4 color = GridDiscColor(p, t, top_side, doppler_factor, temperature,
                             black_body_texture);
#else
  vec4 color = DefaultDiscColor(p, t, top_side, doppler_factor, temperature,
                                black_body_texture);
#endif
  return vec4(density * color.rgb, opacity * color.a);
}

void main() {
  // Traces view rays through the space-time metrics and composites the final pixel color
  frag_color.rgb =
      SceneColor(camera_position, p, k_s, e_tau, e_w, e_h, e_d, view_dir);
  frag_color.a = 1.0;
}
`,re=`/**
 * @file black_hole_shader.glsl
 * @brief Core raymarching and gravitational lensing library for Schwarzschild space-time rendering.
 *
 * Physics & General Relativity Background:
 * - We model a static, spherically symmetric black hole using the Schwarzschild metric.
 *   In natural units where G = c = M = 1, the event horizon (Schwarzschild radius) is r_s = 2.
 * - The line element in Schwarzschild coordinates (t, r, \\theta, \\phi) is:
 *     ds^2 = -(1 - 2/r) dt^2 + (1 - 2/r)^-1 dr^2 + r^2 (d\\theta^2 + \\sin^2\\theta d\\phi^2)
 * - Light paths are null geodesics (ds^2 = 0). Under the metric symmetries, energy E and
 *   angular momentum L are conserved along the ray.
 * - In terms of inverse radius u = 1/r and deflection angle \\phi, the geodesic equation of motion is:
 *     (du/d\\phi)^2 = e^2 - u^2(1 - u)
 *   where:
 *     - e^2 = E^2 / L^2 is the energy-like parameter related to the impact parameter b by e^2 = 1 / b^2.
 *     - V(u) = u^2(1 - u) acts as an effective radial potential barrier.
 *
 * The Photon Sphere & Critical Impact Parameter:
 * - The potential V(u) has a maximum at V'(u) = 2u - 3u^2 = 0 \\implies u = 2/3 (or r = 3M = 1.5 in G=c=M=1).
 *   This is the photon sphere: the radius at which light can orbit the black hole in unstable circular orbits.
 * - The critical value of the potential is V(2/3) = (4/9)*(1/3) = 4/27 = \\mu \\approx 0.14815.
 * - Based on the impact parameter e^2:
 *     - e^2 < 4/27: The ray does not have enough energy to cross the photon sphere potential barrier.
 *                   If it comes from infinity (u \\to 0), it reaches a turning point (periapsis) at some u_apsis < 2/3,
 *                   then deflects back to infinity.
 *     - e^2 > 4/27: The ray crosses the photon sphere and falls into the event horizon (u \\to \\infty).
 *
 * Lookup Table (LUT) Architecture:
 * - To achieve real-time frame rates, we do not integrate the differential geodesic equations numerically
 *   per pixel. Instead, we precompute the solutions and store them in two 2D textures:
 *   1. \`ray_deflection_texture\`: Maps (e^2, u) to the accumulated deflection angle \\Delta\\phi and coordinate time \\Delta t.
 *   2. \`ray_inverse_radius_texture\`: Maps (e^2, \\phi) to the inverse radius u and coordinate time t.
 * - This file contains helper functions to map physical parameters (e^2, u, \\phi) to coordinate spaces [0, 1]
 *   optimized for texture sampling density around the chaotic region near the photon sphere.
 */

// Angles and dimensionless quantities.
#define Angle float
#define Real float

// An angle and a time (in the 1st and 2nd components, respectively).
#define TimedAngle vec2

// An inverse distance and a time (in the 1st and 2nd components, respectively).
#define TimedInverseDistance vec2

// A 2D texture with TimedAngle values.
#define RayDeflectionTexture sampler2D

// A 2D texture with TimedInverseDistance values.
#define RayInverseRadiusTexture sampler2D

// The critical value of the Schwarzschild radial potential barrier: V(2/3) = 4/27
const Real kMu = 4.0 / 27.0;

/**
 * @brief Maps the conserved energy parameter e^2 to the U coordinate of the deflection texture.
 * @details Uses a logarithmic compression around the critical value e^2 = kMu (photon sphere)
 *          to allocate more texels to the chaotic deflection region.
 * @param e_square The energy-like parameter e^2 = 1 / b^2.
 * @return U coordinate in [0, 1].
 */
Real GetRayDeflectionTextureUFromEsquare(const Real e_square) {
  if (e_square < kMu) {
    // Map e^2 in [0, kMu) to [0, 0.5)
    return 0.5 - sqrt(-log(1.0 - e_square / kMu) * (1.0 / 50.0));
  } else {
    // Map e^2 in (kMu, \\infty) to (0.5, 1.0]
    return 0.5 + sqrt(-log(1.0 - kMu / e_square) * (1.0 / 50.0));
  }
}

/**
 * @brief Computes the periapsis (closest approach radius) u_apsis analytically for deflected rays.
 * @details Finds the smallest positive root of the cubic equation u^3 - u^2 + e^2 = 0 using trigonometric identities.
 * @param e_square Conserved energy parameter e^2 (must be < kMu).
 * @return Inverse radius at closest approach.
 */
Real GetUapsisFromEsquare(const Real e_square) {
  Real x = (2.0 / kMu) * e_square - 1.0;
  return 1.0 / 3.0 + (2.0 / 3.0) * sin(asin(x) * (1.0 / 3.0));
}

/**
 * @brief Maps the inverse radius u to the V coordinate of the deflection texture.
 * @details Distinguishes between captured rays (e^2 > kMu) and deflected rays (e^2 < kMu).
 * @param e_square Conserved energy parameter.
 * @param u Inverse radius 1/r.
 * @return V coordinate in [0, 1].
 */
Real GetRayDeflectionTextureVFromEsquareAndU(const Real e_square,
                                             const Real u) {
  if (e_square > kMu) {
    // Falling ray: u goes from 0 to infinity. Square-root scaling centers around the photon sphere u = 2/3.
    Real x = u < 2.0 / 3.0 ? -sqrt(2.0 / 3.0 - u) : sqrt(u - 2.0 / 3.0);
    return (sqrt(2.0 / 3.0) + x) / (sqrt(2.0 / 3.0) + sqrt(1.0 / 3.0));
  } else {
    // Deflected ray: u goes from 0 to u_apsis. Scale relative to u_apsis.
    return 1.0 - sqrt(max(1.0 - u / GetUapsisFromEsquare(e_square), 0.0));
  }
}

/**
 * @brief Offsets a normalized coordinate [0, 1] to prevent edge-sampling artifacts in a texture.
 * @param x Normalized coordinate.
 * @param texture_size Width/height of the texture.
 * @return Coordinate centered on texel centers.
 */
Real GetTextureCoordFromUnitRange(const Real x, const int texture_size) {
  return 0.5 / Real(texture_size) + x * (1.0 - 1.0 / Real(texture_size));
}

/**
 * @brief Samples the deflection texture to find the deflection angle and coordinate time.
 * @param ray_deflection_texture The 2D precomputed deflection lookup texture.
 * @param e_square Conserved energy parameter.
 * @param u Inverse radius 1/r.
 * @param deflection_apsis Output: the deflection and time at the closest approach point.
 * @return The deflection angle and time at the current coordinate u.
 */
TimedAngle LookupRayDeflection(IN(RayDeflectionTexture) ray_deflection_texture,
                               const Real e_square, const Real u,
                               OUT(TimedAngle) deflection_apsis) {
  Real tex_u = GetTextureCoordFromUnitRange(
      GetRayDeflectionTextureUFromEsquare(e_square),
      RAY_DEFLECTION_TEXTURE_WIDTH);
  Real tex_v = GetTextureCoordFromUnitRange(
      GetRayDeflectionTextureVFromEsquareAndU(e_square, u),
      RAY_DEFLECTION_TEXTURE_HEIGHT);
  Real tex_v_apsis =
      GetTextureCoordFromUnitRange(1.0, RAY_DEFLECTION_TEXTURE_HEIGHT);
  
  // Sample closest approach values (V = 1.0 corresponds to u_apsis)
  deflection_apsis =
      TimedAngle(texture(ray_deflection_texture, vec2(tex_u, tex_v_apsis)));
  
  // Sample current coordinate values
  return TimedAngle(texture(ray_deflection_texture, vec2(tex_u, tex_v)));
}

/**
 * @brief Computes the asymptotic upper bound of the deflection angle \\phi_ub.
 * @details Restricts V coordinate lookup domain based on impact parameter.
 * @param e_square Conserved energy parameter.
 * @return Angle limit.
 */
Angle GetPhiUbFromEsquare(const Real e_square) {
  return (1.0 + e_square) / (1.0 / 3.0 + 2.0 * e_square * sqrt(e_square)) * rad;
}

/**
 * @brief Maps e^2 to the U coordinate of the inverse radius texture.
 * @param e_square Conserved energy parameter.
 * @return U coordinate in [0, 1].
 */
Real GetRayInverseRadiusTextureUFromEsquare(const Real e_square) {
  return 1.0 / (1.0 + 6.0 * e_square);
}

/**
 * @brief Samples the inverse radius texture to find the radial coordinate along the ray.
 * @param ray_inverse_radius_texture The 2D precomputed inverse radius lookup texture.
 * @param e_square Conserved energy parameter.
 * @param phi The angular coordinate.
 * @return TimedInverseDistance containing (inverse radius u, coordinate time t).
 */
TimedInverseDistance LookupRayInverseRadius(IN(RayInverseRadiusTexture)
                                                ray_inverse_radius_texture,
                                            const Real e_square,
                                            const Angle phi) {
  Real tex_u = GetTextureCoordFromUnitRange(
      GetRayInverseRadiusTextureUFromEsquare(e_square),
      RAY_INVERSE_RADIUS_TEXTURE_WIDTH);
  Real tex_v = GetTextureCoordFromUnitRange(phi / GetPhiUbFromEsquare(e_square),
                                            RAY_INVERSE_RADIUS_TEXTURE_HEIGHT);
  return TimedInverseDistance(
      texture(ray_inverse_radius_texture, vec2(tex_u, tex_v)));
}

/**
 * @brief Anti-aliased 1D pulse/step function.
 * @details Integrates a step pulse over a screen-pixel footprint of width \`fw\` to prevent aliasing.
 * @param edge0 Left edge of the pulse.
 * @param edge1 Right edge of the pulse.
 * @param x Input coordinate.
 * @param fw Filter width (fwidth of the coordinate).
 * @return Filtered coverage value in [0, 1].
 */
Real FilteredPulse(Real edge0, Real edge1, Real x, Real fw) {
  fw = max(fw, 1e-6);
  Real x0 = x - fw * 0.5;
  Real x1 = x0 + fw;
  return max(0.0, (min(x1, edge1) - max(x0, edge0)) / fw);
}

/**
 * @brief Traces a Schwarzschild geodesic to calculate path deflection and disk intersections.
 * @param ray_deflection_texture Geodesic deflection lookup texture.
 * @param ray_inverse_radius_texture Geodesic inverse radius lookup texture.
 * @param u Initial observer inverse radius (1 / observer_radius).
 * @param u_dot Radial velocity parameter du/d\\phi at observer.
 * @param e_square Conserved energy parameter e^2.
 * @param delta Angular coordinate of observer.
 * @param alpha Initial angle of view ray.
 * @param u_ic Inverse inner accretion disk radius (1 / R_inner).
 * @param u_oc Inverse outer accretion disk radius (1 / R_outer).
 * @param u0 Output: inverse radius of the first intersection with the disk.
 * @param phi0 Output: angle of the first disk intersection.
 * @param t0 Output: Schwarzschild coordinate time at the first intersection.
 * @param alpha0 Output: anti-aliasing opacity weight for the first intersection.
 * @param u1 Output: inverse radius of the second intersection (lensing-induced double image).
 * @param phi1 Output: angle of the second intersection.
 * @param t1 Output: Schwarzschild coordinate time at the second intersection.
 * @param alpha1 Output: anti-aliasing opacity weight for the second intersection.
 * @return Total accumulated angular deflection of the ray.
 */
Angle TraceRay(IN(RayDeflectionTexture) ray_deflection_texture,
               IN(RayInverseRadiusTexture) ray_inverse_radius_texture,
               const Real u, const Real u_dot, const Real e_square,
               const Angle delta, const Angle alpha, const Real u_ic,
               const Real u_oc, OUT(Real) u0, OUT(Angle) phi0, OUT(Real) t0,
               OUT(Real) alpha0, OUT(Real) u1, OUT(Angle) phi1, OUT(Real) t1,
               OUT(Real) alpha1) {
  u0 = -1.0;
  u1 = -1.0;
  
  // If the ray starts inside the photon sphere and is captured, it hits the horizon.
  if (e_square < kMu && u > 2.0 / 3.0) {
    return -1.0 * rad;
  }
  
  // Sample the deflection table for the current trajectory
  TimedAngle deflection_apsis;
  TimedAngle deflection = LookupRayDeflection(ray_deflection_texture, e_square,
                                               u, deflection_apsis);
  Angle ray_deflection = deflection.x;
  
  // If the ray is traveling away from the black hole (u_dot > 0), calculate the outgoing path deflection
  if (u_dot > 0.0) {
    ray_deflection =
        e_square < kMu ? 2.0 * deflection_apsis.x - ray_deflection : -1.0 * rad;
  }
  
  // Accretion disk intersection checks (solving where the ray plane crosses the disk z=0 plane)
  Real s = sign(u_dot);
  Angle phi = deflection.x + (s == 1.0 ? pi - delta : delta) + s * alpha;
  Angle phi_apsis = deflection_apsis.x + pi / 2.0;
  
  // --- First intersection point ---
  phi0 = mod(phi, pi);
  TimedInverseDistance ui0 =
      LookupRayInverseRadius(ray_inverse_radius_texture, e_square, phi0);
  if (phi0 < phi_apsis) {
    Real side = s * (ui0.x - u);
    if (side > 1e-3 || (side > -1e-3 && alpha < delta)) {
      u0 = ui0.x;
      phi0 = alpha + phi - phi0;
      t0 = s * (ui0.y - deflection.y);
    }
  }
  
  // --- Second (lensed) intersection point ---
  // Gravitational lensing causes the light beam to bend around the back of the black hole,
  // creating a secondary image of the accretion disk.
  phi = 2.0 * phi_apsis - phi;
  phi1 = mod(phi, pi);
  TimedInverseDistance ui1 =
      LookupRayInverseRadius(ray_inverse_radius_texture, e_square, phi1);
  if (e_square < kMu && s == 1.0 && phi1 < phi_apsis) {
    u1 = ui1.x;
    phi1 = alpha + phi - phi1;
    t1 = 2.0 * deflection_apsis.y - ui1.y - deflection.y;
  }
  
  // Calculate screen-space derivatives to filter the accretion disk boundaries (anti-aliasing)
  Real fw0 = min(fwidth(ui0.x), fwidth(u0 == -1.0 ? u1 : u0));
  Real fw1 = min(fwidth(ui1.x), fwidth(u1 == -1.0 ? u0 : u1));
  alpha0 = FilteredPulse(u_oc, u_ic, u0, fw0);
  alpha1 = FilteredPulse(u_oc, u_ic, u1, fw1);
  
  // Handle coordinate singularity around the critical photon orbit limit kMu
  if (s == 1.0 && abs(e_square - kMu) < min(fwidth(e_square), kMu)) {
    if (alpha0 < 0.99) u0 = 2.0 / (1.0 / u_ic + 1.0 / u_oc);
    if (alpha1 < 0.99) u1 = 2.0 / (1.0 / u_ic + 1.0 / u_oc);
  }
  
  return ray_deflection;
}

/**
 * @brief Overloaded TraceRay function converting radial coordinate to inverse radius u.
 */
Angle TraceRay(IN(RayDeflectionTexture) ray_deflection_texture,
               IN(RayInverseRadiusTexture) ray_inverse_radius_texture,
               const Real p_r, const Angle delta, const Angle alpha,
               const Real u_ic, const Real u_oc, OUT(Real) u0,
               OUT(Angle) phi0, OUT(Real) t0, OUT(Real) alpha0, OUT(Real) u1,
               OUT(Angle) phi1, OUT(Real) t1, OUT(Real) alpha1) {
  Real u = 1.0 / p_r;
  Real u_dot = -u / tan(delta);
  Real e_square = u_dot * u_dot + u * u * (1.0 - u);
  return TraceRay(ray_deflection_texture, ray_inverse_radius_texture, u,
                  u_dot, e_square, delta, alpha, u_ic, u_oc, u0, phi0, t0,
                  alpha0, u1, phi1, t1, alpha1);
}

// Forward declarations of abstract functions defined in the main shader files
Angle RayTrace(Real u, Real u_dot, Real e_square, Angle delta, Angle alpha,
               Real u_ic, Real u_oc, out Real u0, out Angle phi0, out Real t0,
               out Real alpha0, out Real u1, out Angle phi1, out Real t1,
               out Real alpha1);
vec3 Doppler(vec3 rgb, float doppler_factor);
vec3 GalaxyColor(vec3 dir);
vec3 StarTextureColor(vec3 dir);
vec3 StarTextureColor(vec3 dir, float lod, out vec2 sub_position);
vec3 StarColor(vec3 dir, float lensing_amplification_factor);
float Noise(vec2 uv);
vec4 DiscColor(vec2 p, float t, bool top_side, float doppler_factor);

/**
 * @brief Relativistic Doppler shift function.
 * @details Shifts color spectra based on the ratio of emitted frequency to received frequency.
 *          Uses a 3D LUT containing shifted color templates indexed by chromaticity coordinates
 *          and log Doppler factors.
 * @param doppler_texture 3D color lookup table.
 * @param rgb Unshifted source color.
 * @param doppler_factor Relativistic Doppler factor g = \\nu_{receiver} / \\nu_{source}.
 * @return Relativistically Doppler-shifted RGB color.
 */
vec3 DefaultDoppler(highp sampler3D doppler_texture, vec3 rgb,
                    float doppler_factor) {
  float sum = rgb.r + rgb.g + rgb.b;
  if (sum == 0.0) {
    // If no light emitted, output black
    return vec3(0.0);
  }
  vec3 tex_coord;
  // Compute chromaticity coordinates:
  tex_coord.x = rgb.r / sum;
  tex_coord.y = 2.0 * rgb.g / sum;
  
  // Map log Doppler factor to texture coordinate z using an arc-tangent mapping to handle infinite range:
  tex_coord.z = (1.0 / 3.0) * atan((1.0 / 0.21) * log(doppler_factor)) + 0.5;
  
  // Sample shifted chromaticity and scale by original intensity (conserving photon energy scale)
  return sum * texture(doppler_texture, tex_coord).rgb;
}

/**
 * @brief Computes lensed star radiance.
 * @details Gravitational lensing magnifies and distorts background stars. The magnification
 *          factor depends on the ratio of the solid angle of the pixel to the lensed solid angle:
 *            \\mu = \\Omega / \\Omega'
 *          Since stars are point sources, we resolve their intensity and select a cubemap LOD using
 *          partial screen-space derivatives (dFdx, dFdy) to determine the ray footprint deformation.
 * @param dir Deflected view ray direction in world space.
 * @param lensing_amplification_factor The solid angle ratio \\mu.
 * @param min_lod Minimum mipmap level.
 * @return Shaded star brightness.
 */
vec3 DefaultStarColor(vec3 dir, float lensing_amplification_factor,
                       float min_lod) {
  // Compute screen-space gradients of the direction vector
  vec3 dx_dir = dFdx(dir);
  vec3 dy_dir = dFdy(dir);

  // Determine active cube face by finding the coordinate component with the largest magnitude
  vec3 abs_dir = abs(dir);
  float max_abs_dir_comp = max(abs_dir.x, max(abs_dir.y, abs_dir.z));
  if (max_abs_dir_comp == abs_dir.x) {
    dir = dir.zyx;
    dx_dir = dx_dir.zyx;
    dy_dir = dy_dir.zyx;
  } else if (max_abs_dir_comp == abs_dir.y) {
    dir = dir.xzy;
    dx_dir = dx_dir.xzy;
    dy_dir = dy_dir.xzy;
  }

  // Calculate cubemap face coordinate derivatives (analytic perspective projection)
  float inv_dir_z = 1.0 / dir.z;
  vec2 uv = dir.xy * inv_dir_z;
  vec2 dx_uv = (dx_dir.xy - uv * dx_dir.z) * inv_dir_z;
  vec2 dy_uv = (dy_dir.xy - uv * dy_dir.z) * inv_dir_z;

  // Calculate LOD level to query the star density map. Strong lensing stretching (high d_uv)
  // maps to higher LOD levels (aggregating more stars per pixel) to prevent aliasing.
  vec2 d_uv = max(abs(dx_uv + dy_uv), abs(dx_uv - dy_uv));
  vec2 fwidth = (0.5 * STARS_CUBE_MAP_SIZE / MAX_FOOTPRINT_SIZE) * d_uv;
  float lod = max(ceil(max(log2(fwidth.x), log2(fwidth.y))), min_lod);
  float lod_width = (0.5 * STARS_CUBE_MAP_SIZE) / pow(2.0, lod);
  
  if (lod > MAX_FOOTPRINT_LOD) {
    // If footprint is too large, fall back to aggregate background radiance
    return StarTextureColor(dir);
  }

  // Map pixel boundaries to cubemap face texels, looping over the lensed ray footprint to sample stars
  mat2 to_screen_pixel_coords = inverse(mat2(dx_uv, dy_uv));
  ivec2 ij0 = ivec2(floor((uv - d_uv) * lod_width));
  ivec2 ij1 = ivec2(floor((uv + d_uv) * lod_width));
  vec3 color_sum = vec3(0.0);
  for (int j = ij0.y; j <= ij1.y; ++j) {
    for (int i = ij0.x; i <= ij1.x; ++i) {
      vec2 texel_uv = (vec2(i, j) + vec2(0.5)) / lod_width;
      vec3 texel_dir = vec3(texel_uv * dir.z, dir.z);
      if (max_abs_dir_comp == abs_dir.x) {
        texel_dir = texel_dir.zyx;
      } else if (max_abs_dir_comp == abs_dir.y) {
        texel_dir = texel_dir.xzy;
      }
      vec2 delta_uv;
      // Retrieve star intensity and its sub-texel offset position
      vec3 star_color = StarTextureColor(texel_dir, lod, delta_uv);
      vec2 star_uv = uv - texel_uv + delta_uv / lod_width;
      vec2 star_pixel_coords = to_screen_pixel_coords * star_uv;
      
      // Calculate intersection coverage of the star's pixel footprint with the screen pixel
      vec2 overlap = max(vec2(1.0) - abs(star_pixel_coords), 0.0);
      color_sum += star_color * overlap.x * overlap.y;
    }
  }
  
  // Scale total accumulated star color by the gravitational lensing magnification factor
  return color_sum * lensing_amplification_factor;
}

/**
 * @brief Samples the precomputed black body radiation table.
 * @param black_body_texture 1D lookup table containing RGB values of Planck's radiation law.
 * @param temperature Temperature in Kelvin.
 * @return Emitted RGB color spectrum.
 */
vec3 BlackBodyColor(sampler2D black_body_texture, float temperature) {
  // Map temperature to logarithmic scale coordinate: U = log(T / 100) / 6
  float tex_u = (1.0 / 6.0) * log(temperature * (1.0 / 100.0));
  return texture(black_body_texture, vec2(tex_u, 0.5)).rgb;
}

/**
 * @brief Computes accretion disk shading and relativistic temperature profile.
 *
 * Mathematical Accretion Disk Model:
 * - We model the accretion disk as a thin viscous fluid orbiting the black hole.
 * - The stable orbit region is bounded by the Innermost Stable Circular Orbit (ISCO).
 *   For Schwarzschild black holes, r_{ISCO} = 6M = 3.0 (under 2M = 1 normalization).
 * - According to the Novikov-Thorne general relativistic model, the radial temperature profile of
 *   the disk is described by:
 *     T(r) \\propto r^{-3/4} * (1 - \\sqrt{3 / r})^{1/4}
 *   which vanishes at the ISCO boundary r = 3 and reaches a peak near r = 4.08 (49/12).
 * - We evaluate the local temperature using this profile and map it to a black body spectrum,
 *   accounting for Doppler shift from orbit velocities.
 *
 * Procedural Disk Density:
 * - The disk structure is procedurally modeled using Keplerian orbiting dust particles with precessing orbits.
 * - For each particle, the density is accumulated based on distance from its precessing elliptic orbit.
 */
vec4 DefaultDiscColor(vec2 p, float p_t, bool top_side, float doppler_factor,
                      float disc_temperature, sampler2D black_body_texture) {
  float p_r = length(p);
  float p_phi = atan(p.y, p.x);

  // Compute procedural density from orbiting precessing particles
  float density = 0.0;
  for (int i = 0; i < NUM_DISC_PARTICLES; ++i) {
    vec4 params = DISC_PARTICLE_PARAMS[i];
    float u1 = params.x; // Inverse maximum radius
    float u2 = params.y; // Inverse minimum radius
    float phi0 = params.z; // Initial orbital phase
    float dtheta_dphi = params.w; // Relativistic precession ratio
    
    float u_avg = (u1 + u2) * 0.5;
    // Keplerian orbital frequency \\omega = \\sqrt{M / r^3}
    float dphi_dt = u_avg * sqrt(0.5 * u_avg);
    float phi = dphi_dt * p_t + phi0;
    
    // Calculate orbital angle accounting for precession
    float a = mod(p_phi - phi, 2.0 * pi);
    float s = sin(dtheta_dphi * (a + phi));
    float r = 1.0 / (u1 + (u2 - u1) * s * s);
    vec2 d = vec2(a - pi, r - p_r) * vec2(1.0 / pi, 0.5);
    
    // Add procedural turbulence using a high-frequency noise texture
    float noise = Noise(d * vec2(p_r / OUTER_DISC_R, 1.0));
    density += smoothstep(1.0, 0.0, length(d)) * noise;
  }

  // --- Novikov-Thorne Temperature Profile Calculation ---
  const float r_max = 49.0 / 12.0; // Point of peak temperature profile (approx 4.0833)
  const float temperature_profile_max =
      pow((1.0 - sqrt(3.0 / r_max)) / (r_max * r_max * r_max), 0.25);
  
  // Calculate temperature at current radius p_r: T(r) \\propto ((1 - \\sqrt{3/r}) / r^3)^0.25
  float temperature_profile =
      pow((1.0 - sqrt(3.0 / p_r)) / (p_r * p_r * p_r), 0.25);
  
  // Normalize and scale by baseline input temperature
  float temperature =
      disc_temperature * temperature_profile * (1.0 / temperature_profile_max);

  // Shift emission temperature by the relativistic Doppler factor: T_{obs} = T_{emit} * g
  vec3 color = max(density, 0.0) *
      BlackBodyColor(black_body_texture, temperature * doppler_factor);
      
  // Smoothly fade out the disk density at the inner and outer radius boundaries
  float alpha = smoothstep(INNER_DISC_R, INNER_DISC_R * 1.2, p_r) *
      smoothstep(OUTER_DISC_R, OUTER_DISC_R / 1.2, p_r);
  return vec4(color * alpha, alpha);
}

/**
 * @brief Computes final color for a pixel by raytracing null geodesics and shading components.
 *
 * Architecture & Coordinate Frames:
 * - View rays are defined in the camera's local coordinate frame (observer reference frame).
 * - The observer moves with a 4-velocity k_s relative to the Schwarzschild coordinates.
 * - We project the camera ray into a coordinate momentum vector l in Schwarzschild coordinates,
 *   taking into account the spatial basis vectors e_tau (temporal), e_w (horizontal), e_h (vertical),
 *   and e_d (depth/look direction).
 * - The relative frequency shift (Doppler factor) is computed using the scalar product of the light ray's
 *   4-momentum and the 4-velocity of the observer and emitter:
 *     g = (l \\cdot u_{receiver}) / (l \\cdot u_{emitter})
 * - We check for up to two intersections with the accretion disk plane (primary and lensed images).
 * - Finally, we sample the background celestial sphere (star map and galaxy nebulae), applying the
 *   gravitational lensing amplification factor and Doppler color shifting.
 */
vec3 SceneColor(vec4 camera_position, vec3 p, vec4 k_s, vec3 e_tau, vec3 e_w,
                vec3 e_h, vec3 e_d, vec3 view_dir) {
  // Construct the ray direction momentum in the observer's frame
  vec3 q = normalize(view_dir);
  vec3 d = -e_tau + q.x * e_w + q.y * e_h + q.z * e_d;

  // Construct a coordinate basis centered on the black hole, aligned with the camera position
  vec3 e_x_prime = normalize(p);
  vec3 e_z_prime = normalize(cross(e_x_prime, d));
  vec3 e_y_prime = normalize(cross(e_z_prime, e_x_prime));

  const vec3 e_z = vec3(0.0, 0.0, 1.0);
  vec3 t = normalize(cross(e_z, e_z_prime));
  if (dot(t, e_y_prime) < 0.0) {
    t = -t;
  }

  // Calculate the ray angles in the orbital plane
  float alpha = acos(clamp(dot(e_x_prime, t), -1.0, 1.0));
  float delta = acos(clamp(dot(e_x_prime, normalize(d)), -1.0, 1.0));

  // Determine the conserved geodesic parameters at the observer position
  float u = 1.0 / camera_position[1];
  float u_dot = -u / tan(delta);
  float e_square = u_dot * u_dot + u * u * (1.0 - u);
  float e = -sqrt(e_square);

  const float U_IC = 1.0 / INNER_DISC_R;
  const float U_OC = 1.0 / OUTER_DISC_R;
  float u0, phi0, t0, alpha0, u1, phi1, t1, alpha1;
  
  // Trace the geodesic to find coordinates of potential accretion disk intersections
  float deflection = RayTrace(u, u_dot, e_square, delta, alpha, U_IC, U_OC,
                              u0, phi0, t0, alpha0, u1, phi1, t1, alpha1);

  // Compute the scalar product of light momentum l and observer 4-velocity k_s in the metric
  vec4 l = vec4(e / (1.0 - u), -u_dot, 0.0, u * u);
  float g_k_l_receiver = k_s.x * l.x * (1.0 - u) - k_s.y * l.y / (1.0 - u) -
                         u * dot(e_tau, e_y_prime) * l.w / (u * u);

  // Calculate the lensed deflection direction of the background view
  float delta_prime = delta + max(deflection, 0.0);
  vec3 d_prime = cos(delta_prime) * e_x_prime + sin(delta_prime) * e_y_prime;

  vec3 color = vec3(0.0, 0.0, 0.0);
  
  // If the ray escapes the black hole (deflection >= 0), sample the lensed background stars and galaxies
  if (deflection >= 0.0) {
    float g_k_l_source = e; // Background stars are assumed static at infinity
    float doppler_factor = g_k_l_receiver / g_k_l_source;

    // Estimate the solid angle magnification factor of the lens:
    float omega = length(cross(dFdx(q), dFdy(q)));
    float omega_prime = length(cross(dFdx(d_prime), dFdy(d_prime)));
    float lensing_amplification_factor = omega / omega_prime;
    
    // Clamp the amplification factor to prevent numerical infinities on Einstein rings
    lensing_amplification_factor = min(lensing_amplification_factor, 1e6);

    // Compute pixel footprint area on the celestial sphere to scale the point star intensities
    float pixel_area = max(omega * (1024.0 * 1024.0), 1.0);

    color += GalaxyColor(d_prime);
    color += StarColor(d_prime, lensing_amplification_factor / pixel_area);
    color = Doppler(color, doppler_factor);
  }
  
  // --- Composite the secondary (lensed) disk image if intersected ---
  if (u1 >= 0.0 && alpha1 > 0.0) {
    // Relativistic orbital velocity of disk particles at radius 1/u1:
    // Compute emitter 4-velocity scalar product:
    float g_k_l_source = e * sqrt(2.0 / (2.0 - 3.0 * u1)) -
                         u1 * sqrt(u1 / (2.0 - 3.0 * u1)) * dot(e_z, e_z_prime);
    float doppler_factor = g_k_l_receiver / g_k_l_source;
    
    // Determine whether the ray hits the top or bottom face of the disk
    bool top_side =
        (mod(abs(phi1 - alpha), 2.0 * pi) < 1e-3) == (e_x_prime.z > 0.0);

    vec3 i1 = (e_x_prime * cos(phi1) + e_y_prime * sin(phi1)) / u1;
    vec4 disc_color =
        DiscColor(i1.xy, camera_position[0] - t1, top_side, doppler_factor);
        
    // Standard alpha blending: color = color * (1 - alpha_src) + color_src * alpha_src
    color = color * (1.0 - disc_color.a) + alpha1 * disc_color.rgb;
  }
  
  // --- Composite the primary disk image if intersected ---
  if (u0 >= 0.0 && alpha0 > 0.0) {
    // Relativistic orbital velocity of disk particles at radius 1/u0:
    float g_k_l_source = e * sqrt(2.0 / (2.0 - 3.0 * u0)) -
                         u0 * sqrt(u0 / (2.0 - 3.0 * u0)) * dot(e_z, e_z_prime);
    float doppler_factor = g_k_l_receiver / g_k_l_source;
    
    bool top_side =
        (mod(abs(phi0 - alpha), 2.0 * pi) < 1e-3) == (e_x_prime.z > 0.0);

    vec3 i0 = (e_x_prime * cos(phi0) + e_y_prime * sin(phi0)) / u0;
    vec4 disc_color =
        DiscColor(i0.xy, camera_position[0] - t0, top_side, doppler_factor);
        
    color = color * (1.0 - disc_color.a) + alpha0 * disc_color.rgb;
  }
  
  return color;
}
`,M=[600,[[.537425,.0200663,.00720805,.00159719,907315e-9,275641e-9],[.102792,.0185013,.00291111,519003e-9,519003e-9,519003e-9],[.0704669,.0181097,.00232751,.00232751,.0015737,.0015737],[.0117432,.0117432,.00226476,.00154524,.00116041,.00116041],[.00746695,.00746695,.00171226,.00104832,766638e-9,766638e-9],[.00478257,.00478257,.00100513,818812e-9,397319e-9,397319e-9],[.0037712,.0037712,490892e-9,490892e-9,490892e-9,490892e-9],[.00108603,.00108603,924505e-9,924505e-9,141375e-9,0],[604275e-9,604275e-9,604275e-9,604275e-9,604275e-9,604275e-9]],800,[[.368483,.0216534,.00816305,.00188928,.00108659,3135e-7],[.136249,.0234538,.0044714,35596e-8,35596e-8,35596e-8],[.115467,.0273797,.00361202,.00361202,.0024381,.0024381],[.0185586,.0185586,.00364918,.00244913,.00186549,.00186549],[.0120676,.0120676,.00279834,.00169769,.00125113,.00125113],[.00782081,.00782081,.00165563,.00133947,653398e-9,653398e-9],[.00620986,.00620986,8107e-7,8107e-7,8107e-7,8107e-7],[.0017856,.0017856,.00153169,.00153169,231589e-9,0],[999842e-9,999842e-9,999842e-9,999842e-9,999842e-9,999842e-9]],1e3,[[.256172,.0203539,.00797156,.00192098,.00111651,302982e-9],[.153181,.0252457,.0056879,524724e-10,524724e-10,524724e-10],[.154089,.0348566,.00470551,.00470551,.00317819,.00317819],[.0246407,.0246407,.00494194,.00326092,.00251954,.00251954],[.0163845,.0163845,.00384115,.00230972,.00171517,.00171517],[.010743,.010743,.00229079,.00184054,902617e-9,902617e-9],[.00858938,.00858938,.00112463,.00112463,.00112463,.00112463],[.00246603,.00246603,.0021316,.0021316,318642e-9,0],[.00138965,.00138965,.00138965,.00138965,.00138965,.00138965]],1200,[[.183275,.0181576,.00737853,.00184847,.00110057,302961e-9],[.155444,.026573,.00631122,0,0,0],[.175386,.0406837,.00558637,.00558637,.00379344,.00379344],[.0298822,.0298822,.00611926,.00396558,.00310871,.00310871],[.0203221,.0203221,.00481554,.00287054,.00214781,.00214781],[.0134794,.0134794,.00289524,.00230992,.00113896,.00113896],[.0108519,.0108519,.00142504,.00142504,.00142504,.00142504],[.00311065,.00311065,.0027096,.0027096,400402e-9,0],[.00176416,.00176416,.00176416,.00176416,.00176416,.00176416]],1400,[[.13507,.015829,.00665188,.0017314,.00105678,303019e-9],[.150222,.0270593,.00654101,0,0,0],[.188342,.0450054,.00639373,.0062499,.00430739,.00430739],[.034393,.034393,.00718937,.00457886,.00363942,.00363942],[.0239205,.0239205,.00572745,.00338534,.00255211,.00255211],[.016048,.016048,.00347179,.00275076,.00136368,.00136368],[.013009,.013009,.00171332,.00171332,.00171332,.00171332],[.00372297,.00372297,.00326808,.00326808,477361e-9,0],[.00212503,.00212503,.00212503,.00212503,.00212503,.00212503]],1600,[[.102246,.013671,.00592138,.00159768,.00100127,299669e-9],[.14157,.026801,.00657111,0,0,0],[.19617,.0482116,.00708177,.0067665,.00473424,.00473424],[.0382986,.0382986,.00816852,.00511466,.00412131,.00412131],[.0272343,.0272343,.00658764,.00386174,.00293299,.00293299],[.0184784,.0184784,.00402643,.00316811,.00157908,.00157908],[.0150825,.0150825,.00199223,.00199223,.00199223,.00199223],[.00430923,.00430923,.00381212,.00381212,55036e-8,0],[.00247558,.00247558,.00247558,.00247558,.00247558,.00247558]]],S=9,X="6.55e4",ne=`#version 300 es
  layout(location=0) in vec4 vertex;
  void main() { gl_Position = vertex; }`,ae=`#version 300 es
  precision highp float;
  const vec4 WEIGHTS = vec4(1.0, 3.0, 3.0, 1.0) / 8.0;
  uniform sampler2D source;
  uniform vec2 source_delta_uv;
  layout(location=0) out vec4 frag_color;
  void main() { 
    vec2 ij = floor(gl_FragCoord.xy);
    vec2 source_ij = ij * 2.0 - vec2(1.5);
    vec2 source_uv = source_ij * source_delta_uv;
    vec3 color = vec3(0.0);
    for (int i = 0; i < 4; ++i) {
      float wi = WEIGHTS[i];
      for (int j = 0; j < 4; ++j) {
        float wj = WEIGHTS[j];
        vec2 delta_uv = vec2(i, j) * source_delta_uv;
        color += wi * wj * texture(source, source_uv + delta_uv).rgb;
      }
    }
    frag_color = vec4(min(color, ${X}), 1.0);
  }`,ie=`#version 300 es
  precision highp float;
  uniform sampler2D source;
  uniform vec2 source_delta_uv;
  uniform vec3 source_samples_uvw[SIZE];
  layout(location=0) out vec4 frag_color;
  void main() { 
    vec2 source_uv = (gl_FragCoord.xy + vec2(1.0)) * source_delta_uv;
    vec3 color = vec3(0.0);
    for (int i = 0; i < SIZE; ++i) {
      vec3 uvw = source_samples_uvw[i];
      color += uvw.z * texture(source, source_uv + uvw.xy).rgb;
    }
    frag_color = vec4(min(color, ${X}), 1.0);
  }`,oe=`#version 300 es
  precision highp float;
  const vec4 WEIGHTS[4] = vec4[4] (
    vec4(1.0, 3.0, 3.0, 9.0) / 16.0,
    vec4(3.0, 1.0, 9.0, 3.0) / 16.0,
    vec4(3.0, 9.0, 1.0, 3.0) / 16.0,
    vec4(9.0, 3.0, 3.0, 1.0) / 16.0
  );
  uniform sampler2D source;
  uniform vec2 source_delta_uv;
  layout(location=0) out vec4 frag_color;
  void main() {
    vec2 ij = floor(gl_FragCoord.xy);
    vec2 source_ij = floor((ij - vec2(1.0)) * 0.5) + vec2(0.5);
    vec2 source_uv = source_ij * source_delta_uv;
    vec3 c0 = texture(source, source_uv).rgb;
    vec3 c1 = texture(source, source_uv + vec2(source_delta_uv.x, 0.0)).rgb;
    vec3 c2 = texture(source, source_uv + vec2(0.0, source_delta_uv.y)).rgb;
    vec3 c3 = texture(source, source_uv + source_delta_uv).rgb;
    vec4 weight = WEIGHTS[int(mod(ij.x, 2.0) + 2.0 * mod(ij.y, 2.0))];
    vec3 color = weight.x * c0 + weight.y * c1 + weight.z * c2 + weight.w * c3;
    frag_color = vec4(min(color, ${X}), 1.0);
  }`,se=`#version 300 es
  precision highp float;
  uniform sampler2D source;
  uniform vec2 source_delta_uv;
  uniform vec3 source_samples_uvw[SIZE];
  uniform sampler2D bloom;
  uniform vec2 bloom_delta_uv;
  uniform float intensity;
  uniform float exposure;
  uniform bool high_contrast;
  layout(location=0) out vec4 frag_color;

  // Standard exponential tone mapping: T(x) = 1 - e^-x
  vec3 toneMap(vec3 color) {
    return pow(vec3(1.0) - exp(-color), vec3(1.0 / 2.2));
  }
  
  // ACES Filmic Tone Mapping approximation curve
  vec3 toneMapACES(vec3 color) {
    const float A = 2.51;
    const float B = 0.03;
    const float C = 2.43;
    const float D = 0.59;
    const float E = 0.14;
    color = (color * (A * color + B)) / (color * (C * color + D) + E);
    return pow(color, vec3(1.0 / 2.2));
  }

  void main() {
    vec2 source_uv = (gl_FragCoord.xy + vec2(1.0)) * source_delta_uv;
    vec3 color = texture(bloom, 0.5 * gl_FragCoord.xy * bloom_delta_uv).rgb;
    for (int i = 0; i < SIZE; ++i) {
      vec3 uvw = source_samples_uvw[i];
      color += uvw.z * texture(source, source_uv + uvw.xy).rgb;
    }
    color = mix(texture(source, source_uv).rgb, color, intensity) * exposure;
    color = min(color, 10.0);
    if (high_contrast) {
      color = toneMapACES(color);
    } else {
      color = toneMap(color);
    }
    frag_color = vec4(color, 1.0);
  }`,N=function(i,e,t){const r=i.createShader(e);if(!r)throw new Error("Could not create shader");return i.shaderSource(r,t),i.compileShader(r),r},B=function(i,e,t){const r=i.createTexture();if(!r)throw new Error("Could not create texture");return i.activeTexture(e),i.bindTexture(t,r),i.texParameteri(t,i.TEXTURE_MIN_FILTER,i.NEAREST),i.texParameteri(t,i.TEXTURE_MAG_FILTER,i.NEAREST),i.texParameteri(t,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(t,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),r};class ce{constructor(e,t,r){l(this,"gl");l(this,"width");l(this,"height");l(this,"vertexBuffer");l(this,"downsampleProgram");l(this,"bloomProgram");l(this,"upsampleProgram");l(this,"renderProgram");l(this,"numLevels",0);l(this,"mipmapTextures",[]);l(this,"filterTextures",[]);l(this,"bloomFilters",[]);l(this,"mipmapFbos",[]);l(this,"filterFbos",[]);l(this,"depthBuffer",null);this.gl=e,this.width=t,this.height=r,e.getExtension("OES_texture_float_linear"),e.getExtension("EXT_color_buffer_float"),e.getExtension("EXT_float_blend"),this.vertexBuffer=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.vertexBuffer),e.bufferData(e.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),e.STATIC_DRAW);const n=N(e,e.VERTEX_SHADER,ne),o=a=>{const c=e.createProgram();if(!c)throw new Error("Could not create program");return e.attachShader(c,n),e.attachShader(c,N(e,e.FRAGMENT_SHADER,a)),e.linkProgram(c),c};this.downsampleProgram=o(ae),e.useProgram(this.downsampleProgram),e.uniform1i(e.getUniformLocation(this.downsampleProgram,"source"),0),this.downsampleProgram.sourceDeltaUvUniform=e.getUniformLocation(this.downsampleProgram,"source_delta_uv"),this.bloomProgram=o(ie.replace(/SIZE/g,"25")),e.useProgram(this.bloomProgram),e.uniform1i(e.getUniformLocation(this.bloomProgram,"source"),0),this.bloomProgram.sourceDeltaUvUniform=e.getUniformLocation(this.bloomProgram,"source_delta_uv"),this.upsampleProgram=o(oe),e.useProgram(this.upsampleProgram),e.uniform1i(e.getUniformLocation(this.upsampleProgram,"source"),0),this.upsampleProgram.sourceDeltaUvUniform=e.getUniformLocation(this.upsampleProgram,"source_delta_uv"),this.renderProgram=o(se.replace(/SIZE/g,"25")),e.useProgram(this.renderProgram),e.uniform1i(e.getUniformLocation(this.renderProgram,"source"),0),e.uniform1i(e.getUniformLocation(this.renderProgram,"bloom"),1),this.renderProgram.intensityUniform=e.getUniformLocation(this.renderProgram,"intensity"),this.renderProgram.exposureUniform=e.getUniformLocation(this.renderProgram,"exposure"),this.renderProgram.highContrastUniform=e.getUniformLocation(this.renderProgram,"high_contrast"),this.renderProgram.sourceDeltaUvUniform=e.getUniformLocation(this.renderProgram,"source_delta_uv"),this.renderProgram.bloomDeltaUvUniform=e.getUniformLocation(this.renderProgram,"bloom_delta_uv"),this.numLevels=0,this.mipmapTextures=[],this.filterTextures=[],this.bloomFilters=[];for(let a=0;a<S;++a){const c=B(e,e.TEXTURE0,e.TEXTURE_2D);if(this.mipmapTextures.push({texture:c,width:0,height:0}),a>0){const u=B(e,e.TEXTURE0,e.TEXTURE_2D);a==1&&(e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MIN_FILTER,e.LINEAR),e.texParameteri(e.TEXTURE_2D,e.TEXTURE_MAG_FILTER,e.LINEAR)),this.filterTextures.push({texture:u,width:0,height:0})}else this.filterTextures.push(null)}this.mipmapFbos=[],this.filterFbos=[],this.depthBuffer=null;for(let a=0;a<S;++a){const c=e.createFramebuffer();if(!c)throw new Error("Could not create framebuffer");if(this.mipmapFbos.push(c),e.bindFramebuffer(e.FRAMEBUFFER,c),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,this.mipmapTextures[a].texture,0),a>0){const u=e.createFramebuffer();if(!u)throw new Error("Could not create framebuffer");this.filterFbos.push(u),e.bindFramebuffer(e.FRAMEBUFFER,u);const s=this.filterTextures[a];s&&e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_2D,s.texture,0)}else this.depthBuffer=e.createRenderbuffer(),e.bindRenderbuffer(e.RENDERBUFFER,this.depthBuffer),e.renderbufferStorage(e.RENDERBUFFER,e.DEPTH_COMPONENT16,this.mipmapTextures[0].width,this.mipmapTextures[0].height),e.framebufferRenderbuffer(e.FRAMEBUFFER,e.DEPTH_ATTACHMENT,e.RENDERBUFFER,this.depthBuffer),this.filterFbos.push(null)}e.bindFramebuffer(e.FRAMEBUFFER,null),this.resize(t,r)}resize(e,t){this.width=e,this.height=t;const r=this.gl;r.activeTexture(r.TEXTURE0);let n=0,o=e,a=t;for(;a>2&&n<S;){const d=this.mipmapTextures[n];r.bindTexture(r.TEXTURE_2D,d.texture),r.texImage2D(r.TEXTURE_2D,0,r.RGBA16F,o+2,a+2,0,r.RGBA,r.FLOAT,null),d.width=o+2,d.height=a+2;const m=this.filterTextures[n];n>0&&m?(r.bindTexture(r.TEXTURE_2D,m.texture),r.texImage2D(r.TEXTURE_2D,0,r.RGBA16F,o,a,0,r.RGBA,r.FLOAT,null),m.width=o,m.height=a):n===0&&(r.bindRenderbuffer(r.RENDERBUFFER,this.depthBuffer),r.renderbufferStorage(r.RENDERBUFFER,r.DEPTH_COMPONENT16,this.mipmapTextures[0].width,this.mipmapTextures[0].height)),n+=1,o=Math.ceil(o/2),a=Math.ceil(a/2)}this.numLevels=n,this.bloomFilters=[];let c=0,u=M[c];for(let d=2;d<M.length;d+=2){const m=M[d];Math.abs(m-t)<Math.abs(u-t)&&(c=d,u=m)}const s=M[c+1];for(let d=0;d<this.numLevels;++d){const m=[],h=this.mipmapTextures[d].width,_=this.mipmapTextures[d].height;for(let f=-2;f<=2;++f){const p=Math.abs(f);for(let T=-2;T<=2;++T){const R=Math.abs(T),A=R<p?p*(p+1)/2+R:R*(R+1)/2+p,v=s[d][A];m.push([T/h,f/_,v])}}this.bloomFilters.push(m)}}begin(){const e=this.gl;e.bindFramebuffer(e.FRAMEBUFFER,this.mipmapFbos[0]),e.viewport(1,1,this.mipmapTextures[0].width-2,this.mipmapTextures[0].height-2)}end(e,t,r){const n=this.gl;n.activeTexture(n.TEXTURE0);let o=this.downsampleProgram;n.useProgram(o);for(let c=1;c<this.numLevels;++c){const u=this.mipmapTextures[c];n.bindFramebuffer(n.FRAMEBUFFER,this.mipmapFbos[c]),n.viewport(1,1,u.width-2,u.height-2),n.bindTexture(n.TEXTURE_2D,this.mipmapTextures[c-1].texture),o.sourceDeltaUvUniform&&n.uniform2f(o.sourceDeltaUvUniform,1/this.mipmapTextures[c-1].width,1/this.mipmapTextures[c-1].height),this.drawQuad(o)}o=this.bloomProgram,n.useProgram(o);for(let c=1;c<this.numLevels;++c){const u=this.filterTextures[c];if(u){n.bindFramebuffer(n.FRAMEBUFFER,this.filterFbos[c]),n.viewport(0,0,u.width,u.height),n.bindTexture(n.TEXTURE_2D,this.mipmapTextures[c].texture),o.sourceDeltaUvUniform&&n.uniform2f(o.sourceDeltaUvUniform,1/this.mipmapTextures[c].width,1/this.mipmapTextures[c].height);for(let s=0;s<25;++s)n.uniform3f(n.getUniformLocation(o,`source_samples_uvw[${s}]`),this.bloomFilters[c][s][0],this.bloomFilters[c][s][1],this.bloomFilters[c][s][2]);this.drawQuad(o)}}o=this.upsampleProgram,n.activeTexture(n.TEXTURE0),n.enable(n.BLEND),n.blendEquation(n.FUNC_ADD),n.blendFunc(n.ONE,n.ONE),n.useProgram(o);for(let c=this.numLevels-2;c>=1;--c){const u=this.filterTextures[c];if(!u)continue;n.bindFramebuffer(n.FRAMEBUFFER,this.filterFbos[c]),n.viewport(0,0,u.width,u.height);const s=this.filterTextures[c+1];s&&(n.bindTexture(n.TEXTURE_2D,s.texture),o.sourceDeltaUvUniform&&n.uniform2f(o.sourceDeltaUvUniform,1/s.width,1/s.height)),this.drawQuad(o)}n.disable(n.BLEND),n.bindFramebuffer(n.FRAMEBUFFER,null),n.viewport(0,0,this.width,this.height),o=this.renderProgram,n.useProgram(o),n.activeTexture(n.TEXTURE0),n.bindTexture(n.TEXTURE_2D,this.mipmapTextures[0].texture),n.activeTexture(n.TEXTURE1);const a=this.filterTextures[1];if(a&&n.bindTexture(n.TEXTURE_2D,a.texture),o.sourceDeltaUvUniform&&n.uniform2f(o.sourceDeltaUvUniform,1/this.mipmapTextures[0].width,1/this.mipmapTextures[0].height),o.bloomDeltaUvUniform&&a&&n.uniform2f(o.bloomDeltaUvUniform,1/a.width,1/a.height),this.numLevels>0)for(let c=0;c<25;++c)n.uniform3f(n.getUniformLocation(o,`source_samples_uvw[${c}]`),this.bloomFilters[0][c][0],this.bloomFilters[0][c][1],this.bloomFilters[0][c][2]);o.intensityUniform&&n.uniform1f(o.intensityUniform,e),o.exposureUniform&&n.uniform1f(o.exposureUniform,t),o.highContrastUniform&&n.uniform1i(o.highContrastUniform,r?1:0),this.drawQuad(o)}drawQuad(e){const t=this.gl,r=t.getAttribLocation(e,"vertex");t.bindBuffer(t.ARRAY_BUFFER,this.vertexBuffer),t.vertexAttribPointer(r,2,t.FLOAT,!1,0,0),t.enableVertexAttribArray(r),t.drawArrays(t.TRIANGLE_STRIP,0,4)}}const E=6,O=function(i){return[i.TEXTURE_CUBE_MAP_POSITIVE_X,i.TEXTURE_CUBE_MAP_NEGATIVE_X,i.TEXTURE_CUBE_MAP_POSITIVE_Y,i.TEXTURE_CUBE_MAP_NEGATIVE_Y,i.TEXTURE_CUBE_MAP_POSITIVE_Z,i.TEXTURE_CUBE_MAP_NEGATIVE_Z]},b=function(i,e){const t=i.createTexture();if(!t)throw new Error("Could not create WebGL texture");return i.activeTexture(i.TEXTURE0),i.bindTexture(e,t),i.texParameteri(e,i.TEXTURE_MIN_FILTER,i.LINEAR),i.texParameteri(e,i.TEXTURE_MAG_FILTER,i.LINEAR),i.texParameteri(e,i.TEXTURE_WRAP_S,i.CLAMP_TO_EDGE),i.texParameteri(e,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),t},q=function(i){return i.startsWith("http://")||i.startsWith("https://")?i:"/black-hole/"+i},P=function(i,e){const t=new XMLHttpRequest;t.open("GET",q(i)),t.responseType="arraybuffer",t.onload=()=>{const r=new DataView(t.response),n=new Float32Array(r.byteLength/Float32Array.BYTES_PER_ELEMENT);for(let o=0;o<n.length;++o)n[o]=r.getFloat32(o*Float32Array.BYTES_PER_ELEMENT,!0);e(n)},t.send()},le=function(i,e){const t=new XMLHttpRequest;t.open("GET",q(i)),t.responseType="arraybuffer",t.onload=()=>{const r=new DataView(t.response),n=new Uint32Array(r.byteLength/Uint32Array.BYTES_PER_ELEMENT);for(let o=0;o<n.length;++o)n[o]=r.getUint32(o*Uint32Array.BYTES_PER_ELEMENT,!0);e(n)},t.send()},ue=function(i,e,t){const r=i.createTexture();if(!r)throw new Error("Could not create noise texture");i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,r),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.REPEAT),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.REPEAT),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.LINEAR_MIPMAP_LINEAR),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.LINEAR),i.texParameterf(i.TEXTURE_2D,e.TEXTURE_MAX_ANISOTROPY_EXT,i.getParameter(e.MAX_TEXTURE_MAX_ANISOTROPY_EXT));const n=new Image;return n.addEventListener("load",function(){i.bindTexture(i.TEXTURE_2D,r),i.texImage2D(i.TEXTURE_2D,0,i.R8,i.RED,i.UNSIGNED_BYTE,n),i.generateMipmap(i.TEXTURE_2D)}),n.src="/black-hole/"+t,r};class de{constructor(e,t){l(this,"loadingPanel");l(this,"loadingBar");l(this,"gl");l(this,"rayDeflectionTexture",null);l(this,"rayInverseRadiusTexture",null);l(this,"blackbodyTexture",null);l(this,"dopplerTexture",null);l(this,"gridTexture",null);l(this,"galaxyTexture",null);l(this,"starTexture",null);l(this,"starTexture2",null);l(this,"noiseTexture",null);l(this,"tilesQueue",[]);l(this,"numTilesLoaded",0);l(this,"numTilesLoadedPerLevel",[0,0,0,0,0]);l(this,"numPendingRequests",0);const r=e.querySelector("#cv_loading_panel"),n=e.querySelector("#cv_loading_bar");if(!r)throw new Error("cv_loading_panel not found");if(!n)throw new Error("cv_loading_bar not found");this.loadingPanel=r,this.loadingBar=n,this.gl=t;const o=t.getExtension("EXT_texture_filter_anisotropic");this.loadTextures(o),this.loadStarTextures(o),this.noiseTexture=ue(t,o,"noise_texture.png"),document.body.addEventListener("keypress",a=>this.onKeyPress(a))}loadTextures(e){const t=this.gl;P("deflection.dat",n=>{this.rayDeflectionTexture=b(t,t.TEXTURE_2D),this.rayDeflectionTexture.width=n[0],this.rayDeflectionTexture.height=n[1],t.texImage2D(t.TEXTURE_2D,0,t.RG32F,n[0],n[1],0,t.RG,t.FLOAT,n.slice(2))}),P("inverse_radius.dat",n=>{this.rayInverseRadiusTexture=b(t,t.TEXTURE_2D),this.rayInverseRadiusTexture.width=n[0],this.rayInverseRadiusTexture.height=n[1],t.texImage2D(t.TEXTURE_2D,0,t.RG32F,n[0],n[1],0,t.RG,t.FLOAT,n.slice(2))}),this.dopplerTexture=b(t,t.TEXTURE_3D),t.texParameteri(t.TEXTURE_3D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_3D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_3D,t.TEXTURE_WRAP_R,t.CLAMP_TO_EDGE),P("doppler.dat",n=>{t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_3D,this.dopplerTexture),t.texImage3D(t.TEXTURE_3D,0,t.RGB32F,64,32,64,0,t.RGB,t.FLOAT,n)}),this.blackbodyTexture=b(t,t.TEXTURE_2D),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_S,t.CLAMP_TO_EDGE),t.texParameteri(t.TEXTURE_2D,t.TEXTURE_WRAP_T,t.CLAMP_TO_EDGE),P("black_body.dat",n=>{t.activeTexture(t.TEXTURE0),t.bindTexture(t.TEXTURE_2D,this.blackbodyTexture),t.texImage2D(t.TEXTURE_2D,0,t.RGB32F,128,1,0,t.RGB,t.FLOAT,n)}),this.gridTexture=b(t,t.TEXTURE_CUBE_MAP),t.texStorage2D(t.TEXTURE_CUBE_MAP,10,t.R8,512,512),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MIN_FILTER,t.LINEAR_MIPMAP_LINEAR),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameterf(t.TEXTURE_CUBE_MAP,e.TEXTURE_MAX_ANISOTROPY_EXT,t.getParameter(e.MAX_TEXTURE_MAX_ANISOTROPY_EXT));const r=new Uint8Array(512*512);for(let n=0;n<512;++n){const o=(n+2)%32;for(let a=0;a<512;++a){const c=(a+2)%32;r[a+n*512]=c<4||o<4?255:0}}for(let n of O(t))t.texSubImage2D(n,0,0,0,512,512,t.RED,t.UNSIGNED_BYTE,r,0);t.generateMipmap(t.TEXTURE_CUBE_MAP)}loadStarTextures(e){const t=this.gl;this.galaxyTexture=b(t,t.TEXTURE_CUBE_MAP),t.bindTexture(t.TEXTURE_CUBE_MAP,this.galaxyTexture),t.texStorage2D(t.TEXTURE_CUBE_MAP,12,t.RGB9_E5,2048,2048),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MIN_FILTER,t.LINEAR_MIPMAP_LINEAR),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameterf(t.TEXTURE_CUBE_MAP,e.TEXTURE_MAX_ANISOTROPY_EXT,t.getParameter(e.MAX_TEXTURE_MAX_ANISOTROPY_EXT)),this.starTexture=b(t,t.TEXTURE_CUBE_MAP),t.bindTexture(t.TEXTURE_CUBE_MAP,this.starTexture),t.texStorage2D(t.TEXTURE_CUBE_MAP,E+1,t.RGB9_E5,2048,2048),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MIN_FILTER,t.NEAREST_MIPMAP_NEAREST),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MAG_FILTER,t.NEAREST),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MAX_LOD,E),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MAX_LEVEL,E),this.starTexture2=b(t,t.TEXTURE_CUBE_MAP),t.bindTexture(t.TEXTURE_CUBE_MAP,this.starTexture2),t.texStorage2D(t.TEXTURE_CUBE_MAP,11-E,t.RGB9_E5,2048/(1<<E+1),2048/(1<<E+1)),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MIN_FILTER,t.LINEAR_MIPMAP_LINEAR),t.texParameteri(t.TEXTURE_CUBE_MAP,t.TEXTURE_MAG_FILTER,t.LINEAR),t.texParameterf(t.TEXTURE_CUBE_MAP,e.TEXTURE_MAX_ANISOTROPY_EXT,t.getParameter(e.MAX_TEXTURE_MAX_ANISOTROPY_EXT));const r="gaia_sky_map",n=["pos-x","neg-x","pos-y","neg-y","pos-z","neg-z"],o=O(t);for(let a=0;a<=4;++a)for(let c=0;c<6;++c){const u=2048/(1<<a),s=Math.min(256,u),d=u/s;for(let m=0;m<d;++m)for(let h=0;h<d;++h){const _=o[c],f=`${r}/${n[c]}-${a}-${h}-${m}.dat`;this.tilesQueue.push({l:a,ti:h,tj:m,i:c,target:_,url:f})}}this.updateLoadingBar(),this.loadStarTextureTiles()}loadStarTextureTiles(){for(;this.tilesQueue.length>0&&this.numPendingRequests<6;){const e=this.tilesQueue.pop();e&&this.loadStarTextureTile(e.l,e.ti,e.tj,e.i,e.target,e.url)}}loadStarTextureTile(e,t,r,n,o,a){const c=this.gl,u=2048/(1<<e);le(a,s=>{c.activeTexture(c.TEXTURE0);let d=0,m=e,h=Math.min(256,u);for(;d<s.length;)c.bindTexture(c.TEXTURE_CUBE_MAP,this.galaxyTexture),c.texSubImage2D(o,m,t*h,r*h,h,h,c.RGB,c.UNSIGNED_INT_5_9_9_9_REV,s.subarray(d,d+h*h),0),d+=h*h,m<=E?(c.bindTexture(c.TEXTURE_CUBE_MAP,this.starTexture),c.texSubImage2D(o,m,t*h,r*h,h,h,c.RGB,c.UNSIGNED_INT_5_9_9_9_REV,s.subarray(d,d+h*h),0)):(c.bindTexture(c.TEXTURE_CUBE_MAP,this.starTexture2),c.texSubImage2D(o,m-(E+1),t*h,r*h,h,h,c.RGB,c.UNSIGNED_INT_5_9_9_9_REV,s.subarray(d,d+h*h),0)),d+=h*h,m+=1,h/=2;this.numTilesLoaded+=1,e<=E&&(this.numTilesLoadedPerLevel[e]+=1),this.numPendingRequests-=1,this.updateLoadingBar(),this.loadStarTextureTiles()}),this.numPendingRequests+=1}updateLoadingBar(){this.loadingBar.style.width=`${this.numTilesLoaded/516*100}%`,this.numTilesLoaded==516&&this.loadingPanel.classList.toggle("cv-loaded",!0)}getMinLoadedStarTextureLod(){return this.numTilesLoadedPerLevel[0]==384?0:this.numTilesLoadedPerLevel[1]==96?1:this.numTilesLoadedPerLevel[2]==24?2:this.numTilesLoadedPerLevel[3]==6?3:4}onKeyPress(e){e.key==" "&&this.loadingPanel.classList.toggle("cv-hidden")}}const he=6,me=function(){const t=function(o,a,c){const u=(a-o)/(c-o),s=1e5;let d=0;for(let m=0;m<s;++m){const h=1/s,_=(m+.5)/s;d+=h/Math.sqrt((1-_*_)*(1-u*_*_))}return Math.PI*Math.sqrt(c-o)/(4*d)};let r="",n=0;for(let o=3;o<12;o+=.75){const a=.1*Math.random(),u=1/(o*(1+a)/(1-a)),s=1/o,d=1-u-s,m=2*Math.PI*Math.random(),h=t(u,s,d),_=u.toPrecision(3),f=s.toPrecision(3),p=m.toPrecision(3),T=h.toPrecision(3);r+=`${n==0?"":`,
`}vec4(${_}, ${f}, ${p}, ${T})`,n+=1}return`
      const float INNER_DISC_R = ${3 .toPrecision(3)};
      const float OUTER_DISC_R = ${12 .toPrecision(3)};
      const int NUM_DISC_PARTICLES = ${n};
      const vec4 DISC_PARTICLE_PARAMS[${n}] = vec4[${n}] (
        ${r}
      );`},z=function(i,e,t){const r=i.createShader(e);if(!r)throw new Error("Could not create WebGL shader");if(i.shaderSource(r,t),i.compileShader(r),!i.getShaderParameter(r,i.COMPILE_STATUS)){const o=i.getShaderInfoLog(r);console.error("Shader compilation error:",o)}return r};class _e{constructor(e,t,r){l(this,"model");l(this,"textureManager");l(this,"gl");l(this,"programs",{});l(this,"program",null);this.model=e,this.textureManager=t,this.gl=r,this.programs={},this.program=null}getProgram(){const e=`#define LENSING ${this.model.lensing.getValue()?1:0}
        #define DOPPLER ${this.model.doppler.getValue()?1:0}
        #define GRID ${this.model.grid.getValue()?1:0}
        #define STARS ${this.model.stars.getValue()?1:0}`;if(this.program=this.programs[e]||null,this.program||!this.textureManager.rayDeflectionTexture||!this.textureManager.rayInverseRadiusTexture)return this.program;const t=`#version 300 es
        precision highp float;
        #define IN(x) const in x
        #define OUT(x) out x
        ${e}
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
            float(${this.model.grid.getValue()?128:2048});
        const float MAX_FOOTPRINT_SIZE = float(4);
        const float MAX_FOOTPRINT_LOD =
            float(${this.model.grid.getValue()?0:he});
`,r=this.gl,n=document.querySelector("#vertex_shader"),o=document.querySelector("#black_hole_shader"),a=document.querySelector("#fragment_shader");if(!n||!o||!a)throw new Error("One or more required shaders are missing from the DOM");const c=z(r,r.VERTEX_SHADER,`#version 300 es
        precision highp float;
        ${n.innerHTML}`),u=z(r,r.FRAGMENT_SHADER,`${t}
        ${me()} 
        ${o.innerHTML}
        ${a.innerHTML}`),s=r.createProgram();if(!s)throw new Error("Could not create WebGL program");if(r.attachShader(s,c),r.attachShader(s,u),r.linkProgram(s),!r.getProgramParameter(s,r.LINK_STATUS)){const m=r.getProgramInfoLog(s);console.error("Program link error:",m)}return s.vertexAttrib=r.getAttribLocation(s,"vertex"),s.cameraSize=r.getUniformLocation(s,"camera_size"),s.cameraPosition=r.getUniformLocation(s,"camera_position"),s.p=r.getUniformLocation(s,"p"),s.kS=r.getUniformLocation(s,"k_s"),s.eTau=r.getUniformLocation(s,"e_tau"),s.eW=r.getUniformLocation(s,"e_w"),s.eH=r.getUniformLocation(s,"e_h"),s.eD=r.getUniformLocation(s,"e_d"),s.rayDeflectionTexture=r.getUniformLocation(s,"ray_deflection_texture"),s.rayInverseRadiusTexture=r.getUniformLocation(s,"ray_inverse_radius_texture"),s.galaxyCubeTexture=r.getUniformLocation(s,"galaxy_cube_texture"),s.starCubeTexture=r.getUniformLocation(s,"star_cube_texture"),s.starCubeTexture2=r.getUniformLocation(s,"star_cube_texture2"),s.starsOrientation=r.getUniformLocation(s,"stars_orientation"),s.minStarsLod=r.getUniformLocation(s,"min_stars_lod"),s.blackBodyTexture=r.getUniformLocation(s,"black_body_texture"),s.dopplerTexture=r.getUniformLocation(s,"doppler_texture"),s.noiseTexture=r.getUniformLocation(s,"noise_texture"),s.discParams=r.getUniformLocation(s,"disc_params"),this.programs[e]=s,this.program=s,s}}const I=.1,F=100,G=7,g=1<<G-1,D=.514,L=-20,C=-2.1,w=function(i,e,t){const r=i.createShader(e);if(!r)throw new Error("Could not create WebGL shader");return i.shaderSource(r,t),i.compileShader(r),r},fe=function(i,e){const t=new XMLHttpRequest;t.open("GET","/black-hole/"+i),t.responseType="arraybuffer",t.onload=()=>{const r=new DataView(t.response),n=r.getUint32(0,!0),o=r.getUint32(Uint32Array.BYTES_PER_ELEMENT,!0);let a=2*Uint32Array.BYTES_PER_ELEMENT;const c=new Float32Array(n);for(let s=0;s<n;++s)c[s]=r.getFloat32(s*Float32Array.BYTES_PER_ELEMENT+a,!0);a+=n*Float32Array.BYTES_PER_ELEMENT;const u=new Uint32Array(o);for(let s=0;s<o;++s)u[s]=r.getUint32(s*Uint32Array.BYTES_PER_ELEMENT+a,!0);e(c,u)},t.send()},k=function(i,e){const t=i.getExtension("EXT_texture_filter_anisotropic"),r=i.createTexture();if(!r)throw new Error("Could not create WebGL texture");i.activeTexture(i.TEXTURE0),i.bindTexture(i.TEXTURE_2D,r),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_S,i.REPEAT),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_WRAP_T,i.CLAMP_TO_EDGE),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MIN_FILTER,i.LINEAR_MIPMAP_LINEAR),i.texParameteri(i.TEXTURE_2D,i.TEXTURE_MAG_FILTER,i.LINEAR),t&&i.texParameterf(i.TEXTURE_2D,t.TEXTURE_MAX_ANISOTROPY_EXT,i.getParameter(t.MAX_TEXTURE_MAX_ANISOTROPY_EXT));const n=new Image;return n.addEventListener("load",function(){i.bindTexture(i.TEXTURE_2D,r),i.texImage2D(i.TEXTURE_2D,0,i.RGB,i.RGB,i.UNSIGNED_BYTE,n),i.generateMipmap(i.TEXTURE_2D)}),n.src="/black-hole/"+e,r};class pe{constructor(e,t){l(this,"model");l(this,"gl");l(this,"rocketProgram");l(this,"exhaustProgram");l(this,"envMapTexture");l(this,"envMapFbo");l(this,"rocketVertexBuffer",null);l(this,"rocketIndexBuffer",null);l(this,"exhaustVertexBuffer",null);l(this,"exhaustIndexBuffer",null);l(this,"baseColorTexture");l(this,"occlusionRoughnessMetallicTexture");l(this,"normalMapTexture");this.model=e,this.gl=t,this.baseColorTexture=k(t,"rocket_base_color.png"),this.occlusionRoughnessMetallicTexture=k(t,"rocket_occlusion_roughness_metallic.png"),this.normalMapTexture=k(t,"rocket_normal.png"),this.createRocketProgram(t),this.createExhaustProgram(t),this.createEnvMap(t),fe("rocket.dat",(r,n)=>this.createRocketBuffers(r,n)),this.createExhaustBuffers(t)}createEnvMap(e){const t=e.createTexture();if(!t)throw new Error("Could not create WebGL environment cube map");this.envMapTexture=t,e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_CUBE_MAP,this.envMapTexture),e.texStorage2D(e.TEXTURE_CUBE_MAP,G,e.RGBA16F,g,g),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MIN_FILTER,e.LINEAR_MIPMAP_LINEAR),e.texParameteri(e.TEXTURE_CUBE_MAP,e.TEXTURE_MAG_FILTER,e.LINEAR);const r=e.getExtension("EXT_texture_filter_anisotropic");r&&e.texParameterf(e.TEXTURE_CUBE_MAP,r.TEXTURE_MAX_ANISOTROPY_EXT,e.getParameter(r.MAX_TEXTURE_MAX_ANISOTROPY_EXT));const n=e.createFramebuffer();if(!n)throw new Error("Could not create WebGL framebuffer");this.envMapFbo=n,e.bindFramebuffer(e.FRAMEBUFFER,this.envMapFbo),e.framebufferTexture2D(e.FRAMEBUFFER,e.COLOR_ATTACHMENT0,e.TEXTURE_CUBE_MAP_POSITIVE_X,this.envMapTexture,0),e.bindFramebuffer(e.FRAMEBUFFER,null)}createRocketProgram(e){const t=document.querySelector("#rocket_vertex_shader"),r=document.querySelector("#rocket_fragment_shader");if(!t||!r)throw new Error("Missing rocket shader script elements");const n=w(e,e.VERTEX_SHADER,`#version 300 es
        precision highp float;
        ${t.innerHTML}`),o=w(e,e.FRAGMENT_SHADER,`#version 300 es
        precision highp float;
        const float ENV_MAP_SIZE = float(${g});
        ${r.innerHTML}`),a=e.createProgram();if(!a)throw new Error("Could not create WebGL program");e.attachShader(a,n),e.attachShader(a,o),e.linkProgram(a),a.positionAttrib=e.getAttribLocation(a,"position_attribute"),a.normalAttrib=e.getAttribLocation(a,"normal_attribute"),a.tangentAttrib=e.getAttribLocation(a,"tangent_attribute"),a.uvAttrib=e.getAttribLocation(a,"uv_attribute"),a.ambientOcclusionAttrib=e.getAttribLocation(a,"ambient_occlusion_attribute"),a.modelViewProjMatrix=e.getUniformLocation(a,"model_view_proj_matrix"),a.camera=e.getUniformLocation(a,"camera"),a.baseColorTexture=e.getUniformLocation(a,"base_color_texture"),a.occlusionRoughnessMetallicTexture=e.getUniformLocation(a,"occlusion_roughness_metallic_texture"),a.normalMapTexture=e.getUniformLocation(a,"normal_map_texture"),a.envMapTexture=e.getUniformLocation(a,"env_map_texture"),this.rocketProgram=a}createExhaustProgram(e){const t=document.querySelector("#exhaust_vertex_shader"),r=document.querySelector("#exhaust_fragment_shader");if(!t||!r)throw new Error("Missing exhaust shader script elements");const n=w(e,e.VERTEX_SHADER,`#version 300 es
        precision highp float;
        ${t.innerHTML}`),o=w(e,e.FRAGMENT_SHADER,`#version 300 es
        precision highp float;
        const float RADIUS = float(${D});
        const float Z_MIN = float(${L});
        const float Z_MAX = float(${C});
        ${r.innerHTML}`),a=e.createProgram();if(!a)throw new Error("Could not create WebGL program");e.attachShader(a,n),e.attachShader(a,o),e.linkProgram(a),a.positionAttrib=e.getAttribLocation(a,"position_attribute"),a.modelViewProjMatrix=e.getUniformLocation(a,"model_view_proj_matrix"),a.camera=e.getUniformLocation(a,"camera"),a.intensity=e.getUniformLocation(a,"intensity"),a.kZ=e.getUniformLocation(a,"k_z"),a.kR=e.getUniformLocation(a,"k_r"),this.exhaustProgram=a}createRocketBuffers(e,t){const r=this.gl;if(this.rocketVertexBuffer=r.createBuffer(),r.bindBuffer(r.ARRAY_BUFFER,this.rocketVertexBuffer),r.bufferData(r.ARRAY_BUFFER,e,r.STATIC_DRAW),this.rocketIndexBuffer=r.createBuffer(),!this.rocketIndexBuffer)throw new Error("Could not create index buffer");this.rocketIndexBuffer.size=t.length,r.bindBuffer(r.ELEMENT_ARRAY_BUFFER,this.rocketIndexBuffer),r.bufferData(r.ELEMENT_ARRAY_BUFFER,t,r.STATIC_DRAW)}createExhaustBuffers(e){const r=new Float32Array(198);for(let o=0;o<=32;++o){const a=o==0?0:D,c=2*Math.PI*o/32;r[6*o]=a*Math.cos(c),r[6*o+1]=a*Math.sin(c),r[6*o+2]=L,r[6*o+3]=a*Math.cos(c),r[6*o+4]=a*Math.sin(c),r[6*o+5]=C}this.exhaustVertexBuffer=e.createBuffer(),e.bindBuffer(e.ARRAY_BUFFER,this.exhaustVertexBuffer),e.bufferData(e.ARRAY_BUFFER,r,e.STATIC_DRAW);const n=new Uint32Array(384);for(let o=1;o<=32;++o){const a=o%32+1;n[12*o-12]=0,n[12*o-11]=2*a,n[12*o-10]=2*o,n[12*o-9]=2*o,n[12*o-8]=2*a,n[12*o-7]=2*a+1,n[12*o-6]=2*a+1,n[12*o-5]=2*o+1,n[12*o-4]=2*o,n[12*o-3]=1,n[12*o-2]=2*o+1,n[12*o-1]=2*a+1}if(this.exhaustIndexBuffer=e.createBuffer(),!this.exhaustIndexBuffer)throw new Error("Could not create index buffer");this.exhaustIndexBuffer.size=n.length,e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,this.exhaustIndexBuffer),e.bufferData(e.ELEMENT_ARRAY_BUFFER,n,e.STATIC_DRAW)}renderEnvMap(e,t){const r=this.gl,n=this.model,o=r.getParameter(r.VIEWPORT),a=r.getParameter(r.FRAMEBUFFER_BINDING);r.bindFramebuffer(r.FRAMEBUFFER,this.envMapFbo),r.viewport(0,0,g,g),r.useProgram(e),r.uniform3f(e.cameraSize,g/2,g/2,g/2),r.uniform3f(e.eTau,n.rocketTau[1],n.rocketTau[2],n.rocketTau[3]),r.bindBuffer(r.ARRAY_BUFFER,t),r.vertexAttribPointer(e.vertexAttrib,2,r.FLOAT,!1,0,0),r.enableVertexAttribArray(e.vertexAttrib),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_CUBE_MAP_POSITIVE_X,this.envMapTexture,0),r.uniform3f(e.eW,-n.rocketD[1],-n.rocketD[2],-n.rocketD[3]),r.uniform3f(e.eH,-n.rocketH[1],-n.rocketH[2],-n.rocketH[3]),r.uniform3f(e.eD,-n.rocketW[1],-n.rocketW[2],-n.rocketW[3]),r.drawArrays(r.TRIANGLE_STRIP,0,4),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_CUBE_MAP_NEGATIVE_X,this.envMapTexture,0),r.uniform3f(e.eW,n.rocketD[1],n.rocketD[2],n.rocketD[3]),r.uniform3f(e.eH,-n.rocketH[1],-n.rocketH[2],-n.rocketH[3]),r.uniform3f(e.eD,n.rocketW[1],n.rocketW[2],n.rocketW[3]),r.drawArrays(r.TRIANGLE_STRIP,0,4),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_CUBE_MAP_POSITIVE_Y,this.envMapTexture,0),r.uniform3f(e.eW,n.rocketW[1],n.rocketW[2],n.rocketW[3]),r.uniform3f(e.eH,n.rocketD[1],n.rocketD[2],n.rocketD[3]),r.uniform3f(e.eD,-n.rocketH[1],-n.rocketH[2],-n.rocketH[3]),r.drawArrays(r.TRIANGLE_STRIP,0,4),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_CUBE_MAP_NEGATIVE_Y,this.envMapTexture,0),r.uniform3f(e.eW,n.rocketW[1],n.rocketW[2],n.rocketW[3]),r.uniform3f(e.eH,-n.rocketD[1],-n.rocketD[2],-n.rocketD[3]),r.uniform3f(e.eD,n.rocketH[1],n.rocketH[2],n.rocketH[3]),r.drawArrays(r.TRIANGLE_STRIP,0,4),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_CUBE_MAP_POSITIVE_Z,this.envMapTexture,0),r.uniform3f(e.eW,n.rocketW[1],n.rocketW[2],n.rocketW[3]),r.uniform3f(e.eH,-n.rocketH[1],-n.rocketH[2],-n.rocketH[3]),r.uniform3f(e.eD,-n.rocketD[1],-n.rocketD[2],-n.rocketD[3]),r.drawArrays(r.TRIANGLE_STRIP,0,4),r.framebufferTexture2D(r.FRAMEBUFFER,r.COLOR_ATTACHMENT0,r.TEXTURE_CUBE_MAP_NEGATIVE_Z,this.envMapTexture,0),r.uniform3f(e.eW,-n.rocketW[1],-n.rocketW[2],-n.rocketW[3]),r.uniform3f(e.eH,-n.rocketH[1],-n.rocketH[2],-n.rocketH[3]),r.uniform3f(e.eD,n.rocketD[1],n.rocketD[2],n.rocketD[3]),r.drawArrays(r.TRIANGLE_STRIP,0,4),r.disableVertexAttribArray(e.vertexAttrib),r.bindFramebuffer(r.FRAMEBUFFER,a),r.viewport(o[0],o[1],o[2],o[3])}drawRocket(){var n;if(!this.rocketVertexBuffer||!((n=this.rocketIndexBuffer)!=null&&n.size))return;const e=this.gl;e.clear(e.DEPTH_BUFFER_BIT),e.enable(e.DEPTH_TEST),e.enable(e.CULL_FACE),e.activeTexture(e.TEXTURE0),e.bindTexture(e.TEXTURE_2D,this.baseColorTexture),e.activeTexture(e.TEXTURE1),e.bindTexture(e.TEXTURE_2D,this.occlusionRoughnessMetallicTexture),e.activeTexture(e.TEXTURE2),e.bindTexture(e.TEXTURE_2D,this.normalMapTexture),e.activeTexture(e.TEXTURE3),e.bindTexture(e.TEXTURE_CUBE_MAP,this.envMapTexture),e.generateMipmap(e.TEXTURE_CUBE_MAP);const t=this.rocketProgram;e.useProgram(t),t.baseColorTexture&&e.uniform1i(t.baseColorTexture,0),t.occlusionRoughnessMetallicTexture&&e.uniform1i(t.occlusionRoughnessMetallicTexture,1),t.normalMapTexture&&e.uniform1i(t.normalMapTexture,2),t.envMapTexture&&e.uniform1i(t.envMapTexture,3),this.setCameraUniforms(t),e.bindBuffer(e.ARRAY_BUFFER,this.rocketVertexBuffer),e.bindBuffer(e.ELEMENT_ARRAY_BUFFER,this.rocketIndexBuffer);const r=52;t.positionAttrib!==void 0&&t.positionAttrib>=0&&(e.vertexAttribPointer(t.positionAttrib,3,e.FLOAT,!1,r,0),e.enableVertexAttribArray(t.positionAttrib)),t.normalAttrib!==void 0&&t.normalAttrib>=0&&(e.vertexAttribPointer(t.normalAttrib,3,e.FLOAT,!1,r,12),e.enableVertexAttribArray(t.normalAttrib)),t.tangentAttrib!==void 0&&t.tangentAttrib>=0&&(e.vertexAttribPointer(t.tangentAttrib,4,e.FLOAT,!1,r,24),e.enableVertexAttribArray(t.tangentAttrib)),t.uvAttrib!==void 0&&t.uvAttrib>=0&&(e.vertexAttribPointer(t.uvAttrib,2,e.FLOAT,!1,r,40),e.enableVertexAttribArray(t.uvAttrib)),t.ambientOcclusionAttrib!==void 0&&t.ambientOcclusionAttrib>=0&&(e.vertexAttribPointer(t.ambientOcclusionAttrib,1,e.FLOAT,!1,r,48),e.enableVertexAttribArray(t.ambientOcclusionAttrib)),e.drawElements(e.TRIANGLES,this.rocketIndexBuffer.size,e.UNSIGNED_INT,0),t.positionAttrib!==void 0&&t.positionAttrib>=0&&e.disableVertexAttribArray(t.positionAttrib),t.normalAttrib!==void 0&&t.normalAttrib>=0&&e.disableVertexAttribArray(t.normalAttrib),t.tangentAttrib!==void 0&&t.tangentAttrib>=0&&e.disableVertexAttribArray(t.tangentAttrib),t.uvAttrib!==void 0&&t.uvAttrib>=0&&e.disableVertexAttribArray(t.uvAttrib),t.ambientOcclusionAttrib!==void 0&&t.ambientOcclusionAttrib>=0&&e.disableVertexAttribArray(t.ambientOcclusionAttrib),e.disable(e.DEPTH_TEST),e.disable(e.CULL_FACE)}drawExhaust(e,t){var f;if(!this.rocketVertexBuffer||!((f=this.exhaustIndexBuffer)!=null&&f.size))return;const r=this.gl;r.enable(r.DEPTH_TEST),r.enable(r.BLEND),r.blendEquation(r.FUNC_ADD),r.blendFunc(r.ONE,r.ONE),r.enable(r.CULL_FACE);const n=this.exhaustProgram;r.useProgram(n);const o=.1*Math.pow(t,.75);n.intensity&&r.uniform3f(n.intensity,46/255*o,176/255*o,o),e*=100;const a=6.75+.5*Math.cos(e),c=5.75+.5*Math.cos((e+1)/Math.sqrt(2)),u=4.75+.5*Math.cos((e+2)/Math.sqrt(3)),s=D*D;n.kR&&r.uniform3f(n.kR,a/s,c/s,u/s);const d=27+2*Math.cos((e+1)/Math.sqrt(2)),m=23+2*Math.cos((e+2)/Math.sqrt(3)),h=19+2*Math.cos(e),_=C-L;n.kZ&&r.uniform3f(n.kZ,d/_,m/_,h/_),this.setCameraUniforms(n),r.bindBuffer(r.ARRAY_BUFFER,this.exhaustVertexBuffer),r.bindBuffer(r.ELEMENT_ARRAY_BUFFER,this.exhaustIndexBuffer),n.positionAttrib!==void 0&&n.positionAttrib>=0&&(r.vertexAttribPointer(n.positionAttrib,3,r.FLOAT,!1,0,0),r.enableVertexAttribArray(n.positionAttrib)),r.cullFace(r.BACK),r.drawElements(r.TRIANGLES,this.exhaustIndexBuffer.size,r.UNSIGNED_INT,0),r.cullFace(r.FRONT),r.drawElements(r.TRIANGLES,this.exhaustIndexBuffer.size,r.UNSIGNED_INT,0),n.positionAttrib!==void 0&&n.positionAttrib>=0&&r.disableVertexAttribArray(n.positionAttrib),r.disable(r.DEPTH_TEST),r.disable(r.BLEND),r.disable(r.CULL_FACE),r.cullFace(r.BACK)}setCameraUniforms(e){const t=this.model.cameraYaw.getValue()+this.model.cameraYawOffset-this.model.rocketYaw,r=this.model.rocketDistance.getValue()/2,n=.4*r,o=-n*Math.sin(this.model.rocketYaw),a=n*Math.cos(this.model.rocketYaw),c=Math.cos(t),u=Math.sin(t),s=Math.cos(this.model.cameraPitch.getValue()),d=Math.sin(this.model.cameraPitch.getValue()),m=[[c,0,-u,c*o-u*a],[-u*d,s,-c*d,-u*d*o-c*d*a],[u*s,d,c*s,-r+u*s*o+c*s*a],[0,0,0,1]],h=1/Math.tan(this.model.fovY/2),_=document.body.clientWidth/document.body.clientHeight,f=-100.1/(F-I),p=-2*F*I/(F-I),T=[[h/_,0,0,0],[0,h,0,0],[0,0,f,p],[0,0,-1,0]],R=[0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0];for(let v=0;v<4;++v)for(let x=0;x<4;++x)for(let U=0;U<4;++U)R[v+4*x]+=T[v][U]*m[U][x];e.modelViewProjMatrix&&this.gl.uniformMatrix4fv(e.modelViewProjMatrix,!1,R);const A=[0,0,0,1];for(let v=0;v<3;++v)for(let x=0;x<3;++x)A[v]-=m[x][v]*m[x][3];e.camera&&this.gl.uniform3f(e.camera,A[0],A[1],A[2])}}const Te=function(i){const e=i.createBuffer();if(!e)throw new Error("Could not create quad vertex buffer");return i.bindBuffer(i.ARRAY_BUFFER,e),i.bufferData(i.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),i.STATIC_DRAW),e};class ve{constructor(e,t){l(this,"model");l(this,"rootElement");l(this,"devicePixelRatio");l(this,"canvas");l(this,"errorPanel");l(this,"errorPanelShown");l(this,"gl");l(this,"vertexBuffer");l(this,"textureManager");l(this,"shaderManager");l(this,"rocketManager");l(this,"bloom");l(this,"lastTauSeconds");l(this,"lastFrameTime");l(this,"numFrames",0);l(this,"drag",!1);l(this,"previousMouseX");l(this,"previousMouseY");l(this,"hidden",!1);this.model=e,this.rootElement=t,this.devicePixelRatio=this.getDevicePixelRatio();const r=t.querySelector("#camera_view"),n=t.querySelector("#cv_error_panel");if(!r)throw new Error("camera_view canvas not found");if(!n)throw new Error("cv_error_panel not found");this.canvas=r,this.canvas.style.width=`${t.clientWidth}px`,this.canvas.style.height=`${t.clientHeight}px`,this.canvas.width=t.clientWidth*this.devicePixelRatio,this.canvas.height=t.clientHeight*this.devicePixelRatio,this.errorPanel=n,this.errorPanelShown=!1;const o=this.canvas.getContext("webgl2");if(!o)throw new Error("Could not get WebGL2 context");if(this.gl=o,!this.initGl())throw new Error("Failed to initialize WebGL2 extensions");this.vertexBuffer=Te(this.gl),this.textureManager=new de(t,this.gl),this.shaderManager=new _e(e,this.textureManager,this.gl),this.rocketManager=new pe(e,this.gl),this.bloom=new ce(this.gl,this.canvas.width,this.canvas.height),this.lastTauSeconds=Date.now()/1e3,this.lastFrameTime=void 0,this.numFrames=0,this.drag=!1,this.previousMouseX=void 0,this.previousMouseY=void 0,this.hidden=!1,window.addEventListener("mousedown",a=>this.onMouseDown(a)),window.addEventListener("mousemove",a=>this.onMouseMove(a)),window.addEventListener("mouseup",()=>this.onMouseUp()),window.addEventListener("resize",()=>this.onResize()),document.addEventListener("visibilitychange",()=>{this.hidden=document.hidden,this.hidden||(this.lastFrameTime=void 0)}),requestAnimationFrame(()=>this.onRender())}initGl(){return!this.gl||!this.gl.getExtension("OES_texture_float_linear")||!this.gl.getExtension("EXT_texture_filter_anisotropic")||!this.gl.getExtension("EXT_color_buffer_float")||!this.gl.getExtension("EXT_float_blend")?(this.errorPanel.innerHTML="Unfortunately your browser doesn't support WebGL 2 or the WebGL 2 extensions required for this demo.",this.errorPanel.classList.toggle("cv-hidden",!1),!1):(this.errorPanel.addEventListener("click",()=>{this.errorPanel.classList.toggle("cv-hidden",!0)}),!0)}onRender(){if(this.hidden)return;const e=this.shaderManager.getProgram();if(!e){requestAnimationFrame(()=>this.onRender());return}this.devicePixelRatio!=this.getDevicePixelRatio()&&this.onResize();const t=Date.now()/1e3,r=t-this.lastTauSeconds;this.lastTauSeconds=t;const n=Math.tan(this.model.fovY/2),o=this.canvas.height/(2*n),a=this.gl,c=this.textureManager.rayDeflectionTexture,u=this.textureManager.rayInverseRadiusTexture,s=this.textureManager.galaxyTexture,d=this.textureManager.gridTexture,m=this.textureManager.starTexture,h=this.textureManager.starTexture2,_=this.textureManager.blackbodyTexture,f=this.textureManager.dopplerTexture,p=this.textureManager.noiseTexture;if(!c||!u||!m||!h||!_||!f||!p){requestAnimationFrame(()=>this.onRender());return}a.activeTexture(a.TEXTURE0),a.bindTexture(a.TEXTURE_2D,c),a.activeTexture(a.TEXTURE1),a.bindTexture(a.TEXTURE_2D,u),a.activeTexture(a.TEXTURE2),this.model.grid.getValue()?d&&a.bindTexture(a.TEXTURE_CUBE_MAP,d):s&&a.bindTexture(a.TEXTURE_CUBE_MAP,s);const T=this.model.grid.getValue()?0:this.textureManager.getMinLoadedStarTextureLod();a.texParameteri(a.TEXTURE_CUBE_MAP,a.TEXTURE_MIN_LOD,T),a.activeTexture(a.TEXTURE3),a.bindTexture(a.TEXTURE_CUBE_MAP,m),a.activeTexture(a.TEXTURE4),a.bindTexture(a.TEXTURE_CUBE_MAP,h),a.activeTexture(a.TEXTURE5),a.bindTexture(a.TEXTURE_2D,_),a.activeTexture(a.TEXTURE6),a.bindTexture(a.TEXTURE_3D,f),a.activeTexture(a.TEXTURE7),a.bindTexture(a.TEXTURE_2D,p),a.useProgram(e),e.cameraSize&&a.uniform3f(e.cameraSize,this.canvas.width/2,this.canvas.height/2,o),e.cameraPosition&&a.uniform4f(e.cameraPosition,this.model.t,this.model.r,this.model.worldTheta,this.model.worldPhi),e.p&&a.uniform3f(e.p,this.model.p[0],this.model.p[1],this.model.p[2]),e.kS&&a.uniform4f(e.kS,this.model.kS[0],this.model.kS[1],this.model.kS[2],this.model.kS[3]),e.eTau&&a.uniform3f(e.eTau,this.model.eTau[1],this.model.eTau[2],this.model.eTau[3]),e.eW&&a.uniform3f(e.eW,this.model.eW[1],this.model.eW[2],this.model.eW[3]),e.eH&&a.uniform3f(e.eH,this.model.eH[1],this.model.eH[2],this.model.eH[3]),e.eD&&a.uniform3f(e.eD,this.model.eD[1],this.model.eD[2],this.model.eD[3]),e.rayDeflectionTexture&&a.uniform1i(e.rayDeflectionTexture,0),e.rayInverseRadiusTexture&&a.uniform1i(e.rayInverseRadiusTexture,1),e.galaxyCubeTexture&&a.uniform1i(e.galaxyCubeTexture,2),e.starCubeTexture&&a.uniform1i(e.starCubeTexture,3),e.starCubeTexture2&&a.uniform1i(e.starCubeTexture2,4),e.starsOrientation&&a.uniformMatrix3fv(e.starsOrientation,!1,this.model.starsMatrix),e.minStarsLod&&a.uniform1f(e.minStarsLod,T),e.blackBodyTexture&&a.uniform1i(e.blackBodyTexture,5),e.dopplerTexture&&a.uniform1i(e.dopplerTexture,6),e.noiseTexture&&a.uniform1i(e.noiseTexture,7),e.discParams&&a.uniform3f(e.discParams,this.model.discDensity.getValue(),this.model.discOpacity.getValue(),this.model.discTemperature.getValue()),this.bloom.begin(),a.bindBuffer(a.ARRAY_BUFFER,this.vertexBuffer),e.vertexAttrib!==void 0&&e.vertexAttrib>=0&&(a.vertexAttribPointer(e.vertexAttrib,2,a.FLOAT,!1,0,0),a.enableVertexAttribArray(e.vertexAttrib)),a.drawArrays(a.TRIANGLE_STRIP,0,4),e.vertexAttrib!==void 0&&e.vertexAttrib>=0&&a.disableVertexAttribArray(e.vertexAttrib),this.model.rocket.getValue()&&(this.rocketManager.renderEnvMap(e,this.vertexBuffer),this.rocketManager.drawRocket(),this.model.gForce>0&&this.rocketManager.drawExhaust(t,this.model.gForce)),this.bloom.end(this.model.bloom.getValue(),this.model.exposure.getValue(),this.model.highContrast.getValue()),this.model.updateOrbit(r),requestAnimationFrame(()=>this.onRender()),this.checkFrameRate()}checkFrameRate(){this.numFrames+=1;const e=Date.now();this.lastFrameTime||(this.lastFrameTime=e,this.numFrames=0),e>this.lastFrameTime+1e3&&(this.numFrames<=10&&this.model.stars.getValue()&&!this.errorPanelShown&&(this.model.stars.setValue(!1),this.errorPanel.innerHTML="Stars have been automatically disabled to improve performance. You can re-enable them from the left hand side panel.",this.errorPanel.classList.toggle("cv-hidden",!1),this.errorPanel.classList.toggle("cv-warning",!0),this.errorPanelShown=!0),this.lastFrameTime=e,this.numFrames=0)}onMouseDown(e){this.previousMouseX=e.screenX,this.previousMouseY=e.screenY;const t=e.target;this.drag=t.tagName!="INPUT"&&!e.ctrlKey}onMouseMove(e){const t=e.screenX,r=e.screenY;if(this.drag){let o=this.model.cameraYaw.getValue(),a=this.model.cameraPitch.getValue();const c=this.previousMouseX??t,u=this.previousMouseY??r;o+=(c-t)/500,a-=(u-r)/500,this.model.cameraYaw.setValue(o-2*Math.PI*Math.floor(o/(2*Math.PI))),this.model.cameraPitch.setValue(a)}this.previousMouseX=t,this.previousMouseY=r}onMouseUp(){this.drag=!1}onResize(){const e=this.rootElement;this.devicePixelRatio=this.getDevicePixelRatio(),this.canvas.style.width=`${e.clientWidth}px`,this.canvas.style.height=`${e.clientHeight}px`,this.canvas.width=e.clientWidth*this.devicePixelRatio,this.canvas.height=e.clientHeight*this.devicePixelRatio,this.bloom.resize(this.canvas.width,this.canvas.height)}getDevicePixelRatio(){return this.model.highDefinition.getValue()?window.devicePixelRatio:1}}function y(i,e,t){let r=document.getElementById(i);r||(r=document.createElement("script"),r.id=i,r.setAttribute("type",e),document.body.appendChild(r)),r.textContent=t}y("exhaust_vertex_shader","x-shader/x-vertex",$);y("exhaust_fragment_shader","x-shader/x-fragment",Q);y("rocket_vertex_shader","x-shader/x-vertex",K);y("rocket_fragment_shader","x-shader/x-fragment",J);y("vertex_shader","x-shader/x-vertex",ee);y("fragment_shader","x-shader/x-fragment",te);y("black_hole_shader","x-shader/x-fragment",re);window.addEventListener("DOMContentLoaded",()=>{const i=new W;new j(i);const e=document.body.querySelector("#settings_panel");e&&new Y(e,i);const t=document.body.querySelector("#orbit_panel");t&&new Z(t,i),window.addEventListener("error",r=>{const n=document.querySelector("#cv_error_panel");n&&(n.innerHTML="JS Error: "+r.message,n.classList.toggle("cv-hidden",!1))}),window.addEventListener("unhandledrejection",r=>{const n=document.querySelector("#cv_error_panel");n&&(n.innerHTML="Promise Error: "+r.reason,n.classList.toggle("cv-hidden",!1))}),new ve(i,document.body)});
