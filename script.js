// --- LOAD CONFIGURATIONS ---
const DEFAULT_CONFIG = {
    mqttUrl: SYS_CONFIG.MQTT_DEFAULT_URL,
    mqttUser: SYS_CONFIG.MQTT_DEFAULT_USER,
    mqttPass: SYS_CONFIG.MQTT_DEFAULT_PASS,
    mqttTopic: SYS_CONFIG.MQTT_DEFAULT_TOPIC,
    email: '',
    limits: SYS_CONFIG.DEFAULT_LIMITS
};

// Load configs from localStorage
let appConfig = JSON.parse(localStorage.getItem('utt_air_config')) || DEFAULT_CONFIG;
// Prevent missing keys if object structure changes
appConfig.limits = { ...DEFAULT_CONFIG.limits, ...(appConfig.limits || {}) };

let mqttClient = null;
let lastEmailSentTime = {}; // To prevent email spamming (cooldown)

let isMqttConnected = false;
let isLoraConnected = false;
let lastDataTime = Date.now();
let dataTimeoutAlerted = false;

// --- DOM ELEMENTS ---
const statusDot = document.querySelector('.status-dot');
const statusText = document.querySelector('.status-text');
const aqiBanner = document.getElementById('aqi-banner');
const valAqi = document.getElementById('val-aqi');
const labelAqi = document.getElementById('label-aqi');

// --- TABS LOGIC ---
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


function triggerEmailAlert(paramName, currentValue, limitValue, message, fullData) {
    if (!appConfig.email) return;

    const now = Date.now();
    // Check cooldown
    if (lastEmailSentTime[paramName] && (now - lastEmailSentTime[paramName] < SYS_CONFIG.EMAIL_COOLDOWN_MS)) {
        return; // Skip if in cooldown
    }

    lastEmailSentTime[paramName] = now;
    const emailMsg = `CẢNH BÁO: ${message}. Giá trị hiện tại: ${currentValue}, Giới hạn: ${limitValue}.`;

    showToast('Gửi Email Cảnh báo', `Đang gửi email tới ${appConfig.email}...`, 'warning');
    console.log("SENDING EMAIL to " + appConfig.email + " -> " + emailMsg);

    emailjs.send(SYS_CONFIG.EMAILJS_SERVICE_ID, SYS_CONFIG.EMAILJS_TEMPLATE_ID, {
        to_email: appConfig.email,
        alert_message: message,
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
        showToast('Thành công', 'Đã gửi email cảnh báo tới hòm thư!', 'success');
    }).catch(err => {
        console.error("EmailJS Error:", err);
    });
}

