const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const spawn = require('child_process').spawn;

var ffmpegPath = null;

// Try @ffmpeg-installer first
try {
  const ffmpegInstaller = require('@ffmpeg-installer/ffmpeg');
  ffmpegPath = ffmpegInstaller.path;
  console.log('[ffmpeg] using @ffmpeg-installer');
} catch(e) {
  console.log('[ffmpeg] @ffmpeg-installer not available, trying system paths');
  // System FFmpeg detection
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

if (ffmpegPath) console.log('[ffmpeg] path=%s', ffmpegPath); else console.log('[ffmpeg] NOT AVAILABLE - transcoding disabled, using direct proxy only');

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
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return stbHttpGetFollow(res.headers.location, mac, token, timeout, depth + 1).then(resolve).catch(reject);
      }
      var chunks = [];
      res.on('data', function(c) { chunks.push(c); });
      res.on('end', function() {
        try {
          var data = Buffer.concat(chunks);
          resolve({ statusCode: res.statusCode, headers: res.headers, data: data });
        } catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', function() { req.destroy(); reject(new Error('Request timeout')); });
    req.end();
  });
}

// ══════════════════════════════════════════════════════════════════════
// Portal auto-detection
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

function resolvePortalPath(baseUrl, mac, userPath) {
  var cacheKey = baseUrl + '|' + (userPath || '');
  if (resolvedCache[cacheKey]) return Promise.resolve(resolvedCache[cacheKey]);
  
  return new Promise(function(resolve, reject) {
    var idx = 0;
    var tried = [];
    var candidates = PATH_CANDIDATES.slice();
    if (userPath) candidates.unshift(userPath + '/portal.php', userPath + '/server/load.php', userPath + '/load.php');

    function tryCandidate() {
      if (idx >= candidates.length) {
        var err = new Error('Portal path not found. Tried: ' + tried.join(', '));
        return reject(err);
      }
      var candidate = candidates[idx++];
      var url = baseUrl.replace(/\/$/, '') + candidate;
      tried.push(candidate);
      stbHttpGet(url, mac, null, 8000).then(function(resp) {
        if (resp.statusCode === 200 && (resp.data.length > 100 || candidate.includes('/c/') || candidate.includes('/api/'))) {
          resolvedCache[cacheKey] = candidate;
          resolve(candidate);
        } else {
          tryCandidate();
        }
      }).catch(function() {
        tryCandidate();
      });
    }
    tryCandidate();
  });
}

// ══════════════════════════════════════════════════════════════════════
// Stalker API handlers
// ════════════════════════════════════════════════════════════════════

