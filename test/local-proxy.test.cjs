const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const net = require('net');
const https = require('https');
const http = require('http');
const os = require('os');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { createProxy, allowedHost, modifyHTML, localScript } = require('../standalone/service/local-proxy');

// Throwaway fixtures generated per run: a synthetic CA, two leaf certificates, and a pinned script.
const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-proxy-fixtures-'));
process.on('exit', () => fs.rmSync(fixtureDir, { recursive: true, force: true }));

function openssl(...a) {
  execFileSync('openssl', a, { cwd: fixtureDir, stdio: 'ignore' });
}

openssl(
  'req',
  '-x509',
  '-newkey',
  'rsa:2048',
  '-nodes',
  '-sha256',
  '-days',
  '2',
  '-subj',
  '/CN=TizenTube Test CA',
  '-keyout',
  'ca.key',
  '-out',
  'ca.crt'
);

for (const h of ['www.youtube.com', 'youtube.com']) {
  openssl('req', '-new', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-subj', '/CN=' + h, '-keyout', h + '.key', '-out', h + '.csr');
  fs.writeFileSync(
    path.join(fixtureDir, h + '.ext'),
    'basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:' +
      h +
      '\n'
  );
  openssl(
    'x509',
    '-req',
    '-in',
    h + '.csr',
    '-CA',
    'ca.crt',
    '-CAkey',
    'ca.key',
    '-CAcreateserial',
    '-days',
    '2',
    '-sha256',
    '-extfile',
    h + '.ext',
    '-out',
    h + '.crt'
  );
}

const base = fixtureDir;
const script = Buffer.from('/* test userscript */');
fs.writeFileSync(path.join(base, 'userscript.js'), script);
fs.writeFileSync(
  path.join(base, 'build.json'),
  JSON.stringify({
    userscript_sha256: crypto.createHash('sha256').update(script).digest('hex'),
    version: 'test'
  })
);

const ca = fs.readFileSync(path.join(fixtureDir, 'ca.crt'));
const credentials = {};
for (const h of ['www.youtube.com', 'youtube.com']) {
  credentials[h] = {
    key: fs.readFileSync(path.join(fixtureDir, h + '.key')),
    cert: fs.readFileSync(path.join(fixtureDir, h + '.crt'))
  };
}

function listen(s, host = '127.0.0.1') {
  return new Promise((resolve, reject) => {
    s.once('error', reject);
    s.listen(0, host, () => resolve(s.address().port));
  });
}

function ready(s) {
  return s.listening
    ? Promise.resolve()
    : new Promise((a, b) => {
        s.once('listening', a);
        s.once('error', b);
      });
}

function close(s) {
  return new Promise(r => s.close(r));
}

function connect(port, target) {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1');
    let b = Buffer.alloc(0);
    s.on('error', reject);
    s.on('connect', () => s.write('CONNECT ' + target + ' HTTP/1.1\r\nHost: ' + target + '\r\n\r\n'));
    function data(x) {
      b = Buffer.concat([b, x]);
      let i = b.indexOf('\r\n\r\n');
      if (i < 0) return;
      s.removeListener('data', data);
      s.pause();
      let rest = b.subarray(i + 4);
      if (rest.length) s.unshift(rest);
      resolve({ s, head: b.subarray(0, i).toString() });
    }
    s.on('data', data);
  });
}

async function request(port, pathname, cookie, body) {
  const tls = require('tls');
  const c = await connect(port, 'www.youtube.com:443');
  assert.match(c.head, /200/);
  const agent = new https.Agent({ keepAlive: false });
  agent.createConnection = (_o, cb) => {
    const s = tls.connect({ socket: c.s, servername: 'www.youtube.com', ca }, () => cb(null, s));
    s.on('error', cb);
    c.s.resume();
  };
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        hostname: 'www.youtube.com',
        path: pathname,
        method: body === undefined ? 'GET' : 'POST',
        agent,
        maxHeaderSize: 1024 * 1024,
        headers: cookie ? { cookie } : {}
      },
      res => {
        let b = [];
        res.on('data', x => b.push(x));
        res.on('end', () => {
          agent.destroy();
          resolve({ code: res.statusCode, headers: res.headers, body: Buffer.concat(b).toString() });
        });
      }
    );
    r.on('error', reject);
    r.end(body);
  });
}

test('allowlist rejects suffix tricks, IPs and local targets', () => {
  for (const h of [
    'youtube.com.evil.com',
    'notyoutube.com',
    'localhost',
    '127.0.0.1',
    '192.0.2.10',
    'youtube.com.',
    'youtube.com@evil.com'
  ]) {
    assert.equal(allowedHost(h), false, h);
  }
  for (const h of ['www.youtube.com', 'youtube.com', 'r1.googlevideo.com', 'accounts.google.com']) {
    assert.equal(allowedHost(h), true, h);
  }
});

