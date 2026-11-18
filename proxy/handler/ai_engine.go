package handler

import (
	"bytes"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"os"
	"regexp"
	"strings"
	"sync"
	"time"
)

// Filter execution status constants
const (
	StatusFilterApplied   = "FILTER_APPLIED"
	StatusFilterFailed    = "FILTER_FAILED"
	StatusFallbackApplied = "FALLBACK_APPLIED"
)

// CacheLookupStatus indicates the result of looking up a session in the processed image cache
type CacheLookupStatus int

const (
	CacheStatusHit CacheLookupStatus = iota
	CacheStatusMiss
	CacheStatusExpired
)

// Cache configuration constants
const (
	DefaultCacheTTL = 10 * time.Minute
	MaxCacheEntries = 100
	MaxCacheBytes   = 50 * 1024 * 1024 // 50MB memory budget
)

var sessionIDRegex = regexp.MustCompile(`^[a-fA-F0-9]{8,64}$`)

// IsValidSessionID validates that a session ID consists only of valid hex characters
func IsValidSessionID(sessionID string) bool {
	return sessionIDRegex.MatchString(sessionID)
}

type cacheItem struct {
	data      []byte
	filterID  string
	createdAt time.Time
	expiresAt time.Time
}

type imageCache struct {
	mu           sync.RWMutex
	items        map[string]*cacheItem
	order        []string // FIFO / LRU eviction order
	currentBytes int64
}

var (
	globalCache = &imageCache{
		items: make(map[string]*cacheItem),
		order: make([]string, 0, MaxCacheEntries),
	}
	httpClient = &http.Client{Timeout: 15 * time.Second}
)

func init() {
	// Background cleanup worker: runs every 2 minutes to prune expired entries
	go func() {
		ticker := time.NewTicker(2 * time.Minute)
		for range ticker.C {
			globalCache.PruneExpired()
		}
	}()
}

// PruneExpired removes all expired items from the memory cache
func (c *imageCache) PruneExpired() int {
	c.mu.Lock()
	defer c.mu.Unlock()

	now := time.Now()
	pruned := 0
	newOrder := make([]string, 0, len(c.order))

	for _, id := range c.order {
		item, exists := c.items[id]
		if !exists {
			continue
		}
		if now.After(item.expiresAt) {
			c.currentBytes -= int64(len(item.data))
			delete(c.items, id)
			pruned++
		} else {
			newOrder = append(newOrder, id)
		}
	}
	c.order = newOrder
	return pruned
}

// evictOldestLocked evicts the oldest entries until within constraints. Must be called with lock held.
func (c *imageCache) evictOldestLocked(newBytes int64) {
	for (len(c.order) >= MaxCacheEntries || c.currentBytes+newBytes > MaxCacheBytes) && len(c.order) > 0 {
		oldestID := c.order[0]
		c.order = c.order[1:]
		if item, exists := c.items[oldestID]; exists {
			c.currentBytes -= int64(len(item.data))
			delete(c.items, oldestID)
		}
	}
}

// ClearCache clears all items from the cache (used in testing)
func ClearCache() {
	globalCache.mu.Lock()
	defer globalCache.mu.Unlock()
	globalCache.items = make(map[string]*cacheItem)
	globalCache.order = make([]string, 0, MaxCacheEntries)
	globalCache.currentBytes = 0
}

// GetCacheStats returns the current number of cached items and total memory bytes
func GetCacheStats() (int, int64) {
	globalCache.mu.RLock()
	defer globalCache.mu.RUnlock()
	return len(globalCache.items), globalCache.currentBytes
}

// StoreProcessedImage caches processed JPEG bytes with default 10-minute TTL
func StoreProcessedImage(sessionID string, imgBytes []byte) {
	StoreProcessedImageWithTTL(sessionID, imgBytes, "", DefaultCacheTTL)
}

