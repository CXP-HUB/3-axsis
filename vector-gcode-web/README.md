# DXF / SVG → Z 轴 G-code Web Component

这是一个无框架、可嵌入产品的浏览器组件原型。文件在浏览器本地解析，不上传服务器；编辑界面单位为 cm，核心内部仍使用 mm，G-code 输出单位为 mm。组件提供：

- 导入 ASCII DXF 和 SVG
- DXF `LINE`、`CIRCLE`、`ARC`、`LWPOLYLINE`、传统 `POLYLINE/VERTEX`
- SVG `line`、`polyline`、`polygon`、`rect`、`circle`、`ellipse`、`path`
- 每个文件独立缩放、旋转、X/Y 平移
- 导入后按版面大小、图形间距和横/纵向优先规则自动排版；用户也可以点击“自动排布”重新整理
- 自动排版只需设置图形间距、版面宽度、版面高度和排版方向，预览中会显示版面边界及超出情况
- 默认自动排版参数为：间距 `0 cm`、版面 `120 × 120 cm`、横向优先，用户可直接修改
- 图形放不进当前版面时自动创建下一版面；版面按顺序切换，空版面不会保留，G-code 按版面顺序输出并带有 `Sheet` 标记
- 预览左侧提供所有版面的缩略图总览；比例/旋转既支持单个组成部分，也支持所有导入组成部分的整体变换
- 预览窗口中直接拖动图形，位置会同步到 X/Y 参数
- 选中板片后可点击“复制板片”“粘贴板片”，也支持 `Ctrl+C` / `Ctrl+V`；每次粘贴会生成可独立拖动的副本
- 预览空白区域按住鼠标左键可平移整个视图，滚轮可进行局部缩放
- 单个 DXF 中相交、相接或位于同一外框内的路径会合并成一个几何组成部分；每个组成部分可独立选择和拖动，内部线条不会被拆开
- “测量线段”模式下点击两点，显示长度、ΔX、ΔY，单位为 cm；靠近端点、中点或线段时会自动吸附，并显示绿色捕捉标记
- `G21`、绝对坐标、仅 Z 安全高度/下刀，不输出主轴或激光命令
- `gcode-generated`、`file-loaded`、`layout-changed` 等集成事件

## 本地运行

在本目录启动内置 Node.js 服务器：

```powershell
npm.cmd start
```

然后打开 `http://localhost:8000`。默认代理设备地址为 `http://192.168.4.1`，也就是 `main.py` 的 AP 模式地址。

Windows 也可以直接双击 `start.bat` 启动。

使用 STA 模式时，在启动前设置 ESP32 地址：

```powershell
$env:DEVICE_URL = "http://192.168.1.50"
npm start
```

页面生成 G-code 后可以直接点击“发送 G-code”，然后使用“开始/暂停/继续/停止”控制设备。Node 服务会把原始 G-code 通过 HTTP 代理到 ESP32，ESP32 完整保存后才允许执行。

## 嵌入产品

复制 `vector-gcode-core.js` 和 `vector-gcode-editor.js`，在产品页面引入：

```html
<vector-gcode-editor id="gcodeEditor"></vector-gcode-editor>
<script type="module" src="/components/vector-gcode-editor.js"></script>
<script type="module">
  const editor = document.querySelector('#gcodeEditor');
  editor.addEventListener('gcode-generated', event => {
    const { code, pathCount } = event.detail;
    console.log(pathCount, code);
  });

  await editor.loadFile('part.svg', svgText);
</script>
```

`loadFile(name, text)` 也可以接收用户上传后的文本。组件会根据版面参数自动排版；对象的 `transform` 由组件内的表单维护，公开的 X/Y 状态单位为 cm。核心路径和 G-code 生成仍以 mm 运行，当前 API 可通过 `getState()` 读取布局结果。

## G-code 语义

默认参数为 `safeZ=5`、`cutZ=-1`、`plungeFeed=100`、`cutFeed=500`，输出结构类似：

```gcode
G21
G90
G0 Z5
G0 X10 Y10
G1 Z-1 F100
G1 X50 Y10 F500
G0 Z5
```

组件不包含刀具半径补偿，也不输出 `M3`、`M5`、激光功率或主轴转速。若实际工艺需要刀具补偿，应在产品中增加几何偏置步骤；若控制器不接受 `M2`，可在导出适配层移除末尾的 `M2`。

## 开源参考

实现和后续扩展可优先参考：

- [gdsestimating/dxf-parser](https://github.com/gdsestimating/dxf-parser)：DXF 实体解析器，可替换当前轻量 ASCII DXF 适配器。
- [abey79/vpype](https://github.com/abey79/vpype)：SVG 路径清理、合并和路径优化思路。
- [GridSpace/gridspace-kiri](https://github.com/GridSpace/gridspace-kiri)：浏览器端 CAD/CAM 与 G-code 工作流参考。
- [Jack000/SVGnest](https://github.com/Jack000/SVGnest)：自动套料/排布参考；当前组件使用轻量外框排布，后续可替换为真正的异形套料。

## 当前边界

当前版本不解析二进制 DXF、复杂 DXF `SPLINE`/`ELLIPSE`、SVG `text`、`use`、滤镜和样式填充。复杂实体可在导入前由 CAD 软件转成多段线，或后续接入 `dxf-parser` 与专用曲线离散器。
