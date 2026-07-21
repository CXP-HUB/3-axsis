import math
import gc
import uasyncio as asyncio
from machine import Pin
from time import sleep_us, ticks_diff, ticks_us

GCODE_FILE = "job.gcode"
PREVIEW_ONLY = False
KEEP_Z_ENABLED = True

ENA_ON = 0
ENA_OFF = 1

X_DIRECTION_POSITIVE = 1
Y_DIRECTION_POSITIVE = 0
Z_DIRECTION_POSITIVE = 0

STEPS_PER_MM = {
    "X": 160.0,
    "Y": 160.0,
    "Z": 160.0,
}

DEFAULT_FEED_MM_MIN = 1200.0
DEFAULT_RAPID_MM_MIN = 3000.0
MAX_STEP_RATE = 2800.0
MIN_DELAY_US = 350
START_DELAY_US = 3000
# Keep this short enough that small moves do not spend most of their time
# accelerating. Increase it only after the motor starts cleanly.
ACCEL_PULSES = 800
CONTROL_CHECK_INTERVAL = 128
# Limit inputs are checked often enough to stop before significant travel while
# keeping the software pulse loop reasonably stable on MicroPython.
LIMIT_CHECK_INTERVAL = 4
# A non-zero value makes HTTP control more responsive, but each yield can
# disturb the pulse train. Leave it at zero for the smoothest motion.
PULSE_YIELD_INTERVAL = 0
STEP_HIGH_US = 10
ARC_SEGMENT_MM = 0.5

# The installed optocoupler board reports idle as low and a triggered sensor
# as high on the ESP32 side. Keep the input low while the board is disconnected.
LIMIT_PULL = Pin.PULL_DOWN
LIMIT_ACTIVE_LEVEL = 1

X_STEP_MASK = 1
Y_STEP_MASK = 2
Z_STEP_MASK = 4

x_step = Pin(4, Pin.OUT, value=0)
x_dir = Pin(5, Pin.OUT, value=0)
x_ena = Pin(6, Pin.OUT, value=ENA_OFF)

yl_step = Pin(7, Pin.OUT, value=0)
yl_dir = Pin(8, Pin.OUT, value=0)
yl_ena = Pin(9, Pin.OUT, value=ENA_OFF)

yr_step = Pin(10, Pin.OUT, value=0)
yr_dir = Pin(11, Pin.OUT, value=0)
yr_ena = Pin(12, Pin.OUT, value=ENA_OFF)

z_step = Pin(13, Pin.OUT, value=0)
z_dir = Pin(14, Pin.OUT, value=0)
z_ena = Pin(15, Pin.OUT, value=ENA_OFF)

x_minus_limit = Pin(16, Pin.IN, LIMIT_PULL)
x_plus_limit = Pin(17, Pin.IN, LIMIT_PULL)
y_left_minus_limit = Pin(18, Pin.IN, LIMIT_PULL)
y_left_plus_limit = Pin(21, Pin.IN, LIMIT_PULL)
y_right_minus_limit = Pin(38, Pin.IN, LIMIT_PULL)
y_right_plus_limit = Pin(39, Pin.IN, LIMIT_PULL)
z_minus_limit = Pin(40, Pin.IN, LIMIT_PULL)
z_plus_limit = Pin(41, Pin.IN, LIMIT_PULL)

STEP_PINS = {
    "X": (x_step,),
    "Y": (yl_step, yr_step),
    "Z": (z_step,),
}

DIR_PINS = {
    "X": (x_dir,),
    "Y": (yl_dir, yr_dir),
    "Z": (z_dir,),
}

ENA_PINS = {
    "X": (x_ena,),
    "Y": (yl_ena, yr_ena),
    "Z": (z_ena,),
}

LIMIT_INPUTS = {
    "X-": x_minus_limit,
    "X+": x_plus_limit,
    "Y-left-": y_left_minus_limit,
    "Y-left+": y_left_plus_limit,
    "Y-right-": y_right_minus_limit,
    "Y-right+": y_right_plus_limit,
    "Z-": z_minus_limit,
    "Z+": z_plus_limit,
}

