# ESP32-S3 G-code 控制器项目总结

更新时间：2026-07-20

## 1. 项目目标

手机或电脑通过网页上传 G-code 文件，ESP32-S3 接收文件、解析 G-code，并控制 DM556 步进驱动器带动 X/Y/Z 电机运动。

当前采用的通信方式是：

```text
手机或电脑
    ↓ 连接 ESP32 创建的 Wi-Fi
ESP32-S3 固定 IP：192.168.4.1
    ↓ HTTP 上传 G-code
ESP32 文件系统：/job.gcode
    ↓
MicroPython G-code 解析和运动控制
    ↓
DM556 驱动器
    ↓
步进电机
```

当前优先保证本地 AP 方式稳定工作。ESP32 连接外部路由器的 STA 版本也保留，但不是当前主要测试版本。

## 2. 工程目录

工程目录：

```text
C:\Users\CXP\Documents\Codex\2026-07-17\w1\outputs\esp32_gcode_ap
```

主要文件：

| 文件 | 作用 |
|---|---|
| `main.py` | 创建 ESP32 Wi-Fi 热点、启动 HTTP 服务、接收上传和控制任务 |
| `gcode_controller.py` | G-code 解析、坐标管理、三轴 DDA、STEP/DIR/ENA 输出 |
| `index.html` | 手机或电脑使用的网页界面 |
| `main_sta.py` | 连接外部 Wi-Fi 路由器的备用版本 |
| `axis_test.gcode` | X 轴单独运动测试文件 |
| `README.md` | 早期说明，中文编码可能已经损坏 |
| `PROJECT_SUMMARY.md` | 本次整理的项目交接文档 |

## 3. Thonny 运行方式

不要单独运行 `gcode_controller.py`。它是被 `main.py` 导入的运动控制模块。

在 Thonny 中按下面顺序操作：

1. 连接 ESP32-S3，并确认解释器选择的是 MicroPython on ESP32。
2. 打开本地的 `gcode_controller.py`，保存到 ESP32 文件系统，文件名保持为 `gcode_controller.py`。
3. 打开本地的 `main.py`，保存到 ESP32 文件系统。
4. 将 `index.html` 也保存到 ESP32 文件系统。若没有该文件，`main.py` 会使用内置的简易上传页面。
5. 重启 ESP32，观察 Thonny Shell 输出。
6. 手机连接 Wi-Fi：`GCODE-32`。
7. 浏览器打开：`http://192.168.4.1/`。
8. 选择 G-code 文件并上传，然后点击开始。

正常情况下，Thonny Shell 会显示类似信息：

```text
WiFi SSID: GCODE-32
WiFi IP: 192.168.4.1
Parser ready: True
HTTP server ready
```

## 4. 当前 AP 网络配置

配置位置：`main.py`

```python
AP_SSID = "GCODE-32"
AP_PASSWORD = "12341234"
AP_IP = "192.168.4.1"
```

ESP32 自己创建 Wi-Fi，不依赖外部路由器。手机只要连接 `GCODE-32`，就可以访问固定地址 `192.168.4.1`。

当前 HTTP 接口：

```text
GET  /api/status
PUT  /api/job
POST /api/start
POST /api/pause
POST /api/resume
POST /api/stop
```

上传限制：

```text
最大文件大小：8 MB
临时文件：/job.tmp
正式文件：/job.gcode
```

上传时先写入 `/job.tmp`，完整接收后才替换 `/job.gcode`，避免上传中断时破坏旧任务。

## 5. STA 外部 Wi-Fi 版本

备用文件：`main_sta.py`

它用于以下网络结构：

```text
手机 ─┐
      ├─ 外部 Wi-Fi 路由器 ─ ESP32-S3
电脑 ─┘
```

配置位置：`main_sta.py`

```python
WIFI_SSID = "你的路由器名称"
WIFI_PASSWORD = "你的路由器密码"
```

此版本通常由路由器 DHCP 分配 IP，所以 ESP32 重启或更换网络后地址可能变化。后续可以使用路由器 DHCP 地址保留、mDNS 或独立发现服务解决固定访问问题。

当前阶段先使用 AP 版本，因为它的地址固定为 `192.168.4.1`，不需要用户处理路由器配置。

## 6. 当前电机引脚

当前 `gcode_controller.py` 使用以下 GPIO：

| 轴/驱动 | STEP | DIR | ENA |
|---|---:|---:|---:|
| X | GPIO4 | GPIO5 | GPIO6 |
| Y 左 | GPIO7 | GPIO8 | GPIO9 |
| Y 右 | GPIO10 | GPIO11 | GPIO12 |
| Z | GPIO13 | GPIO14 | GPIO15 |

Y 轴由两个 DM556 驱动器共同运动，因此两个 Y 驱动器会同时收到 STEP、DIR、ENA 信号。

当前参数：

```python
STEPS_PER_MM = {
    "X": 160.0,
    "Y": 160.0,
    "Z": 160.0,
}
```

