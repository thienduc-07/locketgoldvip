const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const code = fs.readFileSync('shadowrocket/js/locket_firebase_response.js', 'utf8');

const mockObj = { entries: {} };
let capturedDone = null;
const sandbox = {
    $request: { headers: { 'User-Agent': 'Locket/1.0.0' } },
    $response: { body: JSON.stringify(mockObj) },
    $done: function (res) {
        capturedDone = res;
    },
    console: console
};

vm.runInNewContext(code, sandbox);

assert(capturedDone, "Expected $done to be called");
assert(capturedDone.body, "Expected $done to return body");

const parsed = JSON.parse(capturedDone.body);

// Test Cache Invalidation & Force Update
assert.strictEqual(parsed.state, "UPDATE", "Expected parsed.state to be UPDATE");
assert(parsed.templateVersion, "Expected templateVersion to be set");
assert.strictEqual(parsed.entries.cache_ttl_seconds, "0", "Expected cache_ttl_seconds to be 0");
assert.strictEqual(parsed.entries.client_cache_ttl_sec, "0", "Expected client_cache_ttl_sec to be 0");

// Test Upsell Features Disabled (no paywall triggers)
const upsell = JSON.parse(parsed.entries.upsell_features);
assert.strictEqual(upsell.custom_widget_frames, false, "Expected custom_widget_frames upsell to be false");
assert.strictEqual(upsell.camera_filter_button, false, "Expected camera_filter_button upsell to be false");

// Test Widget Frames & Event
const fg = JSON.parse(parsed.entries.feature_gates);
assert.strictEqual(fg.custom_widget_frames, "enabled", "Expected custom_widget_frames to be enabled in feature_gates");
assert.strictEqual(parsed.entries.custom_widget_frames, "enabled", "Expected custom_widget_frames to be enabled");
assert.strictEqual(parsed.entries.custom_widget_frames_enabled, "true", "Expected custom_widget_frames_enabled to be true");
assert.strictEqual(parsed.entries.ios_widget_frame_event_enabled, "true", "Expected ios_widget_frame_event_enabled to be true");
assert.strictEqual(parsed.entries.widget_frame_event_enabled, "true", "Expected widget_frame_event_enabled to be true");
assert.strictEqual(parsed.entries.android_widget_frame_event_enabled, "true", "Expected android_widget_frame_event_enabled to be true");
assert.strictEqual(parsed.entries.widget_frame_event_max_images, "5", "Expected widget_frame_event_max_images to be 5");

const widgetFrameEvent = JSON.parse(parsed.entries.widget_frame_event);
assert.strictEqual(widgetFrameEvent.uid, "midautumn_2026", "Expected widget frame uid to be midautumn_2026");
assert.strictEqual(widgetFrameEvent.placement, "below", "Expected widget frame placement to be below");
assert(widgetFrameEvent.url, "Expected widget frame url to be present");

// Test Photobooth Root Flags & AI Filter Configuration
assert.strictEqual(parsed.entries.show_filter_button, "true", "Expected show_filter_button to be true");
assert.strictEqual(parsed.entries.show_photobooth_button, "true", "Expected show_photobooth_button to be true");
assert.strictEqual(parsed.entries.camera_filter_button, "true", "Expected camera_filter_button to be true");
assert.strictEqual(parsed.entries.photobooth_enabled, "true", "Expected photobooth_enabled to be true");
assert.strictEqual(parsed.entries.camera_photobooth_enabled, "true", "Expected camera_photobooth_enabled to be true");
assert.strictEqual(parsed.entries.photobooth_camera_enabled, "true", "Expected photobooth_camera_enabled to be true");
assert.strictEqual(parsed.entries.photobooth_mode_enabled, "true", "Expected photobooth_mode_enabled to be true");
assert.strictEqual(parsed.entries.photobooth_stitcher_enabled, "true", "Expected photobooth_stitcher_enabled to be true");
assert.strictEqual(parsed.entries.camera_filter_enabled, "true", "Expected camera_filter_enabled to be true");
assert.strictEqual(parsed.entries.camera_filters_enabled, "true", "Expected camera_filters_enabled to be true");
assert.strictEqual(parsed.entries.filters_enabled, "true", "Expected filters_enabled to be true");
assert.strictEqual(parsed.entries.sheet_filters_selectable, "true", "Expected sheet_filters_selectable to be true");
assert.strictEqual(parsed.entries.has_premium, "true", "Expected has_premium to be true");
assert.strictEqual(parsed.entries.is_premium, "true", "Expected is_premium to be true");

