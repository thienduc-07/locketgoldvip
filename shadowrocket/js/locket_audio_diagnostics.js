/**
 * @file locket_audio_diagnostics.js
 * @description Shadowrocket Read-Only Audio & Video Diagnostic Script for Locket.
 * 
 * PURPOSE:
 * Pinpoint the exact failure stage where audio is dropped in video moments:
 *   [Stage 1] Client Video Recording & Export (Sender)
 *   [Stage 2] Media Upload & Moment Creation Payload (Sender -> Cloud Storage/API)
 *   [Stage 3] Server-Side Ingestion, Processing & Transcoding (Cloud Functions / GCS)
 *   [Stage 4] Feed Metadata Delivery (API -> Recipient)
 *   [Stage 5] CDN Delivery & Video Playback (CDN -> Recipient Device)
 * 
 * STRICT CONSTRAINTS:
 * 1. 100% READ-ONLY: Never alters responses or requests ($done({}) fail-open contract).
 * 2. ZERO RevenueCat or subscription tampering.
 * 3. NO credential/PII leakage: automatically redacts tokens, cookies, auth headers, and IDs.
 * 4. Zero interference with other rewrite scripts.
 * 
 * @runtime Shadowrocket / Surge / Loon (JavaScriptCore)
 * @version 1.0.0
 */

