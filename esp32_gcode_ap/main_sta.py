import json
import network
import socket
import uasyncio as asyncio
from machine import Pin

try:
    import gcode_controller
    PARSER_IMPORT_ERROR = ""
except Exception as error:
    gcode_controller = None
    PARSER_IMPORT_ERROR = "{}: {}".format(type(error).__name__, error)


WIFI_SSID = "Innox_2.4G"
WIFI_PASSWORD = "innox2.4G"
DEVICE_NAME = "gcode-esp32"
DISCOVERY_PORT = 4210

JOB_PATH = "/job.gcode"
TEMP_PATH = "/job.tmp"
MAX_FILE_SIZE = 8 * 1024 * 1024
READ_CHUNK_SIZE = 4096
REQUEST_LINE_LIMIT = 256

PARSER_READY = gcode_controller is not None

sta = network.WLAN(network.STA_IF)
server = None
discovery_socket = None
device_id = "unknown"
job_name = ""
job_size = 0
job_state = "empty"
upload_received = 0
last_error = ""
stop_requested = False
current_line = 0

FALLBACK_PAGE = b"""<!doctype html>
<html><head><meta name='viewport' content='width=device-width,initial-scale=1'>
<title>G-code Upload</title></head><body>
<h2>G-code Upload</h2>
<input id='file' type='file' accept='.gcode,.nc,.txt'>
<button onclick='upload()'>Upload</button><pre id='out'>Ready</pre>
<script>
async function upload() {
  const file = document.getElementById('file').files[0];
  if (!file) return;
  const out = document.getElementById('out');
  out.textContent = 'Uploading...';
  try {
    const response = await fetch('/api/job', {method:'PUT',
      headers:{'Content-Type':'application/octet-stream','X-File-Name':file.name}, body:file});
    out.textContent = await response.text();
  } catch (error) { out.textContent = error.toString(); }
}
</script></body></html>"""


def json_response(status, payload):
    body = json.dumps(payload).encode()
    header = (
        "HTTP/1.1 {}\r\n"
        "Content-Type: application/json; charset=utf-8\r\n"
        "Content-Length: {}\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n"
    ).format(status, len(body)).encode()
    return header + body


def text_response(status, content_type, body):
    if isinstance(body, str):
        body = body.encode()
    header = (
        "HTTP/1.1 {}\r\n"
        "Content-Type: {}\r\n"
        "Content-Length: {}\r\n"
        "Cache-Control: no-store\r\n"
        "Connection: close\r\n\r\n"
    ).format(status, content_type, len(body)).encode()
    return header + body


async def send_response(writer, payload):
    writer.write(payload)
    await writer.drain()


async def read_request_headers(reader):
    request_line = await reader.readline()
    if not request_line or len(request_line) > REQUEST_LINE_LIMIT:
        return None, None, {}

    parts = request_line.decode().strip().split(" ")
    if len(parts) < 2:
        return None, None, {}

    headers = {}
    while True:
        line = await reader.readline()
        if not line or line in (b"\r\n", b"\n"):
            break
        decoded = line.decode().strip()
        if ":" in decoded:
            key, value = decoded.split(":", 1)
            headers[key.lower().strip()] = value.strip()

    return parts[0], parts[1], headers


def status_payload():
    return {
        "state": job_state,
        "parser_ready": PARSER_READY,
        "parser_error": PARSER_IMPORT_ERROR,
        "mode": "sta",
        "device_name": DEVICE_NAME,
        "device_id": device_id,
        "ip": sta.ifconfig()[0] if sta.isconnected() else "0.0.0.0",
        "name": job_name,
        "size": job_size,
        "line": current_line,
        "upload_received": upload_received,
        "upload_percent": (
            int(upload_received * 100 / job_size) if job_size else 0
        ),
        "error": last_error,
    }


async def upload_job(reader, headers):
    global job_name, job_size, job_state, upload_received, last_error, current_line

    if job_state == "running" or job_state == "paused":
        return 409, {"error": "job_is_running"}

    try:
        content_length = int(headers.get("content-length", "-1"))
    except ValueError:
        content_length = -1

    if content_length < 1 or content_length > MAX_FILE_SIZE:
        return 400, {"error": "invalid_content_length", "max": MAX_FILE_SIZE}

    file_name = headers.get("x-file-name", "job.gcode")
    file_name = file_name.replace("\\", "/").split("/")[-1].strip()
    if not file_name or len(file_name) > 80:
        return 400, {"error": "invalid_file_name"}

    job_state = "uploading"
    upload_received = 0
    current_line = 0
    last_error = ""

    try:
        with open(TEMP_PATH, "wb") as output:
            remaining = content_length
            while remaining:
                chunk = await reader.read(min(READ_CHUNK_SIZE, remaining))
                if not chunk:
                    raise OSError("connection_closed_during_upload")
                output.write(chunk)
                upload_received += len(chunk)
                remaining -= len(chunk)
                await asyncio.sleep_ms(0)

        try:
            import uos
            uos.remove(JOB_PATH)
        except OSError:
            pass

        import uos
        uos.rename(TEMP_PATH, JOB_PATH)
        job_name = file_name
        job_size = content_length
        job_state = "ready"
        return 200, status_payload()
    except Exception as error:
        job_state = "error"
        last_error = str(error)
        try:
            import uos
            uos.remove(TEMP_PATH)
        except OSError:
            pass
        return 500, {"error": last_error}


