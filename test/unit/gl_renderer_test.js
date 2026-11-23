'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const VpeGlRenderer = require('../../media/gl-renderer');
const H = require('../../media/hdr');

const {
  GLRenderer,
  create,
  setCapture,
  matrixBySize,
  yuvMatrix,
  transferParams,
  BT2020_TO_709_COL_MAJOR,
  IDENTITY_3X3,
} = VpeGlRenderer;

const near = (a, b, tol, what) => assert.ok(Math.abs(a - b) <= tol, `${what}: ${a} vs ${b} (tol ${tol})`);
const nearAll = (a, b, tol, what) => a.forEach((v, i) => near(v, b[i], tol, `${what}[${i}]`));

const GL_CONST = {
  VERTEX_SHADER: 0x8b31,
  FRAGMENT_SHADER: 0x8b30,
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ARRAY_BUFFER: 0x8892,
  STATIC_DRAW: 0x88e4,
  FLOAT: 0x1406,
  TEXTURE0: 0x84c0,
  TEXTURE3: 0x84c3,
  TEXTURE_2D: 0x0de1,
  TEXTURE_MIN_FILTER: 0x2801,
  TEXTURE_MAG_FILTER: 0x2800,
  TEXTURE_WRAP_S: 0x2802,
  TEXTURE_WRAP_T: 0x2803,
  LINEAR: 0x2601,
  CLAMP_TO_EDGE: 0x812f,
  UNPACK_ALIGNMENT: 0x0cf5,
  UNPACK_ROW_LENGTH: 0x0cf2,
  R8: 0x8229,
  R16_EXT: 0x822a,
  RED: 0x1903,
  RGBA: 0x1908,
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_SHORT: 0x1403,
  TRIANGLE_STRIP: 0x0005,
};

