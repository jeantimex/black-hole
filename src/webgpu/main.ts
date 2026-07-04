import './style.css';

// Import raw WGSL shaders
import blackHoleShader from './shaders/black_hole_shader.wgsl?raw';
import rocketShader from './shaders/rocket_shader.wgsl?raw';
import exhaustShader from './shaders/exhaust_shader.wgsl?raw';

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

// Inject WGSL shaders
injectShader('black_hole_shader', 'text/wgsl', blackHoleShader);
injectShader('rocket_shader', 'text/wgsl', rocketShader);
injectShader('exhaust_shader', 'text/wgsl', exhaustShader);

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
