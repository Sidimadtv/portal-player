const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const spawn = require('child_process').spawn;
var ffmpegPath = null;
try { ffmpegPath = require('ffmpeg-static'); } catch(e) {}
// Replit-specific FFmpeg detection
if (!ffmpegPath) {
  try {
    const { execSync } = require('child_process');
    ffmpegPath = execSync('which ffmpeg').toString().trim();
  } catch(e) {}
}
// Additional fallback paths
if (!ffmpegPath) {
  const possiblePaths = [
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/ffmpeg/bin/ffmpeg',
    'ffmpeg'
  ];
  for (const p of possiblePaths) {
    try {
      const { execSync } = require('child_process');
      execSync(`test -x ${p}`, { stdio: 'ignore' });
      ffmpegPath = p;
      break;
    } catch(e) {}
  }
}
if (ffmpegPath) console.log('[ffmpeg] path=%s', ffmpegPath); else console.log('[ffmpeg] NOT AVAILABLE');

const PORT = 3000;

process.on('uncaughtException', function(e) { console.error('Uncaught:', e.message); });
process.on('unhandledRejection', function(e) { console.error('Unhandled:', e.message); });
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript',
  '.css': 'text/css',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
};

// ══════════════════════════════════════════════════════════════════════
// STB/Stalker credential helpers
// ══════════════════════════════════════════════════════════════════════

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

// ══════════════════════════════════════════════════════════════════════
// Generic STB HTTP helper
// ══════════════════════════════════════════════════════════════════════

function stbHttpGet(baseUrl, mac, token, timeout) {
  return stbHttpGetFollow(baseUrl, mac, token, timeout || 15000, 0);
}