test('HTML injection preserves CSP nonce and refuses incompatible HTML', () => {
  const x = modifyHTML(Buffer.from('<body><script nonce="test-nonce"></script></body>'), undefined, true);
  assert.match(x, /nonce="test-nonce" src="https:\/\/www.youtube.com\//);
  assert.throws(() => modifyHTML(Buffer.from('<body></body>'), undefined, true));
  assert.throws(() => modifyHTML(Buffer.from('<body></body>'), 'br', false));
});

test('live loopback proxy: cookies and CSP preserved, local script pinned, SSRF and TLS attacks rejected', async () => {
  let seenCookie;
  let trust = true;
  let wrongName = false;
  const up = https.createServer(credentials['www.youtube.com'], (req, res) => {
    seenCookie = req.headers.cookie;
    res.writeHead(200, {
      'x-large-header-fixture': 'a'.repeat(32768),
      'content-type': 'text/html',
      'content-security-policy': "script-src 'nonce-fixture'; object-src 'none'",
      'set-cookie': '__Secure-SESSION=fixture; Secure; HttpOnly; SameSite=Lax'
    });
    res.end('<body><script nonce="fixture"></script></body>');
  });
  const upstreamPort = await listen(up);
  const p = createProxy({
    port: 0,
    bindHost: '127.0.0.1',
    credentials,
    script: path.join(base, 'userscript.js'),
    manifest: path.join(base, 'build.json'),
    httpsRequest: (o, cb) => {
      assert.equal(o.rejectUnauthorized, true);
      assert.equal(o.hostname, 'www.youtube.com');
      return require('../standalone/service/bounded-https').request(
        {
          ...o,
          hostname: '127.0.0.1',
          port: upstreamPort,
          servername: wrongName ? 'wrong.invalid' : 'www.youtube.com',
          ca: trust ? ca : undefined
        },
        cb
      );
    }
  });
  try {
    await ready(p.server);
    assert.equal(p.server.address().address, '127.0.0.1');
    const port = p.server.address().port;
    const r = await request(port, '/tv', '__Secure-SESSION=fixture');
    assert.equal(r.code, 200);
    assert.equal(seenCookie, '__Secure-SESSION=fixture');
    assert.match(r.headers['set-cookie'][0], /Secure; HttpOnly/);
    assert.equal(r.headers['content-security-policy'], "script-src 'nonce-fixture'; object-src 'none'");
    assert.match(r.body, /__tizentube_local__/);

    const local = await request(port, localScript);
    assert.equal(local.code, 200);
    assert.equal(local.body, fs.readFileSync(path.join(base, 'userscript.js'), 'utf8'));
    assert.equal(p.stats.script_requests, 1);

    for (const target of ['127.0.0.1:443', 'youtube.com:80', 'youtube.com.evil.com:443']) {
      const c = await connect(port, target);
      assert.match(c.head, /403/);
      c.s.destroy();
    }
    const status = await new Promise((a, b) =>
      http
        .get({ hostname: '127.0.0.1', port, path: 'http://192.0.2.1/' }, r => {
          r.resume();
          r.on('end', () => a(r.statusCode));
        })
        .on('error', b)
    );
    assert.equal(status, 403);
    trust = false;
    assert.equal((await request(port, '/tv')).code, 502);
    trust = true;
    wrongName = true;
    assert.equal((await request(port, '/tv')).code, 502);
    assert.equal(p.stats.tls_errors, 2);
  } finally {
    await close(p.server);
    await close(up);
  }
});

test('QA stays private-file gated and records only bounded numeric metrics', async () => {
  const data = fs.mkdtempSync(path.join(os.tmpdir(), 'tt-qa-'));
  const p = createProxy({
    data,
    port: 0,
    bindHost: '127.0.0.1',
    credentials,
    script: path.join(base, 'userscript.js'),
    manifest: path.join(base, 'build.json'),
    httpsRequest: () => {
      throw new Error('QA must not be forwarded');
    }
  });
  try {
    await ready(p.server);
    const port = p.server.address().port;
    const u = '/__tizentube_local__/qa';
    assert.equal((await request(port, u)).code, 404);
    for (const q of [
      { clip: 'other', expires: Date.now() + 5000 },
      { clip: 'TESTCLIP001', expires: Date.now() + 1000000 },
      { clip: 'TESTCLIP001', expires: 0 }
    ]) {
      fs.writeFileSync(path.join(data, 'qa-enable.json'), JSON.stringify(q));
      assert.equal((await request(port, u)).code, 404);
    }
    fs.writeFileSync(path.join(data, 'qa-enable.json'), JSON.stringify({ clip: 'TESTCLIP001', expires: Date.now() + 60000 }));
    assert.equal((await request(port, u)).code, 200);
    const m = { kind: 2, at: Date.now(), width: 1280, height: 720, rate: 2, time: 45, ready: 4, dropped: 3, total: 900, phase: 1 };
    assert.equal((await request(port, u, null, JSON.stringify(m))).code, 204);
    const saved = JSON.parse(fs.readFileSync(path.join(data, 'qa-metrics.jsonl'), 'utf8'));
    assert.equal(saved.height, 720);
    assert.equal(saved.dropped, 3);
    for (const bad of [
      { ...m, rate: 'secret' },
      { ...m, note: 'free text' },
      { ...m, kind: 9 },
      { ...m, ['bad-key']: 1 },
      { ...m, rate: -1 },
      [1, 2],
      Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['k' + i, 1]))
    ]) {
      assert.equal((await request(port, u, null, JSON.stringify(bad))).code, 400);
    }
    assert.equal(fs.readFileSync(path.join(data, 'qa-metrics.jsonl'), 'utf8').trim().split('\n').length, 1);
    fs.unlinkSync(path.join(data, 'qa-enable.json'));
    assert.equal((await request(port, u)).code, 404);
  } finally {
    await close(p.server);
    fs.rmSync(data, { recursive: true, force: true });
  }
});
