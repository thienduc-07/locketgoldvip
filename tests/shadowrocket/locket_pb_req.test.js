const fs = require('fs');
const vm = require('vm');
const assert = require('assert');
const test = require('node:test');

const pbScriptCode = fs.readFileSync('shadowrocket/js/locket_pb_req.js', 'utf8');
const filterScriptCode = fs.readFileSync('shadowrocket/js/locket_filter_response.js', 'utf8');

function runPBScript(sandboxContext) {
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
  vm.runInNewContext(pbScriptCode, context);
  return doneResult;
}

function runFilterScript(sandboxContext) {
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
  vm.runInNewContext(filterScriptCode, context);
  return doneResult;
}

// =========================================================================
// TEST GROUP B: REQUEST HANDLING
// =========================================================================

test('Group B - Request: returns short-circuit mock 200 response with photoUrl to prevent infinite Developing hang and 307 redirect', () => {
  const inputPhoto = 'https://firebasestorage.googleapis.com/v0/b/locket-4252a.appspot.com/o/test.jpg?alt=media';
  const result = runPBScript({
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          imageUrl: inputPhoto,
          filterId: 'photobooth_4cut'
        }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  assert(result.response, 'Request handler must return { response: { status: 200, ... } }');
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(result.response.headers['Content-Type'], 'application/json; charset=utf-8');

  const resBody = JSON.parse(result.response.body);
  assert.strictEqual(resBody.status, 200);
  assert.strictEqual(resBody.success, true);
  assert.strictEqual(resBody.outputUrl, inputPhoto);
  assert.strictEqual(resBody.result.outputUrl, inputPhoto);
  assert.strictEqual(resBody.result.data.outputUrl, inputPhoto);
});

test('Group B - Request: handles invalid JSON in request body gracefully without throwing', () => {
  assert.doesNotThrow(() => {
    const result = runPBScript({
      $request: {
        url: 'https://api.locketcamera.com/generateFilteredImage',
        body: 'INVALID_JSON{{{///'
      }
    });
    assert(result, 'Expected $done to be called');
  });
});

test('Group B - Request: handles missing image URL and missing filter ID safely', () => {
  const result = runPBScript({
    $request: {
      url: 'https://api.locketcamera.com/generateFilteredImage',
      body: JSON.stringify({})
    }
  });
  assert(result, 'Expected $done to be called');
});

test('Group B - Request: handles empty body / unexpected request body safely', () => {
  const result = runPBScript({
    $request: {
      url: 'https://api.locketcamera.com/generateFilteredImage',
      body: ''
    }
  });
  assert(result, 'Expected $done to be called');
});

test('Group B - Request: handles null/missing $request cleanly (fail-open)', () => {
  const result = runPBScript({
    $request: null
  });
  assert(result && Object.keys(result).length === 0, 'Expected empty object pass-through');
});

test('Group B - Request: preserves original request if already targeting processing host', () => {
  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage?module=Locket_YouTube',
      headers: { Host: 'uplocket.io.vn' },
      body: JSON.stringify({ data: { filterId: 'looks_maxxing' } })
    }
  });
  // When already targeting worker host, passes through unchanged
  assert(result && Object.keys(result).length === 0, 'Expected empty object pass-through');
});

// =========================================================================
// TEST GROUP C: RESPONSE HANDLING & PIPELINE INTEGRITY
// =========================================================================

test('Group C - Response: PRESERVES valid upstream processed output URL and NEVER overwrites with input photo', () => {
  const inputPhotoUrl = 'https://firebasestorage.googleapis.com/v0/b/locket.appspot.com/o/raw_input.jpg';
  const processedOutputUrl = 'https://cdn.uplocket.io.vn/processed/ai_looks_maxxing_final_999.jpg';

  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage',
      body: JSON.stringify({
        data: {
          imageUrl: inputPhotoUrl,
          filterId: 'looks_maxxing'
        }
      })
    },
    $response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          status: 200,
          outputUrl: processedOutputUrl
        }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  assert.strictEqual(result.status, 200);

  const resBody = JSON.parse(result.body);
  // CRITICAL AUDIT CHECK: Processed image URL must be preserved!
  assert.strictEqual(resBody.result.outputUrl, processedOutputUrl, 'Output URL must be the processed image!');
  assert.strictEqual(resBody.outputUrl, processedOutputUrl, 'Root outputUrl must be the processed image!');
  assert.notStrictEqual(resBody.result.outputUrl, inputPhotoUrl, 'Output URL must NOT be overwritten with input photo!');
});

