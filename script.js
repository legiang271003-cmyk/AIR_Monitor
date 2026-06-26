// --- LOAD CONFIGURATIONS ---
const DEFAULT_CONFIG = {
    mqttUrl: SYS_CONFIG.MQTT_DEFAULT_URL,
    mqttUser: SYS_CONFIG.MQTT_DEFAULT_USER,
    mqttPass: SYS_CONFIG.MQTT_DEFAULT_PASS,
    mqttTopic: SYS_CONFIG.MQTT_DEFAULT_TOPIC,
    email: '',
    alarmEnabled: false,
    geminiKey: SYS_CONFIG.GEMINI_API_KEY,
    limits: SYS_CONFIG.DEFAULT_LIMITS
};

// 1. Lấy dữ liệu đã lưu từ bộ nhớ trình duyệt
let savedConfig = JSON.parse(localStorage.getItem('utt_air_config')) || {};

// 2. LOGIC ĐỒNG BỘ: Nếu Key trong SYS_CONFIG khác với Key đang lưu ở máy, ưu tiên SYS_CONFIG
if (SYS_CONFIG.GEMINI_API_KEY && SYS_CONFIG.GEMINI_API_KEY !== savedConfig.geminiKey) {
    console.log("🔄 Hệ thống: Phát hiện API Key mới, đang đồng bộ dữ liệu...");
    savedConfig.geminiKey = SYS_CONFIG.GEMINI_API_KEY;
}

let appConfig = { ...DEFAULT_CONFIG, ...savedConfig };
appConfig.limits = { ...DEFAULT_CONFIG.limits, ...(savedConfig.limits || {}) };
if (!Number.isFinite(Number(appConfig.limits.maxAqi)) || Number(appConfig.limits.maxAqi) <= 5) {
    appConfig.limits.maxAqi = DEFAULT_CONFIG.limits.maxAqi;
}
localStorage.setItem('utt_air_config', JSON.stringify(appConfig));

// --- CÁC BIẾN TRẠNG THÁI ---
let mqttClient = null;
const webClientId = 'web-client-' + Math.random().toString(16).slice(2, 10);
let lastEmailSentTime = {};
let lastEmailFailureTime = {};
let emailSendQueue = Promise.resolve();
const pendingEmailAlerts = new Set();
let isMqttConnected = false;
let isLoraConnected = false;

// Cấu trúc mới hỗ trợ 2 trạm
const stationsData = {
    1: { name: 'Trạm 1 (LoRa)', history: { timestamp: [], time: [], temp: [], hum: [], pm1_0: [], pm25: [], pm10: [], eco2: [], tvoc: [] }, current: {}, lastTime: Date.now(), timeoutAlerted: false },
    2: { name: 'Trạm 2 (MQTT)', history: { timestamp: [], time: [], temp: [], hum: [], pm1_0: [], pm25: [], pm10: [], eco2: [], tvoc: [] }, current: {}, lastTime: Date.now(), timeoutAlerted: false }
};
const STATION_LOCATIONS = {
    1: { name: 'Trạm 1 (LoRa) - UTT Hà Nội', latitude: 20.984701, longitude: 105.798850 },
    2: { name: 'Trạm 2 (MQTT)', latitude: 21.29229170656175, longitude: 105.58406173400247 }
};
let activeStation = 1;
let activeWeatherStation = 1;
const HISTORY_RETENTION_MS = 60 * 60 * 1000;
const MAX_HISTORY_POINTS = 5000;
const LORA_DUST_CORRECTION_FACTORS = {
    pm1_0: 4.2,   // 21 (LoRa) / 5 (MQTT)
    pm2_5: 5.83,  // 35 (LoRa) / 6 (MQTT)
    pm10: 13.67   // 82 (LoRa) / 6 (MQTT)
};
function getLoRaMqttTopic() {
    return `${appConfig.mqttTopic.replace(/\/$/, '')}/lora`;
}

function updateLoRaGatewayInfo() {
    const topicText = document.getElementById('lora-topic-text');
    const roleText = document.getElementById('lora-role-text');
    if (topicText) topicText.textContent = getLoRaMqttTopic();
    if (roleText) roleText.textContent = isLoraConnected ? 'Gateway USB Serial' : 'Viewer MQTT';
}

function setLoRaPublishStatus(message, color = 'var(--text-secondary)') {
    const status = document.getElementById('lora-publish-status');
    if (!status) return;
    status.textContent = message;
    status.style.color = color;
}

// --- US EPA AQI TỪ PM2.5 VÀ PM10 ---
// PM2.5 dùng breakpoint EPA 2024; PM10 dùng breakpoint hiện hành.
const AQI_BREAKPOINTS = {
    pm25: [
        [0.0, 9.0, 0, 50], [9.1, 35.4, 51, 100], [35.5, 55.4, 101, 150],
        [55.5, 125.4, 151, 200], [125.5, 225.4, 201, 300],
        [225.5, 325.4, 301, 400], [325.5, 500.4, 401, 500]
    ],
    pm10: [
        [0, 54, 0, 50], [55, 154, 51, 100], [155, 254, 101, 150],
        [255, 354, 151, 200], [355, 424, 201, 300],
        [425, 504, 301, 400], [505, 604, 401, 500]
    ]
};

function calculatePollutantAQI(concentration, breakpoints) {
    if (!Number.isFinite(concentration) || concentration < 0) return 0;
    const range = breakpoints.find(([low, high]) => concentration >= low && concentration <= high);
    if (!range) return concentration > breakpoints.at(-1)[1] ? 500 : 0;
    const [cLow, cHigh, iLow, iHigh] = range;
    return Math.round(((iHigh - iLow) / (cHigh - cLow)) * (concentration - cLow) + iLow);
}

function getAQICategory(aqi) {
    if (aqi <= 50) return { val: aqi, label: 'Tốt', class: 'aqi-good' };
    if (aqi <= 100) return { val: aqi, label: 'Trung bình', class: 'aqi-moderate' };
    if (aqi <= 150) return { val: aqi, label: 'Không tốt cho nhóm nhạy cảm', class: 'aqi-sensitive' };
    if (aqi <= 200) return { val: aqi, label: 'Không tốt', class: 'aqi-unhealthy' };
    if (aqi <= 300) return { val: aqi, label: 'Rất không tốt', class: 'aqi-very-unhealthy' };
    return { val: Math.min(aqi, 500), label: 'Nguy hại', class: 'aqi-hazardous' };
}

function calculateAirQualityIndex(pm25Value, pm10Value) {
    const pm25 = Math.floor(Math.max(0, Number(pm25Value) || 0) * 10) / 10;
    const pm10 = Math.floor(Math.max(0, Number(pm10Value) || 0));
    const pm25Aqi = calculatePollutantAQI(pm25, AQI_BREAKPOINTS.pm25);
    const pm10Aqi = calculatePollutantAQI(pm10, AQI_BREAKPOINTS.pm10);
    const dominantPollutant = pm25Aqi >= pm10Aqi ? 'PM2.5' : 'PM10';
    return { ...getAQICategory(Math.max(pm25Aqi, pm10Aqi)), dominantPollutant };
}

// --- DOM ELEMENTS ---
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');
const aqiBanner = document.getElementById('aqi-banner');
const valAqi = document.getElementById('val-aqi');
const labelAqi = document.getElementById('label-aqi');

// --- TABS & STATION LOGIC ---
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
        document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
        btn.classList.add('active');
        document.getElementById(btn.dataset.target).classList.add('active');

        if (btn.dataset.target === 'dashboard-tab') {
            window.dispatchEvent(new Event('resize'));
        } else if (btn.dataset.target === 'weather-tab') {
            loadWeather(activeWeatherStation);
        }
    });
});

document.querySelectorAll('.station-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.station-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeStation = parseInt(btn.dataset.station);

        // Cập nhật lại UI dựa trên data của trạm được chọn
        const stData = stationsData[activeStation];
        if (stData.current.aqi !== undefined) {
            updateDashboardUI(stData.current, stData.history);
            analyzeAIAdvice();
        } else {
            valAqi.innerText = '--';
            labelAqi.innerText = 'Đang chờ dữ liệu...';
            aqiBanner.className = 'aqi-banner';
            resetGauges();
            updateHistoryChart(stData.history);
            resetAIAdvice();
        }
    });
});

document.querySelectorAll('.weather-station-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.weather-station-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        activeWeatherStation = parseInt(btn.dataset.weatherStation);
        loadWeather(activeWeatherStation);
    });
});

// --- INIT CONFIG FORMS ---
function initConfigForms() {
    document.getElementById('cfg-mqtt-url').value = appConfig.mqttUrl;
    document.getElementById('cfg-mqtt-user').value = appConfig.mqttUser;
    document.getElementById('cfg-mqtt-pass').value = appConfig.mqttPass;
    document.getElementById('cfg-mqtt-topic').value = appConfig.mqttTopic;
    updateLoRaGatewayInfo();

    if (document.getElementById('cfg-gemini-key')) {
        document.getElementById('cfg-gemini-key').value = appConfig.geminiKey || '';
    }

    // Split stored emails into 3 boxes
    const emails = appConfig.email ? appConfig.email.split(',').map(e => e.trim()) : [];
    document.getElementById('cfg-email-1').value = emails[0] || '';
    document.getElementById('cfg-email-2').value = emails[1] || '';
    document.getElementById('cfg-email-3').value = emails[2] || '';

    document.getElementById('cfg-max-temp').value = appConfig.limits.maxTemp;
    document.getElementById('cfg-min-temp').value = appConfig.limits.minTemp;
    document.getElementById('cfg-max-hum').value = appConfig.limits.maxHum;
    document.getElementById('cfg-min-hum').value = appConfig.limits.minHum;
    document.getElementById('cfg-max-pm25').value = appConfig.limits.maxPm25;
    document.getElementById('cfg-max-eco2').value = appConfig.limits.maxEco2;
    document.getElementById('cfg-max-tvoc').value = appConfig.limits.maxTvoc;
    document.getElementById('cfg-max-aqi').value = appConfig.limits.maxAqi;
}
initConfigForms();

