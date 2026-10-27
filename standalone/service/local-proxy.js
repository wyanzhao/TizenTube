'use strict';

// Loopback-only local YouTube proxy for Samsung Tizen Cobalt.
// Intercepts TLS strictly for youtube.com / www.youtube.com to inject the SHA-256-pinned
// local userscript while tunneling other allowlisted Google media/auth hosts transparently.
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('./bounded-https');
var net = require('net');
var tls = require('tls');
var crypto = require('crypto');
var zlib = require('zlib');

var LOCAL_SCRIPT = '/__tizentube_local__/userscript.js';
var ROOTS = [
  'youtube.com',
  'googlevideo.com',
  'ytimg.com',
  'ggpht.com',
  'gstatic.com',
  'googleusercontent.com',
  'googleapis.com'
];
var EXACT = [
  'accounts.google.com',
  'clients1.google.com',
  'clients2.google.com',
  'clients3.google.com',
  'clients4.google.com',
  'www.google.com'
];

function allowedHost(host) {
  if (typeof host !== 'string' || !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host)) {
    return false;
  }
  var matchesRoot = ROOTS.some(function (r) {
    return host === r || host.slice(-(r.length + 1)) === '.' + r;
  });
  return matchesRoot || EXACT.indexOf(host) !== -1;
}

