'use strict';
// Downloads behind an HTTP(S) proxy, without extra packages.
//
// VS Code's extension host already routes an extension's https requests through
// the proxy it resolves (http.proxySupport "override", the default: http.proxy,
// else the system/PAC proxy). That covers most setups. This module adds the case it
// can't: an explicit proxy (http.proxy or HTTPS_PROXY) when VS Code's routing is off
// or absent (http.proxySupport "off", plain Node in tests). It tunnels with HTTP
// CONNECT and then speaks TLS to the real host through the tunnel, honouring
// http.proxyStrictSSL for the certificate check (proxies that inspect TLS
// re-sign certificates with their own authority).

const http = require('http');
const https = require('https');
const tls = require('tls');

/**
 * The proxy URL for target, or null. settings: { proxy: http.proxy, env: process.env }.
 * NO_PROXY (comma list of hosts or .domains, or *) excludes targets.
 */
function proxyFor(target, { proxy, env = process.env } = {}) {
  const host = new URL(target).hostname.toLowerCase();
  const noProxy = String(env.NO_PROXY || env.no_proxy || '').split(/[,\s]+/).map((x) => x.trim().toLowerCase()).filter(Boolean);
  for (const n of noProxy) {
    if (n === '*') return null;
    const bare = n.replace(/^\*?\./, '').replace(/:\d+$/, '');
    if (host === bare || host.endsWith(`.${bare}`)) return null;
  }
  const p = proxy || env.HTTPS_PROXY || env.https_proxy || env.HTTP_PROXY || env.http_proxy || '';
  if (!p) return null;
  return /^[a-z]+:\/\//i.test(p) ? p : `http://${p}`;
}

/**
 * Opens a CONNECT tunnel through proxyUrl to host:port; calls back with the raw socket.
 * The proxy itself may be http:// or https://; credentials in the URL become Basic auth.
 */
function tunnel(proxyUrl, host, port, cb, { timeoutMs = 30000, rejectUnauthorized = true } = {}) {
  const p = new URL(proxyUrl);
  const headers = { Host: `${host}:${port}` };
  if (p.username || p.password) {
    headers['Proxy-Authorization'] = `Basic ${Buffer.from(`${decodeURIComponent(p.username)}:${decodeURIComponent(p.password)}`).toString('base64')}`;
  }
  const mod = p.protocol === 'https:' ? https : http;
  let done = false;
  const finish = (err, sock) => { if (!done) { done = true; cb(err, sock); } };
  const req = mod.request({
    host: p.hostname, port: Number(p.port) || (p.protocol === 'https:' ? 443 : 80), method: 'CONNECT',
    path: `${host}:${port}`, headers, agent: false, rejectUnauthorized,
  });
  req.setTimeout(timeoutMs, () => { req.destroy(new Error(`proxy ${p.host} did not answer for ${timeoutMs / 1000} s`)); });
  req.once('connect', (res, socket) => {
    if (res.statusCode !== 200) {
      socket.destroy();
      finish(new Error(`proxy ${p.host} refused the connection to ${host} (HTTP ${res.statusCode}${res.statusCode === 407 ? ': proxy login needed (put user:password@ in http.proxy)' : ''})`));
      return;
    }
    socket.setTimeout(0);
    finish(null, socket);
  });
  req.once('error', (e) => finish(new Error(`proxy ${p.host}: ${e.message}`)));
  req.end();
}

/** An https.Agent whose connections go through the proxy (one tunnel per connection, no keep-alive). */
class TunnelAgent extends https.Agent {
  constructor(proxyUrl, { strictSSL = true } = {}) {
    super({ keepAlive: false });
    this.proxyUrl = proxyUrl;
    this.strictSSL = strictSSL;
  }

  createConnection(options, cb) {
    const host = options.host || options.hostname;
    const port = Number(options.port) || 443;
    tunnel(this.proxyUrl, host, port, (err, socket) => {
      if (err) { cb(err); return; }
      const s = tls.connect({ socket, servername: options.servername || host, rejectUnauthorized: this.strictSSL, ALPNProtocols: ['http/1.1'] });
      s.once('secureConnect', () => cb(null, s));
      s.once('error', (e) => cb(e));
    }, { rejectUnauthorized: this.strictSSL });
    return undefined;
  }
}

/**
 * agentFor(url) for src/setup.js: a TunnelAgent when a proxy applies, else undefined
 * (direct, or VS Code's own proxy routing). cfg: { proxy, strictSSL, proxySupport, env }.
 * With http.proxySupport "override" or "on" and no explicit proxy, VS Code routes it.
 */
function agentFactory(cfg = {}) {
  const cache = new Map();
  return (url) => {
    const p = proxyFor(url, cfg);
    if (!p) return undefined;
    if (!cache.has(p)) cache.set(p, new TunnelAgent(p, { strictSSL: cfg.strictSSL !== false }));
    return cache.get(p);
  };
}

/** Is this download error the network being blocked (no connection, proxy, TLS inspection), not a bad file? */
function looksBlocked(err) {
  const m = `${err && err.code || ''} ${err && err.message || err}`;
  return /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EHOSTUNREACH|ENETUNREACH|proxy|certificate|self.signed|UNABLE_TO|CERT_|no response|no data|HTTP (403|407|451|5\d\d)/i.test(m);
}

module.exports = { proxyFor, tunnel, TunnelAgent, agentFactory, looksBlocked };