# Group the two Y sensors on each side for directional motion protection.
LIMIT_PINS = {
    "X-": (x_minus_limit,),
    "X+": (x_plus_limit,),
    "Y-": (y_left_minus_limit, y_right_minus_limit),
    "Y+": (y_left_plus_limit, y_right_plus_limit),
    "Z-": (z_minus_limit,),
    "Z+": (z_plus_limit,),
}

POSITION_MM = {
    "X": 0.0,
    "Y": 0.0,
    "Z": 0.0,
}

MOTION_MODE = "G0"
FEED_MM_MIN = DEFAULT_FEED_MM_MIN
UNITS = "mm"
ABSOLUTE_MODE = True
STOP_REQUESTED = False
PAUSE_REQUESTED = False


class MotionStopped(Exception):
    pass


class LimitTriggered(MotionStopped):
    def __init__(self, limit_name):
        self.limit_name = limit_name
        super().__init__("limit_triggered_{}".format(limit_name))


def clear_motion_requests():
    global STOP_REQUESTED, PAUSE_REQUESTED
    STOP_REQUESTED = False
    PAUSE_REQUESTED = False


def request_stop():
    global STOP_REQUESTED, PAUSE_REQUESTED
    STOP_REQUESTED = True
    PAUSE_REQUESTED = False
    stop_axes()


def request_pause():
    global PAUSE_REQUESTED
    PAUSE_REQUESTED = True


def request_resume():
    global PAUSE_REQUESTED
    PAUSE_REQUESTED = False


async def wait_for_motion_control():
    while PAUSE_REQUESTED and not STOP_REQUESTED:
        await asyncio.sleep_ms(50)
    if STOP_REQUESTED:
        raise MotionStopped()


def is_limit_active(pin):
    return pin.value() == LIMIT_ACTIVE_LEVEL


def get_limit_status():
    return {
        name: is_limit_active(pin)
        for name, pin in LIMIT_INPUTS.items()
    }


def check_motion_limits(deltas):
    # This function runs while the pulse loop has GC disabled. Avoid tuples,
    # generators, and dictionary construction here or long moves can exhaust
    # the MicroPython heap with unreachable temporary objects.
    if deltas["X"] < 0 and is_limit_active(x_minus_limit):
        raise LimitTriggered("X-")
    if deltas["X"] > 0 and is_limit_active(x_plus_limit):
        raise LimitTriggered("X+")

    if deltas["Y"] < 0:
        if is_limit_active(y_left_minus_limit) or is_limit_active(y_right_minus_limit):
            raise LimitTriggered("Y-")
    if deltas["Y"] > 0:
        if is_limit_active(y_left_plus_limit) or is_limit_active(y_right_plus_limit):
            raise LimitTriggered("Y+")

    if deltas["Z"] < 0 and is_limit_active(z_minus_limit):
        raise LimitTriggered("Z-")
    if deltas["Z"] > 0 and is_limit_active(z_plus_limit):
        raise LimitTriggered("Z+")


def parse_line(raw_line):
    line = raw_line.split(";", 1)[0]
    clean_chars = []
    in_parentheses = False
    for char in line:
        if char == "(":
            in_parentheses = True
        elif char == ")":
            in_parentheses = False
        elif not in_parentheses:
            clean_chars.append(char)

    line = "".join(clean_chars).upper()
    if not line.strip():
        return {}

    words = {}
    index = 0
    valid_letters = "GMTFSXYZR"
    while index < len(line):
        letter = line[index]
        if letter not in valid_letters:
            index += 1
            continue

        number_start = index + 1
        number_end = number_start

        if number_end < len(line) and line[number_end] in "+-":
            number_end += 1

        has_digit = False
        has_decimal = False
        while number_end < len(line):
            number_char = line[number_end]
            if "0" <= number_char <= "9":
                has_digit = True
                number_end += 1
            elif number_char == "." and not has_decimal:
                has_decimal = True
                number_end += 1
            else:
                break

        if has_digit:
            value = float(line[number_start:number_end])
            if letter in ("G", "M", "T") and letter in words:
                existing = words[letter]
                if not isinstance(existing, list):
                    existing = [existing]
                existing.append(value)
                words[letter] = existing
            else:
                words[letter] = value
            index = number_end
        else:
            index += 1

    return words


