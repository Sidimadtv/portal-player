var http = require('http');
var https = require('https');
var crypto = require('crypto');
var spawn = require('child_process').spawn;
var fs = require('fs');
var pathModule = require('path');

var ffmpegPath = null;
function getFfmpeg() {
  if (ffmpegPath !== null) return ffmpegPath || null;
  try {
    var staticPath = require('ffmpeg-static');
    if (staticPath) { ffmpegPath = staticPath; return staticPath; }
  } catch(e) {}
  try {
    var r = require('child_process').execSync('which ffmpeg 2>/dev/null || where ffmpeg 2>nul').toString().trim();
    if (r) { ffmpegPath = r; return r; }
  } catch(e) {}
  ffmpegPath = false;
  return null;
}

function stbSerial(mac) {
  return crypto.createHash('md5').update(mac.replace(/:/g, '').toUpperCase()).digest('hex').slice(0, 13).toUpperCase();
}
function stbDeviceId(mac) {
  return crypto.createHash('sha256').update(mac.replace(/:/g, '').toUpperCase()).digest('hex').slice(0, 64).toUpperCase();
}
function stbSignature(mac) {
  var m = mac.replace(/:/g, '').toUpperCase();
  var serial = stbSerial(mac);
  var devId = stbDeviceId(mac);
  return crypto.createHash('sha256').update(m + serial + devId + devId).digest('hex').slice(0, 64).toUpperCase();
}
function stbHeaders(mac, token) {
  var h = {
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
    'X-User-Agent': 'Model: MAG200; Link: Ethernet',
    'Cookie': 'mac=' + mac + '; stb_lang=en; timezone=Europe/London',
    'Accept': '*/*',
  };
  if (token) h['Authorization'] = 'Bearer ' + token;
  return h;
}
function stbHttpGet(baseUrl, mac, token, timeout) {
  return stbHttpGetFollow(baseUrl, mac, token, timeout || 15000, 0);
}
function stbHttpGetFollow(baseUrl, mac, token, timeout, depth) {
  if (depth > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise(function(resolve, reject) {
    var u = new URL(baseUrl);
    var mod = u.protocol === 'https:' ? https : http;
    var opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: 'GET',
      headers: stbHeaders(mac, token), rejectUnauthorized: false, timeout: timeout || 15000,
    };
    var req = mod.request(opts, function(resp) {
      if (resp.statusCode >= 300 && resp.statusCode < 400 && resp.headers.location) {
        var loc = resp.headers.location;
        if (!loc.startsWith('http')) { try { loc = new URL(loc, baseUrl).toString(); } catch(e) {} }
        resp.resume();
        return stbHttpGetFollow(loc, mac, token, timeout, depth + 1).then(resolve).catch(reject);
      }
      var chunks = [];
      resp.on('data', function(c) { chunks.push(c); });
      resp.on('end', function() {
        var raw = Buffer.concat(chunks);
        if (raw.length === 0) return reject(new Error('Empty response'));
        var snippet = raw.slice(0, 9).toString().toLowerCase();
        if (snippet.startsWith('<!doctype') || snippet.startsWith('<html')) return reject(new Error('Portal returned HTML'));
        try { resolve(JSON.parse(raw.toString())); } catch(e) { reject(new Error('Invalid JSON')); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

var PORTAL_PATH = ['/c', '/stalker_portal', '/server', '/api', '/portal', '/stalker_portal/c', ''];
var PATH_CANDIDATES = [
  '/portal.php', '/c/portal.php', '/stalker_portal/c/portal.php',
  '/c/server/load.php', '/server/load.php', '/stalker_portal/server/load.php',
  '/c/', '/stalker_portal/c/', '/api/', '/stalker_portal/api/', '/api/v3/', '/server/api/',
];
var resolvedCache = {};
var portalHandlerCache = {};

function portalUrl(base, action, extra) {
  var handler = portalHandlerCache[base] || 'portal.php';
  var p = [];
  if (extra) Object.keys(extra).forEach(function(k) { p.push(k + '=' + (k === 'cmd' ? String(extra[k]) : encodeURIComponent(extra[k]))); });
  p.push('action=' + action);
  return base.replace(/\/+$/, '') + '/' + handler + '?' + p.join('&');
}

function resolvePortalBase(rawBase, mac) {
  if (resolvedCache[rawBase]) return Promise.resolve(resolvedCache[rawBase]);
  var parsed = new URL(rawBase);
  var origin = parsed.protocol + '//' + parsed.host;
  var existing = parsed.pathname.replace(/\/+$/, '') || '/';
  var userPath = null;
  if (existing !== '/' && PORTAL_PATH.indexOf(existing) === -1) userPath = existing;
  return new Promise(function(resolve, reject) {
    var idx = 0, tried = [], candidates = PATH_CANDIDATES.slice();
    if (userPath) candidates.unshift(userPath + '/portal.php', userPath + '/server/load.php', userPath + '/load.php');
    function tryCandidate() {
      if (idx >= candidates.length) {
        if (userPath) { var fb = rawBase.replace(/\/+$/, ''); resolvedCache[rawBase] = fb; portalHandlerCache[fb] = 'portal.php'; return resolve(fb); }
        return reject(new Error('Path not found. Tried: ' + tried.join(', ')));
      }
      var p = candidates[idx++]; tried.push(p);
      var url = origin + p + '?type=stb&prehash=0&action=handshake';
      var u = new URL(url);
      var mod = u.protocol === 'https:' ? https : http;
      var opts = {
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'GET',
        headers: stbHeaders(mac), rejectUnauthorized: false, timeout: 8000,
      };
      var req = mod.request(opts, function(resp) {
        var chunks = [];
        resp.on('data', function(c) { chunks.push(c); });
        resp.on('end', function() {
          var raw = Buffer.concat(chunks);
          if (raw.length === 0) return tryCandidate();
          var snippet = raw.slice(0, 9).toString().toLowerCase();
          if (snippet.startsWith('<!doctype') || snippet.startsWith('<html')) return tryCandidate();
          try {
            var data = JSON.parse(raw.toString());
            var token = (data.js && data.js.token) || data.token;
            if (!token) return tryCandidate();
            var parts = p.replace(/\/+$/, '').split('/');
            var last = parts[parts.length - 1];
            var dirPath = last.indexOf('.php') !== -1 ? parts.slice(0, -1).join('/') : (p.replace(/\/+$/, '') || '/c');
            if (!dirPath) dirPath = '';
            if (dirPath.indexOf('/') === 0) dirPath = dirPath.slice(1);
            var result = origin + (dirPath ? '/' + dirPath : '');
            result = result.replace(/\/+$/, '');
            var handler = last === 'load.php' ? 'load.php' : 'portal.php';
            verifyBase(result, mac, handler, function(ok) {
              if (ok) { resolvedCache[rawBase] = result; portalHandlerCache[result] = handler; resolve(result); }
              else tryCandidate();
            });
          } catch(e) { tryCandidate(); }
        });
      });
      req.on('error', function() { tryCandidate(); });
      req.end();
    }
    function verifyBase(base, mac, handler, cb) {
      var ts = Date.now();
      var verifyUrl = base.replace(/\/+$/, '') + '/' + handler + '?type=stb&prehash=0&JsHttpRequest=' + ts + '-xml&action=handshake';
      var vu = new URL(verifyUrl);
      var vmod = vu.protocol === 'https:' ? https : http;
      var vOpts = {
        hostname: vu.hostname, port: vu.port || (vu.protocol === 'https:' ? 443 : 80),
        path: vu.pathname + vu.search, method: 'GET',
        headers: stbHeaders(mac), rejectUnauthorized: false, timeout: 6000,
      };
      var vReq = vmod.request(vOpts, function(vRes) {
        var vChunks = [];
        vRes.on('data', function(c) { vChunks.push(c); });
        vRes.on('end', function() {
          var raw = Buffer.concat(vChunks);
          if (raw.length === 0) return cb(false);
          var snippet = raw.slice(0, 9).toString().toLowerCase();
          cb(!snippet.startsWith('<!doctype') && !snippet.startsWith('<html'));
        });
      });
      vReq.on('error', function() { cb(false); });
      vReq.end();
    }
    tryCandidate();
  });
}

function stbHandshake(base, mac) {
  return stbHandshakeTry(base, mac, true).catch(function() { return stbHandshakeTry(base, mac, false); });
}
function stbHandshakeTry(base, mac, useJs) {
  var params = { type: 'stb', prehash: 0 };
  if (useJs) params.JsHttpRequest = Date.now() + '-xml';
  return stbHttpGet(portalUrl(base, 'handshake', params), mac).then(function(data) {
    var token = (data.js && data.js.token) || data.token;
    if (!token) throw new Error('No token');
    return token;
  });
}
function stbProfile(base, mac, token) {
  return stbHttpGet(portalUrl(base, 'get_profile', {
    type: 'stb', hd: 1, ver: 'ImageDescription: 0.2.18-r23-250; ImageDate: Thu Sep 13 11:31:16 EEST 2018; PORTAL version: 5.6.2; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c',
    num_banks: 2, sn: stbSerial(mac), stb_type: 'MAG250', image_version: 218, video_out: 'hdmi',
    device_id: stbDeviceId(mac), device_id2: stbDeviceId(mac), signature: stbSignature(mac),
    auth_second_step: 1, hw_version: '1.7-BD-00', not_valid_token: 0, client_type: 'STB',
    hw_version_2: crypto.createHash('sha1').update(mac.replace(/:/g, '').toUpperCase()).digest('hex'),
    prehash: '', JsHttpRequest: Date.now() + '-xml',
  }), mac, token).then(function(data) { return data.js || data; });
}
function stbFetchPage(base, mac, token, mediaType, page) {
  var typeMap = { live: 'itv', vod: 'vod', series: 'series' };
  var t = typeMap[mediaType] || 'itv';
  return stbFetchPageTry(base, mac, token, t, page, 'get_ordered_list').catch(function() {
    return stbFetchPageTry(base, mac, token, t, page, 'get_channels');
  });
}
function stbFetchPageTry(base, mac, token, type, page, action) {
  var params = { type: type, JsHttpRequest: Date.now() + '-xml' };
  if (action === 'get_ordered_list') { params.genre = '*'; params.force_ch_link_check = 0; params.fav = 0; params.sortby = 'number'; params.hd = 0; params.p = page; }
  return stbHttpGet(portalUrl(base, action, params), mac, token).then(function(data) {
    var js = data.js || data;
    if (Array.isArray(js)) return { items: js, total: js.length };
    var items = js.data || [];
    var total = parseInt(js.total_items || js.total || 0, 10);
    return { items: items, total: total };
  });
}
function stbCreateLink(base, mac, token, cmd) {
  return stbHttpGet(portalUrl(base, 'create_link', { type: 'itv', cmd: cmd, JsHttpRequest: Date.now() + '-xml' }), mac, token).then(function(data) {
    var js = data.js || data;
    var url = (js.url || js.cmd || '').trim();
    var m = url.match(/^(?:ffmpeg|auto|ffrt|ff)\s+(.+)/i);
    if (m) url = m[1].trim();
    if (!url) return { url: '', contentType: '' };
    url = rewriteLocalhost(url, base);
    return { url: url, contentType: '' };
  });
}
function rewriteLocalhost(url, portalBase) {
  if (url.indexOf('localhost') === -1) return url;
  try {
    var u = new URL(url);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      var p = new URL(portalBase);
      u.hostname = p.hostname;
      if (p.port) u.port = p.port;
      return u.toString();
    }
  } catch(e) {}
  return url;
}
function ensureAbsoluteUrl(url, portalBase) {
  if (!url) return url;
  if (/^https?:\/\//i.test(url) || /^\/\//.test(url)) return url;
  if (url[0] === '/') { try { return new URL(url, portalBase).origin + url; } catch(e) {} }
  try { return new URL(url, portalBase).toString(); } catch(e) {}
  return url;
}
function cleanCmd(cmd) {
  if (!cmd) return '';
  cmd = cmd.trim();
  if (cmd.indexOf('http://') === 0 || cmd.indexOf('https://') === 0 || cmd.indexOf('rtsp://') === 0) return cmd;
  var m = cmd.match(/^(?:ffmpeg|auto|ffrt|ff)\s+(https?:\/\/\S+|rtsp:\/\/\S+)/i);
  return m ? m[1] : cmd;
}
function tryXtreamStream(portal, mac, token, cmd, base) {
  var chId = '';
  var pathOnly = cmd.replace(/\?.*$/, '');
  var m = pathOnly.match(/\/(\d+)_?\.?\w*$/);
  if (m) chId = m[1];
  if (!chId) { m = pathOnly.match(/\/(\d+)$/); if (m) chId = m[1]; }
  if (!chId) return Promise.resolve('');
  var baseUrl = portal.replace(/\/+$/, '');
  return new Promise(function(resolve) {
    var u = new URL(baseUrl + '/player_api.php?username=test&password=test');
    var mod = u.protocol === 'https:' ? https : http;
    var req = mod.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, rejectUnauthorized: false, timeout: 5000 }, function(resp) {
      var chunks = [];
      resp.on('data', function(c) { chunks.push(c); });
      resp.on('end', function() {
        var raw = Buffer.concat(chunks);
        if (raw.length === 0) return resolve('');
        try {
          var data = JSON.parse(raw.toString());
          if (data.user_info) {
            stbProfile(base, mac, token).then(function(profile) {
              var login = profile.login || '';
              var passwd = profile.password || '';
              if (!login || !passwd) { login = mac.replace(/:/g, '').toLowerCase(); passwd = mac.replace(/:/g, '').toLowerCase(); }
              resolve(baseUrl + '/live/' + encodeURIComponent(login) + '/' + encodeURIComponent(passwd) + '/' + chId + '.ts');
            }).catch(function() { resolve(''); });
          } else resolve('');
        } catch(e) { resolve(''); }
      });
    });
    req.on('error', function() { resolve(''); });
    req.on('timeout', function() { req.destroy(); resolve(''); });
  });
}
function stbFetchGenres(base, mac, token, mediaType) {
  var action = mediaType === 'live' ? 'get_genres' : 'get_categories';
  var typeMap = { live: 'itv', vod: 'vod', series: 'series' };
  return stbHttpGet(portalUrl(base, action, { type: typeMap[mediaType] || 'itv' }), mac, token).then(function(data) {
    var js = data.js || [];
    if (typeof js === 'object' && !Array.isArray(js)) js = Object.values(js);
    var map = {};
    js.forEach(function(g) { if (g && g.id) map[String(g.id)] = (g.title || g.name || '').trim(); });
    return map;
  }).catch(function() { return {}; });
}

function sendJson(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(data));
}
function startNdjson(res) {
  res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-cache, no-transform', 'X-Accel-Buffering': 'no', 'Access-Control-Allow-Origin': '*' });
}
function emitNdjson(res, data) {
  res.write(JSON.stringify(data) + '\n');
}

function proxyStream(res, url, method, token, portalForRefresh, macForRefresh, cmdForRefresh, transcode) {
  if (!method) method = 'GET';
  var maxRedirects = 10;
  var refreshAttempted = false;
  function doFetch(currentUrl, depth) {
    if (depth > maxRedirects) { sendJson(res, 504, { error: 'Too many redirects' }); return; }
    var u = new URL(currentUrl);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') { sendJson(res, 502, { error: 'Localhost in stream URL' }); return; }
    var mod = u.protocol === 'https:' ? https : http;
    var headers = {
      'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
      'Accept': '*/*', 'Referer': portalForRefresh || url,
      'Origin': portalForRefresh ? portalForRefresh.replace(/\/+$/, '') : url.replace(/\/[^/]*$/, ''),
    };
    var macMatch = u.search.match(/[?&]mac=([^&]+)/i);
    if (macMatch) headers['Cookie'] = 'mac=' + macMatch[1];
    else if (macForRefresh) headers['Cookie'] = 'mac=' + macForRefresh;
    if (token) headers['Authorization'] = 'Bearer ' + token;
    var opts = {
      hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search, method: method, headers: headers,
      rejectUnauthorized: false, timeout: 30000,
    };
    var req = mod.request(opts, function(proxyRes) {
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
        var loc = proxyRes.headers.location;
        if (!loc.startsWith('http')) { try { loc = new URL(loc, currentUrl).toString(); } catch(e) { loc = currentUrl; } }
        proxyRes.resume();
        return doFetch(loc, depth + 1);
      }
      if ((proxyRes.statusCode === 458 || proxyRes.statusCode === 462 || proxyRes.statusCode === 403) && !refreshAttempted && portalForRefresh && macForRefresh && token) {
        proxyRes.resume(); refreshAttempted = true;
        stbCreateLink(portalForRefresh, macForRefresh, token, cmdForRefresh || currentUrl).then(function(newInfo) {
          if (!newInfo || !newInfo.url) return sendJson(res, 502, { error: 'Token refresh failed' });
          doFetch(newInfo.url, 0);
        }).catch(function(e) { sendJson(res, 502, { error: 'Refresh error: ' + e.message }); });
        return;
      }
      if (transcode && getFfmpeg() && method !== 'HEAD') {
        res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Access-Control-Allow-Origin': '*' });
        var ff = spawn(getFfmpeg(), ['-i', 'pipe:0', '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency', '-c:a', 'copy', '-f', 'mpegts', '-loglevel', 'error', 'pipe:1']);
        proxyRes.pipe(ff.stdin); ff.stdout.pipe(res);
        proxyRes.on('end', function() { ff.stdin.end(); });
        req.on('close', function() { ff.kill(); });
        return;
      }
      var type = proxyRes.headers['content-type'] || 'application/octet-stream';
      res.writeHead(proxyRes.statusCode, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
      if (method !== 'HEAD') { proxyRes.pipe(res); proxyRes.on('end', function() { req.destroy(); }); }
      else { proxyRes.resume(); res.end(); }
    });
    req.on('error', function(err) { sendJson(res, 502, { error: 'Proxy: ' + err.message }); });
    req.on('timeout', function() { req.destroy(); sendJson(res, 504, { error: 'Proxy timeout' }); });
    req.end();
  }
  doFetch(url, 0);
}

module.exports = async function(req, res) {
  var reqPath = req.url ? req.url.split('?')[0] : '/';
  var method = req.method;

  if (method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type' });
    return res.end();
  }

  var bodyRaw = '';
  try {
    bodyRaw = await new Promise(function(resolve, reject) {
      var chunks = [];
      req.on('data', function(c) { chunks.push(c); });
      req.on('end', function() { resolve(Buffer.concat(chunks).toString()); });
      req.on('error', reject);
      req.resume();
    });
  } catch(e) { bodyRaw = ''; }
  var body = {};
  try { body = JSON.parse(bodyRaw || '{}'); } catch(e) { body = {}; }

  if (reqPath === '/api/status') return sendJson(res, 200, { ok: true, ffmpeg: !!getFfmpeg(), node: process.version });

  if (reqPath === '/proxy/stream' && method === 'GET') {
    var proxyQ = require('url').parse(req.url, true).query;
    if (!proxyQ.url) return sendJson(res, 400, { error: 'Missing url' });
    proxyStream(res, proxyQ.url, 'GET', proxyQ.token || '', proxyQ.portal || '', proxyQ.mac || '', proxyQ.cmd || '', proxyQ.transcode === 'true' || proxyQ.transcode === '1');
    return;
  }

  if (reqPath === '/fetch' && method === 'GET') {
    var target = require('url').parse(req.url, true).query.url;
    if (!target) return sendJson(res, 400, { error: 'Missing url' });
    proxyStream(res, target, 'GET', null, null, null, null, false);
    return;
  }

  if (reqPath === '/api/stalker/stream-get' && method === 'GET') {
    var sg = require('url').parse(req.url, true).query;
    if (!sg.url) return sendJson(res, 400, { error: 'Missing url' });
    proxyStream(res, sg.url, 'GET', sg.token || '', sg.portal || '', sg.mac || '', sg.cmd || '', sg.transcode === 'true' || sg.transcode === '1');
    return;
  }

  if (reqPath === '/api/stalker/proxy' && method === 'GET') {
    var pq = require('url').parse(req.url, true).query;
    if (!pq.url) return sendJson(res, 400, { error: 'Missing url' });
    var pu = new URL(pq.url);
    var pmod = pu.protocol === 'https:' ? https : http;
    var popts = {
      hostname: pu.hostname, port: pu.port || (pu.protocol === 'https:' ? 443 : 80),
      path: pu.pathname + pu.search, method: 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
        'X-User-Agent': 'Model: MAG200; Link: Ethernet',
        'Accept': '*/*',
        'Cookie': pq.mac ? 'mac=' + pq.mac + '; stb_lang=en; timezone=Europe/London' : '',
      },
      rejectUnauthorized: false, timeout: 15000,
    };
    if (pq.token) popts.headers['Authorization'] = 'Bearer ' + pq.token;
    if (pq.token) popts.headers['Cookie'] = (popts.headers['Cookie'] || '') + '; token=' + pq.token;
    var prec = pmod.request(popts, function(pres) {
      res.writeHead(pres.statusCode, { 'Content-Type': pres.headers['content-type'] || 'application/octet-stream', 'Access-Control-Allow-Origin': '*' });
      pres.pipe(res);
    });
    prec.on('error', function(e) { sendJson(res, 502, { error: e.message }); });
    prec.end();
    return;
  }

  if (reqPath.indexOf('/api/stalker/') === 0) {
    var action = reqPath.replace('/api/stalker/', '');
    if (method !== 'POST') return sendJson(res, 405, { error: 'Method not allowed' });
    var portal = (body.portal || '').trim().replace(/\/+$/, '');
    var mac = (body.mac || '').trim().toUpperCase().replace(/[^A-F0-9]/g, '');
    if (action !== 'stream-proxy') {
      if (!portal) return sendJson(res, 400, { error: 'portal required' });
      if (!mac) return sendJson(res, 400, { error: 'mac required' });
      if (mac.length === 12) mac = mac.match(/.{2}/g).join(':');
      if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)) return sendJson(res, 400, { error: 'Invalid MAC' });
    }

    try {
      if (action === 'inspect') {
        var base = await resolvePortalBase(portal, mac);
        var token = await stbHandshake(base, mac);
        var profile = {};
        try { profile = await stbProfile(base, mac, token); } catch(e) {}
        var counts = { live: 0, vod: 0, series: 0 };
        for (var mt of ['live', 'vod', 'series']) {
          try { var pg = await stbFetchPage(base, mac, token, mt, 1); counts[mt] = pg.total || pg.items.length || 0; } catch(e) { counts[mt] = -1; }
        }
        return sendJson(res, 200, { ok: true, token: token, resolved_base: base, profile: profile, counts: counts, mac: mac, portal: portal });
      }

      if (action === 'convert') {
        var types = body.types || ['live'];
        var maxPages = parseInt(body.maxPages, 10) || 50;
        var base = await resolvePortalBase(portal, mac);
        var token = await stbHandshake(base, mac);
        startNdjson(res);
        emitNdjson(res, { event: 'meta', portal: portal, types: types, maxPages: maxPages });
        var profile = {};
        try { profile = await stbProfile(base, mac, token); } catch(e) {}
        emitNdjson(res, { event: 'profile', profile: profile });
        var totalSent = 0, errors = [];
        for (var t = 0; t < types.length; t++) {
          var mediaType = types[t];
          var genres = await stbFetchGenres(base, mac, token, mediaType);
          var seen = {}, typeSent = 0;
          for (var pg = 1; pg <= maxPages; pg++) {
            var result;
            try { result = await stbFetchPage(base, mac, token, mediaType, pg); }
            catch(e) { errors.push(mediaType + ' p' + pg + ': ' + e.message); emitNdjson(res, { event: 'error', scope: mediaType, message: e.message, page: pg }); break; }
            if (!result.items || result.items.length === 0) break;
            for (var i = 0; i < result.items.length; i++) {
              var ch = result.items[i];
              var cid = String(ch.id || ch.cmd || '');
              if (seen[cid]) continue;
              seen[cid] = true;
              var rawCmd = ch.cmd || '';
              var stream = ensureAbsoluteUrl(rewriteLocalhost(cleanCmd(rawCmd), base), base);
              var genreId = String(ch.tv_genre_id || ch.category_id || '');
              totalSent++; typeSent++;
              emitNdjson(res, { event: 'channel', count: totalSent, channel: { name: (ch.name || ch.title || 'Unknown').trim(), logo: ch.logo || ch.screenshot_uri || '', group: genres[genreId] || 'Uncategorized', number: ch.number || ch.ch_number || totalSent, cmd: rawCmd, stream_url: stream, epg_id: ch.xmltv_id || ch.tvg_id || '', media_type: mediaType } });
            }
            emitNdjson(res, { event: 'progress', scope: mediaType, page: pg, count: totalSent, typeCount: typeSent, done: (result.total && typeSent >= result.total) || (result.items.length === 0) });
            if (result.total && typeSent >= result.total) break;
          }
          emitNdjson(res, { event: 'progress', scope: mediaType, count: totalSent, typeCount: typeSent, done: true });
        }
        emitNdjson(res, { event: 'done', total: totalSent, errors: errors });
        res.end();
        return;
      }

      if (action === 'stream') {
        var streamToken = body.token;
        var cmd = body.cmd;
        if (!streamToken) return sendJson(res, 400, { error: 'token required' });
        if (!cmd) return sendJson(res, 400, { error: 'cmd required' });
        var base = portalHandlerCache[portal] ? portal : await resolvePortalBase(portal, mac);
        var streamInfo = { url: '', contentType: '' };
        try { streamInfo = await stbCreateLink(base, mac, streamToken, cmd); } catch(e) {}
        if (streamInfo.url && streamInfo.url.indexOf('stream=&') !== -1) {
          var cleanUrl = ensureAbsoluteUrl(cleanCmd(cmd), base);
          var sidMatch = cleanUrl.match(/[?&]stream=(\d+)/);
          if (sidMatch) streamInfo.url = streamInfo.url.replace('stream=&', 'stream=' + sidMatch[1] + '&');
          else streamInfo.url = '';
        }
        if (!streamInfo.url) { var xtUrl = await tryXtreamStream(portal, mac, streamToken, cmd, base); if (xtUrl) streamInfo = { url: xtUrl, contentType: '' }; }
        if (!streamInfo.url) { streamInfo = { url: ensureAbsoluteUrl(cleanCmd(cmd), base), contentType: '' }; streamInfo.url = streamInfo.url.replace(/[?&]play_token=[^&]+/g, ''); }
        streamInfo.url = ensureAbsoluteUrl(streamInfo.url, base);
        streamInfo.url = rewriteLocalhost(streamInfo.url, base);
        return sendJson(res, 200, { url: streamInfo.url, contentType: streamInfo.contentType });
      }

      if (action === 'stream-proxy') {
        var streamUrl = body.url;
        var mseToken = body.token || '';
        if (!streamUrl) return sendJson(res, 400, { error: 'url required' });
        return proxyStream(res, streamUrl, 'GET', mseToken, '', '', '');
      }

      return sendJson(res, 404, { error: 'Unknown action: ' + action });
    } catch(e) {
      return sendJson(res, 502, { ok: false, error: e.message });
    }
  }

  var rootDir = pathModule.resolve(__dirname, '..');
  var relative = reqPath === '/' ? 'index.html' : reqPath.slice(1);
  var safePath = pathModule.resolve(rootDir, relative);
  if (safePath.indexOf(rootDir) !== 0) return sendJson(res, 403, { error: 'Forbidden' });
  try {
    var stat = fs.statSync(safePath);
    if (stat.isFile()) {
      var ext = pathModule.extname(safePath).toLowerCase();
      var mime = { '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' }[ext] || 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': mime, 'Access-Control-Allow-Origin': '*' });
      res.end(fs.readFileSync(safePath));
      return;
    }
  } catch(e) {}
  return sendJson(res, 404, { error: 'Not found' });
};
