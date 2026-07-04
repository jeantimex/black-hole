import { Model, ValueListener } from './model';

/**
 * Context3d is a lightweight custom 3D projection engine that projects 3D coordinates
 * onto a 2D HTML5 canvas context. It handles basic camera orientation, perspective projection,
 * and near-plane clipping.
 */
class Context3d {
  private context: CanvasRenderingContext2D;
  // Camera basis vectors (ex: right, ey: up, ez: forward/look direction)
  private ex: number[];
  private ey: number[];
  private ez: number[];
  // Camera position in 3D world space
  private camera: number[];
  private width: number;
  private height: number;
  private focal: number;
  private nearPlane: number;
  // Cache of the previously projected point to connect lines and perform clipping
  private lastCameraPt: number[];

  constructor(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error("Could not get 2D context");
    this.context = ctx;

    const r = 120; // Orbit map camera distance from the black hole
    const theta = 70 * Math.PI / 180; // Pitch angle of orbit map viewer
    const phi = -135 * Math.PI / 180; // Yaw angle of orbit map viewer
    const fovY = 30 * Math.PI / 180; // Vertical field of view

    // Compute standard camera coordinate axes using spherical trigonometry
    this.ex = [-Math.sin(phi), Math.cos(phi), 0];
    this.ey = [-Math.cos(theta) * Math.cos(phi),
               -Math.cos(theta) * Math.sin(phi),
                Math.sin(theta)];
    this.ez = [Math.sin(theta) * Math.cos(phi),
               Math.sin(theta) * Math.sin(phi),
               Math.cos(theta)];
    // Place camera at radius 'r' looking down the ez axis
    this.camera = [r * this.ez[0], r * this.ez[1], r * this.ez[2]];

    this.width = canvas.width;
    this.height = canvas.height;
    // Focal length (in pixels) = height / (2 * tan(fovY / 2))
    this.focal = this.height / (2 * Math.tan(fovY / 2));
    this.nearPlane = -0.1; // Clipping plane (elements behind this are skipped/clipped)
    this.lastCameraPt = [];
  }

  /** Begins a new 3D path by moving the cursor to (x, y, z). */
  moveTo(x: number, y: number, z: number): void {
    this.pathTo(x, y, z, true);
  }

  /** Extends the current 3D path with a line segment to (x, y, z). */
  lineTo(x: number, y: number, z: number): void {
    this.pathTo(x, y, z, false);
  }

  /**
   * Projects a 3D coordinate and routes it to HTML5 canvas moveTo or lineTo operations.
   * Handles clipping lines that cross or reside behind the near plane.
   */
  private pathTo(x: number, y: number, z: number, move: boolean): void {
    const cameraPt = this.toCameraPt([x, y, z]);
    const screenPt = this.toScreenPt(cameraPt);
    if (move) {
      this.context.moveTo(screenPt[0], screenPt[1]);
    } else {
      // In camera space, coordinates behind the camera have negative Z.
      if (cameraPt[2] < this.nearPlane) {
        if (this.lastCameraPt[2] > this.nearPlane) {
          // Crosses from in-front to behind the near plane: clip and moveTo boundary.
          this.clipTo(cameraPt, true);
        }
        this.context.lineTo(screenPt[0], screenPt[1]);
      } else if (this.lastCameraPt[2] < this.nearPlane) {
        // Crosses from behind to in-front of the near plane: clip and lineTo boundary.
        this.clipTo(cameraPt, false);
      }
    }
    this.lastCameraPt = cameraPt;
  }

  /**
   * Clips a line segment at the near plane boundary via linear interpolation.
   */
  private clipTo(cameraPt: number[], move: boolean): void {
    const t = (this.nearPlane - this.lastCameraPt[2]) / 
        (cameraPt[2] - this.lastCameraPt[2]);
    const nearPlanePt = [
        this.lastCameraPt[0] + t * (cameraPt[0] - this.lastCameraPt[0]),
        this.lastCameraPt[1] + t * (cameraPt[1] - this.lastCameraPt[1]),
        this.nearPlane];
    const screenPt = this.toScreenPt(nearPlanePt);
    if (move) {
      this.context.moveTo(screenPt[0], screenPt[1]);
    } else {
      this.context.lineTo(screenPt[0], screenPt[1]);
    }
  }

