/**
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
 *   `model_view_proj_matrix` which defines the camera's perspective and translation.
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
