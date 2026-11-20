/*
 * Mobile tweaks for the ttyd web client, injected into its template.html at
 * build time (see inject.sh). Plain ES5 on purpose: this file is not run
 * through ttyd's TypeScript/ESLint pipeline. It must also never contain the
 * sequences "<" + "%" or "$" + "{": html-webpack-plugin renders template.html
 * as a lodash template.
 *
 * What it does:
 *  - Rewrites the preferences ttyd's server sends (SET_PREFERENCES), so phone
 *    and tablet settings win over the desktop ones, also after a reconnect.
 *    "mobileFontSize" is a custom key passed with `ttyd -t`; it is always
 *    removed here, because xterm.js throws on options it does not know.
 *  - Debounces window resizes. A soft keyboard fires several resize events
 *    while it animates; each one used to resize the pty, making tmux and
 *    Claude Code redraw the whole screen several times per keyboard toggle.
 *  - On touch devices: a key bar (Esc, Shift+Tab, arrows, Enter, Ctrl+C,
 *    photo upload, paste, Tab, font size) and sizing that follows the
 *    visual viewport.
 */
(function () {
    'use strict';

    var isMobile = false;
    try {
        isMobile = window.matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 900;
    } catch (e) {
        isMobile = false;
    }
    try {
        /* Debug switch: localStorage 'claudecode.forceMobile' = '1' or '0'. */
        var force = window.localStorage.getItem('claudecode.forceMobile');
        if (force === '1') isMobile = true;
        else if (force === '0') isMobile = false;
    } catch (e) {
        /* storage blocked */
    }
    if (isMobile) document.documentElement.className += ' cc-mobile';

    var FONT_KEY = 'claudecode.mobileFontSize';
    var MIN_FONT = 8;
    var MAX_FONT = 24;

    function storedFontSize() {
        try {
            var v = parseInt(window.localStorage.getItem(FONT_KEY), 10);
            return v >= MIN_FONT && v <= MAX_FONT ? v : null;
        } catch (e) {
            return null;
        }
    }

    function storeFontSize(v) {
        try {
            window.localStorage.setItem(FONT_KEY, String(v));
        } catch (e) {
            /* private mode or blocked storage: the setting just won't stick */
        }
    }

    /* ---- preference rewrite ------------------------------------------- */

    var SET_PREFERENCES = 0x32; /* '2' */

    function rewritePrefs(prefs) {
        var mobileFont = prefs.mobileFontSize;
        delete prefs.mobileFontSize;
        if (isMobile) {
            prefs.fontSize = storedFontSize() || mobileFont || prefs.fontSize || 13;
            prefs.scrollback = Math.min(prefs.scrollback || 5000, 5000);
            prefs.disableResizeOverlay = true;
            prefs.disableLeaveAlert = true;
            prefs.smoothScrollDuration = 0;
        }
        if (prefs.theme && prefs.theme.background) {
            document.documentElement.style.setProperty('--cc-bg', prefs.theme.background);
        }
        if (prefs.theme && prefs.theme.foreground) {
            document.documentElement.style.setProperty('--cc-fg', prefs.theme.foreground);
        }
        return prefs;
    }

    function rewriteEvent(ev) {
        var data = ev.data;
        if (!(data instanceof ArrayBuffer) || data.byteLength < 2) return ev;
        if (new Uint8Array(data, 0, 1)[0] !== SET_PREFERENCES) return ev;
        try {
            var prefs = JSON.parse(new TextDecoder().decode(data.slice(1)));
            var body = new TextEncoder().encode(JSON.stringify(rewritePrefs(prefs)));
            var out = new Uint8Array(body.length + 1);
            out[0] = SET_PREFERENCES;
            out.set(body, 1);
            return new MessageEvent('message', { data: out.buffer, origin: ev.origin });
        } catch (e) {
            return ev;
        }
    }

    /* ttyd listens with socket.addEventListener('message', ...) and removes
       the same function again on dispose, so wrap per instance and keep the
       original-to-wrapper mapping for removeEventListener. */
    var NativeWebSocket = window.WebSocket;
    var PatchedWebSocket = function (url, protocols) {
        var ws = protocols === undefined ? new NativeWebSocket(url) : new NativeWebSocket(url, protocols);
        var nativeAdd = ws.addEventListener;
        var nativeRemove = ws.removeEventListener;
        var wrapped = [];
        ws.addEventListener = function (type, fn, opts) {
            if (type !== 'message' || typeof fn !== 'function') return nativeAdd.call(ws, type, fn, opts);
            var w = function (ev) {
                return fn.call(this, rewriteEvent(ev));
            };
            wrapped.push([fn, w]);
            return nativeAdd.call(ws, type, w, opts);
        };
        ws.removeEventListener = function (type, fn, opts) {
            if (type === 'message') {
                for (var i = 0; i < wrapped.length; i++) {
                    if (wrapped[i][0] === fn) {
                        fn = wrapped[i][1];
                        wrapped.splice(i, 1);
                        break;
                    }
                }
            }
            return nativeRemove.call(ws, type, fn, opts);
        };
        return ws;
    };
    PatchedWebSocket.prototype = NativeWebSocket.prototype;
    ['CONNECTING', 'OPEN', 'CLOSING', 'CLOSED'].forEach(function (k) {
        PatchedWebSocket[k] = NativeWebSocket[k];
    });
    window.WebSocket = PatchedWebSocket;

    /* ---- debounced fit ------------------------------------------------ */

    var fitTimer = null;
    function scheduleFit(delay) {
        clearTimeout(fitTimer);
        fitTimer = setTimeout(function () {
            if (window.term && typeof window.term.fit === 'function') window.term.fit();
        }, delay);
    }

    /* Registered before ttyd's own listener (this script runs first), so
       stopImmediatePropagation keeps ttyd from fitting on every event. */
    window.addEventListener('resize', function (e) {
        if (!window.term) return;
        e.stopImmediatePropagation();
        scheduleFit(isMobile ? 200 : 100);
    });

    if (!isMobile) return;

    /* ---- visual viewport (keyboard overlaying the page) ----------------- */

    var root = document.documentElement;
    function syncViewport() {
        var vv = window.visualViewport;
        if (!vv) return;
        var h = Math.round(vv.height);
        if (h > 0 && h < window.innerHeight - 1) {
            root.style.height = h + 'px';
            document.body.style.height = h + 'px';
            window.scrollTo(0, 0);
        } else {
            root.style.height = '';
            document.body.style.height = '';
        }
        scheduleFit(200);
    }
    if (window.visualViewport) window.visualViewport.addEventListener('resize', syncViewport);

    /* ---- helpers ------------------------------------------------------ */

    function send(seq) {
        var t = window.term;
        if (!t) return;
        if (typeof t.input === 'function') t.input(seq, true);
        else if (t._core && t._core.coreService) t._core.coreService.triggerDataEvent(seq, true);
    }

    var toastEl = null;
    var toastTimer = null;
    function toast(text, ms) {
        if (!toastEl) {
            toastEl = document.createElement('div');
            toastEl.id = 'cc-toast';
            toastEl.setAttribute('role', 'status');
            document.body.appendChild(toastEl);
        }
        toastEl.textContent = text;
        toastEl.className = 'cc-show';
        clearTimeout(toastTimer);
        if (ms) {
            toastTimer = setTimeout(function () {
                toastEl.className = '';
            }, ms);
        }
    }

    function arrow(letter) {
        return function () {
            var app = window.term && window.term.modes && window.term.modes.applicationCursorKeysMode;
            send((app ? '\x1bO' : '\x1b[') + letter);
        };
    }

    function changeFont(delta) {
        return function () {
            var t = window.term;
            if (!t) return;
            var size = Math.max(MIN_FONT, Math.min(MAX_FONT, (t.options.fontSize || 13) + delta));
            t.options.fontSize = size;
            storeFontSize(size);
            scheduleFit(50);
            toast('Tekstgrootte ' + size + 'px', 900);
        };
    }

    function paste() {
        function fallback() {
            var text = window.prompt('Plak hier de tekst:');
            if (text) send(text);
        }
        try {
            if (navigator.clipboard && navigator.clipboard.readText) {
                navigator.clipboard.readText().then(function (text) {
                    if (text) send(text);
                    else fallback();
                }, fallback);
                return;
            }
        } catch (e) {
            /* fall through */
        }
        fallback();
    }

    /* ---- photo upload ------------------------------------------------- */
    /*
     * The web terminal has no upload channel, but this page is served through
     * Home Assistant ingress, i.e. from the same origin as the HA frontend
     * around it. So it can use HA's own media upload (the one behind Media >
     * Upload in the sidebar) with the session of whoever is logged in. The
     * file lands in /media/claudecode, which this add-on maps read-write, and
     * its path is typed into the terminal so Claude Code picks it up.
     */

    var UPLOAD_DIR_ID = 'media-source://media_source/local/claudecode';
    var UPLOAD_DIR_PATH = '/media/claudecode/';
    var MAX_EDGE = 2000;

    function findHass() {
        var w = window;
        for (var i = 0; i < 4 && w; i++) {
            try {
                var el = w.document.querySelector('home-assistant');
                if (el && el.hass && typeof el.hass.fetchWithAuth === 'function') return el.hass;
            } catch (e) {
                /* cross-origin parent: stop climbing */
                return null;
            }
            if (w === w.parent) break;
            w = w.parent;
        }
        return null;
    }

    function uploadFetch(body) {
        var hass = findHass();
        if (hass) return hass.fetchWithAuth('/api/media_source/local_source/upload', { method: 'POST', body: body });
        /* Fallback: the tokens HA keeps in localStorage ("keep me logged in"). */
        var tokens = null;
        try {
            tokens = JSON.parse(window.localStorage.getItem('hassTokens'));
        } catch (e) {
            tokens = null;
        }
        if (!tokens || !tokens.access_token) return Promise.reject(new Error('no-auth'));
        return fetch('/api/media_source/local_source/upload', {
            method: 'POST',
            body: body,
            headers: { Authorization: 'Bearer ' + tokens.access_token },
        });
    }

    function pad(n) {
        return n < 10 ? '0' + n : String(n);
    }

    function photoName(index, ext) {
        var d = new Date();
        return (
            'foto-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + '-' +
            pad(d.getHours()) + pad(d.getMinutes()) + pad(d.getSeconds()) +
            (index ? '-' + (index + 1) : '') + '.' + ext
        );
    }

    /* Scale photos down to MAX_EDGE px as JPEG: a phone photo of 4-12 MB
       becomes a few hundred KB, which uploads fast over mobile data and is
       all Claude needs. Anything that cannot be decoded is sent as-is. */
    function shrink(file) {
        if (!/^image\//.test(file.type) || file.type === 'image/gif' || !window.createImageBitmap) {
            return Promise.resolve(file);
        }
        return createImageBitmap(file).then(
            function (bmp) {
                var scale = Math.min(1, MAX_EDGE / Math.max(bmp.width, bmp.height));
                if (scale === 1 && file.size < 1500000) return file;
                var c = document.createElement('canvas');
                c.width = Math.round(bmp.width * scale);
                c.height = Math.round(bmp.height * scale);
                c.getContext('2d').drawImage(bmp, 0, 0, c.width, c.height);
                return new Promise(function (resolve) {
                    c.toBlob(
                        function (blob) {
                            resolve(blob || file);
                        },
                        'image/jpeg',
                        0.85
                    );
                });
            },
            function () {
                return file;
            }
        );
    }

    function uploadOne(file, index) {
        return shrink(file).then(function (blob) {
            var type = blob.type || 'image/jpeg';
            var ext = type === 'image/jpeg' ? 'jpg' : (type.split('/')[1] || 'bin').replace(/[^a-z0-9]/gi, '');
            var name = photoName(index, ext);
            var form = new FormData();
            form.append('media_content_id', UPLOAD_DIR_ID);
            form.append('file', blob, name);
            return uploadFetch(form).then(function (res) {
                if (res.status === 401 || res.status === 403) throw new Error('forbidden');
                if (!res.ok) throw new Error('http-' + res.status);
                return UPLOAD_DIR_PATH + name;
            });
        });
    }

    var picker = null;
    function onPicked() {
        var files = Array.prototype.slice.call(picker.files || []);
        picker.value = '';
        if (!files.length) return;
        toast(files.length === 1 ? 'Foto uploaden…' : files.length + ' foto’s uploaden…');
        var paths = [];
        var chain = Promise.resolve();
        files.forEach(function (f, i) {
            chain = chain.then(function () {
                return uploadOne(f, i).then(function (p) {
                    paths.push(p);
                });
            });
        });
        chain.then(
            function () {
                send(paths.join(' ') + ' ');
                toast(paths.length === 1 ? 'Foto toegevoegd' : paths.length + ' foto’s toegevoegd', 1800);
            },
            function (err) {
                if (paths.length) send(paths.join(' ') + ' ');
                var msg = 'Upload mislukt';
                if (err && err.message === 'forbidden') msg += ': enkel een beheerder kan uploaden';
                else if (err && err.message === 'no-auth') msg += ': open de terminal via Home Assistant';
                toast(msg, 4500);
            }
        );
    }

    function pickPhotos() {
        if (!picker) {
            picker = document.createElement('input');
            picker.type = 'file';
            picker.accept = 'image/*';
            picker.multiple = true;
            picker.style.display = 'none';
            picker.addEventListener('change', onPicked);
            document.body.appendChild(picker);
        }
        picker.click();
    }

    /* ---- key bar ------------------------------------------------------ */

    var KEYS = [
        { label: 'Esc', title: 'Escape (onderbreken)', run: function () { send('\x1b'); } },
        { label: '⇧Tab', title: 'Shift+Tab (modus wisselen)', run: function () { send('\x1b[Z'); } },
        { label: '↑', title: 'Pijl omhoog', run: arrow('A'), repeat: true },
        { label: '↓', title: 'Pijl omlaag', run: arrow('B'), repeat: true },
        { label: '⏎', title: 'Enter', run: function () { send('\r'); } },
        { label: '^C', title: 'Ctrl+C', run: function () { send('\x03'); } },
        { label: 'Foto', title: 'Foto uploaden', run: pickPhotos, wide: true, click: true },
        { label: 'Plak', title: 'Plakken', run: paste, wide: true, click: true },
        { label: '←', title: 'Pijl links', run: arrow('D'), repeat: true },
        { label: '→', title: 'Pijl rechts', run: arrow('C'), repeat: true },
        { label: 'Tab', title: 'Tab', run: function () { send('\t'); } },
        { label: 'A−', title: 'Kleinere tekst', run: changeFont(-1) },
        { label: 'A+', title: 'Grotere tekst', run: changeFont(1) },
    ];

    /*
     * The bar scrolls sideways on narrow screens, so a key fires on release,
     * and only if the finger did not move (a swipe scrolls instead). Arrow
     * keys repeat while held. pointerdown is cancelled so the button never
     * takes focus from the terminal and the soft keyboard stays as it is.
     * The file picker and the clipboard need a real click (user activation),
     * so those keys act on the click event.
     */
    function bindKey(b, k) {
        var startX = 0;
        var moved = false;
        var repeated = false;
        var delay = null;
        var interval = null;
        function stop() {
            clearTimeout(delay);
            clearInterval(interval);
            delay = interval = null;
            b.classList.remove('cc-active');
        }
        b.addEventListener('pointerdown', function (e) {
            if (!k.click) e.preventDefault();
            startX = e.clientX;
            moved = false;
            repeated = false;
            b.classList.add('cc-active');
            if (k.repeat) {
                delay = setTimeout(function () {
                    repeated = true;
                    k.run();
                    interval = setInterval(k.run, 70);
                }, 400);
            }
        });
        b.addEventListener('pointermove', function (e) {
            if (Math.abs(e.clientX - startX) > 10) {
                moved = true;
                stop();
            }
        });
        b.addEventListener('pointerup', function () {
            var fire = !moved && !repeated && !k.click;
            stop();
            if (fire) k.run();
        });
        b.addEventListener('pointercancel', function () {
            moved = true;
            stop();
        });
        if (k.click) {
            b.addEventListener('click', function (e) {
                e.preventDefault();
                if (!moved) k.run();
            });
        }
        b.addEventListener('contextmenu', function (e) {
            e.preventDefault();
        });
    }

    function buildBar() {
        var bar = document.createElement('div');
        bar.id = 'cc-keybar';
        bar.setAttribute('role', 'toolbar');
        bar.setAttribute('aria-label', 'Terminaltoetsen');
        KEYS.forEach(function (k) {
            var b = document.createElement('button');
            b.type = 'button';
            b.tabIndex = -1;
            b.textContent = k.label;
            b.title = k.title;
            b.setAttribute('aria-label', k.title);
            if (k.wide) b.className = 'cc-wide';
            bindKey(b, k);
            bar.appendChild(b);
        });
        document.body.appendChild(bar);
        scheduleFit(0);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', buildBar);
    else buildBar();
})();

