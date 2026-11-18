package proxy_test

import (
	"bytes"
	"crypto/rand"
	"crypto/rsa"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/base64"
	"encoding/json"
	"encoding/pem"
	"io"
	"math/big"
	"net/http"
	"net/http/httptest"
	"os"
	"strconv"
	"strings"
	"testing"
	"time"

	"locket-proxy/proxy/handler"
	tlspkg "locket-proxy/proxy/tls"
)

func TestCA_LoadAndForge(t *testing.T) {
	crtBytes, err := os.ReadFile("../../ca/root-ca.crt")
	if err != nil {
		t.Fatalf("failed to read test root-ca.crt: %v", err)
	}
	keyBytes, err := os.ReadFile("../../ca/root-ca.key")
	if err != nil {
		t.Skipf("skipping CA forge test: root-ca.key not present (expected in dev environment): %v", err)
	}

	ca, err := tlspkg.LoadCA(crtBytes, keyBytes)
	if err != nil {
		t.Fatalf("LoadCA failed: %v", err)
	}

	cache := tlspkg.NewCertCache(ca)
	host := "firebaseremoteconfig.googleapis.com"

	leaf1, err := cache.GetOrForge(host)
	if err != nil {
		t.Fatalf("GetOrForge failed: %v", err)
	}
	if len(leaf1.Certificate) < 2 {
		t.Fatalf("expected certificate chain with leaf + root, got %d", len(leaf1.Certificate))
	}

	leaf2, err := cache.GetOrForge(host)
	if err != nil {
		t.Fatalf("second GetOrForge failed: %v", err)
	}
	if leaf1 != leaf2 {
		t.Fatalf("expected cached certificate pointer to match")
	}
}

