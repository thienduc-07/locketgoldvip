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
assert(celebCfg.cameraFilterConfig.filterGroups.length > 0, "Expected celebrityFilterConfig to contain filterGroups");
const cfg = JSON.parse(parsed.entries.camera_filter_config);
assert(cfg.sheet_filters.some(f => f.id === "group_hot_ai_3d" || (f.title && f.title.vi && f.title.vi.includes("AI 3D"))), "Expected AI 3D filter group");
assert(cfg.sheet_filters.some(f => f.id === "group_photobooth" || (f.title && f.title.vi && f.title.vi.includes("Photobooth"))), "Expected Photobooth filter group");
assert(cfg.sheet_filters.some(f => f.id === "group_frames" || (f.title && f.title.vi && f.title.vi.includes("Khung Viền"))), "Expected Khung Viền filter group");
assert(cfg.remote_filters && cfg.remote_filters.length > 0, "Expected remote photobooth filters");
assert(cfg.picker_filters.length > 0, "Expected picker filters");
assert(cfg.picker_filters.includes("khung_nh_shin_chan_vi_n_m_nh"), "Expected Shin-chan frame in picker filters");
assert(cfg.picker_filters.includes("khung_hello_kitty_pastel_ng_t_ng_o"), "Expected Hello Kitty frame in picker filters");
assert(cfg.picker_filters.includes("photobooth_4cut"), "Expected photobooth_4cut in picker filters");
assert(cfg.picker_filters.includes("looks_maxxing"), "Expected looks_maxxing in picker filters");
assert(cfg.picker_filters.includes("influencer"), "Expected influencer in picker filters");
assert(cfg.picker_filters.includes("disco_lights"), "Expected disco_lights in picker filters");
assert(cfg.picker_filters.includes("beard"), "Expected beard in picker filters");
assert(cfg.picker_filters.includes("slimed"), "Expected slimed in picker filters");

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

// Test Group A: Filter Registry & Schema Validation
assert.strictEqual(cfg.remote_filters.length, 117, "Expected all 117 filters in remote_filters");
const uniqueFids = new Set(cfg.remote_filters.map(f => f.id));
assert.strictEqual(uniqueFids.size, 117, "Expected all 117 filters to have unique IDs");

// Validate required fields on every filter
cfg.remote_filters.forEach(f => {
    assert(f.id, "Expected filter to have id");
    assert(f.name, "Expected filter to have name");
    assert(f.category, "Expected filter to have category: " + f.id);
    assert(f.style, "Expected filter to have style: " + f.id);
    assert(f.filterType, "Expected filter to have filterType: " + f.id);
    assert(typeof f.overlay === "boolean", "Expected filter overlay to be boolean: " + f.id);
    assert(f.tintColor, "Expected filter to have tintColor: " + f.id);
    assert(f.colors && f.colors.length >= 1, "Expected filter to have colors array: " + f.id);
    assert(f.icon && (f.icon.url || f.icon.iconUrl), "Expected filter to have valid icon asset: " + f.id);
});

// Category-specific schema validation
const pbFilters = cfg.remote_filters.filter(f => f.category === "Photobooth");
assert.strictEqual(pbFilters.length, 10, "Expected 10 Photobooth filters");
pbFilters.forEach(f => {
    assert.strictEqual(f.style, "cutout", "Expected Photobooth filter style to be cutout");
    assert.strictEqual(f.overlay, true, "Expected Photobooth filter overlay to be true");
    assert.strictEqual(f.filterType, "cutout", "Expected Photobooth filterType to be cutout");
});

const frameFilters = cfg.remote_filters.filter(f => f.category === "Frames");
assert.strictEqual(frameFilters.length, 18, "Expected 18 Frame filters");
frameFilters.forEach(f => {
    assert.strictEqual(f.style, "cutout", "Expected Frame filter style to be cutout");
    assert.strictEqual(f.overlay, true, "Expected Frame filter overlay to be true");
});

const lookFilters = cfg.remote_filters.filter(f => f.category === "Looks");
assert.strictEqual(lookFilters.length, 24, "Expected 24 Look filters");
lookFilters.forEach(f => {
    assert.strictEqual(f.style, "normal", "Expected Look filter style to be normal");
    assert.strictEqual(f.overlay, false, "Expected Look filter overlay to be false");
});

// Test Camera Filter Button & Entry Point Regression
assert.strictEqual(cfg.showFilterButton, true, "Expected showFilterButton to be true");
assert.strictEqual(cfg.show_filter_button, true, "Expected show_filter_button to be true");
assert.strictEqual(cfg.sheetEnabled, true, "Expected sheetEnabled to be true");
assert.strictEqual(cfg.sheet_enabled, true, "Expected sheet_enabled to be true");
assert.strictEqual(cfg.openSheetImmediately, false, "Expected openSheetImmediately to be false");
assert.strictEqual(cfg.open_sheet_immediately, false, "Expected open_sheet_immediately to be false");
assert.strictEqual(cfg.filters.length, 117, "Expected filters array to contain 117 items");
assert.strictEqual(cfg.remoteFilters.length, 117, "Expected remoteFilters array to contain 117 items");
assert.strictEqual(cfg.remote_filters.length, 117, "Expected remote_filters array to contain 117 items");

// Test Celebrity Filter Config Entry Point
assert.strictEqual(celebCfg.cameraFilterConfig.showFilterButton, true, "Expected showFilterButton in celebrity config");
assert.strictEqual(celebCfg.cameraFilterConfig.show_filter_button, true, "Expected show_filter_button in celebrity config");
assert.strictEqual(celebCfg.cameraFilterConfig.pickerFilters.length, 81, "Expected pickerFilters in celebrity config");
assert.strictEqual(celebCfg.cameraFilterConfig.filterGroups.length, 9, "Expected 9 filter groups in celebrity config");

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
