// =====================================================================================
// MATHEMATICAL PHYSICS ORBIT SIMULATOR (RELATIVISTIC ORBIT MODEL)
// =====================================================================================
//
// 1. CONSTANTS OF MOTION DERIVATIONS
// -------------------------------------------------------------------------------------
// For a massive particle (observer or rocket) orbiting a Schwarzschild black hole:
//   - Proper time: τ
//   - Coordinate time: t
//   - Constants of motion: Energy E, Angular Momentum L.
//
// Relativistic geodesic equations in terms of proper time τ:
//
//   (dr/dτ)² + (1 - r_s/r)(1 + L²/r²) = E²
//   dφ/dτ = L / r²
//   dt/dτ = E / (1 - r_s/r)
//
// In our units, r_s = 2GM/c² = 1.0. If the observer starts at radius r0 with local speed v
// at direction angle δ (relative to radial direction):
//   - Local radial speed:     v_r = v * cos(δ)
//   - Local transverse speed: v_φ = v * sin(δ)
//
// Using Schwarzschild coordinate mappings, we solve for constants e and l:
//
//   e² = (1 - u0) / (1 - v²)
//   l² = (e² - 1 + u0) / [u0² * (1 - u0 + cot²(δ))]
//
// 2. RADIAL ORBIT GEODESIC INTEGRATION
// -------------------------------------------------------------------------------------
// Differentiating the radial geodesic equation with respect to proper time τ gives:
//
//   d²r/dτ² = u² * [ L² * u * (2 - 3u) - 1 ] / 2
//
// The simulator integrates this second-order ODE using Euler's method with high-density
// sub-stepping (n = 1000 steps per frame) to compute the observer's orbital trajectory.
//
// 3. LORENTZ BOOSTS & REFERENCE TETRADS
// -------------------------------------------------------------------------------------
// An observer moving with four-velocity U^μ defines a local inertial frame (tetrad).
// To transform light directions from the observer's camera to the static coordinate frame:
//   - We calculate the velocity v_i in the local static observer frame.
//   - Construct the standard 4D Special Relativistic Lorentz Boost matrix.
//   - Multiply the boost matrix by the coordinate rotation matrices (orbit tilt and camera angles)
//     to obtain the overall spacetime rotation matrix (Lorentz transform).
//
// 4. ACCELERATION & TIME DILATION
// -------------------------------------------------------------------------------------
//   - G-Force (static observer): Proper acceleration felt due to staying at a fixed radius r:
//       a = GM / (r² * √(1 - r_s/r))
//   - Time Dilation:
//       dt/dτ = E / (1 - r_s/r) (moving observer)
//       dt/dτ = 1 / √(1 - r_s/r) (static observer)
//
// =====================================================================================

// The speed of light in meters per second.
const C = 299792458;

// The gravitational constant.
const G = 6.6743e-11;

// The mass of the Sun in kilograms.
const SOLAR_MASS = 1.98847e30;

export type StateType = 'STOPPED' | 'PLAYING' | 'PAUSED';

export const State = {
  STOPPED: 'STOPPED' as StateType,
  PLAYING: 'PLAYING' as StateType,
  PAUSED: 'PAUSED' as StateType
};

export const Target = {
  DEFAULT: 0,
  BLACK_HOLE: 1,
  LEFT: 2,
  FORWARD: 3,
  RIGHT: 4
};

export interface ValueListener {
  onSettingsChange(): void;
  onOrbitChange(): void;
}

export class BooleanValue {
  private model: Model;
  private value: boolean;
  private defaultValue: boolean;

  constructor(model: Model, defaultValue: boolean) {
    this.model = model;
    this.value = defaultValue;
    this.defaultValue = defaultValue;
  }

  getDefaultValue(): boolean { return this.defaultValue; }
  getValue(): boolean { return this.value; }
  setValue(value: boolean): void {
    this.value = !!value;
    this.model.notifyListeners();
  }
}

export class QuantizedValue {
  private model: Model;
  private values: number[];
  private index: number;
  private defaultIndex: number;

  constructor(model: Model, f: (x: number) => number, defaultIndex: number, size = 1000) {
    this.model = model;
    this.values = Array.from({length: size + 1}, (_, i) => f(i / size));
    this.index = defaultIndex;
    this.defaultIndex = defaultIndex;
  }

