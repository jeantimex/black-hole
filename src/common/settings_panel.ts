import { Model, BooleanValue, QuantizedValue, ValueListener, State } from './model';

class Checkbox {
  private checkbox: HTMLInputElement;
  private model: BooleanValue;

  constructor(rootElement: HTMLElement, name: string, model: BooleanValue) {
    const el = rootElement.querySelector(`#sp_${name}`);
    if (!el) throw new Error(`Checkbox sp_${name} not found`);
    this.checkbox = el as HTMLInputElement;
    this.checkbox.addEventListener('input', () => {
      model.setValue(this.checkbox.checked);
    });
    this.model = model;
  }
  update(): void {
    this.checkbox.checked = this.model.getValue();
  }
}

class Slider {
  private slider: HTMLInputElement;
  private value: HTMLElement;
  private model: QuantizedValue;

  constructor(rootElement: HTMLElement, name: string, model: QuantizedValue) {
    const sliderEl = rootElement.querySelector(`#sp_${name}`);
    const valueEl = rootElement.querySelector(`#sp_${name}_value`);
    if (!sliderEl) throw new Error(`Slider sp_${name} not found`);
    if (!valueEl) throw new Error(`Slider value span sp_${name}_value not found`);

    this.slider = sliderEl as HTMLInputElement;
    this.value = valueEl as HTMLElement;
    this.model = model;

    this.slider.min = '0';
    this.slider.max = (model.getSize() - 1).toString();
    this.slider.addEventListener('input', () => {
      model.setIndex(parseInt(this.slider.value));
    });

    const prevBtn = this.slider.previousElementSibling;
    if (prevBtn) {
      prevBtn.addEventListener('click', () => {
        model.setIndex(model.getIndex() - 1);
      });
    }

    const nextBtn = this.slider.nextElementSibling;
    if (nextBtn) {
      nextBtn.addEventListener('click', () => {
        model.setIndex(model.getIndex() + 1);
      });
    }
  }
  getValue(): number { return this.model.getValue(); }
  setValue(value: number): void { this.model.setValue(value); }
  enable(enabled: boolean): void {
    this.slider.disabled = !enabled;
    const prev = this.slider.previousElementSibling as HTMLButtonElement | null;
    const next = this.slider.nextElementSibling as HTMLButtonElement | null;
    if (prev) prev.disabled = !enabled;
    if (next) next.disabled = !enabled;
  }  
  update(format: (v: number) => string): void {
    this.slider.value = this.model.getIndex().toString();
    this.value.innerText = format(this.model.getValue());
  }
}

const quaternionFromAxisAngle = function(x: number, y: number, z: number, theta: number): number[] {
  const ct = Math.cos(theta * 0.5);
  const st = Math.sin(theta * 0.5);
  return [ct, st * x, st * y, st * z];
};

const quaternionFromEulerAngles = function(yaw: number, pitch: number, roll: number): number[] {
  const cy = Math.cos(yaw * 0.5);
  const sy = Math.sin(yaw * 0.5);
  const cp = Math.cos(pitch * 0.5);
  const sp = Math.sin(pitch * 0.5);
  const cr = Math.cos(roll * 0.5);
  const sr = Math.sin(roll * 0.5);
  return [
    cy * cp * cr + sy * sp * sr,
    cy * cp * sr - sy * sp * cr,
    sy * cp * sr + cy * sp * cr,
    sy * cp * cr - cy * sp * sr];
};

const quaternionProduct = function(q1: number[], q2: number[]): number[] {
  return [
    q1[0] * q2[0] - q1[1] * q2[1] - q1[2] * q2[2] - q1[3] * q2[3],
    q1[0] * q2[1] + q1[1] * q2[0] + q1[2] * q2[3] - q1[3] * q2[2],
    q1[0] * q2[2] - q1[1] * q2[3] + q1[2] * q2[0] + q1[3] * q2[1],
    q1[0] * q2[3] + q1[1] * q2[2] - q1[2] * q2[1] + q1[3] * q2[0]
  ];
};

const quaternionToEulerAngles = function(qw: number, qx: number, qy: number, qz: number): number[] {
  const sinr_cosp = 2 * (qw * qx + qy * qz);
  const cosr_cosp = 1 - 2 * (qx * qx + qy * qy);
  const roll = Math.atan2(sinr_cosp, cosr_cosp);
  const sinp = 2 * (qw * qy - qz * qx);
  let pitch: number;
  if (Math.abs(sinp) >= 1) {
    pitch = sinp > 0 ? Math.PI / 2 : -Math.PI / 2;
  } else {
    pitch = Math.asin(sinp);
  }
  const siny_cosp = 2 * (qw * qz + qx * qy);
  const cosy_cosp = 1 - 2 * (qy * qy + qz * qz);
  const yaw = Math.atan2(siny_cosp, cosy_cosp);
  return [yaw, pitch, roll];
};

