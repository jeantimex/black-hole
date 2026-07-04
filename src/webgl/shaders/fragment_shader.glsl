/**
 * @file fragment_shader.glsl
 * @brief Main entry point shader for rendering the black hole environment.
 *
 * Architecture & Physics:
 * - This shader coordinates the raymarching pipeline. It sets up the parameters, imports the
 *   Schwarzschild geodesic tracing logic from `black_hole_shader.glsl`, and resolves flat-space vs.
 *   curved-space calculations.
 * - It defines the Euclidean (flat-space) ray-disk intersection helper to be used when gravitational
 *   lensing is disabled.
 * - It handles texture cube-map sampling for background starfields and nebulae, applies the
 *   relativistic Doppler shifts, and generates the procedural/grid texture on the accretion disk.
 *
 * Euclidean Ray-Disk Intersection (Flat Space):
 * - A straight line ray in coordinates is: \vec{p}(t) = \vec{p}_{cam} + t \vec{d}_{ray}.
 * - The accretion disk lies in the plane z = 0.
 * - The intersection parameters with the disk plane are solved to check if they lie within the disk's
 *   inner and outer radii boundaries.
 */

// Camera position in Schwarzschild coordinate space: (t, r, \theta, \phi)
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