function modifyHTML(bytes, encoding, nonceRequired) {
  if (encoding === 'gzip') {
    bytes = zlib.gunzipSync(bytes);
  } else if (encoding === 'deflate') {
    bytes = zlib.inflateSync(bytes);
  } else if (encoding && encoding !== 'identity') {
    throw new Error('Unsupported upstream encoding');
  }
  if (bytes.length > 8 * 1024 * 1024) {
    throw new Error('HTML size limit');
  }
  var text = bytes.toString('utf8');
  var m = /<script\b[^>]*\bnonce=["']([a-zA-Z0-9+/_=-]+)["']/i.exec(text);
  if (nonceRequired && !m) {
    throw new Error('No compatible CSP nonce');
  }
  var script = '<script' + (m ? ' nonce="' + m[1] + '"' : '') + ' src="https://www.youtube.com' + LOCAL_SCRIPT + '"></script>';
  if (text.indexOf('</body>') === -1) {
    throw new Error('No HTML insertion point');
  }
  return text.replace('</body>', script + '</body>');
}

function safeHeaders(headers, host) {
  var out = {};
  var blocked = [
    'host',
    'connection',
    'proxy-connection',
    'proxy-authorization',
    'proxy-authenticate',
    'keep-alive',
    'upgrade',
    'transfer-encoding'
  ];
  Object.keys(headers).forEach(function (k) {
    if (blocked.indexOf(k.toLowerCase()) < 0) {
      out[k] = headers[k];
    }
  });
  if (host) {
    out.host = host;
  }
  out.connection = 'close';
  return out;
}

function createProxy(options) {
  var opts = options || {};
  var data = opts.data;
  var port = opts.port === undefined ? 8101 : opts.port;
  var bindHost = opts.bindHost || '127.0.0.2';
  if (['127.0.0.1', '127.0.0.2'].indexOf(bindHost) === -1) {
    throw new Error('Loopback bind required');
  }

  var script = fs.readFileSync(opts.script);
  var manifest = JSON.parse(fs.readFileSync(opts.manifest, 'utf8'));
  if (crypto.createHash('sha256').update(script).digest('hex') !== manifest.userscript_sha256) {
    throw new Error('Local userscript hash mismatch');
  }

  var stats = {
    version: manifest.version,
    requests: 0,
    tunnels: 0,
    blocked: 0,
    tls_errors: 0,
    transport_errors: 0,
    injections: 0,
    script_requests: 0,
    last_error: null
  };

  function report() {
    if (!data) return;
    try {
      fs.writeFileSync(path.join(data, 'proxy-status.json'), JSON.stringify(stats), { mode: 384 });
    } catch (_) {}
  }

  var server = http.createServer(function (req, res) {
    stats.blocked++;
    res.writeHead(403, { Connection: 'close' });
    res.end('HTTPS CONNECT only');
  });

  var contexts = {};
  ['www.youtube.com', 'youtube.com'].forEach(function (host) {
    var credentials = opts.credentials[host];
    var inside = http.createServer(function (req, res) {
      stats.requests++;
      var invalidOrigin = req.headers.origin && !/^https:\/\/(www\.)?youtube\.com$/.test(req.headers.origin);
      var invalidHost = req.headers.host !== host && req.headers.host !== host + ':443';
      if (!req.url || req.url[0] !== '/' || req.url.slice(0, 2) === '//' || /[\r\n\x00]/.test(req.url) || invalidOrigin || invalidHost) {
        stats.blocked++;
        res.writeHead(403);
        res.end();
        return;
      }

      if (req.url === '/__tizentube_local__/qa') {
        var qa = null;
        try {
          var raw = fs.readFileSync(path.join(data, 'qa-enable.json'));
          if (raw.length < 256) qa = JSON.parse(raw);
        } catch (_) {}
        if (!qa || !/^[-_a-zA-Z0-9]{11}$/.test(qa.clip || '') || !Number.isFinite(qa.expires) || qa.expires < Date.now() || qa.expires > Date.now() + 900000) {
          res.writeHead(404);
          res.end();
          return;
        }
        if (req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
          res.end(JSON.stringify({ clip: qa.clip, expires: qa.expires }));
          return;
        }
        if (req.method !== 'POST') {
          res.writeHead(405);
          res.end();
          return;
        }
        var qaBytes = 0;
        var qaChunks = [];
        req.on('data', function (b) {
          qaBytes += b.length;
          if (qaBytes > 4096) {
            req.destroy();
            return;
          }
          qaChunks.push(b);
        });
        req.on('end', function () {
          try {
            // Numeric-only measurement records: bounded keys, no free text, no identifiers.
            var input = JSON.parse(Buffer.concat(qaChunks).toString());
            var out = {};
            var keys = Object.keys(input || {});
            if (!input || Array.isArray(input) || typeof input !== 'object' || keys.length < 1 || keys.length > 72) {
              throw new Error('Invalid record');
            }
            keys.forEach(function (k) {
              if (!/^[a-z][a-z0-9_]{0,23}$/i.test(k) || typeof input[k] !== 'number' || !Number.isFinite(input[k]) || input[k] < 0 || input[k] > 1e14) {
                throw new Error('Invalid metric');
              }
              out[k] = input[k];
            });
            if ([1, 2, 3].indexOf(out.kind) < 0) {
              throw new Error('Invalid kind');
            }
            var target = path.join(data, 'qa-metrics.jsonl');
            if (!fs.existsSync(target) || fs.statSync(target).size < 256000) {
              fs.appendFileSync(target, JSON.stringify(out) + '\n', { mode: 384 });
            }
            res.writeHead(204);
            res.end();
          } catch (_) {
            res.writeHead(400);
            res.end();
          }
        });
        return;
      }

      if (req.url === LOCAL_SCRIPT) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          res.writeHead(405);
          res.end();
          return;
        }
        stats.script_requests++;
        res.writeHead(200, {
          'Content-Type': 'application/javascript; charset=utf-8',
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
          'Content-Length': script.length
        });
        res.end(req.method === 'HEAD' ? undefined : script);
        return;
      }

      var isPage = req.method === 'GET' && (req.url === '/tv' || req.url.indexOf('/tv?') === 0);
      var headers = safeHeaders(req.headers, host);
      if (isPage) {
        headers['accept-encoding'] = 'identity';
      }

      var client = (opts.httpsRequest || https.request)(
        {
          hostname: host,
          port: 443,
          servername: host,
          path: req.url,
          method: req.method,
          headers: headers,
          rejectUnauthorized: true,
          maxHeaderSize: 1024 * 1024,
          agent: false,
          ca: opts.upstreamCA
        },
        function (upstream) {
          if (!isPage || upstream.statusCode !== 200 || !/^text\/html(?:;|$)/i.test(upstream.headers['content-type'] || '')) {
            res.writeHead(upstream.statusCode, safeHeaders(upstream.headers));
            upstream.pipe(res);
            return;
          }
          var chunks = [];
          var bytes = 0;
          upstream.on('data', function (chunk) {
            bytes += chunk.length;
            if (bytes > 4 * 1024 * 1024) {
              stats.last_error = 'upstream_html_limit';
              client.destroy();
              res.destroy();
              return;
            }
            chunks.push(chunk);
          });
          upstream.on('end', function () {
            if (res.destroyed) return;
            try {
              var csp = upstream.headers['content-security-policy'] || '';
              var body = modifyHTML(Buffer.concat(chunks), upstream.headers['content-encoding'], /script-src/.test(csp));
              var h = safeHeaders(upstream.headers);
              ['content-encoding', 'content-length', 'transfer-encoding', 'etag', 'content-md5', 'host'].forEach(function (k) {
                delete h[k];
              });
              h['content-length'] = Buffer.byteLength(body);
              h['cache-control'] = 'no-store';
              stats.injections++;
              res.writeHead(upstream.statusCode, h);
              res.end(body);
            } catch (_) {
              stats.last_error = 'html_injection_refused';
              res.writeHead(502);
              res.end('Local YouTube enhancement unavailable');
            }
          });
          upstream.on('error', function () {
            stats.last_error = 'upstream_response';
            res.destroy();
          });
        }
      );

      client.setTimeout(30000, function () {
        stats.last_error = 'upstream_timeout';
        client.destroy();
        res.destroy();
      });
      client.on('error', function (e) {
        if (/TLS|CERT|SELF_SIGNED|VERIFY|ISSUER|SIGNATURE|UNTRUSTED/.test(e.code || '')) {
          stats.tls_errors++;
        } else {
          stats.transport_errors++;
        }
        stats.last_error = String(e.code || 'upstream_tls_or_transport');
        if (!res.headersSent) {
          res.writeHead(502);
          res.end('Upstream TLS or transport error');
        } else {
          res.destroy();
        }
      });
      req.on('aborted', function () {
        client.destroy();
      });
      req.pipe(client);
    });

    inside.maxHeadersCount = 100;
    inside.timeout = 60000;
    var secure = tls.createServer(
      { key: credentials.key, cert: credentials.cert, minVersion: 'TLSv1.2' },
      function (s) {
        inside.emit('connection', s);
      }
    );
    secure.on('tlsClientError', function (_, s) {
      stats.tls_errors++;
      s.destroy();
    });
    contexts[host] = secure;
  });

  server.on('connect', function (req, socket, head) {
    var m = /^([a-z0-9.-]+):443$/.exec(req.url || '');
    if (!m || !allowedHost(m[1]) || req.headers.origin) {
      stats.blocked++;
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    var host = m[1];
    socket.setTimeout(90000, function () {
      socket.destroy();
    });
    socket.on('error', function () {});
    if (contexts[host]) {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) {
        socket.unshift(head);
      }
      contexts[host].emit('connection', socket);
      return;
    }
    stats.tunnels++;
    var upstream = net.connect(443, host, function () {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head && head.length) {
        upstream.write(head);
      }
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.setTimeout(90000, function () {
      upstream.destroy();
      socket.destroy();
    });
    upstream.on('error', function () {
      socket.destroy();
    });
    socket.on('close', function () {
      upstream.destroy();
    });
  });

  server.maxConnections = 32;
  server.maxHeadersCount = 100;
  server.timeout = 60000;
  server.on('clientError', function (_, s) {
    s.destroy();
  });
  server.on('error', function (e) {
    stats.last_error = String(e.code || 'listen');
    report();
  });

  var timer = setInterval(report, 5000);
  server.on('close', function () {
    clearInterval(timer);
    report();
  });
  server.listen(port, bindHost, report);
  return { server: server, stats: stats };
}

module.exports = {
  createProxy: createProxy,
  allowedHost: allowedHost,
  modifyHTML: modifyHTML,
  localScript: LOCAL_SCRIPT
};
