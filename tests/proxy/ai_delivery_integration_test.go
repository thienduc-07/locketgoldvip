package proxy_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	_ "image/jpeg"
	"image/jpeg"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"locket-proxy/proxy/handler"
)

// generateSyntheticPortrait creates a 200x200 JPEG portrait with facial features for testing
func generateSyntheticPortrait() []byte {
	img := image.NewRGBA(image.Rect(0, 0, 200, 200))
	// Fill background (light gray)
	for y := 0; y < 200; y++ {
		for x := 0; x < 200; x++ {
			img.Set(x, y, color.RGBA{R: 220, G: 225, B: 230, A: 255})
		}
	}
	// Face oval (skin tone)
	for y := 40; y < 160; y++ {
		for x := 50; x < 150; x++ {
			dx := float64(x - 100) / 50.0
			dy := float64(y - 100) / 60.0
			if dx*dx+dy*dy <= 1.0 {
				img.Set(x, y, color.RGBA{R: 232, G: 185, B: 154, A: 255})
			}
		}
	}
	// Eyes (dark)
	for y := 85; y < 95; y++ {
		for x := 75; x < 85; x++ {
			img.Set(x, y, color.RGBA{R: 50, G: 40, B: 35, A: 255})
		}
		for x := 115; x < 125; x++ {
			img.Set(x, y, color.RGBA{R: 50, G: 40, B: 35, A: 255})
		}
	}
	// Mouth (pink)
	for y := 125; y < 135; y++ {
		for x := 85; x < 115; x++ {
			img.Set(x, y, color.RGBA{R: 205, G: 95, B: 105, A: 255})
		}
	}

	var buf bytes.Buffer
	_ = jpeg.Encode(&buf, img, &jpeg.Options{Quality: 95})
	return buf.Bytes()
}

// computeMAE calculates the Mean Absolute Error between two decoded images
func computeMAE(imgA, imgB image.Image) (float64, error) {
	boundsA := imgA.Bounds()
	boundsB := imgB.Bounds()

	if boundsA.Dx() != boundsB.Dx() || boundsA.Dy() != boundsB.Dy() {
		return 0, fmt.Errorf("dimensions mismatch: %dx%d vs %dx%d", boundsA.Dx(), boundsA.Dy(), boundsB.Dx(), boundsB.Dy())
	}

	var totalDiff float64
	w, h := boundsA.Dx(), boundsA.Dy()

	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			r1, g1, b1, _ := imgA.At(x, y).RGBA()
			r2, g2, b2, _ := imgB.At(x, y).RGBA()

			dr := math.Abs(float64(r1>>8) - float64(r2>>8))
			dg := math.Abs(float64(g1>>8) - float64(g2>>8))
			db := math.Abs(float64(b1>>8) - float64(b2>>8))

			totalDiff += (dr + dg + db) / 3.0
		}
	}

	return totalDiff / float64(w*h), nil
}

