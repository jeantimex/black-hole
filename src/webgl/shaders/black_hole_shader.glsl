/**
 * @file black_hole_shader.glsl
 * @brief Core raymarching and gravitational lensing library for Schwarzschild space-time rendering.
 *
 * Physics & General Relativity Background:
 * - We model a static, spherically symmetric black hole using the Schwarzschild metric.
 *   In natural units where G = c = M = 1, the event horizon (Schwarzschild radius) is r_s = 2.
 * - The line element in Schwarzschild coordinates (t, r, \theta, \phi) is:
 *     ds^2 = -(1 - 2/r) dt^2 + (1 - 2/r)^-1 dr^2 + r^2 (d\theta^2 + \sin^2\theta d\phi^2)
 * - Light paths are null geodesics (ds^2 = 0). Under the metric symmetries, energy E and
 *   angular momentum L are conserved along the ray.
 * - In terms of inverse radius u = 1/r and deflection angle \phi, the geodesic equation of motion is:
 *     (du/d\phi)^2 = e^2 - u^2(1 - u)
 *   where:
 *     - e^2 = E^2 / L^2 is the energy-like parameter related to the impact parameter b by e^2 = 1 / b^2.
 *     - V(u) = u^2(1 - u) acts as an effective radial potential barrier.
 *
 * The Photon Sphere & Critical Impact Parameter:
 * - The potential V(u) has a maximum at V'(u) = 2u - 3u^2 = 0 \implies u = 2/3 (or r = 3M = 1.5 in G=c=M=1).
 *   This is the photon sphere: the radius at which light can orbit the black hole in unstable circular orbits.
 * - The critical value of the potential is V(2/3) = (4/9)*(1/3) = 4/27 = \mu \approx 0.14815.
 * - Based on the impact parameter e^2:
 *     - e^2 < 4/27: The ray does not have enough energy to cross the photon sphere potential barrier.
 *                   If it comes from infinity (u \to 0), it reaches a turning point (periapsis) at some u_apsis < 2/3,
 *                   then deflects back to infinity.
 *     - e^2 > 4/27: The ray crosses the photon sphere and falls into the event horizon (u \to \infty).
 *
 * Lookup Table (LUT) Architecture:
 * - To achieve real-time frame rates, we do not integrate the differential geodesic equations numerically
 *   per pixel. Instead, we precompute the solutions and store them in two 2D textures:
 *   1. `ray_deflection_texture`: Maps (e^2, u) to the accumulated deflection angle \Delta\phi and coordinate time \Delta t.
 *   2. `ray_inverse_radius_texture`: Maps (e^2, \phi) to the inverse radius u and coordinate time t.
 * - This file contains helper functions to map physical parameters (e^2, u, \phi) to coordinate spaces [0, 1]
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
    // Map e^2 in (kMu, \infty) to (0.5, 1.0]
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
 * @brief Computes the asymptotic upper bound of the deflection angle \phi_ub.
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
 * @details Integrates a step pulse over a screen-pixel footprint of width `fw` to prevent aliasing.
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
 * @param u_dot Radial velocity parameter du/d\phi at observer.
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
 * @param doppler_factor Relativistic Doppler factor g = \nu_{receiver} / \nu_{source}.
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
 *            \mu = \Omega / \Omega'
 *          Since stars are point sources, we resolve their intensity and select a cubemap LOD using
 *          partial screen-space derivatives (dFdx, dFdy) to determine the ray footprint deformation.
 * @param dir Deflected view ray direction in world space.
 * @param lensing_amplification_factor The solid angle ratio \mu.
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
 *     T(r) \propto r^{-3/4} * (1 - \sqrt{3 / r})^{1/4}
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
    // Keplerian orbital frequency \omega = \sqrt{M / r^3}
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
  
  // Calculate temperature at current radius p_r: T(r) \propto ((1 - \sqrt{3/r}) / r^3)^0.25
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
 *     g = (l \cdot u_{receiver}) / (l \cdot u_{emitter})
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
