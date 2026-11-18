/**
 * @file locket_firebase_request.js
 * Locket VIP - Xóa toàn bộ Header Cache & ETag cho Firebase Remote Config
 * Ngăn chặn lỗi HTTP 304 Not Modified, ép Firebase luôn trả về cấu hình mới nhất
 * By thienduc-07
 */

(function () {
    try {
        var headersToStrip = [
            'x-revenuecat-etag',
            'if-none-match',
            'if-modified-since',
            'x-goog-if-none-match',
            'x-firebase-etag',
            'etag'
        ];

        var modifiedHeaders = (typeof $request !== "undefined" && $request && $request.headers)
            ? Object.assign({}, $request.headers)
            : {};

        for (var i = 0; i < headersToStrip.length; i++) {
            var target = headersToStrip[i];
            for (var key in modifiedHeaders) {
                if (key.toLowerCase() === target) {
                    delete modifiedHeaders[key];
                }
            }
        }

        // Force freshness: prevent caching and conditional requests
        modifiedHeaders['Cache-Control'] = 'no-cache, no-store, must-revalidate';
        modifiedHeaders['Pragma'] = 'no-cache';

        $done({ headers: modifiedHeaders });
    } catch (e) {
        $done({});
    }
})();
