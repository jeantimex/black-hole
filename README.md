# Relativistic Black Hole Simulation (WebGL2 & WebGPU)

A real-time, interactive, physically accurate general relativistic ray tracer and spacecraft flight simulator around a Schwarzschild black hole, implemented in both WebGL2 and WebGPU with TypeScript.

https://github.com/user-attachments/assets/8e201151-1a04-48a5-b2a8-595f0314b98f

---

## 1. General Relativity & Schwarzschild Geometry

The simulation models the propagation of light rays (null geodesics) and the flight path of the spacecraft (timelike geodesics) in the curved space-time surrounding a non-rotating, spherically symmetric massive body.

### The Schwarzschild Metric
The geometry of space-time outside a static, uncharged black hole of mass $M$ is described by the Schwarzschild line element:

$$ds^2 = -\left(1 - \frac{2M}{r}\right) c^2 dt^2 + \left(1 - \frac{2M}{r}\right)^{-1} dr^2 + r^2 (d\theta^2 + \sin^2\theta \, d\phi^2)$$

In this system, we use normalized natural units where $G = c = 1$ and scale the Schwarzschild radius $R_s = 2M = 1$. This simplifies the metric line element coefficients:

$$1 - \frac{2M}{r} = 1 - \frac{1}{r} = 1 - u$$

where $u = 1/r$ is the inverse radial coordinate.

---

### Geodesics Equations of Motion
Particles and light rays follow trajectories that extremize proper time or arc length, satisfying the geodesic equation:

$$\frac{d^2 x^\mu}{d\lambda^2} + \Gamma^\mu_{\alpha\beta} \frac{dx^\alpha}{d\lambda} \frac{dx^\beta}{d\lambda} = 0$$

Using the spherical symmetries of Schwarzschild space-time, we identify two constants of motion associated with killing vectors:
1. **Specific Energy ($e$)**: Associated with time-translation invariance.
2. **Specific Angular Momentum ($l$)**: Associated with rotational invariance.

For an orbit restricted to the equatorial plane ($\theta = \pi/2$), these conservation laws translate to:

$$\frac{dt}{d\tau} = \frac{e}{1 - u}$$

$$\frac{d\phi}{d\tau} = \frac{l}{r^2} = l u^2$$

where $\tau$ is the proper time (for timelike orbits) or affine parameter (for null geodesics).

#### Timelike Geodesics (Spacecraft Flight)
For a massive object (the rocket), the four-velocity is normalized: $g_{\mu\nu} u^\mu u^\nu = -1$. This yields the radial equation of motion:

$$\left(\frac{dr}{d\tau}\right)^2 = e^2 - \left(1 - u\right)\left(1 + \frac{l^2}{r^2}\right)$$

Differentiating with respect to proper time $\tau$ gives the radial acceleration:

$$\frac{d^2 r}{d\tau^2} = \frac{u^2}{2} \left[ l^2 u (2 - 3u) - 1 \right]$$

The simulation numerically integrates this ODE system at 60Hz using sub-stepped Euler integration.

#### Null Geodesics (Raymarching Photons)
For massless particles (photons), $g_{\mu\nu} p^\mu p^\nu = 0$. The orbital equation becomes:

$$\left(\frac{dr}{d\phi}\right)^2 = \frac{r^4}{b^2} - r^2 (1 - u)$$

where $b = l/e$ is the **impact parameter** representing the perpendicular distance at which the photon would pass the black hole if space-time were flat.
- **Photon Sphere**: At $r = 1.5 \, R_s$ ($u = 2/3$), an unstable circular photon orbit exists.
- **Critical Impact Parameter**: Photons with $b < b_{crit} = \frac{3\sqrt{3}}{2} \approx 2.598$ are captured by the event horizon. Photons with $b > b_{crit}$ escape to infinity.

---

