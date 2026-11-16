const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const diagnostics = require('../../shadowrocket/js/locket_audio_diagnostics.js');

const scriptSource = fs.readFileSync(
  path.resolve(__dirname, '../../shadowrocket/js/locket_audio_diagnostics.js'),
  'utf8'
);

function runInShadowrocketVm(mockRequest, mockResponse) {
  let doneCalled = false;
  let doneArgs = null;
  const logs = [];

  const sandbox = {
    $request: mockRequest,
    $response: mockResponse,
    $done: function (res) {
      doneCalled = true;
      doneArgs = res;
    },
    console: {
      log: function (...args) {
        logs.push(args.join(' '));
      }
    },
    Date: Date,
    JSON: JSON,
    Math: Math,
    String: String,
    Object: Object,
    Array: Array
  };

  vm.runInNewContext(scriptSource, sandbox);

  return { doneCalled, doneArgs, logs };
}

// =========================================================================
// TEST SUITE: LOCKET AUDIO DIAGNOSTICS
// =========================================================================

test('Stage Classification: Classifies GCS Video Upload', () => {
  const stage = diagnostics.AudioDiagnosticEngine.classifyStage(
    'https://storage.googleapis.com/locket-video/user123_moment.mp4?X-Goog-Algorithm=...',
    'PUT',
    { 'content-type': 'video/mp4' },
    {}
  );
  assert.strictEqual(stage, 'STAGE_2_VIDEO_UPLOAD_STORAGE');
});

test('Stage Classification: Classifies Moment Creation API', () => {
  const stage = diagnostics.AudioDiagnosticEngine.classifyStage(
    'https://api.locketcamera.com/createMoment',
    'POST',
    { 'content-type': 'application/json' },
    {}
  );
  assert.strictEqual(stage, 'STAGE_2_MOMENT_CREATION_API');
});

test('Stage Classification: Classifies Moment Feed Delivery', () => {
  const stage = diagnostics.AudioDiagnosticEngine.classifyStage(
    'https://api.locketcamera.com/fetchMoments?limit=20',
    'GET',
    {},
    { 'content-type': 'application/json' }
  );
  assert.strictEqual(stage, 'STAGE_4_MOMENT_FEED_DELIVERY');
});

test('Media Container: Detects audio and video tracks in MP4/MOV snippet', () => {
  // Mock MP4 snippet containing both 'vide' (video track) and 'soun' (sound track)
  const binaryWithAudio = '....ftypmp42....moov....trak....mdia....hdlrvide....trak....mdia....hdlrsoun....mp4a....';
  const resultWithAudio = diagnostics.MediaContainerInspector.inspectBinarySnippet(binaryWithAudio);

  assert.strictEqual(resultWithAudio.hasVideoTrack, true);
  assert.strictEqual(resultWithAudio.hasAudioTrack, true);
  assert.strictEqual(resultWithAudio.detectedCodecs.aac, true);

  // Mock MP4 snippet containing ONLY video track ('vide') and NO sound track
  const binaryMuted = '....ftypmp42....moov....trak....mdia....hdlrvide....avc1....';
  const resultMuted = diagnostics.MediaContainerInspector.inspectBinarySnippet(binaryMuted);

  assert.strictEqual(resultMuted.hasVideoTrack, true);
  assert.strictEqual(resultMuted.hasAudioTrack, false);
});

test('JSON Extractor: Extracts nested media and audio fields', () => {
  const mockFeed = {
    data: {
      moments: [
        {
          id: 'moment_001',
          video_url: 'https://cdn.locketcamera.com/video/001.mp4',
          thumbnail_url: 'https://cdn.locketcamera.com/thumb/001.jpg',
          duration: 30.0,
          has_audio: false,
          user: { name: 'Alice' }
        }
      ]
    }
  };

  const extracted = diagnostics.JsonMediaExtractor.extractMediaNodes(mockFeed);
  assert.ok(extracted.length >= 1);
  const fields = extracted[0].fields;
  assert.ok(fields.video_url.includes('001.mp4'));
  assert.strictEqual(fields.duration, 30.0);
  assert.strictEqual(fields.has_audio, false);
});

test('Privacy Guard: Redacts sensitive query parameters in URLs', () => {
  const rawGcsUrl = 'https://storage.googleapis.com/locket-video/file.mp4?X-Goog-Signature=secretSig12345&other=1';
  const cleanUrl = diagnostics.PrivacyGuard.maskUrl(rawGcsUrl);
  assert.ok(!cleanUrl.includes('secretSig12345'));
  assert.ok(cleanUrl.includes('[REDACTED_SIGNATURE]'));
});

test('Shadowrocket VM: Fail-open guarantee without altering original response', () => {
  const originalBody = JSON.stringify({
    moments: [{ id: 'm1', video_url: 'https://cdn.example.com/v1.mp4' }]
  });

  const mockReq = {
    url: 'https://api.locketcamera.com/fetchMoments',
    method: 'GET',
    headers: { 'Authorization': 'Bearer secret_token' }
  };
  const mockRes = {
    status: 200,
    headers: { 'content-type': 'application/json' },
    body: originalBody
  };

  const vmResult = runInShadowrocketVm(mockReq, mockRes);
  assert.strictEqual(vmResult.doneCalled, true);
  assert.strictEqual(typeof vmResult.doneArgs, 'object');
  assert.strictEqual(Object.keys(vmResult.doneArgs).length, 0); // Must be strictly empty object
  assert.strictEqual(mockRes.body, originalBody); // Must not mutate body
  assert.ok(vmResult.logs.some((l) => l.includes('STAGE_4_MOMENT_FEED_DELIVERY')));
});

