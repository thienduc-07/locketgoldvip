const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const diagnostics = require('../../shadowrocket/js/api_diagnostics.js');

const scriptSource = fs.readFileSync(
  path.resolve(__dirname, '../../shadowrocket/js/api_diagnostics.js'),
  'utf8'
);

// Helper to run code in an isolated Shadowrocket mock VM
function runInShadowrocketVm(mockRequest, mockResponse) {
  let doneArgs = null;
  let doneCalled = false;
  const loggedMessages = [];

  const sandbox = {
    $request: mockRequest,
    $response: mockResponse,
    $done: function (res) {
      doneCalled = true;
      doneArgs = res;
    },
    console: {
      log: function (...args) {
        loggedMessages.push(args.join(' '));
      },
      warn: function (...args) {
        loggedMessages.push(args.join(' '));
      },
      error: function (...args) {
        loggedMessages.push(args.join(' '));
      }
    },
    Date: Date,
    JSON: JSON,
    Math: Math,
    parseInt: parseInt,
    isNaN: isNaN,
    Number: Number,
    Array: Array,
    Object: Object,
    String: String
  };

  vm.runInNewContext(scriptSource, sandbox);

  return {
    doneCalled,
    doneArgs,
    logs: loggedMessages
  };
}

// =========================================================================
// TEST SUITE 1: JSON SAFE PARSING & TYPE INSPECTION
// =========================================================================

test('JSON Analysis: Valid JSON parses cleanly with accurate structure detection', () => {
  const validPayload = JSON.stringify({
    app_version: '2.5.0',
    count: 42,
    rate: 9.99,
    active: true,
    created_at: '2026-11-16T08:00:00Z',
    items: ['alpha', 'beta'],
    nested: { flag: false }
  });

  const parsed = diagnostics.JSONInspector.safeParse(validPayload);
  assert.strictEqual(parsed.success, true);
  assert.strictEqual(parsed.error, null);

  const stats = diagnostics.JSONInspector.inspectStructure(parsed.data);
  assert.strictEqual(stats.maxDepthObserved, 3);
  assert.strictEqual(stats.nullProperties.length, 0);
  assert.strictEqual(stats.emptyStrings.length, 0);
  assert.strictEqual(stats.typeDistribution['string:iso8601-timestamp'], 1);
  assert.strictEqual(stats.typeDistribution['integer'], 1);
  assert.strictEqual(stats.typeDistribution['float'], 1);
  assert.strictEqual(stats.typeDistribution['boolean'], 2);
});

test('JSON Analysis: Invalid JSON fails gracefully without exception', () => {
  const malformed = '{"title": "Unterminated string, "code": 100';
  const parsed = diagnostics.JSONInspector.safeParse(malformed);

  assert.strictEqual(parsed.success, false);
  assert.ok(parsed.error.includes('JSON.parse failure'));
  assert.ok(parsed.snippet.includes('Unterminated'));
});

test('JSON Analysis: Missing properties detection via Schema Validation', () => {
  const targetObj = {
    id: 101,
    // missing required 'username' and 'email'
    profile: {
      bio: 'Hello world'
      // missing required 'avatar_url'
    }
  };

  const schema = {
    required: ['id', 'username', 'email', 'profile'],
    properties: {
      id: { type: 'number' },
      username: { type: 'string' },
      email: { type: 'string' },
      profile: {
        type: 'object',
        required: ['avatar_url'],
        properties: {
          bio: { type: 'string' },
          avatar_url: { type: 'string' }
        }
      }
    }
  };

  const valResult = diagnostics.JSONInspector.validateSchema(targetObj, schema);
  assert.strictEqual(valResult.valid, false);
  assert.strictEqual(valResult.issuesCount, 3);

  const issuePaths = valResult.issues.map((i) => i.path);
  assert.ok(issuePaths.includes('$.username'));
  assert.ok(issuePaths.includes('$.email'));
  assert.ok(issuePaths.includes('$.profile.avatar_url'));
});

test('JSON Analysis: Null and empty value detection', () => {
  const complexObj = {
    valid_name: 'John',
    nullable_field: null,
    empty_str: '',
    empty_arr: [],
    empty_obj: {},
    nested: {
      sub_null: null,
      sub_empty_str: ''
    }
  };

  const stats = diagnostics.JSONInspector.inspectStructure(complexObj);
  assert.strictEqual(stats.nullProperties.length, 2);
  assert.ok(stats.nullProperties.includes('$.nullable_field'));
  assert.ok(stats.nullProperties.includes('$.nested.sub_null'));

  assert.strictEqual(stats.emptyStrings.length, 2);
  assert.ok(stats.emptyStrings.includes('$.empty_str'));
  assert.ok(stats.emptyStrings.includes('$.nested.sub_empty_str'));

  assert.strictEqual(stats.emptyArrays.length, 1);
  assert.ok(stats.emptyArrays.includes('$.empty_arr'));

  assert.strictEqual(stats.emptyObjects.length, 1);
  assert.ok(stats.emptyObjects.includes('$.empty_obj'));
});