### Deflection and Travel Time Lookup Tables (LUTs)
To achieve real-time raymarching at 60fps on a pixel shader, integrating the null geodesic ODE for every screen pixel is too expensive. Instead, the simulation precomputes the physics of light bending into lookup tables (LUTs):

1. **`deflection.dat` ($512 \times 256$, `RG32F`)**: Maps a photon's energy $e^2$ and radial starting position $u$ to its cumulative angular deflection $\Delta\phi$ and coordinate travel time $\Delta t$.
2. **`inverse_radius.dat` ($512 \times 256$, `RG32F`)**: Maps deflection angle $\phi$ to the inverse radial coordinate $u$ and elapsed coordinate time $t$.

By sampling these textures, the shader resolves gravitational lensing and time-delay effects in a single $O(1)$ texture lookup.

---

### Relativistic Precession & Elliptic Integrals
Bound orbits around a black hole exhibit intense relativistic precession (the orbit does not close into an ellipse). The angular coordinates of the periapsis and apoapsis are evaluated using the complete elliptic integral of the first kind:

$$\Delta\theta = 2 \int_{u_1}^{u_2} \frac{du}{\sqrt{(u - u_1)(u_2 - u)(u_3 - u)}} = \frac{4 K(k^2)}{\sqrt{u_3 - u_1}}$$

where:
- $u_1, u_2$ are the turning points of the radial motion.
- $u_3 = 1 - u_1 - u_2$ is the third root of the cubic orbital geodesic equation.
- $k^2 = \frac{u_2 - u_1}{u_3 - u_1}$ is the elliptic modulus.

The precession ratio $\frac{d\theta}{d\phi} = \frac{\pi}{\Delta\theta}$ is calculated numerically inside `shader_manager.ts` using a $100,000$-step midpoint Riemann integration of $K(k^2)$ to model accretion disk rings.

---

### Relativistic Doppler Shift & Gravitational Redshift
Light emitted by the orbiting accretion disk is shifted in frequency due to two general relativistic effects:
1. **Gravitational Redshift**: Light losing energy climbing out of the gravity well:
   $$z_{grav} = \frac{1}{\sqrt{1 - u}} - 1$$
2. **Kinematic Doppler Shift**: Special relativistic time dilation and headlight effects from orbital velocity.

The combined frequency ratio (Doppler factor $D$) is:

$$D = \frac{\nu_{observed}}{\nu_{emitted}} = \frac{(u^\mu p_\mu)_{observer}}{(u^\mu p_\mu)_{emitter}}$$

To evaluate this, we define an orthonormal tetrad frame $e_a^\mu$ (local reference frame) for both the moving observer (spacecraft) and the emitting accretion disk. We project coordinate vectors into the observer's tetrad, apply a Lorentz Boost matrix for velocity $\beta$, and compute the shifted spectrum color mapping from the precomputed `doppler.dat` LUT.

---

### Shakura-Sunyaev Accretion Disk Model
The disk of matter spiraling into the black hole is procedurally modeled as a thin, viscous gas:
- **Inner Boundary**: Truncated at $r = 3.0 \, R_s$ ($u = 1/3$), which is the **Innermost Stable Circular Orbit (ISCO)** for a Schwarzschild black hole. Below this radius, matter falls rapidly without emitting light.
- **Thermal Emission**: Temperatures drop radially according to the Novikov-Thorne relativistic model:
  $$T(r) \propto r^{-3/4} \left(1 - \sqrt{\frac{3}{r}}\right)^{1/4}$$
- **Opacity**: Emitted intensity is modeled using Beer-Lambert absorption law $I = I_0 e^{-\alpha \cdot s}$ integrated along the bent ray path segments intersecting the disk.

---

## 2. Real-Time Computer Graphics & PBR

The spacecraft is rendered using physically based shading, dynamically reflecting the surrounding gravitationally-lensed sky.