function readJsonBody(req) {
  return new Promise(function(resolve, reject) {
    var chunks = [];
    req.on('data', function(c) { chunks.push(c); });
    req.on('end', function() {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); } catch(e) { reject(e); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, obj) {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function handleStalkerApi(req, res, u) {
  var pathname = u.pathname;
  
  if (pathname === '/api/stalker/handshake') {
    return readJsonBody(req).then(function(body) {
      var mac = body.mac;
      var portalUrl = body.portal_url;
      if (!mac || !portalUrl) return sendJson(res, 400, { error: 'Missing mac or portal_url' });
      resolvePortalPath(portalUrl, mac).then(function(path) {
        sendJson(res, 200, { portal_path: path, status: 'ok' });
      }).catch(function(err) {
        sendJson(res, 500, { error: err.message });
      });
    }).catch(function(err) {
      sendJson(res, 400, { error: 'Invalid JSON: ' + err.message });
    });
  }

  if (pathname === '/api/stalker/channels') {
    return readJsonBody(req).then(function(body) {
      var mac = body.mac;
      var token = body.token;
      var portalUrl = body.portal_url;
      var portalPath = body.portal_path;
      if (!mac || !portalUrl) return sendJson(res, 400, { error: 'Missing mac or portal_url' });
      
      var url = portalUrl.replace(/\/$/, '') + (portalPath || '/c/') + 'channels.json';
      stbHttpGet(url, mac, token, 20000).then(function(resp) {
        if (resp.statusCode === 200) {
          try {
            var json = JSON.parse(resp.data.toString());
            sendJson(res, 200, json);
          } catch(e) {
            sendJson(res, 500, { error: 'Invalid JSON from portal' });
          }
        } else {
          sendJson(res, resp.statusCode, { error: 'Portal returned ' + resp.statusCode });
        }
      }).catch(function(err) {
        sendJson(res, 500, { error: err.message });
      });
    }).catch(function(err) {
      sendJson(res, 400, { error: 'Invalid JSON: ' + err.message });
    });
  }

  if (pathname === '/api/stalker/itv') {
    return readJsonBody(req).then(function(body) {
      var mac = body.mac;
      var token = body.token;
      var portalUrl = body.portal_url;
      var portalPath = body.portal_path;
      var cmd = body.cmd;
      if (!mac || !portalUrl) return sendJson(res, 400, { error: 'Missing mac or portal_url' });
      
      var url = portalUrl.replace(/\/$/, '') + (portalPath || '/c/') + 'itv.json';
      stbHttpGet(url, mac, token, 20000).then(function(resp) {
        if (resp.statusCode === 200) {
          try {
            var json = JSON.parse(resp.data.toString());
            sendJson(res, 200, json);
          } catch(e) {
            sendJson(res, 500, { error: 'Invalid JSON from portal' });
          }
        } else {
          sendJson(res, resp.statusCode, { error: 'Portal returned ' + resp.statusCode });
        }
      }).catch(function(err) {
        sendJson(res, 500, { error: err.message });
      });
    }).catch(function(err) {
      sendJson(res, 400, { error: 'Invalid JSON: ' + err.message });
    });
  }

  sendJson(res, 404, { error: 'API endpoint not found' });
}

// ══════════════════════════════════════════════════════════════════════
// Stream proxy with FFmpeg transcoding
// ══════════════════════════════════════════════════════════════════════

function proxyStream(res, url, method, token, portal, mac, cmd, transcode) {
  var uTarget = new URL(url);
  var mod = uTarget.protocol === 'https:' ? https : http;
  var headers = {
    'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3',
    'Accept': '*/*',
  };
  if (token) headers['Authorization'] = 'Bearer ' + token;
  if (mac) headers['Cookie'] = 'mac=' + mac;

  if (transcode && ffmpegPath) {
    // FFmpeg transcoding (direct spawn approach)
    var ffmpeg = spawn(ffmpegPath, [
      '-i', url,
      '-c:v', 'libx264', '-preset', 'fast', '-crf', '28',
      '-c:a', 'aac', '-b:a', '128k',
      '-f', 'mpegts', 'pipe:1'
    ]);
    ffmpeg.stdout.on('data', function(chunk) {
      res.write(chunk);
    });
    ffmpeg.stderr.on('data', function(data) {
      console.log('[ffmpeg]', data.toString());
    });
    ffmpeg.on('close', function(code) {
      res.end();
      console.log('[ffmpeg] exited with code', code);
    });
    ffmpeg.on('error', function(err) {
      console.error('[ffmpeg] error:', err.message);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end('FFmpeg error: ' + err.message);
      }
    });
  } else {
    // Direct proxy
    var opts = {
      hostname: uTarget.hostname,
      port: uTarget.port || (uTarget.protocol === 'https:' ? 443 : 80),
      path: uTarget.pathname + uTarget.search,
      method: method || 'GET',
      headers: headers,
      rejectUnauthorized: false,
    };
    var proxyReq = mod.request(opts, function(proxyRes) {
      res.writeHead(proxyRes.statusCode, proxyRes.headers);
      proxyRes.pipe(res);
    });
    proxyReq.on('error', function(err) {
      res.writeHead(502);
      res.end('Proxy error: ' + err.message);
    });
    proxyReq.end();
  }
}

// ══════════════════════════════════════════════════════════════════════
// Express app for serverless deployment
// ══════════════════════════════════════════════════════════════════════

const express = require('express');
const app = express();

app.use(express.json());

// CORS headers
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }
  next();
});

// Old /fetch proxy (keep for backward compat)
app.get('/fetch', (req, res) => {
  var target = req.query.url;
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
});

// Stream proxy (GET)
app.get('/proxy/stream', (req, res) => {
  var targetUrl = req.query.url;
  var proxyToken = req.query.token || '';
  var proxyPortal = req.query.portal || '';
  var proxyMac = req.query.mac || '';
  var proxyCmd = req.query.cmd || '';
  var proxyTranscode = req.query.transcode === 'true' || req.query.transcode === '1';
  proxyStream(res, targetUrl, req.method, proxyToken, proxyPortal, proxyMac, proxyCmd, proxyTranscode);
});

// Stalker API
app.all('/api/stalker/*', (req, res) => {
  var u = new URL(req.originalUrl, 'http://localhost');
  handleStalkerApi(req, res, u);
});

// Export for serverless
module.exports = app;
