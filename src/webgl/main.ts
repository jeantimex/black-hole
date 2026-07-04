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

// Import standard modules
import { Model } from '../common/model';
import { UrlParams } from '../common/url_params';
import { SettingsPanel } from '../common/settings_panel';
import { OrbitPanel } from '../common/orbit_panel';
import { CameraView } from './js/camera_view';

window.addEventListener('DOMContentLoaded', () => {
  const model = new Model();
  new UrlParams(model);

  const settingsPanelEl = document.body.querySelector('#settings_panel');
  if (settingsPanelEl) {
    new SettingsPanel(settingsPanelEl as HTMLElement, model);
  }

  const orbitPanelEl = document.body.querySelector('#orbit_panel');
  if (orbitPanelEl) {
    new OrbitPanel(orbitPanelEl as HTMLElement, model);
  }

  window.addEventListener('error', (event) => {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'JS Error: ' + event.message;
      errorPanel.classList.toggle('cv-hidden', false);
    }
  });

  window.addEventListener('unhandledrejection', (event) => {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'Promise Error: ' + event.reason;
      errorPanel.classList.toggle('cv-hidden', false);
    }
  });

  new CameraView(model, document.body);
});
