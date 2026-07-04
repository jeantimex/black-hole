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

// Import standard modules
import { Model } from '../common/model';
import { UrlParams } from '../common/url_params';
import { SettingsPanel } from '../common/settings_panel';
import { OrbitPanel } from '../common/orbit_panel';
import { CameraView } from './js/camera_view';

window.addEventListener('DOMContentLoaded', async () => {
  if (!navigator.gpu) {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'WebGPU is not supported in this browser. Please use a WebGPU-enabled browser (like Chrome or Edge).';
      errorPanel.classList.toggle('cv-hidden', false);
    }
    return;
  }

  const adapter = await navigator.gpu.requestAdapter();
  if (!adapter) {
    const errorPanel = document.querySelector('#cv_error_panel');
    if (errorPanel) {
      errorPanel.innerHTML = 'Failed to request WebGPU adapter.';
      errorPanel.classList.toggle('cv-hidden', false);
    }
    return;
  }

  const requiredFeatures: GPUFeatureName[] = [];
  if (adapter.features.has('float32-filterable')) {
    requiredFeatures.push('float32-filterable');
  }
  const device = await adapter.requestDevice({ requiredFeatures });

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

  new CameraView(model, document.body, device);
});
