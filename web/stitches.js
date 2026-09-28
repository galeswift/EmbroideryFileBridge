// Stitch-level design preview for the viewer.
//
// The server sends every stitch (see encode_stitches in embroidery-web.py).
// With WebGL2 every stitch becomes a real 3D strand of thread:
//
//   stacking  (once per design) the stitches are laid down in sewing order
//             on a height grid: each rests, taut, on the highest thing
//             beneath its middle, its edges ride over older strands they
//             overlap, and it is pulled down into the fabric at its two
//             needle holes, so underlay, layers and satin pile up the way
//             the machine builds them;
//   surface   each stitch is a flattened cylinder bent along that path,
//             pinched where it enters the needle holes (one small mesh,
//             drawn once per stitch by the GPU, in sewing order: where
//             stitches overlap, the later one is on top), rendered into
//             buffers of color, normal, height and fiber direction;
//   light     physically based, per pixel: anisotropic GGX specular (rough
//             across the fibers, smooth along them) with Fresnel, a cloth
//             sheen, a key light, fill light and sky, ambient occlusion and
//             shadows from the rendered heights, and ACES tone mapping.
//
// Without WebGL2 it falls back to thread-width lines on a 2D canvas.
"use strict";

(() => {
  const RX = 0.25;              // mm: half the width thread spreads to
  const RZ = 0.11;              // mm: half its thickness, flattened by tension
  const RAMP = 0.45;            // mm over which it climbs out of a needle hole
  const HOLE_DIP = RZ * 1.4;    // mm a stitch sinks at its needle holes, at most
  const MAX_STACK = 0.55;       // mm: how high layers of stitching can pile up
  const NEIGHBORS = 3;          // stitches just before this one lie beside it, not under it
  const TWIST_PERIOD = 0.5;     // mm per turn of the thread's twist
  const MAX_PX_PER_MM = 90;     // how far in you can zoom
  const FIT_MARGIN = 1.12;

  // ------------------------------------------------------------ data

  function hexToRgb(hex) {
    const n = parseInt(hex.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  // Parse the server's "EBS1" stitch data into draw-ready arrays.
  function parse(buffer) {
    const bytes = new Uint8Array(buffer);
    if (String.fromCharCode(...bytes.subarray(0, 4)) !== "EBS1") throw new Error("Not stitch data");
    const headerLength = new DataView(buffer).getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(bytes.subarray(8, 8 + headerLength)));
    const start = 8 + headerLength;
    const raw = new Int16Array(buffer, start, (buffer.byteLength - start) >> 1);

    const points = new Float32Array(raw.length);
    for (let i = 0; i < raw.length; i++) points[i] = raw[i] / 10;  // 0.1 mm -> mm

    const colors = header.colors.map(hexToRgb);
    const runs = [];
    let segmentCount = 0;
    let offset = 0;
    for (const [color, count] of header.runs) {
      runs.push({ color, start: offset, count });
      offset += count;
      segmentCount += count > 1 ? count - 1 : 1;  // a lone stitch is drawn as a dot
    }

    // Per segment, in sewing order: x0, y0, x1, y1, seed; and its color as RGBA bytes.
    const segments = new Float32Array(segmentCount * 5);
    const segmentColors = new Uint8Array(segmentCount * 4);
    let seed = 12345;
    let s = 0;
    const add = (a, b, color) => {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      segments.set([points[a], points[a + 1], points[b], points[b + 1], seed / 0x7fffffff], s * 5);
      segmentColors.set([...colors[color], 255], s * 4);
      s++;
    };
    for (const run of runs) {
      if (run.count === 1) add(run.start * 2, run.start * 2, run.color);
      for (let i = 1; i < run.count; i++) add((run.start + i - 1) * 2, (run.start + i) * 2, run.color);
    }
    return {
      width: Math.max(header.width_mm, 1),
      height: Math.max(header.height_mm, 1),
      colors: header.colors,
      runs, points, segments, segmentColors, segmentCount,
    };
  }

  const smoothstep = (a, b, x) => {
    const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };

  // Lay the stitches down in sewing order. Returns, per stitch (STRIDE
  // floats): x0 y0 x1 y1, then z0 z1 zTop (its center line at each needle
  // hole and across its middle) and a random seed, then how far its left
  // and right edges ride up over older thread they overlap.
  const STRIDE = 10;

  function stack(design) {
    const n = design.segmentCount;
    const margin = 1.5;
    const cell = Math.max(0.08, Math.max(design.width, design.height) / 2500);
    const gw = Math.ceil((design.width + 2 * margin) / cell) + 1;
    const gh = Math.ceil((design.height + 2 * margin) / cell) + 1;
    // Two surfaces: each strand's middle (what later stitches rest on) and
    // its full width (what later stitches' edges ride over). Each cell
    // remembers the stitch that set it.
    const core = new Float32Array(gw * gh);
    const full = new Float32Array(gw * gh);
    const coreOwner = new Int32Array(gw * gh).fill(-1e6);
    const fullOwner = new Int32Array(gw * gh).fill(-1e6);
    const cellOf = (v, size) => Math.min(size - 1, Math.max(0, Math.round((v + margin) / cell)));
    const index = (x, y) => cellOf(y, gh) * gw + cellOf(x, gw);
    const out = new Float32Array(n * STRIDE);
    const seg = design.segments;
    const edge = RX * 0.85;
    let maxZ = RZ * 2;

    for (let i = 0; i < n; i++) {
      const x0 = seg[i * 5], y0 = seg[i * 5 + 1], seed = seg[i * 5 + 4];
      let x1 = seg[i * 5 + 2], y1 = seg[i * 5 + 3];
      let L = Math.hypot(x1 - x0, y1 - y0);
      if (L < 0.05) { x1 = x0 + 0.15; L = 0.15; }  // a lone tack
      const dx = (x1 - x0) / L, dy = (y1 - y0) / L;
      const nx = -dy, ny = dx;  // toward its left edge
      const mid = L / 2;
      const ramp = Math.min(RAMP, mid);
      // Stitches sewn just before this one share its needle hole and lie
      // beside it (satin zigzags back and forth over almost the same
      // line): they neither lift it nor tuck under its edges.
      const older = (owner, g) => owner[g] < i - NEIGHBORS;

      // A taut thread rests on the highest thing beneath its middle, and
      // its edges ride over the older strands they overlap.
      const keep = Math.min(0.3, mid * 0.6);
      const steps = Math.max(2, Math.ceil(L / cell));
      let under = 0, left = 0, right = 0;
      for (let k = 0; k <= steps; k++) {
        const s = (k / steps) * L;
        if (s < keep || L - s < keep) continue;
        const px = x0 + dx * s, py = y0 + dy * s;
        let g = index(px, py);
        if (older(coreOwner, g)) under = Math.max(under, core[g]);
        g = index(px + nx * edge, py + ny * edge);
        if (older(fullOwner, g)) left = Math.max(left, full[g]);
        g = index(px - nx * edge, py - ny * edge);
        if (older(fullOwner, g)) right = Math.max(right, full[g]);
      }
      // Layers compress under the ones above, so stacks level off.
      const zTop = RZ + MAX_STACK * (1 - Math.exp(-under / MAX_STACK));
      // It dips into its needle holes, but only so far below its top.
      const z0 = Math.max(core[index(x0, y0)] - RZ * 0.5, zTop - HOLE_DIP, -RZ * 0.4);
      const z1 = Math.max(core[index(x1, y1)] - RZ * 0.5, zTop - HOLE_DIP, -RZ * 0.4);
      const liftL = Math.min(2 * RZ, Math.max(0, left - zTop + 0.03));
      const liftR = Math.min(2 * RZ, Math.max(0, right - zTop + 0.03));
      out.set([x0, y0, x1, y1, z0, z1, zTop, seed, liftL, liftR], i * STRIDE);
      maxZ = Math.max(maxZ, zTop + RZ + Math.max(liftL, liftR));

      // Record its surface for the stitches that come after.
      const cx0 = cellOf(Math.min(x0, x1) - RX, gw), cx1 = cellOf(Math.max(x0, x1) + RX, gw);
      const cy0 = cellOf(Math.min(y0, y1) - RX, gh), cy1 = cellOf(Math.max(y0, y1) + RX, gh);
      for (let cy = cy0; cy <= cy1; cy++) {
        const py = cy * cell - margin;
        for (let cx = cx0; cx <= cx1; cx++) {
          const px = cx * cell - margin;
          const s = Math.min(L, Math.max(0, (px - x0) * dx + (py - y0) * dy));
          const qx = px - x0 - dx * s, qy = py - y0 - dy * s;
          const d = Math.hypot(qx, qy) / RX;
          if (d > 1) continue;
          const rise = smoothstep(0, ramp, Math.min(s, L - s));
          const zEnd = s < mid ? z0 : z1;
          const zc = zEnd + (zTop - zEnd) * rise;
          const lift = qx * nx + qy * ny >= 0 ? liftL : liftR;
          const g = cy * gw + cx;
          const top = zc + RZ * Math.sqrt(1 - d * d) + lift * rise * Math.pow(d, 1.5);
          if (top > full[g]) { full[g] = top; fullOwner[g] = i; }
          if (d <= 0.5 && zc + RZ > core[g]) { core[g] = zc + RZ; coreOwner[g] = i; }
        }
      }
    }
    return { instances: out, stride: STRIDE, maxZ };
  }

  // ------------------------------------------------------------ shaders

  // Pass 1 (surface): every strand, in sewing order, into three buffers.
  const TUBE_VS = `#version 300 es
  in vec3 a_vert;     // mesh: which end (0 start, 0.5 middle, 1 end), mm from it, angle around
  in vec4 a_seg;      // x0 y0 x1 y1
  in vec4 a_z;        // z0 z1 zTop seed
  in vec4 a_color;
  in vec2 a_lift;     // left and right edges riding over older thread
  uniform mat4 u_view;
  uniform float u_rx;
  uniform float u_rz;
  uniform float u_ramp;
  out vec3 v_normal;
  out vec3 v_tangent;
  out vec3 v_color;
  out float v_seed;
  out float v_across;
  out float v_along;
  out float v_rise;
  out float v_height;

  float riseAt(float s, float len) { return smoothstep(0.0, min(u_ramp, 0.5 * len), min(s, len - s)); }
  float centerZ(float s, float len) {
    return mix(s < 0.5 * len ? a_z.x : a_z.y, a_z.z, riseAt(s, len));
  }

  void main() {
    vec2 d = a_seg.zw - a_seg.xy;
    float len = max(length(d), 1e-3);
    vec2 t = d / len;
    vec2 n = vec2(-t.y, t.x);
    float mid = 0.5 * len;
    float s = a_vert.x < 0.25 ? min(a_vert.y, mid) : (a_vert.x > 0.75 ? len - min(a_vert.y, mid) : mid);
    float rise = riseAt(s, len);

    // Direction of the center line, including its climb out of the holes.
    float sa = max(s - 0.03, 0.0), sb = min(s + 0.03, len);
    float dz = (centerZ(sb, len) - centerZ(sa, len)) / max(sb - sa, 1e-4);
    vec3 T = normalize(vec3(t, dz));
    vec3 up = normalize(vec3(0.0, 0.0, 1.0) - T * T.z);
    vec3 side = vec3(n, 0.0);
    // A flattened cross-section, pinched where the needle pulled it through.
    float rx = u_rx * mix(0.8, 1.0, rise);
    float rz = u_rz * mix(0.75, 1.0, rise);
    float c = cos(a_vert.z), sn = sin(a_vert.z);
    // Each edge rides up over any older strand it overlaps.
    float lift = (c >= 0.0 ? a_lift.x : a_lift.y) * rise;
    float ac = abs(c);
    vec3 pos = vec3(a_seg.xy + t * s, centerZ(s, len)) + side * c * rx + up * sn * rz
             + vec3(0.0, 0.0, lift * pow(ac, 1.5));
    vec3 normal = normalize(side * c / rx + up * sn / rz);
    float slope = lift * 1.5 * sqrt(ac) * sign(c) / rx;
    normal = normalize(normal - side * slope * max(dot(normal, up), 0.0));

    v_normal = normal;
    v_tangent = T;
    v_color = a_color.rgb;
    v_seed = a_z.w;
    v_across = c;
    v_along = s;
    v_rise = rise;
    v_height = pos.z;
    gl_Position = u_view * vec4(pos, 1.0);
  }`;

  const NOISE = `
  float hash1(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise1(float x) {
    float i = floor(x);
    return mix(hash1(i), hash1(i + 1.0), smoothstep(0.0, 1.0, fract(x)));
  }`;

  const SURFACE_FS = `#version 300 es
  precision highp float;
  in vec3 v_normal;
  in vec3 v_tangent;
  in vec3 v_color;
  in float v_seed;
  in float v_across;
  in float v_along;
  in float v_rise;
  in float v_height;
  uniform float u_twist;
  uniform float u_mmPerPx;
  uniform float u_zBase;
  uniform float u_zRange;
  layout(location = 0) out vec4 o_albedo;   // thread color; alpha 1 = thread here
  layout(location = 1) out vec4 o_normal;   // normal xy, height (16 bits over two channels)
  layout(location = 2) out vec4 o_fiber;    // fiber direction xy, fiber texture, needle-hole shade
  ${NOISE}

  void main() {
    vec3 T = normalize(v_tangent);
    vec3 N = normalize(v_normal);
    // Fine filaments, twisting gently along the thread (once big enough to see).
    float fine = smoothstep(0.12, 0.04, u_mmPerPx);
    float fc = (v_across * 0.5 + 0.5) * 7.0 + (v_along / u_twist + v_seed * 7.0) * 2.0;
    float fibers = 0.55 * noise1(fc) + 0.3 * noise1(fc * 2.7 + 17.0)
                 + 0.15 * noise1(v_along * 6.0 + floor(fc) * 13.0);
    vec3 B = normalize(cross(T, N));
    N = normalize(N + B * (fibers - 0.5) * 0.6 * fine);
    N.z = max(N.z, 0.02);
    N = normalize(N);

    vec3 albedo = v_color * (0.95 + 0.1 * v_seed) * (1.0 + (fibers - 0.5) * 0.3 * fine);
    float h = clamp((v_height - u_zBase) / u_zRange, 0.0, 1.0);
    o_albedo = vec4(albedo, 1.0);
    o_normal = vec4(N.xy * 0.5 + 0.5, floor(h * 255.0) / 255.0, fract(h * 255.0));
    o_fiber = vec4(T.xy * 0.5 + 0.5, mix(0.5, fibers, fine), v_rise);
  }`;

  // Pass 2 (light): per pixel, physically based shading of thread and fabric.
  const LIGHT_VS = `#version 300 es
  void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
    gl_Position = vec4(p, 0.0, 1.0);
  }`;

  const LIGHT_FS = `#version 300 es
  precision highp float;
  uniform sampler2D u_albedo;
  uniform sampler2D u_normal;
  uniform sampler2D u_fiber;
  uniform vec2 u_size;
  uniform float u_scale;      // px per mm
  uniform vec2 u_offset;
  uniform float u_zBase;
  uniform float u_zRange;
  uniform vec3 u_fabric;
  out vec4 o;
  ${NOISE}

  const float PI = 3.14159265;
  // Studio lighting: x right, y down, z up off the fabric. The key light
  // casts shadows; the fill and the sky soften them.
  const vec3 KEY_DIR = vec3(-0.45, -0.6, 0.66);
  const vec3 KEY = vec3(3.3, 3.2, 3.05);
  const vec3 FILL_DIR = vec3(0.7, 0.35, 0.6);
  const vec3 FILL = vec3(0.55, 0.6, 0.7);
  const vec3 SKY = vec3(0.5, 0.52, 0.56);
  const vec3 GROUND = vec3(0.22, 0.2, 0.18);
  const float F0 = 0.045;           // polyester / rayon: a dielectric, index ~1.55
  const float ALONG = 0.1;          // roughness along the fiber...
  const float ACROSS = 0.35;        // ...and across it
  const float SOFTBOX = 0.35;       // the key light's half-size, as a tangent (about 40 degrees across)
  const float AO_RADIUS = 0.6;      // mm
  const float EXPOSURE = 1.0;

  vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }

  float heightAt(vec2 uv) {
    vec4 n = texture(u_normal, uv);
    return u_zBase + (n.z + n.w / 255.0) * u_zRange;
  }

  // uv offset for a step in mm (world y runs down the screen, uv.y up).
  vec2 mmStep(vec2 mm) { return vec2(mm.x, -mm.y) * u_scale / u_size; }

  // Horizon-based ambient occlusion from the rendered heights: how much
  // of the sky the stitching around blocks.
  float occlusion(vec2 uv, float h) {
    float occ = 0.0;
    float nearest = 0.7 / u_scale;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7854 + 0.3927;
      vec2 dir = vec2(cos(a), sin(a));
      float horizon = 0.0;
      for (int j = 1; j <= 4; j++) {
        float d = max(AO_RADIUS * float(j * j) / 16.0, nearest * float(j));
        float dh = heightAt(uv + mmStep(dir * d)) - h;
        horizon = max(horizon, dh / sqrt(dh * dh + d * d));
      }
      occ += horizon;
    }
    return clamp(1.0 - occ / 8.0 * 1.2, 0.3, 1.0);
  }

  // Is stitching between here and the key light?
  float keyShadow(vec2 uv, float h) {
    vec3 l = normalize(KEY_DIR);
    vec2 dir = normalize(l.xy);
    float rise = l.z / length(l.xy);
    float lit = 1.0;
    for (int i = 1; i <= 10; i++) {
      float d = float(i) * 0.07;
      float blocker = heightAt(uv + mmStep(dir * d)) - h - d * rise;
      lit = min(lit, 1.0 - smoothstep(0.0, 0.03, blocker));
    }
    return lit;
  }

  vec3 fresnel(float cosTheta, float f0) { return vec3(f0 + (1.0 - f0) * pow(1.0 - cosTheta, 5.0)); }

  // Anisotropic GGX (as in Filament): fibers lined up along T scatter
  // light widely across the thread but little along it.
  float distributionAniso(float th, float bh, float nh, float at, float ab) {
    float a2 = at * ab;
    vec3 v = vec3(ab * th, at * bh, a2 * nh);
    float w2 = a2 / dot(v, v);
    return a2 * w2 * w2 / PI;
  }

  float visibilityAniso(float at, float ab, float tv, float bv, float tl, float bl, float nv, float nl) {
    float lv = nl * length(vec3(at * tv, ab * bv, nv));
    float ll = nv * length(vec3(at * tl, ab * bl, nl));
    return 0.5 / (lv + ll);
  }

  // Cloth sheen (Charlie distribution): the soft glow of fuzzy fibers.
  float sheenDistribution(float roughness, float nh) {
    float inv = 1.0 / roughness;
    float sin2 = max(1.0 - nh * nh, 0.0078125);
    return (2.0 + inv) * pow(sin2, inv * 0.5) / (2.0 * PI);
  }
  float sheenVisibility(float nv, float nl) { return 1.0 / (4.0 * (nl + nv - nl * nv)); }

  vec3 threadLight(vec3 N, vec3 T, vec3 albedo, float rough, float hole, vec3 L, vec3 radiance) {
    vec3 V = vec3(0.0, 0.0, 1.0);
    float nl = dot(N, L);
    if (nl <= 0.0) return vec3(0.0);
    vec3 B = normalize(cross(N, T));
    vec3 H = normalize(L + V);
    float nv = max(dot(N, V), 1e-3);
    float nh = max(dot(N, H), 0.0);
    float at = ALONG * rough, ab = ACROSS * rough;
    float D = distributionAniso(dot(T, H), dot(B, H), nh, at, ab);
    float Vis = visibilityAniso(at, ab, dot(T, V), dot(B, V), dot(T, L), dot(B, L), nv, nl);
    vec3 F = fresnel(max(dot(L, H), 0.0), F0);
    vec3 specular = D * Vis * F;
    vec3 sheen = mix(albedo, vec3(1.0), 0.35) * 0.3 * sheenDistribution(0.45, nh) * sheenVisibility(nv, nl);
    vec3 diffuse = albedo / PI * (1.0 - F);
    return (diffuse + (specular + sheen) * hole * hole) * radiance * nl;
  }

  // The key light is a big softbox, not a point: it's what lays long soft
  // highlights along the thread. Integrated over a 3 x 3 grid of directions.
  vec3 softboxLight(vec3 N, vec3 T, vec3 albedo, float rough, float hole, vec3 radiance) {
    vec3 k = normalize(KEY_DIR);
    vec3 u = normalize(cross(k, vec3(0.0, 0.0, 1.0)));
    vec3 v = cross(u, k);
    vec3 sum = vec3(0.0);
    for (int i = -1; i <= 1; i++) {
      for (int j = -1; j <= 1; j++) {
        vec3 L = normalize(k + (u * float(i) + v * float(j)) * SOFTBOX);
        sum += threadLight(N, T, albedo, rough, hole, L, radiance);
      }
    }
    return sum / 9.0;
  }

  // ACES filmic tone mapping (Narkowicz's fit).
  vec3 tonemap(vec3 x) {
    return clamp((x * (2.51 * x + 0.03)) / (x * (2.43 * x + 0.59) + 0.14), 0.0, 1.0);
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec2 world = (vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y) - u_offset) / u_scale;
    vec3 key = normalize(KEY_DIR), fill = normalize(FILL_DIR);
    float h = heightAt(uv);
    float ao = occlusion(uv, h);
    float lit = keyShadow(uv, h);

    vec4 albedoT = texture(u_albedo, uv);
    vec4 n = texture(u_normal, uv);
    vec3 N = vec3(n.xy * 2.0 - 1.0, 0.0);
    N.z = sqrt(max(1.0 - dot(N.xy, N.xy), 0.0));
    vec3 sky = mix(GROUND, SKY, N.z * 0.5 + 0.5);
    vec3 color;
    if (albedoT.a > 0.5) {
      vec4 fiber = texture(u_fiber, uv);
      vec3 t = vec3(fiber.xy * 2.0 - 1.0, 0.0);
      vec3 T = normalize(t - N * dot(N, t));
      vec3 albedo = toLinear(albedoT.rgb);
      float rough = mix(0.75, 1.3, fiber.z);
      float hole = fiber.w;
      albedo *= mix(0.8, 1.0, hole);
      color = softboxLight(N, T, albedo, rough, hole, KEY * lit)
            + threadLight(N, T, albedo, rough, hole, fill, FILL)
            + albedo * sky * ao
            + fresnel(N.z, F0) * sky * 0.25 * ao * hole;
    } else {
      // Fabric: a fine, matte plain weave.
      float fine = smoothstep(0.05, 0.02, 1.0 / u_scale);
      vec2 p = world / 0.18;
      vec2 cell = floor(p);
      vec2 f = fract(p) - 0.5;
      bool warp = mod(cell.x + cell.y, 2.0) < 1.0;
      vec2 tilt = warp ? vec2(-f.x, -f.y * 0.3) : vec2(-f.x * 0.3, -f.y);
      vec3 Nf = normalize(vec3(tilt * 0.25 * fine, 1.0));
      vec3 albedo = toLinear(u_fabric) * (1.0 + (hash(cell) - 0.5) * 0.04 * fine);
      color = albedo / PI * (KEY * lit * max(dot(Nf, key), 0.0) + FILL * max(dot(Nf, fill), 0.0))
            + albedo * sky * ao;
    }
    o = vec4(pow(tonemap(color * EXPOSURE), vec3(1.0 / 2.2)), 1.0);
  }`;

  // ------------------------------------------------------------ WebGL2

  function compile(gl, vsSource, fsSource) {
    const program = gl.createProgram();
    for (const [type, source] of [[gl.VERTEX_SHADER, vsSource], [gl.FRAGMENT_SHADER, fsSource]]) {
      const shader = gl.createShader(type);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      gl.attachShader(program, shader);
    }
    ["a_vert", "a_seg", "a_z", "a_color", "a_lift"].forEach((name, i) => gl.bindAttribLocation(program, i, name));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const uniforms = {};
    for (let i = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i--;) {
      const name = gl.getActiveUniform(program, i).name;
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  // A half cylinder (only the top shows) along a stitch: rings at mm from
  // each end, closer together where it climbs out of the needle holes.
  function tubeMesh(sides, fromEnds) {
    const rings = [
      ...fromEnds.map((mm) => [0, mm]),
      [0.5, 0],
      ...fromEnds.slice().reverse().map((mm) => [1, mm]),
    ];
    const verts = [];
    for (const [end, mm] of rings) {
      for (let j = 0; j <= sides; j++) verts.push(end, mm, (Math.PI * j) / sides);
    }
    const index = [];
    for (let r = 0; r < rings.length - 1; r++) {
      for (let j = 0; j < sides; j++) {
        const a = r * (sides + 1) + j;
        const b = a + sides + 1;
        index.push(a, b, a + 1, a + 1, b, b + 1);
      }
    }
    return { verts: new Float32Array(verts), index: new Uint16Array(index) };
  }

  const MESHES = {
    near: tubeMesh(8, [0, 0.05, 0.13, 0.24, 0.36, 0.45]),
    far: tubeMesh(3, [0, 0.2, 0.45]),
  };
  const NEAR_PX_PER_MM = 12;  // switch to the detailed mesh from here in

  class WebGLRenderer {
    constructor(canvas) {
      const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, alpha: false });
      if (!gl) throw new Error("WebGL2 unavailable");
      this.gl = gl;
      this.kind = "webgl";
      // Lighting works per pixel on buffers, which can't be multisampled:
      // render a little larger instead, and let the browser scale it down.
      this.supersample = (window.devicePixelRatio || 1) >= 2 ? 1.25 : 1.75;
      this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 4096);
      this.surface = compile(gl, TUBE_VS, SURFACE_FS);
      this.light = compile(gl, LIGHT_VS, LIGHT_FS);

      this.instances = gl.createBuffer();
      this.colors = gl.createBuffer();
      const stride = STRIDE * 4;
      this.meshes = {};
      for (const [name, mesh] of Object.entries(MESHES)) {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, mesh.verts, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
        for (const [loc, size, offset] of [[1, 4, 0], [2, 4, 16], [4, 2, 32]]) {
          gl.enableVertexAttribArray(loc);
          gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset);
          gl.vertexAttribDivisor(loc, 1);
        }
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colors);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 4, 0);
        gl.vertexAttribDivisor(3, 1);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.index, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        this.meshes[name] = { vao, count: mesh.index.length };
      }
      this.buffers = null;
      this.count = 0;
    }

    setDesign(design) {
      const gl = this.gl;
      const st = design.stack || (design.stack = stack(design));
      this.stacked = st;
      this.count = design.segmentCount;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
      gl.bufferData(gl.ARRAY_BUFFER, st.instances, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colors);
      gl.bufferData(gl.ARRAY_BUFFER, design.segmentColors, gl.STATIC_DRAW);
    }

    // The surface pass's three buffers, sized to the canvas.
    surfaceBuffers(w, h) {
      const gl = this.gl;
      if (this.buffers && this.buffers.w === w && this.buffers.h === h) return this.buffers;
      if (this.buffers) {
        this.buffers.textures.forEach((t) => gl.deleteTexture(t));
        gl.deleteFramebuffer(this.buffers.fb);
      }
      const fb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, fb);
      const textures = [0, 1, 2].map((i) => {
        const tex = gl.createTexture();
        gl.bindTexture(gl.TEXTURE_2D, tex);
        gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
        gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0 + i, gl.TEXTURE_2D, tex, 0);
        return tex;
      });
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1, gl.COLOR_ATTACHMENT2]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.buffers = { w, h, fb, textures };
      return this.buffers;
    }

    render({ width, height, scale, offset, fabric }) {
      const gl = this.gl;
      if (gl.isContextLost() || !this.stacked) return;
      const st = this.stacked;
      const zBase = -0.3, zRange = st.maxZ + 0.6;
      const view = new Float32Array([
        (2 * scale) / width, 0, 0, 0,
        0, (-2 * scale) / height, 0, 0,
        0, 0, -1 / zRange, 0,
        (2 * offset[0]) / width - 1, 1 - (2 * offset[1]) / height, 0, 1,
      ]);
      const mesh = scale >= NEAR_PX_PER_MM ? this.meshes.near : this.meshes.far;

      // 1. Surface: no depth test, since where stitches overlap the one sewn
      // later lies on top, so drawing in sewing order is exactly right.
      const buffers = this.surfaceBuffers(width, height);
      gl.bindFramebuffer(gl.FRAMEBUFFER, buffers.fb);
      gl.viewport(0, 0, width, height);
      gl.disable(gl.DEPTH_TEST);
      gl.disable(gl.BLEND);
      const fabricHeight = (0 - zBase) / zRange;  // bare fabric: flat, at z = 0
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      gl.clearBufferfv(gl.COLOR, 1, [0.5, 0.5, Math.floor(fabricHeight * 255) / 255, (fabricHeight * 255) % 1]);
      gl.clearBufferfv(gl.COLOR, 2, [0.5, 0.5, 0.5, 1]);
      const s = this.surface;
      gl.useProgram(s.program);
      gl.uniformMatrix4fv(s.uniforms.u_view, false, view);
      gl.uniform1f(s.uniforms.u_rx, RX);
      gl.uniform1f(s.uniforms.u_rz, RZ);
      gl.uniform1f(s.uniforms.u_ramp, RAMP);
      gl.uniform1f(s.uniforms.u_twist, TWIST_PERIOD);
      gl.uniform1f(s.uniforms.u_mmPerPx, 1 / scale);
      gl.uniform1f(s.uniforms.u_zBase, zBase);
      gl.uniform1f(s.uniforms.u_zRange, zRange);
      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, this.count);
      gl.bindVertexArray(null);

      // 2. Light it.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const l = this.light;
      gl.useProgram(l.program);
      buffers.textures.forEach((tex, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      });
      gl.uniform1i(l.uniforms.u_albedo, 0);
      gl.uniform1i(l.uniforms.u_normal, 1);
      gl.uniform1i(l.uniforms.u_fiber, 2);
      gl.uniform2f(l.uniforms.u_size, width, height);
      gl.uniform1f(l.uniforms.u_scale, scale);
      gl.uniform2f(l.uniforms.u_offset, offset[0], offset[1]);
      gl.uniform1f(l.uniforms.u_zBase, zBase);
      gl.uniform1f(l.uniforms.u_zRange, zRange);
      gl.uniform3f(l.uniforms.u_fabric, ...fabric.map((c) => c / 255));
      gl.drawArrays(gl.TRIANGLES, 0, 3);
    }
  }

  // ------------------------------------------------------------ canvas 2D

  class CanvasRenderer {
    constructor(canvas) {
      this.ctx = canvas.getContext("2d");
      this.kind = "canvas";
      this.maxSize = 4096;
    }

    setDesign(design) { this.design = design; }

    render({ scale, offset, fabric }) {
      const { ctx, design } = this;
      const { width, height } = ctx.canvas;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.fillStyle = `rgb(${fabric.join(",")})`;
      ctx.fillRect(0, 0, width, height);
      ctx.setTransform(scale, 0, 0, scale, offset[0], offset[1]);
      ctx.lineCap = ctx.lineJoin = "round";
      const px = 1 / scale;
      const tone = (rgb, k) => `rgb(${rgb.map((c) => Math.round(Math.min(255, c * k))).join(",")})`;
      for (const run of design.runs) {
        const rgb = hexToRgb(design.colors[run.color]);
        const path = new Path2D();
        const pts = design.points;
        path.moveTo(pts[run.start * 2], pts[run.start * 2 + 1]);
        for (let i = 1; i < run.count; i++) path.lineTo(pts[(run.start + i) * 2], pts[(run.start + i) * 2 + 1]);
        if (run.count === 1) path.lineTo(pts[run.start * 2] + 0.01, pts[run.start * 2 + 1]);
        // A darker edge and a lighter core make each strand read as round.
        ctx.strokeStyle = tone(rgb, 0.8);
        ctx.lineWidth = Math.max(RX * 2, px);
        ctx.stroke(path);
        ctx.strokeStyle = tone(rgb, 1.12);
        ctx.lineWidth = Math.max(RX * 0.9, px * 0.5);
        ctx.stroke(path);
      }
    }
  }

  // ------------------------------------------------------------ view

  const FABRIC = { light: [236, 231, 222], dark: [44, 43, 47] };

  // A zoomable, pannable canvas showing one design at a time.
  class View {
    constructor() {
      this.element = document.createElement("div");
      this.element.className = "stitch-view";
      this.hint = document.createElement("div");
      this.hint.className = "stitch-hint";
      this.renderer = null;
      if (!window.FORCE_CANVAS_RENDERER) {
        try { this.renderer = new WebGLRenderer(this.newCanvas()); } catch { this.renderer = null; }
      }
      if (!this.renderer) this.renderer = new CanvasRenderer(this.newCanvas());
      this.element.dataset.renderer = this.renderer.kind;
      this.element.append(this.canvas, this.hint);

      this.design = null;
      this.zoom = 1;
      this.center = [0, 0];
      this.pointers = new Map();
      this.frame = 0;
      this.dark = matchMedia("(prefers-color-scheme: dark)");
      this.dark.addEventListener("change", () => this.draw());
      new ResizeObserver(() => this.draw()).observe(this.element);
      this.canvas.addEventListener("webglcontextlost", () => this.fallBack());
      this.listen();
    }

    newCanvas() {
      this.canvas = document.createElement("canvas");
      return this.canvas;
    }

    // The GPU went away (driver reset, too many tabs): carry on in 2D.
    fallBack() {
      const old = this.canvas;
      this.renderer = new CanvasRenderer(this.newCanvas());
      old.replaceWith(this.canvas);
      this.element.dataset.renderer = this.renderer.kind;
      this.listen();
      if (this.design) this.renderer.setDesign(this.design);
      this.draw();
    }

    show(design) {
      if (design === this.design) return;
      this.design = design;
      this.renderer.setDesign(design);
      this.reset();
    }

    reset() {
      this.zoom = 1;
      if (this.design) this.center = [this.design.width / 2, this.design.height / 2];
      this.draw();
    }

    fitScale() {  // CSS px per mm at zoom 1
      const { clientWidth: w, clientHeight: h } = this.element;
      return Math.min(w / (this.design.width * FIT_MARGIN), h / (this.design.height * FIT_MARGIN));
    }

    maxZoom() { return Math.max(1, MAX_PX_PER_MM / this.fitScale()); }

    draw() {
      if (!this.frame) this.frame = requestAnimationFrame(() => { this.frame = 0; this.paint(); });
    }

    paint() {
      const { clientWidth: cssW, clientHeight: cssH } = this.element;
      if (!this.design || !cssW || !cssH) return;
      const dpr = window.devicePixelRatio || 1;
      // Supersample a little: thread edges are finer than a pixel when zoomed out.
      let ss = this.renderer.supersample || (dpr >= 2 ? 1.25 : 2);
      ss = Math.min(ss, this.renderer.maxSize / (Math.max(cssW, cssH) * dpr), Math.sqrt(9e6 / (cssW * cssH * dpr * dpr)));
      const k = dpr * Math.max(ss, 0.5);
      const width = Math.round(cssW * k);
      const height = Math.round(cssH * k);
      if (this.canvas.width !== width || this.canvas.height !== height) {
        this.canvas.width = width;
        this.canvas.height = height;
      }
      const scale = this.fitScale() * this.zoom * k;
      const offset = [width / 2 - this.center[0] * scale, height / 2 - this.center[1] * scale];
      this.renderer.render({
        width, height, scale, offset,
        fabric: this.dark.matches ? FABRIC.dark : FABRIC.light,
      });
      this.element.dataset.zoom = this.zoom.toFixed(2);
      this.element.dataset.rendered = "1";
      const touch = matchMedia("(pointer: coarse)").matches;
      this.hint.textContent = this.zoom > 1.01
        ? (touch ? "Double-tap to fit" : "Double-click to fit")
        : (touch ? "Pinch to zoom in on the stitches" : "Scroll to zoom in on the stitches");
    }

    // Zoom by `factor`, keeping the design point under (x, y) (CSS px) still.
    zoomAt(factor, x, y) {
      if (!this.design) return;
      const before = this.fitScale() * this.zoom;
      this.zoom = Math.min(this.maxZoom(), Math.max(1, this.zoom * factor));
      const after = this.fitScale() * this.zoom;
      const dx = x - this.element.clientWidth / 2;
      const dy = y - this.element.clientHeight / 2;
      this.center[0] += dx / before - dx / after;
      this.center[1] += dy / before - dy / after;
      if (this.zoom === 1) this.center = [this.design.width / 2, this.design.height / 2];
      this.clampCenter();
      this.draw();
    }

    panBy(dx, dy) {
      const s = this.fitScale() * this.zoom;
      this.center[0] -= dx / s;
      this.center[1] -= dy / s;
      this.clampCenter();
      this.draw();
    }

    clampCenter() {
      const d = this.design;
      this.center[0] = Math.min(d.width, Math.max(0, this.center[0]));
      this.center[1] = Math.min(d.height, Math.max(0, this.center[1]));
    }

    listen() {
      const c = this.canvas;
      const local = (ev) => {
        const r = c.getBoundingClientRect();
        return [ev.clientX - r.left, ev.clientY - r.top];
      };
      c.addEventListener("wheel", (ev) => {
        ev.preventDefault();
        this.zoomAt(Math.exp(-ev.deltaY * (ev.deltaMode ? 0.05 : 0.0015)), ...local(ev));
      }, { passive: false });
      c.addEventListener("dblclick", () => this.reset());
      c.addEventListener("pointerdown", (ev) => {
        c.setPointerCapture(ev.pointerId);
        this.pointers.set(ev.pointerId, local(ev));
        if (ev.pointerType === "touch" && this.pointers.size === 1) {
          const now = performance.now();
          if (now - (this.lastTap || 0) < 300) this.reset();
          this.lastTap = now;
        }
      });
      c.addEventListener("pointermove", (ev) => {
        const prev = this.pointers.get(ev.pointerId);
        if (!prev) return;
        const cur = local(ev);
        if (this.pointers.size === 1) {
          this.panBy(cur[0] - prev[0], cur[1] - prev[1]);
        } else if (this.pointers.size === 2) {
          const [other] = [...this.pointers].filter(([id]) => id !== ev.pointerId).map(([, p]) => p);
          const before = Math.hypot(prev[0] - other[0], prev[1] - other[1]);
          const after = Math.hypot(cur[0] - other[0], cur[1] - other[1]);
          if (before > 0) this.zoomAt(after / before, (cur[0] + other[0]) / 2, (cur[1] + other[1]) / 2);
        }
        this.pointers.set(ev.pointerId, cur);
      });
      const up = (ev) => this.pointers.delete(ev.pointerId);
      c.addEventListener("pointerup", up);
      c.addEventListener("pointercancel", up);
    }
  }

  window.StitchView = { parse, stack, View };
})();
