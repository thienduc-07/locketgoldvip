let body = $response.body;

try {
    let obj = JSON.parse(body);
    let entries = obj.entries || {};

    // 1. Bơm các cờ bắt buộc để bật nút Filter và tính năng Photobooth Local
    // 1. Bơm các cờ bắt buộc để bật nút Filter, Photobooth và GỬI CHO RIÊNG MÌNH
    const activeFlags = {
        "show_filter_button": "true",
        "photobooth_enabled": "true",
        "camera_photobooth_enabled": "true",
        "sheet_filters_selectable": "true",
        "has_premium": "true",
        "is_premium": "true",

        // --- THÊM CÁC CỜ NÀY ĐỂ HIỆN LẠI NÚT "GỬI CHO TÔI" ---
        "enable_send_to_self": "true",
        "send_to_self_enabled": "true",
        "enable_journal": "true",
        "journal_enabled": "true",
        "history_enabled": "true",
        "albums_enabled": "true"
    };

    for (let key in activeFlags) {
        entries[key] = activeFlags[key];
    }

    // 2. Lọc và làm sạch mảng Filter
    if (entries.customPhotoboothFilters) {
        let filters = JSON.parse(entries.customPhotoboothFilters);
        let safeFilters = [];

        for (let i = 0; i < filters.length; i++) {
            let filter = filters[i];
            let id = (filter.id || "").toLowerCase();

            // Xóa sạch category cũ để chống lỗi crash Swift Enum
            delete filter.category;

            if (id.includes("photobooth") || id.includes("ptb") || id === "4cut") {
                filter.category = "Photobooth"; // Bắt buộc chữ P viết hoa
                safeFilters.push(filter);
            }
            else if (id.includes("frame") || filter.overlayUrl) {
                filter.category = "Frames"; // Khung ảnh tĩnh (F viết hoa)
                safeFilters.push(filter);
            }
            else if (filter.lutUrl && !filter.serverProcessing) {
                // Tints (Filter màu offline) -> Giữ nguyên, không gán category
                safeFilters.push(filter);
            }
        }

        // Đảm bảo luôn có ít nhất 1 khung Photobooth để không bị crash
        let hasPtb = safeFilters.some(f => f.category === "Photobooth");
        if (!hasPtb) {
            safeFilters.unshift({
                "id": "photobooth_4cut",
                "name": "Photobooth",
                "category": "Photobooth",
                "selectable": true
            });
        }

        entries.customPhotoboothFilters = JSON.stringify(safeFilters);
    }

    body = JSON.stringify(obj);
} catch (e) {
    console.log("Firebase MITM Error: " + e);
}

$done({ body });