function makeMockGl({ norm16 = true, compileOk = true } = {}) {
  let nextId = 1;
  let activeUnit = 0;
  let boundTex = null;
  let rowLength = 0;
  let alignment = 4;
  let lostCount = 0;
  const shaders = new Set();
  const deletedShaders = [];
  const programs = new Set();
  const deletedPrograms = [];
  const buffers = new Set();
  const deletedBuffers = [];
  const textures = new Set();
  const deletedTextures = [];
  const storages = [];
  const subUploads = [];
  const imageUploads = [];
  const uniforms = new Map();
  const uniformHistory = [];
  const viewports = [];
  const draws = [];
  const colorMasks = [];
  let flushes = 0;

  const loseExt = { loseContext() { lostCount++; } };
  const norm16Ext = norm16 ? { R16_EXT: GL_CONST.R16_EXT } : null;

  const gl = {
    ...GL_CONST,
    createShader(type) {
      const s = { id: nextId++, kind: 'shader', type, src: '' };
      shaders.add(s);
      return s;
    },
    shaderSource(s, src) { s.src = src; },
    compileShader() {},
    getShaderParameter() { return compileOk; },
    getShaderInfoLog() { return 'mock compile error'; },
    deleteShader(s) {
      shaders.delete(s);
      deletedShaders.push(s);
    },
    createProgram() {
      const p = { id: nextId++, kind: 'program', shaders: [] };
      programs.add(p);
      return p;
    },
    attachShader(p, s) { p.shaders.push(s); },
    linkProgram() {},
    useProgram() {},
    deleteProgram(p) {
      programs.delete(p);
      deletedPrograms.push(p);
    },
    createBuffer() {
      const b = { id: nextId++, kind: 'buffer' };
      buffers.add(b);
      return b;
    },
    bindBuffer() {},
    bufferData() {},
    deleteBuffer(b) {
      buffers.delete(b);
      deletedBuffers.push(b);
    },
    getAttribLocation() { return 0; },
    enableVertexAttribArray() {},
    vertexAttribPointer() {},
    createTexture() {
      const t = { id: nextId++, kind: 'texture' };
      textures.add(t);
      return t;
    },
    deleteTexture(t) {
      textures.delete(t);
      deletedTextures.push(t);
    },
    activeTexture(u) { activeUnit = u - GL_CONST.TEXTURE0; },
    bindTexture(_target, t) { boundTex = t; },
    texParameteri() {},
    texStorage2D(_target, levels, internalFormat, width, height) {
      storages.push({ unit: activeUnit, tex: boundTex, levels, internalFormat, width, height });
    },
    texSubImage2D(_target, level, x, y, width, height, format, type, srcData, srcOffset) {
      subUploads.push({
        unit: activeUnit,
        tex: boundTex,
        level,
        x,
        y,
        width,
        height,
        format,
        type,
        srcData,
        srcOffset,
        rowLength,
        alignment,
      });
    },
    texImage2D(_target, level, internalFormat, format, type, source) {
      imageUploads.push({
        unit: activeUnit,
        tex: boundTex,
        level,
        internalFormat,
        format,
        type,
        source,
      });
    },
    getUniformLocation(_prog, name) { return { name }; },
    uniform1i(loc, v) {
      uniforms.set(loc.name, v);
      uniformHistory.push([loc.name, v]);
    },
    uniform1f(loc, v) {
      uniforms.set(loc.name, v);
      uniformHistory.push([loc.name, v]);
    },
    uniform3fv(loc, v) {
      const arr = [...v];
      uniforms.set(loc.name, arr);
      uniformHistory.push([loc.name, arr]);
    },
    uniformMatrix3fv(loc, transpose, v) {
      const arr = [...v];
      uniforms.set(loc.name, arr);
      uniformHistory.push([loc.name, arr, transpose]);
    },
    getExtension(name) {
      if (name === 'EXT_texture_norm16') return norm16Ext;
      if (name === 'WEBGL_lose_context') return loseExt;
      return null;
    },
    pixelStorei(pname, param) {
      if (pname === GL_CONST.UNPACK_ROW_LENGTH) rowLength = param;
      if (pname === GL_CONST.UNPACK_ALIGNMENT) alignment = param;
    },
    viewport(x, y, w, h) { viewports.push([x, y, w, h]); },
    colorMask(r, g, b, a) { colorMasks.push([r, g, b, a]); },
    drawArrays(mode, first, count) { draws.push([mode, first, count]); },
    flush() { flushes++; },
  };

  const canvas = {
    width: 0,
    height: 0,
    attrs: null,
    getContext(id, attrs) {
      assert.equal(id, 'webgl2');
      this.attrs = attrs;
      return gl;
    },
  };

  return {
    gl,
    canvas,
    state: {
      shaders,
      deletedShaders,
      programs,
      deletedPrograms,
      buffers,
      deletedBuffers,
      textures,
      deletedTextures,
      storages,
      subUploads,
      imageUploads,
      uniforms,
      uniformHistory,
      viewports,
      draws,
      colorMasks,
      get flushes() { return flushes; },
      get rowLength() { return rowLength; },
      get alignment() { return alignment; },
      get lostCount() { return lostCount; },
    },
  };
}

// ---- UMD / dual browser+CommonJS loading -----------------------------------------------------
{
  const src = fs.readFileSync(path.join(__dirname, '../../media/gl-renderer.js'), 'utf8');
  const ctx = {};
  ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(src, ctx);
  assert.equal(typeof ctx.VpeGlRenderer.GLRenderer, 'function');
  assert.equal(typeof ctx.VpeGlRenderer.create, 'function');
  assert.equal(typeof ctx.VpeGlRenderer.setCapture, 'function');
  assert.equal(ctx.VpeGlRenderer.matrixBySize(1280, 720), 709);
  assert.equal(ctx.VpeGlRenderer.matrixBySize(640, 480), 601);
}

// ---- WebGL2 missing or shader compile failure ------------------------------------------------
{
  assert.throws(() => create({ width: 0, height: 0, getContext: () => null }), /WebGL2 is not available/);
  const { canvas } = makeMockGl({ compileOk: false });
  assert.throws(() => create(canvas), /mock compile error/);
}