// Test Send to Self & Journal Features
assert.strictEqual(parsed.entries.enable_send_to_self, "true", "Expected enable_send_to_self to be true");
assert.strictEqual(parsed.entries.send_to_self_enabled, "true", "Expected send_to_self_enabled to be true");
assert.strictEqual(parsed.entries.enable_journal, "true", "Expected enable_journal to be true");
assert.strictEqual(parsed.entries.journal_enabled, "true", "Expected journal_enabled to be true");
assert.strictEqual(parsed.entries.history_enabled, "true", "Expected history_enabled to be true");
assert.strictEqual(parsed.entries.albums_enabled, "true", "Expected albums_enabled to be true");
assert.strictEqual(parsed.entries.can_send_to_self, "true", "Expected can_send_to_self to be true");
assert.strictEqual(parsed.entries.allow_send_to_self, "true", "Expected allow_send_to_self to be true");
assert.strictEqual(fg.send_to_self, "enabled", "Expected send_to_self in feature_gates");
assert.strictEqual(fg.journal, "enabled", "Expected journal in feature_gates");

// Test Voice Notes & Audio Messages
assert.strictEqual(parsed.entries.voice_notes_enabled, "true", "Expected voice_notes_enabled to be true");
assert.strictEqual(parsed.entries.audio_notes_enabled, "true", "Expected audio_notes_enabled to be true");
assert.strictEqual(parsed.entries.enable_voice_messages, "true", "Expected enable_voice_messages to be true");
assert.strictEqual(parsed.entries.audio_recording_enabled, "true", "Expected audio_recording_enabled to be true");
assert.strictEqual(parsed.entries.moment_audio_enabled, "true", "Expected moment_audio_enabled to be true");
assert.strictEqual(fg.voice_notes, "enabled", "Expected voice_notes in feature_gates");

assert(parsed.entries.customPhotoboothFilters, "Expected customPhotoboothFilters");
const cpFilters = JSON.parse(parsed.entries.customPhotoboothFilters);
assert(cpFilters.some(f => f.category === "Photobooth"), "Expected Photobooth category filter in customPhotoboothFilters");

assert(parsed.entries.camera_filter_config, "Expected camera_filter_config");
assert(parsed.entries.celebrity_filter_config, "Expected celebrity_filter_config");
const celebCfg = JSON.parse(parsed.entries.celebrity_filter_config);
assert(celebCfg.cameraFilterConfig.pickerFilters.length > 0, "Expected celebrityFilterConfig to contain pickerFilters");
const cfg = JSON.parse(parsed.entries.camera_filter_config);
assert(cfg.remote_filters && cfg.remote_filters.length > 0, "Expected remote photobooth filters");
assert(cfg.picker_filters.length > 0, "Expected picker filters");
assert(cfg.picker_filters.includes("khung_nh_shin_chan_vi_n_m_nh"), "Expected Shin-chan frame in picker filters");
assert(cfg.picker_filters.includes("khung_hello_kitty_pastel_ng_t_ng_o"), "Expected Hello Kitty frame in picker filters");
assert(cfg.picker_filters.includes("photobooth_4cut"), "Expected photobooth_4cut in picker filters");
assert(cfg.picker_filters.includes("pb_holo_4cut"), "Expected pb_holo_4cut in picker filters");
assert(cfg.picker_filters.includes("frame_berry_days"), "Expected frame_berry_days in picker filters");
assert(cfg.picker_filters.includes("cmt_locket"), "Expected cmt_locket in picker filters");

// Test Photobooth 4-cut at the beginning of picker filters (Index 0)
assert.strictEqual(cfg.picker_filters[0], "photobooth_4cut", "Expected photobooth_4cut to be first picker filter");
assert(Array.isArray(cfg.sheet_filters) && cfg.sheet_filters.length === 9, "Expected exactly 9 sheet_filters groups");
assert(Array.isArray(cfg.sheetFilters) && cfg.sheetFilters.length === 9, "Expected exactly 9 sheetFilters groups");
assert(Array.isArray(cfg.filter_groups) && cfg.filter_groups.length === 9, "Expected exactly 9 filter_groups");
assert(Array.isArray(cfg.filterGroups) && cfg.filterGroups.length === 9, "Expected exactly 9 filterGroups");