func TestIntegrity_EndToEnd_AIDelivery(t *testing.T) {
	// 1. Launch FastAPI AI Engine in background on port 8011
	absAIEngineDir, err := filepath.Abs("../../ai-engine")
	if err != nil {
		t.Fatalf("failed to resolve ai-engine dir: %v", err)
	}
	uvicornPath := filepath.Join(absAIEngineDir, ".venv", "bin", "uvicorn")
	cmd := exec.Command(uvicornPath, "app.main:app", "--host", "127.0.0.1", "--port", "8011")
	cmd.Dir = absAIEngineDir
	if err := cmd.Start(); err != nil {
		t.Fatalf("failed to start AI Engine via uvicorn: %v", err)
	}
	defer func() {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
	}()

	// Wait for AI Engine to become healthy
	aiEngineURL := "http://127.0.0.1:8011"
	healthOK := false
	for attempt := 0; attempt < 30; attempt++ {
		time.Sleep(200 * time.Millisecond)
		resp, err := http.Get(aiEngineURL + "/health")
		if err == nil && resp.StatusCode == http.StatusOK {
			healthOK = true
			resp.Body.Close()
			break
		}
		if resp != nil {
			resp.Body.Close()
		}
	}
	if !healthOK {
		t.Fatalf("AI Engine failed to become healthy on port 8011 within 6 seconds")
	}

	// 2. Mock Photo Storage Server (simulates GCS hosting user photo)
	portraitBytes := generateSyntheticPortrait()
	origImg, _, err := image.Decode(bytes.NewReader(portraitBytes))
	if err != nil {
		t.Fatalf("failed to decode synthetic portrait: %v", err)
	}

	photoServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "image/jpeg")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(portraitBytes)
	}))
	defer photoServer.Close()

	// 3. Setup Go Proxy Server with production routing logic
	proxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if handler.ServeAIProcessedImage(w, r) {
			return
		}
		if handler.HandleGenerateFilteredImage(w, r, aiEngineURL) {
			return
		}
		http.NotFound(w, r)
	}))
	defer proxyServer.Close()

	// 4. Test all 6 AI Filters through full roundtrip
	testFilters := []struct {
		locketID     string
		mappedFilter string
	}{
		{"glasses", "glasses"},
		{"beard", "beard"},
		{"looks_maxxing", "beauty_makeup"},
		{"cartoon", "cartoon"},
		{"anime", "anime"},
		{"chibi_3d", "chibi_3d"},
	}

	for _, tf := range testFilters {
		t.Run("Filter_"+tf.locketID, func(t *testing.T) {
			startTime := time.Now()

			// A. Client sends generateFilteredImage to Proxy
			reqBody := fmt.Sprintf(`{"imageUrl":"%s","filterId":"%s"}`, photoServer.URL, tf.locketID)
			postReq, err := http.NewRequest("POST", proxyServer.URL+"/generateFilteredImage", strings.NewReader(reqBody))
			if err != nil {
				t.Fatalf("failed to create POST request: %v", err)
			}
			postReq.Header.Set("Content-Type", "application/json")
			postReq.Host = "us-central1-locket-4252a.cloudfunctions.net"

			postResp, err := http.DefaultClient.Do(postReq)
			if err != nil {
				t.Fatalf("POST /generateFilteredImage failed: %v", err)
			}
			defer postResp.Body.Close()

			latency := time.Since(startTime)

			if postResp.StatusCode != http.StatusOK {
				body, _ := io.ReadAll(postResp.Body)
				t.Fatalf("expected HTTP 200, got %d: %s", postResp.StatusCode, string(body))
			}

			var result map[string]any
			if err := json.NewDecoder(postResp.Body).Decode(&result); err != nil {
				t.Fatalf("failed to parse JSON response: %v", err)
			}

			// Verify status flags
			if result["filterStatus"] != handler.StatusFilterApplied {
				t.Errorf("expected filterStatus %s, got %v", handler.StatusFilterApplied, result["filterStatus"])
			}
			outputURL, ok := result["outputUrl"].(string)
			if !ok || outputURL == "" {
				t.Fatalf("outputUrl is missing or empty: %v", result)
			}

			// B. Client downloads processed image from outputUrl via Proxy
			// Rewrite host to proxyServer for local testing
			pathPart := outputURL[strings.Index(outputURL, "/ai-processed/"):]
			fetchURL := proxyServer.URL + pathPart

			getStart := time.Now()
			getResp, err := http.Get(fetchURL)
			if err != nil {
				t.Fatalf("GET %s failed: %v", fetchURL, err)
			}
			defer getResp.Body.Close()
			getLatency := time.Since(getStart)

			if getResp.StatusCode != http.StatusOK {
				t.Fatalf("expected GET HTTP 200, got %d", getResp.StatusCode)
			}

			ct := getResp.Header.Get("Content-Type")
			if ct != "image/jpeg" {
				t.Errorf("expected Content-Type image/jpeg, got %s", ct)
			}

			processedBytes, err := io.ReadAll(getResp.Body)
			if err != nil {
				t.Fatalf("failed to read processed image: %v", err)
			}

			if len(processedBytes) == 0 {
				t.Fatalf("processed image is 0 bytes")
			}

			// C. Decode and verify byte-level & visual changes
			procImg, _, err := image.Decode(bytes.NewReader(processedBytes))
			if err != nil {
				t.Fatalf("failed to decode processed image: %v", err)
			}

			mae, err := computeMAE(origImg, procImg)
			if err != nil {
				t.Fatalf("failed to compute MAE: %v", err)
			}

			if mae <= 0.5 {
				t.Errorf("filter %s did not modify pixels (MAE = %f <= 0.5)", tf.locketID, mae)
			}

			t.Logf("[PASS] Filter: %-14s | Mapped: %-14s | Latency: %6.1fms (POST) + %4.1fms (GET) | Size: %6d B | MAE: %.2f",
				tf.locketID, tf.mappedFilter, float64(latency.Milliseconds()), float64(getLatency.Milliseconds()), len(processedBytes), mae)
		})
	}

	// 5. Test Failure Semantics: Simulated AI Engine failure
	t.Run("Failure_AI_Engine_Down_Returns_502", func(t *testing.T) {
		// Create proxy pointing to dead port
		failProxyServer := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if handler.HandleGenerateFilteredImage(w, r, "http://127.0.0.1:59999") {
				return
			}
			http.NotFound(w, r)
		}))
		defer failProxyServer.Close()

		reqBody := fmt.Sprintf(`{"imageUrl":"%s","filterId":"glasses"}`, photoServer.URL)
		postResp, err := http.Post(failProxyServer.URL+"/generateFilteredImage", "application/json", strings.NewReader(reqBody))
		if err != nil {
			t.Fatalf("POST failed: %v", err)
		}
		defer postResp.Body.Close()

		if postResp.StatusCode != http.StatusBadGateway {
			t.Errorf("expected HTTP 502 Bad Gateway on AI engine failure, got %d (MUST NOT disguise as 200)", postResp.StatusCode)
		}

		var errResult map[string]any
		_ = json.NewDecoder(postResp.Body).Decode(&errResult)
		if errResult["filterStatus"] != handler.StatusFilterFailed {
			t.Errorf("expected filterStatus %s, got %v", handler.StatusFilterFailed, errResult["filterStatus"])
		}
		if errResult["success"] != false {
			t.Errorf("expected success false, got %v", errResult["success"])
		}
	})

	// 6. Test Cache Delivery Edge Cases
	t.Run("Cache_Unknown_Session_Returns_404", func(t *testing.T) {
		resp, err := http.Get(proxyServer.URL + "/ai-processed/1122334455667788.jpg")
		if err != nil {
			t.Fatalf("GET failed: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("expected HTTP 404 for unknown session, got %d", resp.StatusCode)
		}
	})

	t.Run("Cache_Expired_Session_Returns_410", func(t *testing.T) {
		expID := "aabbccddeeff0011"
		handler.StoreProcessedImageWithTTL(expID, portraitBytes, "glasses", 20*time.Millisecond)
		time.Sleep(35 * time.Millisecond)

		resp, err := http.Get(proxyServer.URL + "/ai-processed/" + expID + ".jpg")
		if err != nil {
			t.Fatalf("GET failed: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusGone {
			t.Errorf("expected HTTP 410 Gone for expired session, got %d", resp.StatusCode)
		}
	})

	t.Run("Cache_Traversal_Attack_Returns_404", func(t *testing.T) {
		resp, err := http.Get(proxyServer.URL + "/ai-processed/../../etc/passwd.jpg")
		if err != nil {
			t.Fatalf("GET failed: %v", err)
		}
		defer resp.Body.Close()
		if resp.StatusCode != http.StatusNotFound {
			t.Errorf("expected HTTP 404 for path traversal attempt, got %d", resp.StatusCode)
		}
	})
}