// ---- Plane upload paths: 8-bit 4:2:0, 4:2:2, 4:4:4, 10-bit P010/planar, VideoFrame -----------
{
  const { canvas, state } = makeMockGl();
  const r = create(canvas);
  assert.deepEqual(canvas.attrs, { preserveDrawingBuffer: true, alpha: false, antialias: false });
  assert.equal(state.alignment, 1);
  assert.equal(state.textures.size, 4, 'ty, tu, tv, trgb initialized');

  // 1) 8-bit YUV420p with padded strides and odd dimensions (63x35 -> chroma 32x18).
  const raw8 = new Uint8Array(4096);
  const frame8 = {
    width: 63,
    height: 35,
    depth: 8,
    cw: 1,
    ch: 1,
    data: raw8,
    layout: [
      { offset: 16, stride: 64 },
      { offset: 2300, stride: 32 },
      { offset: 2900, stride: 32 },
    ],
  };
  state.storages.length = 0;
  state.subUploads.length = 0;
  r.drawYuv(frame8);

  assert.equal(canvas.width, 63);
  assert.equal(canvas.height, 35);
  assert.deepEqual(state.viewports.at(-1), [0, 0, 63, 35]);
  assert.equal(state.storages.length, 3, 'allocates storage for 3 planes on first draw');
  assert.deepEqual(
    state.storages.map((s) => [s.unit, s.internalFormat, s.width, s.height]),
    [
      [0, GL_CONST.R8, 63, 35],
      [1, GL_CONST.R8, 32, 18],
      [2, GL_CONST.R8, 32, 18],
    ],
  );
  assert.equal(state.subUploads.length, 3);
  for (let i = 0; i < 3; i++) {
    const u = state.subUploads[i];
    assert.equal(u.unit, i);
    assert.equal(u.format, GL_CONST.RED);
    assert.equal(u.type, GL_CONST.UNSIGNED_BYTE);
    assert.strictEqual(u.srcData, raw8, 'zero-copy: uploads directly from frame Uint8Array');
    assert.equal(u.srcOffset, frame8.layout[i].offset);
    assert.equal(u.rowLength, frame8.layout[i].stride);
  }
  assert.equal(state.rowLength, 0, 'UNPACK_ROW_LENGTH reset to 0 after upload');

  // Redrawing same geometry and depth reuses existing texture storage without reallocating.
  state.storages.length = 0;
  r.drawYuv(frame8);
  assert.equal(state.storages.length, 0, 'no texStorage2D reallocation on same size/format');

  // 2) 8-bit YUV422p (cw=1, ch=0) and YUV444p (cw=0, ch=0).
  state.storages.length = 0;
  r.drawYuv({
    width: 64,
    height: 36,
    cw: 1,
    ch: 0,
    data: raw8,
    layout: [{ offset: 0, stride: 64 }, { offset: 2304, stride: 32 }, { offset: 3456, stride: 32 }],
  });
  assert.deepEqual(
    state.storages.map((s) => [s.unit, s.width, s.height]),
    [[0, 64, 36], [1, 32, 36], [2, 32, 36]],
  );

  state.storages.length = 0;
  r.drawYuv({
    width: 64,
    height: 36,
    cw: 0,
    ch: 0,
    data: raw8,
    layout: [{ offset: 0, stride: 64 }, { offset: 0, stride: 64 }, { offset: 0, stride: 64 }],
  });
  assert.deepEqual(
    state.storages.map((s) => [s.unit, s.width, s.height]),
    [[1, 64, 36], [2, 64, 36]],
  );

  // 3) 10-bit (>8-bit) planar upload on a sub-view Uint8Array (non-zero byteOffset):
  // must create a Uint16Array view over the same ArrayBuffer with zero buffer copies.
  const backing16 = new ArrayBuffer(16384);
  const view16 = new Uint8Array(backing16, 128, 8192);
  state.storages.length = 0;
  state.subUploads.length = 0;
  const frame10 = {
    width: 64,
    height: 36,
    depth: 10,
    cw: 1,
    ch: 1,
    data: view16,
    layout: [
      { offset: 0, stride: 160 },
      { offset: 5760, stride: 80 },
      { offset: 7200, stride: 80 },
    ],
  };
  r.drawYuv(frame10);
  assert.deepEqual(
    state.storages.map((s) => [s.unit, s.internalFormat, s.width, s.height]),
    [
      [0, GL_CONST.R16_EXT, 64, 36],
      [1, GL_CONST.R16_EXT, 32, 18],
      [2, GL_CONST.R16_EXT, 32, 18],
    ],
  );
  for (let i = 0; i < 3; i++) {
    const u = state.subUploads[i];
    assert.equal(u.type, GL_CONST.UNSIGNED_SHORT);
    assert.ok(u.srcData instanceof Uint16Array);
    assert.strictEqual(u.srcData.buffer, backing16, 'zero-copy: 16-bit view shares backing ArrayBuffer');
    assert.equal(u.srcData.byteOffset, 128);
    assert.equal(u.srcData.length, 4096);
    assert.equal(u.srcOffset, frame10.layout[i].offset >> 1);
    assert.equal(u.rowLength, frame10.layout[i].stride >> 1);
  }
  near(state.uniforms.get('scale'), 65535 / 1023, 1e-12, '10-bit norm16 scale');

  // 4) WebCodecs VideoFrame upload (mode 1 on TEXTURE3).
  const vf = { displayWidth: 1920, displayHeight: 1080 };
  r.drawFrame(vf);
  assert.equal(canvas.width, 1920);
  assert.equal(canvas.height, 1080);
  assert.equal(state.imageUploads.length, 1);
  assert.equal(state.imageUploads[0].unit, 3);
  assert.strictEqual(state.imageUploads[0].source, vf);
  assert.equal(state.uniforms.get('mode'), 1);
  assert.equal(state.uniforms.get('scale'), 1);
}

