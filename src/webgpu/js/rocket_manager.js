(function() {

class RocketManager {
  constructor(model, device) {
    this.model = model;
    this.device = device;
  }
  renderEnvMap(program, vertexBuffer) {
    // No-op
  }
  drawRocket() {
    // No-op
  }
  drawExhaust(tauSeconds, gForce) {
    // No-op
  }
}

BlackHoleShaderDemoApp.RocketManager = RocketManager;
})();