function checkThresholds(data) {
    const L = appConfig.limits;
    if (data.temp > L.maxTemp) triggerEmailAlert('Nhiệt độ', data.temp, L.maxTemp, 'Nhiệt độ QUÁ CAO', data);
    if (data.temp < L.minTemp) triggerEmailAlert('Nhiệt độ', data.temp, L.minTemp, 'Nhiệt độ QUÁ THẤP', data);
    if (data.hum > L.maxHum) triggerEmailAlert('Độ ẩm', data.hum, L.maxHum, 'Độ ẩm QUÁ CAO', data);
    if (data.hum < L.minHum) triggerEmailAlert('Độ ẩm', data.hum, L.minHum, 'Độ ẩm QUÁ THẤP', data);
    if (data.pm2_5 > L.maxPm25) triggerEmailAlert('Bụi mịn PM2.5', data.pm2_5, L.maxPm25, 'Bụi mịn PM2.5 vượt ngưỡng', data);
    if (data.eco2 > L.maxEco2) triggerEmailAlert('eCO2', data.eco2, L.maxEco2, 'Nồng độ CO2 vượt ngưỡng', data);
    if (data.tvoc > L.maxTvoc) triggerEmailAlert('TVOC', data.tvoc, L.maxTvoc, 'Nồng độ TVOC vượt ngưỡng', data);
    if (data.aqi > L.maxAqi) triggerEmailAlert('Chỉ số AQI', data.aqi, L.maxAqi, 'Chỉ số AQI ở mức nguy hiểm', data);
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
const historyData = { time: [], temp: [], hum: [], pm1_0: [], pm25: [], pm10: [], eco2: [], tvoc: [] };
const MAX_DATA_POINTS = 30;
chartHistory.setOption({
    tooltip: { trigger: 'axis' },
    legend: {
        data: ['Nhiệt độ (°C)', 'Độ ẩm (%)', 'PM1.0 (µg/m³)', 'PM2.5 (µg/m³)', 'PM10 (µg/m³)', 'eCO2 (ppm)', 'TVOC (ppb)'],
        textStyle: { color: textColor },
        type: 'scroll',
        orient: 'horizontal'
    },
    grid: { left: '3%', right: '4%', bottom: '5%', top: '15%', containLabel: true },
    xAxis: { type: 'category', boundaryGap: false, data: historyData.time, axisLabel: { color: textColor } },
    yAxis: [
        { type: 'value', name: 'Môi trường/Bụi', nameTextStyle: { color: textColor }, axisLabel: { color: textColor } },
        { type: 'value', name: 'Khí (eCO2/TVOC)', nameTextStyle: { color: textColor }, axisLabel: { color: textColor }, splitLine: { show: false } }
    ],
    series: [
        { name: 'Nhiệt độ (°C)', type: 'line', smooth: true, itemStyle: { color: '#ef4444' }, data: historyData.temp },
        { name: 'Độ ẩm (%)', type: 'line', smooth: true, itemStyle: { color: '#3388dd' }, data: historyData.hum },
        { name: 'PM1.0 (µg/m³)', type: 'line', smooth: true, itemStyle: { color: '#10b981' }, data: historyData.pm1_0 },
        { name: 'PM2.5 (µg/m³)', type: 'line', smooth: true, itemStyle: { color: '#f59e0b' }, data: historyData.pm25 },
        { name: 'PM10 (µg/m³)', type: 'line', smooth: true, itemStyle: { color: '#8b5cf6' }, data: historyData.pm10 },
        { name: 'eCO2 (ppm)', type: 'line', smooth: true, yAxisIndex: 1, itemStyle: { color: '#64748b' }, data: historyData.eco2 },
        { name: 'TVOC (ppb)', type: 'line', smooth: true, yAxisIndex: 1, itemStyle: { color: '#ec4899' }, data: historyData.tvoc }
    ]
});

window.addEventListener('resize', () => {
    chartTemp.resize(); chartHum.resize(); chartEco2.resize(); chartTvoc.resize(); chartPm1_0.resize(); chartPm25.resize(); chartPm10.resize(); chartHistory.resize();
});

// --- UPDATE UI LOGIC ---
function updateDashboard(data) {
    try {
        lastDataTime = Date.now();
        dataTimeoutAlerted = false; // Reset cờ báo động khi có data mới

        const aqiVal = data.aqi || 0;
        valAqi.innerText = aqiVal;

        let aqiInfo = { label: 'Không xác định', class: 'offline' };
        switch (Math.round(aqiVal)) {
            case 1: aqiInfo = { label: 'Tuyệt vời', class: 'excellent' }; break;
            case 2: aqiInfo = { label: 'Tốt', class: 'good' }; break;
            case 3: aqiInfo = { label: 'Trung bình', class: 'moderate' }; break;
            case 4: aqiInfo = { label: 'Kém', class: 'poor' }; break;
            case 5: aqiInfo = { label: 'Độc hại', class: 'unhealthy' }; break;
        }

        labelAqi.innerText = aqiInfo.label;
        aqiBanner.className = 'aqi-banner ' + aqiInfo.class;

        chartTemp.setOption({ series: [{ data: [{ value: data.temp || 0, name: 'Nhiệt độ' }] }] });
        chartHum.setOption({ series: [{ data: [{ value: data.hum || 0, name: 'Độ ẩm' }] }] });
        chartEco2.setOption({ series: [{ data: [{ value: data.eco2 || 0, name: 'eCO2' }] }] });
        chartTvoc.setOption({ series: [{ data: [{ value: data.tvoc || 0, name: 'TVOC' }] }] });
        chartPm1_0.setOption({ series: [{ data: [{ value: data.pm1_0 || 0, name: 'PM1.0' }] }] });
        chartPm25.setOption({ series: [{ data: [{ value: data.pm2_5 || 0, name: 'PM2.5' }] }] });
        chartPm10.setOption({ series: [{ data: [{ value: data.pm10 || 0, name: 'PM10' }] }] });

        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ':' + now.getSeconds().toString().padStart(2, '0');
        historyData.time.push(timeStr);
        historyData.temp.push(data.temp || 0);
        historyData.hum.push(data.hum || 0);
        historyData.pm1_0.push(data.pm1_0 || 0);
        historyData.pm25.push(data.pm2_5 || 0);
        historyData.pm10.push(data.pm10 || 0);
        historyData.eco2.push(data.eco2 || 400);
        historyData.tvoc.push(data.tvoc || 0);

        if (historyData.time.length > MAX_DATA_POINTS) {
            historyData.time.shift(); historyData.temp.shift(); historyData.hum.shift(); historyData.pm1_0.shift(); historyData.pm25.shift(); historyData.pm10.shift(); historyData.eco2.shift(); historyData.tvoc.shift();
        }

        chartHistory.setOption({
            xAxis: { data: historyData.time },
            series: [
                { data: historyData.temp },
                { data: historyData.hum },
                { data: historyData.pm1_0 },
                { data: historyData.pm25 },
                { data: historyData.pm10 },
                { data: historyData.eco2 },
                { data: historyData.tvoc }
            ]
        });

        // Check alerts
        checkThresholds(data);

        // AI Trend Analysis
        analyzeAIAdvice();
    } catch (e) {
        console.error("Error parsing dashboard data", e);
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
    if (!aiText || historyData.pm25.length < 10) return; // Cần ít nhất 10 mẫu để phân tích

    // Lấy 10 điểm dữ liệu gần nhất để hồi quy tuyến tính
    const len = historyData.pm25.length;
    const recentPm = historyData.pm25.slice(len - 10);
    const recentEco2 = historyData.eco2.slice(len - 10);
    const recentTemp = historyData.temp.slice(len - 10);
    const currHum = historyData.hum[len - 1];

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
    document.getElementById('btn-ask-gemini').addEventListener('click', askGeminiAI);
}

async function askGeminiAI() {
    const apiKey = appConfig.geminiKey;
    if (!apiKey) {
        showToast('Lỗi Gemini', 'Vui lòng nhập Gemini API Key trong Tab Cài đặt để sử dụng tính năng này!', 'error');
        return;
    }

    const len = historyData.pm25.length;
    if (len === 0) {
        showToast('Chưa có dữ liệu', 'Hệ thống đang chờ dữ liệu từ cảm biến. Vui lòng thử lại sau!', 'warning');
        return;
    }

    const aiText = document.getElementById('ai-advice-text');
    aiText.innerHTML = '<span style="color: #10b981;"><i class="fa-solid fa-spinner fa-spin"></i> Gemini 2.5 Flash đang phân tích dữ liệu...</span>';

    // Lấy tối đa 10 dữ liệu gần nhất để gửi cho AI (giúp AI nhận biết xu hướng)
    const recentCount = Math.min(len, 10);
    const startIndex = len - recentCount;

    let dataTable = "Thời gian | Nhiệt độ | Độ ẩm | PM1.0 | PM2.5 | PM10 | eCO2 | TVOC\n";
    for (let i = startIndex; i < len; i++) {
        dataTable += `${historyData.time[i]} | ${historyData.temp[i]}°C | ${historyData.hum[i]}% | ${historyData.pm1_0[i]} | ${historyData.pm25[i]} | ${historyData.pm10[i]} | ${historyData.eco2[i]} ppm | ${historyData.tvoc[i]} ppb\n`;
    }

    const prompt = `Bạn là một chuyên gia về chất lượng không khí, hô hấp và y tế công cộng. Dưới đây là bảng dữ liệu môi trường đo được liên tục gần đây trong một phòng kín:
${dataTable}
Hãy phân tích ngắn gọn tình trạng và XU HƯỚNG của không khí hiện tại, sau đó đưa ra 1 lời khuyên thực tế để bảo vệ sức khỏe người trong phòng. Viết bằng tiếng Việt, rất thân thiện, súc tích (tối đa 80 từ) và có dùng emoji. Bắt buộc không cần dòng chào hỏi. `;

    try {
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] })
        });

        if (!response.ok) {
            throw new Error(`API Error: ${response.status}`);
        }

        const result = await response.json();
        const reply = result.candidates[0].content.parts[0].text;

        aiText.innerHTML = `<span style="color: #059669;">✨ <strong>Chuyên gia Gemini nhận định: </strong></span><br>${reply.replace(/\n/g, '<br>')}`;
    } catch (error) {
        console.error("Gemini Error:", error);
        aiText.innerHTML = `❌ <strong>Lỗi kết nối AI:</strong> Không thể kết nối với máy chủ Google Gemini. Vui lòng kiểm tra lại kết nối mạng hoặc API Key.`;
        showToast('Lỗi API', 'Gọi Gemini thất bại, nhấn F12 để xem chi tiết.', 'error');
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
            updateDashboard(JSON.parse(payload));
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
                        updateDashboard(data);
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
    let text = [];
    if (isMqttConnected) text.push('MQTT');
    if (isLoraConnected) text.push('LoRa');

    if (text.length > 0) {
        statusDot.className = 'status-dot connected';
        statusText.textContent = `Đã kết nối (${text.join(' + ')})`;
    } else {
        statusDot.className = 'status-dot error';
        statusText.textContent = 'Mất kết nối hoàn toàn';
    }
}

// Kiểm tra mất dữ liệu quá 20s
setInterval(() => {
    const now = Date.now();
    // Chỉ cảnh báo nếu người dùng đang có kết nối ít nhất 1 loại
    if (isMqttConnected || isLoraConnected) {
        if (now - lastDataTime > 20000) { // Quá 20s không có dữ liệu
            statusDot.className = 'status-dot error';
            statusText.textContent = 'Lỗi: Mất tín hiệu thiết bị!';

            if (!dataTimeoutAlerted) {
                showToast('Cảnh báo dữ liệu', 'Đã quá 20 giây không nhận được tín hiệu từ thiết bị (kiểm tra lại nguồn hoặc kết nối của ESP32)!', 'error');
                dataTimeoutAlerted = true;
            }
        } else {
            // Khôi phục lại trạng thái bình thường nếu có mạng trở lại
            updateConnectionStatusBadge();
        }
    }
}, 1000);