// ---- Buffer recycling (heldBuf delayed by one upload, paused redraw safety) ------------------
{
  const { canvas } = makeMockGl();
  const r = create(canvas);
  const recycled = [];
  r.onUploaded = (buf) => recycled.push(buf);

  const makeFrame = (recycle) => {
    const data = new Uint8Array(64);
    return {
      width: 4,
      height: 4,
      recycle,
      data,
      layout: [{ offset: 0, stride: 4 }, { offset: 16, stride: 2 }, { offset: 20, stride: 2 }],
    };
  };
  const f1 = makeFrame(true);
  const f2 = makeFrame(true);
  const fNoRecycle = makeFrame(false);

  r.drawYuv(f1);
  assert.deepEqual(recycled, [], 'first shown frame buffer is held for inspector/compare');
  r.drawYuv(f1);
  assert.deepEqual(recycled, [], 'paused redraw of the same buffer never recycles it early');
  r.drawYuv(f2);
  assert.deepEqual(recycled, [f1.data.buffer], 'previous frame buffer recycled when next frame uploads');
  r.drawYuv(fNoRecycle);
  assert.deepEqual(recycled, [f1.data.buffer, f2.data.buffer], 'non-recyclable frame still releases previous held buffer');
  assert.equal(r.heldBuf, null);
}

