// Main App Logic

document.addEventListener('DOMContentLoaded', () => {
    const screens = {
        login: document.getElementById('login-screen'),
        loading: document.getElementById('loading-screen'),
        menu: document.getElementById('main-menu'),
        player: document.getElementById('player-screen')
    };

    const ui = {
        portalInput: document.getElementById('portal-url'),
        macInput: document.getElementById('mac-address'),
        usernameInput: document.getElementById('username'),
        passwordInput: document.getElementById('password'),
        connectBtn: document.getElementById('connect-btn'),
        statusMsg: document.getElementById('status-message'),
        channelList: document.getElementById('channel-list'),
        videoPlayer: document.getElementById('video-player'),
        previewPlayer: document.getElementById('preview-player'),
        epgChannelName: document.getElementById('epg-channel-name'),
        epgProgramTitle: document.getElementById('epg-program-title'),
        epgProgramTime: document.getElementById('epg-program-time'),
        epgProgramDesc: document.getElementById('epg-program-desc'),
        channelSearch: document.getElementById('channel-search'),
        infoBanner: document.getElementById('info-banner'),
        bannerLogo: document.getElementById('banner-logo'),
        bannerChannelNumber: document.getElementById('banner-channel-number'),
        bannerChannelName: document.getElementById('banner-channel-name'),
        bannerProgramTitle: document.getElementById('banner-program-title'),
        bannerProgramTime: document.getElementById('banner-program-time'),
        bannerProgressBar: document.getElementById('banner-progress-bar'),
        bannerResolution: document.getElementById('banner-resolution'),
        bannerCurrentTime: document.getElementById('banner-current-time'),
        loadingMessage: document.getElementById('loading-message'),
        // New UI Elements
        modeTv: document.getElementById('mode-tv'),
        modeVod: document.getElementById('mode-vod'),
        modeSettings: document.getElementById('mode-settings'),
        categoryList: document.getElementById('category-list'),
        listTitle: document.getElementById('list-title'),
        playerLoader: document.getElementById('player-loader'),
        // Movie Grid UI
        tvViewContainer: document.getElementById('tv-view-container'),
        movieViewContainer: document.getElementById('movie-view-container'),
        movieGrid: document.getElementById('movie-grid'),
        movieSearch: document.getElementById('movie-search'),
        previewFsBtn: document.getElementById('preview-fs-btn')
    };

    // Default MAC (mock for browser)
    // ui.macInput.value is already set in HTML or we can set a default here if needed
    // const mockMac = "00:1A:79:00:00:01"; 
    // ui.macInput.value = mockMac;

    let stalkerClient = null;
    let hlsInstance = null; // hls.js instance for fullscreen player
    let mpegtsPlayer = null;
    let previewHls = null; // hls.js instance for preview player
    let previewMpegts = null;
    let selectedChannel = null; // Currently selected channel
    let channelsData = []; // Store channel data
    let controlsTimeout = null; // Timer for auto-hiding player controls

    let currentMode = 'tv'; // 'tv' or 'vod'
    let currentCategoryId = 'all';
    let categoriesData = [];

    // Navigation state
    let currentFocus = ui.portalInput; // Starting focus

    // Initial focus set
    ui.portalInput.focus();

    // Load saved credentials
    if (localStorage.getItem('portal_url')) {
        ui.portalInput.value = localStorage.getItem('portal_url');
    }
    if (localStorage.getItem('mac_address')) {
        ui.macInput.value = localStorage.getItem('mac_address');
    }
    if (localStorage.getItem('username')) {
        ui.usernameInput.value = localStorage.getItem('username');
    }
    if (localStorage.getItem('password')) {
        ui.passwordInput.value = localStorage.getItem('password');
    }

    // Auto-login only on app startup
    // "The auto login is only done when the app opens"
    if (!window.hasTriedAutoLogin && ui.portalInput.value && ui.macInput.value) {
        window.hasTriedAutoLogin = true;
        showScreen('loading');
        handleConnect();
    } else {
        ui.portalInput.focus();
    }

    // Event Listeners
    ui.connectBtn.addEventListener('click', handleConnect);

    // Mode Switchers
    ui.modeTv.addEventListener('click', () => switchMode('tv'));
    ui.modeVod.addEventListener('click', () => switchMode('vod'));
    ui.modeSettings.addEventListener('click', () => {
        showScreen('login');
        if (previewHls) {
            previewHls.destroy();
            previewHls = null;
        }
        ui.previewPlayer.src = '';
    });

    // settingsBtn removed in favor of modeSettings


    // Search functionality
    ui.channelSearch.addEventListener('input', filterChannels);
    ui.movieSearch.addEventListener('input', filterChannels); // Reuse filter logic for now

    // Remote Control Key Handling
    document.addEventListener('keydown', handleKeyInput);

    // Fullscreen button from preview
    ui.previewFsBtn.addEventListener('click', function() {
        if (selectedChannel) {
            goFullscreen(selectedChannel.url);
        }
    });

    async function handleConnect() {
        const url = ui.portalInput.value;
        const username = ui.usernameInput.value;
        const password = ui.passwordInput.value;

        let mac = ui.macInput.value.toUpperCase().replace(/[^A-F0-9]/g, '');
        if (mac.length === 12) mac = mac.match(/.{2}/g).join(':');
        ui.macInput.value = mac;

        if (!url) {
            showStatus("Please enter a Portal URL", "error");
            return;
        }

        if (!mac) {
            showStatus("Please enter a MAC Address", "error");
            return;
        }

        showStatus("Connecting...", "info");

        stalkerClient = new StalkerClient(url, mac);

        try {
            await stalkerClient.authenticate(username, password);

            // Save credentials on success
            localStorage.setItem('portal_url', url);
            localStorage.setItem('mac_address', mac);
            localStorage.setItem('username', username);
            localStorage.setItem('password', password);

            showStatus("Connected! Loading data...", "success");

            // Initial Load
            await loadCategories();
            // loadChannels called by loadCategories -> selectCategory

        } catch (err) {
            showStatus("Connection failed: " + err.message, "error");
            if (!screens.loading.classList.contains('hidden')) {
                showScreen('login');
            }
        }
    }

    async function switchMode(mode) {
        if (currentMode === mode) return;

        currentMode = mode;

        // Update UI Tabs
        ui.modeTv.classList.toggle('active', mode === 'tv');
        ui.modeVod.classList.toggle('active', mode === 'vod');

        // Toggle Views
        if (mode === 'tv') {
            ui.tvViewContainer.classList.remove('hidden');
            ui.movieViewContainer.classList.add('hidden');
        } else {
            ui.tvViewContainer.classList.add('hidden');
            ui.movieViewContainer.classList.remove('hidden');
        }

        // Reset Category
        currentCategoryId = 'all';
        selectedChannel = null;

        // Reload Categories & Content
        showScreen('loading');
        await loadCategories();
    }

    async function loadCategories() {
        try {
            ui.listTitle.textContent = currentMode === 'tv' ? 'Channels' : 'Movies';

            let categories = [];
            if (currentMode === 'tv') {
                categories = await stalkerClient.getGenres();
            } else {
                categories = await stalkerClient.getVodCategories();
            }

            // Prepend "All"
            categories.unshift({ id: 'all', title: 'All', alias: 'All' });

            renderCategories(categories);

            // Select "All" by default and load content
            selectCategory('all');

        } catch (err) {
            console.error("Failed to load categories", err);
            showStatus("Failed to load categories", "error");
        }
    }

    function renderCategories(categories) {
        categoriesData = categories;
        ui.categoryList.innerHTML = '';

        categories.forEach((cat, index) => {
            const li = document.createElement('li');
            li.className = 'category-item';
            li.textContent = cat.title;
            li.dataset.id = cat.id;
            li.tabIndex = 0;

            if (cat.id === currentCategoryId) {
                li.classList.add('selected');
            }

            li.onclick = () => selectCategory(cat.id);
            li.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') selectCategory(cat.id);
            });

            ui.categoryList.appendChild(li);
        });
    }

    async function selectCategory(catId) {
        currentCategoryId = catId;

        // Update UI
        const items = ui.categoryList.querySelectorAll('.category-item');
        items.forEach(i => {
            if (i.dataset.id == catId) i.classList.add('selected');
            else i.classList.remove('selected');
        });

        // Load Content
        if (!screens.loading.classList.contains('hidden')) {
            // optimize: only show loading if switching big contexts
        }

        await loadContent();
    }

    async function loadContent() {
        try {
            let data = [];
            if (currentMode === 'tv') {
                data = await stalkerClient.getChannels(currentCategoryId);
                renderChannelList(data);
            } else {
                data = await stalkerClient.getVodList(currentCategoryId);
                renderMovieList(data);
            }

            showScreen('menu');

            // Focus logic remains similar
        } catch (err) {
            console.error(err);
            showStatus("Failed to load content", "error");
        }
    }


    function renderChannelList(channels) {
        channelsData = channels; // reusing same variable for vod items too
        ui.channelList.innerHTML = '';

        if (channels.length === 0) {
            ui.channelList.innerHTML = '<div style="padding:20px; color:#666;">No content found</div>';
            return;
        }

        channels.forEach((ch, index) => {
            const li = document.createElement('li');
            li.className = 'channel-item';
            li.tabIndex = 0;
            li.dataset.url = ch.url;
            li.dataset.index = index;

            // Add logo if available
            if (ch.logo) {
                const img = document.createElement('img');
                img.src = ch.logo;
                img.className = 'channel-logo';
                img.alt = '';
                img.onerror = function () { this.style.display = 'none'; };
                li.appendChild(img);
            }

            // Add info
            const info = document.createElement('span');
            info.className = 'channel-info';
            // For VOD, we might not have numbers, just names
            info.textContent = ch.number ? `${ch.number}. ${ch.name}` : ch.name;
            li.appendChild(info);

            li.onclick = () => handleChannelClick(ch, li);

            li.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') handleChannelClick(ch, li);
            });

            ui.channelList.appendChild(li);
        });
    }

    function renderMovieList(movies) {
        channelsData = movies; // Reuse same data store
        ui.movieGrid.innerHTML = '';

        if (movies.length === 0) {
            ui.movieGrid.innerHTML = '<div style="padding:20px; color:#666;">No movies found</div>';
            return;
        }

        movies.forEach((movie, index) => {
            const card = document.createElement('div');
            card.className = 'movie-card';
            card.tabIndex = 0;
            card.dataset.url = movie.url; // Or ID if VOD needs distinct call?
            card.dataset.index = index;

            // Poster
            const poster = document.createElement('img');
            poster.src = movie.logo || 'images/no-poster.png'; // Fallback
            poster.className = 'movie-poster';
            poster.alt = movie.name;
            poster.onerror = function () { this.src = 'https://via.placeholder.com/300x450?text=No+Poster'; }; // Simple placeholder

            // Info
            const info = document.createElement('div');
            info.className = 'movie-info';
            const title = document.createElement('div');
            title.className = 'movie-title';
            title.textContent = movie.name;

            info.appendChild(title);
            card.appendChild(poster);
            card.appendChild(info);

            card.onclick = () => handleChannelClick(movie, card); // Reuse play logic for now

            card.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') handleChannelClick(movie, card);
            });

            ui.movieGrid.appendChild(card);
        });
    }

    function filterChannels() {
        const query = (currentMode === 'tv' ? ui.channelSearch.value : ui.movieSearch.value).toLowerCase().trim();

        if (!query) {
            // Show all
            if (currentMode === 'tv') renderChannelList(channelsData);
            else renderMovieList(channelsData);
            return;
        }

        // Filter
        const filtered = channelsData.filter(ch =>
            ch.name.toLowerCase().includes(query) ||
            (ch.number && ch.number.toString().includes(query))
        );

        if (currentMode === 'tv') renderChannelList(filtered);
        else renderMovieList(filtered);
    }

    function handleChannelClick(channel, element) {
        if (selectedChannel && selectedChannel.url === channel.url) {
            // Same channel clicked again - go fullscreen
            goFullscreen(channel.url);
        } else {
            // New channel selected - play preview
            // Only preview in TV mode? Netflix usually just plays when you click, or shows details.
            // For now, let's just make it "select" visually, or maybe just play.
            if (currentMode === 'tv') {
                selectChannel(channel, element);
            } else {
                // In movie mode, click usually triggers details or play.
                // Let's go straight to fullscreen for movies for now?
                goFullscreen(channel.url);
            }
        }
    }

    function selectChannel(channel, element) {
        // Update selected state
        const allItems = ui.channelList.querySelectorAll('.channel-item');
        allItems.forEach(item => item.classList.remove('selected'));
        element.classList.add('selected');

        selectedChannel = channel;

        // Update EPG info (or Movie Info)
        updateEpgInfo(channel);

        // Play preview
        playPreview(channel.url);
    }

    function updateEpgInfo(channel) {
        ui.epgChannelName.textContent = channel.name || '';

        if (currentMode === 'vod') {
            // Show Movie Info
            ui.epgProgramTitle.textContent = channel.year ? `Year: ${channel.year}` : '';
            ui.epgProgramTime.textContent = channel.rating ? `Rating: ${channel.rating}` : '';
            ui.epgProgramDesc.textContent = channel.description || '';
        } else {
            // Show TV EPG
            if (channel.epg) {
                ui.epgProgramTitle.textContent = channel.epg.title || '';
                ui.epgProgramTime.textContent = channel.epg.time || '';
                ui.epgProgramDesc.textContent = channel.epg.description || '';
            } else {
                ui.epgProgramTitle.textContent = 'No program info available';
                ui.epgProgramTime.textContent = '';
                ui.epgProgramDesc.textContent = '';
            }
        }
    }

    function getProxiedUrl(url) {
        var isCrossOrigin = url.indexOf(location.protocol + '//' + location.host) !== 0 && url.indexOf('//' + location.host) === -1;
        if (!isCrossOrigin) return url;
        var sgBase = window.location.hostname.indexOf('vercel') !== -1 ? '/api/stalker/stream-get' : 'https://stalker-p.vercel.app/api/stalker/stream-get';
        var token = (stalkerClient && stalkerClient.token) || '';
        return sgBase + '?url=' + encodeURIComponent(url) + (token ? '&token=' + encodeURIComponent(token) : '');
    }

    function isMpegTs(url) {
        return url.indexOf('.ts') !== -1 || url.indexOf('extension=ts') !== -1;
    }

    async function playPreview(url) {
        // Destroy previous preview instance
        if (previewHls) {
            previewHls.destroy();
            previewHls = null;
        }
        if (previewMpegts) {
            previewMpegts.destroy();
            previewMpegts = null;
        }

        // Show fullscreen button
        ui.previewFsBtn.classList.remove('hidden');

        try {
            const cleanUrl = await stalkerClient.createLink(url);
            // Use proxy for preview
            const proxiedUrl = getProxiedUrl(cleanUrl);

            console.log('Playing preview:', proxiedUrl);

            // Ensure sound is on
            ui.previewPlayer.muted = false;
            ui.previewPlayer.crossOrigin = 'anonymous';

            // Check for mpegts.js support
            var isMpegtsAvailable = typeof mpegts !== 'undefined' &&
                (typeof mpegts.isSupported === 'function' ? mpegts.isSupported() : mpegts.isSupported);

            if (isMpegTs(cleanUrl) && isMpegtsAvailable) {
                console.log("Using mpegts.js for preview");
                previewMpegts = mpegts.createPlayer({
                    type: 'mpegts',
                    isLive: true,
                    url: proxiedUrl
                });
                previewMpegts.attachMediaElement(ui.previewPlayer);
                previewMpegts.load();
                previewMpegts.play().catch(e => console.log('Preview autoplay blocked'));
            } else if (isMpegTs(cleanUrl)) {
                console.log("TS preview, using native video");
                ui.previewPlayer.src = proxiedUrl;
                ui.previewPlayer.play().catch(e => console.log('Preview autoplay blocked'));
            } else if (Hls.isSupported()) {
                previewHls = new Hls({
                    debug: false,
                    enableWorker: true
                });
                previewHls.loadSource(proxiedUrl);
                previewHls.attachMedia(ui.previewPlayer);

                previewHls.on(Hls.Events.MANIFEST_PARSED, function () {
                    ui.previewPlayer.play().catch(e => console.log('Preview autoplay blocked'));
                });
            } else if (ui.previewPlayer.canPlayType('application/vnd.apple.mpegurl')) {
                // Native Safari HLS doesn't need proxy usually if it handles CORS differently, 
                // but if it's strict, it might. Safari usually is strict.
                ui.previewPlayer.src = proxiedUrl;
            }
        } catch (e) {
            console.error('Preview error:', e);
        }
    }

    function goFullscreen(url) {
        ui.previewFsBtn.classList.add('hidden');
        // Stop preview
        if (previewHls) {
            previewHls.destroy();
            previewHls = null;
        }
        if (previewMpegts) {
            previewMpegts.destroy();
            previewMpegts = null;
        }
        ui.previewPlayer.pause();
        ui.previewPlayer.src = '';

        // Play in fullscreen
        playChannel(url);
    }

    async function playChannel(url) {
        try {
            const cleanUrl = await stalkerClient.createLink(url);
            console.log("Playing URL:", cleanUrl);

            // Show player screen FIRST so video element is visible when setting up
            showScreen('player');

            // Try webOS Luna API to launch native media player
            if (typeof webOS !== 'undefined' && webOS.service && webOS.service.request) {
                console.log("Using webOS Luna API");
                // Native player usually handles streams better, might not need proxy 
                // if the TV platform allows it. But if it fails, maybe try proxy?
                // Let's use raw URL for native first.
                webOS.service.request("luna://com.webos.applicationManager", {
                    method: "launch",
                    parameters: {
                        id: "com.webos.app.photovideo",
                        params: {
                            target: cleanUrl,
                            type: "video"
                        }
                    },
                    onSuccess: function (res) {
                        console.log("Launched native player:", res);
                    },
                    onFailure: function (err) {
                        console.error("Failed to launch native player:", err);
                        // Fallback to HTML5 video -> Use Proxy
                        playWithHtml5(cleanUrl);
                    }
                });
            } else {
                // Fallback for browser/simulator without Luna
                playWithHtml5(cleanUrl);
            }

            // ui.backBtn is removed, rely on document key handler
            currentFocus = null;
            showStatus("Playing...", "success");
        } catch (e) {
            console.error("Play error:", e);
            showStatus("Error playing video: " + e.message, "error");
        }
    }

    function playWithHtml5(url) {
        const video = ui.videoPlayer;
        video.crossOrigin = 'anonymous';
        const proxiedUrl = getProxiedUrl(url);
        console.log("HTML5 Playback URL:", proxiedUrl);

        // Show spinner
        ui.playerLoader.classList.remove('hidden');

        // Destroy previous instances
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }
        if (mpegtsPlayer) {
            mpegtsPlayer.destroy();
            mpegtsPlayer = null;
        }

        // Detect Format
        if (isMpegTs(url) && typeof mpegts !== 'undefined' && mpegts.isSupported()) {
            console.log("Using mpegts.js for fullscreen");
            var mpegtsFallback = false;
            mpegtsPlayer = mpegts.createPlayer({
                type: 'mpegts',
                isLive: true,
                url: proxiedUrl
            });
            mpegtsPlayer.attachMediaElement(video);
            mpegtsPlayer.load();
            mpegtsPlayer.play().catch(function (e) {
                console.error('mpegts playback failed:', e);
                showStatus("Playback failed: " + e.message, "error");
                mpegtsFallback = true;
            });

            mpegtsPlayer.on(mpegts.Events.ERROR, function(errorType, errorDetail, errorInfo) {
                console.log("mpegts error:", errorType, errorDetail, errorInfo);
                if (mpegtsFallback) return;
                if (errorType === mpegts.ErrorTypes.NETWORK_ERROR) {
                    console.log("mpegts network error, trying native video fallback");
                    showStatus("Stream unstable, switching to VLC link...", "info");
                    mpegtsFallback = true;
                    if (mpegtsPlayer) { mpegtsPlayer.destroy(); mpegtsPlayer = null; }
                    video.src = proxiedUrl;
                    video.play().catch(function(e) {
                        console.error('Native fallback also failed:', e);
                        showStatus("Stream URL: " + url + " (Copy to VLC)", "info");
                    });
                }
            });

        } else if (isMpegTs(url)) {
            // TS stream on Firefox or mpegts unavailable — use native video
            console.log("TS stream, using native video");
            video.src = proxiedUrl;
            video.play().catch(function (e) {
                console.error('Native TS playback failed:', e);
                showStatus("Stream URL: " + url + " (Copy to VLC)", "info");
            });
        } else if (Hls.isSupported()) {
            hlsInstance = new Hls({
                debug: false,
                enableWorker: true,
                lowLatencyMode: true
            });

            hlsInstance.loadSource(proxiedUrl);
            hlsInstance.attachMedia(video);

            hlsInstance.on(Hls.Events.MANIFEST_PARSED, function () {
                console.log('HLS manifest parsed, starting playback');
                video.play().catch(function (e) {
                    console.error('Playback failed:', e);
                    showStatus("Playback failed: " + e.message, "error");
                });
            });

            hlsInstance.on(Hls.Events.ERROR, function (event, data) {
                console.error('HLS error:', data);
                if (data.fatal) {
                    switch (data.type) {
                        case Hls.ErrorTypes.NETWORK_ERROR:
                            console.log('Network error, trying to recover...');
                            hlsInstance.startLoad();
                            break;
                        case Hls.ErrorTypes.MEDIA_ERROR:
                            console.log('Media error, trying to recover...');
                            hlsInstance.recoverMediaError();
                            break;
                        default:
                            showStatus("Fatal playback error - Stream URL: " + url, "error");
                            hlsInstance.destroy();
                            break;
                    }
                }
            });
        } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Native HLS support (Safari)
            video.src = proxiedUrl;
            video.addEventListener('loadedmetadata', function () {
                video.play().catch(function (e) {
                    console.error('Native HLS playback failed:', e);
                });
            });
        } else {
            // Fallback: try direct playback
            console.log('HLS/MPEGTS not supported, trying direct playback');
            video.src = proxiedUrl;
            video.play().catch(function (e) {
                console.error('Direct playback failed:', e);
                showStatus("Stream URL: " + url + " (Copy to VLC)", "info");
            });
        }

        // Hide spinner when video starts playing
        const onPlaying = () => {
            ui.playerLoader.classList.add('hidden');
            video.removeEventListener('playing', onPlaying);
            video.removeEventListener('error', onError);
        };
        const onError = () => {
            ui.playerLoader.classList.add('hidden');
            video.removeEventListener('playing', onPlaying);
            video.removeEventListener('error', onError);
        }

        video.addEventListener('playing', onPlaying);
        video.addEventListener('error', onError);
    }

    function stopPlayer() {
        // Destroy hls.js instance
        if (hlsInstance) {
            hlsInstance.destroy();
            hlsInstance = null;
        }
        if (mpegtsPlayer) {
            mpegtsPlayer.destroy();
            mpegtsPlayer = null;
        }
        // Stop and reset video
        ui.videoPlayer.pause();
        ui.videoPlayer.src = '';
        showScreen('menu');
        // Restore focus to list and resume preview
        restoreFocusToChannel();
        if (selectedChannel) {
            playPreview(selectedChannel.url);
        }
    }

    function showStatus(msg, type) {
        ui.statusMsg.textContent = msg;
        ui.statusMsg.style.color = type === 'error' ? 'red' : 'green';

        // Also update loading message if visible
        if (!screens.loading.classList.contains('hidden')) {
            ui.loadingMessage.textContent = msg;
        }
    }

    function showScreen(screenName) {
        Object.values(screens).forEach(s => s.classList.add('hidden'));
        screens[screenName].classList.remove('hidden');
    }
    function handleKeyInput(e) {
        // Show info banner on any key press when in player screen
        if (!screens.player.classList.contains('hidden')) {
            showInfoBanner();
        }

        const isMenuVisible = !screens.menu.classList.contains('hidden');
        const activeEl = document.activeElement;

        switch (e.keyCode) {
            case 461: // WebOS Back button
                if (!screens.player.classList.contains('hidden')) {
                    e.preventDefault(); // Prevent app exit
                    stopPlayer();
                } else if (isMenuVisible) {
                    // Check if we are in sidebar or channel list
                    if (activeEl.classList.contains('channel-item')) {
                        // Focus Sidebar Category
                        const currentCat = ui.categoryList.querySelector('.category-item.selected');
                        if (currentCat) currentCat.focus();
                    } else if (activeEl.classList.contains('movie-card')) {
                        // Focus Sidebar Category from Movie Grid
                        const currentCat = ui.categoryList.querySelector('.category-item.selected');
                        if (currentCat) currentCat.focus();
                    } else if (activeEl.classList.contains('category-item') || activeEl.classList.contains('mode-btn')) {
                        e.preventDefault();
                        showScreen('login');
                        // Stop preview
                        if (previewHls) {
                            previewHls.destroy();
                            previewHls = null;
                        }
                        ui.previewPlayer.src = '';
                    } else {
                        // Default back to login
                        e.preventDefault();
                        showScreen('login');
                    }
                } else if (!screens.loading.classList.contains('hidden')) {
                    // Cancel loading -> go to login
                    e.preventDefault();
                    showScreen('login');
                } else if (!screens.login.classList.contains('hidden')) {
                    // On login screen
                    if (channelsData.length > 0) {
                        // We have channels (came from settings button), go back to menu
                        e.preventDefault();
                        showScreen('menu');
                        restoreFocusToChannel(true);
                    } else {
                        // No channels (fresh start), allow default behavior (Exit App)
                    }
                }
                break;
            case 38: // Up
                if (isMenuVisible) {
                    e.preventDefault(); // Always prevent default scroll

                    if (document.activeElement === ui.channelSearch) {
                        ui.modeTv.focus();
                    } else if (document.activeElement && document.activeElement.classList.contains('channel-item')) {
                        const prev = document.activeElement.previousElementSibling;
                        if (prev) {
                            prev.focus();
                            prev.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        } else {
                            // Top of list -> Go to Search
                            ui.channelSearch.focus();
                        }
                    } else if (document.activeElement && document.activeElement.classList.contains('movie-card')) {
                        // Movie Grid Up
                        const index = parseInt(document.activeElement.dataset.index);
                        const cards = Array.from(ui.movieGrid.querySelectorAll('.movie-card'));
                        const gridStyle = window.getComputedStyle(ui.movieGrid);
                        const colCount = gridStyle.gridTemplateColumns.split(' ').length;
                        if (index >= colCount) {
                            const target = cards[index - colCount];
                            if (target) {
                                target.focus();
                                target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                            }
                        } else {
                            ui.movieSearch.focus();
                        }
                    } else if (document.activeElement && document.activeElement.classList.contains('category-item')) {
                        const prev = document.activeElement.previousElementSibling;
                        if (prev) {
                            prev.focus();
                            prev.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        }
                    } else if (document.activeElement !== ui.channelSearch && document.activeElement !== ui.movieSearch) {
                        // Focus lost? Restore to selected or first
                        restoreFocusToChannel(true);
                    }
                }
                break;
            case 40: // Down
                if (isMenuVisible) {
                    e.preventDefault(); // Always prevent default scroll

                    if (document.activeElement === ui.modeTv || document.activeElement === ui.modeVod || document.activeElement === ui.modeSettings) {
                        ui.channelSearch.focus();
                    } else if (document.activeElement === ui.channelSearch) {
                        const first = ui.channelList.querySelector('.channel-item');
                        if (first) {
                            first.focus();
                            first.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        }
                    } else if (document.activeElement === ui.movieSearch) {
                        const first = ui.movieGrid.querySelector('.movie-card');
                        if (first) {
                            first.focus();
                            first.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        }
                    } else if (document.activeElement && document.activeElement.classList.contains('channel-item')) {
                        const next = document.activeElement.nextElementSibling;
                        if (next) {
                            next.focus();
                            next.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        }
                    } else if (document.activeElement && document.activeElement.classList.contains('movie-card')) {
                        // Movie Grid Down
                        const index = parseInt(document.activeElement.dataset.index);
                        const cards = Array.from(ui.movieGrid.querySelectorAll('.movie-card'));
                        const gridStyle = window.getComputedStyle(ui.movieGrid);
                        const colCount = gridStyle.gridTemplateColumns.split(' ').length;

                        const target = cards[index + colCount];
                        if (target) {
                            target.focus();
                            target.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        }
                    } else if (document.activeElement && document.activeElement.classList.contains('category-item')) {
                        const next = document.activeElement.nextElementSibling;
                        if (next) {
                            next.focus();
                            next.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        }
                    } else {
                        // Focus lost? Restore to selected or first
                        restoreFocusToChannel(true);
                    }
                }
                break;
            case 37: // Left
                if (isMenuVisible) {
                    if (activeEl.classList.contains('channel-item')) {
                        // Move to Category List
                        const currentCat = ui.categoryList.querySelector('.category-item.selected');
                        if (currentCat) currentCat.focus();
                        else ui.categoryList.firstElementChild.focus();
                    } else if (activeEl.classList.contains('movie-card')) {
                        // Movie Grid Left
                        const prev = activeEl.previousElementSibling;
                        if (prev) {
                            prev.focus();
                            prev.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        } else {
                            // First item in row... maybe go to category?
                            const currentCat = ui.categoryList.querySelector('.category-item.selected');
                            if (currentCat) currentCat.focus();
                        }
                    } else if (activeEl.classList.contains('category-item')) {
                        // Move to Mode Switcher
                        ui.modeTv.focus();
                    }
                }
                break;
            case 39: // Right
                if (isMenuVisible) {
                    if (activeEl.classList.contains('mode-btn')) {
                        // Move to Category List
                        const currentCat = ui.categoryList.querySelector('.category-item.selected');
                        if (currentCat) currentCat.focus();
                        else ui.categoryList.firstElementChild.focus();
                    } else if (activeEl.classList.contains('category-item')) {
                        // Move to Channel List or Movie Grid
                        if (currentMode === 'tv') {
                            const firstCh = ui.channelList.querySelector('.channel-item');
                            if (firstCh) firstCh.focus();
                        } else {
                            const firstMovie = ui.movieGrid.querySelector('.movie-card');
                            if (firstMovie) firstMovie.focus();
                        }
                    } else if (activeEl.classList.contains('movie-card')) {
                        // Movie Grid Right
                        const next = activeEl.nextElementSibling;
                        if (next) {
                            next.focus();
                            next.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        }
                    }
                }
                break;
            case 13: // Enter
                // handled by click listeners
                break;
        }
    }

    function restoreFocusToChannel(force = false) {
        if (!force && document.activeElement && (document.activeElement.classList.contains('channel-item') || document.activeElement.classList.contains('movie-card'))) {
            return;
        }

        if (currentMode === 'tv') {
            if (selectedChannel && selectedChannel.url) {
                // Find the element for the selected channel
                const items = ui.channelList.querySelectorAll('.channel-item');
                for (let li of items) {
                    if (li.dataset.url === selectedChannel.url) {
                        li.focus();
                        li.scrollIntoView({ block: 'center', behavior: 'smooth' });
                        return;
                    }
                }
            }

            // Default to first item
            const first = ui.channelList.querySelector('.channel-item');
            if (first) {
                first.focus();
                first.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        } else {
            // Movie Mode fallback
            const first = ui.movieGrid.querySelector('.movie-card');
            if (first) {
                first.focus();
                first.scrollIntoView({ block: 'center', behavior: 'smooth' });
            }
        }
    }

    function showInfoBanner() {
        // Clear existing timeout
        if (controlsTimeout) {
            clearTimeout(controlsTimeout);
        }

        // Update banner with current channel info
        if (selectedChannel) {
            ui.bannerChannelNumber.textContent = selectedChannel.number || '';
            ui.bannerChannelName.textContent = selectedChannel.name || '';

            if (selectedChannel.logo) {
                ui.bannerLogo.src = selectedChannel.logo;
                ui.bannerLogo.style.display = 'block';
            } else {
                ui.bannerLogo.style.display = 'none';
            }

            // EPG info if available
            if (selectedChannel.epg) {
                ui.bannerProgramTitle.textContent = selectedChannel.epg.title || 'Live';
                ui.bannerProgramTime.textContent = selectedChannel.epg.time || '';
                // Calculate progress if we have start/end times
                ui.bannerProgressBar.style.width = '45%'; // Placeholder
            } else {
                ui.bannerProgramTitle.textContent = 'Live';
                ui.bannerProgramTime.textContent = '';
                ui.bannerProgressBar.style.width = '0%';
            }
        }

        // Update current time
        const now = new Date();
        ui.bannerCurrentTime.textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

        // Detect video resolution
        const video = ui.videoPlayer;
        if (video.videoHeight >= 1080) {
            ui.bannerResolution.textContent = 'FHD';
        } else if (video.videoHeight >= 720) {
            ui.bannerResolution.textContent = 'HD';
        } else if (video.videoHeight > 0) {
            ui.bannerResolution.textContent = 'SD';
        } else {
            ui.bannerResolution.textContent = 'HD';
        }

        // Show banner
        ui.infoBanner.classList.add('visible');

        // Auto-hide after 5 seconds
        controlsTimeout = setTimeout(() => {
            ui.infoBanner.classList.remove('visible');
        }, 5000);
    }
});
