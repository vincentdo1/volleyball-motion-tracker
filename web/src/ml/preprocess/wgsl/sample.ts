/**
 * WGSL port of `../cpu.ts`: the same bilinear sampler over the display frame, reading the decoder's `VideoFrame`
 * through an external texture (no copy, no colour-space round trip on our side). Each tap is an explicit `textureLoad`
 * and the weights are computed in the shader, so a black border and the pixel-centre conventions are exactly the CPU
 * ones (a hardware filtering sampler would use reduced-precision weights and could not do a black border).
 *
 * Bindings: 0 = frame, 1 = float32 destination, 2 = `Params`, 3 = one `vec4(ax, bx, ay, by)` sampling map per batch
 * item (workgroup z). Entry points: `chw` writes `3 * outW * outH` normalised RGB floats per item; `gray` writes one
 * luma / 255 plane. The destination is f32 only: every shipped model has float32 inputs.
 */
export const SAMPLE_WGSL = /* wgsl */ `
struct Params {
  // outW, outH, border (0 replicate, 1 zero), unused
  size: vec4<u32>,
  // outOffset (first element written), planeStride (elements between batch items), unused, unused
  placement: vec4<u32>,
  // coded x = orientX.x * xd + orientX.y * yd + orientX.z (and likewise y)
  orientX: vec4<f32>,
  orientY: vec4<f32>,
  mean: vec4<f32>,
  invStd: vec4<f32>,
}

@group(0) @binding(0) var src: texture_external;
@group(0) @binding(1) var<storage, read_write> dst: array<f32>;
@group(0) @binding(2) var<uniform> p: Params;
@group(0) @binding(3) var<storage, read> maps: array<vec4<f32>>;

// Raw colour (0..255) of coded pixel (x, y); outside the frame it is the nearest edge pixel or black.
fn texel(x: i32, y: i32) -> vec3<f32> {
  let dims = vec2<i32>(textureDimensions(src));
  if (p.size.z == 1u && (x < 0 || y < 0 || x >= dims.x || y >= dims.y)) {
    return vec3<f32>(0.0);
  }
  let c = clamp(vec2<i32>(x, y), vec2<i32>(0), dims - vec2<i32>(1));
  return textureLoad(src, c).rgb * 255.0;
}

fn sampleRaw(item: u32, u: u32, v: u32) -> vec3<f32> {
  let m = maps[item];
  let xd = m.x * f32(u) + m.y;
  let yd = m.z * f32(v) + m.w;
  let sx = p.orientX.x * xd + p.orientX.y * yd + p.orientX.z;
  let sy = p.orientY.x * xd + p.orientY.y * yd + p.orientY.z;
  let x0 = floor(sx);
  let y0 = floor(sy);
  let fx = sx - x0;
  let fy = sy - y0;
  let ix = i32(x0);
  let iy = i32(y0);
  return texel(ix, iy) * ((1.0 - fx) * (1.0 - fy))
    + texel(ix + 1, iy) * (fx * (1.0 - fy))
    + texel(ix, iy + 1) * ((1.0 - fx) * fy)
    + texel(ix + 1, iy + 1) * (fx * fy);
}

@compute @workgroup_size(8, 8, 1)
fn chw(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.size.x || g.y >= p.size.y) { return; }
  let rgb = (sampleRaw(g.z, g.x, g.y) - p.mean.xyz) * p.invStd.xyz;
  let plane = p.size.x * p.size.y;
  let base = p.placement.x + g.z * p.placement.y + g.y * p.size.x + g.x;
  dst[base] = rgb.x;
  dst[base + plane] = rgb.y;
  dst[base + 2u * plane] = rgb.z;
}

@compute @workgroup_size(8, 8, 1)
fn gray(@builtin(global_invocation_id) g: vec3<u32>) {
  if (g.x >= p.size.x || g.y >= p.size.y) { return; }
  let rgb = sampleRaw(g.z, g.x, g.y);
  dst[p.placement.x + g.z * p.placement.y + g.y * p.size.x + g.x] = dot(rgb, vec3<f32>(0.299, 0.587, 0.114)) / 255.0;
}
`;