// --- SAVE CONFIGURATIONS ---
document.getElementById('btn-save-mqtt').addEventListener('click', () => {
    appConfig.mqttUrl = document.getElementById('cfg-mqtt-url').value;
    appConfig.mqttUser = document.getElementById('cfg-mqtt-user').value;
    appConfig.mqttPass = document.getElementById('cfg-mqtt-pass').value;
    appConfig.mqttTopic = document.getElementById('cfg-mqtt-topic').value;
    updateLoRaGatewayInfo();
    saveConfig();
    showToast('Thành công', 'Đã lưu cấu hình MQTT. Đang kết nối...', 'success');
    if (mqttClient) {
        mqttClient.end();
        mqttClient = null;
    }
    connectMQTT(); // Reconnect with new settings
});

document.getElementById('btn-save-alerts').addEventListener('click', () => {
    const e1 = document.getElementById('cfg-email-1').value.trim();
    const e2 = document.getElementById('cfg-email-2').value.trim();
    const e3 = document.getElementById('cfg-email-3').value.trim();
    // Gộp lại thành chuỗi cách nhau bởi dấu phẩy, loại bỏ ô trống
    const emails = [e1, e2, e3].filter(e => e !== '');
    const invalidEmails = emails.filter(email => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email));
    if (invalidEmails.length) {
        showToast('Email chưa hợp lệ', `Kiểm tra lại: ${invalidEmails.join(', ')}`, 'error');
        return;
    }
    const emailStr = emails.join(', ');

    appConfig.email = emailStr;
    appConfig.limits.maxTemp = parseFloat(document.getElementById('cfg-max-temp').value);
    appConfig.limits.minTemp = parseFloat(document.getElementById('cfg-min-temp').value);
    appConfig.limits.maxHum = parseFloat(document.getElementById('cfg-max-hum').value);
    appConfig.limits.minHum = parseFloat(document.getElementById('cfg-min-hum').value);
    appConfig.limits.maxPm25 = parseFloat(document.getElementById('cfg-max-pm25').value);
    appConfig.limits.maxEco2 = parseFloat(document.getElementById('cfg-max-eco2').value);
    appConfig.limits.maxTvoc = parseFloat(document.getElementById('cfg-max-tvoc').value);
    appConfig.limits.maxAqi = parseFloat(document.getElementById('cfg-max-aqi').value);
    saveConfig();
    showToast('Thành công', 'Đã lưu cấu hình Email & Cảnh báo.', 'success');
});

if (document.getElementById('btn-save-gemini')) {
    document.getElementById('btn-save-gemini').addEventListener('click', () => {
        appConfig.geminiKey = document.getElementById('cfg-gemini-key').value.trim();
        saveConfig();
        showToast('Thành công', 'Đã lưu khóa API Gemini. Trợ lý AI đã sẵn sàng!', 'success');
    });
}

function saveConfig() {
    localStorage.setItem('utt_air_config', JSON.stringify(appConfig));
}

// --- TOAST NOTIFICATIONS ---
function showToast(title, message, type = 'info') {
    const container = document.getElementById('toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;

    let iconClass = 'fa-info-circle';
    if (type === 'success') iconClass = 'fa-check-circle';
    if (type === 'error') iconClass = 'fa-times-circle';
    if (type === 'warning') iconClass = 'fa-triangle-exclamation';

    toast.innerHTML = `
        <div class="toast-icon"><i class="fa-solid ${iconClass}"></i></div>
        <div class="toast-content">
            <h4>${title}</h4>
            <p>${message}</p>
        </div>
    `;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'fadeOut 0.3s forwards';
        setTimeout(() => toast.remove(), 300);
    }, 5000);
}

// --- EMAIL ALERT LOGIC ---
// EmailJS Initialization
(function () {
    emailjs.init({
        publicKey: SYS_CONFIG.EMAILJS_PUBLIC_KEY
    });
})();


function getAlertEmails() {
    return (appConfig.email || '')
        .split(',')
        .map(email => email.trim())
        .filter(Boolean);
}

function queueEmailSend(task) {
    emailSendQueue = emailSendQueue
        .catch(() => { })
        .then(() => new Promise(resolve => setTimeout(resolve, 1200)))
        .then(task);
    return emailSendQueue;
}

function triggerEmailAlert(stationId, paramName, currentValue, limitValue, message, fullData) {
    const alertEmails = getAlertEmails();
    if (!alertEmails.length) return;

    const now = Date.now();
    const alertKey = `${stationId}_${paramName}`;
    if (pendingEmailAlerts.has(alertKey)) return;

    if (lastEmailFailureTime[alertKey] && (now - lastEmailFailureTime[alertKey] < 60 * 1000)) {
        return;
    }

    // Check cooldown
    if (lastEmailSentTime[alertKey] && (now - lastEmailSentTime[alertKey] < SYS_CONFIG.EMAIL_COOLDOWN_MS)) {
        return; // Skip if in cooldown
    }

    pendingEmailAlerts.add(alertKey);
    const emailMsg = `CẢNH BÁO [Trạm ${stationId}]: ${message}. Giá trị hiện tại: ${currentValue}, Giới hạn: ${limitValue}.`;

    showToast('Gửi Email Cảnh báo', `Đang gửi email tới ${alertEmails.join(', ')}...`, 'warning');
    console.log("SENDING EMAIL to " + alertEmails.join(', ') + " -> " + emailMsg);

    const templateParams = {
        alert_message: `[Trạm ${stationId}] ${message}`,
        param_name: paramName,
        current_value: currentValue,
        limit_value: limitValue,
        val_temp: fullData.temp,
        val_hum: fullData.hum,
        val_pm25: fullData.pm2_5,
        val_pm10: fullData.pm10,
        val_pm1_0: fullData.pm1_0,
        val_eco2: fullData.eco2,
        val_tvoc: fullData.tvoc,
        val_aqi: fullData.aqi,
        time: new Date().toLocaleString('vi-VN')
    };

    Promise.allSettled(alertEmails.map(email => queueEmailSend(() => (
        emailjs.send(SYS_CONFIG.EMAILJS_SERVICE_ID, SYS_CONFIG.EMAILJS_TEMPLATE_ID, {
            ...templateParams,
            to_email: email
        })
    )))).then(results => {
        const successCount = results.filter(result => result.status === 'fulfilled').length;
        if (successCount > 0) {
            lastEmailSentTime[alertKey] = Date.now();
            showToast('Thành công', `Đã gửi ${successCount}/${alertEmails.length} email cảnh báo (Trạm ${stationId})!`, 'success');
        }
        if (successCount < alertEmails.length) {
            const errors = results
                .filter(result => result.status === 'rejected')
                .map(result => result.reason);
            console.error("EmailJS Error:", errors);
            lastEmailFailureTime[alertKey] = Date.now();
            showToast('Lỗi EmailJS', 'EmailJS đang từ chối hoặc giới hạn gửi. Sẽ thử lại sau 60 giây.', 'error');
        }
    }).finally(() => {
        pendingEmailAlerts.delete(alertKey);
    });
}

// --- WEB AUDIO ALARM ---
const ALARM_SOUND_URL = 'https://actions.google.com/sounds/v1/emergency/emergency_siren_short_burst.ogg';
let alarmAudio = null;
let alarmAudioContext = null;
let alarmTimerIds = [];
let lastAlarmTime = {};
const ALARM_COOLDOWN_MS = 60 * 1000;

function updateAlarmButton() {
    const button = document.getElementById('btn-toggle-alarm');
    if (!button) return;
    const enabled = Boolean(appConfig.alarmEnabled && (alarmAudio || alarmAudioContext));
    button.classList.toggle('enabled', enabled);
    button.setAttribute('aria-pressed', String(enabled));
    if (enabled) {
        button.innerHTML = '<i class="fa-solid fa-volume-high"></i><span>Âm cảnh báo đang bật</span>';
    } else if (appConfig.alarmEnabled) {
        button.innerHTML = '<i class="fa-solid fa-hand-pointer"></i><span>Chạm để kích hoạt âm</span>';
    } else {
        button.innerHTML = '<i class="fa-solid fa-volume-xmark"></i><span>Bật âm cảnh báo</span>';
    }
}

async function enableAlarmSound(showConfirmation = true) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;

    if (!alarmAudio) {
        alarmAudio = new Audio(ALARM_SOUND_URL);
        alarmAudio.preload = 'auto';
        alarmAudio.volume = 0.9;
    }

    if (AudioContextClass) {
        if (!alarmAudioContext) alarmAudioContext = new AudioContextClass();
        if (alarmAudioContext.state === 'suspended') await alarmAudioContext.resume();
    }

    // Mở khóa quyền phát media ngay trong thao tác bấm của người dùng.
    try {
        alarmAudio.muted = true;
        await alarmAudio.play();
        alarmAudio.pause();
        alarmAudio.currentTime = 0;
    } catch (error) {
        console.warn('Không thể tải trước còi online, sẽ dùng âm dự phòng.', error);
    } finally {
        alarmAudio.muted = false;
    }

    appConfig.alarmEnabled = true;
    saveConfig();
    updateAlarmButton();
    if (showConfirmation) showToast('Đã bật còi', 'Còi báo động khẩn cấp đã sẵn sàng.', 'success');
    return true;
}

function silenceAlarm(disable = false) {
    alarmTimerIds.forEach(id => clearTimeout(id));
    alarmTimerIds = [];
    if (alarmAudio) {
        alarmAudio.pause();
        alarmAudio.currentTime = 0;
    }
    if (disable) {
        appConfig.alarmEnabled = false;
        saveConfig();
        updateAlarmButton();
    }
}

function playFallbackAlarmPattern() {
    [0, 350, 700, 1200, 1550, 1900].forEach((delay, index) => {
        playAlarmTone(index % 2 === 0 ? 880 : 660, delay, 250);
    });
}

function playOnlineAlarmClip(startDelay, useFallback = false) {
    const timerId = setTimeout(async () => {
        if (!appConfig.alarmEnabled || !alarmAudio) return;
        try {
            alarmAudio.pause();
            alarmAudio.currentTime = 0;
            await alarmAudio.play();
        } catch (error) {
            console.warn('Không thể phát còi online.', error);
            if (useFallback && alarmAudioContext) playFallbackAlarmPattern();
        }
    }, startDelay);
    alarmTimerIds.push(timerId);
}

