import './style.css';

// Import raw WGSL shader strings using Vite's '?raw' loader suffix.
import blackHoleShader from './shaders/black_hole_shader.wgsl?raw';
import rocketShader from './shaders/rocket_shader.wgsl?raw';
import exhaustShader from './shaders/exhaust_shader.wgsl?raw';

/**
 * Dynamically injects imported WGSL shader source code into DOM script blocks.
 * This is done to preserve compatibility with DOM-based shader loader scripts.
 */
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

// Inject WGSL shaders into the body.
injectShader('black_hole_shader', 'text/wgsl', blackHoleShader);
injectShader('rocket_shader', 'text/wgsl', rocketShader);
injectShader('exhaust_shader', 'text/wgsl', exhaustShader);

// Import standard modules.
import { Model } from '../common/model';
import { UrlParams } from '../common/url_params';
import { SettingsPanel } from '../common/settings_panel';
import { OrbitPanel } from '../common/orbit_panel';
import { CameraView } from './js/camera_view';

window.addEventListener('DOMContentLoaded', async () => {
  // 1. Verify browser support for WebGPU API.
  if (!navigator.gpu) {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'WebGPU is not supported in this browser. Please use a WebGPU-enabled browser (like Chrome or Edge).';
      errorPanel.classList.toggle('cv-hidden', false);
    }
    return;
  }

  // 2. Request physical GPU hardware adapter.
  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'Failed to request WebGPU adapter.';
      errorPanel.classList.toggle('cv-hidden', false);
    }
    return;
  }

  // 3. Query support for the optional 'float32-filterable' extension feature.
  // This extension allows GPU samplers to perform linear interpolation/filtering on 32-bit float textures.
  const requiredFeatures: GPUFeatureName[] = [];
  if (adapter.features.has('float32-filterable')) {
    requiredFeatures.push('float32-filterable');
  }
  // Request logical WebGPU device handle.
  const device = await adapter.requestDevice({ requiredFeatures });

  // 4. Instantiate model and sync state with URL query parameters.
  const model = new Model();
  new UrlParams(model);

  const searchParams = new URLSearchParams(window.location.search);
  const hideMenu = searchParams.has('hide_menu') && searchParams.get('hide_menu') !== 'false' && searchParams.get('hide_menu') !== '0';
  const hideOrbit = searchParams.has('hide_orbit') && searchParams.get('hide_orbit') !== 'false' && searchParams.get('hide_orbit') !== '0';

  // 5. Initialize side configurations control panel.
  const settingsPanelEl = document.body.querySelector('#settings_panel');
  if (settingsPanelEl) {
    new SettingsPanel(settingsPanelEl as HTMLElement, model, hideMenu);
  }

  // 6. Initialize relativistic orbit tracker panel.
  const orbitPanelEl = document.body.querySelector('#orbit_panel');
  if (orbitPanelEl) {
    new OrbitPanel(orbitPanelEl as HTMLElement, model, hideOrbit);
  }

  // 7. Establish global JS exception listeners to output faults to the UI error panel.
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

  // 8. Launch the WebGPU graphics context render loop.
  new CameraView(model, document.body, device);
});

