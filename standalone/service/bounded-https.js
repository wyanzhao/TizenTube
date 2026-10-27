'use strict';

// Bounded HTTP/1.1 client and response parser over verified TLS.
// Avoids the legacy Tizen Node.js HTTP parser's fixed 8 KiB header limit on large YouTube Set-Cookie/CSP headers.
var tls = require('tls');
var stream = require('stream');
var util = require('util');

function fail(message) {
  var e = new Error(message);
  e.code = 'LOCAL_HTTP_FRAMING';
  return e;
}

function Parser(callback, onError, onDone, maxHeaders) {
  this.callback = callback;
  this.onError = onError;
  this.onDone = onDone || function () {};
  this.maxHeaders = maxHeaders || 1048576;
  this.buffer = Buffer.alloc(0);
  this.response = null;
  this.remaining = null;
  this.chunked = false;
  this.chunk = null;
  this.needCRLF = false;
  this.trailers = false;
  this.done = false;
  this.interim = 0;
}

Parser.prototype.error = function (e) {
  if (this.done) return;
  this.done = true;
  if (this.response) this.response.destroy();
  this.onError(e);
};

Parser.prototype.complete = function () {
  if (this.done) return;
  this.done = true;
  this.response.end();
  this.onDone();
};

Parser.prototype.push = function (data) {
  if (this.done) return;
  this.buffer = Buffer.concat([this.buffer, data]);
  try {
    this.parse();
  } catch (e) {
    this.error(e);
  }
};