test('JSON Analysis: Empty response bodies handled gracefully', () => {
  assert.strictEqual(diagnostics.JSONInspector.safeParse('').success, false);
  assert.strictEqual(diagnostics.JSONInspector.safeParse('   ').success, false);
  assert.strictEqual(diagnostics.JSONInspector.safeParse(null).success, false);
  assert.strictEqual(diagnostics.JSONInspector.safeParse(undefined).success, false);
});

// =========================================================================
// TEST SUITE 2: HTTP CONSISTENCY & ERROR RESPONSES
// =========================================================================

test('Consistency Checks: Identifies soft 200 error payloads', () => {
  const req = { url: 'https://api.example.com/data', method: 'GET', headers: {} };
  const res = { status: 200, headers: { 'content-type': 'application/json' }, body: '{"error": "Session expired", "err_code": 40101}' };
  const parsed = diagnostics.JSONInspector.safeParse(res.body);

  const evalResult = diagnostics.ConsistencyChecker.evaluate(req, res, parsed);
  assert.strictEqual(evalResult.hasAnomalies, true);
  assert.strictEqual(evalResult.anomalies[0].type, 'SOFT_ERROR_STATUS_200');
  assert.strictEqual(evalResult.anomalies[0].severity, 'HIGH');
});

test('Consistency Checks: Identifies HTTP error responses with HTML instead of JSON', () => {
  const req = { url: 'https://api.example.com/v1/user', method: 'GET', headers: {} };
  const res = {
    status: 502,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: '<html><body>502 Bad Gateway - Cloudflare</body></html>'
  };
  const parsed = diagnostics.JSONInspector.safeParse(res.body);

  const evalResult = diagnostics.ConsistencyChecker.evaluate(req, res, parsed);
  assert.strictEqual(evalResult.hasAnomalies, true);
  const htmlAnomaly = evalResult.anomalies.find((a) => a.type === 'HTML_ERROR_PAGE_FROM_API');
  assert.ok(htmlAnomaly);
  assert.strictEqual(htmlAnomaly.severity, 'MEDIUM');
});

test('Consistency Checks: Identifies HTTP 204 with unexpected body', () => {
  const req = { url: 'https://api.example.com/delete', method: 'DELETE', headers: {} };
  const res = { status: 204, headers: {}, body: '{"deleted": true}' };
  const parsed = diagnostics.JSONInspector.safeParse(res.body);

  const evalResult = diagnostics.ConsistencyChecker.evaluate(req, res, parsed);
  assert.strictEqual(evalResult.hasAnomalies, true);
  const noContentAnomaly = evalResult.anomalies.find((a) => a.type === 'NO_CONTENT_VIOLATION');
  assert.ok(noContentAnomaly);
});

// =========================================================================
// TEST SUITE 3: REVENUECAT SUBSCRIPTION DIAGNOSTICS (READ-ONLY)
// =========================================================================

test('Subscription Diagnostics: Accurately analyzes active and expired RevenueCat subscriptions', () => {
  const rcPayload = {
    request_date: '2026-11-16T08:00:00Z',
    subscriber: {
      original_app_user_id: '$RCAnonymousID:88dfa9104b9042b3',
      subscriptions: {
        'locket_1600_1y': {
          store: 'app_store',
          ownership_type: 'PURCHASED',
          period_type: 'normal',
          is_sandbox: false,
          purchase_date: '2026-01-01T00:00:00Z',
          expires_date: '2027-01-01T00:00:00Z', // Active (future)
          billing_issues_detected_at: null
        },
        'old_trial_monthly': {
          store: 'app_store',
          ownership_type: 'PURCHASED',
          period_type: 'trial',
          is_sandbox: true,
          purchase_date: '2023-01-01T00:00:00Z',
          expires_date: '2023-01-14T00:00:00Z' // Expired (past)
        }
      },
      entitlements: {
        'Gold': {
          product_identifier: 'locket_1600_1y',
          purchase_date: '2026-01-01T00:00:00Z',
          expires_date: '2027-01-01T00:00:00Z'
        }
      }
    }
  };

  const report = diagnostics.RevenueCatDiagnostic.analyze(200, rcPayload);
  assert.strictEqual(report.schemaValid, true);
  assert.strictEqual(report.activeSubscriptions.length, 1);
  assert.strictEqual(report.activeSubscriptions[0].productId, 'locket_1600_1y');
  assert.strictEqual(report.activeSubscriptions[0].isActive, true);
  assert.strictEqual(report.activeSubscriptions[0].isSandbox, false);

  assert.strictEqual(report.expiredSubscriptions.length, 1);
  assert.strictEqual(report.expiredSubscriptions[0].productId, 'old_trial_monthly');
  assert.strictEqual(report.expiredSubscriptions[0].isActive, false);

  assert.strictEqual(report.entitlementsSummary['Gold'].productIdentifier, 'locket_1600_1y');
  assert.strictEqual(report.entitlementsSummary['Gold'].isActive, true);
  assert.strictEqual(report.anomalies.length, 0);
});