// ---- Color space, range, HDR uniforms, twin hook, and rotation/maxPixels resize --------------
{
  const { canvas, state } = makeMockGl();
  const r = create(canvas);
  const twinFrames = [];
  r.twin = (f) => twinFrames.push(f);

  const baseLayout = [{ offset: 0, stride: 4 }, { offset: 16, stride: 2 }, { offset: 20, stride: 2 }];
  const data = new Uint8Array(32);

  // SD untagged -> BT.601 limited range; HD untagged -> BT.709 limited range.
  const sd = yuvMatrix({ width: 640, height: 360 });
  const hd = yuvMatrix({ width: 1280, height: 720 });
  assert.equal(sd.space, 601);
  assert.equal(hd.space, 709);
  assert.notDeepEqual(sd.m, hd.m);

  // Agreement with VpeHdr.yuvParams for 8-bit SDR and 10-bit PQ/HLG HDR.
  for (const sample of [
    { width: 640, height: 360, depth: 8, fullRange: false, space: 601, trc: 1 },
    { width: 1920, height: 1080, depth: 8, fullRange: true, space: 709, trc: 1 },
    { width: 3840, height: 2160, depth: 10, fullRange: false, space: 2020, trc: 16 },
    { width: 3840, height: 2160, depth: 10, fullRange: false, space: 2020, trc: 18 },
  ]) {
    const got = yuvMatrix(sample);
    const ref = H.yuvParams(sample);
    nearAll(got.m, ref.m, 1e-12, `matrix ${JSON.stringify(sample)}`);
    nearAll(got.off, ref.off, 1e-12, `offset ${JSON.stringify(sample)}`);
    near(got.rawScale, ref.scale, 1e-12, `rawScale ${JSON.stringify(sample)}`);
  }

  // HDR PQ with custom peak and BT.2020 primaries (prim=9).
  r.hdrPeak = 4000;
  const pqFrame = {
    width: 1920,
    height: 1080,
    depth: 10,
    space: 2020,
    trc: 16,
    prim: 9,
    data: new Uint8Array(128),
    layout: baseLayout,
  };
  r.drawYuv(pqFrame);
  assert.equal(r.hdr, 16);
  assert.equal(state.uniforms.get('tf'), 1);
  assert.deepEqual(state.uniforms.get('prim'), BT2020_TO_709_COL_MAJOR);
  const top4000 = H.pqInverse(4000);
  const white4000 = H.pqInverse(203) / top4000;
  nearAll(state.uniforms.get('eetf'), [top4000, white4000, 1.5 * white4000 - 0.5], 1e-12, 'PQ 4000-nit EETF');
  assert.strictEqual(twinFrames.at(-1), pqFrame);

  // Drawing another frame with identical (tf, prim, peak) does not re-issue transfer uniforms.
  const histLen = state.uniformHistory.filter(([n]) => n === 'tf' || n === 'eetf' || n === 'prim').length;
  r.drawYuv(pqFrame);
  assert.equal(
    state.uniformHistory.filter(([n]) => n === 'tf' || n === 'eetf' || n === 'prim').length,
    histLen,
    'cached hdrKey skips redundant transfer uniform uploads',
  );

  // HLG (trc=18) uses nominal 1000-nit peak even when hdrPeak is set, and non-2020 prim uses identity.
  r.drawYuv({ ...pqFrame, trc: 18, prim: 1 });
  assert.equal(r.hdr, 18);
  assert.equal(state.uniforms.get('tf'), 2);
  assert.deepEqual(state.uniforms.get('prim'), IDENTITY_3X3);
  const top1000 = H.pqInverse(1000);
  const white1000 = H.pqInverse(203) / top1000;
  nearAll(state.uniforms.get('eetf'), [top1000, white1000, 1.5 * white1000 - 0.5], 1e-12, 'HLG 1000-nit EETF');

  // SDR resets tf and hdr to 0.
  r.drawYuv({ width: 640, height: 360, depth: 8, trc: 1, prim: 1, data, layout: baseLayout });
  assert.equal(r.hdr, 0);
  assert.equal(state.uniforms.get('tf'), 0);

  // drawFrame notifies twin(null).
  r.drawFrame({ displayWidth: 640, displayHeight: 360 });
  assert.equal(twinFrames.at(-1), null);

  // Rotation and maxPixels cap.
  r.setRotation(90);
  assert.equal(r.rot, 90);
  assert.equal(state.uniforms.get('rot'), 90);
  r.size(1920, 1080);
  assert.deepEqual([canvas.width, canvas.height], [1080, 1920], '90 deg rotation swaps canvas width and height');

  r.setRotation(45); // invalid rotation snaps to 0
  assert.equal(r.rot, 0);
  r.maxPixels = 640 * 360;
  r.size(1920, 1080);
  assert.deepEqual([canvas.width, canvas.height], [640, 360], 'maxPixels scales down proportionally');

  // prepareNative allocates 4:2:0 planes and draws masked black warmup quad.
  r.maxPixels = 0;
  const flushesBefore = state.flushes;
  r.prepareNative(1280, 720);
  assert.deepEqual([canvas.width, canvas.height], [1280, 720]);
  assert.deepEqual(state.colorMasks.slice(-2), [[false, false, false, false], [true, true, true, true]]);
  assert.equal(state.flushes, flushesBefore + 1);
}