async def execute_gcode_line(line, line_number):
    if gcode_controller is None:
        raise RuntimeError("gcode_controller_not_loaded")
    return await gcode_controller.execute_gcode_line(line, line_number)


async def run_job():
    global job_state, last_error, stop_requested, current_line

    if not PARSER_READY:
        job_state = "error"
        last_error = "parser_not_connected"
        return

    stop_requested = False
    try:
        gcode_controller.clear_motion_requests()
        gcode_controller.enable_all_axes()
        job_state = "running"
        with open(JOB_PATH, "rb") as job_file:
            for line_number, raw_line in enumerate(job_file, 1):
                if stop_requested:
                    job_state = "stopped"
                    return
                current_line = line_number
                while job_state == "paused" and not stop_requested:
                    await asyncio.sleep_ms(50)
                line = raw_line.decode().strip()
                if line and not line.startswith(";"):
                    finished = await execute_gcode_line(line, line_number)
                    if finished:
                        job_state = "completed"
                        return
                await asyncio.sleep_ms(0)
        job_state = "completed"
    except gcode_controller.MotionStopped:
        job_state = "stopped"
    except Exception as error:
        job_state = "error"
        last_error = str(error)
    finally:
        gcode_controller.stop_axes()


async def client_handler(reader, writer):
    global job_state, stop_requested, last_error

    try:
        method, path, headers = await read_request_headers(reader)
        if not method:
            return

        if method == "GET" and path in ("/", "/index.html"):
            try:
                with open("index.html", "rb") as page:
                    await send_response(
                        writer,
                        text_response("200 OK", "text/html; charset=utf-8", page.read()),
                    )
            except OSError:
                await send_response(writer, text_response("200 OK", "text/html; charset=utf-8", FALLBACK_PAGE))
        elif method == "GET" and path == "/api/status":
            await send_response(writer, json_response("200 OK", status_payload()))
        elif method == "PUT" and path == "/api/job":
            status, payload = await upload_job(reader, headers)
            status_text = "200 OK" if status == 200 else "{} Error".format(status)
            await send_response(writer, json_response(status_text, payload))
        elif method == "POST" and path == "/api/start":
            if not PARSER_READY:
                await send_response(writer, json_response("409 Conflict", {"error": "parser_not_connected"}))
            elif job_state not in ("ready", "stopped", "completed"):
                await send_response(writer, json_response("409 Conflict", {"error": "job_not_ready"}))
            else:
                last_error = ""
                gcode_controller.clear_motion_requests()
                asyncio.create_task(run_job())
                await send_response(writer, json_response("202 Accepted", {"state": "starting"}))
        elif method == "POST" and path == "/api/pause":
            if job_state == "running":
                job_state = "paused"
                if gcode_controller is not None:
                    gcode_controller.request_pause()
            await send_response(writer, json_response("200 OK", status_payload()))
        elif method == "POST" and path == "/api/resume":
            if job_state == "paused":
                job_state = "running"
                if gcode_controller is not None:
                    gcode_controller.request_resume()
            await send_response(writer, json_response("200 OK", status_payload()))
        elif method == "POST" and path == "/api/stop":
            stop_requested = True
            job_state = "stopped"
            if gcode_controller is not None:
                gcode_controller.request_stop()
            await send_response(writer, json_response("200 OK", status_payload()))
        else:
            await send_response(writer, json_response("404 Not Found", {"error": "not_found"}))
    except Exception as error:
        print("HTTP error:", error)
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except AttributeError:
            pass


async def connect_station():
    global device_id
    sta.active(True)
    if device_id == "unknown":
        try:
            mac = sta.config("mac")
            device_id = "esp32-{}".format(
                "".join("{:02X}".format(value) for value in mac[-3:])
            )
        except Exception:
            device_id = DEVICE_NAME
    try:
        sta.config(hostname=DEVICE_NAME)
    except Exception:
        pass

    if sta.isconnected():
        print("WiFi IP:", sta.ifconfig()[0])
        return True

    try:
        sta.disconnect()
    except Exception:
        pass
    sta.connect(WIFI_SSID, WIFI_PASSWORD)

    for _ in range(30):
        if sta.isconnected():
            print("WiFi IP:", sta.ifconfig()[0])
            return True
        await asyncio.sleep_ms(500)

    print("WiFi connect failed")
    return False


async def wifi_monitor():
    while True:
        if not sta.isconnected():
            await connect_station()
        await asyncio.sleep_ms(3000)


async def discovery_task():
    global discovery_socket
    discovery_socket = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    discovery_socket.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    discovery_socket.bind(("0.0.0.0", DISCOVERY_PORT))
    discovery_socket.setblocking(False)

    while True:
        try:
            message, address = discovery_socket.recvfrom(128)
            if message.strip() == b"GCODE_DISCOVER" and sta.isconnected():
                payload = json.dumps({
                    "name": DEVICE_NAME,
                    "device_id": device_id,
                    "ip": sta.ifconfig()[0],
                    "port": 80,
                    "service": "gcode-http",
                }).encode()
                discovery_socket.sendto(payload, address)
        except OSError:
            pass
        await asyncio.sleep_ms(50)


async def main():
    global server
    while not await connect_station():
        await asyncio.sleep_ms(3000)
    server = await asyncio.start_server(client_handler, "0.0.0.0", 80)
    print("HTTP server ready")
    asyncio.create_task(wifi_monitor())
    asyncio.create_task(discovery_task())
    while True:
        await asyncio.sleep_ms(1000)


asyncio.run(main())
