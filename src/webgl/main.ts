import './style.css';

// Import raw GLSL shaders
import exhaustVertexShader from './shaders/exhaust_vertex_shader.glsl?raw';
import exhaustFragmentShader from './shaders/exhaust_fragment_shader.glsl?raw';
import rocketVertexShader from './shaders/rocket_vertex_shader.glsl?raw';
import rocketFragmentShader from './shaders/rocket_fragment_shader.glsl?raw';
import vertexShader from './shaders/vertex_shader.glsl?raw';
import fragmentShader from './shaders/fragment_shader.glsl?raw';
import blackHoleShader from './shaders/black_hole_shader.glsl?raw';

// Function to inject shaders dynamically into the DOM
function injectShader(id: string, type: string, source: string) {
  let element = document.getElementById(id);
  if (!element) {
    element = document.createElement('script');
    element.id = id;
    element.setAttribute('type', type);
    document.body.appendChild(element);
  }
  element.textContent = source;
}

// Inject all shaders before evaluating JS scripts
injectShader('exhaust_vertex_shader', 'x-shader/x-vertex', exhaustVertexShader);
injectShader('exhaust_fragment_shader', 'x-shader/x-fragment', exhaustFragmentShader);
injectShader('rocket_vertex_shader', 'x-shader/x-vertex', rocketVertexShader);
injectShader('rocket_fragment_shader', 'x-shader/x-fragment', rocketFragmentShader);
injectShader('vertex_shader', 'x-shader/x-vertex', vertexShader);
injectShader('fragment_shader', 'x-shader/x-fragment', fragmentShader);
injectShader('black_hole_shader', 'x-shader/x-fragment', blackHoleShader);

// Initialize namespace
(window as any).BlackHoleShaderDemoApp = (window as any).BlackHoleShaderDemoApp || {};

// Import JS scripts sequentially
import './js/model.js';
import './js/url_params.js';
import './js/bloom.js';
import './js/rocket_manager.js';
import './js/texture_manager.js';
import './js/shader_manager.js';
import './js/camera_view.js';
import './js/orbit_panel.js';
import './js/settings_panel.js';

// Trigger DOMContentLoaded manually if it already fired
if (document.readyState !== 'loading') {
  window.dispatchEvent(new Event('DOMContentLoaded'));
}