// StoreProcessedImageWithTTL caches processed JPEG bytes with a specific TTL
func StoreProcessedImageWithTTL(sessionID string, imgBytes []byte, filterID string, ttl time.Duration) {
	globalCache.mu.Lock()
	defer globalCache.mu.Unlock()

	// If entry already exists, remove it first
	if old, exists := globalCache.items[sessionID]; exists {
		globalCache.currentBytes -= int64(len(old.data))
		delete(globalCache.items, sessionID)
		for i, id := range globalCache.order {
			if id == sessionID {
				globalCache.order = append(globalCache.order[:i], globalCache.order[i+1:]...)
				break
			}
		}
	}

	// Evict older entries if limits would be exceeded
	globalCache.evictOldestLocked(int64(len(imgBytes)))

	now := time.Now()
	globalCache.items[sessionID] = &cacheItem{
		data:      imgBytes,
		filterID:  filterID,
		createdAt: now,
		expiresAt: now.Add(ttl),
	}
	globalCache.order = append(globalCache.order, sessionID)
	globalCache.currentBytes += int64(len(imgBytes))
}

// GetProcessedImage retrieves cached processed JPEG bytes (backward compatibility)
func GetProcessedImage(sessionID string) ([]byte, bool) {
	data, status := GetProcessedImageWithStatus(sessionID)
	return data, status == CacheStatusHit
}

// GetProcessedImageWithStatus retrieves cached JPEG bytes and distinguishes between Hit, Miss, and Expired
func GetProcessedImageWithStatus(sessionID string) ([]byte, CacheLookupStatus) {
	globalCache.mu.Lock()
	defer globalCache.mu.Unlock()

	item, exists := globalCache.items[sessionID]
	if !exists {
		return nil, CacheStatusMiss
	}

	if time.Now().After(item.expiresAt) {
		// Clean up expired entry
		globalCache.currentBytes -= int64(len(item.data))
		delete(globalCache.items, sessionID)
		for i, id := range globalCache.order {
			if id == sessionID {
				globalCache.order = append(globalCache.order[:i], globalCache.order[i+1:]...)
				break
			}
		}
		return nil, CacheStatusExpired
	}

	return item.data, CacheStatusHit
}

// MapToAIFilterID maps Locket filter/sticker IDs to the AI Engine's 6 supported filter types
func MapToAIFilterID(locketFilterID string) string {
	lower := strings.ToLower(locketFilterID)
	switch {
	case strings.Contains(lower, "beard") || strings.Contains(lower, "bearded"):
		return "beard"
	case strings.Contains(lower, "glasses") || strings.Contains(lower, "sunglasses"):
		return "glasses"
	case strings.Contains(lower, "looksmax") || strings.Contains(lower, "looks_maxxing") ||
		strings.Contains(lower, "beauty") || strings.Contains(lower, "makeup") ||
		strings.Contains(lower, "influencer") || strings.Contains(lower, "cutesy"):
		return "beauty_makeup"
	case strings.Contains(lower, "cartoon") || strings.Contains(lower, "disco") ||
		strings.Contains(lower, "slimed") || strings.Contains(lower, "comic"):
		return "cartoon"
	case strings.Contains(lower, "anime") || strings.Contains(lower, "manga") ||
		strings.Contains(lower, "princess"):
		return "anime"
	case strings.Contains(lower, "chibi") || strings.Contains(lower, "3d") ||
		strings.Contains(lower, "birthday") || strings.Contains(lower, "toy"):
		return "chibi_3d"
	default:
		// Default to beauty_makeup for general enhancements
		return "beauty_makeup"
	}
}

// BuildAIFilterResponse constructs the full Locket JSON response schema pointing to the processed output URL
func BuildAIFilterResponse(outputURL, filterID string) []byte {
	resp := map[string]any{
		"status":       200,
		"success":      true,
		"filterStatus": StatusFilterApplied,
		"filterId":     filterID,
		"outputUrl":    outputURL,
		"output_url":   outputURL,
		"url":          outputURL,
		"imageUrl":     outputURL,
		"image_url":    outputURL,
		"result": map[string]any{
			"status":       200,
			"success":      true,
			"filterStatus": StatusFilterApplied,
			"filterId":     filterID,
			"outputUrl":    outputURL,
			"output_url":   outputURL,
			"url":          outputURL,
			"imageUrl":     outputURL,
			"image_url":    outputURL,
			"data": map[string]any{
				"status":       200,
				"success":      true,
				"filterStatus": StatusFilterApplied,
				"filterId":     filterID,
				"outputUrl":    outputURL,
				"output_url":   outputURL,
				"url":          outputURL,
				"imageUrl":     outputURL,
				"image_url":    outputURL,
			},
		},
	}
	b, _ := json.Marshal(resp)
	return b
}