function stbHttpGetFollow(baseUrl, mac, token, timeout, depth) {
  if (depth > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise(function(resolve, reject) {
    var u = new URL(baseUrl);
    var mod = u.protocol === 'https:' ? https : http;
    var opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: 'GET',
      headers: stbHeaders(mac, token),
      rejectUnauthorized: false,
      timeout: timeout || 15000,
    };
    var req = mod.request(opts, function(res) {
      // Follow redirects
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers['location']) {
        var loc = res.headers['location'];
        if (!loc.startsWith('http')) {
          try { loc = new URL(loc, baseUrl).toString(); } catch (e) { }
        }
        res.resume();
        resolve(stbHttpGetFollow(loc, mac, token, timeout, depth + 1));
        return;
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var raw = Buffer.concat(chunks);
        if (raw.length === 0) return reject(new Error('Empty response from portal'));
        var snippet = raw.slice(0, 9).toString().toLowerCase();
        if (snippet.startsWith('<!doctype') || snippet.startsWith('<html')) {
          return reject(new Error('Portal returned HTML page'));
        }
        try {
          resolve(JSON.parse(raw.toString()));
        } catch (e) {
          reject(new Error('Invalid JSON from portal'));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Timeout')); });
    req.end();
  });
}

function portalUrl(base, action, extra) {
  var handler = portalHandlerCache[base] || 'portal.php';
  var p = [];
  if (extra) Object.keys(extra).forEach(function(k) { p.push(k + '=' + (k === 'cmd' ? String(extra[k]) : encodeURIComponent(extra[k]))); });
  p.push('action=' + action);
  var qs = p.join('&');
  return base.replace(/\/+$/, '') + '/' + handler + '?' + qs;
}

// ══════════════════════════════════════════════════════════════════════
// Portal path auto-detection
// ══════════════════════════════════════════════════════════════════════

var PATH_CANDIDATES = [
  '/portal.php',
  '/c/portal.php',
  '/stalker_portal/c/portal.php',
  '/c/server/load.php',
  '/server/load.php',
  '/stalker_portal/server/load.php',
  '/c/',
  '/stalker_portal/c/',
  '/api/',
  '/stalker_portal/api/',
  '/api/v3/',
  '/server/api/',
];

var STUB_PATHS = ['/c', '/stalker_portal', '/server', '/api', '/portal', '/stalker_portal/c', ''];

var resolvedCache = {};

var portalHandlerCache = {}; // base -> handler filename (e.g. 'portal.php' or 'load.php')

function resolvePortalBase(rawBase, mac) {
  if (resolvedCache[rawBase]) return Promise.resolve(resolvedCache[rawBase]);

  var parsed = new URL(rawBase);
  var origin = parsed.protocol + '//' + parsed.host;
  var existing = parsed.pathname.replace(/\/+$/, '') || '/';

  // If the path is not a stub path, the user provided a specific path.
  // Add it to candidates but also keep it as fallback.
  var userPath = null;
  if (existing !== '/' && STUB_PATHS.indexOf(existing) === -1) {
    userPath = existing;
  }

  return new Promise(function(resolve, reject) {
    var idx = 0;
    var tried = [];
    var candidates = PATH_CANDIDATES.slice();
    if (userPath) candidates.unshift(userPath + '/portal.php', userPath + '/server/load.php', userPath + '/load.php');

    function tryCandidate() {
      if (idx >= candidates.length) {
        if (userPath) {
          // Fall back to using user's path directly
          var fallback = rawBase.replace(/\/+$/, '');
          resolvedCache[rawBase] = fallback;
          portalHandlerCache[fallback] = 'portal.php';
          return resolve(fallback);
        }
        return reject(new Error('Portal did not respond to any known path.\nTried: ' + tried.join(', ')));
      }
      var p = candidates[idx++];
      tried.push(p);
      // Match same query param pattern stbHandshakeTry uses (without JsHttpRequest)
      var url = origin + p + '?type=stb&prehash=0&action=handshake';

      var u = new URL(url);
      var mod = u.protocol === 'https:' ? https : http;
      var opts = {
        hostname: u.hostname,
        port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search,
        method: 'GET',
        headers: stbHeaders(mac),
        rejectUnauthorized: false,
        timeout: 8000,
      };
      var req = mod.request(opts, function(res) {
        var chunks = [];
        res.on('data', function(c) { chunks.push(c); });
        res.on('end', function() {
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
            // Remove leading slash from dirPath to avoid double slashes with origin
            if (dirPath.indexOf('/') === 0) dirPath = dirPath.slice(1);
            var result = origin + (dirPath ? '/' + dirPath : '');
            result = result.replace(/\/+$/, '');

            // Determine the handler filename (portal.php or load.php)
            var handler = 'portal.php';
            if (last === 'load.php') {
              handler = 'load.php';
            }

            // Verify the base works with the EXACT URL format stbHandshakeTry will use
            verifyPortalBase(result, mac, handler, function(ok) {
              if (ok) {
                resolvedCache[rawBase] = result;
                portalHandlerCache[result] = handler;
                resolve(result);
              } else {
                tryCandidate();
              }
            });
          } catch (e) { tryCandidate(); }
        });
      });
      req.on('error', function() { tryCandidate(); });
      req.end();
    }

    function verifyPortalBase(base, mac, handler, cb) {
      var ts = Date.now();
      var verifyUrl = base.replace(/\/+$/, '') + '/' + handler + '?type=stb&prehash=0&JsHttpRequest=' + ts + '-xml&action=handshake';
      var vu = new URL(verifyUrl);
      var vmod = vu.protocol === 'https:' ? https : http;
      var vOpts = {
        hostname: vu.hostname,
        port: vu.port || (vu.protocol === 'https:' ? 443 : 80),
        path: vu.pathname + vu.search,
        method: 'GET',
        headers: stbHeaders(mac),
        rejectUnauthorized: false,
        timeout: 6000,
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

// ══════════════════════════════════════════════════════════════════════
// Stalker API operations
// ══════════════════════════════════════════════════════════════════════

function stbHandshake(base, mac) {
  return stbHandshakeTry(base, mac, true).catch(function() {
    return stbHandshakeTry(base, mac, false);
  });
}

function stbHandshakeTry(base, mac, useJs) {
  var params = { type: 'stb', prehash: 0 };
  if (useJs) params.JsHttpRequest = Date.now() + '-xml';
  return stbHttpGet(portalUrl(base, 'handshake', params), mac).then(function(data) {
    var token = (data.js && data.js.token) || data.token;
    if (!token) throw new Error('No token in handshake response');
    return token;
  });
}

function stbProfile(base, mac, token) {
  return stbHttpGet(portalUrl(base, 'get_profile', {
    type: 'stb',
    hd: 1,
    ver: 'ImageDescription: 0.2.18-r23-250; ImageDate: Thu Sep 13 11:31:16 EEST 2018; PORTAL version: 5.6.2; API Version: JS API version: 343; STB API version: 146; Player Engine version: 0x58c',
    num_banks: 2,
    sn: stbSerial(mac),
    stb_type: 'MAG250',
    image_version: 218,
    video_out: 'hdmi',
    device_id: stbDeviceId(mac),
    device_id2: stbDeviceId(mac),
    signature: stbSignature(mac),
    auth_second_step: 1,
    hw_version: '1.7-BD-00',
    not_valid_token: 0,
    client_type: 'STB',
    hw_version_2: crypto.createHash('sha1').update(mac.replace(/:/g, '').toUpperCase()).digest('hex'),
    prehash: '',
    JsHttpRequest: Date.now() + '-xml',
  }), mac, token).then(function(data) {
    return data.js || data;
  });
}

function stbFetchPage(base, mac, token, mediaType, page) {
  var typeMap = { live: 'itv', vod: 'vod', series: 'series' };
  var t = typeMap[mediaType] || 'itv';
  // Try get_ordered_list first, fall back to get_channels
  return stbFetchPageTry(base, mac, token, t, page, 'get_ordered_list').catch(function() {
    return stbFetchPageTry(base, mac, token, t, page, 'get_channels');
  });
}

function stbFetchPageTry(base, mac, token, type, page, action) {
  var params = { type: type, JsHttpRequest: Date.now() + '-xml' };
  if (action === 'get_ordered_list') {
    params.genre = '*';
    params.force_ch_link_check = 0;
    params.fav = 0;
    params.sortby = 'number';
    params.hd = 0;
    params.p = page;
  }
  return stbHttpGet(portalUrl(base, action, params), mac, token).then(function(data) {
    var js = data.js || data;
    if (Array.isArray(js)) return { items: js, total: js.length };
    var items = js.data || [];
    var total = parseInt(js.total_items || js.total || 0, 10);
    return { items: items, total: total };
  });
}

function stbCreateLink(base, mac, token, cmd) {
  return stbHttpGet(portalUrl(base, 'create_link', {
    type: 'itv',
    cmd: cmd,
    JsHttpRequest: Date.now() + '-xml',
  }), mac, token).then(function(data) {
    var js = data.js || data;
    var url = js.url || js.cmd || '';
    url = url.trim();
    var m = url.match(/^(?:ffmpeg|auto|ffrt|ff)\s+(.+)/i);
    if (m) url = m[1].trim();
    if (!url) return { url: '', contentType: '' };
    // Replace localhost with portal host so the client can reach the stream
    url = rewriteLocalhost(url, base);
    // Do NOT follow redirects here — that would consume the play_token.
    // The client-side proxy will follow redirects when the user plays.
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
  } catch (e) {}
  return url;
}

function ensureAbsoluteUrl(url, portalBase) {
  if (!url) return url;
  // If URL already has a scheme, it's absolute
  if (/^https?:\/\//i.test(url) || /^\/\//.test(url)) return url;
  // If URL starts with /, resolve against portal base origin
  if (url[0] === '/') {
    try {
      var p = new URL(portalBase);
      return p.origin + url;
    } catch (e) {}
  }
  // Relative path: combine with portal base path
  try {
    return new URL(url, portalBase).toString();
  } catch (e) {}
  return url;
}

function followStreamRedirects(url, mac, token, maxRedirects) {
  function follow(currentUrl, depth) {
    depth = depth || 0;
    if (depth >= maxRedirects) return Promise.resolve({ url: currentUrl, contentType: '' });
    var u = new URL(currentUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return Promise.resolve({ url: currentUrl, contentType: '' });
    var mod = u.protocol === 'https:' ? https : http;
    return new Promise(function(resolve) {
      var headers = {
        'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
        'Accept': '*/*',
      };
      var opts = {
        hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80),
        path: u.pathname + u.search, method: 'GET',
        headers: headers,
        rejectUnauthorized: false, timeout: 10000,
      };
      var req = mod.request(opts, function(res) {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers['location']) {
          var loc = res.headers['location'];
          if (!loc.startsWith('http')) loc = u.protocol + '//' + u.host + loc;
          res.resume();
          follow(loc, depth + 1).then(resolve);
        } else {
          var ct = res.headers['content-type'] || '';
          req.destroy();
          resolve({ url: currentUrl, contentType: ct });
        }
      });
      req.on('error', function() { resolve({ url: currentUrl, contentType: '' }); });
      req.on('timeout', function() { req.destroy(); resolve({ url: currentUrl, contentType: '' }); });
      req.end();
    });
  }
  return follow(url, 0);
}

function stbFetchGenres(base, mac, token, mediaType) {
  var action = mediaType === 'live' ? 'get_genres' : 'get_categories';
  var typeMap = { live: 'itv', vod: 'vod', series: 'series' };
  var t = typeMap[mediaType] || 'itv';
  return stbHttpGet(portalUrl(base, action, { type: t }), mac, token).then(function(data) {
    var js = data.js || [];
    if (typeof js === 'object' && !Array.isArray(js)) js = Object.values(js);
    var map = {};
    js.forEach(function(g) {
      if (g && g.id) map[String(g.id)] = (g.title || g.name || '').trim();
    });
    return map;
  }).catch(function() { return {}; });
}

function cleanCmd(cmd) {
  if (!cmd) return '';
  cmd = cmd.trim();
  if (cmd.indexOf('http://') === 0 || cmd.indexOf('https://') === 0 || cmd.indexOf('rtsp://') === 0) return cmd;
  var m = cmd.match(/^(?:ffmpeg|auto|ffrt|ff)\s+(https?:\/\/\S+|rtsp:\/\/\S+)/i);
  return m ? m[1] : cmd;
}

function tryXtreamStream(portal, mac, token, cmd, base) {
  // Extract channel ID from the LAST path segment of the URL
  var chId = '';
  // Strip query string, then get last path segment
  var pathOnly = cmd.replace(/\?.*$/, '');
  var m = pathOnly.match(/\/(\d+)_?\.?\w*$/);
  if (m) chId = m[1];
  if (!chId) {
    m = pathOnly.match(/\/(\d+)$/);
    if (m) chId = m[1];
  }
  if (!chId) return Promise.resolve('');
  
  // Check if portal has player_api.php
  var baseUrl = portal.replace(/\/+$/, '');
  return new Promise(function(resolve) {
    var u = new URL(baseUrl + '/player_api.php?username=test&password=test');
    var mod = u.protocol === 'https:' ? https : http;
    var req = mod.get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, rejectUnauthorized: false, timeout: 5000 }, function(res) {
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        var raw = Buffer.concat(chunks);
        if (raw.length === 0) return resolve('');
        try {
          var data = JSON.parse(raw.toString());
          if (data.user_info) {
            // Xtream API detected. Get login/password from Stalker profile
            stbProfile(base, mac, token).then(function(profile) {
              var login = profile.login || '';
              var passwd = profile.password || '';
              // If empty, try MAC as login
              if (!login || !passwd) {
                login = mac.replace(/:/g, '').toLowerCase();
                passwd = mac.replace(/:/g, '').toLowerCase();
              }
              var xtUrl = baseUrl + '/live/' + encodeURIComponent(login) + '/' + encodeURIComponent(passwd) + '/' + chId + '.ts';
                resolve(xtUrl);
              }).catch(function() { resolve(''); });
          } else {
            resolve('');
          }
        } catch (e) { resolve(''); }
      });
    });
    req.on('error', function() { resolve(''); });
    req.on('timeout', function() { req.destroy(); resolve(''); });
  });
}

// ══════════════════════════════════════════════════════════════════════
// Stalker API endpoint handler
// ══════════════════════════════════════════════════════════════════════

function readJsonBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(new Error('Invalid JSON')); }
    });
  });
}

