export function createGpuRuntime(deps) {
  const { els } = deps;

  const gpu = {
    supported: !!navigator.gpu,
    ready: false,
    device: null,
    context: null,
    format: null,
    computePipeline: null,
    renderPipeline: null,
    samplerNearest: null,
    uniformBuf: null,
    uniformArr: null,
    inBuf: null,
    inBufBytes: 0,
    outTex: null,
    outTexW: 0,
    outTexH: 0,
    outView: null,
    computeBindGroup: null,
    renderBindGroup: null,
    lastError: null
  };

  async function ensureReady() {
    if (!gpu.supported) return false;
    if (gpu.ready) return true;
    try {
      const adapter = await navigator.gpu.requestAdapter();
      if (!adapter) throw new Error("No WebGPU adapter available");
      const device = await adapter.requestDevice();
      const context = els.gpuCanvas.getContext("webgpu");
      if (!context) throw new Error("WebGPU context not available");

      const format = navigator.gpu.getPreferredCanvasFormat();
      gpu.device = device;
      gpu.context = context;
      gpu.format = format;

      const wgsl = {
        compute: `
struct Params {
  width: u32,
  height: u32,
  _pad0: u32,
  _pad1: u32,
  minVal: f32,
  maxVal: f32,
  gamma: f32,
  gain: f32,
  contrast: f32,
  _pad2: f32,
  _pad3: f32,
  _pad4: f32,
};
@group(0) @binding(0) var<storage, read> inData: array<f32>;
@group(0) @binding(1) var outTex: texture_storage_2d<rgba8unorm, write>;
@group(0) @binding(2) var<uniform> params: Params;
fn tone(v: f32) -> f32 {
  let denom = max(1e-12, params.maxVal - params.minVal);
  var t = (v - params.minVal) / denom;
  if (!(t == t)) { t = 0.0; }
  t = clamp(t, 0.0, 1.0);
  t = pow(t, params.gamma);
  t = (t - 0.5) * params.contrast + 0.5;
  t = t * params.gain;
  return clamp(t, 0.0, 1.0);
}
@compute @workgroup_size(16,16)
fn main(@builtin(global_invocation_id) gid: vec3<u32>) {
  let x = gid.x;
  let y = gid.y;
  if (x >= params.width || y >= params.height) { return; }
  let idx = y * params.width + x;
  let v = inData[idx];
  let t = tone(v);
  textureStore(outTex, vec2<i32>(i32(x), i32(y)), vec4<f32>(t, t, t, 1.0));
}
`,
        render: `
struct VSOut {
  @builtin(position) pos: vec4<f32>,
  @location(0) uv: vec2<f32>,
};
@vertex
fn vs(@builtin(vertex_index) vi: u32) -> VSOut {
  var positions = array<vec2<f32>, 6>(
    vec2<f32>(-1.0, -1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>(-1.0,  1.0),
    vec2<f32>( 1.0, -1.0),
    vec2<f32>( 1.0,  1.0)
  );
  var uvs = array<vec2<f32>, 6>(
    vec2<f32>(0.0, 1.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(1.0, 1.0),
    vec2<f32>(1.0, 0.0)
  );
  var o: VSOut;
  o.pos = vec4<f32>(positions[vi], 0.0, 1.0);
  o.uv = uvs[vi];
  return o;
}
@group(0) @binding(0) var samp: sampler;
@group(0) @binding(1) var tex: texture_2d<f32>;
@fragment
fn fs(in: VSOut) -> @location(0) vec4<f32> {
  return textureSample(tex, samp, in.uv);
}
`
      };

      gpu.computePipeline = device.createComputePipeline({
        layout: "auto",
        compute: { module: device.createShaderModule({ code: wgsl.compute }), entryPoint: "main" }
      });
      gpu.renderPipeline = device.createRenderPipeline({
        layout: "auto",
        vertex: { module: device.createShaderModule({ code: wgsl.render }), entryPoint: "vs" },
        fragment: { module: device.createShaderModule({ code: wgsl.render }), entryPoint: "fs", targets: [{ format }] },
        primitive: { topology: "triangle-list" }
      });
      gpu.samplerNearest = device.createSampler({ magFilter: "nearest", minFilter: "nearest" });
      gpu.uniformBuf = device.createBuffer({ size: 64, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
      gpu.uniformArr = new ArrayBuffer(64);
      gpu.ready = true;
      gpu.lastError = null;
      return true;
    } catch (e) {
      gpu.lastError = e;
      console.warn("WebGPU init failed:", e);
      return false;
    }
  }

  function configureCanvasIfNeeded() {
    if (!gpu.ready) return;
    const dpr = window.devicePixelRatio || 1;
    const rect = els.main.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (els.gpuCanvas.width !== w || els.gpuCanvas.height !== h) {
      els.gpuCanvas.width = w;
      els.gpuCanvas.height = h;
      gpu.context.configure({ device: gpu.device, format: gpu.format, alphaMode: "opaque" });
    }
  }

  function ensureInBuffer(bytes) {
    if (!gpu.ready) return;
    if (gpu.inBuf && gpu.inBufBytes >= bytes) return;
    gpu.inBufBytes = bytes;
    gpu.inBuf = gpu.device.createBuffer({ size: bytes, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }

  function ensureOutTexture(w, h) {
    if (!gpu.ready) return;
    if (gpu.outTex && gpu.outTexW === w && gpu.outTexH === h) return;
    gpu.outTexW = w;
    gpu.outTexH = h;
    gpu.outTex = gpu.device.createTexture({
      size: { width: w, height: h },
      format: "rgba8unorm",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC
    });
    gpu.outView = gpu.outTex.createView();
    gpu.computeBindGroup = gpu.device.createBindGroup({
      layout: gpu.computePipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: gpu.inBuf } },
        { binding: 1, resource: gpu.outView },
        { binding: 2, resource: { buffer: gpu.uniformBuf } }
      ]
    });
    gpu.renderBindGroup = gpu.device.createBindGroup({
      layout: gpu.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: gpu.samplerNearest },
        { binding: 1, resource: gpu.outView }
      ]
    });
  }

  function writeUniforms(width, height, params) {
    const dv = new DataView(gpu.uniformArr);
    dv.setUint32(0, width, true);
    dv.setUint32(4, height, true);
    dv.setUint32(8, 0, true);
    dv.setUint32(12, 0, true);
    dv.setFloat32(16, params.minVal, true);
    dv.setFloat32(20, params.maxVal, true);
    dv.setFloat32(24, params.gamma, true);
    dv.setFloat32(28, params.gain, true);
    dv.setFloat32(32, params.contrast, true);
    gpu.device.queue.writeBuffer(gpu.uniformBuf, 0, gpu.uniformArr);
  }

  function renderGray(rasterF32, w, h, params) {
    if (!gpu.ready) return false;
    configureCanvasIfNeeded();
    ensureInBuffer(rasterF32.byteLength);
    ensureOutTexture(w, h);
    gpu.device.queue.writeBuffer(gpu.inBuf, 0, rasterF32.buffer, rasterF32.byteOffset, rasterF32.byteLength);
    writeUniforms(w, h, params);

    const encoder = gpu.device.createCommandEncoder();
    {
      const pass = encoder.beginComputePass();
      pass.setPipeline(gpu.computePipeline);
      pass.setBindGroup(0, gpu.computeBindGroup);
      pass.dispatchWorkgroups(Math.ceil(w / 16), Math.ceil(h / 16));
      pass.end();
    }
    {
      const colorView = gpu.context.getCurrentTexture().createView();
      const pass = encoder.beginRenderPass({
        colorAttachments: [{
          view: colorView,
          loadOp: "clear",
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: "store"
        }]
      });
      pass.setPipeline(gpu.renderPipeline);
      pass.setBindGroup(0, gpu.renderBindGroup);
      pass.draw(6, 1, 0, 0);
      pass.end();
    }
    gpu.device.queue.submit([encoder.finish()]);
    return true;
  }

  return {
    supported: gpu.supported,
    ensureReady,
    renderGray
  };
}