  /**
   * Transforms world-space coordinates [x, y, z] to camera-space coordinates.
   * Subtracts camera origin and projects onto camera basis vectors [ex, ey, ez].
   */
  toCameraPt(worldPt: number[]): number[] {
    const q = [worldPt[0] - this.camera[0],
               worldPt[1] - this.camera[1],
               worldPt[2] - this.camera[2]];
    return [q[0] * this.ex[0] + q[1] * this.ex[1] + q[2] * this.ex[2],
            q[0] * this.ey[0] + q[1] * this.ey[1] + q[2] * this.ey[2],
            q[0] * this.ez[0] + q[1] * this.ez[1] + q[2] * this.ez[2]];
  }

  /**
   * Projects a camera-space point to 2D screen coordinates.
   * Performs standard perspective division: screen = center +/- focal * coord / Z.
   */
  toScreenPt(cameraPt: number[]): number[] {
    return [this.width * 0.5 - 0.5 * this.focal * cameraPt[0] / cameraPt[2],
            this.height * 0.5 + 0.5 * this.focal * cameraPt[1] / cameraPt[2]];
  }
}

const safeSqrt = function(x: number): number {
  return Math.sqrt(Math.max(x, 0));
};

/**
 * OrbitPanel maintains the 2D canvas displaying the rocket's current orbit,
 * Schwarzschild metrics (proper/global time, dilation, g-force, velocity),
 * and dynamic view-frustum tracking line overlay.
 */
export class OrbitPanel implements ValueListener {
  private rootElement: HTMLElement;
  private model: Model;
  private blackHoleRadius: HTMLElement;
  private radius: HTMLElement;
  private speed: HTMLElement;
  private gforce: HTMLElement;
  private localTime: HTMLElement;
  private globalTime: HTMLElement;
  private timeDilation: HTMLElement;
  private dot: HTMLElement;
  private frustum: HTMLElement[];
  private numberFormat: Intl.NumberFormat;
  private lastStartRadius: number | undefined;
  private lastStartDirection: number | undefined;
  private lastStartSpeed: number | undefined;
  private lastOrbitInclination: number | undefined;
  private canvas: HTMLCanvasElement;
  private context: CanvasRenderingContext2D;
  private context3d: Context3d;

  constructor(rootElement: HTMLElement, model: Model) {
    this.rootElement = rootElement;
    this.model = model;
    this.model.addListener(this);

    const selectOrThrow = (selector: string): HTMLElement => {
      const el = rootElement.querySelector(selector);
      if (!el) throw new Error(`Element ${selector} not found`);
      return el as HTMLElement;
    };

    // DOM bindings for status read-outs.
    this.blackHoleRadius = selectOrThrow('#op_black_hole_radius');
    this.radius = selectOrThrow('#op_radius');
    this.speed = selectOrThrow('#op_speed');
    this.gforce = selectOrThrow('#op_gforce');
    this.localTime = selectOrThrow('#op_local_time');
    this.globalTime = selectOrThrow('#op_global_time');
    this.timeDilation = selectOrThrow('#op_time_dilation');
    this.dot = selectOrThrow('#op_dot');
    
    // Bind frustum lines that visually trace out the rocket's field-of-view in the 3D diagram.
    this.frustum = [];
    for (let i = 0; i <= 8; ++i) {
      this.frustum.push(selectOrThrow(`#op_frustum${i}`));
    }
    this.numberFormat = new Intl.NumberFormat('en-US', {maximumFractionDigits : 1});

    this.lastStartRadius = undefined;
    this.lastStartDirection = undefined;
    this.lastStartSpeed = undefined;
    this.lastOrbitInclination = undefined;

    this.canvas = selectOrThrow('#canvas') as HTMLCanvasElement;
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error("Could not get 2D context");
    this.context = ctx;
    this.context3d = new Context3d(this.canvas);

    this.onSettingsChange();
    this.onOrbitChange();
    this.toggleVisibility();

    document.body.addEventListener('keypress', (e) => this.onKeyPress(e));
  }

