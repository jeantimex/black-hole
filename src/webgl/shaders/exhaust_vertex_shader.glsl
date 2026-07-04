/**
 * @file exhaust_vertex_shader.glsl
 * @brief Vertex shader for the rocket's volume-rendered engine exhaust.
 *
 * Architecture & Mathematics:
 * - This shader processes the vertices defining the outer shell (cylindrical bounds) of the rocket exhaust.
 * - It projects the vertices into clip space using the model-view-projection matrix for rasterization.
 * - Crucially, it passes the raw local object-space `position` attribute to the fragment shader.
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