export class SettingsPanel implements ValueListener {
  private rootElement: HTMLElement;
  private model: Model;
  private cameraTarget: HTMLElement;
  private exposure: Slider;
  private bloom: Slider;
  private highDefinition: Checkbox;
  private highContrast: Checkbox;
  private startRadius: Slider;
  private startDirection: Slider;
  private startSpeed: Slider;
  private orbitInclination: Slider;
  private lensing: Checkbox;
  private doppler: Checkbox;
  private grid: Checkbox;
  private blackHoleMass: Slider;
  private discDensity: Slider;
  private discOpacity: Slider;
  private discTemperature: Slider;
  private rocketDistance: Slider;
  private rocket: Checkbox;
  private starsYaw: Slider;
  private starsPitch: Slider;
  private starsRoll: Slider;
  private stars: Checkbox;

  private previousMouseX: number | undefined = undefined;
  private previousMouseY: number | undefined = undefined;
  private drag = false;

  constructor(rootElement: HTMLElement, model: Model) {
    this.rootElement = rootElement;
    this.model = model;
    this.model.addListener(this);

    if (window.devicePixelRatio <= 1) {
      const highDefinitionDiv = this.rootElement.querySelector('#sp_high_definition_div');
      if (highDefinitionDiv) highDefinitionDiv.classList.toggle('sp-hidden', true);
    }

    const camTarget = this.rootElement.querySelector('#sp_target_container');
    if (!camTarget) throw new Error("sp_target_container not found");
    this.cameraTarget = camTarget as HTMLElement;

    this.exposure = new Slider(rootElement, 'exposure', model.exposure);
    this.bloom = new Slider(rootElement, 'bloom', model.bloom);
    this.highDefinition = new Checkbox(rootElement, 'high_definition', model.highDefinition);
    this.highContrast = new Checkbox(rootElement, 'high_contrast', model.highContrast);
    this.startRadius = new Slider(rootElement, 'start_radius', model.startRadius);
    this.startDirection = new Slider(rootElement, 'start_direction', model.startDirection);
    this.startSpeed = new Slider(rootElement, 'start_speed', model.startSpeed);
    this.orbitInclination = new Slider(rootElement, 'orbit_inclination', model.orbitInclination);
    this.lensing = new Checkbox(rootElement, 'lensing', model.lensing);
    this.doppler = new Checkbox(rootElement, 'doppler', model.doppler);
    this.grid = new Checkbox(rootElement, 'grid', model.grid);
    this.blackHoleMass = new Slider(rootElement, 'black_hole_mass', model.blackHoleMass);
    this.discDensity = new Slider(rootElement, 'disc_density', model.discDensity);
    this.discOpacity = new Slider(rootElement, 'disc_opacity', model.discOpacity);
    this.discTemperature = new Slider(rootElement, 'disc_temperature', model.discTemperature);
    this.rocketDistance = new Slider(rootElement, 'rocket_distance', model.rocketDistance);
    this.rocket = new Checkbox(rootElement, 'rocket', model.rocket);
    this.starsYaw = new Slider(rootElement, 'stars_yaw', model.starsYaw);
    this.starsPitch = new Slider(rootElement, 'stars_pitch', model.starsPitch);
    this.starsRoll = new Slider(rootElement, 'stars_roll', model.starsRoll);
    this.stars = new Checkbox(rootElement, 'stars', model.stars);

    this.onSettingsChange();
    this.onOrbitChange();
    this.toggleVisibility();

    const selectOrThrow = (selector: string): HTMLElement => {
      const el = this.rootElement.querySelector(selector);
      if (!el) throw new Error(`Element ${selector} not found`);
      return el as HTMLElement;
    };

    for (let i = 0; i < 5; ++i) {
      selectOrThrow(`#sp_target${i}`).addEventListener('click', () => this.setCameraTarget(i));
    }
    selectOrThrow('#sp_play').addEventListener('click', () => this.model.setState(State.PLAYING));
    selectOrThrow('#sp_pause').addEventListener('click', () => this.model.setState(State.PAUSED));
    selectOrThrow('#sp_stop').addEventListener('click', () => this.model.setState(State.STOPPED));

    document.body.addEventListener('keypress', (e) => this.onKeyPress(e));
    document.body.addEventListener('wheel', (e) => this.onMouseWheel(e));
    window.addEventListener('mousedown', (e) => this.onMouseDown(e));
    window.addEventListener('mousemove', (e) => this.onMouseMove(e));
    window.addEventListener('mouseup', () => this.onMouseUp());
  }