function playAlarmTone(frequency, startDelay, duration) {
    const timerId = setTimeout(() => {
        if (!appConfig.alarmEnabled || !alarmAudioContext) return;
        const oscillator = alarmAudioContext.createOscillator();
        const gain = alarmAudioContext.createGain();
        oscillator.type = 'square';
        oscillator.frequency.setValueAtTime(frequency, alarmAudioContext.currentTime);
        gain.gain.setValueAtTime(0.0001, alarmAudioContext.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.18, alarmAudioContext.currentTime + 0.02);
        gain.gain.exponentialRampToValueAtTime(0.0001, alarmAudioContext.currentTime + duration / 1000);
        oscillator.connect(gain).connect(alarmAudioContext.destination);
        oscillator.start();
        oscillator.stop(alarmAudioContext.currentTime + duration / 1000 + 0.03);
    }, startDelay);
    alarmTimerIds.push(timerId);
}

function playAlarmPattern(stationId, force = false) {
    const now = Date.now();
    if (!force && lastAlarmTime[stationId] && now - lastAlarmTime[stationId] < ALARM_COOLDOWN_MS) return;
    lastAlarmTime[stationId] = now;
    if (!appConfig.alarmEnabled || (!alarmAudio && !alarmAudioContext)) return;
    silenceAlarm(false);
    if (alarmAudio) {
        [0, 1800, 3600].forEach((delay, index) => playOnlineAlarmClip(delay, index === 0));
    } else {
        playFallbackAlarmPattern();
    }
}

function showAirAlert(stationId, violations) {
    const panel = document.getElementById('air-alert-panel');
    document.getElementById('air-alert-title').textContent = `CẢNH BÁO TRẠM ${stationId}: ${violations.length} chỉ số vượt ngưỡng`;
    document.getElementById('air-alert-message').textContent = violations.map(item => item.display).join(' · ');
    panel.hidden = false;
    playAlarmPattern(stationId);
}

document.getElementById('btn-toggle-alarm')?.addEventListener('click', async () => {
    if (appConfig.alarmEnabled && (alarmAudio || alarmAudioContext)) {
        silenceAlarm(true);
        showToast('Đã tắt còi', 'Bạn vẫn nhận email và thông báo trên màn hình.', 'warning');
    } else {
        await enableAlarmSound();
    }
});

document.getElementById('btn-test-alarm')?.addEventListener('click', async () => {
    if (await enableAlarmSound(false)) {
        playAlarmPattern('test', true);
        showToast('Kiểm tra âm thanh', 'Đang phát mẫu còi cảnh báo.', 'warning');
    }
});

document.getElementById('btn-silence-alarm')?.addEventListener('click', () => silenceAlarm(true));
document.getElementById('btn-close-alert')?.addEventListener('click', () => {
    document.getElementById('air-alert-panel').hidden = true;
});
// Trình duyệt chỉ cho tạo âm thanh sau một tương tác của người dùng.
document.addEventListener('pointerdown', (event) => {
    if (event.target.closest('#btn-toggle-alarm, #btn-test-alarm')) return;
    if (appConfig.alarmEnabled && !alarmAudio && !alarmAudioContext) enableAlarmSound(false);
}, { once: true });
updateAlarmButton();

function checkThresholds(data, stationId) {
    const L = appConfig.limits;
    const mappedAqi = data.aqi || 0;
    const candidates = [
        { active: data.temp > L.maxTemp, param: 'Nhiệt độ', value: data.temp, limit: L.maxTemp, message: 'Nhiệt độ QUÁ CAO', display: `${data.temp}°C > ${L.maxTemp}°C` },
        { active: data.temp < L.minTemp, param: 'Nhiệt độ', value: data.temp, limit: L.minTemp, message: 'Nhiệt độ QUÁ THẤP', display: `${data.temp}°C < ${L.minTemp}°C` },
        { active: data.hum > L.maxHum, param: 'Độ ẩm', value: data.hum, limit: L.maxHum, message: 'Độ ẩm QUÁ CAO', display: `${data.hum}% > ${L.maxHum}%` },
        { active: data.hum < L.minHum, param: 'Độ ẩm', value: data.hum, limit: L.minHum, message: 'Độ ẩm QUÁ THẤP', display: `${data.hum}% < ${L.minHum}%` },
        { active: data.pm2_5 > L.maxPm25, param: 'Bụi mịn PM2.5', value: data.pm2_5, limit: L.maxPm25, message: 'Bụi mịn PM2.5 vượt ngưỡng', display: `PM2.5 ${data.pm2_5} µg/m³` },
        { active: data.eco2 > L.maxEco2, param: 'eCO2', value: data.eco2, limit: L.maxEco2, message: 'Nồng độ eCO2 vượt ngưỡng', display: `eCO2 ${data.eco2} ppm` },
        { active: data.tvoc > L.maxTvoc, param: 'TVOC', value: data.tvoc, limit: L.maxTvoc, message: 'Nồng độ TVOC vượt ngưỡng', display: `TVOC ${data.tvoc} ppb` },
        { active: mappedAqi > L.maxAqi, param: 'Chỉ số AQI', value: mappedAqi, limit: L.maxAqi, message: 'Chỉ số AQI vượt ngưỡng', display: `AQI ${mappedAqi}` }
    ];
    const violations = candidates.filter(item => item.active);
    violations.forEach(item => {
        triggerBrowserNotification(stationId, item.param, `${item.message}: ${item.display}`);
    });
    if (violations.length) {
        const summaryMessage = violations.map(item => `${item.message}: ${item.display}`).join(' | ');
        triggerEmailAlert(
            stationId,
            'Tổng hợp cảnh báo',
            violations.map(item => item.display).join(' | '),
            'Theo cấu hình',
            summaryMessage,
            data
        );
        showAirAlert(stationId, violations);
    }
}


// --- ECHARTS LOGIC ---
const textColor = '#1e293b'; // Chữ xám đen
const tickColor = '#cbd5e1'; // Xám nhạt cho vạch chia
const detailColor = '#e31837'; // Màu Đỏ UTT cho thông số

function getGaugeOption(title, unit, min, max, splitNumber, colorStops) {
    return {
        series: [{
            type: 'gauge', center: ['50%', '55%'], radius: '90%', min: min, max: max, splitNumber: splitNumber,
            axisLine: { lineStyle: { width: 14, color: colorStops } },
            pointer: { itemStyle: { color: 'auto' }, width: 5, length: '60%' },
            axisTick: { distance: -14, length: 8, lineStyle: { color: tickColor, width: 1 } },
            splitLine: { distance: -14, length: 14, lineStyle: { color: tickColor, width: 2 } },
            axisLabel: { color: textColor, distance: 20, fontSize: 11, fontWeight: 600 },
            detail: { valueAnimation: true, formatter: '{value}', color: detailColor, fontSize: 26, fontWeight: 700, offsetCenter: [0, '70%'] },
            title: { offsetCenter: [0, '-30%'], color: '#004085', fontSize: 15, fontWeight: 700, formatter: function (v) { return v + ' (' + unit + ')'; } },
            data: [{ value: 0, name: title }]
        }]
    };
}

const chartTemp = echarts.init(document.getElementById('gauge-temp'));
const chartHum = echarts.init(document.getElementById('gauge-hum'));
const chartEco2 = echarts.init(document.getElementById('gauge-eco2'));
const chartTvoc = echarts.init(document.getElementById('gauge-tvoc'));
const chartPm1_0 = echarts.init(document.getElementById('gauge-pm1_0'));
const chartPm25 = echarts.init(document.getElementById('gauge-pm25'));
const chartPm10 = echarts.init(document.getElementById('gauge-pm10'));

const colorTemp = [[0.3, '#3388dd'], [0.7, '#10b981'], [1, '#ef4444']];
const colorHum = [[0.3, '#f59e0b'], [0.7, '#10b981'], [1, '#3388dd']];
const colorEco2 = [[0.2, '#10b981'], [0.5, '#f59e0b'], [1, '#ef4444']];
const colorTvoc = [[0.2, '#10b981'], [0.5, '#f59e0b'], [1, '#8b5cf6']];
const colorPm = [[0.2, '#10b981'], [0.4, '#f59e0b'], [0.6, '#ef4444'], [1, '#8b5cf6']];

chartTemp.setOption(getGaugeOption('Nhiệt độ', '°C', 0, 50, 5, colorTemp));
chartHum.setOption(getGaugeOption('Độ ẩm', '%', 0, 100, 5, colorHum));
chartEco2.setOption(getGaugeOption('eCO2', 'ppm', 400, 2000, 4, colorEco2));
chartTvoc.setOption(getGaugeOption('TVOC', 'ppb', 0, 1000, 5, colorTvoc));
chartPm1_0.setOption(getGaugeOption('PM1.0', 'µg/m³', 0, 200, 4, colorPm));
chartPm25.setOption(getGaugeOption('PM2.5', 'µg/m³', 0, 200, 4, colorPm));
chartPm10.setOption(getGaugeOption('PM10', 'µg/m³', 0, 200, 4, colorPm));

const chartHistory = echarts.init(document.getElementById('history-chart'));
const CHART_SERIES_NAMES = ['Nhiệt độ (°C)', 'Độ ẩm (%)', 'PM1.0 (µg/m³)', 'PM2.5 (µg/m³)', 'PM10 (µg/m³)', 'eCO2 (ppm)', 'TVOC (ppb)'];
const CHART_FILTER_GROUPS = {
    all: CHART_SERIES_NAMES,
    environment: ['Nhiệt độ (°C)', 'Độ ẩm (%)'],
    dust: ['PM1.0 (µg/m³)', 'PM2.5 (µg/m³)', 'PM10 (µg/m³)'],
    gas: ['eCO2 (ppm)', 'TVOC (ppb)']
};
let chartTimeRangeMinutes = 5;
let activeChartMetricGroup = 'all';

