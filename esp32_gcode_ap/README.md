# ESP32-S3 G-code Wi-Fi AP prototype

这是第一阶段的通信原型：ESP32-S3 创建自己的 Wi-Fi 热点，手机连接后通过浏览器上传 G-code 文件。

## 使用方式

1. 将 `main.py` 和 `gcode_controller.py` 上传到 ESP32 的 MicroPython 文件系统根目录；`index.html` 是完整网页，可选上传到同一目录。
2. 修改 `main.py` 中的 `AP_SSID` 和 `AP_PASSWORD`。
3. 重启 ESP32，手机连接对应 Wi-Fi。
4. 浏览器访问 `http://192.168.4.1/`。
5. 选择文件并上传。上传完成后文件保存为 `/job.gcode`。

## 当前边界

- 支持原始二进制 HTTP `PUT` 上传，最大文件大小为 8 MB。
- 上传时写入 `/job.tmp`，成功后才替换 `/job.gcode`。
- 已预留状态、开始、暂停、继续、停止接口。
- `PARSER_READY` 默认为 `False`，因此不会误启动电机。
- 如果没有上传 `index.html`，ESP32 会自动显示内置的简易上传页。
- 上传 `gcode_controller.py` 后，`main.py` 会自动启用 G-code 执行。
- 状态接口会额外返回当前执行行号 `line`。
- 如果解析器加载失败，状态中的 `parser_error` 会显示原因。
- 当前控制器使用 `2800` steps/s 上限、`3000 us` 起步延时和 `3000` 脉冲加速距离；圆弧分段不重复加减速。默认连续脉冲模式不在运动中让出 CPU，网页停止命令会在当前 G-code 线段结束后响应，必须保留硬件急停。

`axis_test.gcode` 是只移动 X 轴的 10 mm 测试文件，可先用它区分脉冲时序问题和复杂 G-code 路径问题。

## 当前 G-code 适配范围

当前解析器可处理 `G0`、`G1`、`G2`、`G3`、`G17`、`G21`、`G90`、`G94`、`G54`、`G43`、`M2`、`M3`、`M5` 和 `M6`。`G2/G3` 使用 `R` 参数，并按 `ARC_SEGMENT_MM` 分段为直线运动。

## 电机测试前

`gcode_controller.py` 沿用了原有 GPIO 和 DM556 电平配置。确认 DM556 输入接口和电平转换电路后再接电机；如果使用外部 5 V 共阳接法，应使用开漏/开集电极驱动或合适的电平转换，不能让 ESP32 GPIO 直接承受 5 V。软件限位不能替代硬件急停。
- 需要把现有 G-code 解析器接入 `execute_gcode_line()` 后，再将 `PARSER_READY` 改为 `True`。

## 接口

```text
GET  /api/status
PUT  /api/job
POST /api/start
POST /api/pause
POST /api/resume
POST /api/stop
```

当前原型没有加入鉴权。正式使用前应增加设备 Token，并保留硬件急停和限位保护。
