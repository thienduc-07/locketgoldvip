/**
 * @file locket_firebase_request.js
 * Locket VIP - Xóa toàn bộ Header Cache & ETag cho Firebase Remote Config
 * Ngăn chặn lỗi HTTP 304 Not Modified, ép Firebase luôn trả về cấu hình mới nhất
 * By thienduc-07
 */

(function () {
    try {
        const headersToStrip = [
            'x-revenuecat-etag',
            'if-none-match',
            'if-modified-since',
            'x-goog-if-none-match',
            'x-firebase-etag'
        ];

        let modifiedHeaders = (typeof $request !== "undefined" && $request && $request.headers)
            ? Object.assign({}, $request.headers)
            : {};

        for (let key of Object.keys(modifiedHeaders)) {
            if (headersToStrip.includes(key.toLowerCase())) {
                delete modifiedHeaders[key];
            }
        }

        $done({ headers: modifiedHeaders });
    } catch (e) {
        $done({});
    }
})();