chartHistory.setOption({
    tooltip: { trigger: 'axis' },
    legend: {
        data: ['Nhiệt độ (°C)', 'Độ ẩm (%)', 'PM1.0 (µg/m³)', 'PM2.5 (µg/m³)', 'PM10 (µg/m³)', 'eCO2 (ppm)', 'TVOC (ppb)'],
        textStyle: { color: textColor },
        type: 'scroll',
        orient: 'horizontal'
    },
    grid: { left: '3%', right: '4%', bottom: '5%', top: '15%', containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: [], axisLabel: { color: textColor } },
    yAxis: [
        { type: 'value', name: 'Môi trường/Bụi', nameTextStyle: { color: textColor }, axisLabel: { color: textColor } },
        { type: 'value', name: 'Khí (eCO2/TVOC)', nameTextStyle: { color: textColor }, axisLabel: { color: textColor }, splitLine: { show: false } }
    ],
    series: [
        { name: 'Nhiệt độ (°C)', type: 'line', smooth: true, itemStyle: { color: '#ef4444' }, data: [] },
        { name: 'Độ ẩm (%)', type: 'line', smooth: true, itemStyle: { color: '#3388dd' }, data: [] },
        { name: 'PM1.0 (µg/m³)', type: 'line', smooth: true, itemStyle: { color: '#10b981' }, data: [] },
        { name: 'PM2.5 (µg/m³)', type: 'line', smooth: true, itemStyle: { color: '#f59e0b' }, data: [] },
        { name: 'PM10 (µg/m³)', type: 'line', smooth: true, itemStyle: { color: '#8b5cf6' }, data: [] },
        { name: 'eCO2 (ppm)', type: 'line', smooth: true, yAxisIndex: 1, itemStyle: { color: '#64748b' }, data: [] },
        { name: 'TVOC (ppb)', type: 'line', smooth: true, yAxisIndex: 1, itemStyle: { color: '#ec4899' }, data: [] }
    ]
});

function updateHistoryChart(history) {
    const cutoffTime = Date.now() - chartTimeRangeMinutes * 60 * 1000;
    const timestamps = history.timestamp || [];
    const firstVisibleIndex = timestamps.findIndex(timestamp => timestamp >= cutoffTime);
    const startIndex = firstVisibleIndex === -1 ? timestamps.length : firstVisibleIndex;
    chartHistory.setOption({
        xAxis: { data: history.time.slice(startIndex) },
        series: [
            { name: 'Nhiệt độ (°C)', type: 'line', smooth: true, itemStyle: { color: '#ef4444' }, data: history.temp.slice(startIndex) },
            { name: 'Độ ẩm (%)', type: 'line', smooth: true, itemStyle: { color: '#3388dd' }, data: history.hum.slice(startIndex) },
            { name: 'PM1.0 (µg/m³)', type: 'line', smooth: true, itemStyle: { color: '#10b981' }, data: history.pm1_0.slice(startIndex) },
            { name: 'PM2.5 (µg/m³)', type: 'line', smooth: true, itemStyle: { color: '#f59e0b' }, data: history.pm25.slice(startIndex) },
            { name: 'PM10 (µg/m³)', type: 'line', smooth: true, itemStyle: { color: '#8b5cf6' }, data: history.pm10.slice(startIndex) },
            { name: 'eCO2 (ppm)', type: 'line', smooth: true, yAxisIndex: 1, itemStyle: { color: '#64748b' }, data: history.eco2.slice(startIndex) },
            { name: 'TVOC (ppb)', type: 'line', smooth: true, yAxisIndex: 1, itemStyle: { color: '#ec4899' }, data: history.tvoc.slice(startIndex) }
        ]
    });
}

function syncSeriesCheckboxes(selected) {
    document.querySelectorAll('[data-chart-series]').forEach(checkbox => {
        checkbox.checked = selected[checkbox.dataset.chartSeries] !== false;
    });
}

function updateChartAxes(selected) {
    const showEnvironmentAxis = CHART_SERIES_NAMES.slice(0, 5).some(name => selected[name] !== false);
    const showGasAxis = CHART_SERIES_NAMES.slice(5).some(name => selected[name] !== false);
    chartHistory.setOption({
        yAxis: [
            { show: showEnvironmentAxis },
            { show: showGasAxis }
        ]
    });
}

function applySeriesSelection(selected) {
    chartHistory.setOption({ legend: { selected } });
    updateChartAxes(selected);
    syncSeriesCheckboxes(selected);
}

function applyChartMetricFilter(group) {
    if (group === 'custom') return;
    activeChartMetricGroup = CHART_FILTER_GROUPS[group] ? group : 'all';
    const visibleSeries = CHART_FILTER_GROUPS[activeChartMetricGroup];
    const selected = Object.fromEntries(CHART_SERIES_NAMES.map(name => [name, visibleSeries.includes(name)]));
    applySeriesSelection(selected);
}

document.getElementById('chart-metric-filter')?.addEventListener('change', event => {
    applyChartMetricFilter(event.target.value);
});

document.getElementById('chart-point-filter')?.addEventListener('change', event => {
    chartTimeRangeMinutes = Number(event.target.value) || 5;
    updateHistoryChart(stationsData[activeStation].history);
});

document.querySelectorAll('[data-chart-series]').forEach(checkbox => {
    checkbox.addEventListener('change', () => {
        const selected = Object.fromEntries(
            [...document.querySelectorAll('[data-chart-series]')]
                .map(input => [input.dataset.chartSeries, input.checked])
        );
        activeChartMetricGroup = 'custom';
        document.getElementById('chart-metric-filter').value = 'custom';
        applySeriesSelection(selected);
    });
});

chartHistory.on('legendselectchanged', event => {
    activeChartMetricGroup = 'custom';
    document.getElementById('chart-metric-filter').value = 'custom';
    updateChartAxes(event.selected);
    syncSeriesCheckboxes(event.selected);
});

const fullscreenChartButton = document.getElementById('btn-fullscreen-chart');
fullscreenChartButton?.addEventListener('click', async () => {
    const chartSection = document.querySelector('.chart-section');
    try {
        if (document.fullscreenElement) await document.exitFullscreen();
        else await chartSection.requestFullscreen();
    } catch (error) {
        console.error('Fullscreen error:', error);
        showToast('Không thể phóng to', 'Trình duyệt không cho phép mở toàn màn hình.', 'error');
    }
});

document.addEventListener('fullscreenchange', () => {
    if (fullscreenChartButton) {
        fullscreenChartButton.innerHTML = document.fullscreenElement
            ? '<i class="fa-solid fa-compress"></i><span>Thu nhỏ</span>'
            : '<i class="fa-solid fa-expand"></i><span>Phóng to</span>';
    }
    setTimeout(() => chartHistory.resize(), 100);
});

window.addEventListener('resize', () => {
    chartTemp.resize(); chartHum.resize(); chartEco2.resize(); chartTvoc.resize(); chartPm1_0.resize(); chartPm25.resize(); chartPm10.resize(); chartHistory.resize();
});

// --- UPDATE LOGIC ---
function toFiniteNumber(value, fallback = 0) {
    const number = Number(value);
    return Number.isFinite(number) ? number : fallback;
}

function pickNumber(data, keys, fallback = 0) {
    for (const key of keys) {
        if (data[key] !== undefined && data[key] !== null && data[key] !== '') {
            return toFiniteNumber(data[key], fallback);
        }
    }
    return fallback;
}

function normalizeStationData(data, stationId) {
    const normalizedData = {
        ...data,
        temp: pickNumber(data, ['temp', 'temperature', 'nhietdo']),
        hum: pickNumber(data, ['hum', 'humidity', 'doam']),
        pm1_0: pickNumber(data, ['pm1_0', 'pm1', 'pm01']),
        pm2_5: pickNumber(data, ['pm2_5', 'pm25', 'pm2.5']),
        pm10: pickNumber(data, ['pm10']),
        eco2: pickNumber(data, ['eco2', 'eCO2', 'co2'], 400),
        tvoc: pickNumber(data, ['tvoc', 'TVOC'])
    };
    if (stationId === 1 && !data._normalized) {
        Object.entries(LORA_DUST_CORRECTION_FACTORS).forEach(([metric, correctionFactor]) => {
            const rawValue = Number(normalizedData[metric]);
            if (Number.isFinite(rawValue)) {
                normalizedData[metric] = Math.round((rawValue / correctionFactor) * 10) / 10;
            }
        });
    }

    const aqiInfo = calculateAirQualityIndex(normalizedData.pm2_5, normalizedData.pm10);
    normalizedData.aqi = aqiInfo.val;
    normalizedData.aqiPollutant = aqiInfo.dominantPollutant;

    return normalizedData;
}

function publishLoRaData(data) {
    if (!mqttClient || !isMqttConnected) {
        setLoRaPublishStatus('Đã đọc USB Serial, nhưng MQTT chưa kết nối nên máy khác chưa xem được.', 'var(--status-moderate)');
        return;
    }
    const payload = {
        ...data,
        _stationId: 1,
        _source: webClientId,
        _normalized: true,
        _publishedAt: Date.now()
    };
    mqttClient.publish(getLoRaMqttTopic(), JSON.stringify(payload), { qos: 0, retain: true }, error => {
        if (error) {
            console.error('Không thể đẩy dữ liệu LoRa lên MQTT:', error);
            setLoRaPublishStatus('Lỗi đẩy dữ liệu LoRa lên MQTT. Kiểm tra broker/topic.', 'var(--status-offline)');
            return;
        }
        setLoRaPublishStatus(`Gateway đã đẩy lên MQTT lúc ${new Date(payload._publishedAt).toLocaleTimeString('vi-VN')}`, 'var(--status-excellent)');
    });
}

function storeStationData(data, stationId, options = {}) {
    data = normalizeStationData(data, stationId);
    const st = stationsData[stationId];
    const sourceTimestamp = Number(data._publishedAt || data.timestamp || data.timeMs);
    const sampleTimestamp = options.source === 'mqtt' && Number.isFinite(sourceTimestamp)
        ? sourceTimestamp
        : Date.now();
    st.current = data;
    st.lastTime = sampleTimestamp;
    st.timeoutAlerted = false;
    updateStationFreshness(stationId);

    const now = new Date(sampleTimestamp);
    const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');

    st.history.timestamp.push(sampleTimestamp);
    st.history.time.push(timeStr);
    st.history.temp.push(data.temp || 0);
    st.history.hum.push(data.hum || 0);
    st.history.pm1_0.push(data.pm1_0 || 0);
    st.history.pm25.push(data.pm2_5 || 0);
    st.history.pm10.push(data.pm10 || 0);
    st.history.eco2.push(data.eco2 || 400);
    st.history.tvoc.push(data.tvoc || 0);

    const historyExpired = () => st.history.timestamp[0] < sampleTimestamp - HISTORY_RETENTION_MS;
    while (st.history.time.length > MAX_HISTORY_POINTS || historyExpired()) {
        st.history.timestamp.shift(); st.history.time.shift(); st.history.temp.shift(); st.history.hum.shift(); st.history.pm1_0.shift(); st.history.pm25.shift(); st.history.pm10.shift(); st.history.eco2.shift(); st.history.tvoc.shift();
    }

    checkThresholds(data, stationId);

    const aqiInfo = { ...getAQICategory(data.aqi || 0), dominantPollutant: data.aqiPollutant };
    if (typeof updateMapMarker === 'function') {
        updateMapMarker(stationId, aqiInfo, data);
    }

    if (activeStation === stationId) {
        updateDashboardUI(data, st.history);
        analyzeAIAdvice();
    }

    if (stationId === 1 && options.source !== 'mqtt') {
        publishLoRaData(data);
    }
}

