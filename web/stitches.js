// Stitch-level design preview for the viewer.
//
// The server sends every stitch (see encode_stitches in embroidery-web.py).
// With WebGL2 every stitch becomes a real 3D strand of thread:
//
//   stacking  (once per design) the stitches are laid down in sewing order
//             on a height grid: each rests, taut, on the highest thing
//             beneath its middle and is pulled down into the fabric at its
//             two needle holes, so underlay, layers and satin pile up the
//             way the machine builds them;
//   geometry  each stitch is a flattened cylinder bent along that path,
//             pinched where it enters the needle holes (one small mesh,
//             drawn once per stitch by the GPU, in sewing order: where
//             stitches overlap, the later one is on top);
//   lighting  shadows and soft occlusion from the stacked heights, and a
//             hair-style (Kajiya-Kay / Marschner-like) sheen along the
//             thread with fine twisting filaments up close.
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

  // Lay the stitches down in sewing order. Returns, per stitch,
  // x0 y0 x1 y1 z0 z1 zTop seed (the z's are its center line at each
  // needle hole and across its middle), plus the final surface heights.
  function stack(design) {
    const n = design.segmentCount;
    const margin = 1.5;
    const cell = Math.max(0.1, Math.max(design.width, design.height) / 2000);
    const gw = Math.ceil((design.width + 2 * margin) / cell) + 1;
    const gh = Math.ceil((design.height + 2 * margin) / cell) + 1;
    const grid = new Float32Array(gw * gh);
    const owner = new Int32Array(gw * gh).fill(-1000);  // the stitch that set each cell
    const cellOf = (v, size) => Math.min(size - 1, Math.max(0, Math.round((v + margin) / cell)));
    const at = (x, y) => grid[cellOf(y, gh) * gw + cellOf(x, gw)];
    const out = new Float32Array(n * 8);
    const seg = design.segments;
    const core = RX * 0.5;
    let maxZ = RZ * 2;

    for (let i = 0; i < n; i++) {
      const x0 = seg[i * 5], y0 = seg[i * 5 + 1], seed = seg[i * 5 + 4];
      let x1 = seg[i * 5 + 2], y1 = seg[i * 5 + 3];
      let L = Math.hypot(x1 - x0, y1 - y0);
      if (L < 0.05) { x1 = x0 + 0.15; L = 0.15; }  // a lone tack
      const dx = (x1 - x0) / L, dy = (y1 - y0) / L;
      const mid = L / 2;
      const ramp = Math.min(RAMP, mid);

      // A taut thread rests on the highest thing beneath its middle. Not
      // on the stitches sewn just before it, though: those share its
      // needle hole and lie beside it (satin zigzags back and forth
      // over almost the same line), they don't lift it.
      const keep = Math.min(0.3, mid * 0.6);
      const steps = Math.max(2, Math.ceil(L / cell));
      let under = 0;
      for (let k = 0; k <= steps; k++) {
        const s = (k / steps) * L;
        if (s < keep || L - s < keep) continue;
        const g = cellOf(y0 + dy * s, gh) * gw + cellOf(x0 + dx * s, gw);
        if (owner[g] < i - NEIGHBORS) under = Math.max(under, grid[g]);
      }
      // Layers compress under the ones above, so stacks level off.
      const zTop = RZ + MAX_STACK * (1 - Math.exp(-under / MAX_STACK));
      // It dips into its needle holes, but only so far below its top.
      const z0 = Math.max(at(x0, y0) - RZ * 0.5, zTop - HOLE_DIP, -RZ * 0.4);
      const z1 = Math.max(at(x1, y1) - RZ * 0.5, zTop - HOLE_DIP, -RZ * 0.4);
      out.set([x0, y0, x1, y1, z0, z1, zTop, seed], i * 8);
      maxZ = Math.max(maxZ, zTop + RZ);

      // Its core is what later stitches rest on. (Only the core, so
      // stitches sewn side by side, as in satin, don't climb each other.)
      const cx0 = cellOf(Math.min(x0, x1) - core, gw), cx1 = cellOf(Math.max(x0, x1) + core, gw);
      const cy0 = cellOf(Math.min(y0, y1) - core, gh), cy1 = cellOf(Math.max(y0, y1) + core, gh);
      for (let cy = cy0; cy <= cy1; cy++) {
        const py = cy * cell - margin;
        for (let cx = cx0; cx <= cx1; cx++) {
          const px = cx * cell - margin;
          const s = Math.min(L, Math.max(0, (px - x0) * dx + (py - y0) * dy));
          if (Math.hypot(px - x0 - dx * s, py - y0 - dy * s) > core) continue;
          const rise = smoothstep(0, ramp, Math.min(s, L - s));
          const zEnd = s < mid ? z0 : z1;
          const top = zEnd + (zTop - zEnd) * rise + RZ;
          const g = cy * gw + cx;
          if (top > grid[g]) {
            grid[g] = top;
            owner[g] = i;
          }
        }
      }
    }
    return { instances: out, grid, gw, gh, cell, margin, maxZ };
  }

  // ------------------------------------------------------------ shaders

  const TUBE_VS = `#version 300 es
  in vec3 a_vert;     // mesh: which end (0 start, 0.5 middle, 1 end), mm from it, angle around
  in vec4 a_seg;      // x0 y0 x1 y1
  in vec4 a_z;        // z0 z1 zTop seed
  in vec4 a_color;
  uniform mat4 u_view;
  uniform float u_rx;
  uniform float u_rz;
  uniform float u_ramp;
  out vec3 v_world;
  out vec3 v_normal;
  out vec3 v_tangent;
  out vec3 v_color;
  out float v_seed;
  out float v_across;
  out float v_along;
  out float v_rise;

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
    // Pinched where the needle pulled it through.
    float rx = u_rx * mix(0.8, 1.0, rise);
    float rz = u_rz * mix(0.75, 1.0, rise);
    float c = cos(a_vert.z), sn = sin(a_vert.z);
    vec3 pos = vec3(a_seg.xy + t * s, centerZ(s, len)) + side * c * rx + up * sn * rz;

    v_world = pos;
    v_normal = normalize(side * c / rx + up * sn / rz);
    v_tangent = T;
    v_color = a_color.rgb;
    v_seed = a_z.w;
    v_across = c;
    v_along = s;
    v_rise = rise;
    gl_Position = u_view * vec4(pos, 1.0);
  }`;

  // Shared by the thread and the fabric.
  const LIGHTING = `
  uniform sampler2D u_grid;
  uniform vec4 u_gridMap;     // world mm -> grid uv: (xy + map.xy) * map.zw
  uniform float u_gridMax;
  uniform vec3 u_light;       // toward the light; x right, y down, z up off the fabric
  uniform float u_mmPerPx;

  const float AMBIENT = 0.42;
  const float SUN = 0.85;

  vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
  vec3 toSrgb(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float hash1(float x) { return fract(sin(x * 91.3458) * 47453.5453); }
  float noise1(float x) {
    float i = floor(x);
    return mix(hash1(i), hash1(i + 1.0), smoothstep(0.0, 1.0, fract(x)));
  }

  float surfaceHeight(vec2 w) { return texture(u_grid, (w + u_gridMap.xy) * u_gridMap.zw).r * u_gridMax; }

  // 0 in shadow .. 1 lit: is stitching between here and the light?
  float litFraction(vec3 w) {
    vec2 dir = normalize(u_light.xy);
    float rise = u_light.z / length(u_light.xy);  // the light's height gain per mm
    float lit = 1.0;
    for (int i = 1; i <= 8; i++) {
      float d = float(i) * 0.1;
      float blocker = surfaceHeight(w.xy + dir * d) - w.z - d * rise;
      lit = min(lit, 1.0 - smoothstep(0.0, 0.06, blocker));
    }
    return lit;
  }

  // Darker where the stitching around stands higher: the sides of a
  // strand, the gaps between strands, the foot of raised satin.
  float occlusion(vec3 w) {
    float sum = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7854 + 0.39;
      vec2 dir = vec2(cos(a), sin(a));
      sum += max(surfaceHeight(w.xy + dir * 0.3) - w.z, 0.0);
      sum += max(surfaceHeight(w.xy + dir * 0.9) - w.z, 0.0) * 0.6;
    }
    return clamp(1.0 - sum / 16.0 * 3.0, 0.35, 1.0);
  }`;

  const TUBE_FS = `#version 300 es
  precision highp float;
  in vec3 v_world;
  in vec3 v_normal;
  in vec3 v_tangent;
  in vec3 v_color;
  in float v_seed;
  in float v_across;
  in float v_along;
  in float v_rise;
  ${LIGHTING}
  uniform float u_twist;
  out vec4 o;

  void main() {
    vec3 L = normalize(u_light);
    vec3 V = vec3(0.0, 0.0, 1.0);
    vec3 T = normalize(v_tangent);
    vec3 N = normalize(v_normal);
    // Fine filaments, twisting gently along the thread (once big enough to see).
    float fine = smoothstep(0.12, 0.04, u_mmPerPx);
    float fc = (v_across * 0.5 + 0.5) * 7.0 + (v_along / u_twist + v_seed * 7.0) * 2.0;
    float fibers = 0.55 * noise1(fc) + 0.3 * noise1(fc * 2.7 + 17.0)
                 + 0.15 * noise1(v_along * 6.0 + floor(fc) * 13.0);
    vec3 B = normalize(cross(T, N));
    N = normalize(N + B * (fibers - 0.5) * 0.7 * fine);
    vec3 Tn = normalize(T - N * dot(N, T));

    float ao = occlusion(v_world);
    float sh = mix(0.45, 1.0, litFraction(v_world));
    vec3 Hv = normalize(L + V);
    // Light wraps a little around the soft, fuzzy strand.
    float lambert = max((dot(N, L) + 0.35) / 1.35, 0.0);
    float tl = dot(Tn, L);
    float diffuse = 0.75 * lambert + 0.25 * sqrt(max(1.0 - tl * tl, 0.0));
    // Two sheen lobes along the fiber: a soft whitish shine, and a broader
    // one tinted by the thread (light that went through the fiber).
    float h1 = dot(normalize(Tn + N * 0.08), Hv);
    float h2 = dot(normalize(Tn - N * 0.12), Hv);
    float shine = pow(sqrt(max(1.0 - h1 * h1, 0.0)), 36.0);
    float glow = pow(sqrt(max(1.0 - h2 * h2, 0.0)), 10.0);
    float facing = smoothstep(0.0, 0.3, dot(N, L)) * v_rise;

    vec3 albedo = toLinear(v_color) * (0.94 + 0.12 * v_seed)
                * (1.0 + (fibers - 0.5) * 0.35 * fine) * mix(0.7, 1.0, v_rise);
    vec3 color = albedo * (AMBIENT * ao + SUN * diffuse * sh)
               + (vec3(0.12) * shine + albedo * 0.35 * glow) * facing * sh * ao;
    o = vec4(toSrgb(color), 1.0);
  }`;

  const FABRIC_VS = `#version 300 es
  uniform float u_depth;
  void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
    gl_Position = vec4(p, u_depth, 1.0);
  }`;

  const FABRIC_FS = `#version 300 es
  precision highp float;
  ${LIGHTING}
  uniform vec2 u_size;
  uniform float u_scale;
  uniform vec2 u_offset;
  uniform vec3 u_fabric;
  out vec4 o;

  void main() {
    vec2 world = (vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y) - u_offset) / u_scale;
    vec3 w = vec3(world, 0.0);
    // A fine plain weave, only once big enough to see.
    float fine = smoothstep(0.05, 0.02, u_mmPerPx);
    vec2 p = world / 0.18;
    vec2 cell = floor(p);
    vec2 f = fract(p) - 0.5;
    bool warp = mod(cell.x + cell.y, 2.0) < 1.0;
    vec2 tilt = warp ? vec2(-f.x, -f.y * 0.3) : vec2(-f.x * 0.3, -f.y);
    vec3 N = normalize(vec3(tilt * 0.25 * fine, 1.0));
    float grain = (hash(cell) - 0.5) * 0.04 * fine + (hash(floor(world * 2.0)) - 0.5) * 0.02;
    vec3 albedo = toLinear(u_fabric) * (1.0 + grain);
    float sh = mix(0.45, 1.0, litFraction(w));
    vec3 color = albedo * (AMBIENT * occlusion(w) + SUN * max(dot(N, normalize(u_light)), 0.0) * sh);
    o = vec4(toSrgb(color), 1.0);
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
    ["a_vert", "a_seg", "a_z", "a_color"].forEach((name, i) => gl.bindAttribLocation(program, i, name));
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
      const gl = canvas.getContext("webgl2", { antialias: true, preserveDrawingBuffer: true, alpha: false });
      if (!gl) throw new Error("WebGL2 unavailable");
      this.gl = gl;
      this.kind = "webgl";
      this.supersample = 1;  // the canvas is multisampled instead
      this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 4096);
      this.tube = compile(gl, TUBE_VS, TUBE_FS);
      this.fabric = compile(gl, FABRIC_VS, FABRIC_FS);

      this.instances = gl.createBuffer();
      this.colors = gl.createBuffer();
      this.meshes = {};
      for (const [name, mesh] of Object.entries(MESHES)) {
        const vao = gl.createVertexArray();
        gl.bindVertexArray(vao);
        gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ARRAY_BUFFER, mesh.verts, gl.STATIC_DRAW);
        gl.enableVertexAttribArray(0);
        gl.vertexAttribPointer(0, 3, gl.FLOAT, false, 0, 0);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.instances);
        gl.enableVertexAttribArray(1);
        gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 32, 0);
        gl.vertexAttribDivisor(1, 1);
        gl.enableVertexAttribArray(2);
        gl.vertexAttribPointer(2, 4, gl.FLOAT, false, 32, 16);
        gl.vertexAttribDivisor(2, 1);
        gl.bindBuffer(gl.ARRAY_BUFFER, this.colors);
        gl.enableVertexAttribArray(3);
        gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 4, 0);
        gl.vertexAttribDivisor(3, 1);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
        gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.index, gl.STATIC_DRAW);
        gl.bindVertexArray(null);
        this.meshes[name] = { vao, count: mesh.index.length };
      }

      this.gridTexture = gl.createTexture();
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

      const bytes = new Uint8Array(st.grid.length);
      for (let i = 0; i < bytes.length; i++) bytes[i] = Math.round((st.grid[i] / st.maxZ) * 255);
      gl.bindTexture(gl.TEXTURE_2D, this.gridTexture);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, st.gw, st.gh, 0, gl.RED, gl.UNSIGNED_BYTE, bytes);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    }

    render({ width, height, scale, offset, fabric, light }) {
      const gl = this.gl;
      if (gl.isContextLost() || !this.stacked) return;
      const st = this.stacked;
      const zMin = -0.5, zMax = st.maxZ + 0.5;
      const view = new Float32Array([
        (2 * scale) / width, 0, 0, 0,
        0, (-2 * scale) / height, 0, 0,
        0, 0, -2 / (zMax - zMin), 0,
        (2 * offset[0]) / width - 1, 1 - (2 * offset[1]) / height, 1 + (2 * zMin) / (zMax - zMin), 1,
      ]);
      const mesh = scale >= NEAR_PX_PER_MM ? this.meshes.near : this.meshes.far;

      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      gl.viewport(0, 0, width, height);
      // No depth test: where stitches overlap, the one sewn later lies on
      // top, so drawing in sewing order is exactly right.
      gl.disable(gl.DEPTH_TEST);
      gl.clearColor(0, 0, 0, 1);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, this.gridTexture);
      const lighting = (p) => {
        gl.useProgram(p.program);
        gl.uniform1i(p.uniforms.u_grid, 0);
        const k = 1 / st.cell;
        gl.uniform4f(p.uniforms.u_gridMap, st.margin + st.cell / 2, st.margin + st.cell / 2, k / st.gw, k / st.gh);
        gl.uniform1f(p.uniforms.u_gridMax, st.maxZ);
        gl.uniform3f(p.uniforms.u_light, ...light);
        gl.uniform1f(p.uniforms.u_mmPerPx, 1 / scale);
      };

      const f = this.fabric;
      lighting(f);
      gl.uniform1f(f.uniforms.u_depth, 0);
      gl.uniform2f(f.uniforms.u_size, width, height);
      gl.uniform1f(f.uniforms.u_scale, scale);
      gl.uniform2f(f.uniforms.u_offset, offset[0], offset[1]);
      gl.uniform3f(f.uniforms.u_fabric, ...fabric.map((c) => c / 255));
      gl.drawArrays(gl.TRIANGLES, 0, 3);

      const t = this.tube;
      lighting(t);
      gl.uniformMatrix4fv(t.uniforms.u_view, false, view);
      gl.uniform1f(t.uniforms.u_rx, RX);
      gl.uniform1f(t.uniforms.u_rz, RZ);
      gl.uniform1f(t.uniforms.u_ramp, RAMP);
      gl.uniform1f(t.uniforms.u_twist, TWIST_PERIOD);
      gl.bindVertexArray(mesh.vao);
      gl.drawElementsInstanced(gl.TRIANGLES, mesh.count, gl.UNSIGNED_SHORT, 0, this.count);
      gl.bindVertexArray(null);
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
  const LIGHT = [-0.45, -0.6, 0.66];  // from the upper left

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
        light: LIGHT,
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
