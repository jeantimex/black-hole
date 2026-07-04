/**
 * @file exhaust_fragment_shader.glsl
 * @brief Volumetric raymarching fragment shader for rendering the rocket's engine exhaust plume.
 *
 * Physics & Mathematics:
 * - The exhaust plume is modeled as a hot, emitting gas contained within a finite cylinder.
 * - The cylinder is centered along the local z-axis, with radius R (`RADIUS`) and extending from
 *   z = Z_MIN to z = Z_MAX.
 * - The emission density profile \rho at any local coordinate (x, y, z) is modeled using an exponential decay:
 *     \rho(r, z) = \exp(-k_r * r^2 - k_z * (Z_MAX - z))
 *   where:
 *     - r^2 = x^2 + y^2 is the squared radial distance from the cylinder's axis.
 *     - (Z_MAX - z) is the distance from the engine nozzle (which sits at Z_MAX).
 *     - k_r and k_z are extinction/density coefficients that can be varied per color channel
 *       (r, g, b) to simulate chromatic absorption/emission effects (e.g. cooler outer boundaries).
 *
 * Ray-Cylinder Intersection Derivation:
 * - A ray is parameterized in object space as:
 *     \vec{p}(t) = \vec{o} + t \vec{d}
 *   where:
 *     - \vec{o} is the camera position in object space (`camera`).
 *     - \vec{d} is the normalized direction vector from the camera to the current fragment (`dir`).
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
 *     t = (-b \pm \sqrt{D}) / a
 *
 * Volume Boundary Clipping:
 * - We find the cylinder shell intersection times t_min = (-b - \sqrt{D})/a and t_max = (-b + \sqrt{D})/a.
 * - Since we only render in front of the camera, we clamp t_min to >= 0.
 * - The ray path must also be clipped to the finite z-interval [Z_MIN, Z_MAX]:
 *     z(t) = o_z + t d_z
 *   - If d_z > 0:
 *       t_min = \max(t_min, (Z_MIN - o_z) / d_z)
 *       t_max = \min(t_max, (Z_MAX - o_z) / d_z)
 *   - If d_z < 0 (pointing backward along z):
 *       t_min = \max(t_min, (Z_MAX - o_z) / d_z)
 *       t_max = \min(t_max, (Z_MIN - o_z) / d_z)
 * - If t_min < t_max, the ray segment inside the finite cylinder is valid.
 *
 * Volumetric Integration (Riemann Sum):
 * - The integral of emitted light along the ray path within the volume is:
 *     I = \int_{t_{min}}^{t_{max}} \text{intensity} * \exp(-k_r * r(t)^2 - k_z * (Z_MAX - z(t))) dt
 * - We approximate this integral numerically by sampling at N = 16 discrete points.
 * - The step size is dt = (t_max - t_min) / N.
 * - For each step i \in [0, N-1], we sample at the midpoint:
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