function resetAIAdvice() {
    const aiText = document.getElementById('ai-advice-text');
    const aiBox = document.getElementById('ai-advisory-box');
    if (aiText) aiText.innerHTML = 'Đang chờ đủ dữ liệu để phân tích xu hướng.';
    if (aiBox) {
        aiBox.style.background = 'linear-gradient(135deg, #ffffff, #f8fafc)';
        aiBox.style.borderColor = 'var(--card-border)';
        aiBox.style.boxShadow = '0 4px 15px rgba(0,0,0,0.03)';
    }
}

function resetGauges() {
    chartTemp.setOption({ series: [{ data: [{ value: 0, name: 'Nhiệt độ' }] }] });
    chartHum.setOption({ series: [{ data: [{ value: 0, name: 'Độ ẩm' }] }] });
    chartEco2.setOption({ series: [{ data: [{ value: 400, name: 'eCO2' }] }] });
    chartTvoc.setOption({ series: [{ data: [{ value: 0, name: 'TVOC' }] }] });
    chartPm1_0.setOption({ series: [{ data: [{ value: 0, name: 'PM1.0' }] }] });
    chartPm25.setOption({ series: [{ data: [{ value: 0, name: 'PM2.5' }] }] });
    chartPm10.setOption({ series: [{ data: [{ value: 0, name: 'PM10' }] }] });
}

function updateDashboardUI(data, history) {
    try {
        const aqiInfo = { ...getAQICategory(data.aqi || 0), dominantPollutant: data.aqiPollutant };
        valAqi.innerText = aqiInfo.val;
        labelAqi.innerText = `${aqiInfo.label} · do ${aqiInfo.dominantPollutant}`;
        aqiBanner.className = 'aqi-banner ' + aqiInfo.class;

        chartTemp.setOption({ series: [{ name: 'Nhiệt độ', data: [{ value: data.temp || 0, name: 'Nhiệt độ' }] }] });
        chartHum.setOption({ series: [{ name: 'Độ ẩm', data: [{ value: data.hum || 0, name: 'Độ ẩm' }] }] });
        chartEco2.setOption({ series: [{ name: 'eCO2', data: [{ value: data.eco2 || 0, name: 'eCO2' }] }] });
        chartTvoc.setOption({ series: [{ name: 'TVOC', data: [{ value: data.tvoc || 0, name: 'TVOC' }] }] });
        chartPm1_0.setOption({ series: [{ name: 'PM1.0', data: [{ value: data.pm1_0 || 0, name: 'PM1.0' }] }] });
        chartPm25.setOption({ series: [{ name: 'PM2.5', data: [{ value: data.pm2_5 || 0, name: 'PM2.5' }] }] });
        chartPm10.setOption({ series: [{ name: 'PM10', data: [{ value: data.pm10 || 0, name: 'PM10' }] }] });

        updateHistoryChart(history);
    } catch (e) {
        console.error("Error updating UI", e);
    }
}

// --- AI PREDICTIVE ANALYTICS ---
function linearRegression(y) {
    let n = y.length;
    if (n === 0) return 0;
    let sumX = 0, sumY = 0, sumXY = 0, sumX2 = 0;
    for (let i = 0; i < n; i++) {
        sumX += i;
        sumY += y[i];
        sumXY += i * y[i];
        sumX2 += i * i;
    }
    // Trả về hệ số góc (slope) - tốc độ thay đổi trên mỗi mẫu dữ liệu
    return (n * sumXY - sumX * sumY) / (n * sumX2 - sumX * sumX);
}

function analyzeAIAdvice() {
    const aiText = document.getElementById('ai-advice-text');
    const aiBox = document.getElementById('ai-advisory-box');
    const hist = stationsData[activeStation].history;

    if (!aiText) return;
    if (hist.pm25.length < 10) {
        resetAIAdvice();
        return;
    } // Cần ít nhất 10 mẫu để phân tích

    // Lấy 10 điểm dữ liệu gần nhất để hồi quy tuyến tính
    const len = hist.pm25.length;
    const recentPm = hist.pm25.slice(len - 10);
    const recentEco2 = hist.eco2.slice(len - 10);
    const recentTemp = hist.temp.slice(len - 10);
    const currHum = hist.hum[len - 1];

    const currPm = recentPm[9];
    const currEco2 = recentEco2[9];
    const currTemp = recentTemp[9];

    // Tính toán độ dốc (Slope) - Tốc độ thay đổi
    const slopePm = linearRegression(recentPm);
    const slopeEco2 = linearRegression(recentEco2);

    const L = appConfig.limits;
    let warningLevel = 0; // 0: Normal, 1: Warning, 2: Danger
    let adviceMsg = "Dữ liệu đo đạc hiện tại đang ổn định. Thuật toán dự báo không phát hiện xu hướng bất thường nào.";

    // Thuật toán Dự đoán (Predictive Algorithm)
    if (currEco2 > 800 && slopeEco2 > 2) {
        warningLevel = 2;
        // Mặc định ESP gửi data mỗi ~2s. Slope là ppm/2s. => Tốc độ ppm/phút = slope * 30
        const ratePerMin = (slopeEco2 * 30).toFixed(0);
        const minsToLimit = Math.max(1, Math.round((L.maxEco2 - currEco2) / (slopeEco2 * 30)));
        adviceMsg = `⚠️ <strong>Cảnh báo ngạt khí:</strong> eCO2 đang tăng liên tục với tốc độ <b>${ratePerMin} ppm/phút</b>. Dự báo sẽ chạm ngưỡng độc hại (${L.maxEco2} ppm) trong khoảng <b>${minsToLimit} phút</b> nữa. Yêu cầu bật quạt thông gió hoặc mở cửa sổ khẩn cấp!`;
    } else if (currPm > 40 && slopePm > 0.5) {
        warningLevel = 2;
        const ratePerMin = (slopePm * 30).toFixed(1);
        const minsToLimit = Math.max(1, Math.round((L.maxPm25 - currPm) / (slopePm * 30)));
        adviceMsg = `⚠️ <strong>Báo động khói bụi:</strong> PM2.5 đang tăng vọt <b>${ratePerMin} µg/m³/phút</b> (Dấu hiệu khói thuốc/đun nấu/cháy). Khả năng cao sẽ chạm ngưỡng nguy hiểm trong <b>${minsToLimit} phút</b>. Hãy đeo khẩu trang và kiểm tra xung quanh!`;
    } else if (slopePm < -0.5 || slopeEco2 < -2) {
        warningLevel = 0;
        adviceMsg = "🌱 <strong>Tiến triển tốt:</strong> Chất lượng không khí đang được cải thiện rõ rệt theo thời gian. Nồng độ các chất có hại đang giảm xuống. Tốc độ làm sạch không khí đang rất hiệu quả!";
    } else if (currEco2 > 1000) {
        warningLevel = 1;
        adviceMsg = "🔔 <strong>Khuyến cáo:</strong> Nồng độ eCO2 đang tích tụ ở mức cao. Không gian đang thiếu oxy lưu thông, người trong phòng có thể cảm thấy uể oải, buồn ngủ.";
    } else if (currTemp > 31 && currHum > 75) {
        warningLevel = 1;
        adviceMsg = "🔔 <strong>Chỉ số nhiệt (Heat Index) cao:</strong> Nhiệt độ và Độ ẩm đều ở mức cao gây cảm giác oi bức, đổ mồ hôi không bay hơi được. Khuyến cáo bật điều hòa ở chế độ Dry (Hút ẩm)!";
    }

    // Cập nhật giao diện
    aiText.innerHTML = adviceMsg;
    if (warningLevel === 2) {
        aiBox.style.background = 'linear-gradient(135deg, rgba(227, 24, 55, 0.1), rgba(227, 24, 55, 0.05))';
        aiBox.style.borderColor = 'rgba(227, 24, 55, 0.3)';
        aiBox.style.boxShadow = '0 0 15px rgba(227, 24, 55, 0.2)';
    } else if (warningLevel === 1) {
        aiBox.style.background = 'linear-gradient(135deg, rgba(245, 158, 11, 0.1), rgba(245, 158, 11, 0.05))';
        aiBox.style.borderColor = 'rgba(245, 158, 11, 0.3)';
        aiBox.style.boxShadow = 'none';
    } else {
        aiBox.style.background = 'linear-gradient(135deg, #ffffff, #f8fafc)';
        aiBox.style.borderColor = 'var(--card-border)';
        aiBox.style.boxShadow = '0 4px 15px rgba(0,0,0,0.03)';
    }
}

// --- GOOGLE GEMINI AI LOGIC ---
if (document.getElementById('btn-ask-gemini')) {
    document.getElementById('btn-ask-gemini').addEventListener('click', () => {
        const bubble = document.getElementById('ai-chat-bubble');
        bubble.classList.add('active');
        askGeminiAI();
    });
}

if (document.getElementById('close-chat')) {
    document.getElementById('close-chat').addEventListener('click', (e) => {
        e.stopPropagation();
        document.getElementById('ai-chat-bubble').classList.remove('active');
    });
}