  onSettingsChange(): void {
    this.cameraTarget.setAttribute('select', 
        this.model.cameraYaw.getValue() == 0 && 
        this.model.cameraPitch.getValue() == 0 ? 
            `${this.model.cameraTarget.getValue()}` : '');
    this.exposure.update((v) => `${(Math.log2(v * 1000)).toPrecision(3)}`);
    this.bloom.update((v) => `${(v * 100).toFixed(0)}%`);
    this.highDefinition.update();
    this.highContrast.update();
    this.startRadius.update((v) => `${v.toPrecision(3)}`);
    this.startDirection.update((v) => `${(v * 180 / Math.PI).toFixed(1)}°`);
    this.startSpeed.update((v) => `${v.toPrecision(3)}`);
    this.orbitInclination.update((v) => `${(v * 180 / Math.PI).toFixed(1)}°`);
    this.lensing.update();
    this.doppler.update();
    this.grid.update();
    this.blackHoleMass.update((v) => `${v.toExponential(2)}`);
    this.discDensity.update((v) => `${v.toExponential(2)}`);
    this.discOpacity.update((v) => `${(v * 100).toFixed(1)}%`);
    this.discTemperature.update((v) => `${v.toFixed(0)}K`);
    this.rocketDistance.update((v) => `${v.toFixed(1)}m`);
    this.rocket.update();
    this.starsYaw.update((v) => `${(v * 180 / Math.PI).toFixed(1)}°`);
    this.starsPitch.update((v) => `${(v * 180 / Math.PI).toFixed(1)}°`);
    this.starsRoll.update((v) => `${(v * 180 / Math.PI).toFixed(1)}°`);
    this.stars.update();
  }

  onOrbitChange(): void {
    const playing = this.model.state == State.PLAYING;
    this.rootElement.classList.toggle('sp-playing', playing);

    const stopped = this.model.state == State.STOPPED;
    this.startRadius.enable(stopped);
    this.startDirection.enable(stopped);
    this.startSpeed.enable(stopped);
  }

  onKeyPress(event: KeyboardEvent): void {
    const key = event.key;
    if (key == '+') {
      this.exposure.setValue(this.exposure.getValue() * 1.1);
    } else if (key == '-') {
      this.exposure.setValue(this.exposure.getValue() / 1.1);
    } else if (key == 'p') {
      this.model.setState(this.model.state == State.PLAYING ? State.PAUSED : State.PLAYING); 
    } else if (key == 'd') {
      this.setCameraTarget(0);
    } else if (key == 'b') {
      this.setCameraTarget(1);
    } else if (key == 'l') {
      this.setCameraTarget(2);
    } else if (key == 'f') {
      this.setCameraTarget(3);
    } else if (key == 'r') {
      this.setCameraTarget(4);
    } else if (key == ' ') {
      this.toggleVisibility();
    }
  }

  onMouseWheel(event: WheelEvent): void {
    if (this.model.state == State.STOPPED) {
      if (event.deltaY > 0) {
        this.startRadius.setValue(this.startRadius.getValue() * 1.05);
      } else {
        this.startRadius.setValue(this.startRadius.getValue() / 1.05);
      }
    }
  }

  onMouseDown(event: MouseEvent): void {
    this.previousMouseX = event.screenX;
    this.previousMouseY = event.screenY;
    const target = event.target as HTMLElement;
    this.drag = (target.tagName != 'INPUT') && event.ctrlKey;
  }

  onMouseMove(event: MouseEvent): void {
    const kScale = 500;
    const mouseX = event.screenX;
    const mouseY = event.screenY;
    if (this.drag) {
      const prevX = this.previousMouseX ?? mouseX;
      const prevY = this.previousMouseY ?? mouseY;
      const x = (prevX - mouseX) / kScale;
      const y = (prevY - mouseY) / kScale;
      const qx = quaternionFromAxisAngle(0, 0, 1, -x);
      const qy = quaternionFromAxisAngle(0, 1, 0, y);
      let q = quaternionFromEulerAngles(this.model.starsYaw.getValue(), 
          this.model.starsPitch.getValue(), this.model.starsRoll.getValue());    
      q = quaternionProduct(q, qx);
      q = quaternionProduct(q, qy);
      const euler = quaternionToEulerAngles(q[0], q[1], q[2], q[3]);
      this.model.starsYaw.setValue(euler[0]);
      this.model.starsPitch.setValue(euler[1]);
      this.model.starsRoll.setValue(euler[2]);
    }
    this.previousMouseX = mouseX;
    this.previousMouseY = mouseY;
  }

  onMouseUp(): void {
    this.drag = false;
  }

  setCameraTarget(target: number): void {
    this.model.cameraTarget.setValue(target);
    this.model.cameraYaw.setValue(0);
    this.model.cameraPitch.setValue(0);
  }

  toggleVisibility(): void {
    this.rootElement.classList.toggle('sp-hidden');
  }
}