func TestHandler_InjectFirebase(t *testing.T) {
	initial := []byte(`{"entries":{"foo":"bar"},"state":"UPDATE"}`)
	injected, err := handler.InjectFirebase(initial)
	if err != nil {
		t.Fatalf("InjectFirebase returned error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(injected, &parsed); err != nil {
		t.Fatalf("unmarshal modified body failed: %v", err)
	}

	if !strings.Contains(parsed["Attention"].(string), "Locket-XVIP Activated") {
		t.Errorf("Attention header missing, got %v", parsed["Attention"])
	}

	entries := parsed["entries"].(map[string]any)
	if entries["max_friends_count"] != "999999" {
		t.Errorf("expected max_friends_count 999999, got %v", entries["max_friends_count"])
	}

	var camera map[string]any
	if err := json.Unmarshal([]byte(entries["camera"].(string)), &camera); err != nil {
		t.Fatalf("unmarshal camera config failed: %v", err)
	}
	if camera["gold_max_duration"] != 60.0 {
		t.Errorf("expected gold_max_duration 60.0, got %v", camera["gold_max_duration"])
	}

	cfgStr, ok := entries["camera_filter_config"].(string)
	if !ok || cfgStr == "" {
		t.Fatalf("expected non-empty camera_filter_config")
	}
	for _, expectedID := range []string{"khung_nh_shin_chan_vi_n_m_nh", "khung_hello_kitty_pastel_ng_t_ng_o", "photobooth_4cut", "looks_maxxing", "stk_dio_looksmaxing", "stk_rose_flower"} {
		if !strings.Contains(cfgStr, expectedID) {
			t.Errorf("expected camera_filter_config to contain %s", expectedID)
		}
	}

	celebStr, ok := entries["celebrity_filter_config"].(string)
	if !ok || !strings.Contains(celebStr, "celebrityUid") {
		t.Errorf("expected celebrity_filter_config with celebrityUid, got %v", celebStr)
	}
}

func TestHandler_InjectFirebase_SendToSelfAndJournal(t *testing.T) {
	// 1. Prepare upstream response simulating existing user and moment sharing state
	initial := []byte(`{
		"entries": {
			"existing_friend_moments": "active",
			"send_moment_to_friends_enabled": "true",
			"user_session_token": "valid_token_xyz"
		},
		"state": "UPDATE"
	}`)

	injected, err := handler.InjectFirebase(initial)
	if err != nil {
		t.Fatalf("InjectFirebase failed: %v", err)
	}

	// 2. Validate JSON response validity
	var parsed map[string]any
	if err := json.Unmarshal(injected, &parsed); err != nil {
		t.Fatalf("injected response is not valid JSON: %v", err)
	}

	entries, ok := parsed["entries"].(map[string]any)
	if !ok {
		t.Fatalf("entries is missing or not a map in parsed JSON")
	}

	// 3. Verify Send to Self flags exist and have correct type ("true")
	expectedSendToSelfFlags := map[string]string{
		"enable_send_to_self":  "true",
		"send_to_self_enabled": "true",
	}
	for key, expectedVal := range expectedSendToSelfFlags {
		val, exists := entries[key]
		if !exists {
			t.Errorf("expected flag %s to exist in entries", key)
		} else if val != expectedVal {
			t.Errorf("flag %s: expected %s, got %v", key, expectedVal, val)
		}
	}

	// 4. Verify Journal flags exist and have correct type ("true")
	expectedJournalFlags := map[string]string{
		"enable_journal":  "true",
		"journal_enabled": "true",
	}
	for key, expectedVal := range expectedJournalFlags {
		val, exists := entries[key]
		if !exists {
			t.Errorf("expected flag %s to exist in entries", key)
		} else if val != expectedVal {
			t.Errorf("flag %s: expected %s, got %v", key, expectedVal, val)
		}
	}

	// 5. Verify History and Albums flags exist and have correct type ("true")
	expectedHistoryAlbumFlags := map[string]string{
		"history_enabled": "true",
		"albums_enabled":  "true",
	}
	for key, expectedVal := range expectedHistoryAlbumFlags {
		val, exists := entries[key]
		if !exists {
			t.Errorf("expected flag %s to exist in entries", key)
		} else if val != expectedVal {
			t.Errorf("flag %s: expected %s, got %v", key, expectedVal, val)
		}
	}

	// 6. Verify feature_gates contains send_to_self: "enabled" and journal: "enabled"
	fgStr, ok := entries["feature_gates"].(string)
	if !ok || fgStr == "" {
		t.Fatalf("expected non-empty feature_gates string")
	}

	var featureGates map[string]string
	if err := json.Unmarshal([]byte(fgStr), &featureGates); err != nil {
		t.Fatalf("unmarshal feature_gates JSON failed: %v", err)
	}

	if featureGates["send_to_self"] != "enabled" {
		t.Errorf("expected feature_gates.send_to_self = 'enabled', got %v", featureGates["send_to_self"])
	}
	if featureGates["journal"] != "enabled" {
		t.Errorf("expected feature_gates.journal = 'enabled', got %v", featureGates["journal"])
	}

	// 7. Verify existing feature gates are strictly preserved (no deletion/overwrite)
	for _, expectedGate := range []string{
		"app_icon_picker",
		"camera_roll",
		"camera_theme",
		"locket_views",
		"long_captions",
		"longer_video",
		"unlimited_friends",
		"priority_support",
		"profile_badge",
		"remove_ads",
		"video",
		"custom_widget_frames",
		"streak_recovery",
		"longer_videos",
		"longer_camera_roll_videos",
		"camera_roll_video",
		"camera_roll_video_upload",
		"camera_roll_longer_videos",
		"video_trimmer",
		"camera_filter",
		"camera_filters",
		"filters",
		"ai_filters",
		"ai_filter",
		"likeness",
		"ai_likeness",
		"create_likeness",
		"likeness_creation",
		"face_filter",
		"face_filters",
		"ai_styles",
		"ai_style",
		"avatars",
		"avatar",
		"can_record_30s_video",
		"can_upload_30s_video",
		"can_record_60s_video",
		"can_upload_60s_video",
	} {
		if featureGates[expectedGate] != "enabled" {
			t.Errorf("expected existing feature gate %s to remain 'enabled', got %v", expectedGate, featureGates[expectedGate])
		}
	}

	// 8. Verify Moment sharing functions and friend limits are NOT affected
	momentChecks := map[string]string{
		"moment_views_enabled":      "true",
		"record_moment_views":       "true",
		"notify_moment_views":       "true",
		"moment_reactions_v2":       "true",
		"max_friends_count":         "999999",
		"conversations_enabled":     "true",
		"groups_enabled":            "true",
		"chat_reactions_enabled":    "true",
		"typing_indicators_enabled": "true",
	}
	for key, expectedVal := range momentChecks {
		if entries[key] != expectedVal {
			t.Errorf("moment sharing setting %s altered: expected %s, got %v", key, expectedVal, entries[key])
		}
	}

	// 9. Verify upstream entries are NOT erased
	if entries["existing_friend_moments"] != "active" {
		t.Errorf("upstream entry existing_friend_moments was wiped")
	}
	if entries["send_moment_to_friends_enabled"] != "true" {
		t.Errorf("upstream entry send_moment_to_friends_enabled was wiped")
	}
	if entries["user_session_token"] != "valid_token_xyz" {
		t.Errorf("upstream user_session_token was wiped")
	}
}

func TestHandler_InjectRevenueCat(t *testing.T) {
	initial := []byte(`{"subscriber":{"subscriptions":{},"entitlements":{}}}`)
	injected, err := handler.InjectRevenueCat(initial)
	if err != nil {
		t.Fatalf("InjectRevenueCat returned error: %v", err)
	}

	var parsed map[string]any
	if err := json.Unmarshal(injected, &parsed); err != nil {
		t.Fatalf("unmarshal modified body failed: %v", err)
	}

	sub := parsed["subscriber"].(map[string]any)
	ents := sub["entitlements"].(map[string]any)
	if ents["Gold"] == nil {
		t.Errorf("missing Gold entitlement")
	}

	subs := sub["subscriptions"].(map[string]any)
	if subs["locket_1600_1y"] == nil {
		t.Errorf("missing locket_1600_1y subscription")
	}
}

func TestHandler_CleanFilterResponse(t *testing.T) {
	initial := []byte(`{"error":"payment_required","errors":[{"code":402}],"result":{"error":"payment_required","status":402,"outputUrl":"https://example.com/pb.jpg"}}`)
	cleaned := handler.CleanFilterResponse(initial)

	var parsed map[string]any
	if err := json.Unmarshal(cleaned, &parsed); err != nil {
		t.Fatalf("unmarshal cleaned body failed: %v", err)
	}

	if _, exists := parsed["error"]; exists {
		t.Errorf("expected top-level error to be deleted")
	}
	if _, exists := parsed["errors"]; exists {
		t.Errorf("expected top-level errors to be deleted")
	}

	res, ok := parsed["result"].(map[string]any)
	if !ok {
		t.Fatalf("missing result object")
	}
	if _, exists := res["error"]; exists {
		t.Errorf("expected result.error to be deleted")
	}
	if res["status"] != float64(200) && res["status"] != 200 {
		t.Errorf("expected result.status 200, got %v", res["status"])
	}
	if res["outputUrl"] != "https://example.com/pb.jpg" {
		t.Errorf("outputUrl corrupted, got %v", res["outputUrl"])
	}
}

func TestHandler_LocketAPI(t *testing.T) {
	if !handler.IsChangeProfileInfo("/v1/changeProfileInfo") {
		t.Errorf("expected IsChangeProfileInfo to match /v1/changeProfileInfo")
	}

	mockResp := handler.ChangeProfileInfoMockResponse()
	var mockParsed map[string]any
	if err := json.Unmarshal(mockResp, &mockParsed); err != nil {
		t.Fatalf("unmarshal mock response failed: %v", err)
	}
	data := mockParsed["data"].(map[string]any)
	if data["badge"] != "locket_gold" || data["is_gold"] != true {
		t.Errorf("expected badge locket_gold and is_gold true, got %v", data)
	}

	initial := []byte(`{"data":{"uid":"user123","blurred_url":"https://example.com/blur.jpg","unblurred_url":"https://example.com/clear.jpg","is_locked":true}}`)
	modified := handler.RewriteLocketAPI(initial)

	var parsed map[string]any
	if err := json.Unmarshal(modified, &parsed); err != nil {
		t.Fatalf("unmarshal modified API failed: %v", err)
	}
	userData := parsed["data"].(map[string]any)
	if userData["badge"] != "locket_gold" {
		t.Errorf("expected badge locket_gold, got %v", userData["badge"])
	}
	if userData["is_locked"] != false {
		t.Errorf("expected is_locked false, got %v", userData["is_locked"])
	}
	if userData["blurred_url"] != "https://example.com/clear.jpg" {
		t.Errorf("expected blurred_url replaced with unblurred_url, got %v", userData["blurred_url"])
	}
}

func TestHandler_PhotoboothAndOverlayFrames(t *testing.T) {
	reqJSON := []byte(`{"data":{"imageUrl":"https://firebasestorage.googleapis.com/v0/b/locket/pic.jpg","filterId":"khung_nh_shin_chan_vi_n_m_nh"}}`)
	photoURL, filterID := handler.ExtractPhotoURLAndFilterID(reqJSON)
	if photoURL != "https://firebasestorage.googleapis.com/v0/b/locket/pic.jpg" {
		t.Errorf("expected photoURL to be parsed, got %s", photoURL)
	}
	if filterID != "khung_nh_shin_chan_vi_n_m_nh" {
		t.Errorf("expected filterID to be khung_nh_shin_chan_vi_n_m_nh, got %s", filterID)
	}

	if !handler.IsOverlayOrPhotoboothFilter(filterID) {
		t.Errorf("expected khung_nh_shin_chan_vi_n_m_nh to be overlay frame")
	}
	if !handler.IsOverlayOrPhotoboothFilter("photobooth_4cut") {
		t.Errorf("expected photobooth_4cut to be overlay frame")
	}
	if !handler.IsOverlayOrPhotoboothFilter("khung_hello_kitty_pastel_ng_t_ng_o") {
		t.Errorf("expected Hello Kitty to be overlay frame")
	}
	if handler.IsOverlayOrPhotoboothFilter("looks_maxxing") {
		t.Errorf("looks_maxxing should not be overlay frame")
	}

	mockResp := handler.BuildMockFilterResponse(photoURL)
	var parsed map[string]any
	if err := json.Unmarshal(mockResp, &parsed); err != nil {
		t.Fatalf("unmarshal mock filter response failed: %v", err)
	}
	res, ok := parsed["result"].(map[string]any)
	if !ok || res["outputUrl"] != photoURL {
		t.Errorf("expected outputUrl to match photoURL, got %v", res["outputUrl"])
	}
}

// generateEphemeralTestCA creates an in-memory ephemeral self-signed CA cert and RSA key for runtime testing
func generateEphemeralTestCA(t *testing.T) ([]byte, []byte) {
	t.Helper()
	privKey, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatalf("failed to generate ephemeral RSA key: %v", err)
	}

	template := x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject: pkix.Name{
			Organization: []string{"Ephemeral Test CA"},
			CommonName:   "Ephemeral Test Root CA",
		},
		NotBefore:             time.Now().Add(-1 * time.Hour),
		NotAfter:              time.Now().Add(24 * time.Hour),
		KeyUsage:              x509.KeyUsageCertSign | x509.KeyUsageCRLSign,
		BasicConstraintsValid: true,
		IsCA:                  true,
	}

	certDER, err := x509.CreateCertificate(rand.Reader, &template, &template, &privKey.PublicKey, privKey)
	if err != nil {
		t.Fatalf("failed to create ephemeral certificate: %v", err)
	}

	certPEM := pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: certDER})
	keyPEM := pem.EncodeToMemory(&pem.Block{Type: "RSA PRIVATE KEY", Bytes: x509.MarshalPKCS1PrivateKey(privKey)})

	return certPEM, keyPEM
}