  /**
   * Re-draws the static aspects of the orbital coordinate system
   * (inclined grid, axes, disk, and projected geodesic curve) when initial orbit settings change.
   */
  onSettingsChange(): void {
    if (this.lastStartRadius == this.model.startRadius.getValue() &&
        this.lastStartDirection == this.model.startDirection.getValue() &&
        this.lastStartSpeed == this.model.startSpeed.getValue() &&
        this.lastOrbitInclination == this.model.orbitInclination.getValue()) {
      return;
    }
    this.lastStartRadius = this.model.startRadius.getValue();
    this.lastStartDirection = this.model.startDirection.getValue();
    this.lastStartSpeed = this.model.startSpeed.getValue();
    this.lastOrbitInclination = this.model.orbitInclination.getValue();

    // Clear Canvas and repaint standard references.
    this.context.clearRect(0, 0, this.canvas.width, this.canvas.height);
    this.context.strokeStyle = '#AAA';
    this.context.beginPath();
    this.drawGrid(100, 12, this.model.orbitInclination.getValue());
    this.context.stroke();    
    this.drawAxes();
    this.drawDisc();
    this.drawOrbit();
  }

  /**
   * Updates relativistic physical variables and moves overlays on every frame tick.
   */
  onOrbitChange(): void {
    const model = this.model;
    const radiusMeters = model.r * model.blackHoleRadiusMeters;
    
    // Format and display metric parameters.
    this.blackHoleRadius.innerText =
        `${this.numberFormat.format(model.blackHoleRadiusMeters / 1000)}km`;
    this.radius.innerText = 
        `${this.numberFormat.format(radiusMeters / 1000)}km`;
    this.speed.innerText = 
        `${this.numberFormat.format(model.speedMetersPerSecond / 1000)}km/s`;
    this.gforce.innerText = 
        `${this.numberFormat.format(model.gForce / 9.80665)}g`;
    this.localTime.innerText = 
        `${model.localElapsedTimeSeconds.toFixed(2)}s`;
    this.globalTime.innerText = 
        `${model.globalElapsedTimeSeconds.toFixed(2)}s`;
    this.timeDilation.innerText = 
        `${model.timeDilationFactor.toFixed(3)}`;

    // Re-project the active rocket dot and view frustum coordinates.
    this.drawDotAndFrustum();
  }