  getSize(): number { return this.values.length; }
  getDefaultIndex(): number { return this.defaultIndex; }
  getIndex(): number { return this.index; }
  getValue(): number { return this.values[this.index]; }
  setIndex(index: number): void { 
    this.index = Math.max(0, Math.min(index, this.values.length - 1)); 
    this.model.notifyListeners();
  }
  setValue(value: number): void {
    let i0 = 0;
    let i1 = this.values.length - 1;
    if (value <= this.values[i0]) {
      this.index = i0;
    } else if (value >= this.values[i1]) {
      this.index = i1;
    } else {
      while (i1 > i0 + 1) {
        const i = Math.floor((i0 + i1) / 2);
        if (value < this.values[i]) {
          i1 = i;
        } else {
          i0 = i;
        }
      }
      this.index = value - this.values[i0] < this.values[i1] - value ? i0 : i1;
    }
    this.model.notifyListeners();
  }
}

const safeSqrt = function(x: number): number {
  return Math.sqrt(Math.max(x, 0));
};

const matrixProduct = function(a: number[][], b: number[][]): number[][] {
  const c = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  for (let i = 0; i < 4; ++i) {
    for (let j = 0; j < 4; ++j) {
      for (let k = 0; k < 4; ++k) {
        c[i][j] += a[i][k] * b[k][j];
      }
    }
  }
  return c;
};

const vectorMatrixProduct = function(v: number[], m: number[][]): number[] {
  const c = [0, 0, 0, 0];
  for (let i = 0; i < 4; ++i) {
    for (let j = 0; j < 4; ++j) {
      c[i] += v[j] * m[j][i];
    }
  }
  return c;
};

export class Model {
  cameraTarget: QuantizedValue;
  cameraYaw: QuantizedValue;
  cameraPitch: QuantizedValue;
  exposure: QuantizedValue;
  bloom: QuantizedValue;
  highDefinition: BooleanValue;
  highContrast: BooleanValue;
  startRadius: QuantizedValue;
  startDirection: QuantizedValue;
  startSpeed: QuantizedValue;
  orbitInclination: QuantizedValue;
  lensing: BooleanValue;
  doppler: BooleanValue;
  grid: BooleanValue;
  blackHoleMass: QuantizedValue;
  discDensity: QuantizedValue;
  discOpacity: QuantizedValue;
  discTemperature: QuantizedValue;
  rocketDistance: QuantizedValue;
  rocket: BooleanValue;
  starsYaw: QuantizedValue;
  starsPitch: QuantizedValue;
  starsRoll: QuantizedValue;
  stars: BooleanValue;

  starsMatrix: number[] = [];
  state: StateType = 'STOPPED';
  e: number = 0;
  l: number = 0;
  t: number = 0;
  r: number = 0;
  drOverDtau: number = 0;
  worldTheta: number = 0;
  worldPhi: number = 0;
  phi: number = 0;
  lorentz: number[][] = [];
  p: number[] = [];
  kS: number[] = [];
  fovY: number = 50 / 180 * Math.PI;
  cameraYawOffset: number = 0;

  eTau: number[] = [];
  eW: number[] = [];
  eH: number[] = [];
  eD: number[] = [];

  rocketYaw: number = 0;
  rocketLorentz: number[][] = [];
  rocketTau: number[] = [];
  rocketW: number[] = [];
  rocketH: number[] = [];
  rocketD: number[] = [];

  blackHoleRadiusMeters: number = 0;
  speedMetersPerSecond: number = 0;
  gForce: number = 0;
  localElapsedTimeSeconds: number = 0;
  globalElapsedTimeSeconds: number = 0;
  timeDilationFactor: number = 1;

  private listeners: ValueListener[] = [];

