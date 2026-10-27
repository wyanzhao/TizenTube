const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Parser, request } = require('../standalone/service/bounded-https');

function parse(chunks, end = true, limit) {
  let out = { body: '', done: false, error: null, headers: null };
  const p = new Parser(
    r => {
      out.headers = r.headers;
      r.on('data', b => {
        out.body += b.toString();
      });
    },
    e => {
      out.error = e;
    },
    () => {
      out.done = true;
    },
    limit
  );
  for (const c of chunks) {
    p.push(Buffer.from(c));
  }
  if (end) {
    p.end();
  }
  return out;
}

const raw =
  'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\nSet-Cookie: a=b; Secure\r\nSet-Cookie: c=d; HttpOnly\r\n\r\n4\r\nWiki\r\n5\r\npedia\r\n0\r\n\r\n';

test('chunked message survives every possible TCP boundary including final zero chunk', () => {
  for (let i = 0; i <= raw.length; i++) {
    const r = parse([raw.slice(0, i), raw.slice(i)]);
    assert.equal(r.error, null, 'split ' + i);
    assert.equal(r.done, true);
    assert.equal(r.body, 'Wikipedia');
    assert.deepEqual(r.headers['set-cookie'], ['a=b; Secure', 'c=d; HttpOnly']);
  }
});

test('bytewise chunks and bounded trailers preserve body', () => {
  let r = parse([...raw]);
  assert.equal(r.body, 'Wikipedia');
  assert.equal(r.error, null);
  r = parse(['HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n1\r\nx\r\n0\r\nSafe-Trailer: yes\r\n\r\n']);
  assert.equal(r.body, 'x');
  assert.equal(r.done, true);
});

test('fixed length and EOF delimited bodies complete exactly', () => {
  for (const x of ['HTTP/1.1 200 OK\r\nContent-Length: 3\r\n\r\nabc', 'HTTP/1.0 200 OK\r\n\r\nabc']) {
    const r = parse([x]);
    assert.equal(r.body, 'abc');
    assert.equal(r.done, true);
  }
});

test('incomplete and ambiguous responses fail instead of completing', () => {
  const invalidResponses = [
    'HTTP/1.1 200 OK\r\nContent-Length: 5\r\n\r\nabc',
    'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nContent-Length: 3\r\n\r\nabc',
    'HTTP/1.1 200 OK\r\nContent-Length: 3\r\nTransfer-Encoding: chunked\r\n\r\n0\r\n\r\n',
    'HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\nZ\r\nbad\r\n0\r\n\r\n'
  ];
  for (const s of invalidResponses) {
    const r = parse([s]);
    assert.ok(r.error);
    assert.equal(r.done, false);
  }
});

test('large valid headers work; explicit upper limit rejects oversized input', () => {
  const s = 'HTTP/1.1 200 OK\r\nX-Large: ' + 'a'.repeat(32768) + '\r\nContent-Length: 1\r\n\r\nx';
  assert.equal(parse([s]).body, 'x');
  assert.ok(parse([s], true, 8192).error);
  assert.ok(parse(['a'.repeat(1024 * 1024 + 1)]).error);
});

test('no TLS-insecure mode can be requested', () => {
  assert.throws(() => request({ rejectUnauthorized: false }, () => {}), /verification required/);
});