async function askGeminiAI() {
    const btnAsk = document.getElementById('btn-ask-gemini');
    const chatText = document.getElementById('chat-text');
    const chatTime = document.getElementById('chat-time');
    const apiKey = appConfig.geminiKey;

    if (!apiKey) {
        showToast('Lỗi cấu hình', 'Vui lòng kiểm tra API Key trong Tab hệ thống.', 'error');
        return;
    }

    // Trạng thái chờ
    btnAsk.disabled = true;
    chatText.innerHTML = '<i class="fa-solid fa-microchip fa-spin"></i> Đang xử lý dữ liệu từ cảm biến laser...';

    // Xử lý dữ liệu đầu vào (Lọc bỏ các giá trị lỗi để tránh Bad Request)
    const hist = stationsData[activeStation].history;
    const len = hist.time.length;
    if (len < 5) {
        chatText.innerHTML = "⚠️ Cần thêm dữ liệu để thực hiện phân tích đa thông số.";
        btnAsk.disabled = false;
        return;
    }

    const startIndex = Math.max(0, len - 10);

    // Xây dựng bảng dữ liệu ĐẦY ĐỦ (Full Parameters)
    let dataTable = `Dữ liệu từ ${stationsData[activeStation].name}:\nT | PM1.0 | PM2.5 | PM10 | eCO2 | TVOC | T(°C) | H(%)\n`;
    for (let i = startIndex; i < len; i++) {
        const d = {
            p1: hist.pm1_0[i] || 0,
            p25: hist.pm25[i] || 0,
            p10: hist.pm10[i] || 0,
            co2: hist.eco2[i] || 400,
            voc: hist.tvoc[i] || 0,
            temp: hist.temp[i] || 0,
            hum: hist.hum[i] || 0
        };
        dataTable += `${hist.time[i]} | ${d.p1} | ${d.p25} | ${d.p10} | ${d.co2} | ${d.voc} | ${d.temp} | ${d.hum}\n`;
    }

    const promptText = `Bạn là chuyên gia phân tích dữ liệu môi trường. Hãy đánh giá bảng dữ liệu quan trắc thời gian thực sau:
${dataTable}
Yêu cầu:
1. Đánh giá sự tương quan giữa các chỉ số (ví dụ: Độ ẩm cao ảnh hưởng thế nào đến chỉ số bụi, hoặc sự liên quan giữa TVOC và eCO2).
2. Đưa ra nhận định về chất lượng không khí tổng thể theo tiêu chuẩn sức khỏe.
3. Dự báo xu hướng chất lượng không khí trong vài giờ tới (dựa trên đà thay đổi hiện tại) và đưa ra khuyến nghị xử lý thiết thực.
Trả lời: Chuyên sâu, súc tích, trình bày rõ ràng, có dùng emoji.`;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: promptText }] }]
            })
        });

        const result = await response.json();

        if (!response.ok) {
            console.error("Lỗi hệ thống:", result);
            throw new Error(result.error?.message || "Yêu cầu không hợp lệ");
        }

        const reply = result.candidates[0].content.parts[0].text;

        // Hiển thị kết quả với format chuyên nghiệp
        chatText.innerHTML = reply.replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
        chatTime.innerText = new Date().toLocaleTimeString('vi-VN');

    } catch (error) {
        console.error("Gemini Error:", error);
        chatText.innerHTML = `<span style="color: #ef4444;">❌ <strong>Lỗi phân tích:</strong> ${error.message}</span>`;
    } finally {
        btnAsk.disabled = false;
    }
}


// --- MQTT CLIENT ---
function connectMQTT() {
    if (mqttClient) {
        mqttClient.end();
        console.log("Closed existing MQTT connection.");
    }

    console.log(`Connecting to MQTT Broker: ${appConfig.mqttUrl}...`);
    statusDot.className = 'status-dot';
    statusText.textContent = 'Đang kết nối...';

    mqttClient = mqtt.connect(appConfig.mqttUrl, {
        username: appConfig.mqttUser,
        password: appConfig.mqttPass,
        clientId: webClientId,
        reconnectPeriod: 5000,
    });

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT Broker via WebSocket');
        isMqttConnected = true;
        document.getElementById('btn-save-mqtt').style.display = 'none';
        document.getElementById('btn-disconnect-mqtt').style.display = 'flex';
        updateLoRaGatewayInfo();
        if (!isLoraConnected) {
            setLoRaPublishStatus(`Viewer đang nghe dữ liệu LoRa tại ${getLoRaMqttTopic()}`, 'var(--status-excellent)');
        }
        updateConnectionStatusBadge();

        const topics = [appConfig.mqttTopic, getLoRaMqttTopic()];
        mqttClient.subscribe(topics, (err) => {
            if (!err) console.log(`Subscribed to ${topics.join(', ')}`);
        });
    });

    mqttClient.on('message', (topic, message) => {
        const payload = message.toString();
        try {
            const parsedData = JSON.parse(payload);
            if (topic === getLoRaMqttTopic()) {
                console.debug('Nhận dữ liệu LoRa qua MQTT:', parsedData);
                setLoRaPublishStatus(`Viewer nhận LoRa qua MQTT lúc ${new Date(parsedData._publishedAt || Date.now()).toLocaleTimeString('vi-VN')}`, 'var(--status-excellent)');
                storeStationData(parsedData, 1, { source: 'mqtt' }); // Trạm 1 LoRa từ gateway MQTT
                return;
            }
            if (topic === appConfig.mqttTopic) {
                const mqttStationId = Number(parsedData._stationId || parsedData.stationId || parsedData.station);
                const sourceName = String(parsedData._source || parsedData.source || '').toLowerCase();
                if (mqttStationId === 1 || sourceName.includes('lora')) {
                    console.debug('Nhận dữ liệu LoRa qua MQTT topic chính:', parsedData);
                    setLoRaPublishStatus(`Viewer nhận LoRa qua MQTT lúc ${new Date(parsedData._publishedAt || Date.now()).toLocaleTimeString('vi-VN')}`, 'var(--status-excellent)');
                    storeStationData(parsedData, 1, { source: 'mqtt' });
                    return;
                }
                storeStationData(parsedData, 2); // Trạm 2 là MQTT
            }
        } catch (e) {
            console.warn('Bỏ qua MQTT payload không hợp lệ:', payload, e);
        }
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT Error:', err);
        isMqttConnected = false;
        if (isLoraConnected) setLoRaPublishStatus('Gateway LoRa đang đọc COM nhưng mất kết nối MQTT.', 'var(--status-offline)');
        updateConnectionStatusBadge();
    });

    mqttClient.on('close', () => {
        isMqttConnected = false;
        if (isLoraConnected) setLoRaPublishStatus('Gateway LoRa đang đọc COM nhưng MQTT đã ngắt.', 'var(--status-offline)');
        updateConnectionStatusBadge();
    });
}

function disconnectMQTT() {
    if (mqttClient) {
        mqttClient.end();
        mqttClient = null;
    }
    isMqttConnected = false;
    document.getElementById('btn-save-mqtt').style.display = 'flex';
    document.getElementById('btn-disconnect-mqtt').style.display = 'none';
    if (isLoraConnected) setLoRaPublishStatus('Gateway LoRa đang đọc COM nhưng MQTT đã ngắt.', 'var(--status-offline)');
    else setLoRaPublishStatus('Viewer chưa kết nối MQTT nên chưa nhận được LoRa.', 'var(--status-offline)');
    updateConnectionStatusBadge();
    showToast('Đã ngắt', 'Đã ngắt kết nối MQTT', 'warning');
}

document.getElementById('btn-disconnect-mqtt').addEventListener('click', disconnectMQTT);

// Start MQTT Connection
connectMQTT();

// ==========================================
// LORA WEB SERIAL API LOGIC
// ==========================================
let serialPort = null;
let serialReader = null;
let keepReading = false; // Cờ điều khiển vòng lặp
let readLoopPromise = null; // Theo dõi luồng đọc

async function connectLoRa() {
    try {
        if (!navigator.serial) {
            let errorMsg = 'Trình duyệt không hỗ trợ Web Serial API.';
            if (window.isSecureContext === false) {
                errorMsg += ' (Yêu cầu HTTPS hoặc localhost để sử dụng tính năng này)';
            } else {
                errorMsg += ' (Vui lòng dùng Chrome hoặc Edge mới nhất)';
            }
            showToast('Lỗi trình duyệt', errorMsg, 'error');
            return;
        }

        const baudRate = parseInt(document.getElementById('cfg-lora-baud').value) || 9600;
        serialPort = await navigator.serial.requestPort();
        await serialPort.open({ baudRate: baudRate });

        document.getElementById('lora-status-text').innerText = `Đã kết nối (COM @ ${baudRate})`;
        document.getElementById('lora-status-text').style.color = 'var(--status-excellent)';
        document.getElementById('btn-connect-lora').style.display = 'none';
        document.getElementById('btn-disconnect-lora').style.display = 'flex';

        showToast('Thành công', 'Đã kết nối bộ thu LoRa', 'success');

        isLoraConnected = true;
        updateLoRaGatewayInfo();
        setLoRaPublishStatus(
            isMqttConnected
                ? `Gateway sẵn sàng đẩy Trạm 1 lên ${getLoRaMqttTopic()}`
                : 'Gateway đã mở COM, đang chờ MQTT để máy khác xem được.',
            isMqttConnected ? 'var(--status-excellent)' : 'var(--status-moderate)'
        );
        updateConnectionStatusBadge();

        readSerialLoop();
    } catch (e) {
        console.error("Lỗi kết nối LoRa:", e);
        showToast('Lỗi', 'Không thể mở cổng COM hoặc bạn chưa chọn cổng', 'error');
    }
}

async function disconnectLoRa() {
    try {
        console.log("Đang bắt đầu ngắt kết nối LoRa...");
        keepReading = false; // Bước 1: Hạ cờ dừng vòng lặp

        if (serialReader) {
            // Bước 2: Hủy lệnh read() đang treo để luồng chạy xuống finally
            await serialReader.cancel().catch(() => { });
        }

        if (readLoopPromise) {
            // Bước 3: Đợi cho đến khi vòng lặp thoát hẳn và nhả Lock
            await readLoopPromise;
            readLoopPromise = null;
        }

        if (serialPort) {
            // Bước 4: Bây giờ đóng port sẽ cực kỳ an toàn, không bao giờ bị đơ
            await serialPort.close();
            serialPort = null;
            console.log("Đã đóng cổng Serial thành công.");
        }

        // Cập nhật giao diện UI
        document.getElementById('lora-status-text').innerText = 'Chưa kết nối';
        document.getElementById('lora-status-text').style.color = 'var(--status-offline)';
        document.getElementById('btn-connect-lora').style.display = 'flex';
        document.getElementById('btn-disconnect-lora').style.display = 'none';

        isLoraConnected = false;
        updateLoRaGatewayInfo();
        setLoRaPublishStatus(
            isMqttConnected
                ? `Viewer đang nghe dữ liệu LoRa tại ${getLoRaMqttTopic()}`
                : 'Viewer chưa kết nối MQTT nên chưa nhận được LoRa.',
            isMqttConnected ? 'var(--status-excellent)' : 'var(--status-offline)'
        );
        updateConnectionStatusBadge();
        showToast('Đã ngắt', 'Đã đóng cổng COM an toàn', 'warning');

    } catch (e) {
        console.error("Lỗi ngắt kết nối LoRa:", e);
        showToast('Lỗi', 'Không thể ngắt kết nối sạch sẽ', 'error');
    }
}