### PBR & Cook-Torrance Microfacet BRDF
The spaceship material uses a metallic-roughness workflow, evaluating the Cook-Torrance specular microfacet BRDF model:

$$f_{\text{specular}} = \frac{D(h) \cdot F(v, h) \cdot V(l, v)}{4 \cdot (n \cdot l)(n \cdot v)}$$

1. **Microfacet Distribution Function ($D$) - Trowbridge-Reitz GGX**:
   $$D(n \cdot h) = \frac{\alpha^2}{\pi \left[ (n \cdot h)^2 (\alpha^2 - 1) + 1 \right]^2}$$
   where $\alpha = \text{roughness}^2$.
2. **Fresnel Term ($F$) - Schlick's Approximation**:
   $$F(v, h) = F_0 + (1 - F_0) (1 - (v \cdot h))^5$$
   where $F_0$ is the specular reflectance at normal incidence (0.04 for dielectrics, base color for metals).
3. **Visibility Factor ($V$) - Height-Correlated Smith**:
   $$V(l, v) = \frac{0.5}{\Lambda(l) + \Lambda(v)}$$
   $$\Lambda(x) = x \sqrt{x^2 (1 - \alpha^2) + \alpha^2}$$

---

### Image-Based Lighting (IBL) & Monte Carlo Importance Sampling
The spacecraft is illuminated by the surrounding lensed environment. To capture detailed specular highlights on glossy surfaces:
- **Rough Surfaces**: The shader integrates the environment map cube over a uniform hemisphere grid ($24$ samples) at high MIP levels.
- **Smooth Surfaces ($\alpha^2 < 0.0625$)**: To capture sharp reflections without noise, the shader performs Quasi-Monte Carlo importance sampling. It uses a **Van der Corput low-discrepancy sequence** to generate points mapped to half-vectors $h$ matching the GGX NDF:
  $$\cos\theta = \sqrt{ \frac{1 - u}{(1 - \alpha^2)u + 1} }$$
  The sample direction $l$ is obtained by reflecting view vector $v$ about $h$. The sample's MIP level is calculated dynamically using its solid angle matching the Probability Density Function (PDF) to avoid aliasing:
  $$\text{LOD} = -\frac{1}{2} \log_2(\text{PDF} \cdot N \cdot \Omega_{texel})$$

---

### Volumetric Exhaust Raymarching
The spacecraft engine plume is rendered by intersecting the view ray with a bounding cylinder:
- A 3D ray-cylinder quadratic equation is solved to find entry ($t_{min}$) and exit ($t_{max}$) distances:
  $$a t^2 + 2b t + c = 0$$
- The cylinder segment is clipped by the nozzle limits ($Z_{min} \le z \le Z_{max}$).
- Inside the plume, the shader integrates emission over 16 raymarching steps:
  $$I = \int_{t_{min}}^{t_{max}} e^{-k_r \cdot r^2 - k_z \cdot (Z_{max} - z)} dt$$
- To simulate flickering turbulence, the radial and longitudinal decay coefficients ($k_r$, $k_z$) are oscillated using noise waves.

---

### High-Dynamic Range (HDR) Bloom Pipeline
The light bloom effect mimics the physical scattering of high-intensity light in the lens:
1. **Downsampling (Binomial Tent Filter)**: A 9-level mipmap pyramid of the rendering is created. To prevent pixel flickering, a 4x4 binomial filter kernel is used:
   $$W_{2D} = \frac{1}{64} \begin{pmatrix} 1 & 3 & 3 & 1 \\ 3 & 9 & 9 & 3 \\ 3 & 9 & 9 & 3 \\ 1 & 3 & 3 & 1 \end{pmatrix}$$
2. **Bloom Filtering**: A 5x5 convolution blur is applied at each level using weights derived from human ocular scattering profiles.
3. **Upsampling (Bilinear Tent Filter)**: Mipmaps are combined back up the pyramid using additive blending.
4. **Tone Mapping**: The HDR color is converted to standard range using either **ACES Filmic** or **Exponential** tone mapping curves, followed by a $2.2$ gamma correction.