func TestCA_LoadAndForge_Ephemeral(t *testing.T) {
	certPEM, keyPEM := generateEphemeralTestCA(t)

	ca, err := tlspkg.LoadCA(certPEM, keyPEM)
	if err != nil {
		t.Fatalf("LoadCA with ephemeral key failed: %v", err)
	}

	cache := tlspkg.NewCertCache(ca)
	host := "firebaseremoteconfig.googleapis.com"

	leaf, err := cache.GetOrForge(host)
	if err != nil {
		t.Fatalf("GetOrForge for %s failed: %v", host, err)
	}

	if len(leaf.Certificate) < 2 {
		t.Fatalf("expected certificate chain length >= 2, got %d", len(leaf.Certificate))
	}
}

func TestRuntime_RemoteConfig_SendToSelf_Roundtrip(t *testing.T) {
	// 1. Upstream simulated Firebase Remote Config server
	upstreamServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json; charset=UTF-8")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte(`{
			"state": "NO_CHANGE",
			"templateVersion": "1732000000000",
			"entries": {
				"app_icon_picker": "enabled",
				"friends_moment_feed": "active",
				"send_to_friends_enabled": "true"
			}
		}`))
	}))
	defer upstreamServer.Close()

	// 2. Simulate the exact Proxy ModifyResponse runtime hook from proxy/main.go
	proxyModifyResponse := func(resp *http.Response) error {
		host := resp.Request.Host
		if strings.Contains(host, "firebaseremoteconfig.googleapis.com") || strings.Contains(host, "127.0.0.1") {
			body, err := io.ReadAll(resp.Body)
			if err != nil {
				return err
			}
			_ = resp.Body.Close()
			modBody, err := handler.InjectFirebase(body)
			if err == nil {
				resp.Body = io.NopCloser(bytes.NewReader(modBody))
				resp.ContentLength = int64(len(modBody))
				resp.Header.Set("Content-Length", strconv.Itoa(len(modBody)))
			} else {
				resp.Body = io.NopCloser(bytes.NewReader(body))
			}
		}
		return nil
	}

	// 3. Send simulated client request through the upstream and apply modify response
	client := upstreamServer.Client()
	req, err := http.NewRequest("GET", upstreamServer.URL, nil)
	if err != nil {
		t.Fatalf("failed to create request: %v", err)
	}
	req.Host = "firebaseremoteconfig.googleapis.com"

	resp, err := client.Do(req)
	if err != nil {
		t.Fatalf("upstream request failed: %v", err)
	}
	defer resp.Body.Close()

	// Apply proxy interception hook
	if err := proxyModifyResponse(resp); err != nil {
		t.Fatalf("proxy modify response returned error: %v", err)
	}

	// 4. Read modified response body
	respBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		t.Fatalf("failed to read response body: %v", err)
	}

	// 5. Parse JSON and verify payload
	var result map[string]any
	if err := json.Unmarshal(respBytes, &result); err != nil {
		t.Fatalf("response is not valid JSON: %v. Raw: %s", err, string(respBytes))
	}

	if result["state"] != "UPDATE" {
		t.Errorf("expected state to be UPDATE, got %v", result["state"])
	}

	entries, ok := result["entries"].(map[string]any)
	if !ok {
		t.Fatalf("entries is not a map: %v", result["entries"])
	}

	// 6. Verify Send to Self / Journal / History / Albums flags
	flagsToCheck := map[string]string{
		"enable_send_to_self":  "true",
		"send_to_self_enabled": "true",
		"enable_journal":       "true",
		"journal_enabled":      "true",
		"history_enabled":      "true",
		"albums_enabled":       "true",
	}

	for flag, expected := range flagsToCheck {
		val, exists := entries[flag]
		if !exists {
			t.Errorf("missing flag %s in runtime response", flag)
		} else if val != expected {
			t.Errorf("flag %s: expected %s, got %v", flag, expected, val)
		}
	}

	// 7. Verify feature_gates contents
	fgStr, ok := entries["feature_gates"].(string)
	if !ok || fgStr == "" {
		t.Fatalf("missing or non-string feature_gates in entries")
	}

	var fg map[string]string
	if err := json.Unmarshal([]byte(fgStr), &fg); err != nil {
		t.Fatalf("failed to unmarshal feature_gates: %v", err)
	}

	if fg["send_to_self"] != "enabled" {
		t.Errorf("expected fg.send_to_self = 'enabled', got %v", fg["send_to_self"])
	}
	if fg["journal"] != "enabled" {
		t.Errorf("expected fg.journal = 'enabled', got %v", fg["journal"])
	}

	// 8. Verify existing feature gates are preserved
	for _, expectedGate := range []string{"camera_roll", "longer_video", "video", "custom_widget_frames", "ai_filters"} {
		if fg[expectedGate] != "enabled" {
			t.Errorf("expected gate %s to be 'enabled', got %v", expectedGate, fg[expectedGate])
		}
	}

	// 9. Verify friend moment sharing is not disrupted
	if entries["friends_moment_feed"] != "active" {
		t.Errorf("upstream friends_moment_feed was wiped")
	}
	if entries["send_to_friends_enabled"] != "true" {
		t.Errorf("upstream send_to_friends_enabled was wiped")
	}
	if entries["max_friends_count"] != "999999" {
		t.Errorf("expected max_friends_count 999999, got %v", entries["max_friends_count"])
	}
}

func TestAIEngine_FilterMapping(t *testing.T) {
	testCases := []struct {
		input    string
		expected string
	}{
		{"beard", "beard"},
		{"stk_dio_bearded", "beard"},
		{"glasses", "glasses"},
		{"sunglasses", "glasses"},
		{"looks_maxxing", "beauty_makeup"},
		{"stk_dio_looksmaxing", "beauty_makeup"},
		{"influencer", "beauty_makeup"},
		{"cutesy", "beauty_makeup"},
		{"disco_lights", "cartoon"},
		{"stk_dio_disco", "cartoon"},
		{"slimed", "cartoon"},
		{"princess", "anime"},
		{"anime_girl", "anime"},
		{"chibi_3d", "chibi_3d"},
		{"happy_birthday", "chibi_3d"},
		{"unknown_filter_id", "beauty_makeup"},
	}

	for _, tc := range testCases {
		res := handler.MapToAIFilterID(tc.input)
		if res != tc.expected {
			t.Errorf("MapToAIFilterID(%q) = %q, expected %q", tc.input, res, tc.expected)
		}
	}
}

func TestAIEngine_StoreAndRetrieveCache(t *testing.T) {
	sessionID := "test_session_12345"
	dummyBytes := []byte("fake_jpeg_binary_content")

	handler.StoreProcessedImage(sessionID, dummyBytes)

	retrieved, ok := handler.GetProcessedImage(sessionID)
	if !ok {
		t.Fatalf("expected session %s to be found in cache", sessionID)
	}
	if !bytes.Equal(retrieved, dummyBytes) {
		t.Errorf("retrieved bytes do not match stored bytes")
	}

	_, ok = handler.GetProcessedImage("non_existent_session")
	if ok {
		t.Errorf("expected non-existent session to return false")
	}
}

func TestAIEngine_BuildAIFilterResponse(t *testing.T) {
	outputURL := "https://us-central1-locket-4252a.cloudfunctions.net/ai-processed/session_abc.jpg"
	filterID := "looks_maxxing"

	respBytes := handler.BuildAIFilterResponse(outputURL, filterID)

	var parsed map[string]any
	if err := json.Unmarshal(respBytes, &parsed); err != nil {
		t.Fatalf("unmarshal BuildAIFilterResponse failed: %v", err)
	}

	if parsed["status"] != float64(200) && parsed["status"] != 200 {
		t.Errorf("expected status 200, got %v", parsed["status"])
	}
	if parsed["success"] != true {
		t.Errorf("expected success true, got %v", parsed["success"])
	}
	if parsed["outputUrl"] != outputURL {
		t.Errorf("expected root outputUrl %s, got %v", outputURL, parsed["outputUrl"])
	}

	res, ok := parsed["result"].(map[string]any)
	if !ok || res["outputUrl"] != outputURL {
		t.Errorf("expected result.outputUrl %s, got %v", outputURL, res["outputUrl"])
	}

	data, ok := res["data"].(map[string]any)
	if !ok || data["outputUrl"] != outputURL {
		t.Errorf("expected result.data.outputUrl %s, got %v", outputURL, data["outputUrl"])
	}
}

func TestAIEngine_ProcessWithAIEngine_MockIntegration(t *testing.T) {
	// 1. Mock photo download server (simulates Google Cloud Storage)
	photoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write([]byte("mock_raw_photo_bytes_from_storage"))
	}))
	defer photoServer.Close()

	// 2. Mock AI Engine server (simulates FastAPI backend)
	dummyJPEG := []byte("processed_filtered_jpeg_bytes_here")
	dummyB64 := "data:image/jpeg;base64," + strings.TrimSpace(string(base64.StdEncoding.EncodeToString(dummyJPEG)))

	aiEngineServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/filters/process" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusOK)
		respJSON := map[string]any{
			"status":       "success",
			"session_id":   "mock_session_uuid",
			"filter_id":    "beauty_makeup",
			"output_image": dummyB64,
		}
		_ = json.NewEncoder(w).Encode(respJSON)
	}))
	defer aiEngineServer.Close()

	// 3. Execute ProcessWithAIEngine
	sessionID, outBytes, err := handler.ProcessWithAIEngine(aiEngineServer.URL, photoServer.URL, "looks_maxxing")
	if err != nil {
		t.Fatalf("ProcessWithAIEngine failed: %v", err)
	}

	if sessionID == "" {
		t.Errorf("expected non-empty sessionID")
	}
	if !bytes.Equal(outBytes, dummyJPEG) {
		t.Errorf("processed bytes mismatch: got %s, expected %s", string(outBytes), string(dummyJPEG))
	}

	// 4. Verify image is retrievable from cache
	cached, ok := handler.GetProcessedImage(sessionID)
	if !ok || !bytes.Equal(cached, dummyJPEG) {
		t.Errorf("cached image does not match output bytes")
	}
}

func TestAIEngine_SessionIDValidation(t *testing.T) {
	validIDs := []string{
		"12345678",
		"abcdef0123456789",
		"0123456789abcdef0123456789abcdef",
	}
	for _, id := range validIDs {
		if !handler.IsValidSessionID(id) {
			t.Errorf("expected %s to be valid session ID", id)
		}
	}

	invalidIDs := []string{
		"",
		"short",
		"../../etc/passwd",
		"session;rm -rf /",
		"hello_world!",
		"1234567z", // 'z' is not hex
	}
	for _, id := range invalidIDs {
		if handler.IsValidSessionID(id) {
			t.Errorf("expected %s to be invalid session ID", id)
		}
	}
}

func TestAIEngine_CacheTTLAndExpiration(t *testing.T) {
	handler.ClearCache()
	defer handler.ClearCache()

	sessionID := "deadbeef12345678"
	data := []byte("test_jpeg_bytes_for_ttl")

	// Store with 50ms TTL
	handler.StoreProcessedImageWithTTL(sessionID, data, "glasses", 50*time.Millisecond)

	// Immediate lookup -> Hit
	retrieved, status := handler.GetProcessedImageWithStatus(sessionID)
	if status != handler.CacheStatusHit {
		t.Fatalf("expected CacheStatusHit, got %v", status)
	}
	if !bytes.Equal(retrieved, data) {
		t.Fatalf("retrieved bytes mismatch")
	}

	// Sleep past TTL
	time.Sleep(70 * time.Millisecond)

	// Next lookup -> Expired (and auto-pruned)
	_, statusAfter := handler.GetProcessedImageWithStatus(sessionID)
	if statusAfter != handler.CacheStatusExpired {
		t.Fatalf("expected CacheStatusExpired, got %v", statusAfter)
	}

	// Further lookup -> Miss
	_, statusMiss := handler.GetProcessedImageWithStatus(sessionID)
	if statusMiss != handler.CacheStatusMiss {
		t.Fatalf("expected CacheStatusMiss, got %v", statusMiss)
	}
}

func TestAIEngine_CacheEvictionAndPruning(t *testing.T) {
	handler.ClearCache()
	defer handler.ClearCache()

	// Fill cache past MaxCacheEntries (100)
	for i := 0; i < 110; i++ {
		idHex := hexString(i)
		handler.StoreProcessedImage(idHex, []byte("image_data_"+strconv.Itoa(i)))
	}

	count, bytesCount := handler.GetCacheStats()
	if count > handler.MaxCacheEntries {
		t.Errorf("expected max %d items, got %d", handler.MaxCacheEntries, count)
	}
	if bytesCount > handler.MaxCacheBytes {
		t.Errorf("expected max %d bytes, got %d", handler.MaxCacheBytes, bytesCount)
	}

	// Oldest entries (e.g., index 0..9) should have been evicted
	firstHex := hexString(0)
	_, ok := handler.GetProcessedImage(firstHex)
	if ok {
		t.Errorf("expected oldest item %s to be evicted", firstHex)
	}

	// Newest entries (e.g. index 109) should still exist
	lastHex := hexString(109)
	_, ok = handler.GetProcessedImage(lastHex)
	if !ok {
		t.Errorf("expected newest item %s to exist in cache", lastHex)
	}
}

func hexString(i int) string {
	raw := strconv.Itoa(10000000 + i)
	return raw + raw // 16-char hex-like string
}

func TestAIEngine_BuildAIFilterErrorResponse(t *testing.T) {
	filterID := "glasses"
	errMsg := "model inference timeout after 15s"
	respBytes := handler.BuildAIFilterErrorResponse(filterID, errMsg, http.StatusBadGateway)

	var parsed map[string]any
	if err := json.Unmarshal(respBytes, &parsed); err != nil {
		t.Fatalf("unmarshal error response failed: %v", err)
	}

	if parsed["status"] != float64(502) {
		t.Errorf("expected status 502, got %v", parsed["status"])
	}
	if parsed["success"] != false {
		t.Errorf("expected success false, got %v", parsed["success"])
	}
	if parsed["filterStatus"] != handler.StatusFilterFailed {
		t.Errorf("expected filterStatus %s, got %v", handler.StatusFilterFailed, parsed["filterStatus"])
	}

	errMap, ok := parsed["error"].(map[string]any)
	if !ok || errMap["code"] != handler.StatusFilterFailed || errMap["message"] != errMsg {
		t.Errorf("error details mismatch: got %v", errMap)
	}
}

func TestAIEngine_BuildFallbackResponse(t *testing.T) {
	outputURL := "https://example.com/fallback.jpg"
	filterID := "chibi_3d"
	reason := "offline filter transformation applied"
	respBytes := handler.BuildFallbackResponse(outputURL, filterID, reason)

	var parsed map[string]any
	if err := json.Unmarshal(respBytes, &parsed); err != nil {
		t.Fatalf("unmarshal fallback response failed: %v", err)
	}

	if parsed["status"] != float64(200) {
		t.Errorf("expected status 200, got %v", parsed["status"])
	}
	if parsed["success"] != true {
		t.Errorf("expected success true, got %v", parsed["success"])
	}
	if parsed["filterStatus"] != handler.StatusFallbackApplied {
		t.Errorf("expected filterStatus %s, got %v", handler.StatusFallbackApplied, parsed["filterStatus"])
	}
	if parsed["fallbackReason"] != reason {
		t.Errorf("expected fallbackReason %s, got %v", reason, parsed["fallbackReason"])
	}
}

func TestProxy_ServeAIProcessedImage_Delivery(t *testing.T) {
	handler.ClearCache()
	defer handler.ClearCache()

	sessionID := "c0ffee0123456789"
	imgBytes := []byte("fake_jpeg_header_and_pixels_here")

	// 1. Valid cached image
	handler.StoreProcessedImageWithTTL(sessionID, imgBytes, "glasses", 10*time.Minute)

	req := httptest.NewRequest("GET", "/ai-processed/"+sessionID+".jpg", nil)
	rec := httptest.NewRecorder()
	handled := handler.ServeAIProcessedImage(rec, req)

	if !handled {
		t.Fatalf("expected request to be handled")
	}
	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200, got %d", rec.Code)
	}
	if ct := rec.Header().Get("Content-Type"); ct != "image/jpeg" {
		t.Errorf("expected Content-Type image/jpeg, got %s", ct)
	}
	if !bytes.Equal(rec.Body.Bytes(), imgBytes) {
		t.Errorf("delivered image bytes do not match cached bytes")
	}

	// 2. Non-existent session -> 404
	req404 := httptest.NewRequest("GET", "/ai-processed/0000000000000000.jpg", nil)
	rec404 := httptest.NewRecorder()
	handler.ServeAIProcessedImage(rec404, req404)
	if rec404.Code != http.StatusNotFound {
		t.Errorf("expected HTTP 404 for unknown session, got %d", rec404.Code)
	}

	// 3. Invalid session ID format -> 404
	reqInvalid := httptest.NewRequest("GET", "/ai-processed/../../etc/passwd.jpg", nil)
	recInvalid := httptest.NewRecorder()
	handler.ServeAIProcessedImage(recInvalid, reqInvalid)
	if recInvalid.Code != http.StatusNotFound {
		t.Errorf("expected HTTP 404 for invalid session ID, got %d", recInvalid.Code)
	}

	// 4. Expired session -> 410 Gone
	expiredID := "ee00112233445566"
	handler.StoreProcessedImageWithTTL(expiredID, imgBytes, "glasses", 10*time.Millisecond)
	time.Sleep(20 * time.Millisecond)

	req410 := httptest.NewRequest("GET", "/ai-processed/"+expiredID+".jpg", nil)
	rec410 := httptest.NewRecorder()
	handler.ServeAIProcessedImage(rec410, req410)
	if rec410.Code != http.StatusGone {
		t.Errorf("expected HTTP 410 Gone for expired session, got %d", rec410.Code)
	}
}

func TestProxy_HandleGenerateFilteredImage_FailureSemantics(t *testing.T) {
	// Simulate AI filter request pointing to unreachable AI Engine
	payload := `{"imageUrl":"https://storage.googleapis.com/test.jpg","filterId":"looks_maxxing"}`
	req := httptest.NewRequest("POST", "/generateFilteredImage", strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handled := handler.HandleGenerateFilteredImage(rec, req, "http://127.0.0.1:59999") // unreachable port
	if !handled {
		t.Fatalf("expected request to be handled")
	}

	// CRITICAL TEST: Must NOT return HTTP 200 with original photo!
	if rec.Code != http.StatusBadGateway {
		t.Errorf("expected HTTP 502 Bad Gateway on AI engine failure, got %d (MUST NOT return HTTP 200)", rec.Code)
	}

	var parsed map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("unmarshal error response failed: %v", err)
	}

	if parsed["filterStatus"] != handler.StatusFilterFailed {
		t.Errorf("expected filterStatus FILTER_FAILED, got %v", parsed["filterStatus"])
	}
	if parsed["success"] != false {
		t.Errorf("expected success false, got %v", parsed["success"])
	}
}

func TestProxy_HandleGenerateFilteredImage_OverlayFrames(t *testing.T) {
	// Client frames (e.g. photobooth or Shin-chan) should return HTTP 200 with photoURL
	// because frames are rendered natively by Locket's GPU shaders over the photo
	photoURL := "https://storage.googleapis.com/test_frame.jpg"
	payload := `{"imageUrl":"` + photoURL + `","filterId":"khung_nh_shin_chan_vi_n_m_nh"}`
	req := httptest.NewRequest("POST", "/generateFilteredImage", strings.NewReader(payload))
	req.Header.Set("Content-Type", "application/json")
	rec := httptest.NewRecorder()

	handled := handler.HandleGenerateFilteredImage(rec, req, "http://127.0.0.1:8000")
	if !handled {
		t.Fatalf("expected request to be handled")
	}

	if rec.Code != http.StatusOK {
		t.Errorf("expected HTTP 200 for overlay frame, got %d", rec.Code)
	}

	var parsed map[string]any
	if err := json.Unmarshal(rec.Body.Bytes(), &parsed); err != nil {
		t.Fatalf("unmarshal overlay response failed: %v", err)
	}

	res, ok := parsed["result"].(map[string]any)
	if !ok || res["outputUrl"] != photoURL {
		t.Errorf("expected overlay outputUrl to match original photoURL %s, got %v", photoURL, res["outputUrl"])
	}
}
