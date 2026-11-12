// ==============================================================
//  VIOLATION VIDEO COMPRESSOR
//
//  Shrinks violation-report videos ABOVE 15 MB before they are uploaded to
//  the Violations Cloudinary account (25 GB total storage). Videos of 15 MB
//  or less — and every non-video file — are uploaded untouched.
//
//  HOW: the browser's own hardware-accelerated video encoder (WebCodecs),
//  driven by the vendored Mediabunny library (js/vendor/, MPL-2.0). Every
//  frame is decoded and re-encoded 1:1 with its original timestamp, so there
//  are no dropped frames, no gaps and no change in duration.
//    • Output: MP4, H.264, SAME resolution as the original, "medium" quality.
//    • Audio is kept (copied when MP4-compatible, otherwise re-encoded; a
//      track the browser cannot encode is dropped — CCTV rarely has one).
//
//  NEVER BLOCKS AN UPLOAD. compress() always RESOLVES with a file to upload:
//  the compressed one when it worked and is actually smaller, otherwise the
//  ORIGINAL, with a `reason`. So an old browser, an unusual codec, a library
//  that fails to load, or a stalled encoder all fall back to uploading the
//  original exactly like before.
//
//  NO FREEZING: decoding/encoding run inside the browser's media pipeline,
//  not as a long JavaScript loop, so the page stays responsive. A watchdog
//  cancels a conversion that makes no progress for STALL_MS and falls back
//  to the original file, so Submit can never hang on a stuck encoder.
//
//  The library (~700 KB) is loaded only the first time a video over 15 MB is
//  submitted — never on page load.
// ==============================================================
(function () {
    'use strict';

    var MB = 1024 * 1024;
    // "Above 15 MB only": exactly 15 MB or less is uploaded as-is.
    var THRESHOLD_BYTES = 15 * MB;
    // No progress at all for this long => treat the encoder as stuck.
    var STALL_MS = 60 * 1000;
    // Library load timeout (local copy first, then the CDN).
    var LOAD_TIMEOUT_MS = 30 * 1000;
    // Keep the original unless compression saves at least 3%.
    var MIN_SAVING_RATIO = 0.97;

    var LOCAL_LIB = 'js/vendor/mediabunny-1.63.0.min.js';
    var CDN_LIB = 'https://cdn.jsdelivr.net/npm/mediabunny@1.63.0/dist/bundles/mediabunny.min.mjs';

    var libPromise = null;
    // Indirection so tests can supply a fake library (see _configure below).
    var libraryLoader = function () { return loadLibrary(); };

    function withTimeout(promise, ms, label) {
        return new Promise(function (resolve, reject) {
            var timer = setTimeout(function () { reject(new Error(label + ' timed out')); }, ms);
            promise.then(function (v) { clearTimeout(timer); resolve(v); },
                function (e) { clearTimeout(timer); reject(e); });
        });
    }

    function resolveUrl(path) {
        try { return new URL(path, document.baseURI).href; } catch (e) { return path; }
    }

    /** Load Mediabunny once (local vendored copy, CDN as backup). */
    function loadLibrary() {
        if (libPromise) return libPromise;
        libPromise = withTimeout(import(resolveUrl(LOCAL_LIB)), LOAD_TIMEOUT_MS, 'Compressor library load')
            .catch(function () {
                return withTimeout(import(CDN_LIB), LOAD_TIMEOUT_MS, 'Compressor library load (CDN)');
            })
            .catch(function (error) {
                libPromise = null;   // allow a retry on the next submit
                throw error;
            });
        return libPromise;
    }

    function isVideoFile(file) {
        if (!file) return false;
        var type = String(file.type || '').toLowerCase();
        if (type.indexOf('video/') === 0) return true;
        return /\.(mp4|m4v|mov|webm|mkv|ogv|ogg)$/i.test(String(file.name || ''));
    }

    /** True when this file must go through the compressor (video, > 15 MB). */
    function shouldCompress(file) {
        return isVideoFile(file) && Number(file.size) > THRESHOLD_BYTES;
    }

    /** Can this browser encode video at all (WebCodecs present)? */
    function isSupported() {
        return typeof window !== 'undefined'
            && typeof window.VideoEncoder === 'function'
            && typeof window.VideoDecoder === 'function';
    }

    function original(file, reason) {
        return {
            file: file,
            compressed: false,
            reason: reason,
            originalBytes: file ? file.size : 0,
            outputBytes: file ? file.size : 0
        };
    }

    function mp4Name(name) {
        var base = String(name || 'video').replace(/\.[^./\\]+$/, '') || 'video';
        return base + '.mp4';
    }

    function even(n) {
        n = Math.floor(Number(n) || 0);
        return n % 2 === 0 ? n : n - 1;
    }

    /**
     * Compress one file. ALWAYS resolves (never rejects) with:
     *   { file, compressed, reason, originalBytes, outputBytes }
     * `file` is what should be uploaded.
     *
     * @param {File} file
     * @param {{ onProgress?: function(number) }} [options]  progress 0..1
     */
    async function compress(file, options) {
        var opts = options || {};
        var report = function (p) {
            if (typeof opts.onProgress !== 'function') return;
            try { opts.onProgress(Math.max(0, Math.min(1, Number(p) || 0))); } catch (e) { /* UI only */ }
        };

        if (!file) return original(file, 'no-file');
        if (!shouldCompress(file)) return original(file, 'below-threshold-or-not-video');
        if (!isSupported()) return original(file, 'browser-has-no-video-encoder');

        var M;
        try {
            M = await libraryLoader();
        } catch (error) {
            console.warn('[VideoCompressor] library unavailable, uploading original:', error && error.message);
            return original(file, 'library-unavailable');
        }

        var input = null;
        var conversion = null;
        var watchdog = null;
        var stalled = false;
        var lastProgressAt = Date.now();
        var settleStall = null;

        // ⚠️ THE WATCHDOG WINS A RACE, IT DOES NOT JUST CANCEL. If any step
        // hangs (a corrupt file whose metadata never parses, an encoder that
        // stops emitting frames), cancelling alone is not enough — an await
        // that never settles would keep compress() pending forever and Submit
        // would hang. So a stall RESOLVES this call with the original file,
        // and the abandoned work is cancelled/disposed in the background.
        var stallPromise = new Promise(function (resolve) { settleStall = resolve; });
        watchdog = setInterval(function () {
            if (Date.now() - lastProgressAt > STALL_MS) {
                stalled = true;
                clearInterval(watchdog);
                watchdog = null;
                if (conversion) { try { conversion.cancel(); } catch (e) { /* ignore */ } }
                console.warn('[VideoCompressor] no progress for ' + (STALL_MS / 1000) + 's, uploading original:', file.name);
                settleStall(original(file, 'stalled'));
            }
        }, Math.max(50, Math.min(2000, Math.floor(STALL_MS / 2))));

        var job = (async function () {
          try {
            input = new M.Input({ source: new M.BlobSource(file), formats: M.ALL_FORMATS });

            var track = await input.getPrimaryVideoTrack();
            if (stalled) return original(file, 'stalled');
            if (!track) return original(file, 'no-video-track');
            lastProgressAt = Date.now();

            var width = Number(track.displayWidth) || 0;
            var height = Number(track.displayHeight) || 0;

            // H.264 in MP4 plays everywhere (Cloudinary, every browser, the
            // in-app viewer). Ask the browser whether it can encode it at THIS
            // resolution; if not, keep the original rather than produce a file
            // that may not play.
            var codec = await M.getFirstEncodableVideoCodec(['avc'], {
                width: even(width) || undefined,
                height: even(height) || undefined,
                quality: M.QUALITY_MEDIUM
            });
            if (stalled) return original(file, 'stalled');
            if (!codec) return original(file, 'h264-encoder-unavailable');
            lastProgressAt = Date.now();

            var videoOptions = {
                codec: codec,
                quality: M.QUALITY_MEDIUM,
                forceTranscode: true
            };
            // Same resolution as the original ("keep resolution"). H.264 4:2:0
            // needs even dimensions, so an odd size is trimmed by ONE pixel —
            // the only change ever made to the picture size.
            if (width > 0 && height > 0 && (width % 2 || height % 2)) {
                videoOptions.width = even(width);
                videoOptions.height = even(height);
                videoOptions.fit = 'fill';
            }

            var output = new M.Output({
                format: new M.Mp4OutputFormat({ fastStart: 'in-memory' }),
                target: new M.BufferTarget()
            });

            conversion = await M.Conversion.init({
                input: input,
                output: output,
                video: videoOptions,
                showWarnings: false
            });
            if (stalled) return original(file, 'stalled');
            lastProgressAt = Date.now();

            var keepsVideo = (conversion.utilizedTracks || []).some(function (t) {
                return t && (t.type === 'video' || (typeof t.isVideoTrack === 'function' && t.isVideoTrack()));
            });
            if (!conversion.isValid || !keepsVideo) {
                return original(file, 'cannot-convert-this-video');
            }

            var lastPct = -1;
            conversion.onProgress = function (progress) {
                lastProgressAt = Date.now();
                var pct = Math.floor((Number(progress) || 0) * 100);
                if (pct !== lastPct) {
                    lastPct = pct;
                    report(pct / 100);
                }
            };

            report(0);
            await conversion.execute();
            if (stalled) return original(file, 'stalled');

            var buffer = output.target && output.target.buffer;
            if (!buffer || !buffer.byteLength) return original(file, 'empty-output');
            if (buffer.byteLength >= file.size * MIN_SAVING_RATIO) {
                return original(file, 'not-smaller');
            }

            report(1);
            var compressedFile = new File([buffer], mp4Name(file.name), {
                type: 'video/mp4',
                lastModified: file.lastModified || Date.now()
            });
            return {
                file: compressedFile,
                compressed: true,
                reason: 'compressed',
                originalBytes: file.size,
                outputBytes: compressedFile.size
            };
          } catch (error) {
            if (stalled) return original(file, 'stalled');
            console.warn('[VideoCompressor] compression failed, uploading original:', error && error.message);
            return original(file, 'error');
          }
        })();

        try {
            return await Promise.race([job, stallPromise]);
        } finally {
            if (watchdog) { clearInterval(watchdog); watchdog = null; }
            // Release the file handle once the job has really finished — after
            // a stall that happens in the background, without delaying Submit.
            job.then(function () {
                if (input) { try { input.dispose(); } catch (e) { /* ignore */ } }
            });
        }
    }

    window.VideoCompressor = {
        THRESHOLD_BYTES: THRESHOLD_BYTES,
        shouldCompress: shouldCompress,
        isSupported: isSupported,
        compress: compress,
        // Exposed for tests (test/violation-video-compressor.test.js).
        _internals: { mp4Name: mp4Name, even: even, isVideoFile: isVideoFile },
        _configure: function (cfg) {
            if (cfg && typeof cfg.loader === 'function') libraryLoader = cfg.loader;
            if (cfg && Number(cfg.stallMs) > 0) STALL_MS = Number(cfg.stallMs);
        }
    };
})();