// BuildAIFilterErrorResponse constructs a structured failure response when AI processing cannot complete.
// It explicitly flags StatusFilterFailed and does NOT disguise failure as a successful 200 response.
func BuildAIFilterErrorResponse(filterID, errorMsg string, httpStatus int) []byte {
	resp := map[string]any{
		"status":       httpStatus,
		"success":      false,
		"filterStatus": StatusFilterFailed,
		"filterId":     filterID,
		"error": map[string]any{
			"code":    StatusFilterFailed,
			"message": errorMsg,
		},
		"result": map[string]any{
			"status":       httpStatus,
			"success":      false,
			"filterStatus": StatusFilterFailed,
			"error":        errorMsg,
		},
	}
	b, _ := json.Marshal(resp)
	return b
}

// BuildFallbackResponse constructs a response when a legitimate fallback effect is applied.
func BuildFallbackResponse(outputURL, filterID, fallbackReason string) []byte {
	resp := map[string]any{
		"status":         200,
		"success":        true,
		"filterStatus":   StatusFallbackApplied,
		"filterId":       filterID,
		"outputUrl":      outputURL,
		"output_url":     outputURL,
		"fallbackReason": fallbackReason,
		"result": map[string]any{
			"status":         200,
			"success":        true,
			"filterStatus":   StatusFallbackApplied,
			"filterId":       filterID,
			"outputUrl":      outputURL,
			"fallbackReason": fallbackReason,
		},
	}
	b, _ := json.Marshal(resp)
	return b
}

// ProcessWithAIEngine fetches the user photo, calls the local AI Engine, and returns (sessionID, jpegBytes, error)
func ProcessWithAIEngine(aiEngineBaseURL, photoURL, locketFilterID string) (string, []byte, error) {
	if aiEngineBaseURL == "" {
		aiEngineBaseURL = "http://127.0.0.1:8000"
	}

	// 1. Download user photo from storage URL
	req, err := http.NewRequest("GET", photoURL, nil)
	if err != nil {
		return "", nil, fmt.Errorf("failed to create photo download request: %w", err)
	}
	resp, err := httpClient.Do(req)
	if err != nil {
		return "", nil, fmt.Errorf("failed to download photo from %s: %w", photoURL, err)
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		return "", nil, fmt.Errorf("photo download returned HTTP %d", resp.StatusCode)
	}

	photoBytes, err := io.ReadAll(resp.Body)
	if err != nil {
		return "", nil, fmt.Errorf("failed to read photo body: %w", err)
	}

	// 2. Prepare multipart request to AI Engine
	targetFilter := MapToAIFilterID(locketFilterID)
	var bodyBuf bytes.Buffer
	mw := multipart.NewWriter(&bodyBuf)

	_ = mw.WriteField("filter_id", targetFilter)
	_ = mw.WriteField("intensity", "0.85")

	part, err := mw.CreateFormFile("file", "photo.jpg")
	if err != nil {
		return "", nil, fmt.Errorf("failed to create multipart form file: %w", err)
	}
	if _, err := part.Write(photoBytes); err != nil {
		return "", nil, fmt.Errorf("failed to write multipart photo data: %w", err)
	}
	_ = mw.Close()

	aiReqURL := fmt.Sprintf("%s/api/v1/filters/process", strings.TrimRight(aiEngineBaseURL, "/"))
	aiReq, err := http.NewRequest("POST", aiReqURL, &bodyBuf)
	if err != nil {
		return "", nil, fmt.Errorf("failed to create AI Engine request: %w", err)
	}
	aiReq.Header.Set("Content-Type", mw.FormDataContentType())

	aiResp, err := httpClient.Do(aiReq)
	if err != nil {
		return "", nil, fmt.Errorf("AI Engine request failed: %w", err)
	}
	defer aiResp.Body.Close()

	if aiResp.StatusCode != http.StatusOK {
		respErr, _ := io.ReadAll(aiResp.Body)
		return "", nil, fmt.Errorf("AI Engine returned HTTP %d: %s", aiResp.StatusCode, string(respErr))
	}

	var aiResult struct {
		Status      string `json:"status"`
		OutputImage string `json:"output_image"`
		FilterID    string `json:"filter_id"`
	}
	if err := json.NewDecoder(aiResp.Body).Decode(&aiResult); err != nil {
		return "", nil, fmt.Errorf("failed to decode AI Engine response: %w", err)
	}

	if !strings.HasPrefix(aiResult.OutputImage, "data:image/jpeg;base64,") {
		return "", nil, fmt.Errorf("AI Engine returned unexpected output format")
	}

	rawB64 := strings.TrimPrefix(aiResult.OutputImage, "data:image/jpeg;base64,")
	jpegBytes, err := base64.StdEncoding.DecodeString(rawB64)
	if err != nil {
		return "", nil, fmt.Errorf("failed to decode base64 JPEG: %w", err)
	}

	// 3. Generate unique session ID and cache image bytes with TTL
	randBytes := make([]byte, 8)
	_, _ = rand.Read(randBytes)
	sessionID := hex.EncodeToString(randBytes)

	StoreProcessedImageWithTTL(sessionID, jpegBytes, targetFilter, DefaultCacheTTL)

	return sessionID, jpegBytes, nil
}