async function readSerialLoop() {
    keepReading = true;
    const PACKET_SIZE = 16;
    let buffer = new Uint8Array(0);
    let serialMode = null;
    let jsonTextBuffer = '';
    const textDecoder = new TextDecoder();

    function parseBinaryLoRaPacket(packet) {
        const view = new DataView(packet.buffer);
        return {
            pm1_0: view.getUint16(0, true),
            pm2_5: view.getUint16(2, true),
            pm10: view.getUint16(4, true),
            temp: view.getInt16(6, true) / 10.0,
            hum: view.getInt16(8, true) / 10.0,
            aqi: view.getUint16(10, true),
            tvoc: view.getUint16(12, true),
            eco2: view.getUint16(14, true)
        };
    }

    function handleJsonLoRaChunk(value) {
        jsonTextBuffer += textDecoder.decode(value, { stream: true });
        const lines = jsonTextBuffer.split(/\r?\n/);
        jsonTextBuffer = lines.pop() || '';

        lines.forEach(line => {
            const trimmed = line.trim();
            if (!trimmed) return;
            const jsonStart = trimmed.indexOf('{');
            const jsonEnd = trimmed.lastIndexOf('}');
            const jsonText = jsonStart >= 0 && jsonEnd > jsonStart
                ? trimmed.slice(jsonStart, jsonEnd + 1)
                : trimmed;
            try {
                const parsedData = JSON.parse(jsonText);
                console.debug('Nhận dữ liệu LoRa qua Serial JSON:', parsedData);
                storeStationData(parsedData, 1);
            } catch (error) {
                console.warn('Bỏ qua dòng LoRa JSON không hợp lệ:', trimmed, error);
            }
        });

        const pendingJson = jsonTextBuffer.trim();
        const pendingStart = pendingJson.indexOf('{');
        const pendingEnd = pendingJson.lastIndexOf('}');
        if (pendingStart >= 0 && pendingEnd > pendingStart) {
            try {
                const parsedData = JSON.parse(pendingJson.slice(pendingStart, pendingEnd + 1));
                console.debug('Nhận dữ liệu LoRa qua Serial JSON:', parsedData);
                storeStationData(parsedData, 1);
                jsonTextBuffer = pendingJson.slice(pendingEnd + 1);
            } catch (error) {
                // Chờ thêm byte nếu JSON chưa hoàn chỉnh.
            }
        }
    }

    // Bọc vòng lặp vào promise để có thể 'await' ở hàm disconnect
    readLoopPromise = (async () => {
        while (serialPort && serialPort.readable && keepReading) {
            serialReader = serialPort.readable.getReader();
            try {
                while (keepReading) {
                    const { value, done } = await serialReader.read();
                    if (done || !keepReading) break;

                    // Logic ghép nối và xử lý Binary (Giữ nguyên của bạn)
                    let newBuffer = new Uint8Array(buffer.length + value.length);
                    newBuffer.set(buffer);
                    newBuffer.set(value, buffer.length);
                    buffer = newBuffer;

                    if (serialMode !== 'binary') {
                        const previewText = textDecoder.decode(buffer, { stream: false }).trimStart();
                        if (previewText.includes('{') || /^[\x09\x0a\x0d\x20-\x7e]*$/.test(previewText)) serialMode = 'json';
                    }

                    if (serialMode === 'json') {
                        handleJsonLoRaChunk(value);
                        buffer = new Uint8Array(0);
                        continue;
                    }

                    if (!serialMode && buffer.length >= PACKET_SIZE) serialMode = 'binary';

                    while (buffer.length >= PACKET_SIZE) {
                        const packet = buffer.slice(0, PACKET_SIZE);
                        buffer = buffer.slice(PACKET_SIZE);
                        storeStationData(parseBinaryLoRaPacket(packet), 1); // Trạm 1 là LoRa
                    }
                }
            } catch (error) {
                // Chỉ log lỗi nếu không phải do chúng ta chủ động ngắt
                if (keepReading) console.error("Lỗi đọc dữ liệu:", error);
            } finally {
                serialReader.releaseLock();
                serialReader = null;
                console.log("Đã giải phóng Serial Reader Lock");
            }
        }
    })();
}

document.getElementById('btn-connect-lora').addEventListener('click', connectLoRa);
document.getElementById('btn-disconnect-lora').addEventListener('click', disconnectLoRa);

// ==========================================
// THÔNG BÁO VÀ THEO DÕI TRẠNG THÁI KẾT NỐI
// ==========================================
function updateConnectionStatusBadge() {
    let errorTexts = [];
    let okTexts = [];

    if (isLoraConnected) {
        if (stationsData[1].timeoutAlerted) errorTexts.push('LoRa');
        else okTexts.push('LoRa');
    }
    if (isMqttConnected) {
        if (stationsData[2].timeoutAlerted) errorTexts.push('MQTT');
        else okTexts.push('MQTT');
    }

    if (!isLoraConnected && !isMqttConnected) {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Mất kết nối hoàn toàn';
        return;
    }

    if (errorTexts.length > 0) {
        statusDot.className = 'status-dot error';
        if (okTexts.length > 0) {
            statusText.textContent = `Lỗi mất tín hiệu: ${errorTexts.join(' & ')} (Đang nhận: ${okTexts.join(' & ')})`;
        } else {
            statusText.textContent = `Lỗi: Mất tín hiệu (${errorTexts.join(' & ')})`;
        }
    } else {
        statusDot.className = 'status-dot connected';
        statusText.textContent = `Đã kết nối (${okTexts.join(' + ')})`;
    }
}

function updateStationFreshness(stationId) {
    const element = document.getElementById(`station-freshness-${stationId}`);
    const station = stationsData[stationId];
    if (!element || !station || Object.keys(station.current).length === 0) return;

    const ageSeconds = Math.max(0, Math.floor((Date.now() - station.lastTime) / 1000));
    if (station.timeoutAlerted || ageSeconds > 20) {
        element.textContent = 'Mất tín hiệu';
        element.dataset.state = 'offline';
    } else {
        element.textContent = ageSeconds < 3 ? 'Vừa cập nhật' : `${ageSeconds} giây trước`;
        element.dataset.state = 'live';
    }
}

// Kiểm tra mất dữ liệu quá 20s cho từng trạm
setInterval(() => {
    const now = Date.now();

    if (isLoraConnected) {
        if (now - stationsData[1].lastTime > 20000) {
            if (!stationsData[1].timeoutAlerted) {
                showToast('Cảnh báo dữ liệu', 'Trạm 1 (LoRa) mất tín hiệu hơn 20s!', 'error');
                stationsData[1].timeoutAlerted = true;
            }
        } else {
            stationsData[1].timeoutAlerted = false;
        }
    }

    if (isMqttConnected) {
        if (now - stationsData[2].lastTime > 20000) {
            if (!stationsData[2].timeoutAlerted) {
                showToast('Cảnh báo dữ liệu', 'Trạm 2 (MQTT) mất tín hiệu hơn 20s!', 'error');
                stationsData[2].timeoutAlerted = true;
            }
        } else {
            stationsData[2].timeoutAlerted = false;
        }
    }

    updateStationFreshness(1);
    updateStationFreshness(2);
    updateConnectionStatusBadge();
}, 1000);

// ==========================================
// KHÍ TƯỢNG THỦY VĂN - OPEN-METEO
// ==========================================
const weatherCache = {};
const WEATHER_CACHE_MS = 10 * 60 * 1000;

function getWeatherInfo(code, isDay = 1) {
    const weatherCodes = {
        0: [isDay ? '☀️' : '🌙', 'Trời quang'],
        1: [isDay ? '🌤️' : '🌙', 'Ít mây'],
        2: ['⛅', 'Mây rải rác'],
        3: ['☁️', 'Nhiều mây'],
        45: ['🌫️', 'Sương mù'], 48: ['🌫️', 'Sương mù đóng băng'],
        51: ['🌦️', 'Mưa phùn nhẹ'], 53: ['🌦️', 'Mưa phùn'], 55: ['🌧️', 'Mưa phùn dày'],
        56: ['🌧️', 'Mưa phùn lạnh'], 57: ['🌧️', 'Mưa phùn lạnh mạnh'],
        61: ['🌦️', 'Mưa nhẹ'], 63: ['🌧️', 'Mưa vừa'], 65: ['🌧️', 'Mưa to'],
        66: ['🌧️', 'Mưa lạnh'], 67: ['🌧️', 'Mưa lạnh mạnh'],
        71: ['🌨️', 'Tuyết nhẹ'], 73: ['🌨️', 'Tuyết vừa'], 75: ['❄️', 'Tuyết dày'], 77: ['🌨️', 'Hạt tuyết'],
        80: ['🌦️', 'Mưa rào nhẹ'], 81: ['🌧️', 'Mưa rào'], 82: ['⛈️', 'Mưa rào rất to'],
        85: ['🌨️', 'Mưa tuyết nhẹ'], 86: ['🌨️', 'Mưa tuyết mạnh'],
        95: ['⛈️', 'Dông'], 96: ['⛈️', 'Dông kèm mưa đá'], 99: ['⛈️', 'Dông mưa đá mạnh']
    };
    return weatherCodes[code] || ['🌡️', 'Chưa xác định'];
}