def validate_motion_config():
    for axis in ("X", "Y", "Z"):
        if STEPS_PER_MM[axis] <= 0:
            raise ValueError("Set STEPS_PER_MM[{}] before motion".format(axis))


def set_directions(deltas):
    direction_levels = {
        "X": X_DIRECTION_POSITIVE,
        "Y": Y_DIRECTION_POSITIVE,
        "Z": Z_DIRECTION_POSITIVE,
    }

    for axis in ("X", "Y", "Z"):
        if deltas[axis] < 0:
            direction_levels[axis] = 1 - direction_levels[axis]
        for pin in DIR_PINS[axis]:
            pin.value(direction_levels[axis])


def set_axis_enabled(axis, enabled):
    level = ENA_ON if enabled else ENA_OFF
    for pin in ENA_PINS[axis]:
        pin.value(level)


def set_all_steps(level):
    for pins in STEP_PINS.values():
        for pin in pins:
            pin.value(level)


def enable_all_axes():
    for axis in ("X", "Y", "Z"):
        set_axis_enabled(axis, True)


def stop_axes():
    set_all_steps(0)
    set_axis_enabled("X", False)
    set_axis_enabled("Y", False)
    set_axis_enabled("Z", KEEP_Z_ENABLED)


def calculate_delay_us(distance_mm, max_steps, feed_mm_min):
    if distance_mm <= 0 or max_steps <= 0:
        return START_DELAY_US

    step_rate = feed_mm_min * max_steps / (distance_mm * 60.0)
    step_rate = min(step_rate, MAX_STEP_RATE)
    interval_us = int(1000000.0 / step_rate)
    return max(MIN_DELAY_US, interval_us - STEP_HIGH_US)


def pulse_axes(active_axes, delay_us):
    for axis in active_axes:
        for pin in STEP_PINS[axis]:
            pin.value(1)

    sleep_us(STEP_HIGH_US)

    for axis in active_axes:
        for pin in STEP_PINS[axis]:
            pin.value(0)

    sleep_us(delay_us)


def wait_until(deadline_us):
    remaining_us = ticks_diff(deadline_us, ticks_us())
    if remaining_us > 0:
        sleep_us(remaining_us)


