// Stitch-level design preview for the viewer.
//
// The server sends every stitch (see encode_stitches in embroidery-web.py).
// With WebGL2 each stitch is drawn as a strand of thread and lit like one:
//
//   1. height pass   every stitch adds a rounded ridge to a height map, so
//                    layered stitches and satin columns stand up;
//   2. thread pass   the last stitch sewn over each pixel records its color,
//                    direction and where across the strand the pixel is;
//   3. light pass    per pixel: a hair-style (Kajiya-Kay / Marschner-like)
//                    anisotropic sheen along the thread, ply twist when
//                    zoomed in, occlusion and cast shadows from the height
//                    map, and woven fabric where there is no thread.
//
// Without WebGL2 it falls back to thread-width lines on a 2D canvas.
"use strict";

(() => {
  const THREAD_RADIUS = 0.21;   // mm: embroidery thread lies about 0.4 mm wide
  const THREAD_HEIGHT = 0.2;    // mm a single stitch stands off the fabric
  const TWIST_PERIOD = 0.5;     // mm per turn of the thread's twist
  const HEIGHT_RANGE = 1.0;     // mm of stacked height an 8-bit height map can hold
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

    // Per segment: x0, y0, x1, y1, seed; and its color as RGBA bytes.
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

  // ------------------------------------------------------------ shaders

  const STITCH_VS = `#version 300 es
  in vec2 a_corner;
  in vec4 a_seg;
  in float a_seed;
  in vec4 a_color;
  uniform float u_scale;    // framebuffer px per mm
  uniform vec2 u_offset;    // framebuffer px of the design's origin
  uniform vec2 u_size;
  uniform float u_radius;
  out vec2 v_local;         // mm along the stitch (from its start), across it
  out float v_len;
  out vec2 v_dir;
  out vec3 v_color;
  out float v_seed;
  void main() {
    vec2 d = a_seg.zw - a_seg.xy;
    float len = length(d);
    vec2 t = len > 1e-5 ? d / len : vec2(1.0, 0.0);
    vec2 n = vec2(-t.y, t.x);
    float r = u_radius + 1.5 / u_scale;  // room for the edge pixels
    float along = mix(-r, len + r, a_corner.x);
    float across = a_corner.y * r;
    vec2 px = (a_seg.xy + t * along + n * across) * u_scale + u_offset;
    gl_Position = vec4(px.x / u_size.x * 2.0 - 1.0, 1.0 - px.y / u_size.y * 2.0, 0.0, 1.0);
    v_local = vec2(along, across);
    v_len = len;
    v_dir = t;
    v_color = a_color.rgb;
    v_seed = a_seed;
  }`;

  // Shared by both stitch passes: where this pixel sits on the strand.
  const STRAND = `
  in vec2 v_local;
  in float v_len;
  in vec2 v_dir;
  in vec3 v_color;
  in float v_seed;
  uniform float u_radius;
  vec2 strandOffset() {  // from the stitch's center line, in mm
    return vec2(v_local.x - clamp(v_local.x, 0.0, v_len), v_local.y);
  }`;

  const HEIGHT_FS = `#version 300 es
  precision highp float;
  ${STRAND}
  uniform float u_height;
  uniform float u_store;    // mm -> stored units
  out vec4 o;
  void main() {
    float q = length(strandOffset()) / u_radius;
    if (q > 1.0) discard;
    // The thread dips into the fabric at each needle hole.
    float fromEnd = min(v_local.x, v_len - v_local.x);
    float hole = mix(0.6, 1.0, smoothstep(-u_radius, u_radius * 1.6, fromEnd));
    float h = sqrt(1.0 - q * q) * hole * u_height * (0.85 + 0.3 * v_seed);
    o = vec4(h * u_store, 0.0, 0.0, 1.0);
  }`;

  const THREAD_FS = `#version 300 es
  precision highp float;
  ${STRAND}
  uniform float u_twist;
  layout(location = 0) out vec4 o_color;
  layout(location = 1) out vec4 o_shape;
  void main() {
    vec2 d = strandOffset();
    // Short, flat ends: the thread runs on down into the needle hole.
    if (length(vec2(d.x * 2.0, d.y)) > u_radius) discard;
    vec2 n = vec2(-v_dir.y, v_dir.x);
    // Outward on the strand (length 0..1): round across it.
    vec2 out2 = (v_dir * d.x * 0.35 + n * d.y) / u_radius;
    // Near the needle holes the thread is in shadow.
    float fromEnd = min(v_local.x, v_len - v_local.x);
    float hole = mix(0.55, 1.0, smoothstep(-0.5 * u_radius, u_radius * 1.2, fromEnd));
    float shade = (0.92 + 0.16 * v_seed) * hole;
    // alpha: twist phase along the thread (> 0 marks "thread here");
    // the direction's length carries the hole shadow for the sheen.
    o_color = vec4(v_color * shade, 0.1 + 0.9 * fract(v_local.x / u_twist + v_seed));
    o_shape = vec4(v_dir * hole * 0.5 + 0.5, out2 * 0.5 + 0.5);
  }`;

  const LIGHT_VS = `#version 300 es
  void main() {
    vec2 p = vec2(gl_VertexID == 1 ? 3.0 : -1.0, gl_VertexID == 2 ? 3.0 : -1.0);
    gl_Position = vec4(p, 0.0, 1.0);
  }`;

  const LIGHT_FS = `#version 300 es
  precision highp float;
  uniform sampler2D u_heightMap;
  uniform sampler2D u_threadColor;
  uniform sampler2D u_threadShape;
  uniform vec2 u_size;
  uniform float u_mmPerPx;
  uniform float u_load;     // stored units -> mm
  uniform vec3 u_light;     // toward the light; x right, y down, z toward the viewer
  uniform vec3 u_fabric;
  uniform float u_scale;
  uniform vec2 u_offset;
  out vec4 o;

  const float MAX_H = 0.7;
  const float AMBIENT = 0.38;
  const float SUN = 0.85;

  vec3 toLinear(vec3 c) { return pow(c, vec3(2.2)); }
  vec3 toSrgb(vec3 c) { return pow(clamp(c, 0.0, 1.0), vec3(1.0 / 2.2)); }
  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }

  // Stacked stitches pile up, but not without limit.
  float heightAt(vec2 uv) {
    float h = texture(u_heightMap, uv).r * u_load;
    return MAX_H * (1.0 - exp(-h / MAX_H));
  }

  // uv offsets for a step in mm; world y runs down the screen, uv.y up.
  vec2 mmStep(vec2 mm) { return vec2(mm.x, -mm.y) / (u_mmPerPx * u_size); }

  float occlusion(vec2 uv, float h) {
    float sum = 0.0;
    for (int i = 0; i < 8; i++) {
      float a = float(i) * 0.7854 + 0.39;
      vec2 dir = vec2(cos(a), sin(a));
      sum += max(heightAt(uv + mmStep(dir * 0.55)) - h, 0.0);
      sum += max(heightAt(uv + mmStep(dir * 0.22)) - h, 0.0);
    }
    return clamp(1.0 - sum / 16.0 * 2.6, 0.3, 1.0);
  }

  float shadow(vec2 uv, float h) {
    vec2 dir = normalize(u_light.xy);
    float rise = u_light.z / length(u_light.xy);  // light's height gain per mm
    float lit = 1.0;
    for (int i = 1; i <= 6; i++) {
      float d = float(i) * 0.12;
      float blocker = heightAt(uv + mmStep(dir * d)) - h - d * rise;
      lit = min(lit, 1.0 - smoothstep(0.0, 0.05, blocker));
    }
    return mix(0.5, 1.0, lit);
  }

  // Broad shape of the surface (satin bulge, layers) from the height map.
  vec3 surfaceNormal(vec2 uv) {
    float s = max(0.3, u_mmPerPx);
    float dx = heightAt(uv + mmStep(vec2(s, 0.0))) - heightAt(uv - mmStep(vec2(s, 0.0)));
    float dy = heightAt(uv + mmStep(vec2(0.0, s))) - heightAt(uv - mmStep(vec2(0.0, s)));
    return normalize(vec3(-dx / (2.0 * s), -dy / (2.0 * s), 1.0));
  }

  void main() {
    vec2 uv = gl_FragCoord.xy / u_size;
    vec2 world = (vec2(gl_FragCoord.x, u_size.y - gl_FragCoord.y) - u_offset) / u_scale;
    vec3 L = normalize(u_light);
    vec3 V = vec3(0.0, 0.0, 1.0);
    float h = heightAt(uv);
    float ao = occlusion(uv, h);
    float sh = shadow(uv, h);
    // Fine detail (twist, weave) only once it's big enough to see.
    float fine = smoothstep(0.07, 0.025, u_mmPerPx);

    vec4 thread = texture(u_threadColor, uv);
    vec3 color;
    if (thread.a > 0.05) {
      vec4 shape = texture(u_threadShape, uv);
      vec2 t = shape.xy * 2.0 - 1.0;
      float hole = length(t);
      t /= max(hole, 1e-3);
      vec2 out2 = shape.zw * 2.0 - 1.0;
      float q2 = min(dot(out2, out2), 1.0);
      // Round strand, tilted by the broad surface shape.
      vec3 N = normalize(vec3(out2, sqrt(1.0 - q2)) + vec3(surfaceNormal(uv).xy * 0.5, 0.0));
      // The plies twisting around the thread.
      float across = dot(out2, vec2(-t.y, t.x));
      float phase = (thread.a - 0.1) / 0.9;
      float ridge = sin(6.2832 * (2.0 * phase + 1.4 * across));
      N = normalize(N + vec3(t, 0.0) * ridge * 0.18 * fine);

      vec3 T = normalize(vec3(t, 0.0) - N * dot(N, vec3(t, 0.0)));
      vec3 Hv = normalize(L + V);
      float lambert = max(dot(N, L), 0.0);
      float tl = dot(T, L);
      float diffuse = 0.7 * lambert + 0.3 * sqrt(max(1.0 - tl * tl, 0.0));
      // Two sheen lobes along the fiber: a white glint, and a softer one
      // tinted by the thread's color (light that went through the fiber).
      vec3 T1 = normalize(T + N * 0.1);
      vec3 T2 = normalize(T - N * 0.15);
      float h1 = dot(T1, Hv);
      float h2 = dot(T2, Hv);
      float glint = pow(sqrt(max(1.0 - h1 * h1, 0.0)), 70.0);
      float glow = pow(sqrt(max(1.0 - h2 * h2, 0.0)), 22.0);
      float facing = smoothstep(0.0, 0.3, dot(N, L)) * smoothstep(0.6, 1.0, hole);

      vec3 albedo = toLinear(thread.rgb);
      color = albedo * (AMBIENT * ao + SUN * diffuse * sh)
            + (vec3(0.24) * glint + albedo * 0.4 * glow) * facing * sh * ao;
    } else {
      // Plain-weave fabric.
      vec2 p = world / 0.3;
      vec2 cell = floor(p);
      vec2 f = fract(p) - 0.5;
      bool warp = mod(cell.x + cell.y, 2.0) < 1.0;
      vec2 tilt = warp ? vec2(-f.x * 1.4, -f.y * 0.5) : vec2(-f.x * 0.5, -f.y * 1.4);
      vec3 N = normalize(vec3(tilt * fine, 1.0));
      float grain = hash(cell) * 0.08 * fine + hash(floor(world * 3.0)) * 0.03;
      vec3 albedo = toLinear(u_fabric) * (0.95 + grain);
      color = albedo * (AMBIENT * ao + SUN * max(dot(N, L), 0.0) * sh);
    }
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
    gl.bindAttribLocation(program, 0, "a_corner");
    gl.bindAttribLocation(program, 1, "a_seg");
    gl.bindAttribLocation(program, 2, "a_seed");
    gl.bindAttribLocation(program, 3, "a_color");
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
    const uniforms = {};
    for (let i = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS); i--;) {
      const name = gl.getActiveUniform(program, i).name;
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    return { program, uniforms };
  }

  class WebGLRenderer {
    constructor(canvas) {
      const gl = canvas.getContext("webgl2", { antialias: false, preserveDrawingBuffer: true, alpha: false });
      if (!gl) throw new Error("WebGL2 unavailable");
      this.gl = gl;
      this.kind = "webgl";
      this.floatHeights = !!(gl.getExtension("EXT_color_buffer_float") || gl.getExtension("EXT_color_buffer_half_float"));
      this.heightProgram = compile(gl, STITCH_VS, HEIGHT_FS);
      this.threadProgram = compile(gl, STITCH_VS, THREAD_FS);
      this.lightProgram = compile(gl, LIGHT_VS, LIGHT_FS);

      this.vao = gl.createVertexArray();
      gl.bindVertexArray(this.vao);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
      gl.enableVertexAttribArray(0);
      gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
      this.segmentBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.segmentBuffer);
      gl.enableVertexAttribArray(1);
      gl.vertexAttribPointer(1, 4, gl.FLOAT, false, 20, 0);
      gl.vertexAttribDivisor(1, 1);
      gl.enableVertexAttribArray(2);
      gl.vertexAttribPointer(2, 1, gl.FLOAT, false, 20, 16);
      gl.vertexAttribDivisor(2, 1);
      this.colorBuffer = gl.createBuffer();
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
      gl.enableVertexAttribArray(3);
      gl.vertexAttribPointer(3, 4, gl.UNSIGNED_BYTE, true, 4, 0);
      gl.vertexAttribDivisor(3, 1);
      gl.bindVertexArray(null);

      this.targets = null;
      this.count = 0;
      this.maxSize = Math.min(gl.getParameter(gl.MAX_TEXTURE_SIZE), 4096);
    }

    setDesign(design) {
      const gl = this.gl;
      gl.bindBuffer(gl.ARRAY_BUFFER, this.segmentBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, design.segments, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.colorBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, design.segmentColors, gl.STATIC_DRAW);
      this.count = design.segmentCount;
    }

    texture(internalFormat, format, type, filter, w, h) {
      const gl = this.gl;
      const tex = gl.createTexture();
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texImage2D(gl.TEXTURE_2D, 0, internalFormat, w, h, 0, format, type, null);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return tex;
    }

    makeTargets(w, h) {
      const gl = this.gl;
      if (this.targets && this.targets.w === w && this.targets.h === h) return;
      if (this.targets) {
        for (const t of this.targets.textures) gl.deleteTexture(t);
        gl.deleteFramebuffer(this.targets.heightFb);
        gl.deleteFramebuffer(this.targets.threadFb);
      }
      const heightFb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, heightFb);
      let height = null;
      if (this.floatHeights) {
        height = this.texture(gl.R16F, gl.RED, gl.HALF_FLOAT, gl.LINEAR, w, h);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, height, 0);
        if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) {
          gl.deleteTexture(height);
          height = null;
          this.floatHeights = false;
        }
      }
      if (!height) {
        height = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.LINEAR, w, h);
        gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, height, 0);
      }
      const threadFb = gl.createFramebuffer();
      gl.bindFramebuffer(gl.FRAMEBUFFER, threadFb);
      const color = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, w, h);
      const shape = this.texture(gl.RGBA8, gl.RGBA, gl.UNSIGNED_BYTE, gl.NEAREST, w, h);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, color, 0);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, shape, 0);
      gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      this.targets = { w, h, heightFb, threadFb, height, color, shape, textures: [height, color, shape] };
    }

    stitchUniforms(p, scale, offset, w, h) {
      const gl = this.gl;
      gl.useProgram(p.program);
      gl.uniform1f(p.uniforms.u_scale, scale);
      gl.uniform2f(p.uniforms.u_offset, offset[0], offset[1]);
      gl.uniform2f(p.uniforms.u_size, w, h);
      gl.uniform1f(p.uniforms.u_radius, THREAD_RADIUS);
    }

    render({ width, height, scale, offset, fabric, light }) {
      const gl = this.gl;
      if (gl.isContextLost()) return;
      this.makeTargets(width, height);
      const t = this.targets;
      gl.viewport(0, 0, width, height);
      gl.bindVertexArray(this.vao);

      // 1. Height map: every stitch adds its ridge.
      const store = this.floatHeights ? 1 : 1 / HEIGHT_RANGE;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.heightFb);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      this.stitchUniforms(this.heightProgram, scale, offset, width, height);
      gl.uniform1f(this.heightProgram.uniforms.u_height, THREAD_HEIGHT);
      gl.uniform1f(this.heightProgram.uniforms.u_store, store);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
      gl.disable(gl.BLEND);

      // 2. Thread: the last stitch sewn over each pixel wins, as on fabric.
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.threadFb);
      gl.clearBufferfv(gl.COLOR, 0, [0, 0, 0, 0]);
      gl.clearBufferfv(gl.COLOR, 1, [0, 0, 0, 0]);
      this.stitchUniforms(this.threadProgram, scale, offset, width, height);
      gl.uniform1f(this.threadProgram.uniforms.u_twist, TWIST_PERIOD);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, this.count);
      gl.bindVertexArray(null);

      // 3. Light it.
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
      const p = this.lightProgram;
      gl.useProgram(p.program);
      [t.height, t.color, t.shape].forEach((tex, i) => {
        gl.activeTexture(gl.TEXTURE0 + i);
        gl.bindTexture(gl.TEXTURE_2D, tex);
      });
      gl.uniform1i(p.uniforms.u_heightMap, 0);
      gl.uniform1i(p.uniforms.u_threadColor, 1);
      gl.uniform1i(p.uniforms.u_threadShape, 2);
      gl.uniform2f(p.uniforms.u_size, width, height);
      gl.uniform1f(p.uniforms.u_mmPerPx, 1 / scale);
      gl.uniform1f(p.uniforms.u_load, 1 / store);
      gl.uniform3f(p.uniforms.u_light, ...light);
      gl.uniform3f(p.uniforms.u_fabric, ...fabric.map((c) => c / 255));
      gl.uniform1f(p.uniforms.u_scale, scale);
      gl.uniform2f(p.uniforms.u_offset, offset[0], offset[1]);
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
        ctx.lineWidth = Math.max(THREAD_RADIUS * 2, px);
        ctx.stroke(path);
        ctx.strokeStyle = tone(rgb, 1.12);
        ctx.lineWidth = Math.max(THREAD_RADIUS * 0.9, px * 0.5);
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
      let ss = dpr >= 2 ? 1.25 : 2;
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

  window.StitchView = { parse, View };
})();
