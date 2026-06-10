// ==========================================
// TỆP CẤU HÌNH HỆ THỐNG (SYSTEM CONFIGURATION)
// Chứa các khóa API và cấu hình mặc định để dễ quản lý
// ==========================================

const SYS_CONFIG = {
    // 1. CẤU HÌNH MQTT MẶC ĐỊNH
    MQTT_DEFAULT_URL: 'wss://56ecf33a4ced4963be99ef6504a4b410.s1.eu.hivemq.cloud:8884/mqtt',
    MQTT_DEFAULT_USER: 'AIRMONITOR',
    MQTT_DEFAULT_PASS: 'Air12345',
    MQTT_DEFAULT_TOPIC: 'utt/airquality/data',

    // 2. CẤU HÌNH KHÓA EMAILJS
    EMAILJS_PUBLIC_KEY: '9hNUJSyH8R5ApIGj7',
    EMAILJS_SERVICE_ID: 'service_rr2rcfv',
    EMAILJS_TEMPLATE_ID: 'template_vt19xpj',

    // 3. CẤU HÌNH GEMINI API
    GEMINI_API_KEY: atob('QVEuQWI4Uk42S3RmRDZlbTIyRGJZUW9YQ0l3NHE4VGFmUTZvZTFHTGpfQm9kZXVDMnQzdnc='),

    // 4. CẤU HÌNH HỆ THỐNG
    EMAIL_COOLDOWN_MS: 5 * 60 * 1000, // Thời gian chờ (chống spam) giữa 2 lần gửi mail cho cùng 1 thông số (5 phút)

    // 4. GIỚI HẠN CẢNH BÁO MẶC ĐỊNH
    DEFAULT_LIMITS: {
        maxTemp: 35,
        minTemp: 15,
        maxHum: 80,
        minHum: 30,
        maxPm25: 50,
        maxEco2: 1000,
        maxTvoc: 500,
        maxAqi: 3
    }
};