test('Group C - Response: preserves PENDING state for asynchronous tasks without falsely claiming completion', () => {
  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage',
      body: JSON.stringify({ data: { filterId: 'pb_4cut', taskId: 'task_123' } })
    },
    $response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        status: 'PENDING',
        task_id: 'task_123',
        message: 'Rendering photobooth collage...'
      })
    }
  });

  assert(result, 'Expected $done to be called');
  assert.strictEqual(result.status, 200);
  const resBody = JSON.parse(result.body);
  assert.strictEqual(resBody.status, 'PENDING');
  assert.strictEqual(resBody.task_id, 'task_123');
});

test('Group C - Response: preserves PROCESSING state for asynchronous tasks', () => {
  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage',
      body: JSON.stringify({ data: { filterId: 'photobooth_cute' } })
    },
    $response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          status: 'PROCESSING',
          progress: 50
        }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  const resBody = JSON.parse(result.body);
  assert.strictEqual(resBody.result.status, 'PROCESSING');
});

test('Group C - Response: handles nested response objects (result.data.outputUrl)', () => {
  const deepOutput = 'https://storage.googleapis.com/moments/nested_effect.jpg';
  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage',
      body: JSON.stringify({ data: { filterId: 'disco_lights' } })
    },
    $response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          data: {
            outputUrl: deepOutput
          }
        }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  const resBody = JSON.parse(result.body);
  assert.strictEqual(resBody.result.outputUrl, deepOutput);
});

test('Group C - Response: gracefully falls back to captured photo with HTTP 200 on server-side processing error to prevent Developing hang', () => {
  const photoUrl = 'https://test.com/in.jpg';
  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage',
      body: JSON.stringify({ data: { filterId: 'looks_maxxing', imageUrl: photoUrl } })
    },
    $response: {
      status: 500,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        error: { message: 'Vertex AI backend capacity exceeded' }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  assert.strictEqual(result.status, 200, 'Must return safe 200 fallback');
  const resBody = JSON.parse(result.body);
  assert.strictEqual(resBody.success, true);
  assert.strictEqual(resBody.outputUrl, photoUrl, 'Must return captured photo on error');
});

test('Group C - Response: handles timeout response (504 Gateway Timeout) cleanly with safe photo fallback', () => {
  const photoUrl = 'https://test.com/in.jpg';
  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage',
      body: JSON.stringify({ data: { filterId: 'beard', imageUrl: photoUrl } })
    },
    $response: {
      status: 504,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Gateway Timeout' })
    }
  });

  assert(result, 'Expected $done to be called');
  assert.strictEqual(result.status, 200);
  const resBody = JSON.parse(result.body);
  assert.strictEqual(resBody.success, true);
  assert.strictEqual(resBody.outputUrl, photoUrl);
});

// =========================================================================
// TEST GROUP D: IMAGE VALIDATION & SANITIZATION
// =========================================================================

test('Group D - Image: extracts valid HTTPS JPEG and PNG urls without corrupted escapes', () => {
  const escapedUrl = 'https:\\/\\/cdn.locketcamera.com\\/images\\/shot.png?token=abc\\u0026v=1';
  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage',
      body: JSON.stringify({ data: { filterId: 'frame_classic_pb' } })
    },
    $response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        result: {
          outputUrl: escapedUrl
        }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  const resBody = JSON.parse(result.body);
  assert.strictEqual(resBody.result.outputUrl, 'https://cdn.locketcamera.com/images/shot.png?token=abc&v=1');
  assert(!resBody.result.outputUrl.includes('\\'));
});