  /**
   * Projects the rocket position and its camera frustum edges into the 3D viewport.
   * Relies on the rocket's local reference frame vectors (eTau, eW, eH, eD)
   * to align the frustum pointing direction in General Relativity space.
   */
  drawDotAndFrustum(): void {
    const model = this.model;
    const context3d = this.context3d;
    
    // Resolve rocket orbit-plane coordinate position.
    const ci = Math.cos(model.orbitInclination.getValue());
    const si = Math.sin(model.orbitInclination.getValue());
    const worldPt = [ci * model.r * Math.cos(model.phi),
                          model.r * Math.sin(model.phi),
                     si * model.r * Math.cos(model.phi)];
    
    // Project rocket position into 2D screen coordinate.
    const screenPt = context3d.toScreenPt(context3d.toCameraPt(worldPt));
    this.dot.style.left = `${screenPt[0]}px`;
    this.dot.style.top = `${screenPt[1]}px`;
 
    // Field-of-view dimensions
    const tanFovY = Math.tan(model.fovY / 2);
    const focalLength = 1 / (2 * tanFovY);
    const aspectRatio = document.body.clientWidth / document.body.clientHeight;
    
    // Local reference frame four-vectors of the rocket.
    const eTau = model.eTau;
    const eW = model.eW;
    const eH = model.eH;
    const eD = model.eD;
    
    // Computes where a specific corner of the camera's view frustum projects in the 3D space map.
    const getFrustumScreenPt = function(i: number, j: number, l: number): number[] {
      const w = i * aspectRatio;
      const h = j;
      const d = -focalLength;
      const n = Math.sqrt(w * w + h * h + d * d);
      
      // Compute the spatial view direction vectors relative to the observer's frame.
      const dx = -eTau[1] + (w * eW[1] + h * eH[1] + d * eD[1]) / n;
      const dy = -eTau[2] + (w * eW[2] + h * eH[2] + d * eD[2]) / n;
      const dz = -eTau[3] + (w * eW[3] + h * eH[3] + d * eD[3]) / n;
      const dl = Math.sqrt(dx * dx + dy * dy + dz * dz);
      
      // Project the ray out to a length 'l'.
      const frustumWorldPt = [
        worldPt[0] + l * dx / dl,
        worldPt[1] + l * dy / dl,
        worldPt[2] + l * dz / dl
      ];
      return context3d.toScreenPt(context3d.toCameraPt(frustumWorldPt));
    };
    
    // Map the 4 corner rays and center direction of the frustum.
    const frustumScreenPts = [
      getFrustumScreenPt(-1, -1, 10),
      getFrustumScreenPt(-1, 1, 10),
      getFrustumScreenPt(1, 1, 10),
      getFrustumScreenPt(1, -1, 10),
      getFrustumScreenPt(0, 0, 10)
    ];
    
    // Position HTML line elements dynamically by converting coordinates into 2D affine transformation matrices.
    for (let i = 0; i < 4; ++i) {
      this.setLine(this.frustum[i], screenPt, frustumScreenPts[i]);
      this.setLine(this.frustum[i + 4], frustumScreenPts[i], 
          frustumScreenPts[(i + 1) % 4]);
    }
    this.setLine(this.frustum[8], screenPt, frustumScreenPts[4]);
  }

  /**
   * Position, rotates, and stretches an HTML element (serving as a line) between two 2D points.
   * Expressed as a CSS 2D affine transformation matrix:
   * [a, b, c, d, tx, ty]
   * where (tx, ty) is translation, and a,b,c,d handle rotation and scaling.
   */
  setLine(element: HTMLElement, p: number[], q: number[]): void {
    const dx = q[0] - p[0];
    const dy = q[1] - p[1];
    const scale = Math.sqrt(dx * dx + dy * dy);
    const theta = Math.atan2(dy, dx);
    const a = scale * Math.cos(theta);
    const b = scale * Math.sin(theta);
    const c = -Math.sin(theta);
    const d = Math.cos(theta);
    const tx = p[0];
    const ty = p[1];
    element.style.transform = `matrix(${a}, ${b}, ${c}, ${d}, ${tx}, ${ty})`;
  }

  /** Draws the grid template representing the orbital equatorial plane. */
  drawGrid(halfSize: number, steps: number, orbitInclination: number): void {
    const ci = Math.cos(orbitInclination);
    const si = Math.sin(orbitInclination);
    for (let i = 0; i <= steps; ++i) {
      const step = -halfSize + 2 * (i / steps) * halfSize;
      this.context3d.moveTo(-ci * halfSize, step, -si * halfSize);
      this.context3d.lineTo(ci * halfSize, step, si * halfSize);
      this.context3d.moveTo(ci * step, -halfSize, si * step);
      this.context3d.lineTo(ci * step, halfSize, si * step);
    }
  }

  /** Renders color-coded 3D basis axes (Red: X, Green: Y, Blue: Z). */
  drawAxes(): void {
    const context = this.context;
    const context3d = this.context3d;
    context.strokeStyle = '#F00';
    context.beginPath();
    context3d.moveTo(0, 0, 0);
    context3d.lineTo(40, 0, 0);
    context.stroke(); 
    context.strokeStyle = '#0F0';
    context.beginPath();
    context3d.moveTo(0, 0, 0);
    context3d.lineTo(0, 40, 0);
    context.stroke(); 
    context.strokeStyle = '#00F';
    context.beginPath();
    context3d.moveTo(0, 0, 0);
    context3d.lineTo(0, 0, 40);
    context.stroke(); 
  }

