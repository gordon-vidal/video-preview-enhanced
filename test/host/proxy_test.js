'use strict';
// node test/host/proxy_test.js: downloads through an HTTP proxy (src/proxy.js) against
// a local CONNECT proxy: proxy choice (http.proxy, HTTPS_PROXY, NO_PROXY), the tunnel,
// proxy login, refusal, and HTTPS through the tunnel with http.proxyStrictSSL on and
// off (needs openssl on PATH for a throwaway certificate; that part is skipped otherwise).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const https = require('https');
const { execFileSync } = require('child_process');
const proxy = require('../../src/proxy');

const listen = (srv) => new Promise((r) => srv.listen(0, '127.0.0.1', () => r(srv.address().port)));

(async () => {
  // ---- which proxy ----------------------------------------------------------------
  const env = { HTTPS_PROXY: 'http://corp:8080', NO_PROXY: 'localhost,.internal.example' };
  assert.strictEqual(proxy.proxyFor('https://github.com/x', { env }), 'http://corp:8080');
  assert.strictEqual(proxy.proxyFor('https://github.com/x', { proxy: 'http://set:3128', env }), 'http://set:3128', 'http.proxy wins');
  assert.strictEqual(proxy.proxyFor('https://github.com/x', { proxy: 'set:3128', env: {} }), 'http://set:3128', 'scheme added');
  assert.strictEqual(proxy.proxyFor('https://a.internal.example/x', { env }), null, 'NO_PROXY domain');
  assert.strictEqual(proxy.proxyFor('https://localhost/x', { env }), null);
  assert.strictEqual(proxy.proxyFor('https://github.com/x', { env: { https_proxy: 'http://low:1', NO_PROXY: '*' } }), null);
  assert.strictEqual(proxy.proxyFor('https://github.com/x', { env: {} }), null, 'no proxy: direct (or VS Code routes it)');
  assert.strictEqual(proxy.agentFactory({ env: {} })('https://github.com/'), undefined);
  const f = proxy.agentFactory({ proxy: 'http://p:1', env: {} });
  assert.ok(f('https://github.com/') instanceof proxy.TunnelAgent);
  assert.strictEqual(f('https://github.com/'), f('https://example.com/'), 'one agent per proxy');
  assert.ok(proxy.looksBlocked(Object.assign(new Error('getaddrinfo ENOTFOUND github.com'), { code: 'ENOTFOUND' })));
  assert.ok(proxy.looksBlocked(new Error('HTTP 407 for https://x')));
  assert.ok(proxy.looksBlocked(new Error('self-signed certificate in certificate chain')));
  assert.ok(!proxy.looksBlocked(new Error('build.zip failed its checksum')));

  // ---- a local CONNECT proxy and a plain target --------------------------------------
  const target = http.createServer((req, res) => res.end(`hello ${req.url}`));
  const tport = await listen(target);
  const seen = [];
  let needAuth = null;
  const prox = http.createServer((req, res) => { res.writeHead(405); res.end(); });
  prox.on('connect', (req, sock) => {
    seen.push({ path: req.url, auth: req.headers['proxy-authorization'] || '' });
    if (needAuth && req.headers['proxy-authorization'] !== needAuth) { sock.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'); return; }
    const [h, p] = req.url.split(':');
    const up = net.connect(Number(p), h, () => { sock.write('HTTP/1.1 200 Connection Established\r\n\r\n'); up.pipe(sock); sock.pipe(up); });
    up.on('error', () => sock.destroy());
  });
  const pport = await listen(prox);
  const purl = `http://127.0.0.1:${pport}`;
  const viaTunnel = (url, host, port) => new Promise((resolve, reject) => {
    proxy.tunnel(url, host, port, (err, s) => {
      if (err) { reject(err); return; }
      let body = '';
      s.on('data', (d) => { body += d; });
      s.on('end', () => resolve(body));
      s.write(`GET /x HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
    });
  });
  try {
    let body = await viaTunnel(purl, '127.0.0.1', tport);
    assert.match(body, /hello \/x/);
    assert.strictEqual(seen[0].path, `127.0.0.1:${tport}`);
    // Proxy login from the URL's user:password.
    needAuth = `Basic ${Buffer.from('me:p@ss').toString('base64')}`;
    await assert.rejects(viaTunnel(purl, '127.0.0.1', tport), /407.*login/);
    body = await viaTunnel(`http://me:p%40ss@127.0.0.1:${pport}`, '127.0.0.1', tport);
    assert.match(body, /hello/);
    needAuth = null;
    // Proxy not there.
    const dead = net.createServer();
    const dport = await listen(dead);
    dead.close();
    await assert.rejects(viaTunnel(`http://127.0.0.1:${dport}`, '127.0.0.1', tport), /proxy 127\.0\.0\.1.*ECONNREFUSED/);

    // ---- HTTPS through the tunnel ------------------------------------------------------
    let haveSsl = true;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vpe_proxy_'));
    try {
      try {
        execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', path.join(dir, 'k.pem'), '-out', path.join(dir, 'c.pem'),
          '-days', '1', '-subj', '/CN=localhost'], { stdio: 'ignore', windowsHide: true });
      } catch { haveSsl = false; }
      if (haveSsl) {
        const tls = https.createServer({ key: fs.readFileSync(path.join(dir, 'k.pem')), cert: fs.readFileSync(path.join(dir, 'c.pem')) }, (req, res) => res.end('secure'));
        const sport = await listen(tls);
        const get = (agent) => new Promise((resolve, reject) => {
          https.get(`https://localhost:${sport}/f`, { agent }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve(b)); }).on('error', reject);
        });
        assert.strictEqual(await get(new proxy.TunnelAgent(purl, { strictSSL: false })), 'secure', 'proxyStrictSSL false: re-signed certificates pass');
        await assert.rejects(get(new proxy.TunnelAgent(purl, { strictSSL: true })), /self.signed|certificate/i, 'proxyStrictSSL true: checked');
        assert.ok(seen.some((s) => s.path === `localhost:${sport}`), 'went through the proxy');
        tls.close();
      }
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
    console.log(`proxy: ok${haveSsl ? '' : ' (HTTPS part skipped: no openssl)'}`);
  } finally {
    target.close();
    prox.close();
  }
})().catch((e) => { console.error(e); process.exit(1); });