function sendJson(res, status, data) {
  var body = JSON.stringify(data);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

function startNdjson(res) {
  res.writeHead(200, {
    'Content-Type': 'application/x-ndjson; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
  });
}

function emitNdjson(res, data) {
  res.write(JSON.stringify(data) + '\n');
}

async function handleStalkerApi(req, res, u) {
  try {
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    if (req.method !== 'POST') {
      return sendJson(res, 405, { error: 'Method not allowed' });
    }

    var body = await readJsonBody(req);
    var portal = (body.portal || '').trim().replace(/\/+$/, '');
    var mac = (body.mac || '').trim().toUpperCase();
    var action = u.pathname.replace('/api/stalker/', '');

    // stream-proxy does not need portal/mac validation
    if (action !== 'stream-proxy') {
      if (!portal) return sendJson(res, 400, { error: 'portal is required' });
      if (!mac) return sendJson(res, 400, { error: 'mac is required' });
      mac = mac.toUpperCase().replace(/[^A-F0-9]/g, '');
      if (mac.length === 12) mac = mac.match(/.{2}/g).join(':');
      if (!/^([0-9A-Fa-f]{2}:){5}[0-9A-Fa-f]{2}$/.test(mac)) {
        return sendJson(res, 400, { error: 'Invalid MAC format' });
      }
    }

    // ── INSPECT ──
    if (action === 'inspect') {
      var base = await resolvePortalBase(portal, mac);
      var token = await stbHandshake(base, mac);
      var profile = {};
      try { profile = await stbProfile(base, mac, token); } catch (e) {}

      var counts = { live: 0, vod: 0, series: 0 };
      for (var mt of ['live', 'vod', 'series']) {
        try {
          var pg = await stbFetchPage(base, mac, token, mt, 1);
          counts[mt] = pg.total || pg.items.length || 0;
        } catch (e) { counts[mt] = -1; }
      }

      return sendJson(res, 200, {
        ok: true,
        token: token,
        resolved_base: base,
        profile: profile,
        counts: counts,
        mac: mac,
        portal: portal,
      });
    }

    // ── CONVERT (NDJSON stream) ──
    if (action === 'convert') {
      var types = body.types || ['live'];
      var maxPages = parseInt(body.maxPages, 10) || 50;
      var base = await resolvePortalBase(portal, mac);
      var token = await stbHandshake(base, mac);

      startNdjson(res);
      emitNdjson(res, { event: 'meta', portal: portal, types: types, maxPages: maxPages });

      var profile = {};
      try { profile = await stbProfile(base, mac, token); } catch (e) {}
      emitNdjson(res, { event: 'profile', profile: profile });

      var totalSent = 0;
      var errors = [];

      for (var t = 0; t < types.length; t++) {
        var mediaType = types[t];
        var genres = await stbFetchGenres(base, mac, token, mediaType);
        var seen = {};
        var typeSent = 0;

        for (var pg = 1; pg <= maxPages; pg++) {
          var result;
          try {
            result = await stbFetchPage(base, mac, token, mediaType, pg);
          } catch (e) {
            errors.push(mediaType + ' p' + pg + ': ' + e.message);
            emitNdjson(res, { event: 'error', scope: mediaType, message: e.message, page: pg });
            break;
          }

          if (!result.items || result.items.length === 0) break;

          for (var i = 0; i < result.items.length; i++) {
            var ch = result.items[i];
            var cid = String(ch.id || ch.cmd || '');
            if (seen[cid]) continue;
            seen[cid] = true;

            var rawCmd = ch.cmd || '';
            var stream = ensureAbsoluteUrl(rewriteLocalhost(cleanCmd(rawCmd), base), base);
            var genreId = String(ch.tv_genre_id || ch.category_id || '');

            var item = {
              name: (ch.name || ch.title || 'Unknown').trim(),
              logo: ch.logo || ch.screenshot_uri || '',
              group: genres[genreId] || 'Uncategorized',
              number: ch.number || ch.ch_number || totalSent + 1,
              cmd: rawCmd,
              stream_url: stream,
              epg_id: ch.xmltv_id || ch.tvg_id || '',
              media_type: mediaType,
            };

            totalSent++;
            typeSent++;
            emitNdjson(res, { event: 'channel', count: totalSent, channel: item });
          }

          emitNdjson(res, {
            event: 'progress', scope: mediaType, page: pg,
            count: totalSent, typeCount: typeSent,
            done: (result.total && typeSent >= result.total) || (result.items.length === 0),
          });

          if (result.total && typeSent >= result.total) break;
        }

        emitNdjson(res, {
          event: 'progress', scope: mediaType,
          count: totalSent, typeCount: typeSent, done: true,
        });
      }

      emitNdjson(res, { event: 'done', total: totalSent, errors: errors });
      res.end();
      return;
    }

    // ── STREAM URL ──
    if (action === 'stream') {
      var token = body.token;
      if (!token) return sendJson(res, 400, { error: 'token is required' });
      var cmd = body.cmd;
      if (!cmd) return sendJson(res, 400, { error: 'cmd is required' });

      var base;
      if (portalHandlerCache[portal]) {
        base = portal;
      } else {
        base = await resolvePortalBase(portal, mac);
      }
      var streamInfo = { url: '', contentType: '' };
      try { streamInfo = await stbCreateLink(base, mac, token, cmd); } catch (e) {}
      // Fix: if create_link returned URL with empty stream=, inject stream ID from cmd
      if (streamInfo.url && streamInfo.url.indexOf('stream=&') !== -1) {
        var cleanUrl = ensureAbsoluteUrl(cleanCmd(cmd), base);
        var sidMatch = cleanUrl.match(/[?&]stream=(\d+)/);
        if (sidMatch) {
          streamInfo.url = streamInfo.url.replace('stream=&', 'stream=' + sidMatch[1] + '&');
        } else {
          streamInfo.url = '';
        }
      }
      if (!streamInfo.url) {
        var xtreamUrl = await tryXtreamStream(portal, mac, token, cmd, base);
        if (xtreamUrl) streamInfo = { url: xtreamUrl, contentType: '' };
      }
      if (!streamInfo.url) {
        streamInfo = { url: ensureAbsoluteUrl(cleanCmd(cmd), base), contentType: '' };
        streamInfo.url = streamInfo.url.replace(/[?&]play_token=[^&]+/g, '');
      }
      streamInfo.url = ensureAbsoluteUrl(streamInfo.url, base);
      streamInfo.url = rewriteLocalhost(streamInfo.url, base);

      return sendJson(res, 200, { url: streamInfo.url, contentType: streamInfo.contentType });
    }

    // ── STREAM PROXY (same-origin pipe for MSE) ──
    if (action === 'stream-proxy') {
      var streamUrl = body.url;
      var mseToken = body.token || '';
      if (!streamUrl) return sendJson(res, 400, { error: 'url is required' });
      return proxyStream(res, streamUrl, 'GET', mseToken, '', '', '');
    }

    return sendJson(res, 404, { error: 'Unknown action: ' + action });
  } catch (e) {
    sendJson(res, 502, { ok: false, error: e.message });
  }
}

function proxyStream(res, url, method, token, portalForRefresh, macForRefresh, cmdForRefresh, transcode) {
  console.log('[proxy] START url=%s', url ? url.substring(0,100) : '(none)');
  if (!method) method = 'GET';
  var maxRedirects = 10;
  var refreshAttempted = false;
  function doFetch(currentUrl, depth) {
    if (depth > maxRedirects) {
      sendJson(res, 504, { error: 'Too many redirects' });
      return;
    }
    var u = new URL(currentUrl);
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') {
      sendJson(res, 502, { error: 'Stream URL points to localhost - portal did not resolve it' });
      return;
    }
    var mod = u.protocol === 'https:' ? https : http;
    var headers = {
      'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
      'Accept': '*/*',
      'Referer': portalForRefresh || url,
      'Origin': portalForRefresh ? portalForRefresh.replace(/\/+$/, '') : url.replace(/\/[^/]*$/, ''),
    };
    var macMatch = u.search.match(/[?&]mac=([^&]+)/i);
    if (macMatch) {
      headers['Cookie'] = 'mac=' + macMatch[1];
    } else if (macForRefresh) {
      headers['Cookie'] = 'mac=' + macForRefresh;
    }
    if (token) {
      headers['Authorization'] = 'Bearer ' + token;
    }
    var opts = {
      hostname: u.hostname,
      port: u.port || (u.protocol === 'https:' ? 443 : 80),
      path: u.pathname + u.search,
      method: method,
      headers: headers,
      rejectUnauthorized: false,
      timeout: 30000,
    };
    console.log('[proxy] FETCH depth=%d host=%s path=%s', depth, u.hostname, (u.pathname + u.search).substring(0,80));
    var req = mod.request(opts, function(proxyRes) {
      console.log('[proxy] RESPONSE status=%d type=%s', proxyRes.statusCode, proxyRes.headers['content-type'] || '(none)');
      if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers['location']) {
        var loc = proxyRes.headers['location'];
        console.log('[proxy] REDIRECT to %s', loc.substring(0,80));
        if (!loc.startsWith('http')) {
          try { loc = new URL(loc, currentUrl).toString(); } catch (e) { loc = currentUrl; }
        }
        proxyRes.resume();
        doFetch(loc, depth + 1);
        return;
      }
      if ((proxyRes.statusCode === 458 || proxyRes.statusCode === 462 || proxyRes.statusCode === 403) && !refreshAttempted && portalForRefresh && macForRefresh && token) {
        console.log('[proxy] TOKEN EXPIRED (%d), refreshing...', proxyRes.statusCode);
        proxyRes.resume();
        refreshAttempted = true;
        refreshAndRetry(currentUrl);
        return;
      }
      if (transcode && ffmpegPath && method !== 'HEAD') {
        res.writeHead(200, {
          'Content-Type': 'video/mp2t',
          'Access-Control-Allow-Origin': '*',
        });
        console.log('[proxy] TRANSCODING via ffmpeg');
        var ff = spawn(ffmpegPath, [
          '-i', 'pipe:0',
          '-c:v', 'libx264', '-preset', 'ultrafast', '-tune', 'zerolatency',
          '-c:a', 'copy',
          '-f', 'mpegts',
          '-loglevel', 'error',
          'pipe:1',
        ]);
        proxyRes.pipe(ff.stdin);
        ff.stdout.pipe(res);
        ff.stderr.on('data', function(d) { console.log('[ffmpeg] ' + d.toString().trim()); });
        ff.on('close', function(code) { console.log('[ffmpeg] exit code=%d', code); req.destroy(); });
        proxyRes.on('end', function() { ff.stdin.end(); });
        req.on('close', function() { ff.kill(); });
        return;
      }
      var type = proxyRes.headers['content-type'] || 'application/octet-stream';
      res.writeHead(proxyRes.statusCode, {
        'Content-Type': type,
        'Access-Control-Allow-Origin': '*',
      });
      if (method !== 'HEAD') {
        var dataCount = 0;
        proxyRes.on('data', function(chunk) {
          dataCount += chunk.length;
        });
        proxyRes.on('end', function() {
          console.log('[proxy] STREAM END totalBytes=%d', dataCount);
          req.destroy();
        });
        proxyRes.pipe(res);
        proxyRes.on('end', function() { req.destroy(); });
      } else {
        proxyRes.resume();
        res.end();
      }
    });
    req.on('error', function(err) {
      console.log('[proxy] ERROR %s', err.message);
      sendJson(res, 502, { error: 'Proxy error: ' + err.message });
    });
    req.on('timeout', function() {
      console.log('[proxy] TIMEOUT');
      req.destroy();
      sendJson(res, 504, { error: 'Proxy timeout' });
    });
    req.end();
  }
  function refreshAndRetry(oldUrl) {
    var refreshCmd = cmdForRefresh || oldUrl;
    console.log('[proxy] REFRESH cmd=%s', refreshCmd.substring(0,60));
    stbCreateLink(portalForRefresh, macForRefresh, token, refreshCmd).then(function(newInfo) {
      if (!newInfo || !newInfo.url) {
        console.log('[proxy] REFRESH FAILED - no url');
        sendJson(res, 502, { error: 'Token refresh failed - no url' });
        return;
      }
      console.log('[proxy] REFRESH OK newUrl=%s', newInfo.url.substring(0,80));
      doFetch(newInfo.url, 0);
    }).catch(function(e) {
      console.log('[proxy] REFRESH ERROR %s', e.message);
      sendJson(res, 502, { error: 'Token refresh error: ' + e.message });
    });
  }
  // Try the URL immediately - refresh on 458/403 if needed
  doFetch(url, 0);
}