(function (global) {
  'use strict';

  // =========================================================================
  // 1. CONFIGURATION & SIGNATURES
  // =========================================================================

  var CONFIG = {
    TAG: '[LOCKET-AUDIO-DIAG]',
    MAX_BODY_INSPECT_BYTES: 131072, // Inspect up to first 128KB for MP4/MOV box signatures
    LOG_RAW_JSON: false // Set true only if inspecting full schema
  };

  // Known media metadata fields in Locket API & Firebase
  var MEDIA_KEYS_REGEX = /video|audio|sound|mute|duration|codec|media|stream|transcod|upload_main|quality/i;

  // Sensitive headers to redact
  var SENSITIVE_HEADERS = [
    'authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'x-auth-token',
    'x-firebase-auth-token',
    'x-revenuecat-etag'
  ];

  // =========================================================================
  // 2. RUNTIME & SAFE WRAPPER
  // =========================================================================

  var Runtime = {
    isShadowrocket: function () {
      return typeof $done === 'function';
    },

    getRequest: function () {
      if (typeof $request !== 'undefined' && $request) {
        return {
          url: $request.url || '',
          method: ($request.method || 'GET').toUpperCase(),
          headers: $request.headers || {},
          body: typeof $request.body !== 'undefined' ? $request.body : null
        };
      }
      return { url: '', method: 'GET', headers: {}, body: null };
    },

    getResponse: function () {
      if (typeof $response !== 'undefined' && $response) {
        return {
          status: typeof $response.status === 'number' ? $response.status : 200,
          headers: $response.headers || {},
          body: typeof $response.body !== 'undefined' ? $response.body : null
        };
      }
      return { status: 0, headers: {}, body: null };
    },

    getHeader: function (headers, key) {
      if (!headers || typeof headers !== 'object') return null;
      var target = String(key).toLowerCase();
      var keys = Object.keys(headers);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === target) {
          return headers[keys[i]];
        }
      }
      return null;
    },

    log: function (msg) {
      console.log(CONFIG.TAG + ' ' + msg);
    },

    warn: function (msg) {
      console.log(CONFIG.TAG + ' ⚠️ [WARN] ' + msg);
    },

    error: function (msg, err) {
      console.log(CONFIG.TAG + ' 🛑 [ERROR] ' + msg + ' - ' + (err && err.message ? err.message : String(err)));
    },

    done: function () {
      if (typeof $done === 'function') {
        try {
          $done({});
        } catch (e) {
          try { $done(); } catch (ignored) {}
        }
      }
    }
  };

  // =========================================================================
  // 3. PRIVACY & REDACTION
  // =========================================================================

  var PrivacyGuard = {
    sanitizeHeaders: function (headers) {
      if (!headers || typeof headers !== 'object') return {};
      var clean = {};
      var keys = Object.keys(headers);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var lower = k.toLowerCase();
        var isSensitive = false;
        for (var s = 0; s < SENSITIVE_HEADERS.length; s++) {
          if (lower === SENSITIVE_HEADERS[s] || lower.indexOf('auth') !== -1 || lower.indexOf('token') !== -1) {
            isSensitive = true;
            break;
          }
        }
        if (isSensitive) {
          clean[k] = '[REDACTED_LEN_' + String(headers[k]).length + ']';
        } else {
          clean[k] = headers[k];
        }
      }
      return clean;
    },

    maskUrl: function (rawUrl) {
      if (!rawUrl || typeof rawUrl !== 'string') return '';
      // Redact signature queries from signed GCS/S3 URLs (X-Goog-Signature, Signature, etc.)
      return rawUrl.replace(/([?&](?:X-Goog-Signature|Signature|token|auth)=)[^&]+/gi, '$1[REDACTED_SIGNATURE]');
    }
  };

  // =========================================================================
  // 4. MP4 / MOV CONTAINER AUDIO TRACK INSPECTOR
  // =========================================================================

  var MediaContainerInspector = {
    /**
     * Inspects binary snippet for ISO Base Media File Format (MP4/MOV) track handlers.
     * In MP4/MOV:
     *   - Video track: handler type 'vide'
     *   - Audio track: handler type 'soun'
     *   - AAC Audio sample description: 'mp4a'
     */
    inspectBinarySnippet: function (body) {
      if (!body) return { hasVideoTrack: false, hasAudioTrack: false, inspected: false };

      var sample = '';
      if (typeof body === 'string') {
        sample = body.substring(0, CONFIG.MAX_BODY_INSPECT_BYTES);
      } else {
        return { hasVideoTrack: false, hasAudioTrack: false, inspected: false, note: 'Body is non-string binary' };
      }

      var hasVideo = sample.indexOf('vide') !== -1 || sample.indexOf('avc1') !== -1 || sample.indexOf('hvc1') !== -1;
      var hasAudio = sample.indexOf('soun') !== -1 || sample.indexOf('mp4a') !== -1 || sample.indexOf('aac ') !== -1;

      return {
        inspected: true,
        inspectedBytes: sample.length,
        hasVideoTrack: hasVideo,
        hasAudioTrack: hasAudio,
        detectedCodecs: {
          h264: sample.indexOf('avc1') !== -1,
          hevc: sample.indexOf('hvc1') !== -1,
          aac: sample.indexOf('mp4a') !== -1
        }
      };
    }
  };

  // =========================================================================
  // 5. JSON EXTRACTOR FOR MEDIA & MOMENT FIELDS
  // =========================================================================

  var JsonMediaExtractor = {
    extractMediaNodes: function (obj, currentPath, collected) {
      if (!collected) collected = [];
      if (currentPath === undefined) currentPath = '$';
      if (!obj || typeof obj !== 'object') return collected;

      if (Array.isArray(obj)) {
        for (var i = 0; i < obj.length; i++) {
          JsonMediaExtractor.extractMediaNodes(obj[i], currentPath + '[' + i + ']', collected);
        }
        return collected;
      }

      var keys = Object.keys(obj);
      var currentMediaNode = null;

      for (var k = 0; k < keys.length; k++) {
        var prop = keys[k];
        var val = obj[prop];

        if (MEDIA_KEYS_REGEX.test(prop)) {
          if (!currentMediaNode) {
            currentMediaNode = { path: currentPath, fields: {} };
          }
          if (typeof val === 'string' && val.indexOf('http') === 0) {
            currentMediaNode.fields[prop] = PrivacyGuard.maskUrl(val);
          } else {
            currentMediaNode.fields[prop] = val;
          }
        }

        if (val && typeof val === 'object') {
          JsonMediaExtractor.extractMediaNodes(val, currentPath + '.' + prop, collected);
        }
      }

      if (currentMediaNode && Object.keys(currentMediaNode.fields).length > 0) {
        collected.push(currentMediaNode);
      }

      return collected;
    }
  };

  // =========================================================================
  // 6. STAGE CLASSIFIER & DIAGNOSTIC ANALYZER
  // =========================================================================

  var AudioDiagnosticEngine = {
    classifyStage: function (url, method, reqHeaders, resHeaders) {
      var u = (url || '').toLowerCase();
      var m = (method || 'GET').toUpperCase();
      var reqContentType = (Runtime.getHeader(reqHeaders, 'content-type') || '').toLowerCase();
      var resContentType = (Runtime.getHeader(resHeaders, 'content-type') || '').toLowerCase();

      // Stage A: Video Upload (Direct PUT to GCS or S3)
      if ((m === 'PUT' || m === 'POST') && (u.indexOf('storage.googleapis.com') !== -1 || u.indexOf('.s3.amazonaws.com') !== -1)) {
        if (reqContentType.indexOf('video') !== -1 || reqContentType.indexOf('octet-stream') !== -1 || u.indexOf('.mp4') !== -1 || u.indexOf('.mov') !== -1) {
          return 'STAGE_2_VIDEO_UPLOAD_STORAGE';
        }
      }

      // Stage B: Moment Creation / Publishing
      if ((m === 'POST' || m === 'PUT') && u.indexOf('api.locketcamera.com') !== -1) {
        if (u.indexOf('createmoment') !== -1 || u.indexOf('postmoment') !== -1 || u.indexOf('upload') !== -1 || u.indexOf('/moments') !== -1) {
          return 'STAGE_2_MOMENT_CREATION_API';
        }
      }

      // Stage C: Remote Config Audio Flags
      if (u.indexOf('firebaseremoteconfig.googleapis.com') !== -1) {
        return 'STAGE_0_FIREBASE_REMOTE_CONFIG';
      }

      // Stage D: Moment Retrieval / Feed (Recipient & Sender history)
      if (u.indexOf('api.locketcamera.com') !== -1) {
        if (u.indexOf('getmoments') !== -1 || u.indexOf('fetchmoments') !== -1 || u.indexOf('/moments') !== -1 || u.indexOf('getlatestmoment') !== -1) {
          return 'STAGE_4_MOMENT_FEED_DELIVERY';
        }
      }

      // Stage E: CDN Video Download / Stream
      if (resContentType.indexOf('video/') !== -1 || u.indexOf('.mp4') !== -1 || u.indexOf('.mov') !== -1) {
        return 'STAGE_5_CDN_MEDIA_DELIVERY';
      }

      return 'OTHER_LOCKET_TRAFFIC';
    },

    diagnose: function (req, res) {
      var stage = AudioDiagnosticEngine.classifyStage(req.url, req.method, req.headers, res.headers);
      var maskedUrl = PrivacyGuard.maskUrl(req.url);

      var report = {
        timestamp: new Date().toISOString(),
        stage: stage,
        method: req.method,
        url: maskedUrl,
        status: res.status,
        findings: [],
        extractedMediaFields: [],
        containerAudioStatus: null
      };

      // ---------------------------------------------------------------------
      // ANALYSIS 1: FIREBASE REMOTE CONFIG AUDIO & VIDEO FLAGS
      // ---------------------------------------------------------------------
      if (stage === 'STAGE_0_FIREBASE_REMOTE_CONFIG') {
        try {
          var fbObj = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
          var entries = fbObj.entries || {};
          report.findings.push('Firebase Remote Config evaluated.');

          var keySummary = {};
          var targetKeys = [
            'video_sound_enabled',
            'audio_session_deactivation_enabled',
            'camera_roll_video_sound_enabled',
            'video_audio_enabled',
            'audio_enabled',
            'sound_enabled',
            'video_max_duration',
            'camera_roll_video_max_duration',
            'video_quality_mbps',
            'upload_main',
            'cdn_domain_replacements_video',
            'storage_bucket_video'
          ];

          for (var t = 0; t < targetKeys.length; t++) {
            var k = targetKeys[t];
            if (k in entries) {
              keySummary[k] = entries[k];
            }
          }

          report.findings.push('Configured Audio/Video Parameters: ' + JSON.stringify(keySummary));

          if (entries.audio_session_deactivation_enabled === 'true') {
            report.findings.push('⚠️ [CRITICAL CHECK] "audio_session_deactivation_enabled" is set to "true". This flag can cause AVAudioSession to deactivate during video capture or export, resulting in silent video output!');
          }
          if (entries.upload_main === 'true') {
            report.findings.push('ℹ️ [PARAMETER CHECK] "upload_main" is "true". Verify if this tells client to omit secondary audio tracks or separate streams.');
          }
        } catch (e) {
          report.findings.push('Unable to parse Firebase entries: ' + e.message);
        }
      }

      // ---------------------------------------------------------------------
      // ANALYSIS 2: VIDEO UPLOAD (SENDER -> STORAGE)
      // ---------------------------------------------------------------------
      if (stage === 'STAGE_2_VIDEO_UPLOAD_STORAGE') {
        var uploadLen = Runtime.getHeader(req.headers, 'content-length') || '0';
        var uploadMime = Runtime.getHeader(req.headers, 'content-type') || 'unknown';
        report.findings.push('Video Upload detected: ' + uploadLen + ' bytes with Content-Type: ' + uploadMime);

        // Inspect request body container bytes if available
        if (req.body) {
          var containerRes = MediaContainerInspector.inspectBinarySnippet(req.body);
          report.containerAudioStatus = containerRes;
          if (containerRes.inspected) {
            if (containerRes.hasVideoTrack && !containerRes.hasAudioTrack) {
              report.findings.push('🛑 [ROOT CAUSE CANDIDATE]: SENDER UPLOAD LACKS AUDIO TRACK! Uploaded container has "vide" but NO "soun" / "mp4a" atom. Audio was dropped ON CLIENT before upload!');
            } else if (containerRes.hasVideoTrack && containerRes.hasAudioTrack) {
              report.findings.push('✅ [CLIENT UPLOAD OK]: SENDER UPLOAD HAS AUDIO TRACK! ("vide" and "soun" both present). Audio was successfully exported by client.');
            }
          }
        }
      }

      // ---------------------------------------------------------------------
      // ANALYSIS 3: MOMENT CREATION API (METADATA SUBMISSION)
      // ---------------------------------------------------------------------
      if (stage === 'STAGE_2_MOMENT_CREATION_API') {
        try {
          var reqPayload = typeof req.body === 'string' ? JSON.parse(req.body) : req.body;
          if (reqPayload) {
            var reqMedia = JsonMediaExtractor.extractMediaNodes(reqPayload);
            report.extractedMediaFields.push({ direction: 'REQUEST_PAYLOAD', data: reqMedia });
            report.findings.push('Moment Creation Request Payload contains ' + reqMedia.length + ' media-related nodes.');
          }

          var resPayload = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
          if (resPayload) {
            var resMedia = JsonMediaExtractor.extractMediaNodes(resPayload);
            report.extractedMediaFields.push({ direction: 'RESPONSE_PAYLOAD', data: resMedia });
            report.findings.push('Moment Creation Response contains ' + resMedia.length + ' media-related nodes.');
          }
        } catch (e) {
          report.findings.push('JSON parse note on Moment Creation API: ' + e.message);
        }
      }

      // ---------------------------------------------------------------------
      // ANALYSIS 4: MOMENT FEED / FETCH (RECIPIENT RETRIEVAL)
      // ---------------------------------------------------------------------
      if (stage === 'STAGE_4_MOMENT_FEED_DELIVERY') {
        try {
          var feedObj = typeof res.body === 'string' ? JSON.parse(res.body) : res.body;
          if (feedObj) {
            var feedMedia = JsonMediaExtractor.extractMediaNodes(feedObj);
            report.extractedMediaFields.push({ direction: 'FEED_RESPONSE', data: feedMedia });
            report.findings.push('Feed Delivery API returned ' + feedMedia.length + ' media items.');

            for (var mIdx = 0; mIdx < feedMedia.length; mIdx++) {
              var fItem = feedMedia[mIdx].fields;
              if (fItem.video_url || fItem.videoUrl) {
                var vUrl = fItem.video_url || fItem.videoUrl;
                report.findings.push('Moment Video URL: ' + vUrl);
                if ('has_audio' in fItem) {
                  report.findings.push('   • Explicit has_audio flag: ' + fItem.has_audio);
                }
                if ('audio_url' in fItem) {
                  report.findings.push('   • Separate audio_url: ' + fItem.audio_url);
                }
                if ('sound_enabled' in fItem) {
                  report.findings.push('   • sound_enabled flag: ' + fItem.sound_enabled);
                }
              }
            }
          }
        } catch (e) {
          report.findings.push('JSON parse note on Moment Feed: ' + e.message);
        }
      }

      // ---------------------------------------------------------------------
      // ANALYSIS 5: CDN VIDEO DELIVERY / DOWNLOAD (PLAYBACK STREAM)
      // ---------------------------------------------------------------------
      if (stage === 'STAGE_5_CDN_MEDIA_DELIVERY') {
        var cdnType = Runtime.getHeader(res.headers, 'content-type') || '';
        var cdnLen = Runtime.getHeader(res.headers, 'content-length') || '0';
        var acceptRanges = Runtime.getHeader(res.headers, 'accept-ranges') || 'none';
        report.findings.push('CDN Media Stream served: ' + cdnLen + ' bytes (' + cdnType + ') [Accept-Ranges: ' + acceptRanges + ']');

        if (res.body) {
          var cdnContainer = MediaContainerInspector.inspectBinarySnippet(res.body);
          report.containerAudioStatus = cdnContainer;
          if (cdnContainer.inspected) {
            if (cdnContainer.hasVideoTrack && !cdnContainer.hasAudioTrack) {
              report.findings.push('🛑 [CONFIRMED ON CDN]: The video file served by CDN has NO audio track ("soun"). Recipient cannot hear audio because the file itself is silent!');
            } else if (cdnContainer.hasVideoTrack && cdnContainer.hasAudioTrack) {
              report.findings.push('ℹ️ [CDN HAS AUDIO]: Video file on CDN HAS an audio track ("soun"). If recipient hears no sound, issue is Recipient In-App AudioSession or Silent Mode Switch!');
            }
          }
        }
      }

      return report;
    },

    formatConsoleReport: function (report) {
      if (report.stage === 'OTHER_LOCKET_TRAFFIC') return null;

      var lines = [];
      lines.push('────────────────────────────────────────────────────────────────');
      lines.push('🎧 [LOCKET AUDIO/VIDEO DIAGNOSTIC] ' + report.stage);
      lines.push('▶ ENDPOINT : ' + report.method + ' ' + report.url);
      lines.push('▶ STATUS   : ' + report.status);

      for (var f = 0; f < report.findings.length; f++) {
        lines.push('   ' + report.findings[f]);
      }

      if (report.extractedMediaFields.length > 0) {
        lines.push('   📦 Extracted Media Metadata:');
        for (var e = 0; e < report.extractedMediaFields.length; e++) {
          var item = report.extractedMediaFields[e];
          lines.push('     [' + item.direction + '] Nodes Count: ' + item.data.length);
          for (var d = 0; d < Math.min(item.data.length, 3); d++) {
            lines.push('       • ' + item.data[d].path + ' => ' + JSON.stringify(item.data[d].fields));
          }
        }
      }

      lines.push('────────────────────────────────────────────────────────────────');
      return lines.join('\n');
    }
  };

  // =========================================================================
  // 7. MAIN DISPATCHER
  // =========================================================================

  function runAudioDiagnostics() {
    try {
      var req = Runtime.getRequest();
      var res = Runtime.getResponse();

      var report = AudioDiagnosticEngine.diagnose(req, res);
      var logOutput = AudioDiagnosticEngine.formatConsoleReport(report);

      if (logOutput) {
        Runtime.log('\n' + logOutput);
      }
    } catch (err) {
      Runtime.error('Diagnostic error', err);
    } finally {
      // FAIL-OPEN: Always forward untouched original response
      Runtime.done();
    }
  }

  if (Runtime.isShadowrocket()) {
    runAudioDiagnostics();
  }

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      runAudioDiagnostics: runAudioDiagnostics,
      AudioDiagnosticEngine: AudioDiagnosticEngine,
      MediaContainerInspector: MediaContainerInspector,
      JsonMediaExtractor: JsonMediaExtractor,
      PrivacyGuard: PrivacyGuard,
      Runtime: Runtime
    };
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);