function buildWeatherAdvisory(data) {
    const notes = [];
    const todayRain = Number(data.daily.precipitation_sum[0] || 0);
    const rainChance = Number(data.daily.precipitation_probability_max[0] || 0);
    const maxUv = Number(data.daily.uv_index_max[0] || 0);
    const gust = Number(data.daily.wind_gusts_10m_max[0] || 0);
    if (todayRain >= 50) notes.push('⚠️ Nguy cơ mưa rất lớn/ngập cục bộ, cần theo dõi thoát nước và hạn chế đi qua vùng trũng.');
    else if (todayRain >= 20) notes.push('🌧️ Có khả năng mưa lớn, nên chuẩn bị phương án che chắn và thoát nước.');
    else if (rainChance >= 60) notes.push(`☔ Xác suất mưa hôm nay ${Math.round(rainChance)}%, nên mang theo áo mưa.`);
    if (gust >= 50) notes.push(`💨 Gió giật có thể đạt ${Math.round(gust)} km/h, lưu ý vật dụng ngoài trời.`);
    if (maxUv >= 8) notes.push(`🧴 UV rất cao (${maxUv.toFixed(1)}), hạn chế phơi nắng vào buổi trưa.`);
    if (!notes.length) notes.push('✅ Điều kiện khí tượng hiện chưa có dấu hiệu nguy hiểm nổi bật.');
    return notes.join(' ');
}

function renderWeather(data, stationId) {
    const current = data.current;
    const daily = data.daily;
    const [icon, description] = getWeatherInfo(current.weather_code, current.is_day);
    document.getElementById('weather-location').textContent = `${STATION_LOCATIONS[stationId].name} · cập nhật ${new Date().toLocaleTimeString('vi-VN', { hour: '2-digit', minute: '2-digit' })}`;
    document.getElementById('weather-icon').textContent = icon;
    document.getElementById('weather-temp').textContent = `${Math.round(current.temperature_2m)}°`;
    document.getElementById('weather-description').textContent = description;
    document.getElementById('weather-feels-like').textContent = `Cảm giác như ${Math.round(current.apparent_temperature)}°C`;
    document.getElementById('weather-humidity').textContent = `${Math.round(current.relative_humidity_2m)}%`;
    document.getElementById('weather-rain').textContent = `${Number(current.precipitation || 0).toFixed(1)} mm`;
    document.getElementById('weather-wind').textContent = `${Math.round(current.wind_speed_10m)} km/h`;
    document.getElementById('weather-pressure').textContent = `${Math.round(current.surface_pressure)} hPa`;
    document.getElementById('weather-advisory').textContent = buildWeatherAdvisory(data);

    const formatter = new Intl.DateTimeFormat('vi-VN', { weekday: 'short', day: '2-digit', month: '2-digit' });
    document.getElementById('daily-forecast').innerHTML = daily.time.map((date, index) => {
        const [dayIcon, dayDescription] = getWeatherInfo(daily.weather_code[index]);
        const dayLabel = index === 0 ? 'Hôm nay' : formatter.format(new Date(`${date}T00:00:00`));
        return `<article class="forecast-day ${index === 0 ? 'today' : ''}" title="${dayDescription}">
            <strong>${dayLabel}</strong>
            <span class="forecast-icon">${dayIcon}</span>
            <div class="forecast-temps">${Math.round(daily.temperature_2m_max[index])}° <span class="forecast-low">/ ${Math.round(daily.temperature_2m_min[index])}°</span></div>
            <small><i class="fa-solid fa-droplet"></i> ${Math.round(daily.precipitation_probability_max[index] || 0)}% · ${Number(daily.precipitation_sum[index] || 0).toFixed(1)} mm</small>
        </article>`;
    }).join('');

    document.getElementById('weather-loading').hidden = true;
    document.getElementById('weather-error').hidden = true;
    document.getElementById('weather-content').hidden = false;
}

async function loadWeather(stationId = activeWeatherStation, force = false) {
    const location = STATION_LOCATIONS[stationId];
    const cached = weatherCache[stationId];
    if (!force && cached && Date.now() - cached.time < WEATHER_CACHE_MS) {
        renderWeather(cached.data, stationId);
        return;
    }

    const loading = document.getElementById('weather-loading');
    const error = document.getElementById('weather-error');
    const content = document.getElementById('weather-content');
    loading.hidden = false;
    error.hidden = true;
    if (!cached) content.hidden = true;

    const params = new URLSearchParams({
        latitude: location.latitude,
        longitude: location.longitude,
        current: 'temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,rain,weather_code,cloud_cover,surface_pressure,wind_speed_10m,wind_direction_10m,wind_gusts_10m',
        daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,wind_gusts_10m_max,uv_index_max,sunrise,sunset',
        timezone: 'auto',
        forecast_days: '7'
    });

    try {
        const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        if (!data.current || !data.daily) throw new Error('Dữ liệu dự báo không đầy đủ');
        weatherCache[stationId] = { time: Date.now(), data };
        if (stationId === activeWeatherStation) renderWeather(data, stationId);
    } catch (fetchError) {
        console.error('Weather API error:', fetchError);
        loading.hidden = true;
        error.hidden = false;
        error.innerHTML = '<i class="fa-solid fa-cloud-bolt"></i> Không thể tải dự báo. Vui lòng kiểm tra Internet rồi thử lại.';
        if (cached) renderWeather(cached.data, stationId);
    }
}

document.getElementById('btn-refresh-weather')?.addEventListener('click', () => loadWeather(activeWeatherStation, true));
loadWeather(activeWeatherStation);
setInterval(() => loadWeather(activeWeatherStation, true), 15 * 60 * 1000);

// ==========================================
// TÍNH NĂNG MỚI: BẢN ĐỒ VỊ TRÍ TRẠM (LEAFLET.JS)
// ==========================================
let map;
let marker1, marker2;

function initMap() {
    map = L.map('station-map');

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        attribution: '© OpenStreetMap contributors',
        maxZoom: 19
    }).addTo(map);

    // Marker Trạm 1 (LoRa)
    marker1 = L.circleMarker([20.984701, 105.798850], {
        color: '#a6a6a6',
        fillColor: '#a6a6a6',
        fillOpacity: 0.8,
        radius: 12
    }).addTo(map).bindPopup('<b>Trạm 1 (LoRa)</b><br>Đang chờ dữ liệu...');

    // Marker Trạm 2 (MQTT)
    marker2 = L.circleMarker([21.29229170656175, 105.58406173400247], {
        color: '#a6a6a6',
        fillColor: '#a6a6a6',
        fillOpacity: 0.8,
        radius: 12
    }).addTo(map).bindPopup('<b>Trạm 2 (MQTT)</b><br>Đang chờ dữ liệu...');

    const group = new L.featureGroup([marker1, marker2]);
    map.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 15 });

    // Xử lý lỗi map không tải hết gạch (tiles) do nằm trong thẻ bị ẩn ban đầu
    setTimeout(() => {
        map.invalidateSize();
        map.fitBounds(group.getBounds(), { padding: [50, 50], maxZoom: 15 });
    }, 500);
}

function updateMapMarker(stationId, aqiInfo, data) {
    if (!map) return;
    const marker = stationId === 1 ? marker1 : marker2;
    // Lấy màu từ biến CSS
    const color = getComputedStyle(document.documentElement).getPropertyValue(`--status-${aqiInfo.class}`).trim() || '#a6a6a6';

    marker.setStyle({ color: color, fillColor: color });
    marker.setPopupContent(`
        <b>Trạm ${stationId} ${stationId === 1 ? '(LoRa)' : '(MQTT)'}</b><br>
        AQI: <b>${aqiInfo.val}</b> (${aqiInfo.label})<br>
        Nhiệt độ: ${data.temp}°C | Độ ẩm: ${data.hum}%<br>
        PM2.5: ${data.pm2_5} µg/m³
    `);
}

document.addEventListener('DOMContentLoaded', initMap);

// Nếu chuyển sang tab dashboard, cần báo map vẽ lại
document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        if (btn.dataset.target === 'dashboard-tab' && map) {
            setTimeout(() => map.invalidateSize(), 100);
        }
    });
});

// ==========================================
// TÍNH NĂNG MỚI: PUSH NOTIFICATION (TRÌNH DUYỆT)
// ==========================================
let notificationCooldown = {};

function requestNotificationPermission() {
    if ("Notification" in window) {
        if (Notification.permission !== "granted" && Notification.permission !== "denied") {
            Notification.requestPermission();
        }
    }
}

// Yêu cầu quyền ngay khi tải web
requestNotificationPermission();

function triggerBrowserNotification(stationId, paramName, message) {
    if (!("Notification" in window) || Notification.permission !== "granted") return;

    const alertKey = `${stationId}_${paramName}_browser`;
    const now = Date.now();
    // Cooldown 1 phút cho Notification để tránh spam
    if (notificationCooldown[alertKey] && (now - notificationCooldown[alertKey] < 60000)) {
        return;
    }
    notificationCooldown[alertKey] = now;

    new Notification(`CẢNH BÁO: Trạm ${stationId}`, {
        body: `${message}. Vui lòng kiểm tra hệ thống!`,
        icon: 'logo.png' // Thêm logo.png của bạn nếu có
    });
}

// ==========================================
// TÍNH NĂNG MỚI: XUẤT DỮ LIỆU EXCEL
// ==========================================
if (document.getElementById('btn-export-excel')) {
    document.getElementById('btn-export-excel').addEventListener('click', () => {
        const stData = stationsData[activeStation].history;
        if (stData.time.length === 0) {
            showToast('Lỗi xuất dữ liệu', 'Không có dữ liệu để xuất!', 'error');
            return;
        }

        const dataRows = [];
        for (let i = 0; i < stData.time.length; i++) {
            dataRows.push({
                "Thời gian": stData.time[i],
                "Nhiệt độ (°C)": stData.temp[i],
                "Độ ẩm (%)": stData.hum[i],
                "PM1.0 (µg/m³)": stData.pm1_0[i],
                "PM2.5 (µg/m³)": stData.pm25[i],
                "PM10 (µg/m³)": stData.pm10[i],
                "eCO2 (ppm)": stData.eco2[i],
                "TVOC (ppb)": stData.tvoc[i]
            });
        }

        const worksheet = XLSX.utils.json_to_sheet(dataRows);
        const workbook = XLSX.utils.book_new();
        XLSX.utils.book_append_sheet(workbook, worksheet, `Trạm_${activeStation}_Data`);

        // Tải file xuống
        XLSX.writeFile(workbook, `Bao_cao_Tram${activeStation}_${new Date().toISOString().slice(0, 10)}.xlsx`);
        showToast('Thành công', 'Đã tải xuống file Excel!', 'success');
    });
}