// ServeAIProcessedImage handles GET /ai-processed/{sessionID}.jpg requests.
// Returns true if the request was handled by this endpoint, false otherwise.
func ServeAIProcessedImage(w http.ResponseWriter, r *http.Request) bool {
	if !strings.HasPrefix(r.URL.Path, "/ai-processed/") {
		return false
	}
	sessionID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/ai-processed/"), ".jpg")
	if sessionID == "" || !IsValidSessionID(sessionID) {
		http.NotFound(w, r)
		return true
	}

	imgBytes, status := GetProcessedImageWithStatus(sessionID)
	switch status {
	case CacheStatusHit:
		w.Header().Set("Content-Type", "image/jpeg")
		w.Header().Set("Cache-Control", "public, max-age=600")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(imgBytes)
		return true
	case CacheStatusExpired:
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.WriteHeader(http.StatusGone) // 410 Gone
		_, _ = w.Write([]byte(`{"status":410,"error":{"code":"SESSION_EXPIRED","message":"processed image session has expired"}}`))
		return true
	default:
		http.NotFound(w, r)
		return true
	}
}

// HandleGenerateFilteredImage handles generateFilteredImage requests.
// Returns true if the request was handled, false otherwise.
func HandleGenerateFilteredImage(w http.ResponseWriter, r *http.Request, aiEngineURL string) bool {
	if !strings.Contains(r.URL.Path, "generateFilteredImage") || r.Body == nil {
		return false
	}

	bodyBytes, err := io.ReadAll(r.Body)
	if err != nil {
		return false
	}
	r.Body = io.NopCloser(bytes.NewReader(bodyBytes))

	photoURL, filterID := ExtractPhotoURLAndFilterID(bodyBytes)
	if photoURL == "" {
		return false
	}

	// A. Client-side overlay & Photobooth frames: return mock 200 immediately
	// because frames are rendered natively client-side over the original photo
	if IsOverlayOrPhotoboothFilter(filterID) {
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(BuildMockFilterResponse(photoURL))
		return true
	}

	// B. AI Filters: Process with local AI Engine
	if aiEngineURL == "" {
		aiEngineURL = "http://127.0.0.1:8000"
	}
	sessionID, _, err := ProcessWithAIEngine(aiEngineURL, photoURL, filterID)
	if err == nil && sessionID != "" {
		reqHost := os.Getenv("PUBLIC_HOST")
		if reqHost == "" {
			reqHost = r.Host
		}
		if reqHost == "" || strings.HasPrefix(reqHost, "localhost") || strings.HasPrefix(reqHost, "127.0.0.1") {
			reqHost = "us-central1-locket-4252a.cloudfunctions.net"
		}
		outputURL := "https://" + reqHost + "/ai-processed/" + sessionID + ".jpg"
		w.Header().Set("Content-Type", "application/json; charset=utf-8")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.WriteHeader(http.StatusOK)
		_, _ = w.Write(BuildAIFilterResponse(outputURL, filterID))
		return true
	}

	// C. Controlled Failure: NEVER silently return original photo with HTTP 200 when user selected an AI Filter
	// Return controlled HTTP 502 with structured FILTER_FAILED status and explicit error details
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusBadGateway)
	errMsg := "AI Engine processing failed or unavailable"
	if err != nil {
		errMsg = err.Error()
	}
	_, _ = w.Write(BuildAIFilterErrorResponse(filterID, errMsg, http.StatusBadGateway))
	return true
}

