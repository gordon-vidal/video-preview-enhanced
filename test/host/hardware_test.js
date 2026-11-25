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
    const local = hw.gpuCacheKey(undefined, 'workstation', 'win32');
    assert.strictEqual(local, hw.gpuCacheKey('local', 'workstation', 'win32'));
    assert.notStrictEqual(local, hw.gpuCacheKey('wsl', 'workstation', 'win32'));
    assert.notStrictEqual(local, hw.gpuCacheKey(undefined, 'workstation', 'linux'));
    assert.notStrictEqual(hw.gpuCacheKey('ssh-remote', 'alpha', 'linux'), hw.gpuCacheKey('ssh-remote', 'beta', 'linux'));

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

    // ---- Windows registry (reg.exe, tried before PowerShell) ---------------------------
    const CLASS = 'HKEY_LOCAL_MACHINE\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}';
    // adapters: { '0000': { DriverDesc, DriverVersion, ProviderName, MatchingDeviceId } }; fakes `reg query ... /s /v <Value>`.
    const regOut = (adapters, value) => {
      const keys = Object.keys(adapters).filter((k) => adapters[k][value] !== undefined);
      if (!keys.length) return 'End of search: 0 match(es) found.\r\n';
      return `\r\n${keys.map((k) => `${CLASS}\\${k}\r\n    ${value}    REG_SZ    ${adapters[k][value]}\r\n`).join('\r\n')}\r\n` +
        `End of search: ${keys.length} match(es) found.\r\n`;
    };
    const regRunner = (adapters) => async (cmd, args) => {
      if (cmd === 'reg.exe') return { code: 0, stdout: regOut(adapters, args[args.length - 1]), stderr: '' };
      throw new Error('PowerShell must not run when the registry has the GPUs');
    };
    const NV = { DriverDesc: 'NVIDIA GeForce RTX 4070', DriverVersion: '32.0.15.7242', ProviderName: 'NVIDIA', MatchingDeviceId: 'pci\\ven_10de&dev_2786' };
    const INTEL = { DriverDesc: 'Intel(R) UHD Graphics 770', DriverVersion: '31.0.101.4502', ProviderName: 'Intel Corporation', MatchingDeviceId: 'pci\\ven_8086&dev_4688' };
    const AMD = { DriverDesc: 'AMD Radeon RX 7900 XT', DriverVersion: '31.0.21001.1', ProviderName: 'Advanced Micro Devices, Inc.', MatchingDeviceId: 'pci\\ven_1002&dev_744c' };

    calls.length = 0;
    answer = regRunner({ '0001': NV });
    info = await hw.detect();
    assert.deepStrictEqual(info.gpus, [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', driver: '572.42' }]);
    assert.strictEqual(info.nvidiaDriver, '572.42', 'Windows 32.0.15.7242 -> 572.42, as the PowerShell path');
    assert.deepStrictEqual(calls.map((c) => c.cmd), ['reg.exe', 'reg.exe', 'reg.exe', 'reg.exe'], 'registry only, no PowerShell');
    assert.deepStrictEqual(calls[0].args.slice(0, 3), ['query', CLASS.replace('HKEY_LOCAL_MACHINE', 'HKLM'), '/s']);

    answer = regRunner({ '0000': INTEL });
    assert.deepStrictEqual((await hw.detect()).gpus, [{ vendor: 'intel', name: 'Intel(R) UHD Graphics 770', driver: '31.0.101.4502' }]);
    answer = regRunner({ '0000': AMD });
    info = await hw.detect();
    assert.deepStrictEqual(info.gpus.map((x) => x.vendor), ['amd']);
    assert.strictEqual(info.nvidiaDriver, null);

    // iGPU + dGPU, numbered subkeys in order whatever the order of the output; Basic Display / virtual adapters dropped.
    answer = regRunner({
      '0002': { DriverDesc: 'Microsoft Basic Display Adapter', DriverVersion: '10.0.19041.1', ProviderName: 'Microsoft', MatchingDeviceId: 'root\\basicdisplay' },
      '0001': NV,
      '0000': INTEL,
      '0003': { DriverDesc: 'Parsec Virtual Display Adapter', DriverVersion: '1.0', ProviderName: 'Parsec' },
    });
    info = await hw.detect();
    assert.deepStrictEqual(info.gpus.map((x) => x.vendor), ['intel', 'nvidia']);
    assert.strictEqual(info.nvidiaDriver, '572.42');
    assert.strictEqual(info.gpus[1].driver, '572.42');
    assert.strictEqual(info.gpus[0].driver, '31.0.101.4502', 'non-NVIDIA drivers stay as Windows prints them');

    // The vendor falls back to the PCI id when provider and name say nothing; subkeys that are not adapters are ignored.
    answer = regRunner({ '0000': { DriverDesc: 'GeForce Thing', DriverVersion: '31.0.15.3623', ProviderName: 'Contoso', MatchingDeviceId: 'PCI\\VEN_10DE&DEV_1' } });
    info = await hw.detect();
    assert.deepStrictEqual(info.gpus.map((x) => [x.vendor, x.driver]), [['nvidia', '536.23']]);
    assert.deepStrictEqual(hw.parseRegistryGpus({
      DriverDesc: `${CLASS}\\Configuration\\Control\\Video\r\n    DriverDesc    REG_SZ    Bogus\r\n${CLASS}\\0000\r\n    DriverDesc    REG_SZ    Matrox G200\r\n`,
    }), [{ vendor: 'other', name: 'Matrox G200', driver: '' }]);
    assert.deepStrictEqual(hw.parseRegistryGpus({}), []);
    assert.deepStrictEqual(hw.parseRegistryGpus({ DriverDesc: 'ERROR: The system was unable to find the specified registry key or value.' }), []);

    // reg.exe failing, throwing or listing only virtual adapters falls back to PowerShell (same result shape).
    const ps = { Name: 'NVIDIA GeForce RTX 4070', AdapterCompatibility: 'NVIDIA', DriverVersion: '32.0.15.7242' };
    const psAfter = (regAnswer) => async (cmd, args) => (cmd === 'reg.exe' ? regAnswer(cmd, args)
      : { code: 0, stdout: JSON.stringify(ps), stderr: '' });
    const onlyBasic = regRunner({ '0000': { DriverDesc: 'Microsoft Basic Display Adapter', ProviderName: 'Microsoft' } });
    for (const regAnswer of [
      async () => ({ code: 1, stdout: '', stderr: 'ERROR: Access is denied.' }),
      async () => ({ code: -1, stdout: '', stderr: 'ENOENT' }),
      async () => { throw new Error('spawn failed'); },
      async () => ({ code: 0, stdout: 'End of search: 0 match(es) found.', stderr: '' }),
      (cmd, args) => onlyBasic(cmd, args),
    ]) {
      calls.length = 0;
      answer = psAfter(regAnswer);
      info = await hw.detect();
      assert.deepStrictEqual(info.gpus, [{ vendor: 'nvidia', name: 'NVIDIA GeForce RTX 4070', driver: '572.42' }]);
      assert.strictEqual(info.nvidiaDriver, '572.42');
      assert.strictEqual(calls[calls.length - 1].cmd, 'powershell.exe');
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