// ══════════════════════════════════════════════════════════════════════
// Server
// ══════════════════════════════════════════════════════════════════════

const server = http.createServer(function(req, res) {
  var u = new URL(req.url, 'http://localhost:' + PORT);
  var pathname = u.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  // Old /fetch proxy (keep for backward compat)
  if (pathname === '/fetch' && u.searchParams.has('url')) {
    var target = u.searchParams.get('url');
    var uTarget = new URL(target);
    var mod = uTarget.protocol === 'https:' ? https : http;
    var opts = {
      hostname: uTarget.hostname,
      port: uTarget.port || (uTarget.protocol === 'https:' ? 443 : 80),
      path: uTarget.pathname + uTarget.search,
      method: 'GET',
      headers: { 'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; Android C)' },
      rejectUnauthorized: false,
    };
    var proxyReq = mod.request(opts, function(proxyRes) {
      var chunks = [];
      proxyRes.on('data', function(c) { chunks.push(c); });
      proxyRes.on('end', function() {
        var data = Buffer.concat(chunks);
        res.writeHead(proxyRes.statusCode, { 'Content-Type': proxyRes.headers['content-type'] || 'text/plain' });
        res.end(data);
      });
    });
    proxyReq.on('error', function(err) {
      res.writeHead(502);
      res.end('Proxy error: ' + err.message);
    });
    proxyReq.end();
    return;
  }

  // Stream proxy (GET) - pipes stream from origin through local server (avoids IP-locked CDN blocks)
  if (pathname === '/proxy/stream' && u.searchParams.has('url')) {
    var targetUrl = u.searchParams.get('url');
    var proxyToken = u.searchParams.get('token') || '';
    var proxyPortal = u.searchParams.get('portal') || '';
    var proxyMac = u.searchParams.get('mac') || '';
    var proxyCmd = u.searchParams.get('cmd') || '';
    var proxyTranscode = u.searchParams.get('transcode') === 'true' || u.searchParams.get('transcode') === '1';
    proxyStream(res, targetUrl, req.method, proxyToken, proxyPortal, proxyMac, proxyCmd, proxyTranscode);
    return;
  }

  // Stalker API
  if (pathname.indexOf('/api/stalker/') === 0) {
    return handleStalkerApi(req, res, u);
  }

  // Static files
  var filePath = path.join(__dirname, pathname === '/' ? 'index.html' : decodeURIComponent(pathname));
  var ext = path.extname(filePath);
  fs.readFile(filePath, function(err, data) {
    if (err) {
      res.writeHead(404);
      return res.end('Not Found');
    }
    var headers = { 'Content-Type': MIME[ext] || 'application/octet-stream' };
    if (ext === '.html') headers['Cache-Control'] = 'no-cache, no-store, must-revalidate';
    res.writeHead(200, headers);
    res.end(data);
  });
});

server.on('error', function(e) {
  if (e.code === 'EADDRINUSE') {
    console.error('Port ' + PORT + ' in use, trying ' + (PORT + 1));
    server.listen(PORT + 1);
  } else {
    console.error('Server error:', e.message);
  }
});
server.listen(PORT, function() {
  console.log('Server on port ' + PORT);
});