async def move_linear(target_mm, feed_mm_min, preview=False, ramp=True):
    deltas = {
        axis: target_mm[axis] - POSITION_MM[axis]
        for axis in ("X", "Y", "Z")
    }
    steps = {
        axis: int(abs(deltas[axis]) * STEPS_PER_MM[axis] + 0.5)
        for axis in ("X", "Y", "Z")
    }
    max_steps = max(steps.values())
    distance_mm = math.sqrt(
        deltas["X"] * deltas["X"]
        + deltas["Y"] * deltas["Y"]
        + deltas["Z"] * deltas["Z"]
    )

    if preview:
        print(
            "MOVE X={:.3f} Y={:.3f} Z={:.3f} F={:.1f}".format(
                target_mm["X"],
                target_mm["Y"],
                target_mm["Z"],
                feed_mm_min,
            )
        )
        POSITION_MM.update(target_mm)
        return

    if max_steps == 0:
        POSITION_MM.update(target_mm)
        return

    check_motion_limits(deltas)
    set_directions(deltas)
    target_delay_us = calculate_delay_us(distance_mm, max_steps, feed_mm_min)
    start_delay_us = max(START_DELAY_US, target_delay_us)
    ramp_pulses = min(ACCEL_PULSES, max_steps // 2) if ramp else 0

    # The old loop allocated a list for every pulse. At a few thousand pulses
    # per second that eventually triggered garbage collection and created an
    # audible pause. Keep all DDA state in local integers and use a deadline
    # clock so loop overhead does not accumulate into the pulse period.
    x_steps = steps["X"]
    y_steps = steps["Y"]
    z_steps = steps["Z"]
    x_accumulator = 0
    y_accumulator = 0
    z_accumulator = 0
    ramp_delta_us = start_delay_us - target_delay_us
    deadline_us = ticks_us() + start_delay_us + STEP_HIGH_US

    gc.collect()
    gc.disable()
    try:
        for pulse_index in range(max_steps):
            if pulse_index % LIMIT_CHECK_INTERVAL == 0:
                check_motion_limits(deltas)
            if pulse_index % CONTROL_CHECK_INTERVAL == 0:
                if STOP_REQUESTED or PAUSE_REQUESTED:
                    gc.enable()
                    try:
                        await wait_for_motion_control()
                    finally:
                        gc.collect()
                        gc.disable()

            step_mask = 0
            x_accumulator += x_steps
            if x_accumulator >= max_steps:
                x_accumulator -= max_steps
                step_mask |= X_STEP_MASK
            y_accumulator += y_steps
            if y_accumulator >= max_steps:
                y_accumulator -= max_steps
                step_mask |= Y_STEP_MASK
            z_accumulator += z_steps
            if z_accumulator >= max_steps:
                z_accumulator -= max_steps
                step_mask |= Z_STEP_MASK

            if ramp_pulses > 0 and pulse_index < ramp_pulses:
                delay_us = start_delay_us - (ramp_delta_us * pulse_index // ramp_pulses)
            elif ramp_pulses > 0 and pulse_index >= max_steps - ramp_pulses:
                decel_index = pulse_index - (max_steps - ramp_pulses)
                delay_us = target_delay_us + (ramp_delta_us * decel_index // ramp_pulses)
            else:
                delay_us = target_delay_us

            wait_until(deadline_us)

            if step_mask & X_STEP_MASK:
                x_step.value(1)
            if step_mask & Y_STEP_MASK:
                yl_step.value(1)
                yr_step.value(1)
            if step_mask & Z_STEP_MASK:
                z_step.value(1)

            sleep_us(STEP_HIGH_US)

            if step_mask & X_STEP_MASK:
                x_step.value(0)
            if step_mask & Y_STEP_MASK:
                yl_step.value(0)
                yr_step.value(0)
            if step_mask & Z_STEP_MASK:
                z_step.value(0)

            deadline_us += STEP_HIGH_US + max(0, delay_us)

            if PULSE_YIELD_INTERVAL and pulse_index % PULSE_YIELD_INTERVAL == 0:
                gc.enable()
                try:
                    await asyncio.sleep_ms(0)
                finally:
                    gc.collect()
                    gc.disable()
    finally:
        gc.enable()

    POSITION_MM.update(target_mm)


def code_values(words, letter):
    if letter not in words:
        return []

    value = words[letter]
    if isinstance(value, list):
        return [int(item) for item in value]
    return [int(value)]


def calculate_arc(start_mm, target_mm, radius_value, clockwise):
    start_x = start_mm["X"]
    start_y = start_mm["Y"]
    end_x = target_mm["X"]
    end_y = target_mm["Y"]
    radius = abs(radius_value)
    delta_x = end_x - start_x
    delta_y = end_y - start_y
    chord = math.sqrt(delta_x * delta_x + delta_y * delta_y)

    if chord <= 0.000001:
        raise ValueError("Arc start and end are identical")
    if chord > (2.0 * radius) + 0.000001:
        raise ValueError("Arc radius is too small")

    half_chord = chord / 2.0
    height = math.sqrt(max(0.0, radius * radius - half_chord * half_chord))
    mid_x = (start_x + end_x) / 2.0
    mid_y = (start_y + end_y) / 2.0
    normal_x = -delta_y / chord
    normal_y = delta_x / chord

    centers = (
        (mid_x + normal_x * height, mid_y + normal_y * height),
        (mid_x - normal_x * height, mid_y - normal_y * height),
    )
    want_major = radius_value < 0
    selected = None
    fallback = None

    for center_x, center_y in centers:
        start_angle = math.atan2(start_y - center_y, start_x - center_x)
        end_angle = math.atan2(end_y - center_y, end_x - center_x)
        full_circle = 2.0 * math.pi

        if clockwise:
            sweep = (start_angle - end_angle) % full_circle
            signed_sweep = -sweep
        else:
            sweep = (end_angle - start_angle) % full_circle
            signed_sweep = sweep

        candidate = (
            center_x,
            center_y,
            start_angle,
            sweep,
            signed_sweep,
        )
        fallback = candidate
        if (sweep > math.pi) == want_major:
            selected = candidate
            break

    if selected is None:
        selected = fallback

    return selected


async def move_arc(target_mm, feed_mm_min, radius_value, clockwise, preview=False):
    start_mm = POSITION_MM.copy()
    center_x, center_y, start_angle, sweep, signed_sweep = calculate_arc(
        start_mm,
        target_mm,
        radius_value,
        clockwise,
    )
    radius = abs(radius_value)
    arc_length = radius * sweep
    segment_count = max(2, int(arc_length / ARC_SEGMENT_MM) + 1)

    if preview:
        print(
            "ARC {} radius={:.3f} segments={} X={:.3f} Y={:.3f} Z={:.3f}".format(
                "G2" if clockwise else "G3",
                radius_value,
                segment_count,
                target_mm["X"],
                target_mm["Y"],
                target_mm["Z"],
            )
        )

    for index in range(1, segment_count + 1):
        fraction = index / segment_count
        angle = start_angle + signed_sweep * fraction
        point = target_mm.copy()
        point["X"] = center_x + radius * math.cos(angle)
        point["Y"] = center_y + radius * math.sin(angle)
        point["Z"] = start_mm["Z"] + (
            target_mm["Z"] - start_mm["Z"]
        ) * fraction
        await move_linear(point, feed_mm_min, preview, ramp=False)


async def process_words(words, line_number):
    global MOTION_MODE, FEED_MM_MIN, UNITS, ABSOLUTE_MODE

    if not words:
        return False

    for m_code in code_values(words, "M"):
        if m_code == 2:
            print("M2 at line", line_number)
            return True
        if m_code in (3, 5):
            print("Ignoring M{} spindle command at line {}".format(m_code, line_number))
            continue
        if m_code == 6:
            print("Ignoring M6 tool change at line", line_number)
            continue
        raise ValueError("Unsupported M{} at line {}".format(m_code, line_number))

    for g_code in code_values(words, "G"):
        if g_code == 0:
            MOTION_MODE = "G0"
        elif g_code == 1:
            MOTION_MODE = "G1"
        elif g_code == 2:
            MOTION_MODE = "G2"
        elif g_code == 3:
            MOTION_MODE = "G3"
        elif g_code == 17:
            print("Using G17 XY plane")
        elif g_code == 21:
            UNITS = "mm"
        elif g_code == 20:
            raise ValueError("G20 inches are not supported")
        elif g_code == 90:
            ABSOLUTE_MODE = True
        elif g_code == 91:
            raise ValueError("G91 relative mode is not supported")
        elif g_code == 94:
            pass
        elif g_code == 54:
            print("Using G54 work coordinate system")
        elif g_code in (43, 49):
            print("Ignoring G{} tool length command".format(g_code))
        else:
            raise ValueError("Unsupported G{} at line {}".format(g_code, line_number))

    if "F" in words:
        if words["F"] <= 0:
            raise ValueError("Invalid feed at line {}".format(line_number))
        FEED_MM_MIN = words["F"]

    if UNITS != "mm" or not ABSOLUTE_MODE:
        raise ValueError("Unsupported coordinate mode at line {}".format(line_number))

    has_coordinate = any(axis in words for axis in ("X", "Y", "Z"))
    if not has_coordinate:
        return False

    target = POSITION_MM.copy()
    for axis in ("X", "Y", "Z"):
        if axis in words:
            target[axis] = words[axis]

    feed = DEFAULT_RAPID_MM_MIN if MOTION_MODE == "G0" else FEED_MM_MIN
    if MOTION_MODE in ("G2", "G3"):
        if "R" not in words:
            raise ValueError("Arc requires R at line {}".format(line_number))
        await move_arc(
            target,
            feed,
            words["R"],
            MOTION_MODE == "G2",
            PREVIEW_ONLY,
        )
    else:
        await move_linear(target, feed, PREVIEW_ONLY)
    return False


async def execute_gcode_line(raw_line, line_number=0):
    words = parse_line(raw_line)
    return await process_words(words, line_number)


async def execute_file(path):
    if not PREVIEW_ONLY:
        validate_motion_config()
        enable_all_axes()

    with open(path, "r") as gcode_file:
        for line_number, raw_line in enumerate(gcode_file, 1):
            stopped = await execute_gcode_line(raw_line, line_number)
            if stopped:
                break
