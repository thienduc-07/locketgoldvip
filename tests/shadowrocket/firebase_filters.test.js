const fs = require('fs');
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

// Test Upsell Features Enabled for Gold features
const upsell = JSON.parse(parsed.entries.upsell_features);
assert.strictEqual(upsell.custom_widget_frames, true, "Expected custom_widget_frames upsell to be true");

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

// Test Photobooth & AI Filter Configuration (RealTrueHieu & Hakaiz V2 baseline)
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

// Test Photobooth at the beginning of picker filters
assert.strictEqual(cfg.picker_filters[0], "photobooth_4cut", "Expected photobooth_4cut to be first picker filter");

// Test 30s Recording & Video Upload with Audio
assert.strictEqual(parsed.entries.video_sound_enabled, "true", "Expected video_sound_enabled");
assert.strictEqual(parsed.entries.microphone_enabled, "true", "Expected microphone_enabled");
assert.strictEqual(parsed.entries.camera_microphone_enabled, "true", "Expected camera_microphone_enabled");
assert.strictEqual(parsed.entries.camera_roll_video_sound_enabled, "true", "Expected camera_roll_video_sound_enabled");
assert.strictEqual(parsed.entries.audio_session_deactivation_enabled, "false", "Expected audio_session_deactivation_enabled to be false");
assert.strictEqual(parsed.entries.upload_main, "false", "Expected upload_main to be false");
assert.strictEqual(parsed.entries.video_max_duration, "60.0", "Expected video_max_duration to be 60.0");
assert.strictEqual(parsed.entries.camera_roll_video_max_duration, "60.0", "Expected camera_roll_video_max_duration to be 60.0");

// Test Captions
assert(parsed.entries.overlay_items, "Expected overlay_items");
assert(parsed.entries.overlay_dynamic_captions, "Expected overlay_dynamic_captions");

// Test Group A: Filter Registry & Schema Validation (28 Offline Photobooth & Frame Filters)
assert.strictEqual(cfg.remote_filters.length, 28, "Expected 28 offline filters in remote_filters");
const uniqueFids = new Set(cfg.remote_filters.map(f => f.id));
assert.strictEqual(uniqueFids.size, 28, "Expected 28 filters to have unique IDs");

// Validate required fields on every filter
cfg.remote_filters.forEach(f => {
    assert(f.id, "Expected filter to have id");
    assert(f.name, "Expected filter to have name");
    if (f.category) assert(["Photobooth", "Frames"].includes(f.category), "Expected valid category if defined: " + f.id);
    assert(f.style, "Expected filter to have style: " + f.id);
    assert(f.filterType, "Expected filter to have filterType: " + f.id);
    assert(typeof f.overlay === "boolean", "Expected filter overlay to be boolean: " + f.id);
    if (f.tintColor) assert(typeof f.tintColor === "string", "Expected filter tintColor to be string: " + f.id);
    assert(f.colors && f.colors.length >= 1, "Expected filter to have colors array: " + f.id);
    assert(f.icon && (f.icon.url || f.icon.iconUrl), "Expected filter to have valid icon asset: " + f.id);
});

// Category-specific schema validation
const pbFilters = cfg.remote_filters.filter(f => f.category === "Photobooth");
assert.strictEqual(pbFilters.length, 10, "Expected 10 Photobooth filters");
pbFilters.forEach(f => {
    assert.strictEqual(f.style, "cutout", "Expected Photobooth filter style to be cutout");
    assert.strictEqual(f.overlay, true, "Expected Photobooth filter overlay to be true");
});

const frameFilters = cfg.remote_filters.filter(f => f.category === "Frames");
assert.strictEqual(frameFilters.length, 17, "Expected 17 Frame filters");
frameFilters.forEach(f => {
    assert.strictEqual(f.style, "cutout", "Expected Frame filter style to be cutout");
    assert.strictEqual(f.overlay, true, "Expected Frame filter overlay to be true");
});

// Non-frame / sticker filter has omitted category (decoded as nil Optional)
const nilCategoryFilters = cfg.remote_filters.filter(f => !f.category);
assert.strictEqual(nilCategoryFilters.length, 1, "Expected 1 filter with nil/omitted category (stk_dio_pm2)");
assert.strictEqual(nilCategoryFilters[0].id, "stk_dio_pm2");

// Test Camera Filter Button & Entry Point Regression
assert.strictEqual(cfg.showFilterButton, true, "Expected showFilterButton to be true");
assert.strictEqual(cfg.show_filter_button, true, "Expected show_filter_button to be true");
assert.strictEqual(cfg.sheetEnabled, true, "Expected sheetEnabled to be true");
assert.strictEqual(cfg.sheet_enabled, true, "Expected sheet_enabled to be true");
assert.strictEqual(cfg.openSheetImmediately, false, "Expected openSheetImmediately to be false");
assert.strictEqual(cfg.open_sheet_immediately, false, "Expected open_sheet_immediately to be false");
assert.strictEqual(cfg.filters.length, 28, "Expected filters array to contain 28 items");
assert.strictEqual(cfg.remoteFilters.length, 28, "Expected remoteFilters array to contain 28 items");
assert.strictEqual(cfg.remote_filters.length, 28, "Expected remote_filters array to contain 28 items");

// Test Celebrity Filter Config Entry Point
assert.strictEqual(celebCfg.cameraFilterConfig.showFilterButton, true, "Expected showFilterButton in celebrity config");
assert.strictEqual(celebCfg.cameraFilterConfig.show_filter_button, true, "Expected show_filter_button in celebrity config");
assert.strictEqual(celebCfg.cameraFilterConfig.pickerFilters.length, 28, "Expected 28 pickerFilters in celebrity config");
assert.strictEqual(celebCfg.cameraFilterConfig.filterGroups, undefined, "filterGroups must be undefined (removed per Task 1)");

// Test Camera Hardware Config Sanitization (preventing strict Decodable failure)
const cameraObj = JSON.parse(parsed.entries.camera);
assert.strictEqual(cameraObj.flash_button, true, "Expected flash_button to be true");
assert.strictEqual(cameraObj.filter_button, undefined, "Extraneous filter_button must not exist in camera");
assert.strictEqual(cameraObj.photobooth_button, undefined, "Extraneous photobooth_button must not exist in camera");
assert.strictEqual(cameraObj.photobooth, undefined, "Extraneous photobooth must not exist in camera");

// Test Payload Size Safety (must remain under 1MB Shadowrocket limit)
const totalPayloadBytes = Buffer.byteLength(capturedDone.body, 'utf8');
assert(totalPayloadBytes < 1048576, `Payload size (${totalPayloadBytes} bytes) must remain under 1MB safe processing limit`);

console.log("Shadowrocket Firebase Filter, Widget Frames & Audio test passed!");