// Test 60s Recording & Video Upload with Audio
assert.strictEqual(parsed.entries.video_sound_enabled, "true", "Expected video_sound_enabled");
assert.strictEqual(parsed.entries.microphone_enabled, "true", "Expected microphone_enabled");
assert.strictEqual(parsed.entries.camera_microphone_enabled, "true", "Expected camera_microphone_enabled");
assert.strictEqual(parsed.entries.camera_roll_video_sound_enabled, "true", "Expected camera_roll_video_sound_enabled");
assert.strictEqual(parsed.entries.audio_session_deactivation_enabled, "false", "Expected audio_session_deactivation_enabled to be false");
assert.strictEqual(parsed.entries.upload_main, "false", "Expected upload_main to be false");
assert.strictEqual(parsed.entries.video_max_duration, "60.0", "Expected video_max_duration to be 60.0");
assert.strictEqual(parsed.entries.camera_roll_video_max_duration, "60.0", "Expected camera_roll_video_max_duration to be 60.0");
assert.strictEqual(parsed.entries.max_video_duration, "60.0", "Expected max_video_duration to be 60.0");

// Test Captions
assert(parsed.entries.overlay_items, "Expected overlay_items");
assert(parsed.entries.overlay_dynamic_captions, "Expected overlay_dynamic_captions");

// Test Full 117 Filters Registry & Swift Codable Sanitization
assert.strictEqual(cfg.remote_filters.length, 117, "Expected 117 total filters in remote_filters");
assert.strictEqual(cfg.remoteFilters.length, 117, "Expected 117 total filters in remoteFilters");
assert.strictEqual(cfg.filters.length, 117, "Expected 117 total filters in filters");
assert.strictEqual(cfg.picker_filters.length, 81, "Expected 81 filters in picker_filters");
assert.strictEqual(cfg.pickerFilters.length, 81, "Expected 81 filters in pickerFilters");

const uniqueFids = new Set(cfg.remote_filters.map(f => f.id));
assert.strictEqual(uniqueFids.size, 117, "Expected all 117 filters to have unique IDs");

// Validate required fields on every filter
cfg.remote_filters.forEach(f => {
    assert(f.id, "Expected filter to have id: " + JSON.stringify(f));
    assert(f.name, "Expected filter to have name: " + f.id);
    if (f.category !== undefined) {
        assert(["Photobooth", "Frames"].includes(f.category), "Expected category strictly Photobooth or Frames to prevent Swift decode error: " + f.id + " had " + f.category);
    }
    assert(f.style, "Expected filter to have style: " + f.id);
    assert(f.filterType, "Expected filter to have filterType: " + f.id);
    assert(typeof f.overlay === "boolean", "Expected filter overlay to be boolean: " + f.id);
    if (f.tintColor) assert(typeof f.tintColor === "string", "Expected filter tintColor to be string: " + f.id);
    assert(f.colors && f.colors.length >= 1, "Expected filter to have colors array: " + f.id);
    assert(f.icon && (f.icon.url || f.icon.iconUrl || f.icon.remoteImage), "Expected filter to have valid icon asset: " + f.id);
});

// Category-specific schema validation
const pbFilters = cfg.remote_filters.filter(f => f.category === "Photobooth");
assert.strictEqual(pbFilters.length, 10, "Expected exactly 10 Photobooth filters");
pbFilters.forEach(f => {
    assert.strictEqual(f.style, "cutout", "Expected Photobooth filter style to be cutout");
    assert.strictEqual(f.overlay, true, "Expected Photobooth filter overlay to be true");
});

const frameFilters = cfg.remote_filters.filter(f => f.category === "Frames");
assert.strictEqual(frameFilters.length, 18, "Expected exactly 18 Frame filters");
frameFilters.forEach(f => {
    assert.strictEqual(f.style, "cutout", "Expected Frame filter style to be cutout");
    assert.strictEqual(f.overlay, true, "Expected Frame filter overlay to be true");
});

