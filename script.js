// --- LOAD CONFIGURATIONS ---
const DEFAULT_CONFIG = {
    mqttUrl: SYS_CONFIG.MQTT_DEFAULT_URL,
    mqttUser: SYS_CONFIG.MQTT_DEFAULT_USER,
    mqttPass: SYS_CONFIG.MQTT_DEFAULT_PASS,
    mqttTopic: SYS_CONFIG.MQTT_DEFAULT_TOPIC,
    email: '',
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
localStorage.setItem('utt_air_config', JSON.stringify(appConfig));

// --- CÁC BIẾN TRẠNG THÁI ---
let mqttClient = null;
let lastEmailSentTime = {};
let isMqttConnected = false;
let isLoraConnected = false;

// Cấu trúc mới hỗ trợ 2 trạm
const stationsData = {
    1: { name: 'Trạm 1 (LoRa)', history: { time: [], temp: [], hum: [], pm1_0: [], pm25: [], pm10: [], eco2: [], tvoc: [] }, current: {}, lastTime: Date.now(), timeoutAlerted: false },
    2: { name: 'Trạm 2 (MQTT)', history: { time: [], temp: [], hum: [], pm1_0: [], pm25: [], pm10: [], eco2: [], tvoc: [] }, current: {}, lastTime: Date.now(), timeoutAlerted: false }
};
let activeStation = 1;
const MAX_DATA_POINTS = 30;

// --- AQI MAPPING ---
// ENS160 trả về 1-5 (UBA Index). Chuyển sang EPA AQI (0-500)
function mapENS160toEPA(ensAqi) {
    switch (Math.round(ensAqi)) {
        case 1: return { val: 25, label: 'Tuyệt vời', class: 'excellent' }; // 0-50
        case 2: return { val: 75, label: 'Tốt', class: 'good' }; // 51-100
        case 3: return { val: 125, label: 'Trung bình', class: 'moderate' }; // 101-150
        case 4: return { val: 175, label: 'Kém', class: 'poor' }; // 151-200
        case 5: return { val: 250, label: 'Độc hại', class: 'unhealthy' }; // 201-300+
        default: return { val: 0, label: 'Không xác định', class: 'offline' };
    }
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
        } else {
            valAqi.innerText = '--';
            labelAqi.innerText = 'Đang chờ dữ liệu...';
            aqiBanner.className = 'aqi-banner';
        }
    });
});

// --- INIT CONFIG FORMS ---
function initConfigForms() {
    document.getElementById('cfg-mqtt-url').value = appConfig.mqttUrl;
    document.getElementById('cfg-mqtt-user').value = appConfig.mqttUser;
    document.getElementById('cfg-mqtt-pass').value = appConfig.mqttPass;
    document.getElementById('cfg-mqtt-topic').value = appConfig.mqttTopic;

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
    const emailStr = [e1, e2, e3].filter(e => e !== '').join(', ');

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
    emailjs.init(SYS_CONFIG.EMAILJS_PUBLIC_KEY);
})();


function triggerEmailAlert(stationId, paramName, currentValue, limitValue, message, fullData) {
    if (!appConfig.email) return;

    const now = Date.now();
    const alertKey = `${stationId}_${paramName}`;
    // Check cooldown
    if (lastEmailSentTime[alertKey] && (now - lastEmailSentTime[alertKey] < SYS_CONFIG.EMAIL_COOLDOWN_MS)) {
        return; // Skip if in cooldown
    }

    lastEmailSentTime[alertKey] = now;
    const emailMsg = `CẢNH BÁO [Trạm ${stationId}]: ${message}. Giá trị hiện tại: ${currentValue}, Giới hạn: ${limitValue}.`;

    showToast('Gửi Email Cảnh báo', `Đang gửi email tới ${appConfig.email}...`, 'warning');
    console.log("SENDING EMAIL to " + appConfig.email + " -> " + emailMsg);

    emailjs.send(SYS_CONFIG.EMAILJS_SERVICE_ID, SYS_CONFIG.EMAILJS_TEMPLATE_ID, {
        to_email: appConfig.email,
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
    }).then(() => {
        showToast('Thành công', `Đã gửi email cảnh báo (Trạm ${stationId})!`, 'success');
    }).catch(err => {
        console.error("EmailJS Error:", err);
    });
}