  constructor() {
    this.cameraTarget = new QuantizedValue(this, (x) => 4 * x, 0, 4);
    this.cameraYaw = new QuantizedValue(this, (x) => 2 * Math.PI * x, 0, 36000);
    this.cameraPitch = new QuantizedValue(this, (x) => Math.PI * (x - 0.5), 9000, 18000);
    this.exposure = new QuantizedValue(this, (x) => Math.pow(10, 3 * x - 3), 500);
    this.bloom = new QuantizedValue(this, (x) => x, 500);
    this.highDefinition = new BooleanValue(this, false);
    this.highContrast = new BooleanValue(this, false);
    this.startRadius = new QuantizedValue(this, (x) => Math.max(1 + 39 * x * x, 1.01), 940);
    this.startDirection = new QuantizedValue(this, (x) => Math.PI * (x - 0.5), 1800, 1800);
    this.startSpeed = new QuantizedValue(this, (x) => Math.min(x * x, 0.99), 347);
    this.orbitInclination = new QuantizedValue(this, (x) => Math.PI * (x - 0.5), 970, 1799);
    this.lensing = new BooleanValue(this, true);
    this.doppler = new BooleanValue(this, true);
    this.grid = new BooleanValue(this, false);
    this.blackHoleMass = new QuantizedValue(this, (x) => 10 * Math.pow(10, 6 * x), 384);
    this.discDensity = new QuantizedValue(this, (x) => 100 * Math.pow(x, 10), 500);
    this.discOpacity = new QuantizedValue(this, (x) => x, 300);
    this.discTemperature = new QuantizedValue(this, (x) => 1000 * Math.pow(10, x), 430);
    this.rocketDistance = new QuantizedValue(this, (x) => 30 + 50 * x, 500);
    this.rocket = new BooleanValue(this, false);
    this.starsYaw = new QuantizedValue(this, (x) => 2 * Math.PI * (x - 0.5), 1800, 3600);
    this.starsPitch = new QuantizedValue(this, (x) => Math.PI * (x - 0.5), 900, 1800);
    this.starsRoll = new QuantizedValue(this, (x) => 2 * Math.PI * (x - 0.5), 1800, 3600);
    this.stars = new BooleanValue(this, true);

    this.updateDerivedValues();
  }

  addListener(listener: ValueListener): void {
    this.listeners.push(listener);
  }

  setState(state: StateType): void {
    if (state != this.state) {
      this.state = state;
      if (state == State.PLAYING) {
        this.t = 0;
        this.localElapsedTimeSeconds = 0;
        this.globalElapsedTimeSeconds = 0;
      }
      this.notifyListeners(false);
    }
  }

  // Solves the geodesic differential equations of motion for the observer.
  updateOrbit(dTauSeconds: number): void {
    const M = this.blackHoleMass.getValue() * SOLAR_MASS;
    const dTauOverDtauSeconds = (C * C * C) / (2 * G * M);
    const dTau = dTauOverDtauSeconds * dTauSeconds;

    let u = 1 / this.r;
    const e = this.e;
    const l = this.l;
    const dtOverDtau = this.state == State.PLAYING ? e / (1 - u) : 1 / Math.sqrt(1 - u);
    this.t += dtOverDtau * dTau;
    this.localElapsedTimeSeconds += dTauSeconds;
    this.globalElapsedTimeSeconds += dtOverDtau * dTauSeconds;

    // Run high-precision sub-stepping integration to prevent Euler drift
    if (this.state == State.PLAYING) {
      const n = 1000;
      const dTauN = dTau / n;
      for (let i = 0; i < n; ++i) {
        u = 1 / this.r;
        // Derived from Schwarzschild geodesic: d²r/dτ² = u² * [ L² * u * (2 - 3u) - 1 ] / 2
        const d2rOverDtau2 = u * u * (l * l * (2 - 3 * u) * u - 1) / 2;
        this.drOverDtau += d2rOverDtau2 * dTauN;
        this.r += this.drOverDtau * dTauN;
        this.phi += l * u * u * dTauN; // dφ/dτ = L / r²
        if (this.r <= 1.0 || this.r > 100.0) {
          this.setState(State.STOPPED);
          return;
        }
      }
    }
    this.notifyListeners(false);
  }

  notifyListeners(settingsChanged = true): void {
    this.updateDerivedValues();
    for (let listener of this.listeners) {
      if (settingsChanged) {
        listener.onSettingsChange();
      }
      listener.onOrbitChange();
    }
  }

  updateDerivedValues(): void {
    this.updateStarsMatrix();
    this.updateCameraCoordinates();
    this.updateCameraAndRocketLorentzTransforms();
    this.updateCameraAndRocketReferenceFrames();
    this.updateOrbitInfo();
  }

  updateStarsMatrix(): void {
    const cy = Math.cos(this.starsYaw.getValue() + Math.PI);
    const sy = Math.sin(this.starsYaw.getValue() + Math.PI);
    const cp = Math.cos(this.starsPitch.getValue());
    const sp = Math.sin(this.starsPitch.getValue());
    const cr = Math.cos(this.starsRoll.getValue());
    const sr = Math.sin(this.starsRoll.getValue());
    this.starsMatrix = [
      cp * cy,                cp * sy,     -sp,
      sr * sp * cy - cr * sy, sr * sp * sy + cr * cy, sr * cp,
      cr * sp * cy + sr * sy, cr * sp * sy - sr * cy, cr * cp
    ];
  }