  /** Draws inner and outer boundary markers for the accretion disk. */
  drawDisc(): void {
    const context = this.context;
    context.strokeStyle = '#FF0';
    context.lineWidth = 2;
    context.beginPath();
    this.drawCircle(3); // ISCO (Innermost Stable Circular Orbit) for Schwarzschild is r = 3 Rs
    this.drawCircle(12); // Disc outer boundary limit
    context.stroke();
    context.lineWidth = 1;
  }

  /** Renders a circular contour of a given radius in 3D camera space. */
  drawCircle(radius: number): void {
    this.context3d.moveTo(radius, 0, 0);
    for (let i = 1; i <= 64; ++i) {
      const a = 2 * Math.PI * i / 64;
      this.context3d.lineTo(radius * Math.cos(a), radius * Math.sin(a), 0);
    }
  }

  /**
   * Numerically integrates and draws the general relativistic orbit trajectory.
   * Integrates Schwarzschild geodesic equations of motion:
   * dr/dtau = sqrt(e^2 - (1 - u) - l^2 * u^2 * (1 - u))
   * d^2r/dtau^2 = 0.5 * u^2 * (l^2 * u * (2 - 3u) - 1)
   * dphi/dtau = l * u^2
   */
  drawOrbit(): void {
    const context = this.context;
    context.lineWidth = 2;
    context.strokeStyle = '#FFF';
    context.shadowOffsetX = 1;
    context.shadowOffsetY = 1;
    context.shadowBlur = 2;
    context.shadowColor = '#000';
    context.beginPath();
    
    const ci = Math.cos(this.model.orbitInclination.getValue());
    const si = Math.sin(this.model.orbitInclination.getValue());
    
    // Read energy (e) and angular momentum (l) constants of motion from model.
    const e = this.model.e;
    const l = this.model.l;
    let r = this.model.startRadius.getValue();
    let u = 1 / r;
    // Initial radial velocity relative to proper time.
    let drOverDtau = -safeSqrt(e * e - (1 - u) - l * l * u * u * (1 - u));
    let phi = 0;

    let i = 0;
    let dashes = false;
    this.context3d.moveTo(ci * r, 0, si * r);
    
    // Perform Euler integration forward in proper time (dTau)
    while (Math.abs(phi) < 6 * Math.PI) {
      u = 1 / r;
      // Step size modulated by radial redshift parameter.
      const dTau = 1e-2 / Math.sqrt(e * e / (1 - u) - 0.99);
      // Geodesic second radial derivative (radial acceleration in Schwarzschild space-time)
      const d2rOverDtau2 = u * u * (l * l * u * (2 - 3 * u) - 1) / 2;
      
      // Update variables.
      drOverDtau += d2rOverDtau2 * dTau;
      r += drOverDtau * dTau;
      phi += l * u * u * dTau;
      
      // Stop integration if orbit escapes or crosses event horizon.
      if (r > 100.0 || r <= 1.0) {
        break;
      }
      
      // Decimate path drawing commands to save performance.
      if ((++i) % 100 == 0) {
        const x = r * Math.cos(phi);
        const y = r * Math.sin(phi);
        this.context3d.lineTo(ci * x, y, si * x);
        // Switch to dashed lines for distant parts of orbit tail.
        if (Math.abs(phi) > 5 * Math.PI && !dashes) {
          context.stroke(); 
          context.beginPath();
          this.context3d.moveTo(ci * x, y, si * x);
          context.setLineDash([5, 5]);
          dashes = true;
        }
      }
    }
    context.stroke(); 
    context.lineWidth = 1;
    context.setLineDash([]);
    context.shadowOffsetX = 0;
    context.shadowOffsetY = 0;
    context.shadowBlur = 0;
  }

  onKeyPress(event: KeyboardEvent): void {
    if (event.key == ' ') {
      this.toggleVisibility();
    }
  }

  toggleVisibility(): void {
    this.rootElement.classList.toggle('op-hidden');
  }
}

