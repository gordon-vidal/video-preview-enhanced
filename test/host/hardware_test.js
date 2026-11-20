'use strict';
// node test/host/hardware_test.js: GPU detection (src/hardware.js) with a faked command runner and a
// faked process.platform: Windows CIM JSON (one GPU, a list, garbage, virtual adapters), Linux lspci,
// macOS system_profiler, NVIDIA driver version conversion, encoder candidates and testEncoders results.
const assert = require('assert');
const path = require('path');

// hardware.js takes `run` from ./ffmpeg: replace it with a script of canned answers.
const ffmpegPath = require.resolve('../../src/ffmpeg');
const real = require(ffmpegPath);
let answer = async () => ({ code: 1, stdout: '', stderr: '' });
const calls = [];
require.cache[ffmpegPath].exports = { ...real, run: (cmd, args, ms) => { calls.push({ cmd, args, ms }); return answer(cmd, args, ms); } };
const hw = require('../../src/hardware');
require.cache[ffmpegPath].exports = real;
delete require.cache[path.resolve(__dirname, '../../src/hardware.js')];

const setPlatform = (p) => Object.defineProperty(process, 'platform', { value: p, configurable: true });
const realPlatform = process.platform;

(async () => {
  try {
    // ---- driver versions ----------------------------------------------------------
    assert.strictEqual(hw.nvidiaFromWindowsVersion('32.0.15.8115'), '581.15');
    assert.strictEqual(hw.nvidiaFromWindowsVersion('31.0.15.3623'), '536.23');
    assert.strictEqual(hw.nvidiaFromWindowsVersion('27.21.14.5671'), '456.71');
    assert.strictEqual(hw.nvidiaFromWindowsVersion('1.2'), null, 'too few digits');
    assert.strictEqual(hw.nvidiaFromWindowsVersion(''), null);
    assert.strictEqual(hw.nvidiaFromWindowsVersion(undefined), null);
    assert.strictEqual(hw.nvidiaFromWindowsVersion('unknown-version'), null, 'non-numeric text (was NaN.ed)');
    assert.strictEqual(hw.nvidiaFromWindowsVersion('32.0.15.0007'), '500.07');
    assert.strictEqual(hw.nvidiaFromWindowsVersion('0.0.0.0.7'), '0.07', 'a major part of zeros prints as 0');

    // ---- Windows --------------------------------------------------------------------
    setPlatform('win32');
    const cim = (v) => async () => ({ code: 0, stdout: typeof v === 'string' ? v : JSON.stringify(v), stderr: '' });
    answer = cim([
      { Name: 'NVIDIA GeForce RTX 4090', AdapterCompatibility: 'NVIDIA', DriverVersion: '32.0.15.8115' },
      { Name: 'Intel(R) UHD Graphics 770', AdapterCompatibility: 'Intel Corporation', DriverVersion: '31.0.101.4502' },
      { Name: 'Microsoft Basic Display Adapter', AdapterCompatibility: 'Microsoft', DriverVersion: '10.0' },
      { Name: 'Parsec Virtual Display', AdapterCompatibility: 'Parsec', DriverVersion: '1' },
      { Name: 'Remote Display Adapter' },
      null,
      { AdapterCompatibility: 'nameless' },
    ]);
    let info = await hw.detect();
    assert.strictEqual(info.os, 'win32');
    assert.deepStrictEqual(info.gpus.map((g) => g.vendor), ['nvidia', 'intel'], 'virtual / basic / nameless entries are dropped');
    assert.strictEqual(info.gpus[0].driver, '581.15');
    assert.strictEqual(info.nvidiaDriver, '581.15');
    assert.strictEqual(info.gpus[1].driver, '31.0.101.4502');
    assert.strictEqual(calls[calls.length - 1].cmd, 'powershell.exe');

    // PowerShell prints one object (not a list) for a single GPU.
    answer = cim({ Name: 'AMD Radeon RX 7900', AdapterCompatibility: 'Advanced Micro Devices, Inc.', DriverVersion: '31.0.21001.1' });
    info = await hw.detect();
    assert.deepStrictEqual(info.gpus.map((g) => g.vendor), ['amd']);
    assert.strictEqual(info.nvidiaDriver, null);

    // NVIDIA with a driver string that is not convertible keeps the raw string; no nvidiaDriver.
    answer = cim({ Name: 'NVIDIA T4', AdapterCompatibility: 'NVIDIA', DriverVersion: 'n/a' });
    info = await hw.detect();
    assert.strictEqual(info.gpus[0].driver, 'n/a');
    assert.strictEqual(info.nvidiaDriver, null);
    // Unknown vendor, Qualcomm, no DriverVersion.
    answer = cim([{ Name: 'Snapdragon X Adreno', AdapterCompatibility: 'Qualcomm' }, { Name: 'Matrox G200', AdapterCompatibility: 'Matrox' }]);
    info = await hw.detect();
    assert.deepStrictEqual(info.gpus.map((g) => [g.vendor, g.driver]), [['qualcomm', ''], ['other', '']]);

    // Garbage, empty output, a failing command and a throwing runner never throw.
    for (const a of [cim('not json {'), cim(''), async () => ({ code: 1, stdout: '', stderr: 'boom' }), async () => { throw new Error('spawn failed'); }]) {
      answer = a;
      info = await hw.detect();
      assert.deepStrictEqual(info.gpus, []);
      assert.strictEqual(info.vaapi, false);
    }

    // ---- Linux ----------------------------------------------------------------------
    setPlatform('linux');
    answer = async () => ({
      code: 0,
      stdout: [
        '00:02.0 "VGA compatible controller" "Intel Corporation" "Alder Lake-S GT1 [UHD Graphics 770]" -r0c -p00 "Dell" "0a50"',
        '01:00.0 "3D controller" "NVIDIA Corporation" "GA104 [GeForce RTX 3070]" -ra1 "Dell" "1234"',
        '00:1f.3 "Audio device" "Intel Corporation" "Alder Lake PCH-P High Definition Audio"',
        '02:00.0 "Display controller" "Advanced Micro Devices, Inc. [AMD/ATI]" "Navi 21"',
        '',
      ].join('\n'),
      stderr: '',
    });
    info = await hw.detect();
    assert.deepStrictEqual(info.gpus.map((g) => g.vendor), ['intel', 'nvidia', 'amd'], 'only VGA / 3D / Display lines');
    assert.ok(/UHD Graphics 770/.test(info.gpus[0].name));
    assert.strictEqual(typeof info.vaapi, 'boolean');
    // lspci missing (spawn error result): nothing found, no throw.
    answer = async () => ({ code: -1, stdout: '', stderr: 'ENOENT' });
    assert.deepStrictEqual((await hw.detect()).gpus, []);

    // ---- macOS ----------------------------------------------------------------------
    setPlatform('darwin');
    answer = cim({ SPDisplaysDataType: [
      { _name: 'Apple M2 Pro', sppci_model: 'Apple M2 Pro', spdisplays_vendor: 'sppci_vendor_Apple' },
      { _name: 'AMD Radeon Pro 5500M' },
    ] });
    info = await hw.detect();
    assert.deepStrictEqual(info.gpus.map((g) => g.vendor), ['apple', 'amd']);
    answer = cim({ SPDisplaysDataType: null });
    assert.deepStrictEqual((await hw.detect()).gpus, [], 'missing list');
    answer = cim('{broken');
    assert.deepStrictEqual((await hw.detect()).gpus, [], 'broken json');

    // ---- other platform -------------------------------------------------------------
    setPlatform('freebsd');
    info = await hw.detect();
    assert.deepStrictEqual(info.gpus, []);
    assert.strictEqual(info.os, 'freebsd');
  } finally { setPlatform(realPlatform); }

  // ---- candidateEncoders --------------------------------------------------------
  const g = (...vendors) => ({ gpus: vendors.map((vendor) => ({ vendor })) });
  assert.deepStrictEqual(hw.candidateEncoders({ os: 'win32', ...g() }), []);
  assert.deepStrictEqual(hw.candidateEncoders({ os: 'win32', ...g('nvidia', 'intel', 'amd') }), ['h264_nvenc', 'h264_qsv', 'h264_amf']);
  assert.deepStrictEqual(hw.candidateEncoders({ os: 'linux', ...g('amd'), vaapi: false }), [], 'AMF is Windows-only; no VAAPI device');
  assert.deepStrictEqual(hw.candidateEncoders({ os: 'linux', ...g('amd'), vaapi: true }), ['h264_vaapi']);
  assert.deepStrictEqual(hw.candidateEncoders({ os: 'darwin', ...g('apple') }), ['h264_videotoolbox']);
  assert.deepStrictEqual(hw.candidateEncoders({ os: 'darwin', ...g('amd') }), ['h264_videotoolbox']);
  assert.deepStrictEqual(hw.candidateEncoders({ os: 'win32', ...g('qualcomm') }), ['h264_mf']);
  assert.deepStrictEqual(hw.candidateEncoders({ os: 'linux', ...g('qualcomm') }), []);
  assert.deepStrictEqual(hw.candidateEncoders({ os: 'win32', ...g('other') }), []);

  // ---- testEncoders -----------------------------------------------------------------
  calls.length = 0;
  const msg = '[h264_nvenc @ 0x1] Driver does not support the required nvenc API version';
  answer = async (cmd, args) => {
    const enc = args[args.indexOf('-c:v') + 1];
    if (enc === 'h264_nvenc') return { code: 1, stdout: '', stderr: `${msg}\r\nError initializing output stream\r\n` };
    if (enc === 'h264_qsv') return { code: 3, stdout: '', stderr: '' };
    if (enc === 'h264_amf') return { code: 1, stdout: '', stderr: 'some harmless banner line\nthe second line\n' };
    return { code: 0, stdout: '', stderr: '' };
  };
  const res = await hw.testEncoders('ffmpeg-x', ['h264_nvenc', 'h264_qsv', 'h264_amf', 'h264_vaapi', 'h264_videotoolbox']);
  assert.strictEqual(res.h264_nvenc.ok, false);
  assert.strictEqual(res.h264_nvenc.error, 'Driver does not support the required nvenc API version', 'the keyword line, without its [component] prefix');
  assert.strictEqual(res.h264_qsv.error, 'exit 3', 'no output: the exit code');
  assert.strictEqual(res.h264_amf.error, 'some harmless banner line', 'no keyword line: the first line');
  assert.strictEqual(res.h264_vaapi.ok, true);
  assert.ok(res.h264_vaapi.ms >= 0);
  const argsOf = (enc) => calls.find((c) => c.args.includes(enc)).args;
  assert.ok(argsOf('h264_vaapi').includes('-vaapi_device') && argsOf('h264_vaapi').includes('format=nv12,hwupload'), 'VAAPI needs a device and hwupload');
  assert.ok(argsOf('h264_qsv').includes('nv12'), 'QSV takes nv12');
  assert.ok(argsOf('h264_nvenc').includes('yuv420p'));
  assert.deepStrictEqual(await hw.testEncoders('ffmpeg-x', []), {});
  console.log('hardware: ok');
})().catch((e) => { console.error(e); process.exit(1); });
