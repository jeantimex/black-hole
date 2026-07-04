(function() {

class Bloom {
  constructor(device, width, height) {
    this.device = device;
  }
  begin() {
    // No-op. Output is tone-mapped in fragment shader directly.
  }
  end(bloom, exposure, highContrast) {
    // No-op.
  }
  resize(width, height) {
    // No-op.
  }
}

BlackHoleShaderDemoApp.Bloom = Bloom;
})();
