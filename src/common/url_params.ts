import { Model, BooleanValue, QuantizedValue, ValueListener, State } from './model';

/**
 * Interface representing a query parameter handler that can serialize/deserialize
 * a specific model property to/from URL search parameters.
 */
interface Param {
  /** Reads and applies the parameter from the current URLSearchParams to the model. */
  read(searchParams: URLSearchParams): void;
  /** Writes the parameter from the model to the URLSearchParams. */
  write(searchParams: URLSearchParams): void;
}

/**
 * Serializes and deserializes boolean settings to/from the URL.
 * Represented as '1' (true) or '0' (false).
 */
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
    // Map non-default query values to boolean settings.
    if (this.model.getDefaultValue()) {
      this.model.setValue(value != '0');
    } else {
      this.model.setValue(value == '1');
    }
  }

  write(searchParams: URLSearchParams): void {
    // To keep the URL clean, omit the parameter if it is set to its default value.
    if (this.model.getValue() == this.model.getDefaultValue()) {
      searchParams.delete(this.name);
    } else {
      searchParams.set(this.name, this.model.getValue() ? '1' : '0');
    }
  }
}

/**
 * Serializes and deserializes quantized (integer/indexed) settings to/from the URL.
 */
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
    // Keep the URL concise by omitting default indices.
    if (this.model.getIndex() == this.model.getDefaultIndex()) {
      searchParams.delete(this.name);
    } else {
      searchParams.set(this.name, this.model.getIndex().toString());
    }
  }
}

/**
 * UrlParams handles bidirectional synchronization between the application's Model state
 * and the URL query parameters. This allows users to share direct links to specific
 * simulation settings or custom orbital coordinates.
 */
export class UrlParams implements ValueListener {
  private model: Model;
  private params: Param[];
  private lastState: string | undefined;
  // Timeout handle for debouncing URL writes during rapid settings updates.
  private timeout: ReturnType<typeof setTimeout> | null = null;

  constructor(model: Model) {
    this.model = model;
    this.params = [];
    
    // Register mapping of URL parameter keys to Model properties.
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
    
    // Parse any parameters present in the initial URL.
    this.readUrlParams();
    // Start observing the model for subsequent modifications.
    this.model.addListener(this);
  }

  /**
   * Callback fired when UI settings are adjusted (e.g. exposure, bloom, mass).
   * Debounces history updates by 500ms to prevent browser lag.
   */
  onSettingsChange(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
    }
    this.timeout = setTimeout(() => this.writeUrlParams(), 500);
  }

  /**
   * Callback fired when the orbit state changes (e.g. going from PLAYING to PAUSED).
   * Used to write the orbital coordinates to the URL when paused or stopped.
   */
  onOrbitChange(): void {
    if (this.model.state == this.lastState) {
      return;
    }
    this.lastState = this.model.state;
    // We only write coordinates to URL when the orbit is not actively running (PLAYING),
    // because updating the URL history at 60fps would degrade browser performance.
    if (this.model.state != State.PLAYING) {
      this.writeUrlParams();
    }
  }

  /**
   * Parses parameters from the URL and applies them to the simulation.
   */
  readUrlParams(): void {
    const searchParams = new URLSearchParams(window.location.search);
    for (let param of this.params) {
      param.read(searchParams);
    }
    
    // Check for physical coordinate overrides in the URL parameters:
    // 'r': Radial coordinate (Schwarzschild radius r)
    // 'dr': dr/dtau (radial velocity relative to proper time tau)
    // 'phi': Angular coordinate (in orbit plane)
    const rVal = searchParams.get('r');
    const drVal = searchParams.get('dr');
    const phiVal = searchParams.get('phi');
    if (rVal !== null && drVal !== null && phiVal !== null) {
      const r = parseFloat(rVal);
      const dr = parseFloat(drVal);
      const phi = parseFloat(phiVal);
      // Validate coordinates: r must be outside the physical event horizon (r > 1 in our normalized units)
      if (!isNaN(r) && !isNaN(dr) && !isNaN(phi) && r > 1) {
        this.model.r = r;
        this.model.drOverDtau = dr;
        this.model.phi = phi;
        // Pause the simulation at these coordinates so the user can inspect the state.
        this.model.state = State.PAUSED;
      }
    }
  }

  /**
   * Serializes current model state to URL search parameters and updates browser history.
   */
  writeUrlParams(): void {
    const url = new URL(window.location.toString());
    const searchParams = new URLSearchParams(url.search);
    for (let param of this.params) {
      param.write(searchParams);
    }
    
    // If the orbit is paused, write precise physical coordinates to URL.
    if (this.model.state == State.PAUSED) {
      searchParams.set('r', this.model.r.toString());
      searchParams.set('dr', this.model.drOverDtau.toString());
      searchParams.set('phi', this.model.phi.toString());
    } else {
      // Clear physical coordinates if the simulation is playing or reset.
      searchParams.delete('r');
      searchParams.delete('dr');
      searchParams.delete('phi');
    }
    
    // Replace the browser address bar entry without reloading or polluting the history stack.
    url.search = searchParams.toString();
    window.history.replaceState(null, '', url.toString());
    this.timeout = null;
  }
}