// ---- Explicit render/capture contract (setCapture / onFrame) ---------------------------------
{
  const { canvas } = makeMockGl();
  const r = create(canvas);
  const captured = [];
  setCapture(r, (frame) => captured.push(frame));

  const yuv = {
    width: 16,
    height: 16,
    data: new Uint8Array(384),
    layout: [{ offset: 0, stride: 16 }, { offset: 256, stride: 8 }, { offset: 320, stride: 8 }],
  };
  r.drawYuv(yuv);
  assert.equal(captured.length, 1);
  assert.strictEqual(captured[0].yuv, yuv, 'capture hook receives exact YUV frame reference without copying');

  const vf = { displayWidth: 16, displayHeight: 16 };
  r.drawFrame(vf);
  assert.equal(captured.length, 2);
  assert.strictEqual(captured[1].vf, vf, 'capture hook receives VideoFrame reference');

  r.dispose();
  assert.equal(captured.length, 3);
  assert.equal(captured[2], null, 'dispose notifies capture listener with null to release retained frames');
}

// ---- Idempotent dispose() and WebGL resource cleanup -----------------------------------------
{
  const { canvas, state } = makeMockGl();
  const r = create(canvas);

  // Trigger plane texture replacement so plane textures are allocated too.
  r.prepareNative(64, 36);
  const liveTextures = state.textures.size;
  assert.equal(liveTextures, 4);
  assert.equal(state.buffers.size, 1);
  assert.equal(state.programs.size, 1);
  assert.equal(state.shaders.size, 2);

  let captureNulls = 0;
  setCapture(r, (f) => { if (f === null) captureNulls++; });

  r.dispose({ loseContext: true });
  assert.equal(r.disposed, true);
  assert.equal(captureNulls, 1);
  assert.equal(state.textures.size, 0, 'all textures deleted');
  assert.equal(state.buffers.size, 0, 'vertex buffer deleted');
  assert.equal(state.programs.size, 0, 'program deleted');
  assert.equal(state.shaders.size, 0, 'shaders deleted');
  assert.equal(state.lostCount, 1, 'loseContext called when requested');

  // Second dispose is a safe no-op; draw calls after dispose do nothing.
  const drawsBefore = state.draws.length;
  r.dispose({ loseContext: true });
  r.drawFrame({ displayWidth: 32, displayHeight: 32 });
  r.drawYuv({
    width: 32,
    height: 32,
    data: new Uint8Array(1536),
    layout: [{ offset: 0, stride: 32 }, { offset: 1024, stride: 16 }, { offset: 1280, stride: 16 }],
  });
  assert.equal(captureNulls, 1, 'capture listener not called twice');
  assert.equal(state.deletedPrograms.length, 1);
  assert.equal(state.deletedBuffers.length, 1);
  assert.equal(state.draws.length, drawsBefore);
  assert.equal(state.lostCount, 2, 'loseContext option still honored if explicitly passed again');
}

console.log('gl renderer checks passed');
