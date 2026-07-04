import { Model, BooleanValue, QuantizedValue, ValueListener, State } from './model';

interface Param {
  read(searchParams: URLSearchParams): void;
  write(searchParams: URLSearchParams): void;
}

class BoolParam implements Param {
  private name: string;
  private model: BooleanValue;

  constructor(name: string, model: BooleanValue) {
    this.name = name;
    this.model = model;
  }
  read(searchParams: URLSearchParams): void {
    const value = searchParams.get(this.name);
    if (value === null) return;
    if (this.model.getDefaultValue()) {
      this.model.setValue(value != '0');
    } else {
      this.model.setValue(value == '1');
    }
  }
  write(searchParams: URLSearchParams): void {
    if (this.model.getValue() == this.model.getDefaultValue()) {
      searchParams.delete(this.name);
    } else {
      searchParams.set(this.name, this.model.getValue() ? '1' : '0');
    }
  }
}

class IntParam implements Param {
  private name: string;
  private model: QuantizedValue;

  constructor(name: string, model: QuantizedValue) {
    this.name = name;
    this.model = model;
  }
  read(searchParams: URLSearchParams): void {
    const valStr = searchParams.get(this.name);
    if (valStr === null) return;
    const index = parseInt(valStr);
    if (index >= 0) {
      this.model.setIndex(index);
    }
  }
  write(searchParams: URLSearchParams): void {
    if (this.model.getIndex() == this.model.getDefaultIndex()) {
      searchParams.delete(this.name);
    } else {
      searchParams.set(this.name, this.model.getIndex().toString());
    }
  }
}

export class UrlParams implements ValueListener {
  private model: Model;
  private params: Param[];
  private lastState: string | undefined;
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(model: Model) {
    this.model = model;
    this.params = [];
    this.params.push(new IntParam('ct', model.cameraTarget));
    this.params.push(new IntParam('cy', model.cameraYaw));
    this.params.push(new IntParam('cp', model.cameraPitch));
    this.params.push(new IntParam('ce', model.exposure));
    this.params.push(new IntParam('cb', model.bloom));
    this.params.push(new BoolParam('hd', model.highDefinition));
    this.params.push(new BoolParam('hc', model.highContrast));
    this.params.push(new IntParam('or', model.startRadius));
    this.params.push(new IntParam('od', model.startDirection));
    this.params.push(new IntParam('os', model.startSpeed));
    this.params.push(new IntParam('oi', model.orbitInclination));
    this.params.push(new BoolParam('pl', model.lensing));
    this.params.push(new BoolParam('pd', model.doppler));
    this.params.push(new BoolParam('sg', model.grid));
    this.params.push(new IntParam('bhm', model.blackHoleMass));
    this.params.push(new IntParam('dd', model.discDensity));
    this.params.push(new IntParam('do', model.discOpacity));
    this.params.push(new IntParam('dt', model.discTemperature));
    this.params.push(new IntParam('srd', model.rocketDistance));
    this.params.push(new BoolParam('sr', model.rocket));
    this.params.push(new IntParam('sfy', model.starsYaw));
    this.params.push(new IntParam('sfp', model.starsPitch));
    this.params.push(new IntParam('sfr', model.starsRoll));
    this.params.push(new BoolParam('sfe', model.stars));

    this.lastState = undefined;
    this.readUrlParams();
    this.model.addListener(this);
  }

  onSettingsChange(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    this.timeout = setTimeout(() => this.writeUrlParams(), 500);
  }

  onOrbitChange(): void {
    if (this.model.state == this.lastState) {
      return;
    }
    this.lastState = this.model.state;
    if (this.model.state != State.PLAYING) {
      this.writeUrlParams();
    }
  }

  readUrlParams(): void {
    const searchParams = new URLSearchParams(window.location.search);
    for (let param of this.params) {
      param.read(searchParams);
    }
    const rVal = searchParams.get('r');
    const drVal = searchParams.get('dr');
    const phiVal = searchParams.get('phi');
    if (rVal !== null && drVal !== null && phiVal !== null) {
      const r = parseFloat(rVal);
      const dr = parseFloat(drVal);
      const phi = parseFloat(phiVal);
      if (!isNaN(r) && !isNaN(dr) && !isNaN(phi) && r > 1) {
        this.model.r = r;
        this.model.drOverDtau = dr;
        this.model.phi = phi;
        this.model.state = State.PAUSED;
      }
    }
  }

  writeUrlParams(): void {
    const url = new URL(window.location.toString());
    const searchParams = new URLSearchParams(url.search);
    for (let param of this.params) {
      param.write(searchParams);
    }
    if (this.model.state == State.PAUSED) {
      searchParams.set('r', this.model.r.toString());
      searchParams.set('dr', this.model.drOverDtau.toString());
      searchParams.set('phi', this.model.phi.toString());
    } else {
      searchParams.delete('r');
      searchParams.delete('dr');
      searchParams.delete('phi');
    }
    url.search = searchParams.toString();
    window.history.replaceState(null, '', url.toString());
    this.timeout = null;
  }
}
