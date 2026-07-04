/**
 * @file vertex_shader.glsl
 * @brief Screen-aligned quad vertex shader with view-ray direction computation.
 *
 * Architecture & Physics:
 * - This shader takes a full-screen viewport quad (NDC coordinates covering [-1, 1] on x and y axes).
 * - It projects each screen vertex into the camera's local coordinate system.
 * - By interpolating these camera-space coordinates across the fragment shader, each fragment
 *   receives an accurate view direction vector `view_dir`.
 * - This `view_dir` represents the initial wavevector or momentum direction of light rays traced
 *   backwards (from the camera/observer to the light source/universe) in the relativistic raytracer.
 *
 * Mathematical derivation:
 * - Let a vertex have coordinates (x, y) in the normalized device coordinate range [-1, 1]^2.
 * - The uniform `camera_size` contains:
 *     - camera_size.x: Half-width of the viewport (w / 2).
 *     - camera_size.y: Half-height of the viewport (h / 2).
 *     - camera_size.z: Camera focal length (f) related to Field of View (FOV) by:
 *                      f = (h / 2) / tan(FOV_y / 2).
 * - The view direction vector `view_dir` in camera-space is:
 *     \vec{v}_{cam} = (x * (w/2), y * (h/2), -f)
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