test('Group D - Image: strips compression and length headers from modified response', () => {
  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage',
      body: JSON.stringify({ data: { filterId: 'photobooth_4cut' } })
    },
    $response: {
      status: 200,
      headers: {
        'content-encoding': 'gzip',
        'content-length': '9999',
        'transfer-encoding': 'chunked',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        result: { outputUrl: 'https://cdn.example.com/out.jpg' }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  assert.strictEqual(result.headers['content-encoding'], undefined);
  assert.strictEqual(result.headers['Content-Encoding'], undefined);
  assert.strictEqual(result.headers['content-length'], undefined);
  assert.strictEqual(result.headers['Transfer-Encoding'], undefined);
  assert.strictEqual(result.headers['Content-Type'], 'application/json; charset=utf-8');
});

// =========================================================================
// TEST GROUP E: REGRESSION & OVERLAY COMPOSITING
// =========================================================================

test('Group E - Regression: overlay frame filter provides client compositing base when upstream lacks cloud template', () => {
  const inputPhoto = 'https://storage.googleapis.com/test_shot.jpg';
  const result = runPBScript({
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage',
      body: JSON.stringify({
        data: {
          filter_id: 'khung_nh_shin_chan_vi_n_m_nh',
          imageUrl: inputPhoto
        }
      })
    },
    $response: {
      status: 403,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ error: 'Template not on server' })
    }
  });

  assert(result, 'Expected $done to be called');
  assert.strictEqual(result.status, 200);
  const resBody = JSON.parse(result.body);
  assert.strictEqual(resBody.result.status, 200);
  assert.strictEqual(resBody.result.outputUrl, inputPhoto);
});

test('Group E - Regression: locket_filter_response passes through generateFilteredImage without collision', () => {
  const result = runFilterScript({
    $request: {
      url: 'https://api.locketcamera.com/generateFilteredImage',
      body: JSON.stringify({ data: { imageUrl: 'https://storage.googleapis.com/test.jpg' } })
    },
    $response: {
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ result: { outputUrl: 'https://storage.googleapis.com/real_processed.jpg' } })
    }
  });

  // Must hand off generateFilteredImage to locket_pb_req by returning empty object without mutating body
  assert(result && Object.keys(result).length === 0, 'Expected empty object pass-through');
});

test('Group E - Regression: Photobooth 4cut handles HTTP 307 Redirect by stripping location header and returning photo from persistentStore with status 200', () => {
  const store = {
    locket_last_photo_url: 'https://firebasestorage.googleapis.com/v0/b/locket-4252a.appspot.com/o/photo_4cut.jpg?alt=media',
    locket_last_filter_id: 'photobooth_4cut'
  };

  const result = runPBScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $request: {
      url: 'https://uplocket.io.vn/generateFilteredImage?module=Locket_YouTube'
      // Body omitted by Shadowrocket during response phase
    },
    $response: {
      status: 307,
      headers: {
        'content-type': 'text/plain',
        'location': 'https://uplocket.io.vn/sign-in?redirectTo=%2FgenerateFilteredImage',
        'set-cookie': 'session=abc'
      },
      body: 'https://uplocket.io.vn/sign-in?redirectTo=%2FgenerateFilteredImage'
    }
  });

  assert(result, 'Expected $done to be called');
  assert.strictEqual(result.status, 200, 'Must return HTTP 200');
  assert.strictEqual(result.headers['location'], undefined, 'Must strip location header');
  assert.strictEqual(result.headers['Location'], undefined, 'Must strip Location header');
  assert.strictEqual(result.headers['set-cookie'], undefined, 'Must strip set-cookie header');
  assert.strictEqual(result.headers['Content-Type'], 'application/json; charset=utf-8');

  const resBody = JSON.parse(result.body);
  assert.strictEqual(resBody.status, 200);
  assert.strictEqual(resBody.success, true);
  assert.strictEqual(resBody.outputUrl, store.locket_last_photo_url);
  assert.strictEqual(resBody.result.outputUrl, store.locket_last_photo_url);
  assert.strictEqual(resBody.result.data.outputUrl, store.locket_last_photo_url);
  assert.strictEqual(resBody.data.outputUrl, store.locket_last_photo_url);
});

test('Group E - Regression: Request mode persists photoUrl and filterId to persistentStore', () => {
  const store = {};
  const photoUrl = 'https://firebasestorage.googleapis.com/v0/b/locket-4252a.appspot.com/o/my_photo.jpg?alt=media';

  const result = runPBScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        data: {
          imageUrl: photoUrl,
          filterId: 'photobooth_cute'
        }
      })
    }
  });

  assert(result, 'Expected $done to be called');
  assert.strictEqual(store.locket_last_photo_url, photoUrl, 'photoUrl must be written to persistent store');
  assert.strictEqual(store.locket_last_filter_id, 'photobooth_cute', 'filterId must be written to persistent store');
});