  // Solves the initial constants of motion from starting parameters r0, direction angle, and speed.
  updateCameraCoordinates(): void {
    const r0 = this.startRadius.getValue();
    const delta = this.startDirection.getValue();
    const v = this.startSpeed.getValue();

    // Schwarzschild coordinate representation of constants of motion:
    const u0 = 1 / r0;
    const cotDelta = 1 / Math.tan(delta);
    const e2 = (1 - u0) / (1 - v * v);
    const l2 = (e2 - 1 + u0) / (u0 * u0 * (1 - u0 + cotDelta * cotDelta));
    const e = safeSqrt(e2);
    const l = delta == 0 ? 0 : (delta > 0 ? 1 : -1) * safeSqrt(l2);
    this.e = e;
    this.l = l;

    // Reset parameters when orbit simulation is stopped
    if (this.state == State.STOPPED) {
      this.r = r0;
      this.drOverDtau = -safeSqrt(e2 - (1 - u0) - l * l * u0 * u0 * (1 - u0));
      this.phi = 0;
    }
    const ci = Math.cos(this.orbitInclination.getValue());
    const si = Math.sin(this.orbitInclination.getValue());
    const cphi = Math.cos(this.phi);
    const sphi = Math.sin(this.phi);
    this.worldTheta = Math.acos(cphi * si);
    this.worldPhi = Math.atan2(sphi, cphi * ci);
  }

  // Computes the Lorentz boost tensors and relative camera/rocket local angles.
  updateCameraAndRocketLorentzTransforms(): void {
    const e = this.e;
    const l = this.l;
    const u = 1 / this.r;
    let k: number[];
    if (this.state == State.PLAYING) {
      k = [e / (1 - u), this.drOverDtau, 0, l * u * u];
    } else {
      k = [1 / Math.sqrt(1 - u), 0, 0, 0];
    }

    const ct = Math.cos(this.worldTheta);
    const st = Math.sin(this.worldTheta);
    const cp = Math.cos(this.worldPhi);
    const sp = Math.sin(this.worldPhi);
    const ci = Math.cos(this.orbitInclination.getValue());
    const si = Math.sin(this.orbitInclination.getValue());
    const ca = si * ct * cp + st * ci;
    const sa = si * sp;
    const orbitRot = [
      [1, 0,  0,   0],
      [0, 1,  0,   0],
      [0, 0, ca, -sa],
      [0, 0, sa,  ca]];

    const k_s = [k[0] * Math.sqrt(1 - u), k[1] / Math.sqrt(1 - u), k[2] / u, k[3] / u];
    const v = [k_s[1] / k_s[0], k_s[2] / k_s[0], k_s[3] / k_s[0]];
    const v2 = v[0] * v[0] + v[1] * v[1] + v[2] * v[2];
    const gamma = 1 / Math.sqrt(1 - v2);
    const gv = v2 == 0 ? 0 : (gamma - 1) / v2;
    
    // Spacetime 4-velocity boost matrix:
    const boost = [
      [     gamma,       gamma*v[0],       gamma*v[1],       gamma*v[2]],
      [gamma*v[0], 1 + gv*v[0]*v[0],     gv*v[0]*v[1],     gv*v[0]*v[2]],
      [gamma*v[1],     gv*v[1]*v[0], 1 + gv*v[1]*v[1],     gv*v[1]*v[2]],
      [gamma*v[2],     gv*v[2]*v[0],     gv*v[2]*v[1], 1 + gv*v[2]*v[2]]];

    this.cameraYawOffset = 0;
    if (this.state == State.PLAYING) {
      if (this.cameraTarget.getValue() == Target.BLACK_HOLE) {
        this.cameraYawOffset = this.getYaw(boost, -1, 0) - Math.PI;
      } else if (this.cameraTarget.getValue() != Target.DEFAULT) {
        this.cameraYawOffset = this.getYaw(boost, k_s[1], k_s[3]) - Math.PI +
            (Target.FORWARD - this.cameraTarget.getValue()) * Math.PI / 2;
      }
    }
    const cosY = Math.cos(this.cameraYaw.getValue() + this.cameraYawOffset);
    const sinY = Math.sin(this.cameraYaw.getValue() + this.cameraYawOffset);
    const cosP = Math.cos(this.cameraPitch.getValue());
    const sinP = Math.sin(this.cameraPitch.getValue());
    const cameraRot = [
      [1,            0,     0,            0],
      [0,        -sinY,     0,         cosY],
      [0, -cosY * sinP, -cosP, -sinY * sinP],
      [0,  cosY * cosP, -sinP,  sinY * cosP]];

    this.lorentz = matrixProduct(cameraRot, matrixProduct(boost, orbitRot));

    if (this.state == State.PLAYING) {
      this.rocketYaw = this.getYaw(boost, k_s[1], k_s[3]);
    } else {
      this.rocketYaw = 0;
    }
    const cosRy = Math.cos(this.rocketYaw);
    const sinRy = Math.sin(this.rocketYaw);
    const rocketRot = [
      [1,      0,  0,     0],
      [0, -sinRy,  0, cosRy],
      [0,      0, -1,     0],
      [0,  cosRy,  0, sinRy]];
    this.rocketLorentz = matrixProduct(rocketRot, matrixProduct(boost, orbitRot));
  }

