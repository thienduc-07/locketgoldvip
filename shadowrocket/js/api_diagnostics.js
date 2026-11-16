/**
 * @file api_diagnostics.js
 * @description Senior-grade Read-Only HTTP Traffic & JSON Schema Diagnostic Tool for Shadowrocket / Surge / Loon.
 * 
 * DESIGN PRINCIPLES:
 * 1. STRICT READ-ONLY: Never alters, mutates, or injects mock data into responses, requests, or headers.
 * 2. ABSOLUTE FAIL-OPEN: Guarantees $done({}) is always executed in a finally block to prevent app hangs.
 * 3. ZERO EXTERNAL DEPENDENCIES: 100% self-contained vanilla ES5/ES6 compatible with iOS JavaScriptCore.
 * 4. PRIVACY-PRESERVING: Automatically redacts bearer tokens, session cookies, API secrets, and user PII.
 * 5. EVIDENCE-BASED: Differentiates client vs server image processing; verifies AI indicators before classification.
 * 
 * @version 1.0.0
 * @runtime Shadowrocket (WebKit / JavaScriptCore)
 */

(function (global) {
  'use strict';

  // =========================================================================
  // 1. CONFIGURATION & CONSTANTS
  // =========================================================================

  var CONFIG = {
    ENABLED: true,
    LOG_TAG: '[API-DIAG]',
    MAX_NESTING_DEPTH: 8,
    MAX_LOG_ARRAY_LENGTH: 5,
    MAX_STRING_SNIPPET: 120,
    ENABLE_TIMING: true,
    MASK_PII: true,
    STRICT_FAIL_OPEN: true
  };

  var ENDPOINT_TYPES = {
    REVENUECAT_SUBSCRIPTION: 'REVENUECAT_SUBSCRIPTION',
    FIREBASE_REMOTE_CONFIG: 'FIREBASE_REMOTE_CONFIG',
    USER_PROFILE_AUTH: 'USER_PROFILE_AUTH',
    IMAGE_UPLOAD: 'IMAGE_UPLOAD',
    IMAGE_PROCESSING: 'IMAGE_PROCESSING',
    MEDIA_CDN_DELIVERY: 'MEDIA_CDN_DELIVERY',
    GENERIC_API: 'GENERIC_API'
  };

  var IMAGE_WORKFLOW_TYPES = {
    CLIENT_LOCAL_RENDER: 'CLIENT_LOCAL_RENDER',
    SERVER_PROCEDURAL_RENDER: 'SERVER_PROCEDURAL_RENDER',
    SERVER_AI_TRANSFORMATION: 'SERVER_AI_TRANSFORMATION',
    STORAGE_TRANSFER: 'STORAGE_TRANSFER',
    STATIC_DELIVERY: 'STATIC_DELIVERY',
    UNKNOWN: 'UNKNOWN'
  };

  // Known headers that contain sensitive credentials
  var SENSITIVE_HEADERS = [
    'authorization',
    'proxy-authorization',
    'cookie',
    'set-cookie',
    'x-api-key',
    'apikey',
    'x-firebase-auth-token',
    'x-revenuecat-etag',
    'x-auth-token',
    'access-token',
    'refresh-token',
    'session-token'
  ];

  // Object keys containing sensitive data in JSON bodies
  var SENSITIVE_JSON_KEYS = [
    'password',
    'token',
    'access_token',
    'refresh_token',
    'auth_token',
    'id_token',
    'secret',
    'client_secret',
    'private_key',
    'card_number',
    'cvv',
    'cvc',
    'credential'
  ];

  // Specific indicators for AI/Generative transformation evidence
  var AI_EVIDENCE_KEYWORDS = [
    'prompt',
    'negative_prompt',
    'diffusion',
    'latent',
    'denoising_strength',
    'steps',
    'guidance_scale',
    'seed',
    'model_id',
    'checkpoint',
    'lora',
    'face_embedding',
    'face_detect',
    'face_mesh',
    'controlnet',
    'inpaint',
    'outpaint',
    'sampler'
  ];

  // Procedural / Traditional Image processing indicators
  var PROCEDURAL_IMAGE_KEYWORDS = [
    'crop',
    'resize',
    'rotate',
    'quality',
    'format',
    'lut',
    'filter_id',
    'saturation',
    'contrast',
    'brightness',
    'overlay',
    'watermark',
    'photobooth',
    'layout',
    'grid',
    'border',
    'aspect_ratio'
  ];

  // =========================================================================
  // 2. RUNTIME ENVIRONMENT ADAPTER (Fail-open)
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
          body: $request.body || null
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

    getHeader: function (headers, targetKey) {
      if (!headers || typeof headers !== 'object') return null;
      var lowerTarget = String(targetKey).toLowerCase();
      var keys = Object.keys(headers);
      for (var i = 0; i < keys.length; i++) {
        if (keys[i].toLowerCase() === lowerTarget) {
          return headers[keys[i]];
        }
      }
      return null;
    },

    log: function (msg, data) {
      if (!CONFIG.ENABLED) return;
      if (data !== undefined) {
        try {
          console.log(CONFIG.LOG_TAG + ' ' + msg + ' ' + (typeof data === 'object' ? JSON.stringify(data, null, 2) : String(data)));
        } catch (e) {
          console.log(CONFIG.LOG_TAG + ' ' + msg + ' [Serialization Error]');
        }
      } else {
        console.log(CONFIG.LOG_TAG + ' ' + msg);
      }
    },

    warn: function (msg, data) {
      Runtime.log('⚠️ [WARN] ' + msg, data);
    },

    error: function (msg, err) {
      var errStr = err && err.message ? err.message : String(err);
      Runtime.log('🛑 [ERROR] ' + msg + ' - ' + errStr);
    },

    /**
     * Strictly fail-open completion.
     * Passing empty object {} signals Shadowrocket to leave original response untouched.
     */
    done: function () {
      if (typeof $done === 'function') {
        try {
          $done({});
        } catch (e) {
          // Final defense line
          try { $done(); } catch (ignored) {}
        }
      }
    }
  };

  // =========================================================================
  // 3. PRIVACY & SANITIZATION ENGINE
  // =========================================================================

  var PrivacyGuard = {
    maskString: function (str, visiblePrefix, visibleSuffix) {
      if (!str || typeof str !== 'string') return '';
      if (str.length <= (visiblePrefix + visibleSuffix)) return '***';
      var prefix = str.substring(0, visiblePrefix);
      var suffix = str.substring(str.length - visibleSuffix);
      return prefix + '***' + suffix;
    },

    maskEmail: function (email) {
      if (!email || typeof email !== 'string') return '';
      var parts = email.split('@');
      if (parts.length !== 2) return PrivacyGuard.maskString(email, 2, 2);
      var name = parts[0];
      var domain = parts[1];
      var maskedName = name.length > 2 ? name[0] + '***' + name[name.length - 1] : name[0] + '***';
      var maskedDomain = domain.length > 4 ? domain[0] + '***' + domain.substring(domain.lastIndexOf('.')) : domain;
      return maskedName + '@' + maskedDomain;
    },

    maskPhoneNumber: function (phone) {
      if (!phone || typeof phone !== 'string') return '';
      return phone.replace(/(\+?\d{2,3})\d{4,}(\d{2,4})/, '$1***$2');
    },

    inspectJwtMetadata: function (tokenStr) {
      if (!tokenStr || typeof tokenStr !== 'string') return null;
      var clean = tokenStr.replace(/^Bearer\s+/i, '').trim();
      var parts = clean.split('.');
      if (parts.length !== 3) return null;

      try {
        var base64Url = parts[0];
        var base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
        // Decode header without external atob if necessary
        var jsonHeader = RuntimeEnvironmentPolyfill.decodeBase64(base64);
        var parsedHeader = JSON.parse(jsonHeader);

        var payloadB64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
        var jsonPayload = RuntimeEnvironmentPolyfill.decodeBase64(payloadB64);
        var parsedPayload = JSON.parse(jsonPayload);

        return {
          isJwt: true,
          algorithm: parsedHeader.alg || 'unknown',
          type: parsedHeader.typ || 'JWT',
          issuer: parsedPayload.iss || null,
          subject: parsedPayload.sub ? PrivacyGuard.maskString(parsedPayload.sub, 3, 3) : null,
          expiresAt: parsedPayload.exp ? new Date(parsedPayload.exp * 1000).toISOString() : null,
          issuedAt: parsedPayload.iat ? new Date(parsedPayload.iat * 1000).toISOString() : null,
          isExpired: parsedPayload.exp ? (Date.now() / 1000 > parsedPayload.exp) : null
        };
      } catch (e) {
        return { isJwt: true, parseError: 'Header/Payload base64 decode failed' };
      }
    },

    sanitizeHeaders: function (headers) {
      if (!headers || typeof headers !== 'object') return {};
      var sanitized = {};
      var keys = Object.keys(headers);
      for (var i = 0; i < keys.length; i++) {
        var key = keys[i];
        var lowerKey = key.toLowerCase();
        var val = headers[key];

        var isSensitive = false;
        for (var s = 0; s < SENSITIVE_HEADERS.length; s++) {
          if (lowerKey === SENSITIVE_HEADERS[s] || lowerKey.indexOf('auth') !== -1 || lowerKey.indexOf('key') !== -1) {
            isSensitive = true;
            break;
          }
        }

        if (isSensitive) {
          if (typeof val === 'string' && val.toLowerCase().indexOf('bearer ') === 0) {
            var jwtMeta = PrivacyGuard.inspectJwtMetadata(val);
            if (jwtMeta) {
              sanitized[key] = '[REDACTED_JWT alg=' + jwtMeta.algorithm + ' exp=' + (jwtMeta.expiresAt || 'none') + ' expired=' + jwtMeta.isExpired + ']';
            } else {
              sanitized[key] = 'Bearer [REDACTED_TOKEN len=' + (val.length - 7) + ']';
            }
          } else if (typeof val === 'string') {
            sanitized[key] = '[REDACTED len=' + val.length + ']';
          } else {
            sanitized[key] = '[REDACTED]';
          }
        } else {
          sanitized[key] = val;
        }
      }
      return sanitized;
    },

    sanitizeObject: function (obj, currentDepth) {
      if (!CONFIG.MASK_PII) return obj;
      if (currentDepth === undefined) currentDepth = 0;
      if (currentDepth > CONFIG.MAX_NESTING_DEPTH) return '[MAX_DEPTH_REACHED]';
      if (!obj || typeof obj !== 'object') return obj;

      if (Array.isArray(obj)) {
        var cleanArr = [];
        var maxLen = Math.min(obj.length, CONFIG.MAX_LOG_ARRAY_LENGTH);
        for (var a = 0; a < maxLen; a++) {
          cleanArr.push(PrivacyGuard.sanitizeObject(obj[a], currentDepth + 1));
        }
        if (obj.length > maxLen) {
          cleanArr.push('[... and ' + (obj.length - maxLen) + ' more items]');
        }
        return cleanArr;
      }

      var sanitizedObj = {};
      var keys = Object.keys(obj);
      for (var i = 0; i < keys.length; i++) {
        var k = keys[i];
        var lowerK = k.toLowerCase();
        var v = obj[k];

        var isSensitiveKey = false;
        for (var sk = 0; sk < SENSITIVE_JSON_KEYS.length; sk++) {
          if (lowerK.indexOf(SENSITIVE_JSON_KEYS[sk]) !== -1) {
            isSensitiveKey = true;
            break;
          }
        }

        if (isSensitiveKey) {
          sanitizedObj[k] = typeof v === 'string' ? '[REDACTED_SECRET len=' + v.length + ']' : '[REDACTED_SECRET]';
        } else if (typeof v === 'string') {
          if (v.indexOf('@') !== -1 && v.indexOf('.') !== -1 && v.length < 100) {
            sanitizedObj[k] = PrivacyGuard.maskEmail(v);
          } else if (/^\+?[0-9]{9,15}$/.test(v)) {
            sanitizedObj[k] = PrivacyGuard.maskPhoneNumber(v);
          } else {
            sanitizedObj[k] = v;
          }
        } else if (typeof v === 'object' && v !== null) {
          sanitizedObj[k] = PrivacyGuard.sanitizeObject(v, currentDepth + 1);
        } else {
          sanitizedObj[k] = v;
        }
      }
      return sanitizedObj;
    }
  };

  // Base64 helper for pure JS environments
  var RuntimeEnvironmentPolyfill = {
    decodeBase64: function (input) {
      if (typeof atob === 'function') {
        return atob(input);
      }
      if (typeof Buffer !== 'undefined') {
        return Buffer.from(input, 'base64').toString('utf8');
      }
      // Pure JS base64 decoder
      var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';
      var str = String(input).replace(/=+$/, '');
      if (str.length % 4 === 1) throw new Error('Invalid base64 string');
      var output = '';
      for (var bc = 0, bs = 0, buffer, idx = 0; (buffer = str.charAt(idx++));) {
        var charIdx = chars.indexOf(buffer);
        if (~charIdx) {
          bs = bc % 4 ? bs * 64 + charIdx : charIdx;
          if (bc++ % 4) output += String.fromCharCode(255 & bs >> (-2 * bc & 6));
        }
      }
      return output;
    }
  };

  // =========================================================================
  // 4. JSON ANALYSIS & SCHEMA VALIDATION ENGINE
  // =========================================================================

  var JSONInspector = {
    safeParse: function (rawBody) {
      if (rawBody === null || rawBody === undefined) {
        return { success: false, data: null, error: 'Body is null or undefined', rawType: typeof rawBody };
      }
      if (typeof rawBody === 'object') {
        return { success: true, data: rawBody, error: null, rawType: 'object' };
      }
      if (typeof rawBody !== 'string') {
        return { success: false, data: null, error: 'Body is not a string/object: ' + (typeof rawBody), rawType: typeof rawBody };
      }
      var trimmed = rawBody.trim();
      if (trimmed.length === 0) {
        return { success: false, data: null, error: 'Body is empty string', rawType: 'string' };
      }

      try {
        var parsed = JSON.parse(trimmed);
        return { success: true, data: parsed, error: null, rawType: 'string' };
      } catch (err) {
        // Attempt to diagnose JSON parse failure point
        var snippet = trimmed.length > 80 ? trimmed.substring(0, 80) + '...' : trimmed;
        return {
          success: false,
          data: null,
          error: 'JSON.parse failure: ' + (err.message || String(err)),
          snippet: snippet,
          rawType: 'string'
        };
      }
    },

    detectDetailedType: function (val) {
      if (val === null) return 'null';
      if (val === undefined) return 'undefined';
      if (Array.isArray(val)) return 'array';
      var t = typeof val;
      if (t === 'string') {
        if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/i.test(val)) {
          return 'string:iso8601-timestamp';
        }
        if (/^https?:\/\/[^\s$.?#].[^\s]*$/i.test(val)) {
          return 'string:url';
        }
        if (/^data:image\/[a-zA-Z]+;base64,/i.test(val)) {
          return 'string:base64-image-data-uri';
        }
        if (/^ey[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(val)) {
          return 'string:jwt-compact';
        }
        return 'string';
      }
      if (t === 'number') {
        return isNaN(val) ? 'number:nan' : (Number.isInteger(val) ? 'integer' : 'float');
      }
      if (t === 'boolean') return 'boolean';
      if (t === 'object') return 'object';
      return t;
    },

    inspectStructure: function (obj, currentPath, depth, stats) {
      if (!stats) {
        stats = {
          totalNodes: 0,
          maxDepthObserved: 0,
          nullProperties: [],
          emptyStrings: [],
          emptyArrays: [],
          emptyObjects: [],
          typeDistribution: {}
        };
      }
      if (currentPath === undefined) currentPath = '$';
      if (depth === undefined) depth = 1;

      if (depth > stats.maxDepthObserved) stats.maxDepthObserved = depth;
      stats.totalNodes++;

      var detailedType = JSONInspector.detectDetailedType(obj);
      stats.typeDistribution[detailedType] = (stats.typeDistribution[detailedType] || 0) + 1;

      if (obj === null) {
        stats.nullProperties.push(currentPath);
        return stats;
      }

      if (typeof obj === 'string' && obj.length === 0) {
        stats.emptyStrings.push(currentPath);
        return stats;
      }

      if (depth > CONFIG.MAX_NESTING_DEPTH) {
        return stats;
      }

      if (Array.isArray(obj)) {
        if (obj.length === 0) {
          stats.emptyArrays.push(currentPath);
        } else {
          var inspectLen = Math.min(obj.length, 5);
          for (var i = 0; i < inspectLen; i++) {
            JSONInspector.inspectStructure(obj[i], currentPath + '[' + i + ']', depth + 1, stats);
          }
        }
        return stats;
      }

      if (typeof obj === 'object') {
        var keys = Object.keys(obj);
        if (keys.length === 0) {
          stats.emptyObjects.push(currentPath);
        } else {
          for (var k = 0; k < keys.length; k++) {
            var prop = keys[k];
            JSONInspector.inspectStructure(obj[prop], currentPath + '.' + prop, depth + 1, stats);
          }
        }
      }

      return stats;
    },

    validateSchema: function (data, schema) {
      var issues = [];

      function check(currentData, currentSchema, path) {
        if (!currentSchema) return;

        // Check required fields
        if (currentSchema.required && Array.isArray(currentSchema.required)) {
          if (!currentData || typeof currentData !== 'object') {
            issues.push({ path: path, issue: 'Expected object to check required fields, found ' + typeof currentData });
            return;
          }
          for (var r = 0; r < currentSchema.required.length; r++) {
            var reqKey = currentSchema.required[r];
            if (!(reqKey in currentData) || currentData[reqKey] === undefined) {
              issues.push({ path: path + '.' + reqKey, issue: 'Missing required property' });
            }
          }
        }

        // Check properties definition
        if (currentSchema.properties && currentData && typeof currentData === 'object' && !Array.isArray(currentData)) {
          var specKeys = Object.keys(currentSchema.properties);
          for (var p = 0; p < specKeys.length; p++) {
            var key = specKeys[p];
            var propSpec = currentSchema.properties[key];
            if (key in currentData) {
              var val = currentData[key];
              var expectedType = propSpec.type;

              if (val === null) {
                if (!propSpec.nullable) {
                  issues.push({ path: path + '.' + key, issue: 'Value is null but schema requires non-null ' + expectedType });
                }
                continue;
              }

              if (expectedType) {
                var actualType = Array.isArray(val) ? 'array' : typeof val;
                if (actualType !== expectedType) {
                  issues.push({ path: path + '.' + key, issue: 'Type mismatch: expected ' + expectedType + ', found ' + actualType });
                }
              }

              if (propSpec.properties || propSpec.required) {
                check(val, propSpec, path + '.' + key);
              }
            }
          }
        }
      }

      check(data, schema, '$');
      return {
        valid: issues.length === 0,
        issuesCount: issues.length,
        issues: issues
      };
    }
  };

  // =========================================================================
  // 5. RESPONSE CONSISTENCY CHECKER
  // =========================================================================

  var ConsistencyChecker = {
    evaluate: function (request, response, parseResult) {
      var anomalies = [];
      var status = response.status;
      var contentType = Runtime.getHeader(response.headers, 'content-type') || '';
      var contentLength = Runtime.getHeader(response.headers, 'content-length');

      // 1. Status 200/201 with soft error in JSON
      if (status >= 200 && status < 300 && parseResult.success && parseResult.data) {
        var d = parseResult.data;
        if (d.error || d.err_code || d.error_code || (d.status === 'error') || (d.code && typeof d.code === 'number' && d.code >= 400)) {
          anomalies.push({
            type: 'SOFT_ERROR_STATUS_200',
            severity: 'HIGH',
            detail: 'HTTP ' + status + ' returned, but payload contains explicit error payload: ' + JSON.stringify(d.error || d.error_code || d.message)
          });
        }
      }

      // 2. Status 204 No Content with non-empty body
      if (status === 204 && response.body && String(response.body).trim().length > 0) {
        anomalies.push({
          type: 'NO_CONTENT_VIOLATION',
          severity: 'MEDIUM',
          detail: 'HTTP 204 No Content returned with ' + String(response.body).length + ' body bytes'
        });
      }

      // 3. Status 4xx/5xx inspection
      if (status >= 400) {
        if (!response.body || String(response.body).trim().length === 0) {
          anomalies.push({
            type: 'EMPTY_ERROR_BODY',
            severity: 'LOW',
            detail: 'HTTP ' + status + ' returned without error body or diagnostic details'
          });
        } else if (contentType.indexOf('text/html') !== -1) {
          anomalies.push({
            type: 'HTML_ERROR_PAGE_FROM_API',
            severity: 'MEDIUM',
            detail: 'HTTP ' + status + ' returned raw HTML instead of structured JSON API error response'
          });
        }
      }

      // 4. Content-Type Header vs Body Reality
      if (contentType.toLowerCase().indexOf('application/json') !== -1) {
        if (!parseResult.success) {
          anomalies.push({
            type: 'CONTENT_TYPE_JSON_PARSE_MISMATCH',
            severity: 'HIGH',
            detail: 'Header declared application/json, but payload failed JSON parsing: ' + parseResult.error
          });
        }
      }

      // 5. Content-Length Header vs Body Length
      if (contentLength && response.body && typeof response.body === 'string') {
        var parsedLen = parseInt(contentLength, 10);
        if (!isNaN(parsedLen) && parsedLen > 0) {
          var actualByteLen = RuntimeEnvironmentPolyfill.decodeBase64 ? (function () {
            try { return unescape(encodeURIComponent(response.body)).length; } catch (e) { return response.body.length; }
          })() : response.body.length;

          if (Math.abs(actualByteLen - parsedLen) > 5) { // allow slight difference for gzip decompression
            anomalies.push({
              type: 'CONTENT_LENGTH_DISCREPANCY',
              severity: 'LOW',
              detail: 'Content-Length header (' + parsedLen + ') differs from uncompressed body length (' + actualByteLen + ')'
            });
          }
        }
      }

      return {
        hasAnomalies: anomalies.length > 0,
        anomalies: anomalies
      };
    }
  };

  // =========================================================================
  // 6. ENDPOINT CLASSIFIER
  // =========================================================================

  var EndpointClassifier = {
    classify: function (url, method, headers, parsedBody) {
      var u = (url || '').toLowerCase();
      var m = (method || 'GET').toUpperCase();

      // 1. RevenueCat Subscription
      if (u.indexOf('api.revenuecat.com') !== -1 || u.indexOf('/v1/subscribers') !== -1 || u.indexOf('/v1/receipts') !== -1 || u.indexOf('/v1/offerings') !== -1) {
        return ENDPOINT_TYPES.REVENUECAT_SUBSCRIPTION;
      }

      // 2. Firebase Remote Config
      if (u.indexOf('firebaseremoteconfig.googleapis.com') !== -1 || u.indexOf('firebaseremoteconfigrealtime.googleapis.com') !== -1) {
        return ENDPOINT_TYPES.FIREBASE_REMOTE_CONFIG;
      }

      // 3. User Profile & Auth
      if (u.indexOf('/users/') !== -1 || u.indexOf('/profile') !== -1 || u.indexOf('/account') !== -1 || u.indexOf('/auth/') !== -1 || u.indexOf('/me') !== -1) {
        return ENDPOINT_TYPES.USER_PROFILE_AUTH;
      }

      // 4. Image Upload (Presigned S3/GCS or Direct Multipart)
      var cType = (Runtime.getHeader(headers, 'content-type') || '').toLowerCase();
      var isStorageDomain = u.indexOf('storage.googleapis.com') !== -1 || u.indexOf('.s3.amazonaws.com') !== -1 || u.indexOf('s3.') !== -1;
      if (isStorageDomain && (m === 'PUT' || m === 'POST')) {
        return ENDPOINT_TYPES.IMAGE_UPLOAD;
      }
      if ((m === 'POST' || m === 'PUT') && (u.indexOf('/upload') !== -1 || cType.indexOf('multipart/form-data') !== -1 || cType.indexOf('image/') !== -1)) {
        return ENDPOINT_TYPES.IMAGE_UPLOAD;
      }

      // 5. Image Processing / Transformation Workflow
      if (u.indexOf('/transform') !== -1 || u.indexOf('/photobooth') !== -1 || u.indexOf('/filter') !== -1 || u.indexOf('/generate') !== -1 || u.indexOf('/render') !== -1 || u.indexOf('/jobs') !== -1 || u.indexOf('/tasks') !== -1) {
        return ENDPOINT_TYPES.IMAGE_PROCESSING;
      }

      // 6. Media CDN Delivery
      if (cType.indexOf('image/') === 0 || u.indexOf('.jpg') !== -1 || u.indexOf('.jpeg') !== -1 || u.indexOf('.png') !== -1 || u.indexOf('.webp') !== -1 || u.indexOf('.heic') !== -1) {
        return ENDPOINT_TYPES.MEDIA_CDN_DELIVERY;
      }

      return ENDPOINT_TYPES.GENERIC_API;
    }
  };

  // =========================================================================
  // 7. SUBSCRIPTION DIAGNOSTICS (Strictly Read-Only RevenueCat)
  // =========================================================================

  var RevenueCatDiagnostic = {
    // Expected RevenueCat Subscriber v1 schema definition for validation
    SUBSCRIBER_SCHEMA: {
      required: ['subscriber'],
      properties: {
        subscriber: {
          type: 'object',
          required: ['subscriptions', 'entitlements'],
          properties: {
            subscriptions: { type: 'object' },
            entitlements: { type: 'object' }
          }
        }
      }
    },

    analyze: function (responseStatus, parsedJson) {
      var report = {
        isRevenueCat: true,
        schemaValid: false,
        schemaIssues: [],
        subscriberId: null,
        activeSubscriptions: [],
        expiredSubscriptions: [],
        entitlementsSummary: {},
        offeringsSummary: null,
        anomalies: []
      };

      if (!parsedJson || typeof parsedJson !== 'object') {
        report.anomalies.push('RevenueCat response body is not a valid JSON object');
        return report;
      }

      // Check offerings response structure
      if (parsedJson.current_offering_id || parsedJson.offerings) {
        report.offeringsSummary = RevenueCatDiagnostic.parseOfferings(parsedJson);
        return report;
      }

      // Validate against Subscriber schema
      var valRes = JSONInspector.validateSchema(parsedJson, RevenueCatDiagnostic.SUBSCRIBER_SCHEMA);
      report.schemaValid = valRes.valid;
      report.schemaIssues = valRes.issues;

      var subscriber = parsedJson.subscriber;
      if (!subscriber) {
        report.anomalies.push('Missing root "subscriber" object in RevenueCat payload');
        return report;
      }

      report.subscriberId = subscriber.original_app_user_id ? PrivacyGuard.maskString(subscriber.original_app_user_id, 3, 3) : 'anonymous';

      var now = Date.now();

      // Inspect subscriptions
      var subs = subscriber.subscriptions || {};
      var subKeys = Object.keys(subs);
      for (var s = 0; s < subKeys.length; s++) {
        var prodId = subKeys[s];
        var item = subs[prodId] || {};
        var expDateStr = item.expires_date || null;
        var expTime = expDateStr ? new Date(expDateStr).getTime() : 0;
        var isActive = expTime ? expTime > now : true; // lifetime may have no expiry or 9999

        var subInfo = {
          productId: prodId,
          store: item.store || 'unknown',
          ownershipType: item.ownership_type || 'PURCHASED',
          periodType: item.period_type || 'normal',
          isSandbox: !!item.is_sandbox,
          purchaseDate: item.purchase_date || null,
          expiresDate: expDateStr,
          isActive: isActive,
          autoResumeDate: item.auto_resume_date || null,
          unsubscribeDetectedAt: item.unsubscribe_detected_at || null,
          billingIssuesDetectedAt: item.billing_issues_detected_at || null
        };

        if (isActive) {
          report.activeSubscriptions.push(subInfo);
        } else {
          report.expiredSubscriptions.push(subInfo);
        }
      }

      // Inspect entitlements
      var ents = subscriber.entitlements || {};
      var entKeys = Object.keys(ents);
      for (var e = 0; e < entKeys.length; e++) {
        var entId = entKeys[e];
        var entData = ents[entId] || {};
        var entExp = entData.expires_date || null;
        var entExpTime = entExp ? new Date(entExp).getTime() : 0;
        var entActive = entExpTime ? entExpTime > now : true;

        report.entitlementsSummary[entId] = {
          productIdentifier: entData.product_identifier || null,
          purchaseDate: entData.purchase_date || null,
          expiresDate: entExp,
          isActive: entActive
        };

        // Consistency check: entitlement active but product not in subscriptions
        if (entData.product_identifier && !(entData.product_identifier in subs)) {
          report.anomalies.push('Entitlement "' + entId + '" references product "' + entData.product_identifier + '" which is absent from subscriptions catalog');
        }
      }

      return report;
    },

    parseOfferings: function (parsedJson) {
      var currentOfferingId = parsedJson.current_offering_id || null;
      var offerings = parsedJson.offerings || {};
      var summary = {
        currentOfferingId: currentOfferingId,
        availableOfferings: []
      };

      var keys = Object.keys(offerings);
      for (var i = 0; i < keys.length; i++) {
        var oId = keys[i];
        var item = offerings[oId] || {};
        var packages = item.packages || [];
        var pkgList = [];
        for (var p = 0; p < packages.length; p++) {
          var pkg = packages[p];
          pkgList.push({
            identifier: pkg.identifier,
            platformProductId: pkg.platform_product_identifier
          });
        }
        summary.availableOfferings.push({
          offeringId: oId,
          description: item.description || '',
          packageCount: packages.length,
          packages: pkgList
        });
      }
      return summary;
    }
  };

  // =========================================================================
  // 8. IMAGE PROCESSING & WORKFLOW ANALYSIS
  // =========================================================================

  var ImageWorkflowDiagnostic = {
    analyze: function (request, response, parseResult) {
      var report = {
        workflowType: IMAGE_WORKFLOW_TYPES.UNKNOWN,
        inputAnalysis: {
          mechanism: 'NONE',
          contentType: null,
          contentLength: 0,
          isPresignedUpload: false,
          presignedVendor: null
        },
        processingParameters: {
          isLocalRenderingOnly: false,
          serverComputeRequired: false,
          hasAiEvidence: false,
          detectedAiParameters: [],
          detectedProceduralParameters: [],
          customParameters: {}
        },
        asyncJobLifecycle: {
          isAsync: false,
          jobId: null,
          status: null,
          pollUrl: null,
          estimatedDuration: null
        },
        deliveryAnalysis: {
          cdnVendor: null,
          cacheStatus: null,
          servedMimeType: null,
          age: null
        },
        evidenceNotes: []
      };

      var u = (request.url || '').toLowerCase();
      var m = (request.method || 'GET').toUpperCase();
      var reqContentType = (Runtime.getHeader(request.headers, 'content-type') || '').toLowerCase();
      var resContentType = (Runtime.getHeader(response.headers, 'content-type') || '').toLowerCase();

      // 1. Input & Upload Mechanism Analysis
      if (m === 'PUT' || m === 'POST') {
        report.inputAnalysis.contentLength = parseInt(Runtime.getHeader(request.headers, 'content-length') || '0', 10);
        report.inputAnalysis.contentType = reqContentType;

        if (u.indexOf('storage.googleapis.com') !== -1) {
          report.inputAnalysis.isPresignedUpload = true;
          report.inputAnalysis.presignedVendor = 'Google Cloud Storage';
          report.inputAnalysis.mechanism = 'HTTP_PUT_PRESIGNED_BLOB';
          report.workflowType = IMAGE_WORKFLOW_TYPES.STORAGE_TRANSFER;
          report.evidenceNotes.push('Presigned direct upload to Google Cloud Storage bucket');
        } else if (u.indexOf('.s3.amazonaws.com') !== -1 || u.indexOf('s3.') !== -1) {
          report.inputAnalysis.isPresignedUpload = true;
          report.inputAnalysis.presignedVendor = 'Amazon S3';
          report.inputAnalysis.mechanism = 'HTTP_PUT_PRESIGNED_BLOB';
          report.workflowType = IMAGE_WORKFLOW_TYPES.STORAGE_TRANSFER;
          report.evidenceNotes.push('Presigned direct upload to Amazon Web Services S3');
        } else if (reqContentType.indexOf('multipart/form-data') !== -1) {
          report.inputAnalysis.mechanism = 'MULTIPART_FORM_POST';
          report.evidenceNotes.push('Client submitting multipart form containing binary image parts');
        } else if (reqContentType.indexOf('image/') !== -1) {
          report.inputAnalysis.mechanism = 'DIRECT_BINARY_IMAGE_STREAM';
          report.evidenceNotes.push('Client streaming raw image binary with ' + reqContentType);
        }
      }

      // 2. Processing Parameters & AI Evidence Check
      var bodyObj = parseResult.success ? parseResult.data : null;
      var reqBodyParse = JSONInspector.safeParse(request.body);
      var reqBodyObj = reqBodyParse.success ? reqBodyParse.data : null;

      var targetObjects = [reqBodyObj, bodyObj];
      for (var t = 0; t < targetObjects.length; t++) {
        var currentObj = targetObjects[t];
        if (!currentObj || typeof currentObj !== 'object') continue;

        var keysFlat = Object.keys(currentObj);
        for (var k = 0; k < keysFlat.length; k++) {
          var keyName = keysFlat[k].toLowerCase();

          // Check AI indicators
          for (var ai = 0; ai < AI_EVIDENCE_KEYWORDS.length; ai++) {
            if (keyName.indexOf(AI_EVIDENCE_KEYWORDS[ai]) !== -1) {
              report.processingParameters.hasAiEvidence = true;
              if (report.processingParameters.detectedAiParameters.indexOf(keyName) === -1) {
                report.processingParameters.detectedAiParameters.push(keyName);
              }
            }
          }

          // Check Procedural indicators
          for (var pr = 0; pr < PROCEDURAL_IMAGE_KEYWORDS.length; pr++) {
            if (keyName.indexOf(PROCEDURAL_IMAGE_KEYWORDS[pr]) !== -1) {
              if (report.processingParameters.detectedProceduralParameters.indexOf(keyName) === -1) {
                report.processingParameters.detectedProceduralParameters.push(keyName);
              }
            }
          }
        }
      }

      // Distinguish Local vs Server-side
      var isAssetCatalogUrl = u.indexOf('/filters/') !== -1 || u.indexOf('/stickers/') !== -1 || u.indexOf('.metallib') !== -1 || u.indexOf('.cube') !== -1 || u.indexOf('.mlmodel') !== -1;
      if (m === 'GET' && (isAssetCatalogUrl || (u.indexOf('/config') !== -1 && resContentType.indexOf('json') !== -1))) {
        report.processingParameters.isLocalRenderingOnly = true;
        report.workflowType = IMAGE_WORKFLOW_TYPES.CLIENT_LOCAL_RENDER;
        report.evidenceNotes.push('Endpoint delivers asset definitions, shaders, or color tables for on-device CoreImage/Metal execution');
      } else if (report.processingParameters.hasAiEvidence) {
        report.processingParameters.serverComputeRequired = true;
        report.workflowType = IMAGE_WORKFLOW_TYPES.SERVER_AI_TRANSFORMATION;
        report.evidenceNotes.push('Concrete AI indicators identified: ' + report.processingParameters.detectedAiParameters.join(', '));
      } else if (report.processingParameters.detectedProceduralParameters.length > 0 || (m === 'POST' && u.indexOf('/transform') !== -1)) {
        report.processingParameters.serverComputeRequired = true;
        report.workflowType = IMAGE_WORKFLOW_TYPES.SERVER_PROCEDURAL_RENDER;
        report.evidenceNotes.push('Procedural transformation request detected without AI markers; classifies as server-side procedural pipeline');
      }

      // 3. Asynchronous Job Lifecycle
      if (bodyObj && typeof bodyObj === 'object') {
        var jobId = bodyObj.job_id || bodyObj.task_id || bodyObj.operation_id || bodyObj.id;
        var jobStatus = bodyObj.status || bodyObj.state || bodyObj.phase;

        if (jobId && jobStatus) {
          report.asyncJobLifecycle.isAsync = true;
          report.asyncJobLifecycle.jobId = String(jobId);
          report.asyncJobLifecycle.status = String(jobStatus);
          report.asyncJobLifecycle.pollUrl = bodyObj.poll_url || bodyObj.result_url || null;
          report.asyncJobLifecycle.estimatedDuration = bodyObj.estimated_time || bodyObj.eta || null;
          report.evidenceNotes.push('Asynchronous batch job detected (ID: ' + jobId + ', Status: ' + jobStatus + ')');
        }
      }

      // 4. Delivery & CDN Inspection
      var cfCache = Runtime.getHeader(response.headers, 'cf-cache-status');
      var serverHdr = Runtime.getHeader(response.headers, 'server') || '';
      var ageHdr = Runtime.getHeader(response.headers, 'age');

      if (cfCache) {
        report.deliveryAnalysis.cdnVendor = 'Cloudflare';
        report.deliveryAnalysis.cacheStatus = cfCache;
      } else if (Runtime.getHeader(response.headers, 'x-amz-cf-id')) {
        report.deliveryAnalysis.cdnVendor = 'Amazon CloudFront';
        report.deliveryAnalysis.cacheStatus = Runtime.getHeader(response.headers, 'x-cache');
      } else if (serverHdr.indexOf('Google') !== -1 || Runtime.getHeader(response.headers, 'x-goog-generation')) {
        report.deliveryAnalysis.cdnVendor = 'Google Cloud CDN';
      }

      report.deliveryAnalysis.servedMimeType = resContentType;
      report.deliveryAnalysis.age = ageHdr;

      if (report.workflowType === IMAGE_WORKFLOW_TYPES.UNKNOWN && resContentType.indexOf('image/') === 0) {
        report.workflowType = IMAGE_WORKFLOW_TYPES.STATIC_DELIVERY;
      }

      return report;
    }
  };

  // =========================================================================
  // 9. DIAGNOSTIC REPORTER & LOG FORMATTER
  // =========================================================================

  var DiagnosticReporter = {
    render: function (record) {
      var lines = [];
      lines.push('════════════════════════════════════════════════════════════════');
      lines.push('🔍 [HTTP TRAFFIC & API DIAGNOSTICS]');
      lines.push('────────────────────────────────────────────────────────────────');
      lines.push('▶ REQUEST  : ' + record.method + ' ' + record.url);
      lines.push('▶ RESPONSE : Status ' + record.status + ' (' + (record.bodyLength || 0) + ' bytes)');
      lines.push('▶ CATEGORY : ' + record.classification);

      if (record.jwtAuth) {
        lines.push('▶ AUTH-JWT : Alg=' + record.jwtAuth.algorithm + ' | Exp=' + (record.jwtAuth.expiresAt || 'N/A') + ' | Expired=' + record.jwtAuth.isExpired);
      }

      // Consistency check section
      if (record.consistency && record.consistency.hasAnomalies) {
        lines.push('⚠️ ANOMALIES DETECTED:');
        for (var a = 0; a < record.consistency.anomalies.length; a++) {
          var an = record.consistency.anomalies[a];
          lines.push('   • [' + an.severity + '] ' + an.type + ': ' + an.detail);
        }
      }

      // JSON structure section
      if (record.jsonStats) {
        lines.push('📊 JSON ANALYSIS: Nodes=' + record.jsonStats.totalNodes + ' | Depth=' + record.jsonStats.maxDepthObserved);
        if (record.jsonStats.nullProperties.length > 0) {
          lines.push('   • Null Fields (' + record.jsonStats.nullProperties.length + '): ' + record.jsonStats.nullProperties.slice(0, 5).join(', '));
        }
        if (record.jsonStats.emptyStrings.length > 0) {
          lines.push('   • Empty Strings (' + record.jsonStats.emptyStrings.length + '): ' + record.jsonStats.emptyStrings.slice(0, 5).join(', '));
        }
      }

      // RevenueCat section
      if (record.revenueCatReport) {
        var rc = record.revenueCatReport;
        lines.push('💳 REVENUECAT DIAGNOSTICS (READ-ONLY):');
        lines.push('   • User ID: ' + rc.subscriberId + ' | Schema Valid: ' + rc.schemaValid);
        lines.push('   • Active Subscriptions (' + rc.activeSubscriptions.length + '):');
        for (var s = 0; s < rc.activeSubscriptions.length; s++) {
          var sub = rc.activeSubscriptions[s];
          lines.push('     - ' + sub.productId + ' (Expires: ' + (sub.expiresDate || 'Lifetime') + ', Sandbox: ' + sub.isSandbox + ')');
        }
        if (rc.anomalies.length > 0) {
          lines.push('   • RC Anomalies: ' + rc.anomalies.join('; '));
        }
      }

      // Image processing section
      if (record.imageReport) {
        var img = record.imageReport;
        lines.push('🖼️ IMAGE WORKFLOW: ' + img.workflowType);
        if (img.inputAnalysis.mechanism !== 'NONE') {
          lines.push('   • Input Mechanism : ' + img.inputAnalysis.mechanism + ' (' + (img.inputAnalysis.presignedVendor || 'Direct') + ')');
        }
        lines.push('   • AI Evidence     : ' + (img.processingParameters.hasAiEvidence ? ('YES (' + img.processingParameters.detectedAiParameters.join(', ') + ')') : 'NO (Verified)'));
        lines.push('   • Processing Mode : ' + (img.processingParameters.isLocalRenderingOnly ? 'Client-Side (Local Shader/Filter)' : (img.processingParameters.serverComputeRequired ? 'Server-Side Compute' : 'Static Transfer')));
        if (img.asyncJobLifecycle.isAsync) {
          lines.push('   • Async Job       : ID=' + img.asyncJobLifecycle.jobId + ' Status=' + img.asyncJobLifecycle.status);
        }
        if (img.deliveryAnalysis.cdnVendor) {
          lines.push('   • CDN / Cache     : ' + img.deliveryAnalysis.cdnVendor + ' (Status: ' + (img.deliveryAnalysis.cacheStatus || 'N/A') + ')');
        }
      }

      lines.push('════════════════════════════════════════════════════════════════');
      return lines.join('\n');
    }
  };

  // =========================================================================
  // 10. MAIN EXECUTION CONTROLLER
  // =========================================================================

  function runDiagnostics() {
    var startTime = Date.now();
    var diagnosticRecord = {
      timestamp: new Date().toISOString(),
      url: '',
      method: '',
      status: 0,
      bodyLength: 0,
      classification: ENDPOINT_TYPES.GENERIC_API,
      jwtAuth: null,
      consistency: null,
      jsonStats: null,
      revenueCatReport: null,
      imageReport: null
    };

    try {
      var req = Runtime.getRequest();
      var res = Runtime.getResponse();

      diagnosticRecord.url = req.url;
      diagnosticRecord.method = req.method;
      diagnosticRecord.status = res.status;
      diagnosticRecord.bodyLength = (res.body && typeof res.body === 'string') ? res.body.length : 0;

      // 1. Inspect Auth in Request Headers (Read-only, redacted)
      var authHdr = Runtime.getHeader(req.headers, 'authorization');
      if (authHdr) {
        diagnosticRecord.jwtAuth = PrivacyGuard.inspectJwtMetadata(authHdr);
      }

      // 2. Parse JSON Response Body safely
      var parsedRes = JSONInspector.safeParse(res.body);

      // 3. Classify Endpoint
      diagnosticRecord.classification = EndpointClassifier.classify(req.url, req.method, req.headers, parsedRes.data);

      // 4. Perform JSON Structure & Quality Inspection
      if (parsedRes.success && parsedRes.data && typeof parsedRes.data === 'object') {
        diagnosticRecord.jsonStats = JSONInspector.inspectStructure(parsedRes.data);
      }

      // 5. Evaluate HTTP Response Consistency
      diagnosticRecord.consistency = ConsistencyChecker.evaluate(req, res, parsedRes);

      // 6. Subscription Diagnostics (if RevenueCat)
      if (diagnosticRecord.classification === ENDPOINT_TYPES.REVENUECAT_SUBSCRIPTION && parsedRes.success) {
        diagnosticRecord.revenueCatReport = RevenueCatDiagnostic.analyze(res.status, parsedRes.data);
      }

      // 7. Image Workflow Diagnostics (if image related)
      if (diagnosticRecord.classification === ENDPOINT_TYPES.IMAGE_UPLOAD ||
          diagnosticRecord.classification === ENDPOINT_TYPES.IMAGE_PROCESSING ||
          diagnosticRecord.classification === ENDPOINT_TYPES.MEDIA_CDN_DELIVERY) {
        diagnosticRecord.imageReport = ImageWorkflowDiagnostic.analyze(req, res, parsedRes);
      }

      // 8. Output Formatted Report
      var outputLog = DiagnosticReporter.render(diagnosticRecord);
      Runtime.log('\n' + outputLog);

    } catch (unexpectedError) {
      Runtime.error('Fatal exception inside diagnostic engine', unexpectedError);
    } finally {
      // MANDATORY FAIL-OPEN CONTRACT:
      // Passing {} ensures Shadowrocket forwards the response without modification.
      Runtime.done();
    }

    return diagnosticRecord;
  }

  // Auto-execute if in Shadowrocket runtime
  if (Runtime.isShadowrocket()) {
    runDiagnostics();
  }

  // Export module for Node.js unit testing harnesses
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      runDiagnostics: runDiagnostics,
      JSONInspector: JSONInspector,
      PrivacyGuard: PrivacyGuard,
      ConsistencyChecker: ConsistencyChecker,
      EndpointClassifier: EndpointClassifier,
      RevenueCatDiagnostic: RevenueCatDiagnostic,
      ImageWorkflowDiagnostic: ImageWorkflowDiagnostic,
      DiagnosticReporter: DiagnosticReporter,
      Runtime: Runtime,
      ENDPOINT_TYPES: ENDPOINT_TYPES,
      IMAGE_WORKFLOW_TYPES: IMAGE_WORKFLOW_TYPES
    };
  }

})(typeof globalThis !== 'undefined' ? globalThis : this);
