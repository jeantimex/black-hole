import './style.css'

function requireElement<T extends Element>(selector: string) {
  const element = document.querySelector<T>(selector)

  if (!element) {
    throw new Error(`Missing required element: ${selector}`)
  }

  return element
}

const canvas = requireElement<HTMLCanvasElement>('#camera_view')
const errorPanel = requireElement<HTMLDivElement>('#cv_error_panel')
const loadingPanel = requireElement<HTMLDivElement>('#cv_loading_panel')
const settingsPanel = requireElement<HTMLFormElement>('#settings_panel')
const orbitPanel = requireElement<HTMLDivElement>('#orbit_panel')
const orbitCanvas = requireElement<HTMLCanvasElement>('#orbit_canvas')

function showError(message: string) {
  errorPanel.textContent = message
  errorPanel.classList.remove('cv-hidden')
  loadingPanel.classList.add('cv-loaded')
}

function setUiVisible(visible: boolean) {
  settingsPanel.classList.toggle('sp-hidden', !visible)
  orbitPanel.classList.toggle('op-hidden', !visible)
}

function drawOrbitPanel() {
  const context = orbitCanvas.getContext('2d')

  if (!context) {
    return
  }

  const center = orbitCanvas.width / 2
  context.clearRect(0, 0, orbitCanvas.width, orbitCanvas.height)
  context.strokeStyle = 'rgba(255, 255, 255, 0.45)'
  context.lineWidth = 1

  for (const radius of [48, 96, 144, 192]) {
    context.beginPath()
    context.arc(center, center, radius, 0, Math.PI * 2)
    context.stroke()
  }

  context.fillStyle = '#000'
  context.beginPath()
  context.arc(center, center, 24, 0, Math.PI * 2)
  context.fill()
}

document.addEventListener('keydown', (event) => {
  if (event.code === 'Space' && event.target === document.body) {
    event.preventDefault()
    setUiVisible(settingsPanel.classList.contains('sp-hidden'))
  }
})

drawOrbitPanel()

const shader = /* wgsl */ `
@group(0) @binding(0) var textSampler: sampler;
@group(0) @binding(1) var textTexture: texture_2d<f32>;

struct VertexOutput {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
}

@vertex
fn vertexMain(@builtin(vertex_index) vertexIndex: u32) -> VertexOutput {
  var positions = array<vec2f, 6>(
    vec2f(-1.0, -1.0),
    vec2f(1.0, -1.0),
    vec2f(-1.0, 1.0),
    vec2f(-1.0, 1.0),
    vec2f(1.0, -1.0),
    vec2f(1.0, 1.0)
  );

  var uvs = array<vec2f, 6>(
    vec2f(0.0, 1.0),
    vec2f(1.0, 1.0),
    vec2f(0.0, 0.0),
    vec2f(0.0, 0.0),
    vec2f(1.0, 1.0),
    vec2f(1.0, 0.0)
  );

  var output: VertexOutput;
  output.position = vec4f(positions[vertexIndex], 0.0, 1.0);
  output.uv = uvs[vertexIndex];
  return output;
}

@fragment
fn fragmentMain(input: VertexOutput) -> @location(0) vec4f {
  return textureSample(textTexture, textSampler, input.uv);
}
`

function drawTextTexture(width: number, height: number) {
  const textCanvas = document.createElement('canvas')
  textCanvas.width = width
  textCanvas.height = height

  const context = textCanvas.getContext('2d')

  if (!context) {
    throw new Error('Could not create text canvas context.')
  }

  context.fillStyle = '#050508'
  context.fillRect(0, 0, width, height)

  context.fillStyle = '#f7f1e8'
  context.textAlign = 'center'
  context.textBaseline = 'middle'
  context.font = `${Math.max(24, Math.floor(width / 14))}px monospace`
  context.fillText('hellow blackhole', width / 2, height / 2)

  return textCanvas
}

async function start() {
  if (!navigator.gpu) {
    showError('WebGPU is not available. Use a current Chromium-based browser with WebGPU enabled.')
    canvas.hidden = true
    return
  }

  const adapter = await navigator.gpu.requestAdapter()
  const device = adapter ? await adapter.requestDevice() : null

  if (!device) {
    showError('Could not request a WebGPU device.')
    canvas.hidden = true
    return
  }

  const context = canvas.getContext('webgpu')

  if (!context) {
    showError('Could not create a WebGPU canvas context.')
    canvas.hidden = true
    return
  }

  loadingPanel.classList.add('cv-loaded')

  const gpuDevice = device
  const gpuContext = context
  const format = navigator.gpu.getPreferredCanvasFormat()

  gpuContext.configure({
    device: gpuDevice,
    format,
    alphaMode: 'opaque',
  })

  const shaderModule = gpuDevice.createShaderModule({ code: shader })
  const sampler = gpuDevice.createSampler({
    magFilter: 'linear',
    minFilter: 'linear',
  })

  const pipeline = gpuDevice.createRenderPipeline({
    layout: 'auto',
    vertex: {
      module: shaderModule,
      entryPoint: 'vertexMain',
    },
    fragment: {
      module: shaderModule,
      entryPoint: 'fragmentMain',
      targets: [{ format }],
    },
    primitive: {
      topology: 'triangle-list',
    },
  })

  let texture: GPUTexture | null = null
  let bindGroup: GPUBindGroup | null = null

  function resize() {
    const pixelRatio = Math.min(window.devicePixelRatio, 2)
    const width = Math.max(1, Math.floor(canvas.clientWidth * pixelRatio))
    const height = Math.max(1, Math.floor(canvas.clientHeight * pixelRatio))

    if (canvas.width === width && canvas.height === height) {
      return
    }

    canvas.width = width
    canvas.height = height
    texture?.destroy()

    texture = gpuDevice.createTexture({
      size: [width, height],
      format: 'rgba8unorm',
      usage:
        GPUTextureUsage.TEXTURE_BINDING |
        GPUTextureUsage.COPY_DST |
        GPUTextureUsage.RENDER_ATTACHMENT,
    })

    gpuDevice.queue.copyExternalImageToTexture(
      { source: drawTextTexture(width, height) },
      { texture },
      [width, height],
    )

    bindGroup = gpuDevice.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        {
          binding: 0,
          resource: sampler,
        },
        {
          binding: 1,
          resource: texture.createView(),
        },
      ],
    })
  }

  function render() {
    resize()

    if (!bindGroup) {
      requestAnimationFrame(render)
      return
    }

    const encoder = gpuDevice.createCommandEncoder()
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: gpuContext.getCurrentTexture().createView(),
          clearValue: { r: 0.02, g: 0.02, b: 0.03, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    })

    pass.setPipeline(pipeline)
    pass.setBindGroup(0, bindGroup)
    pass.draw(6)
    pass.end()

    gpuDevice.queue.submit([encoder.finish()])
    requestAnimationFrame(render)
  }

  requestAnimationFrame(render)
}

start().catch((error: unknown) => {
  console.error(error)
  showError(error instanceof Error ? error.message : 'Unexpected WebGPU startup error.')
  canvas.hidden = true
})
