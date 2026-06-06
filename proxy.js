const http = require('http');
const https = require('https');
const url = require('url');

const PORT = 3000;

// Disable keep-alive agents
const httpAgent = new http.Agent({ keepAlive: false });
const httpsAgent = new https.Agent({ keepAlive: false });

const server = http.createServer((req, res) => {
    // Enable CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    const query = url.parse(req.url, true).query;
    const targetUrl = query.url;

    if (!targetUrl) {
        res.writeHead(400, { 'Content-Type': 'text/plain' });
        res.end('Missing "url" query parameter');
        return;
    }

    console.log(`[Proxy] Forwarding to: ${targetUrl}`);

    const handleRequest = (currentUrl, redirectCount = 0, collectedCookies = []) => {
        if (redirectCount > 5) {
            res.writeHead(502, { 'Content-Type': 'text/plain' });
            res.end('Too many redirects');
            return;
        }

        const targetUrlObj = url.parse(currentUrl);
        const isHttps = targetUrlObj.protocol === 'https:';
        const protocol = isHttps ? https : http;
        const agent = isHttps ? httpsAgent : httpAgent;

        // Merge incoming cookies with collected cookies
        const initialCookies = req.headers['x-forwarded-cookie'] ? req.headers['x-forwarded-cookie'].split(';').map(c => c.trim()) : [];
        const allCookies = [...initialCookies, ...collectedCookies];
        // Deduplicate cookies (last writer wins mostly, but simplistic concat works for many)
        const cookieHeader = allCookies.join('; ');

        // Construct headers that mimic a real MAG STB
        const stbHeaders = {
            'User-Agent': 'Mozilla/5.0 (QtEmbedded; U; Linux; C) AppleWebKit/533.3 (KHTML, like Gecko) MAG200 stbapp ver: 2 rev: 250 Safari/533.3',
            'X-User-Agent': 'Model: MAG250; Link: WiFi',
            'Accept': '*/*',
            'Accept-Encoding': 'identity', // No compression to avoid issues
            'Accept-Language': 'en-US,en;q=0.9',
            'Referer': `${targetUrlObj.protocol}//${targetUrlObj.host}/c/`,
            'Cookie': cookieHeader,
            'Connection': 'close'
        };

        const options = {
            method: req.method,
            headers: stbHeaders,
            agent: agent,
            timeout: 30000
        };

        const proxyReq = protocol.request(currentUrl, options, (proxyRes) => {
            console.log(`[Proxy] Response status: ${proxyRes.statusCode} for ${currentUrl}`);

            // Handle Redirects
            if ([301, 302, 303, 307, 308].includes(proxyRes.statusCode) && proxyRes.headers.location) {
                console.log(`[Proxy] Following redirect to: ${proxyRes.headers.location}`);

                // Collect cookies from this response
                let newCookies = [];
                if (proxyRes.headers['set-cookie']) {
                    // Normalize to array
                    const setCookie = Array.isArray(proxyRes.headers['set-cookie']) ? proxyRes.headers['set-cookie'] : [proxyRes.headers['set-cookie']];
                    newCookies = setCookie.map(c => c.split(';')[0]); // Take only key=value
                    console.log('[Proxy] Captured new cookies:', newCookies);
                }

                // Resolve relative URLs if needed
                const nextUrl = new URL(proxyRes.headers.location, currentUrl).toString();

                // Drain the response to prevent memory leaks
                proxyRes.resume();

                handleRequest(nextUrl, redirectCount + 1, [...collectedCookies, ...newCookies]);
                return;
            }

            // Forward headers back to client
            Object.keys(proxyRes.headers).forEach(key => {
                // Skip content-length if likely to change (though strictly piping usually matches)
                // Filter out some hop-by-hop headers if needed, but usually fine.
                res.setHeader(key, proxyRes.headers[key]);
            });

            // Explicitly handle Set-Cookie to be accessible by client
            if (proxyRes.headers['set-cookie']) {
                // Forwarding works for simple cases
            }

            res.writeHead(proxyRes.statusCode);
            proxyRes.pipe(res);
        });

        proxyReq.on('timeout', () => {
            console.error('[Proxy] Request timeout');
            proxyReq.destroy(new Error('Request timeout'));
        });

        proxyReq.on('error', (err) => {
            console.error('[Proxy] Error:', err.message);
            if (!res.headersSent) {
                res.writeHead(500, { 'Content-Type': 'text/plain' });
                res.end('Proxy error: ' + err.message);
            }
        });

        proxyReq.end();
    };

    handleRequest(targetUrl);
});

server.listen(PORT, () => {
    console.log(`Proxy server running on http://localhost:${PORT}`);
});
