import sys
with open('script.js', 'r', encoding='utf-8') as f:
    text = f.read()

target = '''    // Lấy thông số hiện tại
    const currTemp = historyData.temp[len - 1];
    const currHum = historyData.hum[len - 1];
    const currPm1_0 = historyData.pm1_0[len - 1];
    const currPm25 = historyData.pm25[len - 1];
    const currPm10 = historyData.pm10[len - 1];
    const currEco2 = historyData.eco2[len - 1];
    const currTvoc = historyData.tvoc[len - 1];

    const prompt = \Bạn là một chuyên gia về chất lượng không khí, hô hấp và y tế công cộng. Dưới đây là thông số môi trường hiện tại trong một phòng kín:
- Nhiệt độ: \ °C
- Độ ẩm: \ %
- Bụi mịn PM1.0: \ µg/m³
- Bụi mịn PM2.5: \ µg/m³
- Bụi mịn PM10: \ µg/m³
- Khí CO2 (eCO2): \ ppm
- Khí độc TVOC: \ ppb

Hãy phân tích ngắn gọn tình trạng hiện tại và đưa ra 1 lời khuyên thực tế để bảo vệ sức khỏe người trong phòng. Viết bằng tiếng Việt, rất thân thiện, súc tích (tối đa 60 từ) và có dùng emoji. Bắt buộc không cần dòng chào hỏi. \;'''

replacement = '''    // Lấy tối đa 10 dữ liệu gần nhất để gửi cho AI (giúp AI nhận biết xu hướng)
    const recentCount = Math.min(len, 10);
    const startIndex = len - recentCount;
    
    let dataTable = "Thời gian | Nhiệt độ | Độ ẩm | PM1.0 | PM2.5 | PM10 | eCO2 | TVOC\\n";
    for (let i = startIndex; i < len; i++) {
        dataTable += \\ | \°C | \% | \ | \ | \ | \ ppm | \ ppb\\n\;
    }

    const prompt = \Bạn là một chuyên gia về chất lượng không khí, hô hấp và y tế công cộng. Dưới đây là bảng dữ liệu môi trường đo được liên tục gần đây trong một phòng kín:
\
Hãy phân tích ngắn gọn tình trạng và XU HƯỚNG của không khí hiện tại, sau đó đưa ra 1 lời khuyên thực tế để bảo vệ sức khỏe người trong phòng. Viết bằng tiếng Việt, rất thân thiện, súc tích (tối đa 80 từ) và có dùng emoji. Bắt buộc không cần dòng chào hỏi. \;'''

text = text.replace('\r\n', '\n')
target = target.replace('\r\n', '\n')
if target in text:
    with open('script.js', 'w', encoding='utf-8') as f:
        f.write(text.replace(target, replacement))
    print('SUCCESS')
else:
    print('NOT FOUND')