const uncatFilters = cfg.remote_filters.filter(f => f.category === undefined);
assert.strictEqual(uncatFilters.length, 89, "Expected 89 uncategorized filters (Swift nil category)");

// Test Camera Filter Button & Entry Point Regression
assert.strictEqual(cfg.showFilterButton, true, "Expected showFilterButton to be true");
assert.strictEqual(cfg.show_filter_button, true, "Expected show_filter_button to be true");
assert.strictEqual(cfg.sheetEnabled, true, "Expected sheetEnabled to be true");
assert.strictEqual(cfg.sheet_enabled, true, "Expected sheet_enabled to be true");
assert.strictEqual(cfg.openSheetImmediately, false, "Expected openSheetImmediately to be false");
assert.strictEqual(cfg.open_sheet_immediately, false, "Expected open_sheet_immediately to be false");

// Test Celebrity Filter Config Entry Point
assert.strictEqual(celebCfg.cameraFilterConfig.showFilterButton, true, "Expected showFilterButton in celebrity config");
assert.strictEqual(celebCfg.cameraFilterConfig.show_filter_button, true, "Expected show_filter_button in celebrity config");
assert.strictEqual(celebCfg.cameraFilterConfig.pickerFilters.length, 81, "Expected 81 pickerFilters in celebrity config");

// Test Camera Hardware Config Sanitization
const cameraObj = JSON.parse(parsed.entries.camera);
assert.strictEqual(cameraObj.flash_button, true, "Expected flash_button to be true");
assert.strictEqual(cameraObj.max_duration, 60.0, "Expected max_duration to be 60.0");
assert.strictEqual(cameraObj.video_max_duration, 60.0, "Expected video_max_duration to be 60.0");

// Test Payload Size Safety (must remain under 1MB safe processing limit)
const totalPayloadBytes = Buffer.byteLength(capturedDone.body, 'utf8');
assert(totalPayloadBytes < 1048576, `Payload size (${totalPayloadBytes} bytes) must remain under 1MB safe processing limit`);

// Test Firebase Request Header Stripping
const reqScriptPath = path.join(__dirname, '../../shadowrocket/js/locket_firebase_request.js');
const reqScriptCode = fs.readFileSync(reqScriptPath, 'utf8');
let reqCapturedDone = null;
const reqContext = {
    $request: {
        url: "https://firebaseremoteconfig.googleapis.com/v1/projects/locket/namespaces/firebase:fetch",
        headers: {
            "Host": "firebaseremoteconfig.googleapis.com",
            "if-none-match": "W/\"etag123\"",
            "if-modified-since": "Mon, 01 Jan 2026 00:00:00 GMT",
            "x-goog-if-none-match": "W/\"etag123\"",
            "x-firebase-etag": "etag123",
            "etag": "etag123",
            "User-Agent": "Locket/1.144.0"
        }
    },
    $done: (res) => { reqCapturedDone = res; },
    console: console
};
vm.runInNewContext(reqScriptCode, reqContext);
assert(reqCapturedDone, "Expected $done to be called in locket_firebase_request.js");
assert(reqCapturedDone.headers, "Expected modified headers in locket_firebase_request.js");
assert.strictEqual(reqCapturedDone.headers["if-none-match"], undefined, "Expected if-none-match to be stripped");
assert.strictEqual(reqCapturedDone.headers["if-modified-since"], undefined, "Expected if-modified-since to be stripped");
assert.strictEqual(reqCapturedDone.headers["x-goog-if-none-match"], undefined, "Expected x-goog-if-none-match to be stripped");
assert.strictEqual(reqCapturedDone.headers["x-firebase-etag"], undefined, "Expected x-firebase-etag to be stripped");
assert.strictEqual(reqCapturedDone.headers["etag"], undefined, "Expected etag to be stripped");
assert.strictEqual(reqCapturedDone.headers["Cache-Control"], "no-cache, no-store, must-revalidate", "Expected Cache-Control header");
assert.strictEqual(reqCapturedDone.headers["Pragma"], "no-cache", "Expected Pragma header");
assert.strictEqual(reqCapturedDone.headers["Host"], "firebaseremoteconfig.googleapis.com", "Expected Host header preserved");

console.log("Shadowrocket Firebase Filter, Widget Frames & Audio test passed!");
