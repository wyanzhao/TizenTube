'use strict';

var fs = require('fs');
var path = require('path');

// Resolve <root>/apps/<package>/res/wgt/service -> per-package private data directory.
var PKG = path.basename(path.resolve(__dirname, '../../..'));
if (!/^[A-Za-z0-9]{10}$/.test(PKG)) {
  throw new Error('Unexpected package layout');
}

var DATA = '/opt/usr/home/owner/apps_rw/' + PKG + '/data';
var credentials = {};
['www.youtube.com', 'youtube.com'].forEach(function (host) {
  credentials[host] = {
    key: fs.readFileSync(path.join(DATA, host + '.key')),
    cert: fs.readFileSync(path.join(DATA, host + '.crt'))
  };
});

var service = require('./local-proxy').createProxy({
  data: DATA,
  credentials: credentials,
  upstreamCA: fs.readFileSync(path.join(DATA, 'upstream-ca.pem')),
  script: path.join(__dirname, 'userscript.js'),
  manifest: path.join(__dirname, 'build.json')
});

module.exports = {
  onStart: function () {},
  onRequest: function () {},
  onStop: function () {
    service.server.close();
  }
};