// =========================================================================
// TEST GROUP F: AI FILTER RECOVERY & DYNAMIC CONFIGURATION
// =========================================================================

test('Group F - AI Filter Recovery: returns safe HTTP 200 fallback with captured photo when AI host is not set', () => {
  const store = {};
  const photoUrl = 'https://firebasestorage.googleapis.com/v0/b/locket/o/selfie.jpg';
  const result = runPBScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: JSON.stringify({
        data: {
          imageUrl: photoUrl,
          filterId: 'looks_maxxing'
        }
      })
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(result.response.status, 200, 'Must return safe 200 fallback');
  const body = JSON.parse(result.response.body);
  assert.strictEqual(body.outputUrl, photoUrl);
  assert.strictEqual(body.success, true);
});

test('Group F - AI Filter Recovery: calls $httpClient.post and returns HTTP 200 with AI outputUrl when AI Engine succeeds', () => {
  const store = { locket_ai_host: 'http://192.168.1.8:8000' };
  const photoUrl = 'https://firebasestorage.googleapis.com/v0/b/locket/o/selfie.jpg';
  const aiOutput = 'http://192.168.1.8:8000/api/v1/filters/output/session-123.jpg';
  let calledUrl = '';
  let calledBody = null;

  const result = runPBScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $httpClient: {
      post: (options, callback) => {
        calledUrl = options.url;
        calledBody = JSON.parse(options.body);
        callback(null, { status: 200 }, JSON.stringify({
          status: 'success',
          session_id: 'session-123',
          output_url: aiOutput
        }));
      }
    },
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: JSON.stringify({
        data: {
          imageUrl: photoUrl,
          filterId: 'beard'
        }
      })
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(calledUrl, 'http://192.168.1.8:8000/api/v1/filters/process-url');
  assert.strictEqual(calledBody.image_url, photoUrl);
  assert.strictEqual(calledBody.filter_id, 'beard');
  assert.strictEqual(result.response.status, 200);
  const body = JSON.parse(result.response.body);
  assert.strictEqual(body.outputUrl, aiOutput);
  assert.strictEqual(body.result.outputUrl, aiOutput);
  assert.strictEqual(body.data.outputUrl, aiOutput);
});

test('Group F - AI Filter Recovery: returns safe HTTP 200 fallback with captured photo when AI Engine returns 500', () => {
  const store = { locket_ai_host: 'http://192.168.1.8:8000' };
  const photoUrl = 'https://firebasestorage.googleapis.com/v0/b/locket/o/selfie.jpg';

  const result = runPBScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $httpClient: {
      post: (options, callback) => {
        callback(null, { status: 500 }, JSON.stringify({
          detail: 'Model GPU out of memory'
        }));
      }
    },
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: JSON.stringify({
        data: {
          imageUrl: photoUrl,
          filterId: 'anime'
        }
      })
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(result.response.status, 200);
  const body = JSON.parse(result.response.body);
  assert.strictEqual(body.outputUrl, photoUrl);
  assert.strictEqual(body.success, true);
});

test('Group F - AI Filter Recovery: returns safe HTTP 200 fallback with captured photo when $httpClient encounters network timeout/error', () => {
  const store = { locket_ai_host: 'http://192.168.1.8:8000' };
  const photoUrl = 'https://firebasestorage.googleapis.com/v0/b/locket/o/selfie.jpg';

  const result = runPBScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $httpClient: {
      post: (options, callback) => {
        callback(new Error('Connection timed out to 192.168.1.8:8000'), null, null);
      }
    },
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: JSON.stringify({
        data: {
          imageUrl: photoUrl,
          filterId: 'chibi_3d'
        }
      })
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(result.response.status, 200);
  const body = JSON.parse(result.response.body);
  assert.strictEqual(body.outputUrl, photoUrl);
  assert.strictEqual(body.success, true);
});

