const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const test = require('node:test');

const scriptCode = fs.readFileSync('shadowrocket/js/locket_pb_req.js', 'utf8');

function runScript(sandboxContext) {
  let doneResult = null;
  const context = {
    $request: sandboxContext.$request,
    $response: sandboxContext.$response,
    $done: (val) => {
      doneResult = val;
    },
    console: console,
    ...sandboxContext
  };
  vm.runInNewContext(scriptCode, context);
  return doneResult;
}

test('locket_pb_req [REQUEST]: mocks HTTP 200 response when imageUrl is present', () => {
  const result = runScript({
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: JSON.stringify({
        data: {
          imageUrl: 'https://firebasestorage.googleapis.com/v0/b/locket-4252a.appspot.com/o/test.jpg?alt=media',
          filterId: 'photobooth_4cut'
        }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  assert(result.response, 'Expected response wrapper in Shadowrocket http-request mock');
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(result.response.headers['Content-Type'], 'application/json; charset=utf-8');

  const body = JSON.parse(result.response.body);
  assert.strictEqual(body.result.status, 200);
  assert(body.result.outputUrl.includes('test.jpg'));
});

test('locket_pb_req [REQUEST]: mocks HTTP 200 response even if body is empty (failsafe)', () => {
  const result = runScript({
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: ''
    }
  });

  assert(result, 'Expected $done to be called');
  assert(result.response, 'Expected response wrapper in Shadowrocket http-request mock');
  assert.strictEqual(result.response.status, 200);

  const body = JSON.parse(result.response.body);
  assert.strictEqual(body.result.status, 200);
});

test('locket_pb_req [RESPONSE]: strips errors from upstream 403 and returns 200 OK', () => {
  const result = runScript({
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: JSON.stringify({ imageUrl: 'https://example.com/photo.jpg' })
    },
    $response: {
      status: 403,
      headers: {
        'content-encoding': 'gzip',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        error: {
          message: 'Permission denied: Requires Gold Subscription',
          status: 'PERMISSION_DENIED'
        }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  assert.strictEqual(result.status, 200);
  assert.strictEqual(result.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.strictEqual(result.headers['content-encoding'], undefined);

  const body = JSON.parse(result.body);
  assert.strictEqual(body.error, undefined);
  assert.strictEqual(body.result.status, 200);
  assert.strictEqual(body.result.unlocked, true);
  assert.strictEqual(body.result.requires_gold, false);
});