`STEPS_PER_MM` 必须和电机的机械传动、DM556 细分设置一致。计算方式是：

```text
每毫米步数 = 每转脉冲数 × 减速比 ÷ 每转移动距离
```

如果实际移动距离不对，优先检查这个参数和 DM556 细分拨码。

## 7. 当前运动参数

位置：`gcode_controller.py` 文件开头。

```python
MAX_STEP_RATE = 2800.0
MIN_DELAY_US = 350
START_DELAY_US = 3000
ACCEL_PULSES = 800
CONTROL_CHECK_INTERVAL = 128
PULSE_YIELD_INTERVAL = 0
STEP_HIGH_US = 10
ARC_SEGMENT_MM = 0.5
```

参数含义：

| 参数 | 含义 |
|---|---|
| `MAX_STEP_RATE` | 最高轴脉冲频率，单位 steps/s |
| `MIN_DELAY_US` | 脉冲低电平最小等待时间 |
| `START_DELAY_US` | 加速开始时的较慢脉冲间隔 |
| `ACCEL_PULSES` | 加速和减速使用的脉冲数量 |
| `CONTROL_CHECK_INTERVAL` | 检查停止或暂停请求的脉冲间隔 |
| `PULSE_YIELD_INTERVAL` | 主动让出 CPU 的脉冲间隔，当前为 0 |
| `STEP_HIGH_US` | STEP 高电平持续时间 |
| `ARC_SEGMENT_MM` | 圆弧拆分为直线时的分段长度 |

如果运动仍然太慢，可以先把 `ACCEL_PULSES` 从 `800` 调整为 `400`。如果高速失步、振动或噪声明显，可以降低 `MAX_STEP_RATE`，例如改为 `1800` 或 `2200`，再逐步提高。

## 8. 本次运动控制修改

修改文件：`gcode_controller.py`

原来的脉冲循环存在以下问题：

- 每个脉冲都创建 `active_axes` 列表。
- Python 字典和列表操作发生在高频脉冲循环中。
- 每个脉冲使用相对等待时间，循环执行时间会累积到脉冲周期。
- Python 垃圾回收可能在运动过程中突然暂停。

当前已经改为：

- 使用 X/Y/Z 三个整数累加器完成 DDA 多轴同步。
- 使用位掩码判断本次需要输出哪些轴的 STEP。
- 不在每个脉冲中创建列表。
- 使用 `ticks_us()` 和绝对 deadline 控制脉冲时刻。
- 运动前执行垃圾回收，然后在脉冲循环期间暂时关闭垃圾回收。
- Y 左右两个驱动器在同一个 DDA 事件中同时输出脉冲。
- 将默认 `ACCEL_PULSES` 从 `3000` 调整为 `800`，避免长距离运动加速时间过长。

已经完成的验证：

- Python AST 语法检查通过。
- 使用假的 Pin 和时钟完成单轴、斜线、双 Y 输出测试。
- 模拟测试中三轴步数和 Y 左右输出数量一致。

尚未完成的验证：

- 尚未在真实 DM556 和电机上测量 STEP 波形。
- 尚未验证所有 G-code 后处理器输出格式。
- 尚未实现硬件定时器 ISR 级别的脉冲输出。

## 9. 当前 G-code 支持范围

已支持或处理：

```text
G0    快速直线运动
G1    进给直线运动
G2    顺时针圆弧，使用 R 参数
G3    逆时针圆弧，使用 R 参数
G17   XY 平面
G21   毫米单位
G90   绝对坐标
G94   每分钟进给
G54   工作坐标系提示
G43   忽略刀长命令
G49   忽略刀长取消命令
M2    任务结束
M3/M5 主轴命令，当前忽略
M6    换刀命令，当前忽略
```

暂不支持：

```text
G20   英寸单位
G91   相对坐标
```

当前圆弧要求使用 `R` 参数，并拆分成多段直线。复杂 CAM 文件可能包含暂不支持的 G-code，需要根据错误行号继续扩展解析器。

## 10. 当前已知限制

### 10.1 MicroPython 不是硬实时脉冲系统

当前方案仍然使用 MicroPython 的 `Pin.value()` 和 `sleep_us()` 输出脉冲。此次优化可以减少明显的 Python 卡顿，但它仍然不能达到 FluidNC 或 Grbl_Esp32 的硬件定时器稳定性。

如果单轴长直线仍然出现固定周期的顿挫或明显嗡响，继续修改延时参数的收益会很有限，下一步应迁移到 Arduino/ESP-IDF C++ 的硬件定时器运动内核。

### 10.2 当前网页停止不一定立即生效

`PULSE_YIELD_INTERVAL = 0` 是为了减少 Wi-Fi 调度对脉冲时序的影响。因此长直线运动期间，HTTP 的暂停或停止命令可能要等到当前运动段结束后才被处理。