test('Group F - Dynamic Config: visiting set_ai_host in locket_pb_req updates persistentStore', () => {
  const store = {};
  const result = runPBScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $request: {
      url: 'https://api.locketcamera.com/set_ai_host?host=http%3A%2F%2F192.168.1.8%3A8000'
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(store.locket_ai_host, 'http://192.168.1.8:8000');
  assert.strictEqual(store.ai_engine_url, 'http://192.168.1.8:8000');
});

test('Group F - Dynamic Config: visiting set_ai_host in locket_filter_response updates persistentStore', () => {
  const store = {};
  const result = runFilterScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $request: {
      url: 'https://api.locketcamera.com/set_ai_host?host=http%3A%2F%2F192.168.1.8%3A8000'
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(result.response.status, 200);
  assert.strictEqual(store.locket_ai_host, 'http://192.168.1.8:8000');
});

test('Group F - Security: rejects invalid AI_HOST with cloud metadata (169.254.169.254)', () => {
  const store = {};
  const result = runFilterScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $request: {
      url: 'https://api.locketcamera.com/set_ai_host?host=http%3A%2F%2F169.254.169.254%3A8000'
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(result.response.status, 400);
  const body = JSON.parse(result.response.body);
  assert.strictEqual(body.code, 'INVALID_AI_HOST');
  assert.strictEqual(store.locket_ai_host, undefined, 'Invalid host must not be saved');
});

test('Group F - Security: rejects invalid AI_HOST with non-http scheme (ftp://, javascript:)', () => {
  const store = {};
  const result = runFilterScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $request: {
      url: 'https://api.locketcamera.com/set_ai_host?host=javascript%3Aalert(1)'
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(result.response.status, 400);
  assert.strictEqual(store.locket_ai_host, undefined);
});

test('Group F - Security: returns safe HTTP 200 fallback with captured photo when stored host is corrupted', () => {
  const store = { locket_ai_host: 'http://169.254.169.254:8000' };
  const photoUrl = 'https://firebasestorage.googleapis.com/v0/b/locket/o/selfie.jpg';

  const result = runPBScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: JSON.stringify({
        data: {
          imageUrl: photoUrl,
          filterId: 'beard'
        }
      })
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(result.response.status, 200);
  const body = JSON.parse(result.response.body);
  assert.strictEqual(body.outputUrl, photoUrl);
  assert.strictEqual(body.success, true);
});

test('Group F - Reliability: safeDone guarantees $done is called exactly once despite duplicate callback invocations', () => {
  const store = { locket_ai_host: 'http://192.168.1.8:8000' };
  const photoUrl = 'https://firebasestorage.googleapis.com/v0/b/locket/o/selfie.jpg';
  let doneCount = 0;

  let capturedDone = null;
  const context = {
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $httpClient: {
      post: (options, callback) => {
        // Deliberately trigger callback multiple times
        callback(null, { status: 200 }, JSON.stringify({ status: 'success', output_url: 'http://out1.jpg' }));
        callback(null, { status: 200 }, JSON.stringify({ status: 'success', output_url: 'http://out2.jpg' }));
      }
    },
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: JSON.stringify({
        data: {
          imageUrl: photoUrl,
          filterId: 'glasses'
        }
      })
    },
    $done: (res) => {
      doneCount++;
      capturedDone = res;
    },
    console: console
  };

  const pbScriptCode = require('fs').readFileSync('shadowrocket/js/locket_pb_req.js', 'utf8');
  require('vm').runInNewContext(pbScriptCode, context);

  assert.strictEqual(doneCount, 1, '$done must be invoked strictly once');
  assert(capturedDone && capturedDone.response);
  assert.strictEqual(capturedDone.response.status, 200);
});

test('Group F - Photobooth: Photobooth 4cut continues to return instant 200 with captured photo even if AI host is unconfigured', () => {
  const store = {}; // No AI host configured
  const photoUrl = 'https://firebasestorage.googleapis.com/v0/b/locket/o/captured_photobooth.jpg';

  const result = runPBScript({
    $persistentStore: {
      read: (k) => store[k] || '',
      write: (v, k) => { store[k] = v; }
    },
    $request: {
      url: 'https://us-central1-locket-4252a.cloudfunctions.net/generateFilteredImage',
      body: JSON.stringify({
        data: {
          imageUrl: photoUrl,
          filterId: 'photobooth_4cut'
        }
      })
    }
  });

  assert(result && result.response, 'Expected response object');
  assert.strictEqual(result.response.status, 200, 'Photobooth must succeed independently of AI host');
  const body = JSON.parse(result.response.body);
  assert.strictEqual(body.outputUrl, photoUrl);
  assert.strictEqual(body.success, true);
});