---

### Shared Exponent Star Textures (RGB9_E5)
To support high-dynamic-range star catalogs from the Gaia space telescope while saving video memory, starfield textures are packed in the **`RGB9_E5` shared-exponent format** (`gl.RGB9_E5` / `TextureFormat::Rgb9e5Ufloat`). This format packs three 9-bit mantissas and a single 5-bit exponent into one 32-bit float, providing HDR precision with a 75% memory saving compared to raw floats.

---

## 3. URL Parameters & Keyboard Shortcuts

The simulation state can be customized via URL query parameters, allowing you to share direct links to specific configurations.

### URL Query Parameters

| Parameter | Type | Description |
| :--- | :--- | :--- |
| `hide_menu` | Boolean | Hides the left settings control panel initially (e.g. `?hide_menu=1` or `?hide_menu`). |
| `hide_orbit` | Boolean | Hides the top-right relativistic orbit panel initially (e.g. `?hide_orbit=1` or `?hide_orbit`). |
| `ct` | Integer | Initial camera target (0: Accretion Disk, 1: Black Hole, 2: Lensed Orbit, 3: Front Orbit, 4: Rocket). |
| `cy` | Integer | Initial camera yaw angle. |
| `cp` | Integer | Initial camera pitch angle. |
| `ce` | Integer | Photographic exposure value index. |
| `cb` | Integer | Bloom percentage slider index. |
| `hd` | Boolean | Toggle high definition render mode (`1` for enabled, `0` for disabled). |
| `hc` | Boolean | Toggle high contrast render mode (`1` for enabled, `0` for disabled). |
| `or` | Integer | Initial orbit distance (radial coordinate). |
| `od` | Integer | Initial orbit direction angle. |
| `os` | Integer | Initial orbit launch speed. |
| `oi` | Integer | Orbit plane inclination angle. |
| `pl` | Boolean | Toggle gravitational lensing (`1` for enabled, `0` for disabled). |
| `pd` | Boolean | Toggle Doppler shift / Gravitational redshift effect (`1` for enabled, `0` for disabled). |
| `sg` | Boolean | Toggle reference coordinate grid (`1` for enabled, `0` for disabled). |
| `bhm` | Integer | Black hole mass index. |
| `dd` | Integer | Accretion disk density index. |
| `do` | Integer | Accretion disk opacity index. |
| `dt` | Integer | Accretion disk temperature index. |
| `srd` | Integer | Rocket coordinate distance. |
| `sr` | Boolean | Toggle rocket mesh rendering (`1` for enabled, `0` for disabled). |
| `sfy` | Integer | Stars skybox yaw rotation. |
| `sfp` | Integer | Stars skybox pitch rotation. |
| `sfr` | Integer | Stars skybox roll rotation. |
| `sfe` | Boolean | Toggle stars skybox (`1` for enabled, `0` for disabled). |

### Keyboard Shortcuts

- **`Space`**: Toggle visibility of all user interface panels (settings menu, orbit panel, and loading text).
- **`P`**: Toggle play / pause state of the spacecraft orbital path simulation.
- **`+` / `-`**: Adjust camera exposure brightness.
- **`D`**: Lock camera target to the accretion disk.
- **`B`**: Lock camera target to the black hole event horizon.
- **`L`**: Lock camera target to lensed view.
- **`F`**: Lock camera target to front/relative view.
- **`R`**: Lock camera target to the spacecraft cockpit view.

---

## 4. Credits & Acknowledgements

This simulation is based on the general relativity physics modeling, precomputed lookup table structures, and Gaia star catalog pagination techniques originally developed and published by **[Eric Bruneton](https://github.com/ebruneton/black_hole_shader)**. Special thanks to the original author for making their research on relativistic graphics open and accessible.