test('Subscription Diagnostics: Flags entitlement referencing nonexistent product', () => {
  const brokenPayload = {
    subscriber: {
      subscriptions: {},
      entitlements: {
        'GhostTier': {
          product_identifier: 'unregistered_product_sku',
          expires_date: '2099-01-01T00:00:00Z'
        }
      }
    }
  };

  const report = diagnostics.RevenueCatDiagnostic.analyze(200, brokenPayload);
  assert.strictEqual(report.anomalies.length, 1);
  assert.ok(report.anomalies[0].includes('references product "unregistered_product_sku"'));
});

// =========================================================================
// TEST SUITE 4: IMAGE WORKFLOW & AI EVIDENCE CLASSIFICATION
// =========================================================================

test('Image Workflow: Correctly classifies Presigned S3/GCS Upload', () => {
  const req = {
    url: 'https://storage.googleapis.com/locket-user-uploads/moment_abc123.jpg?X-Goog-Algorithm=...',
    method: 'PUT',
    headers: {
      'content-type': 'image/jpeg',
      'content-length': '245192'
    }
  };
  const res = { status: 200, headers: { 'x-goog-generation': '170000000' }, body: '' };
  const parsed = diagnostics.JSONInspector.safeParse(res.body);

  const report = diagnostics.ImageWorkflowDiagnostic.analyze(req, res, parsed);
  assert.strictEqual(report.workflowType, diagnostics.IMAGE_WORKFLOW_TYPES.STORAGE_TRANSFER);
  assert.strictEqual(report.inputAnalysis.isPresignedUpload, true);
  assert.strictEqual(report.inputAnalysis.presignedVendor, 'Google Cloud Storage');
  assert.strictEqual(report.inputAnalysis.mechanism, 'HTTP_PUT_PRESIGNED_BLOB');
  assert.strictEqual(report.inputAnalysis.contentLength, 245192);
});

test('Image Workflow: Verifies local rendering when downloading shaders/filters without AI', () => {
  const req = {
    url: 'https://api.locketcamera.com/v1/filters/stickers/config.json',
    method: 'GET',
    headers: {}
  };
  const res = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      filters: [{ id: 'vintage_sepia', lut_url: 'https://cdn.example.com/vintage.cube' }]
    })
  };
  const parsed = diagnostics.JSONInspector.safeParse(res.body);

  const report = diagnostics.ImageWorkflowDiagnostic.analyze(req, res, parsed);
  assert.strictEqual(report.workflowType, diagnostics.IMAGE_WORKFLOW_TYPES.CLIENT_LOCAL_RENDER);
  assert.strictEqual(report.processingParameters.isLocalRenderingOnly, true);
  assert.strictEqual(report.processingParameters.hasAiEvidence, false);
});

test('Image Workflow: Verifies server-side generative AI only when explicit evidence exists', () => {
  const req = {
    url: 'https://api.example.com/v1/generate/portrait',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      prompt: 'Retro 90s aesthetic portrait',
      seed: 428192,
      steps: 30,
      denoising_strength: 0.75,
      model_id: 'flux-realism-v1'
    })
  };
  const res = {
    status: 202,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      job_id: 'job_gen_99818',
      status: 'queued',
      estimated_time: 4.5,
      poll_url: 'https://api.example.com/v1/jobs/job_gen_99818'
    })
  };
  const parsed = diagnostics.JSONInspector.safeParse(res.body);

  const report = diagnostics.ImageWorkflowDiagnostic.analyze(req, res, parsed);
  assert.strictEqual(report.workflowType, diagnostics.IMAGE_WORKFLOW_TYPES.SERVER_AI_TRANSFORMATION);
  assert.strictEqual(report.processingParameters.hasAiEvidence, true);
  assert.ok(report.processingParameters.detectedAiParameters.includes('prompt'));
  assert.ok(report.processingParameters.detectedAiParameters.includes('seed'));
  assert.ok(report.processingParameters.detectedAiParameters.includes('model_id'));
  assert.strictEqual(report.asyncJobLifecycle.isAsync, true);
  assert.strictEqual(report.asyncJobLifecycle.jobId, 'job_gen_99818');
  assert.strictEqual(report.asyncJobLifecycle.status, 'queued');
});

