import { Model } from '../../common/model';
import { TextureManager } from './texture_manager';

export class ShaderManager {
  private textureManager: TextureManager;
  private device: GPUDevice;
  private shaderModule: GPUShaderModule | null = null;

  constructor(_model: Model, textureManager: TextureManager, device: GPUDevice) {
    this.textureManager = textureManager;
    this.device = device;
    this.shaderModule = null;
  }

  getProgram(): GPUShaderModule | null {
    // If the lookup textures are not loaded yet, we wait.
    if (!this.textureManager.rayDeflectionTexture ||
        !this.textureManager.rayInverseRadiusTexture) {
      return null;
    }

    if (!this.shaderModule) {
      const shaderElement = document.querySelector('#black_hole_shader');
      if (!shaderElement) {
        console.error("ShaderManager: #black_hole_shader element not found in DOM!");
        return null;
      }
      const source = shaderElement.textContent || "";
      this.shaderModule = this.device.createShaderModule({
        label: 'BlackHoleShader',
        code: source
      });
      
      this.shaderModule.getCompilationInfo().then((info) => {
        if (info.messages.length > 0) {
          const errors = info.messages.filter(m => m.type === 'error');
          if (errors.length > 0) {
            console.error("ShaderManager WGSL compile error: " + errors[0].message);
            const errorPanel = document.querySelector('#cv_error_panel');
            if (errorPanel) {
              errorPanel.innerHTML = 'WGSL Compile Error: ' + errors[0].message + ' at line ' + errors[0].lineNum;
              errorPanel.classList.toggle('cv-hidden', false);
            }
          }
        }
      });
    }

    return this.shaderModule;
  }
}
