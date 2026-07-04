import { Model } from '../../common/model';
import { TextureManager } from './texture_manager';

/**
 * ShaderManager handles the retrieval, compilation, and error reporting of the
 * main WebGPU WGSL shader module used for the black hole raymarching.
 */
export class ShaderManager {
  // Reference to the texture manager to ensure lookup tables are loaded before shader initialization.
  private textureManager: TextureManager;
  // The active WebGPU device context.
  private device: GPUDevice;
  // Cached GPUShaderModule to avoid compiling the source code on every frame/request.
  private shaderModule: GPUShaderModule | null = null;

  constructor(_model: Model, textureManager: TextureManager, device: GPUDevice) {
    this.textureManager = textureManager;
    this.device = device;
    this.shaderModule = null;
  }

  /**
   * Retrieves or compiles the GPUShaderModule for the black hole simulation.
   * Ensures that essential lookup textures are fully loaded beforehand.
   * 
   * @returns GPUShaderModule if successfully loaded/compiled, otherwise null.
   */
  getProgram(): GPUShaderModule | null {
    // Raymarching calculations rely on pre-computed deflection and inverse radius
    // textures. If they are not ready yet, we postpone shader creation.
    if (!this.textureManager.rayDeflectionTexture ||
        !this.textureManager.rayInverseRadiusTexture) {
      return null;
    }

    // Lazy initialization of the shader module.
    if (!this.shaderModule) {
      // Retrieve the raw WGSL source text from a script block in the DOM.
      const shaderElement = document.querySelector('#black_hole_shader');
      if (!shaderElement) {
        console.error("ShaderManager: #black_hole_shader element not found in DOM!");
        return null;
      }
      const source = shaderElement.textContent || "";
      
      // Compile the WGSL code into a WebGPU GPUShaderModule.
      this.shaderModule = this.device.createShaderModule({
        label: 'BlackHoleShader',
        code: source
      });
      
      // Asynchronously query WebGPU compilation info to check for errors/warnings.
      this.shaderModule.getCompilationInfo().then((info) => {
        if (info.messages.length > 0) {
          // Filter for critical compilation errors.
          const errors = info.messages.filter(m => m.type === 'error');
          if (errors.length > 0) {
            console.error("ShaderManager WGSL compile error: " + errors[0].message);
            // Locate the user-facing error UI panel and display the compilation error.
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