test('Image Workflow: Rejects AI classification for traditional photobooth stitcher', () => {
  const req = {
    url: 'https://api.example.com/v1/render/photobooth',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      layout: '4-cut',
      border_color: '#FFFFFF',
      aspect_ratio: '3:4',
      photos: ['url1', 'url2', 'url3', 'url4']
    })
  };
  const res = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ result_url: 'https://cdn.example.com/output.jpg' })
  };
  const parsed = diagnostics.JSONInspector.safeParse(res.body);

  const report = diagnostics.ImageWorkflowDiagnostic.analyze(req, res, parsed);
  assert.strictEqual(report.workflowType, diagnostics.IMAGE_WORKFLOW_TYPES.SERVER_PROCEDURAL_RENDER);
  assert.strictEqual(report.processingParameters.hasAiEvidence, false);
});

// =========================================================================
// TEST SUITE 5: PRIVACY REDACTION & SANITIZATION
// =========================================================================

test('Privacy Guard: Redacts sensitive headers and decodes JWT metadata safely', () => {
  // Construct a dummy JWT: header.payload.signature
  const headerB64 = Buffer.from(JSON.stringify({ alg: 'ES256', typ: 'JWT' })).toString('base64');
  const payloadB64 = Buffer.from(JSON.stringify({ sub: 'user_999888', exp: 1999999999 })).toString('base64');
  const dummyJwt = `${headerB64}.${payloadB64}.fakeSignatureStringHere`;

  const headers = {
    'Authorization': `Bearer ${dummyJwt}`,
    'Cookie': 'session_token=abcdef123456789; secure; HttpOnly',
    'X-Api-Key': 'secret_key_prod_8992',
    'Content-Type': 'application/json'
  };

  const sanitized = diagnostics.PrivacyGuard.sanitizeHeaders(headers);
  assert.ok(sanitized['Authorization'].includes('REDACTED_JWT'));
  assert.ok(sanitized['Authorization'].includes('alg=ES256'));
  assert.ok(sanitized['Cookie'].includes('[REDACTED len='));
  assert.ok(sanitized['X-Api-Key'].includes('[REDACTED len='));
  assert.strictEqual(sanitized['Content-Type'], 'application/json');
});

test('Privacy Guard: Masks email, phone numbers, and sensitive JSON payload fields', () => {
  const sensitivePayload = {
    user_email: 'testuser@example.com',
    phone: '+84901234567',
    password_hash: '$2b$12$e8Y6...',
    access_token: 'secret_token_12345',
    public_display_name: 'Alex'
  };

  const clean = diagnostics.PrivacyGuard.sanitizeObject(sensitivePayload);
  assert.strictEqual(clean.user_email, 't***r@e***.com');
  assert.strictEqual(clean.public_display_name, 'Alex');
  assert.ok(clean.phone.includes('***'));
  assert.ok(clean.password_hash.includes('[REDACTED_SECRET'));
  assert.ok(clean.access_token.includes('[REDACTED_SECRET'));
});

// =========================================================================
// TEST SUITE 6: SHADOWROCKET RUNTIME ENVIRONMENT & FAIL-OPEN INTEGRITY
// =========================================================================

test('Shadowrocket Runtime: Strictly fail-open on valid response without mutating body', () => {
  const originalBody = JSON.stringify({ status: 'ok', data: [1, 2, 3] });
  const mockReq = {
    url: 'https://api.revenuecat.com/v1/subscribers/test_user',
    method: 'GET',
    headers: { 'Authorization': 'Bearer test_token' }
  };
  const mockRes = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: originalBody
  };

  const result = runInShadowrocketVm(mockReq, mockRes);
  assert.strictEqual(result.doneCalled, true, '$done must be executed');
  assert.strictEqual(typeof result.doneArgs, 'object', '$done argument must be an object');
  assert.strictEqual(Object.keys(result.doneArgs).length, 0, '$done({}) must be called with empty object to ensure NO body mutation');
  assert.strictEqual(mockRes.body, originalBody, '$response.body must not be modified');
  assert.ok(result.logs.some((l) => l.includes('[API-DIAG]')));
});

test('Shadowrocket Runtime: Strictly fail-open on fatal exception / corrupted payload', () => {
  const mockReq = {
    url: 'https://corrupted.example.com',
    method: 'GET',
    // Header getter that throws an unexpected error
    get headers() {
      throw new Error('Fatal header trap simulator');
    }
  };
  const mockRes = { status: 500, headers: {}, body: 'fatal error' };

  const result = runInShadowrocketVm(mockReq, mockRes);
  assert.strictEqual(result.doneCalled, true, '$done must be called even on fatal engine exception');
  assert.strictEqual(typeof result.doneArgs, 'object', '$done argument must be an object');
  assert.strictEqual(Object.keys(result.doneArgs).length, 0, '$done({}) must be called with empty object');
  assert.ok(result.logs.some((l) => l.includes('Fatal exception inside diagnostic engine') || l.includes('[ERROR]')));
});