  getYaw(boost: number[][], dr: number, dphi: number): number {
    const dt = -Math.sqrt(dr * dr + dphi * dphi);
    const dr0 = -boost[1][0] * dt + boost[1][1] * dr + boost[1][3] * dphi;
    const dphi0 = -boost[3][0] * dt + boost[3][1] * dr + boost[3][3] * dphi;
    return Math.atan2(dphi0, dr0);
  }

  // Generates coordinate axes (tetrads) representing the local observer reference frame.
  updateCameraAndRocketReferenceFrames(): void {
    const r = this.r;
    const cos_theta = Math.cos(this.worldTheta);
    const sin_theta = Math.sin(this.worldTheta);
    const cos_phi = Math.cos(this.worldPhi);
    const sin_phi = Math.sin(this.worldPhi);

    const u = 1 / r;
    const v = Math.sqrt(1 - u);
    const ur = [sin_theta * cos_phi, sin_theta * sin_phi, cos_theta];

    // Schwarzschild static tetrad vectors:
    const e_t = [1 / v, 0, 0, 0];
    const e_r = [0, v * ur[0], v * ur[1], v * ur[2]];
    const e_theta = [0, cos_theta * cos_phi, cos_theta * sin_phi, -sin_theta];
    const e_phi = [0, -sin_phi, cos_phi, 0];

    const L = this.lorentz;
    const e_static = [e_t, e_r, e_theta, e_phi];
    this.eTau = vectorMatrixProduct(L[0], e_static);
    this.eW = vectorMatrixProduct(L[1], e_static);
    this.eH = vectorMatrixProduct(L[2], e_static);
    this.eD = vectorMatrixProduct(L[3], e_static);

    this.rocketTau = vectorMatrixProduct(this.rocketLorentz[0], e_static);
    this.rocketW = vectorMatrixProduct(this.rocketLorentz[1], e_static);
    this.rocketH = vectorMatrixProduct(this.rocketLorentz[2], e_static);
    this.rocketD = vectorMatrixProduct(this.rocketLorentz[3], e_static);

    this.p = [r * ur[0], r * ur[1], r * ur[2]];
    this.kS = [L[0][0] / v, v * L[0][1], u * L[0][2], u / sin_theta * L[0][3]];
  }

  // Computes UI physical statistics (g-force, velocity, time dilation).
  updateOrbitInfo(): void {
    const M = this.blackHoleMass.getValue() * SOLAR_MASS;
    this.blackHoleRadiusMeters = (2 * G * M) / (C * C);
    const e = this.e;
    const u = 1 / this.r;
    if (this.state == State.PLAYING) {
      this.speedMetersPerSecond = Math.sqrt(1 - (1 - u) / (e * e)) * C;
      this.gForce = 0; // In free fall, proper acceleration is zero (equivalence principle)
      this.timeDilationFactor = e / (1 - u); // dt/dτ = E / (1 - r_s/r)
    } else {
      const rMeters = this.r * this.blackHoleRadiusMeters;
      this.speedMetersPerSecond = 0;
      // Proper acceleration felt by static observer: a = GM / (r² * √(1 - r_s/r))
      this.gForce = G * M / (rMeters * rMeters * Math.sqrt(1 - u));
      this.timeDilationFactor = 1 / Math.sqrt(1 - u); // dt/dτ = 1 / √(1 - r_s/r)
    }
  }
}
