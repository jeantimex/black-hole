/**
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
 * - f_diffuse = (1 - F) * (albedo / \pi)
 * - Under conservation of energy, the diffuse part represents light that penetrates the surface, scatters
 *   sub-surface, and re-emerges isotropically. The (1 - F) factor ensures that light reflected specularly is
 *   not also diffused.
 *
 * Specular Component (Microfacet Cook-Torrance):
 * - f_specular = D * F * G / (4 * (n \cdot l) * (n \cdot v))
 * - Let's define the terms:
 *   1. D: Microfacet Distribution Function (NDF). We use the Trowbridge-Reitz (GGX) distribution:
 *        D(h) = \alpha^2 / (\pi * ((n \cdot h)^2 * (\alpha^2 - 1) + 1)^2)
 *        where:
 *          - h = \text{normalize}(v + l) is the half-vector between light and view directions.
 *          - \alpha = \text{roughness}^2 is the linear roughness squared.
 *          - D(h) measures the fraction of microfacets aligned with the half-vector h.
 *
 *   2. F: Fresnel Reflection Coefficient. We use the Fresnel-Schlick approximation:
 *        F(h, v) = F_0 + (1 - F_0) * (1 - (h \cdot v))^5
 *        where:
 *          - F_0 is the specular reflectance at normal incidence.
 *          - For dielectrics, F_0 \approx 0.04.
 *          - For metals, F_0 is equal to the base color of the metal, and the diffuse albedo becomes zero (metallic absorption).
 *
 *   3. G: Geometric Attenuation Factor. Combined with the 1 / (4 * (n \cdot l) * (n \cdot v)) denominator, we express it
 *      via the Visiblity function V = G / (4 * (n \cdot l) * (n \cdot v)). We use the Height-Correlated Smith Joint model:
 *        V(l, v) = 0.5 / (a + b)
 *        where:
 *          a = (n \cdot l) * \sqrt{(n \cdot v)^2 * (1 - \alpha^2) + \alpha^2}
 *          b = (n \cdot v) * \sqrt{(n \cdot l)^2 * (1 - \alpha^2) + \alpha^2}
 *          \alpha^2 = \text{roughness}^4.
 *
 * Image-Based Lighting (IBL) & Split-Sum Approximation:
 * - We integrate incoming light from the environment map texture (`env_map_texture`) over the hemisphere:
 *     L_{out}(v) = \int f(l, v) * L_{in}(l) * (n \cdot l) dl
 * - This is solved in two ways based on roughness:
 *   1. Large Roughness (Specular & Diffuse Integration):
 *      - We use numerical integration over a spherical grid of size N_Z * N_PHI = 24 samples.
 *      - The environment map is sampled at a low-resolution Mipmap level (LOD) representing the solid angle
 *        of the sample cone: LOD = 0.5 * log2(\Omega_{sample} / \Omega_{texel}).
 *   2. Small Roughness (Importance Specular Sampling):
 *      - When roughness is small (\alpha^2 < 0.0625), uniform hemispherical sampling suffers from high variance (aliasing).
 *      - We use Quasi-Monte Carlo (QMC) Importance Sampling of the GGX NDF.
 *      - Points from the 1D Van der Corput low-discrepancy sequence (Hammersley sequence) are mapped to tangent-space
 *        half-vectors h distributed according to the GGX NDF:
 *          \cos\theta = \sqrt{ (1 - u_1) / (u_1 * (\alpha^2 - 1) + 1) }
 *          \phi = 2 * \pi * u_2
 *      - The reflection direction l = \text{reflect}(-v, h) is computed, and the environment map is sampled.
 *      - The probability density function (PDF) of GGX is:
 *          pdf = D * (n \cdot h) / (4 * (v \cdot h))
 *      - To prevent aliasing, the Mipmap level (LOD) is selected dynamically using the inverse PDF:
 *          LOD = -0.5 * log2(pdf * SAMPLE_COUNT * \Omega_{texel})
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
  float alpha_sq;      // Fourth power of roughness (\alpha^2 = roughness^4), used in GGX math.
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