function checkThresholds(data, stationId) {
    const L = appConfig.limits;
    if (data.temp > L.maxTemp) { triggerEmailAlert(stationId, 'Nhiệt độ', data.temp, L.maxTemp, 'Nhiệt độ QUÁ CAO', data); triggerBrowserNotification(stationId, 'Nhiệt độ', `Nhiệt độ QUÁ CAO: ${data.temp}°C`); }
    if (data.temp < L.minTemp) { triggerEmailAlert(stationId, 'Nhiệt độ', data.temp, L.minTemp, 'Nhiệt độ QUÁ THẤP', data); triggerBrowserNotification(stationId, 'Nhiệt độ', `Nhiệt độ QUÁ THẤP: ${data.temp}°C`); }
    if (data.hum > L.maxHum) { triggerEmailAlert(stationId, 'Độ ẩm', data.hum, L.maxHum, 'Độ ẩm QUÁ CAO', data); triggerBrowserNotification(stationId, 'Độ ẩm', `Độ ẩm QUÁ CAO: ${data.hum}%`); }
    if (data.hum < L.minHum) { triggerEmailAlert(stationId, 'Độ ẩm', data.hum, L.minHum, 'Độ ẩm QUÁ THẤP', data); triggerBrowserNotification(stationId, 'Độ ẩm', `Độ ẩm QUÁ THẤP: ${data.hum}%`); }
    if (data.pm2_5 > L.maxPm25) { triggerEmailAlert(stationId, 'Bụi mịn PM2.5', data.pm2_5, L.maxPm25, 'Bụi mịn PM2.5 vượt ngưỡng', data); triggerBrowserNotification(stationId, 'PM2.5', `Bụi mịn PM2.5 vượt ngưỡng: ${data.pm2_5} µg/m³`); }
    if (data.eco2 > L.maxEco2) { triggerEmailAlert(stationId, 'eCO2', data.eco2, L.maxEco2, 'Nồng độ CO2 vượt ngưỡng', data); triggerBrowserNotification(stationId, 'eCO2', `Nồng độ eCO2 vượt ngưỡng: ${data.eco2} ppm`); }
    if (data.tvoc > L.maxTvoc) { triggerEmailAlert(stationId, 'TVOC', data.tvoc, L.maxTvoc, 'Nồng độ TVOC vượt ngưỡng', data); triggerBrowserNotification(stationId, 'TVOC', `Nồng độ TVOC vượt ngưỡng: ${data.tvoc} ppb`); }

    const mappedAqi = mapENS160toEPA(data.aqi || 0).val;
    if (mappedAqi > L.maxAqi) { triggerEmailAlert(stationId, 'Chỉ số AQI', mappedAqi, L.maxAqi, 'Chỉ số AQI ở mức nguy hiểm', data); triggerBrowserNotification(stationId, 'AQI', `Chỉ số AQI nguy hiểm: ${mappedAqi}`); }
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

window.addEventListener('resize', () => {
    chartTemp.resize(); chartHum.resize(); chartEco2.resize(); chartTvoc.resize(); chartPm1_0.resize(); chartPm25.resize(); chartPm10.resize(); chartHistory.resize();
});

// --- UPDATE LOGIC ---
function storeStationData(data, stationId) {
    const st = stationsData[stationId];
    st.current = data;
    st.lastTime = Date.now();
    st.timeoutAlerted = false;

    const now = new Date();
    const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');

    st.history.time.push(timeStr);
    st.history.temp.push(data.temp || 0);
    st.history.hum.push(data.hum || 0);
    st.history.pm1_0.push(data.pm1_0 || 0);
    st.history.pm25.push(data.pm2_5 || 0);
    st.history.pm10.push(data.pm10 || 0);
    st.history.eco2.push(data.eco2 || 400);
    st.history.tvoc.push(data.tvoc || 0);

    if (st.history.time.length > MAX_DATA_POINTS) {
        st.history.time.shift(); st.history.temp.shift(); st.history.hum.shift(); st.history.pm1_0.shift(); st.history.pm25.shift(); st.history.pm10.shift(); st.history.eco2.shift(); st.history.tvoc.shift();
    }

    checkThresholds(data, stationId);

    const aqiInfo = mapENS160toEPA(data.aqi || 0);
    if (typeof updateMapMarker === 'function') {
        updateMapMarker(stationId, aqiInfo, data);
    }

    if (activeStation === stationId) {
        updateDashboardUI(data, st.history);
        analyzeAIAdvice();
    }
}

function updateDashboardUI(data, history) {
    try {
        const aqiInfo = mapENS160toEPA(data.aqi || 0);
        valAqi.innerText = aqiInfo.val;
        labelAqi.innerText = aqiInfo.label;
        aqiBanner.className = 'aqi-banner ' + aqiInfo.class;

        chartTemp.setOption({ series: [{ data: [{ value: data.temp || 0, name: 'Nhiệt độ' }] }] });
        chartHum.setOption({ series: [{ data: [{ value: data.hum || 0, name: 'Độ ẩm' }] }] });
        chartEco2.setOption({ series: [{ data: [{ value: data.eco2 || 0, name: 'eCO2' }] }] });
        chartTvoc.setOption({ series: [{ data: [{ value: data.tvoc || 0, name: 'TVOC' }] }] });
        chartPm1_0.setOption({ series: [{ data: [{ value: data.pm1_0 || 0, name: 'PM1.0' }] }] });
        chartPm25.setOption({ series: [{ data: [{ value: data.pm2_5 || 0, name: 'PM2.5' }] }] });
        chartPm10.setOption({ series: [{ data: [{ value: data.pm10 || 0, name: 'PM10' }] }] });

        chartHistory.setOption({
            xAxis: { data: history.time },
            series: [
                { data: history.temp },
                { data: history.hum },
                { data: history.pm1_0 },
                { data: history.pm25 },
                { data: history.pm10 },
                { data: history.eco2 },
                { data: history.tvoc }
            ]
        });
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

    if (!aiText || hist.pm25.length < 10) return; // Cần ít nhất 10 mẫu để phân tích

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
            // Nếu vẫn 400, log này sẽ chỉ chính xác nguyên nhân
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
        clientId: 'web-client-' + Math.random().toString(16).substr(2, 8),
        reconnectPeriod: 5000,
    });

    mqttClient.on('connect', () => {
        console.log('Connected to MQTT Broker via WebSocket');
        isMqttConnected = true;
        document.getElementById('btn-save-mqtt').style.display = 'none';
        document.getElementById('btn-disconnect-mqtt').style.display = 'flex';
        updateConnectionStatusBadge();

        mqttClient.subscribe(appConfig.mqttTopic, (err) => {
            if (!err) console.log(`Subscribed to ${appConfig.mqttTopic}`);
        });
    });

    mqttClient.on('message', (topic, message) => {
        const payload = message.toString();
        try {
            storeStationData(JSON.parse(payload), 2); // Trạm 2 là MQTT
        } catch (e) { }
    });

    mqttClient.on('error', (err) => {
        console.error('MQTT Error:', err);
        isMqttConnected = false;
        updateConnectionStatusBadge();
    });

    mqttClient.on('close', () => {
        isMqttConnected = false;
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

                    while (buffer.length >= PACKET_SIZE) {
                        const packet = buffer.slice(0, PACKET_SIZE);
                        buffer = buffer.slice(PACKET_SIZE);
                        const view = new DataView(packet.buffer);
                        const data = {
                            pm1_0: view.getUint16(0, true),
                            pm2_5: view.getUint16(2, true),
                            pm10: view.getUint16(4, true),
                            temp: view.getInt16(6, true) / 10.0,
                            hum: view.getInt16(8, true) / 10.0,
                            aqi: view.getUint16(10, true),
                            tvoc: view.getUint16(12, true),
                            eco2: view.getUint16(14, true)
                        };
                        storeStationData(data, 1); // Trạm 1 là LoRa
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

    updateConnectionStatusBadge();
}, 1000);

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