必须保留实体急停。软件停止不能代替硬件急停。

### 10.3 SN04-N 八路限位

当前 MicroPython 控制器通过光耦输入板读取 8 个 NPN 型 SN04-N 传感器：

| 限位 | 光耦输入 | ESP32 GPIO |
|---|---:|---:|
| X- | IN1 | GPIO16 |
| X+ | IN2 | GPIO17 |
| Y 左- | IN3 | GPIO18 |
| Y 左+ | IN4 | GPIO21 |
| Y 右- | IN5 | GPIO38 |
| Y 右+ | IN6 | GPIO39 |
| Z- | IN7 | GPIO40 |
| Z+ | IN8 | GPIO41 |

传感器假设为 NPN 输出，且光耦板在 ESP32 侧以低电平表示触发。输入板
必须隔离 24 V 传感器回路，并输出 3.3 V 安全电平或开集电极信号。程序
在运动开始前和每 4 个脉冲检查相关方向的限位；触发后任务状态为 `limit`，
反向脱离该限位仍可执行。软件限位不能替代独立的硬件急停。

### 10.4 DM556 电平必须确认

如果 DM556 使用 `PUL+、DIR+、ENA+` 接外部 5V 的共阳接法，ESP32 GPIO 不应直接使用普通 3.3V 推挽输出去承受 5V 输入。

建议使用：

- ULN2003 或 ULN2803。
- 三极管开集电极电路。
- 合适的 3.3V 转 5V 开漏/开集电极接口。

改线或拨动 DM556 拨码前必须断电，并确认 ESP32 GND、接口电源负极和驱动器控制侧参考地的连接关系。

### 10.5 没有上传认证

当前 AP 模式默认没有 Token 或密码之外的 HTTP 鉴权。正式使用时应增加设备配对、Token 或至少限制危险控制接口。

## 11. 推荐测试顺序

1. 断开机械负载或将机构置于安全位置。
2. 只连接一个 X 轴驱动器和电机。
3. 使用 `axis_test.gcode` 做单轴测试。
4. 先使用较低进给速度，例如 `F300` 或 `F600`。
5. 确认方向、步数、启停和声音都正常。
6. 再测试 Y 左右两个驱动器同步。
7. 再测试 Z 轴。
8. 最后测试多轴直线、圆弧和完整 G-code 文件。

出现问题时记录以下信息：

```text
使用的 G-code 行
F 值
实际移动距离
DM556 细分设置
DM556 电流设置
电机供电电压
是否单轴也顿挫
Thonny Shell 报错内容
```

## 12. FluidNC 和 Grbl_Esp32 借鉴结论

两个项目最值得借鉴的是运动内核，而不是直接复制网页代码：

```text
HTTP 上传
    ↓
G-code 解析
    ↓
Planner 运动规划器
    ↓
环形运动队列
    ↓
速度分段器
    ↓
ESP32 硬件定时器 ISR
    ↓
STEP/DIR 输出
```

关键技术：

- 使用 ESP32 硬件定时器或 I2S/RMT 类硬件输出步进时序。
- 主任务只负责解析和填充运动队列。
- 中断或硬件外设负责稳定输出 STEP 脉冲。
- 使用整数 DDA/Bresenham 保证多轴步数同步。
- 使用 Planner look-ahead 计算相邻 G-code 线段的连续速度。
- 将网络、文件、解析、规划、脉冲执行和报警状态分离。

FluidNC 和 Grbl_Esp32 的代码许可、ESP-IDF 版本和硬件抽象体系都需要单独确认，不能把大量代码直接复制到自己的项目中而忽略 GPLv3 等许可要求。

## 13. 下一步升级路线

短期：

1. 用当前 MicroPython 版本完成真实电机单轴测试。
2. 确认 DM556 电流、细分、脉冲电平和接线。
3. 根据实际声音和速度调整 `MAX_STEP_RATE`、`ACCEL_PULSES`。

中期：

1. 使用 Arduino/ESP-IDF C++ 写一个硬件定时器步进测试固件。
2. 先实现 X/Y/Z STEP、DIR、ENA 和多轴 DDA。
3. 保留当前 HTTP API 和网页界面。
4. 将当前文件执行方式改成解析器向 Planner 环形队列填充运动块。

长期：

1. 增加 look-ahead 和连续加减速。
2. 增加 G2/G3 高质量圆弧插补。
3. 增加限位、急停、报警和任务恢复状态机。
4. 根据需要选择直接配置 FluidNC，或继续维护自己的 C++ 控制器。

## 14. 下次继续时的起点

下次先说明：

```text
继续 ESP32-S3 G-code 项目。
当前使用 outputs/esp32_gcode_ap。
AP 版本固定访问 192.168.4.1。
当前 MicroPython 运动控制已经优化，但仍是 Pin.value + sleep_us 软件脉冲。
下一步优先测试真实电机；如果仍然顿挫，开始迁移到 C++ 硬件定时器。
```
