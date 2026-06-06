// Dashboard App Logic

document.addEventListener('DOMContentLoaded', function () {
    // ─── UI refs ───
    var $ = function (id) { return document.getElementById(id); };
    var u = {
        portalInput: $('portal-url'), macInput: $('mac-address'),
        username: $('username'), password: $('password'),
        portalName: $('portal-name'), loginForm: $('login-form'),
        statusMsg: $('status-message'), savedPortals: $('saved-portals'),
        loadingMsg: $('loading-message'),
        modeTv: $('mode-tv'), modeSeries: $('mode-series'), modeMovies: $('mode-movies'),
        modeFav: $('mode-fav'), modeSettings: $('mode-settings'),
        listTitle: $('list-title'), searchInput: $('channel-search'),
        categoryBar: $('category-bar'), contentList: $('content-list'),
        previewPlayer: $('preview-player'), previewFsBtn: $('preview-fs-btn'),
        epgTitle: $('epg-title'), epgDesc: $('epg-desc'),
        videoPlayer: $('video-player'), playerLoader: $('player-loader'),
        bannerName: $('banner-channel-name'), bannerProg: $('banner-program-title'),
        bannerLogo: $('banner-logo'),
    };
    var screens = {
        login: $('login-screen'), loading: $('loading-screen'),
        menu: $('main-menu'), player: $('player-screen')
    };

    // ─── State ───
    var stalkerClient = null;
    var currentMode = 'tv'; // 'tv'|'series'|'movies'|'fav'
    var channelsData = [];
    var currentCategory = 'all';
    var categoriesMap = {};
    var categoriesList = [];
    var selectedChannel = null;
    var previewMpegts = null;
    var previewHls = null;
    var mpegtsPlayer = null;
    var hlsInstance = null;
    var allItems = []; // flat list for favorites

    // ─── Helpers ───
    function showScreen(id) {
        Object.keys(screens).forEach(function (k) { screens[k].classList.add('hidden'); });
        screens[id].classList.remove('hidden');
    }
    function showStatus(msg, type) {
        u.statusMsg.textContent = msg;
        u.statusMsg.style.color = type === 'error' ? '#f55' : '#0a7';
    }

    function getProxiedUrl(url) {
        var isCross = url.indexOf(location.protocol + '//' + location.host) !== 0 && url.indexOf('//' + location.host) === -1;
        if (!isCross) return url;
        var base = location.hostname.indexOf('vercel') !== -1 ? '/api/stalker/stream-get' : 'https://stalker-p.vercel.app/api/stalker/stream-get';
        var tok = (stalkerClient && stalkerClient.token) || '';
        return base + '?url=' + encodeURIComponent(url) + (tok ? '&token=' + encodeURIComponent(tok) : '');
    }

    function isMpegTs(url) {
        return url.indexOf('.ts') !== -1 || url.indexOf('extension=ts') !== -1 || url.indexOf('.m2ts') !== -1;
    }
    function isM3u8(url) {
        return url.indexOf('.m3u8') !== -1;
    }

    function formatTime(sec) {
        if (!sec) return '';
        var h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
        return (h ? h + ':' : '') + (m < 10 ? '0' : '') + m + ':' + (s < 10 ? '0' : '') + s;
    }

    // ─── Favorites ───
    function getFavorites() {
        try { return JSON.parse(localStorage.getItem('dash_fav') || '[]'); } catch (e) { return []; }
    }
    function setFavorites(arr) {
        localStorage.setItem('dash_fav', JSON.stringify(arr));
    }
    function isFavorite(url) {
        return getFavorites().indexOf(url) !== -1;
    }
    function toggleFavorite(url) {
        var favs = getFavorites();
        var idx = favs.indexOf(url);
        if (idx === -1) favs.push(url); else favs.splice(idx, 1);
        setFavorites(favs);
        return favs.indexOf(url) !== -1;
    }

    // ─── Multi portal ───
    function getPortals() {
        try { return JSON.parse(localStorage.getItem('dash_portals') || '[]'); } catch (e) { return []; }
    }
    function savePortal(portal, mac, user, pass) {
        var list = getPortals();
        // replace if same portal
        var found = false;
        for (var i = 0; i < list.length; i++) {
            if (list[i].portal === portal && list[i].mac === mac) {
                list[i] = { portal: portal, mac: mac, username: user || '', password: pass || '' };
                found = true; break;
            }
        }
        if (!found) list.push({ portal: portal, mac: mac, username: user || '', password: pass || '' });
        localStorage.setItem('dash_portals', JSON.stringify(list));
    }
    function removePortal(portal, mac) {
        var list = getPortals().filter(function (p) { return p.portal !== portal || p.mac !== mac; });
        localStorage.setItem('dash_portals', JSON.stringify(list));
        renderSavedPortals();
    }
    function renderSavedPortals() {
        var list = getPortals();
        u.savedPortals.innerHTML = '';
        if (list.length === 0) return;
        list.forEach(function (p) {
            var li = document.createElement('li');
            li.innerHTML = '<span><strong>' + escapeHtml(p.portal.replace(/https?:\/\//, '')) + '</strong> <span style="color:#888;font-size:11px;">' + escapeHtml(p.mac) + '</span></span><span class="del" data-del="1">✕</span>';
            li.querySelector('[data-del]').addEventListener('click', function (e) {
                e.stopPropagation(); removePortal(p.portal, p.mac);
            });
            li.addEventListener('click', function () {
                u.portalInput.value = p.portal;
                u.macInput.value = p.mac;
                u.username.value = p.username || '';
                u.password.value = p.password || '';
                doConnect(p.portal, p.mac, p.username || '', p.password || '');
            });
            u.savedPortals.appendChild(li);
        });
    }

    function escapeHtml(s) {
        var d = document.createElement('div');
        d.textContent = s;
        return d.innerHTML;
    }

    // ─── Connect ───
    u.loginForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var portal = u.portalInput.value.trim();
        var mac = u.macInput.value.trim().toUpperCase().replace(/[^A-F0-9]/g, '');
        if (mac.length === 12) mac = mac.match(/.{2}/g).join(':');
        var user = u.username.value.trim();
        var pass = u.password.value.trim();
        if (!portal || !mac) { showStatus('Portal URL and MAC required', 'error'); return; }
        savePortal(portal, mac, user, pass);
        doConnect(portal, mac, user, pass);
    });

    async function doConnect(portal, mac, user, pass) {
        showScreen('loading');
        u.loadingMsg.textContent = 'Connecting...';
        try {
            stalkerClient = new StalkerClient(portal, mac);
            await stalkerClient.authenticate(user, pass);
            u.loadingMsg.textContent = 'Loading channels...';
            showScreen('menu');
            await switchMode('tv');
        } catch (e) {
            showScreen('login');
            showStatus('Connection failed: ' + e.message, 'error');
        }
    }

    // ─── Mode switching ───
    function setActiveModeBtn(id) {
        [u.modeTv, u.modeSeries, u.modeMovies, u.modeFav, u.modeSettings].forEach(function (b) { b.classList.remove('active'); });
        var map = { tv: u.modeTv, series: u.modeSeries, movies: u.modeMovies, fav: u.modeFav, settings: u.modeSettings };
        if (map[id]) map[id].classList.add('active');
    }

    u.modeTv.addEventListener('click', function () { switchMode('tv'); });
    u.modeSeries.addEventListener('click', function () { switchMode('series'); });
    u.modeMovies.addEventListener('click', function () { switchMode('movies'); });
    u.modeFav.addEventListener('click', function () { switchMode('fav'); });
    u.modeSettings.addEventListener('click', function () {
        destroyPreview();
        showScreen('login');
        renderSavedPortals();
    });

    async function switchMode(mode) {
        currentMode = mode;
        setActiveModeBtn(mode);
        selectedChannel = null;
        destroyPreview();
        u.contentList.innerHTML = '';
        u.categoryBar.innerHTML = '';
        u.epgTitle.textContent = '';
        u.epgDesc.textContent = '';

        if (mode === 'fav') {
            u.listTitle.textContent = 'Favorites';
            u.categoryBar.innerHTML = '<button class="active">All</button>';
            loadFavorites();
            return;
        }
        if (!stalkerClient) return;

        var typeMap = { tv: 'live', series: 'series', movies: 'vod' };
        var mediaType = typeMap[mode] || 'live';
        var titleMap = { tv: 'TV Channels', series: 'Series', movies: 'Movies' };
        u.listTitle.textContent = titleMap[mode] || 'Channels';

        u.loadingMsg.textContent = 'Loading ' + titleMap[mode] + '...';
        showScreen('loading');

        try {
            if (mode === 'tv') {
                var genresArr = await stalkerClient.getGenres();
                categoriesMap = {};
                categoriesList = [];
                genresArr.forEach(function (g) { categoriesMap[g.id] = g.title; categoriesList.push(g.id); });
                categoriesList.sort(function (a, b) { return (categoriesMap[a] || '').localeCompare(categoriesMap[b] || ''); });
                renderCategories();
                var allChs = await stalkerClient.getChannels();
                channelsData = allChs.map(function (ch) { return { name: ch.name, cmd: ch.url, number: ch.number, logo: ch.logo, tv_genre_id: ch.genre_id }; });
                allItems = channelsData;
                renderContentList(channelsData);
            } else {
                var apiType = mode === 'movies' ? 'vod' : 'series';
                var cats = await stalkerClient.getVodCategories(apiType);
                categoriesMap = {};
                categoriesList = [];
                cats.forEach(function (c) { categoriesMap[c.id] = c.title; categoriesList.push(c.id); });
                categoriesList.sort(function (a, b) { return (categoriesMap[a] || '').localeCompare(categoriesMap[b] || ''); });
                renderCategories();
                var vlist = await stalkerClient.getVodList(null, apiType);
                channelsData = vlist.map(function (m) { return { name: m.name, cmd: m.url, logo: m.logo, category_id: null, description: m.description }; });
                allItems = channelsData;
                renderContentList(channelsData);
            }
            showScreen('menu');
            u.loadingMsg.textContent = 'Done';
        } catch (e) {
            showScreen('menu');
            console.error('Load error:', e);
        }
    }

    function renderCategories() {
        u.categoryBar.innerHTML = '<button class="active" data-id="all">All</button>';
        categoriesList.forEach(function (id) {
            var btn = document.createElement('button');
            btn.textContent = categoriesMap[id];
            btn.setAttribute('data-id', id);
            btn.addEventListener('click', function () {
                u.categoryBar.querySelectorAll('button').forEach(function (b) { b.classList.remove('active'); });
                btn.classList.add('active');
                currentCategory = id;
                if (currentMode === 'fav') loadFavorites();
                else filterByCategory();
            });
            u.categoryBar.appendChild(btn);
        });
        currentCategory = 'all';
    }

    function filterByCategory() {
        if (currentCategory === 'all') {
            renderContentList(allItems);
        } else {
            renderContentList(allItems.filter(function (ch) {
                return String(ch.tv_genre_id || ch.category_id || '') === String(currentCategory);
            }));
        }
    }

    function renderContentList(items) {
        u.contentList.innerHTML = '';
        if (!items || items.length === 0) {
            u.contentList.innerHTML = '<li style="color:#666;padding:20px;text-align:center;">No items found</li>';
            return;
        }
        items.forEach(function (ch) {
            var li = document.createElement('li');
            var name = ch.name || ch.title || 'Unknown';
            var num = ch.number || ch.ch_number || '';
            var logo = ch.logo || ch.screenshot_uri || '';
            var url = ch.cmd || '';
            var isFav = isFavorite(url);
            li.innerHTML = (num ? '<span class="num">' + num + '</span>' : '') +
                (logo ? '<img src="' + logo + '" alt="" onerror="this.style.display=\'none\'">' : '') +
                '<span>' + escapeHtml(name) + '</span>' +
                '<span class="fav' + (isFav ? ' on' : '') + '" data-fav="1">★</span>';
            li.addEventListener('click', function (e) {
                if (e.target.getAttribute('data-fav') === '1') {
                    var now = toggleFavorite(url);
                    e.target.classList.toggle('on', now);
                    return;
                }
                // Select / Fullscreen
                if (selectedChannel && selectedChannel.cmd === url) {
                    goFullscreen(url);
                } else {
                    selectChannel(ch, li);
                }
            });
            u.contentList.appendChild(li);
        });
    }

    function loadFavorites() {
        var favUrls = getFavorites();
        var items = allItems.filter(function (ch) { return favUrls.indexOf(ch.cmd || '') !== -1; });
        renderContentList(items);
        if (items.length === 0) {
            u.epgTitle.textContent = 'No favorites yet';
            u.epgDesc.textContent = 'Click ★ on any channel to add it';
        }
    }

    // ─── Category click from search ───
    u.searchInput.addEventListener('input', function () {
        var q = u.searchInput.value.toLowerCase();
        if (currentMode === 'fav') {
            var favUrls = getFavorites();
            var items = allItems.filter(function (ch) {
                return favUrls.indexOf(ch.cmd || '') !== -1 && (ch.name || ch.title || '').toLowerCase().indexOf(q) !== -1;
            });
            renderContentList(items);
        } else if (currentCategory === 'all') {
            renderContentList(allItems.filter(function (ch) {
                return (ch.name || ch.title || '').toLowerCase().indexOf(q) !== -1;
            }));
        } else {
            renderContentList(allItems.filter(function (ch) {
                return String(ch.tv_genre_id || ch.category_id || '') === String(currentCategory) &&
                    (ch.name || ch.title || '').toLowerCase().indexOf(q) !== -1;
            }));
        }
    });

    // ─── Select channel / preview ───
    function selectChannel(ch, li) {
        selectedChannel = ch;
        u.contentList.querySelectorAll('li').forEach(function (l) { l.classList.remove('selected'); });
        if (li) li.classList.add('selected');
        u.epgTitle.textContent = ch.name || ch.title || '';
        u.epgDesc.textContent = ch.epg_desc || ch.description || '';
        playPreview(ch.cmd || '');
        u.previewFsBtn.classList.remove('hidden');
    }

    function destroyPreview() {
        if (previewHls) { previewHls.destroy(); previewHls = null; }
        if (previewMpegts) { previewMpegts.destroy(); previewMpegts = null; }
        u.previewPlayer.pause();
        u.previewPlayer.src = '';
        u.previewFsBtn.classList.add('hidden');
    }

    u.previewFsBtn.addEventListener('click', function () {
        if (selectedChannel) goFullscreen(selectedChannel.cmd || '');
    });

    async function playPreview(cmd) {
        destroyPreview();
        if (!cmd || !stalkerClient) return;
        try {
            var url = await stalkerClient.createLink(cmd);
            var proxied = getProxiedUrl(url);
            console.log('Preview:', proxied);

            u.previewPlayer.muted = false;
            u.previewPlayer.crossOrigin = 'anonymous';

            var mpegtsOk = typeof mpegts !== 'undefined' && mpegts.isSupported && mpegts.isSupported();
            var hlsOk = typeof Hls !== 'undefined' && Hls.isSupported();

            if (isMpegTs(url) && mpegtsOk) {
                previewMpegts = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: proxied });
                previewMpegts.attachMediaElement(u.previewPlayer);
                previewMpegts.load();
                previewMpegts.play().catch(function () {});
            } else if (isM3u8(url) && hlsOk) {
                previewHls = new Hls({ debug: false });
                previewHls.loadSource(proxied);
                previewHls.attachMedia(u.previewPlayer);
                previewHls.on(Hls.Events.MANIFEST_PARSED, function () {
                    u.previewPlayer.play().catch(function () {});
                });
            } else {
                u.previewPlayer.src = proxied;
                u.previewPlayer.play().catch(function () {});
            }
        } catch (e) {
            console.error('Preview error:', e);
        }
    }

    // ─── Fullscreen ───
    function goFullscreen(cmd) {
        u.previewFsBtn.classList.add('hidden');
        destroyPreview();
        if (!cmd || !stalkerClient) return;
        playChannel(cmd);
    }

    async function playChannel(cmd) {
        showScreen('player');
        u.playerLoader.classList.remove('hidden');
        u.videoPlayer.crossOrigin = 'anonymous';

        // Destroy previous
        if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
        if (mpegtsPlayer) { mpegtsPlayer.destroy(); mpegtsPlayer = null; }
        u.videoPlayer.src = '';

        try {
            var url = await stalkerClient.createLink(cmd);
            var proxied = getProxiedUrl(url);
            console.log('Fullscreen:', proxied);

            var mpegtsOk = typeof mpegts !== 'undefined' && mpegts.isSupported && mpegts.isSupported();
            var hlsOk = typeof Hls !== 'undefined' && Hls.isSupported();
            var tried = [];

            // Try mpegts first for TS streams
            if (isMpegTs(url) && mpegtsOk) {
                tried.push('mpegts');
                console.log('Trying mpegts.js');
                tryMpegts(proxied, url, hlsOk, proxied);
                return;
            }

            // Try HLS for m3u8
            if (isM3u8(url) && hlsOk) {
                tried.push('hls');
                console.log('Trying HLS.js');
                tryHls(proxied, url);
                return;
            }

            // Native fallback
            tried.push('native');
            tryNative(proxied, url);

        } catch (e) {
            console.error('Play error:', e);
            showPlayerError('Error: ' + e.message, url);
        }

        function tryMpegts(streamUrl, rawUrl, fallbackHls, fallbackNative) {
            if (mpegtsPlayer) { mpegtsPlayer.destroy(); mpegtsPlayer = null; }
            mpegtsPlayer = mpegts.createPlayer({ type: 'mpegts', isLive: true, url: streamUrl });
            mpegtsPlayer.attachMediaElement(u.videoPlayer);
            mpegtsPlayer.load();
            mpegtsPlayer.play().catch(function (e) {
                console.error('mpegts play error:', e);
                fallbackFromMpegts();
            });
            var errored = false;
            mpegtsPlayer.on(mpegts.Events.ERROR, function (type, detail, info) {
                if (errored) return;
                errored = true;
                console.error('mpegts error:', type, detail, info);
                if (mpegtsPlayer) { mpegtsPlayer.destroy(); mpegtsPlayer = null; }
                if (fallbackHls && isM3u8(rawUrl)) {
                    console.log('mpegts failed, trying HLS');
                    tryHls(streamUrl, rawUrl);
                } else {
                    console.log('mpegts failed, trying native');
                    tryNative(streamUrl, rawUrl);
                }
            });
            u.playerLoader.classList.add('hidden');
            onPlayerReady();
        }

        function fallbackFromMpegts() {
            if (mpegtsPlayer) { mpegtsPlayer.destroy(); mpegtsPlayer = null; }
            if (hlsOk && isM3u8(url)) {
                tryHls(proxied, url);
            } else {
                tryNative(proxied, url);
            }
        }

        function tryHls(streamUrl, rawUrl) {
            if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
            u.videoPlayer.src = '';
            hlsInstance = new Hls({ debug: false, enableWorker: true, lowLatencyMode: true });
            hlsInstance.loadSource(streamUrl);
            hlsInstance.attachMedia(u.videoPlayer);
            hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
                u.playerLoader.classList.add('hidden');
                u.videoPlayer.play().catch(function () {});
                onPlayerReady();
            });
            var hlsErrored = false;
            hlsInstance.on(Hls.Events.ERROR, function (event, data) {
                if (hlsErrored) return;
                if (data.fatal) {
                    hlsErrored = true;
                    console.error('HLS fatal error:', data);
                    hlsInstance.destroy(); hlsInstance = null;
                    tryNative(streamUrl, rawUrl);
                }
            });
            setTimeout(function () {
                u.playerLoader.classList.add('hidden');
            }, 3000);
        }

        function tryNative(streamUrl, rawUrl) {
            u.videoPlayer.src = streamUrl;
            u.videoPlayer.play().catch(function (e) {
                console.error('Native play error:', e);
                showPlayerError('Cannot play this stream. Copy URL to VLC.', rawUrl);
            });
            u.videoPlayer.addEventListener('playing', function () {
                u.playerLoader.classList.add('hidden');
                onPlayerReady();
            }, { once: true });
            u.videoPlayer.addEventListener('error', function () {
                u.playerLoader.classList.add('hidden');
                showPlayerError('Playback error - Stream URL:', rawUrl);
            }, { once: true });
            setTimeout(function () {
                u.playerLoader.classList.add('hidden');
            }, 3000);
        }

        function onPlayerReady() {
            showInfoBanner();
            setTimeout(hideInfoBanner, 4000);
        }
    }

    function showPlayerError(msg, rawUrl) {
        u.playerLoader.classList.add('hidden');
        // Show error overlay with VLC link
        var existing = document.querySelector('.plyr-error');
        if (existing) existing.remove();
        var div = document.createElement('div');
        div.className = 'plyr-error';
        div.style.cssText = 'position:absolute;bottom:60px;left:20px;right:20px;background:rgba(0,0,0,0.85);padding:12px 16px;border-radius:6px;text-align:center;z-index:20;';
        var url = rawUrl || '';
        if (rawUrl && rawUrl.indexOf('play_token=') !== -1) {
            url = rawUrl.replace(/play_token=[^&]+/, 'play_token=XXX').replace(/token=[^&]+/, 'token=XXX');
        }
        div.innerHTML = '<div style="color:#f88;font-size:13px;margin-bottom:6px;">' + escapeHtml(msg) + '</div>' +
            (url ? '<div style="font-size:11px;color:#aaa;word-break:break-all;">' + escapeHtml(url) + '</div>' : '') +
            '<button onclick="this.parentElement.remove()" style="margin-top:8px;padding:4px 16px;background:#0a7;color:#fff;border:none;border-radius:4px;cursor:pointer;">Dismiss</button>';
        u.videoPlayer.parentElement.appendChild(div);
    }

    // ─── Info banner ───
    var bannerTimer = null;
    function showInfoBanner() {
        var banner = document.getElementById('info-banner');
        if (!banner) return;
        banner.classList.remove('hidden2');
        if (selectedChannel) {
            u.bannerName.textContent = selectedChannel.name || selectedChannel.title || '';
            u.bannerProg.textContent = selectedChannel.epg_desc || selectedChannel.description || '';
            u.bannerLogo.src = selectedChannel.logo || selectedChannel.screenshot_uri || '';
            u.bannerLogo.onerror = function () { this.style.display = 'none'; };
            u.bannerLogo.style.display = '';
        }
        if (bannerTimer) clearTimeout(bannerTimer);
        bannerTimer = setTimeout(hideInfoBanner, 4000);
    }
    function hideInfoBanner() {
        var banner = document.getElementById('info-banner');
        if (banner) banner.classList.add('hidden2');
    }

    // Keyboard: Back/Escape to exit player
    document.addEventListener('keydown', function (e) {
        if (!screens.player.classList.contains('hidden')) {
            if (e.key === 'Escape' || e.keyCode === 461) {
                e.preventDefault();
                // Stop fullscreen
                if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }
                if (mpegtsPlayer) { mpegtsPlayer.destroy(); mpegtsPlayer = null; }
                u.videoPlayer.pause();
                u.videoPlayer.src = '';
                showScreen('menu');
                if (selectedChannel) playPreview(selectedChannel.cmd || '');
            }
        }
        // H on player to toggle info banner
        if (!screens.player.classList.contains('hidden') && (e.key === 'h' || e.key === 'H')) {
            showInfoBanner();
        }
    });

    // Double-click on player to toggle info
    u.videoPlayer.addEventListener('dblclick', function () {
        showInfoBanner();
    });

    // ─── Init saved portals on login ───
    renderSavedPortals();

    // If only one saved portal, auto-fill form
    var portals = getPortals();
    if (portals.length === 1) {
        u.portalInput.value = portals[0].portal;
        u.macInput.value = portals[0].mac;
        u.username.value = portals[0].username || '';
        u.password.value = portals[0].password || '';
    }

    console.log('Dashboard ready');
});