Parser.prototype.parse = function () {
  for (;;) {
    if (this.done) return;
    if (!this.response) {
      var end = this.buffer.indexOf('\r\n\r\n');
      if (end < 0) {
        if (this.buffer.length > this.maxHeaders) throw fail('Response headers exceed limit');
        return;
      }
      if (end > this.maxHeaders) throw fail('Response headers exceed limit');
      var lines = this.buffer.slice(0, end).toString('binary').split('\r\n');
      this.buffer = this.buffer.slice(end + 4);
      var status = /^HTTP\/1\.[01] ([1-5][0-9]{2})(?: (.*))?$/.exec(lines.shift());
      if (!status || lines.length > 200) throw fail('Invalid response status or header count');
      var headers = Object.create(null);
      lines.forEach(function (line) {
        var m = /^([!#$%&'*+.^_`|~0-9A-Za-z-]+):[ \t]*([^\r\n]*)$/.exec(line);
        if (!m) throw fail('Invalid response header');
        var k = m[1].toLowerCase();
        var v = m[2].trim();
        if (k === 'set-cookie') {
          (headers[k] || (headers[k] = [])).push(v);
        } else if (headers[k] !== undefined) {
          if (k === 'content-length' || k === 'transfer-encoding') throw fail('Ambiguous message framing');
          headers[k] += ', ' + v;
        } else {
          headers[k] = v;
        }
      });
      var code = Number(status[1]);
      if (code < 200) {
        if (code === 101 || ++this.interim > 5) throw fail('Unsupported interim response');
        continue;
      }
      if (headers['content-length'] !== undefined && headers['transfer-encoding'] !== undefined) {
        throw fail('Conflicting body framing');
      }
      if (headers['transfer-encoding'] !== undefined) {
        if (headers['transfer-encoding'].toLowerCase() !== 'chunked') throw fail('Unsupported transfer encoding');
        this.chunked = true;
      } else if (headers['content-length'] !== undefined) {
        if (!/^[0-9]+$/.test(headers['content-length'])) throw fail('Invalid content length');
        this.remaining = Number(headers['content-length']);
        if (!Number.isSafeInteger(this.remaining) || this.remaining > 536870912) {
          throw fail('Content length exceeds limit');
        }
      }
      if (code === 204 || code === 304 || this.head) {
        this.remaining = 0;
        this.chunked = false;
      }
      this.response = new stream.PassThrough();
      this.response.statusCode = code;
      this.response.headers = headers;
      this.response.statusMessage = status[2] || '';
      this.callback(this.response);
    }

    if (this.chunked) {
      if (this.trailers) {
        if (this.buffer.length >= 2 && this.buffer.slice(0, 2).toString() === '\r\n') {
          this.buffer = this.buffer.slice(2);
          this.complete();
          return;
        }
        var te = this.buffer.indexOf('\r\n\r\n');
        if (te < 0) {
          if (this.buffer.length > 16384) throw fail('Trailer limit');
          return;
        }
        if (te > 16384) throw fail('Trailer limit');
        this.buffer = this.buffer.slice(te + 4);
        this.complete();
        return;
      }
      if (this.needCRLF) {
        if (this.buffer.length < 2) return;
        if (this.buffer.slice(0, 2).toString() !== '\r\n') throw fail('Invalid chunk terminator');
        this.buffer = this.buffer.slice(2);
        this.needCRLF = false;
        this.chunk = null;
      }
      if (this.chunk === null) {
        var se = this.buffer.indexOf('\r\n');
        if (se < 0) {
          if (this.buffer.length > 8192) throw fail('Chunk line limit');
          return;
        }
        if (se > 8192) throw fail('Chunk line limit');
        var sizeLine = this.buffer.slice(0, se).toString('ascii');
        if (!/^[0-9a-fA-F]+(?:;[^\r\n]*)?$/.test(sizeLine)) throw fail('Invalid chunk size');
        this.chunk = parseInt(sizeLine.split(';')[0], 16);
        if (!Number.isSafeInteger(this.chunk) || this.chunk > 536870912) throw fail('Chunk size exceeds limit');
        this.buffer = this.buffer.slice(se + 2);
        if (this.chunk === 0) {
          this.trailers = true;
          continue;
        }
      }
      if (!this.buffer.length) return;
      var count = Math.min(this.chunk, this.buffer.length);
      this.response.write(this.buffer.slice(0, count));
      this.buffer = this.buffer.slice(count);
      this.chunk -= count;
      if (this.chunk === 0) this.needCRLF = true;
      continue;
    }

    if (this.remaining === 0) {
      this.complete();
      return;
    }
    if (!this.buffer.length) return;
    var n = this.remaining === null ? this.buffer.length : Math.min(this.buffer.length, this.remaining);
    this.response.write(this.buffer.slice(0, n));
    this.buffer = this.buffer.slice(n);
    if (this.remaining !== null) this.remaining -= n;
  }
};

Parser.prototype.end = function () {
  if (this.done) return;
  if (this.response && !this.chunked && this.remaining === null) {
    this.complete();
  } else {
    this.error(fail('Premature response close'));
  }
};

function Client(options, callback) {
  stream.Writable.call(this, { autoDestroy: false });
  if (options.rejectUnauthorized === false) throw new Error('TLS verification required');
  this.options = options;
  this.options.method = String(options.method || 'GET').toUpperCase();
  this.callback = callback;
  this.parts = [];
  this.bytes = 0;
  this.socket = null;
  this.closedRequest = false;
  this.timeoutMs = 30000;
  var self = this;
  this.on('finish', function () {
    try {
      self.send();
    } catch (e) {
      self.destroy(e);
    }
  });
}

util.inherits(Client, stream.Writable);

Client.prototype._write = function (data, encoding, cb) {
  if (this.closedRequest) {
    cb(fail('Request closed'));
    return;
  }
  this.bytes += data.length;
  if (this.bytes > 8388608) {
    cb(fail('Request body limit'));
    return;
  }
  this.parts.push(Buffer.from(data));
  cb();
};

Client.prototype.setTimeout = function (ms, callback) {
  this.timeoutMs = ms;
  if (callback) this.on('timeout', callback);
  return this;
};

Client.prototype.destroy = function (error) {
  if (this.closedRequest) return this;
  this.closedRequest = true;
  if (this.socket) this.socket.destroy();
  if (error) this.emit('error', error);
  return this;
};

Client.prototype.send = function () {
  var self = this;
  var o = this.options;
  var body = Buffer.concat(this.parts);
  this.parts = [];
  if (this.closedRequest) return;

  var headers = Object.create(null);
  Object.keys(o.headers || {}).forEach(function (k) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(k)) throw fail('Invalid request header name');
    var v = o.headers[k];
    if (Array.isArray(v)) v = v.join(', ');
    if (/[\r\n\x00]/.test(String(v))) throw fail('Invalid request header value');
    headers[k.toLowerCase()] = String(v);
  });

  if (!/^[A-Z]+$/.test(o.method) || !o.path || o.path[0] !== '/' || /[\r\n\x00 ]/.test(o.path)) {
    this.destroy(fail('Invalid request line'));
    return;
  }

  delete headers['transfer-encoding'];
  delete headers['proxy-authorization'];
  headers.host = o.hostname;
  headers.connection = 'close';
  if (body.length || ['POST', 'PUT', 'PATCH'].indexOf(o.method) !== -1) {
    headers['content-length'] = String(body.length);
  }

  var text =
    o.method +
    ' ' +
    o.path +
    ' HTTP/1.1\r\n' +
    Object.keys(headers)
      .map(function (k) {
        return k + ': ' + headers[k];
      })
      .join('\r\n') +
    '\r\n\r\n';

  var parser = new Parser(
    function (res) {
      self.callback(res);
    },
    function (e) {
      self.destroy(e);
    },
    function () {
      if (self.socket) self.socket.destroy();
    },
    o.maxHeaderSize
  );
  parser.head = o.method === 'HEAD';

  var socket = tls.connect(
    {
      host: o.hostname,
      port: o.port || 443,
      servername: o.servername || o.hostname,
      ca: o.ca,
      rejectUnauthorized: true,
      minVersion: 'TLSv1.2'
    },
    function () {
      var wrong = tls.checkServerIdentity(o.servername || o.hostname, socket.getPeerCertificate());
      if (!socket.authorized || wrong) {
        self.destroy(wrong || new Error('TLS authorization failed'));
        return;
      }
      socket.write(text);
      if (body.length) socket.write(body);
    }
  );

  this.socket = socket;
  socket.setTimeout(this.timeoutMs, function () {
    self.emit('timeout');
    self.destroy();
  });
  socket.on('data', function (data) {
    parser.push(data);
    if (parser.response && parser.response.writableLength > 65536) {
      socket.pause();
      parser.response.once('drain', function () {
        socket.resume();
      });
    }
  });
  socket.on('error', function (e) {
    self.destroy(e);
  });
  socket.on('end', function () {
    parser.end();
  });
  socket.on('close', function () {
    if (!parser.done && !self.closedRequest) parser.end();
  });
};

module.exports = {
  request: function (options, callback) {
    return new Client(options, callback);
  },
  Parser: Parser
};
