const SVG_UNIT_TO_MM = {
  mm: 1,
  cm: 10,
  m: 1000,
  in: 25.4,
  pt: 25.4 / 72,
  pc: 25.4 / 6,
  px: 25.4 / 96
};

function number(value, fallback = 0) {
  const parsed = Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function point(x, y) {
  return { x: number(x), y: number(y) };
}

function samePoint(first, second, epsilon = 1e-7) {
  return Math.abs(first.x - second.x) <= epsilon && Math.abs(first.y - second.y) <= epsilon;
}

function distance(first, second) {
  return Math.hypot(second.x - first.x, second.y - first.y);
}

function measureSegment(first, second) {
  return distance(first, second);
}

function addPoint(target, candidate, epsilon = 1e-7) {
  if (!target.length || !samePoint(target[target.length - 1], candidate, epsilon)) {
    target.push(candidate);
  }
}

function parseUnit(value, fallback = 1, unitless = 'mm') {
  const match = String(value ?? '').trim().match(/^[-+]?\d*\.?\d+(?:e[-+]?\d+)?\s*(mm|cm|m|in|pt|pc|px)?$/i);
  if (!match) return fallback;
  return number(match[0]) * (SVG_UNIT_TO_MM[match[1]?.toLowerCase() || unitless] || 1);
}

function parsePoints(value) {
  const values = String(value || '').trim().match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || [];
  const points = [];
  for (let index = 0; index + 1 < values.length; index += 2) {
    points.push(point(values[index], values[index + 1]));
  }
  return points;
}

function multiplyMatrix(first, second) {
  return {
    a: first.a * second.a + first.c * second.b,
    b: first.b * second.a + first.d * second.b,
    c: first.a * second.c + first.c * second.d,
    d: first.b * second.c + first.d * second.d,
    e: first.a * second.e + first.c * second.f + first.e,
    f: first.b * second.e + first.d * second.f + first.f
  };
}

function applyMatrix(matrix, value) {
  return point(
    matrix.a * value.x + matrix.c * value.y + matrix.e,
    matrix.b * value.x + matrix.d * value.y + matrix.f
  );
}

function parseTransform(value) {
  const identity = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };
  const pattern = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/gi;
  let result = identity;
  let match;
  while ((match = pattern.exec(String(value || '')))) {
    const values = (match[2].match(/[-+]?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number);
    let current = identity;
    const name = match[1].toLowerCase();
    if (name === 'matrix' && values.length >= 6) {
      current = { a: values[0], b: values[1], c: values[2], d: values[3], e: values[4], f: values[5] };
    } else if (name === 'translate') {
      current = { ...identity, e: values[0] || 0, f: values[1] || 0 };
    } else if (name === 'scale') {
      current = { ...identity, a: values[0] ?? 1, d: values[1] ?? values[0] ?? 1 };
    } else if (name === 'rotate') {
      const angle = (values[0] || 0) * Math.PI / 180;
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      current = { a: cosine, b: sine, c: -sine, d: cosine, e: 0, f: 0 };
      if (values.length >= 3) {
        const center = point(values[1], values[2]);
        current = multiplyMatrix(
          multiplyMatrix({ ...identity, e: center.x, f: center.y }, current),
          { ...identity, e: -center.x, f: -center.y }
        );
      }
    } else if (name === 'skewx') {
      current = { ...identity, c: Math.tan((values[0] || 0) * Math.PI / 180) };
    } else if (name === 'skewy') {
      current = { ...identity, b: Math.tan((values[0] || 0) * Math.PI / 180) };
    }
    result = multiplyMatrix(result, current);
  }
  return result;
}

function cubic(first, controlFirst, controlSecond, last, steps) {
  const points = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const inverse = 1 - t;
    points.push(point(
      inverse ** 3 * first.x + 3 * inverse ** 2 * t * controlFirst.x + 3 * inverse * t ** 2 * controlSecond.x + t ** 3 * last.x,
      inverse ** 3 * first.y + 3 * inverse ** 2 * t * controlFirst.y + 3 * inverse * t ** 2 * controlSecond.y + t ** 3 * last.y
    ));
  }
  return points;
}

function quadratic(first, control, last, steps) {
  const points = [];
  for (let index = 1; index <= steps; index += 1) {
    const t = index / steps;
    const inverse = 1 - t;
    points.push(point(
      inverse ** 2 * first.x + 2 * inverse * t * control.x + t ** 2 * last.x,
      inverse ** 2 * first.y + 2 * inverse * t * control.y + t ** 2 * last.y
    ));
  }
  return points;
}

function arcToPoints(first, rx, ry, rotation, largeArc, sweep, last, steps) {
  const radiusX = Math.abs(rx);
  const radiusY = Math.abs(ry);
  if (!radiusX || !radiusY || samePoint(first, last)) return [last];

  const angle = rotation * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const dx = (first.x - last.x) / 2;
  const dy = (first.y - last.y) / 2;
  const localX = cosine * dx + sine * dy;
  const localY = -sine * dx + cosine * dy;
  const correction = localX ** 2 / radiusX ** 2 + localY ** 2 / radiusY ** 2;
  const scale = correction > 1 ? Math.sqrt(correction) : 1;
  const adjustedX = radiusX * scale;
  const adjustedY = radiusY * scale;
  const numerator = Math.max(0, adjustedX ** 2 * adjustedY ** 2 - adjustedX ** 2 * localY ** 2 - adjustedY ** 2 * localX ** 2);
  const denominator = adjustedX ** 2 * localY ** 2 + adjustedY ** 2 * localX ** 2;
  const factor = (largeArc === sweep ? -1 : 1) * (denominator ? Math.sqrt(numerator / denominator) : 0);
  const centerLocalX = factor * adjustedX * localY / adjustedY;
  const centerLocalY = factor * -adjustedY * localX / adjustedX;
  const center = point(
    cosine * centerLocalX - sine * centerLocalY + (first.x + last.x) / 2,
    sine * centerLocalX + cosine * centerLocalY + (first.y + last.y) / 2
  );
  const vectorAngle = (x, y) => Math.atan2(y, x);
  const startAngle = vectorAngle((localX - centerLocalX) / adjustedX, (localY - centerLocalY) / adjustedY);
  let deltaAngle = vectorAngle((-localX - centerLocalX) / adjustedX, (-localY - centerLocalY) / adjustedY) - startAngle;
  if (!sweep && deltaAngle > 0) deltaAngle -= Math.PI * 2;
  if (sweep && deltaAngle < 0) deltaAngle += Math.PI * 2;
  const count = Math.max(4, Math.ceil(Math.abs(deltaAngle) / (Math.PI / 18)), steps || 0);
  const points = [];
  for (let index = 1; index <= count; index += 1) {
    const current = startAngle + deltaAngle * index / count;
    points.push(point(
      center.x + adjustedX * Math.cos(current) * cosine - adjustedY * Math.sin(current) * sine,
      center.y + adjustedX * Math.cos(current) * sine + adjustedY * Math.sin(current) * cosine
    ));
  }
  return points;
}

function parsePathData(value, tolerance = 10) {
  const tokens = String(value || '').match(/[a-z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:e[-+]?\d+)?/gi) || [];
  const points = [];
  let cursor = point(0, 0);
  let subpathStart = point(0, 0);
  let command = '';
  let index = 0;
  let previousControl;
  const isCommand = token => /^[a-z]$/i.test(token);
  const read = () => number(tokens[index++]);
  const readPoint = relative => {
    const value = point(read(), read());
    return relative ? point(cursor.x + value.x, cursor.y + value.y) : value;
  };
  while (index < tokens.length) {
    if (isCommand(tokens[index])) command = tokens[index++];
    if (!command) break;
    const relative = command === command.toLowerCase();
    const type = command.toUpperCase();
    if (type === 'Z') {
      addPoint(points, subpathStart);
      cursor = subpathStart;
      previousControl = undefined;
      command = '';
      continue;
    }
    if (type === 'M') {
      const next = readPoint(relative);
      addPoint(points, next);
      cursor = next;
      subpathStart = next;
      previousControl = undefined;
      command = relative ? 'l' : 'L';
      continue;
    }
    if (type === 'L') {
      const next = readPoint(relative);
      addPoint(points, next);
      cursor = next;
      previousControl = undefined;
      continue;
    }
    if (type === 'H' || type === 'V') {
      const value = read();
      const next = type === 'H' ? point(relative ? cursor.x + value : value, cursor.y) : point(cursor.x, relative ? cursor.y + value : value);
      addPoint(points, next);
      cursor = next;
      previousControl = undefined;
      continue;
    }
    if (type === 'C') {
      const controlFirst = readPoint(relative);
      const controlSecond = readPoint(relative);
      const next = readPoint(relative);
      points.push(...cubic(cursor, controlFirst, controlSecond, next, Math.max(4, Math.ceil(distance(cursor, next) / tolerance))));
      cursor = next;
      previousControl = controlSecond;
      continue;
    }
    if (type === 'S') {
      const controlFirst = previousControl ? point(2 * cursor.x - previousControl.x, 2 * cursor.y - previousControl.y) : cursor;
      const controlSecond = readPoint(relative);
      const next = readPoint(relative);
      points.push(...cubic(cursor, controlFirst, controlSecond, next, Math.max(4, Math.ceil(distance(cursor, next) / tolerance))));
      cursor = next;
      previousControl = controlSecond;
      continue;
    }
    if (type === 'Q') {
      const control = readPoint(relative);
      const next = readPoint(relative);
      points.push(...quadratic(cursor, control, next, Math.max(4, Math.ceil(distance(cursor, next) / tolerance))));
      cursor = next;
      previousControl = control;
      continue;
    }
    if (type === 'T') {
      const control = previousControl ? point(2 * cursor.x - previousControl.x, 2 * cursor.y - previousControl.y) : cursor;
      const next = readPoint(relative);
      points.push(...quadratic(cursor, control, next, Math.max(4, Math.ceil(distance(cursor, next) / tolerance))));
      cursor = next;
      previousControl = control;
      continue;
    }
    if (type === 'A') {
      const rx = read();
      const ry = read();
      const rotation = read();
      const largeArc = Boolean(read());
      const sweep = Boolean(read());
      const next = readPoint(relative);
      points.push(...arcToPoints(cursor, rx, ry, rotation, largeArc, sweep, next));
      cursor = next;
      previousControl = undefined;
      continue;
    }
    index += 1;
  }
  return points;
}

function parseSvg(svgText, options = {}) {
  if (typeof DOMParser === 'undefined') throw new Error('SVG 解析需要浏览器 DOMParser。');
  const document = new DOMParser().parseFromString(svgText, 'image/svg+xml');
  const parseError = document.querySelector('parsererror');
  if (parseError) throw new Error('SVG 文件格式无效。');
  const root = document.documentElement;
  const viewBox = (root.getAttribute('viewBox') || '').trim().match(/[-+]?\d*\.?\d+/g)?.map(Number);
  const viewBoxWidth = viewBox?.[2] || 0;
  const viewBoxHeight = viewBox?.[3] || 0;
  const width = root.hasAttribute('width') ? parseUnit(root.getAttribute('width'), viewBoxWidth || 1, 'px') : (viewBoxWidth || 1) * SVG_UNIT_TO_MM.px;
  const height = root.hasAttribute('height') ? parseUnit(root.getAttribute('height'), viewBoxHeight || 1, 'px') : (viewBoxHeight || 1) * SVG_UNIT_TO_MM.px;
  const scaleX = viewBoxWidth ? width / viewBoxWidth : 25.4 / 96;
  const scaleY = viewBoxHeight ? height / viewBoxHeight : 25.4 / 96;
  const tolerance = number(options.tolerance, 0.2) / Math.max(scaleX, scaleY, 0.00001);
  const paths = [];
  const addPath = (rawPoints, closed, matrix) => {
    if (rawPoints.length < 2) return;
    const transformed = rawPoints.map(value => applyMatrix(matrix, point(value.x * scaleX, value.y * scaleY)));
    paths.push({ points: transformed, closed: Boolean(closed), source: 'svg' });
  };
  const walk = (element, parentMatrix) => {
    const matrix = multiplyMatrix(parentMatrix, parseTransform(element.getAttribute('transform')));
    const tag = element.tagName.toLowerCase();
    if (tag === 'line') {
      addPath([point(element.getAttribute('x1'), element.getAttribute('y1')), point(element.getAttribute('x2'), element.getAttribute('y2'))], false, matrix);
    } else if (tag === 'polyline' || tag === 'polygon') {
      addPath(parsePoints(element.getAttribute('points')), tag === 'polygon', matrix);
    } else if (tag === 'rect') {
      const x = number(element.getAttribute('x'));
      const y = number(element.getAttribute('y'));
      const widthValue = number(element.getAttribute('width'));
      const heightValue = number(element.getAttribute('height'));
      addPath([point(x, y), point(x + widthValue, y), point(x + widthValue, y + heightValue), point(x, y + heightValue), point(x, y)], true, matrix);
    } else if (tag === 'circle' || tag === 'ellipse') {
      const centerX = number(element.getAttribute('cx'));
      const centerY = number(element.getAttribute('cy'));
      const radiusX = number(element.getAttribute(tag === 'circle' ? 'r' : 'rx'));
      const radiusY = number(element.getAttribute(tag === 'circle' ? 'r' : 'ry'));
      const circlePoints = [];
      for (let step = 0; step <= 72; step += 1) {
        const angle = step / 72 * Math.PI * 2;
        circlePoints.push(point(centerX + radiusX * Math.cos(angle), centerY + radiusY * Math.sin(angle)));
      }
      addPath(circlePoints, true, matrix);
    } else if (tag === 'path') {
      addPath(parsePathData(element.getAttribute('d'), tolerance), false, matrix);
    }
    for (const child of element.children) walk(child, matrix);
  };
  walk(root, { a: 1, b: 0, c: 0, d: 1, e: viewBox?.[0] ? -viewBox[0] * scaleX : 0, f: viewBox?.[1] ? -viewBox[1] * scaleY : 0 });
  return { paths, width, height, format: 'svg' };
}

function dxfPairs(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const pairs = [];
  for (let index = 0; index + 1 < lines.length; index += 2) {
    pairs.push({ code: Number.parseInt(lines[index].trim(), 10), value: lines[index + 1].trim() });
  }
  return pairs;
}

function pairValue(entity, code, fallback = 0) {
  const found = entity.find(item => item.code === code);
  return found ? number(found.value, fallback) : fallback;
}

function bulgePoints(first, second, bulge, segments = 18) {
  if (!bulge) return [second];
  const chord = distance(first, second);
  const angle = 4 * Math.atan(bulge);
  const radius = chord / (2 * Math.sin(Math.abs(angle) / 2));
  const midpoint = point((first.x + second.x) / 2, (first.y + second.y) / 2);
  const normal = point(-(second.y - first.y) / chord, (second.x - first.x) / chord);
  const offset = Math.sqrt(Math.max(0, radius ** 2 - (chord / 2) ** 2)) * Math.sign(bulge);
  const center = point(midpoint.x + normal.x * offset, midpoint.y + normal.y * offset);
  const start = Math.atan2(first.y - center.y, first.x - center.x);
  let delta = angle;
  if (bulge > 0 && delta < 0) delta += Math.PI * 2;
  if (bulge < 0 && delta > 0) delta -= Math.PI * 2;
  const count = Math.max(2, Math.ceil(Math.abs(delta) / (Math.PI / segments)));
  const result = [];
  for (let index = 1; index <= count; index += 1) {
    const current = start + delta * index / count;
    result.push(point(center.x + radius * Math.cos(current), center.y + radius * Math.sin(current)));
  }
  return result;
}

function parseDxf(text) {
  const pairs = dxfPairs(text);
  const sectionStart = pairs.findIndex(item => item.code === 2 && item.value.toUpperCase() === 'ENTITIES');
  const sectionEnd = sectionStart >= 0 ? pairs.findIndex((item, index) => index > sectionStart && item.code === 0 && item.value.toUpperCase() === 'ENDSEC') : -1;
  const entities = [];
  let current = null;
  const end = sectionEnd >= 0 ? sectionEnd : pairs.length;
  for (let index = Math.max(sectionStart + 1, 0); index < end; index += 1) {
    const item = pairs[index];
    if (item.code === 0) {
      if (current) entities.push(current);
      current = { type: item.value.toUpperCase(), pairs: [] };
    } else if (current) {
      current.pairs.push(item);
    }
  }
  if (current) entities.push(current);
  const paths = [];
  for (let entityIndex = 0; entityIndex < entities.length; entityIndex += 1) {
    const entity = entities[entityIndex];
    const data = entity.pairs;
    if (entity.type === 'LINE') {
      paths.push({ points: [point(pairValue(data, 10), pairValue(data, 20)), point(pairValue(data, 11), pairValue(data, 21))], closed: false, source: 'dxf' });
    } else if (entity.type === 'CIRCLE' || entity.type === 'ARC') {
      const center = point(pairValue(data, 10), pairValue(data, 20));
      const radius = pairValue(data, 40);
      const start = entity.type === 'ARC' ? pairValue(data, 50) : 0;
      const endAngle = entity.type === 'ARC' ? pairValue(data, 51) : 360;
      let sweep = endAngle - start;
      if (sweep <= 0) sweep += 360;
      const count = Math.max(8, Math.ceil(sweep / 5));
      const circlePoints = [];
      for (let index = 0; index <= count; index += 1) {
        const angle = (start + sweep * index / count) * Math.PI / 180;
        circlePoints.push(point(center.x + radius * Math.cos(angle), center.y + radius * Math.sin(angle)));
      }
      paths.push({ points: circlePoints, closed: entity.type === 'CIRCLE', source: 'dxf' });
    } else if (entity.type === 'LWPOLYLINE') {
      const vertices = [];
      let vertex = null;
      for (const item of data) {
        if (item.code === 10) {
          if (vertex) vertices.push(vertex);
          vertex = { x: number(item.value), y: 0, bulge: 0 };
        } else if (vertex && item.code === 20) vertex.y = number(item.value);
        else if (vertex && item.code === 42) vertex.bulge = number(item.value);
      }
      if (vertex) vertices.push(vertex);
      if (vertices.length > 1) {
        const polyline = [point(vertices[0].x, vertices[0].y)];
        const isClosed = data.some(item => item.code === 70 && (Number.parseInt(item.value, 10) & 1) === 1);
        for (let index = 0; index < vertices.length - 1; index += 1) {
          polyline.push(...bulgePoints(vertices[index], vertices[index + 1], vertices[index].bulge));
        }
        if (isClosed) polyline.push(...bulgePoints(vertices.at(-1), vertices[0], vertices.at(-1).bulge));
        paths.push({ points: polyline, closed: isClosed, source: 'dxf' });
      }
    } else if (entity.type === 'POLYLINE') {
      const vertices = [];
      let nextEntityIndex = entityIndex + 1;
      while (nextEntityIndex < entities.length && entities[nextEntityIndex].type === 'VERTEX') {
        const vertexData = entities[nextEntityIndex].pairs;
        vertices.push({
          x: pairValue(vertexData, 10),
          y: pairValue(vertexData, 20),
          bulge: pairValue(vertexData, 42)
        });
        nextEntityIndex += 1;
      }
      if (entities[nextEntityIndex]?.type === 'SEQEND') entityIndex = nextEntityIndex;
      if (vertices.length > 1) {
        const polyline = [point(vertices[0].x, vertices[0].y)];
        const isClosed = (Math.trunc(pairValue(data, 70)) & 1) === 1;
        for (let index = 0; index < vertices.length - 1; index += 1) {
          polyline.push(...bulgePoints(vertices[index], vertices[index + 1], vertices[index].bulge));
        }
        if (isClosed) polyline.push(...bulgePoints(vertices.at(-1), vertices[0], vertices.at(-1).bulge));
        paths.push({ points: polyline, closed: isClosed, source: 'dxf' });
      }
    }
  }
  return { paths, format: 'dxf' };
}

function parseVectorFile(name, text, options = {}) {
  const extension = String(name).split('.').pop().toLowerCase();
  if (extension === 'svg') return parseSvg(text, options);
  if (extension === 'dxf') return parseDxf(text);
  throw new Error(`不支持的文件格式：${extension || '未知'}`);
}

function joinConnectedPaths(paths, epsilon = 0.05) {
  const remaining = paths.map(pathValue => ({
    ...pathValue,
    points: pathValue.points.map(value => point(value.x, value.y))
  }));
  const groups = [];
  while (remaining.length) {
    const current = remaining.shift();
    let merged = true;
    while (merged && !current.closed && current.points.length > 1) {
      merged = false;
      for (let index = 0; index < remaining.length; index += 1) {
        const candidate = remaining[index];
        if (samePoint(current.points.at(-1), candidate.points[0], epsilon)) {
          current.points.push(...candidate.points.slice(1));
        } else if (samePoint(current.points.at(-1), candidate.points.at(-1), epsilon)) {
          current.points.push(...candidate.points.slice(0, -1).reverse());
        } else if (samePoint(current.points[0], candidate.points.at(-1), epsilon)) {
          current.points = candidate.points.slice(0, -1).concat(current.points);
        } else if (samePoint(current.points[0], candidate.points[0], epsilon)) {
          current.points = candidate.points.slice(1).reverse().concat(current.points);
        } else {
          continue;
        }
        remaining.splice(index, 1);
        merged = true;
        break;
      }
      if (samePoint(current.points[0], current.points.at(-1), epsilon)) current.closed = true;
    }
    groups.push(current);
  }
  return groups;
}

function pointSegmentDistance(value, first, second) {
  const deltaX = second.x - first.x;
  const deltaY = second.y - first.y;
  const lengthSquared = deltaX ** 2 + deltaY ** 2;
  if (!lengthSquared) return distance(value, first);
  const ratio = Math.max(0, Math.min(1, ((value.x - first.x) * deltaX + (value.y - first.y) * deltaY) / lengthSquared));
  return distance(value, point(first.x + deltaX * ratio, first.y + deltaY * ratio));
}

function orientation(first, second, third) {
  return (second.x - first.x) * (third.y - first.y) - (second.y - first.y) * (third.x - first.x);
}

function segmentsIntersect(first, second, third, fourth, epsilon) {
  const firstOrientation = orientation(first, second, third);
  const secondOrientation = orientation(first, second, fourth);
  const thirdOrientation = orientation(third, fourth, first);
  const fourthOrientation = orientation(third, fourth, second);
  const crosses = ((firstOrientation > epsilon && secondOrientation < -epsilon) || (firstOrientation < -epsilon && secondOrientation > epsilon)) && ((thirdOrientation > epsilon && fourthOrientation < -epsilon) || (thirdOrientation < -epsilon && fourthOrientation > epsilon));
  if (crosses) return true;
  return (Math.abs(firstOrientation) <= epsilon && pointSegmentDistance(third, first, second) <= epsilon) ||
    (Math.abs(secondOrientation) <= epsilon && pointSegmentDistance(fourth, first, second) <= epsilon) ||
    (Math.abs(thirdOrientation) <= epsilon && pointSegmentDistance(first, third, fourth) <= epsilon) ||
    (Math.abs(fourthOrientation) <= epsilon && pointSegmentDistance(second, third, fourth) <= epsilon);
}

function segmentDistance(first, second, third, fourth, epsilon) {
  if (segmentsIntersect(first, second, third, fourth, epsilon)) return 0;
  return Math.min(
    pointSegmentDistance(first, third, fourth),
    pointSegmentDistance(second, third, fourth),
    pointSegmentDistance(third, first, second),
    pointSegmentDistance(fourth, first, second)
  );
}

function boxesContain(outer, inner, epsilon) {
  return outer.minX - epsilon <= inner.minX && outer.minY - epsilon <= inner.minY && outer.maxX + epsilon >= inner.maxX && outer.maxY + epsilon >= inner.maxY;
}

function boxesOverlap(first, second, epsilon) {
  return first.minX <= second.maxX + epsilon && first.maxX + epsilon >= second.minX && first.minY <= second.maxY + epsilon && first.maxY + epsilon >= second.minY;
}

function pathsConnected(first, second, firstBounds, secondBounds, epsilon) {
  if (boxesContain(firstBounds, secondBounds, epsilon) || boxesContain(secondBounds, firstBounds, epsilon)) return true;
  if (!boxesOverlap(firstBounds, secondBounds, epsilon)) return false;
  for (let firstIndex = 0; firstIndex < first.points.length - 1; firstIndex += 1) {
    const firstStart = first.points[firstIndex];
    const firstEnd = first.points[firstIndex + 1];
    for (let secondIndex = 0; secondIndex < second.points.length - 1; secondIndex += 1) {
      if (segmentDistance(firstStart, firstEnd, second.points[secondIndex], second.points[secondIndex + 1], epsilon) <= epsilon) return true;
    }
  }
  return false;
}

function groupConnectedPaths(paths, epsilon = 0.05) {
  const parent = paths.map((_, index) => index);
  const find = value => {
    let current = value;
    while (parent[current] !== current) {
      parent[current] = parent[parent[current]];
      current = parent[current];
    }
    return current;
  };
  const union = (first, second) => {
    const firstRoot = find(first);
    const secondRoot = find(second);
    if (firstRoot !== secondRoot) parent[secondRoot] = firstRoot;
  };
  const pathBounds = paths.map(pathValue => bounds([pathValue]));
  for (let firstIndex = 0; firstIndex < paths.length; firstIndex += 1) {
    for (let secondIndex = firstIndex + 1; secondIndex < paths.length; secondIndex += 1) {
      if (pathsConnected(paths[firstIndex], paths[secondIndex], pathBounds[firstIndex], pathBounds[secondIndex], epsilon)) union(firstIndex, secondIndex);
    }
  }
  const grouped = new Map();
  paths.forEach((pathValue, index) => {
    const root = find(index);
    if (!grouped.has(root)) grouped.set(root, []);
    grouped.get(root).push(pathValue);
  });
  const result = [...grouped.values()];
  let merged = true;
  while (merged) {
    merged = false;
    for (let firstIndex = 0; firstIndex < result.length && !merged; firstIndex += 1) {
      const firstBounds = bounds(result[firstIndex]);
      for (let secondIndex = firstIndex + 1; secondIndex < result.length; secondIndex += 1) {
        const secondBounds = bounds(result[secondIndex]);
        if (boxesContain(firstBounds, secondBounds, epsilon) || boxesContain(secondBounds, firstBounds, epsilon)) {
          result[firstIndex].push(...result[secondIndex]);
          result.splice(secondIndex, 1);
          merged = true;
          break;
        }
      }
    }
  }
  return result.map(group => ({ paths: group, component: true }));
}

function bounds(paths) {
  const values = paths.flatMap(pathValue => pathValue.points);
  if (!values.length) return { minX: 0, minY: 0, maxX: 0, maxY: 0, width: 0, height: 0 };
  const minX = Math.min(...values.map(value => value.x));
  const minY = Math.min(...values.map(value => value.y));
  const maxX = Math.max(...values.map(value => value.x));
  const maxY = Math.max(...values.map(value => value.y));
  return { minX, minY, maxX, maxY, width: maxX - minX, height: maxY - minY };
}

function transformPaths(paths, transform = {}) {
  const scaleX = number(transform.scaleX, number(transform.scale, 1));
  const scaleY = number(transform.scaleY, number(transform.scale, 1));
  const angle = number(transform.rotate, 0) * Math.PI / 180;
  const cosine = Math.cos(angle);
  const sine = Math.sin(angle);
  const offsetX = number(transform.x, 0);
  const offsetY = number(transform.y, 0);
  return paths.map(pathValue => ({
    ...pathValue,
    points: pathValue.points.map(value => point(
      value.x * scaleX * cosine - value.y * scaleY * sine + offsetX,
      value.x * scaleX * sine + value.y * scaleY * cosine + offsetY
    ))
  }));
}

function arrangeGrid(items, options = {}) {
  const columns = Math.max(1, Math.floor(number(options.columns, 2)));
  const gapX = number(options.gapX, 10);
  const gapY = number(options.gapY, 10);
  const arranged = [];
  let rowHeight = 0;
  let x = 0;
  let y = 0;
  items.forEach((item, index) => {
    const itemBounds = bounds(item.paths);
    if (index && index % columns === 0) {
      x = 0;
      y += rowHeight + gapY;
      rowHeight = 0;
    }
    arranged.push({ ...item, transform: { ...item.transform, x, y } });
    x += itemBounds.width * number(item.transform?.scale, 1) + gapX;
    rowHeight = Math.max(rowHeight, itemBounds.height * number(item.transform?.scale, 1));
  });
  return arranged;
}

function arrangeAuto(items, options = {}) {
  const spacing = Math.max(0, number(options.spacing, 10));
  const layoutWidth = Math.max(1, number(options.layoutWidth, 200));
  let cursorX = 0;
  let cursorY = 0;
  let rowHeight = 0;
  return items.map(item => {
    const baseTransform = { ...item.transform, x: 0, y: 0 };
    const itemBounds = bounds(transformPaths(item.paths, baseTransform));
    if (cursorX > 0 && cursorX + itemBounds.width > layoutWidth) {
      cursorX = 0;
      cursorY += rowHeight + spacing;
      rowHeight = 0;
    }
    const transform = {
      ...item.transform,
      x: cursorX - itemBounds.minX,
      y: cursorY - itemBounds.minY
    };
    cursorX += itemBounds.width + spacing;
    rowHeight = Math.max(rowHeight, itemBounds.height);
    return { ...item, transform };
  });
}

function arrangeOnSheet(items, options = {}) {
  const sheetWidth = Math.max(1, number(options.sheetWidth, 500));
  const sheetHeight = Math.max(1, number(options.sheetHeight, 800));
  const spacing = Math.max(0, number(options.spacing, 10));
  const direction = options.direction === 'vertical' ? 'vertical' : 'horizontal';
  const prepared = items.map((item, index) => {
    const baseTransform = { ...item.transform, x: 0, y: 0 };
    const itemBounds = bounds(transformPaths(item.paths, baseTransform));
    return { item, index, itemBounds, area: itemBounds.width * itemBounds.height };
  }).sort((first, second) => second.area - first.area);
  const arranged = [];
  let cursorX = 0;
  let cursorY = 0;
  let shelfDepth = 0;
  let overflow = 0;
  for (const entry of prepared) {
    const { item, itemBounds } = entry;
    const itemWidth = itemBounds.width;
    const itemHeight = itemBounds.height;
    if (direction === 'horizontal') {
      if (cursorX > 0 && cursorX + itemWidth > sheetWidth) {
        cursorX = 0;
        cursorY += shelfDepth + spacing;
        shelfDepth = 0;
      }
      if (cursorY + itemHeight > sheetHeight) overflow += 1;
      item.transform = { ...item.transform, x: cursorX - itemBounds.minX, y: cursorY - itemBounds.minY };
      cursorX += itemWidth + spacing;
      shelfDepth = Math.max(shelfDepth, itemHeight);
    } else {
      if (cursorY > 0 && cursorY + itemHeight > sheetHeight) {
        cursorY = 0;
        cursorX += shelfDepth + spacing;
        shelfDepth = 0;
      }
      if (cursorX + itemWidth > sheetWidth) overflow += 1;
      item.transform = { ...item.transform, x: cursorX - itemBounds.minX, y: cursorY - itemBounds.minY };
      cursorY += itemHeight + spacing;
      shelfDepth = Math.max(shelfDepth, itemWidth);
    }
    arranged.push({ item, index: entry.index });
  }
  arranged.sort((first, second) => first.index - second.index);
  return { items: arranged.map(entry => entry.item), overflow, sheetWidth, sheetHeight, spacing, direction };
}

function arrangeOnSheets(items, options = {}) {
  const sheetWidth = Math.max(1, number(options.sheetWidth, 500));
  const sheetHeight = Math.max(1, number(options.sheetHeight, 800));
  const spacing = Math.max(0, number(options.spacing, 10));
  const direction = options.direction === 'vertical' ? 'vertical' : 'horizontal';
  const prepared = items.map((item, index) => {
    const baseTransform = { ...item.transform, x: 0, y: 0 };
    const itemBounds = bounds(transformPaths(item.paths, baseTransform));
    return { item, index, itemBounds, area: itemBounds.width * itemBounds.height };
  }).sort((first, second) => second.area - first.area);
  const pages = [];
  let currentPage = null;
  let overflow = 0;
  const createPage = () => {
    currentPage = { sheetIndex: pages.length, itemCount: 0, cursorX: 0, cursorY: 0, shelfDepth: 0 };
    pages.push(currentPage);
    return currentPage;
  };
  const place = entry => {
    const { item, itemBounds } = entry;
    const itemWidth = itemBounds.width;
    const itemHeight = itemBounds.height;
    if (direction === 'horizontal') {
      if (currentPage.cursorX > 0 && currentPage.cursorX + itemWidth > sheetWidth) {
        currentPage.cursorX = 0;
        currentPage.cursorY += currentPage.shelfDepth + spacing;
        currentPage.shelfDepth = 0;
      }
      if (currentPage.cursorY + itemHeight > sheetHeight) return false;
      item.transform = { ...item.transform, x: currentPage.cursorX - itemBounds.minX, y: currentPage.cursorY - itemBounds.minY, sheetIndex: currentPage.sheetIndex };
      currentPage.cursorX += itemWidth + spacing;
      currentPage.shelfDepth = Math.max(currentPage.shelfDepth, itemHeight);
    } else {
      if (currentPage.cursorY > 0 && currentPage.cursorY + itemHeight > sheetHeight) {
        currentPage.cursorY = 0;
        currentPage.cursorX += currentPage.shelfDepth + spacing;
        currentPage.shelfDepth = 0;
      }
      if (currentPage.cursorX + itemWidth > sheetWidth) return false;
      item.transform = { ...item.transform, x: currentPage.cursorX - itemBounds.minX, y: currentPage.cursorY - itemBounds.minY, sheetIndex: currentPage.sheetIndex };
      currentPage.cursorY += itemHeight + spacing;
      currentPage.shelfDepth = Math.max(currentPage.shelfDepth, itemWidth);
    }
    currentPage.itemCount += 1;
    return true;
  };
  for (const entry of prepared) {
    if (entry.itemBounds.width > sheetWidth || entry.itemBounds.height > sheetHeight) {
      if (!currentPage || currentPage.itemCount) createPage();
      entry.item.transform = { ...entry.item.transform, x: -entry.itemBounds.minX, y: -entry.itemBounds.minY, sheetIndex: currentPage.sheetIndex };
      currentPage.itemCount += 1;
      overflow += 1;
      continue;
    }
    let placed = false;
    for (const page of pages) {
      currentPage = page;
      if (place(entry)) {
        placed = true;
        break;
      }
    }
    if (!placed) {
      createPage();
      if (!place(entry)) overflow += 1;
    }
  }
  const arranged = prepared.map(entry => ({ item: entry.item, index: entry.index })).sort((first, second) => first.index - second.index).map(entry => entry.item);
  return {
    items: arranged,
    sheets: pages.filter(page => page.itemCount > 0).map(page => ({ sheetIndex: page.sheetIndex, itemCount: page.itemCount })),
    overflow,
    sheetWidth,
    sheetHeight,
    spacing,
    direction
  };
}

function arrangeOnSheetsTight(items, options = {}) {
  const sheetWidth = Math.max(1, number(options.sheetWidth, 500));
  const sheetHeight = Math.max(1, number(options.sheetHeight, 800));
  const spacing = Math.max(0, number(options.spacing, 10));
  const direction = options.direction === 'vertical' ? 'vertical' : 'horizontal';
  const globalScale = number(options.globalTransform?.scale, 1);
  const globalRotate = number(options.globalTransform?.rotate, 0);
  const prepared = items.map((item, index) => {
    const baseTransform = {
      ...item.transform,
      x: 0,
      y: 0,
      scale: number(item.transform?.scale, 1) * globalScale,
      rotate: number(item.transform?.rotate, 0) + globalRotate
    };
    const itemBounds = bounds(transformPaths(item.paths, baseTransform));
    return { item, index, itemBounds, area: itemBounds.width * itemBounds.height };
  }).sort((first, second) => second.area - first.area);
  const pages = [];
  let currentPage = null;
  let overflow = 0;
  const createPage = () => {
    currentPage = { sheetIndex: pages.length, itemCount: 0, placed: [] };
    pages.push(currentPage);
    return currentPage;
  };
  const fits = (candidate, itemBounds, page) => {
    if (candidate.x < 0 || candidate.y < 0 || candidate.x + itemBounds.width > sheetWidth || candidate.y + itemBounds.height > sheetHeight) return false;
    return !page.placed.some(rect => candidate.x < rect.maxX + spacing && candidate.x + itemBounds.width + spacing > rect.minX && candidate.y < rect.maxY + spacing && candidate.y + itemBounds.height + spacing > rect.minY);
  };
  const place = entry => {
    const xCandidates = [0];
    const yCandidates = [0];
    currentPage.placed.forEach(rect => {
      xCandidates.push(rect.minX, rect.maxX + spacing);
      yCandidates.push(rect.minY, rect.maxY + spacing);
    });
    const candidates = xCandidates.flatMap(x => yCandidates.map(y => ({ x, y })));
    const ordered = candidates.sort((first, second) => direction === 'horizontal' ? first.y - second.y || first.x - second.x : first.x - second.x || first.y - second.y);
    const candidate = ordered.find(value => fits(value, entry.itemBounds, currentPage));
    if (!candidate) return false;
    entry.item.transform = { ...entry.item.transform, x: candidate.x - entry.itemBounds.minX, y: candidate.y - entry.itemBounds.minY, sheetIndex: currentPage.sheetIndex };
    currentPage.placed.push({ minX: candidate.x, minY: candidate.y, maxX: candidate.x + entry.itemBounds.width, maxY: candidate.y + entry.itemBounds.height });
    currentPage.itemCount += 1;
    return true;
  };
  for (const entry of prepared) {
    if (!currentPage) createPage();
    if (entry.itemBounds.width > sheetWidth || entry.itemBounds.height > sheetHeight) {
      if (currentPage.itemCount) createPage();
      entry.item.transform = { ...entry.item.transform, x: -entry.itemBounds.minX, y: -entry.itemBounds.minY, sheetIndex: currentPage.sheetIndex };
      currentPage.itemCount += 1;
      overflow += 1;
      continue;
    }
    if (!place(entry)) {
      createPage();
      if (!place(entry)) overflow += 1;
    }
  }
  const arranged = prepared.map(entry => ({ item: entry.item, index: entry.index })).sort((first, second) => first.index - second.index).map(entry => entry.item);
  return {
    items: arranged,
    sheets: pages.filter(page => page.itemCount > 0).map(page => ({ sheetIndex: page.sheetIndex, itemCount: page.itemCount })),
    overflow,
    sheetWidth,
    sheetHeight,
    spacing,
    direction
  };
}

function formatNumber(value, decimals = 3) {
  if (decimals === 0) return String(Math.round(number(value)));
  return number(value).toFixed(decimals).replace(/0+$/, '').replace(/\.$/, '') || '0';
}

function generateGcode(items, options = {}) {
  const safeZ = number(options.safeZ, 5);
  const cutZ = number(options.cutZ, -1);
  const plungeFeed = number(options.plungeFeed, 100);
  const cutFeed = number(options.cutFeed, 500);
  const decimals = Math.max(0, Math.floor(number(options.decimals, 3)));
  const lines = ['; Vector G-code', '; Units: millimeters', '; No spindle or laser commands', 'G21', 'G90', 'G17', 'G94', `G0 Z${formatNumber(safeZ, decimals)}`];
  let pathCount = 0;
  let currentSheet = null;
  for (const item of items) {
    const sheetIndex = item.transform?.sheetIndex ?? item.sheetIndex ?? 0;
    if (sheetIndex !== currentSheet) {
      lines.push(`; Sheet ${sheetIndex + 1}`);
      currentSheet = sheetIndex;
    }
    for (const pathValue of transformPaths(item.paths, item.transform || {})) {
      if (pathValue.points.length < 2) continue;
      const points = pathValue.closed && !samePoint(pathValue.points[0], pathValue.points.at(-1)) ? [...pathValue.points, pathValue.points[0]] : pathValue.points;
      const first = points[0];
      lines.push(`G0 X${formatNumber(first.x, decimals)} Y${formatNumber(first.y, decimals)}`);
      lines.push(`G1 Z${formatNumber(cutZ, decimals)} F${formatNumber(plungeFeed, 0)}`);
      for (let index = 1; index < points.length; index += 1) {
        lines.push(`G1 X${formatNumber(points[index].x, decimals)} Y${formatNumber(points[index].y, decimals)} F${formatNumber(cutFeed, 0)}`);
      }
      lines.push(`G0 Z${formatNumber(safeZ, decimals)}`);
      pathCount += 1;
    }
  }
  lines.push(`G0 Z${formatNumber(safeZ, decimals)}`, 'M2');
  return { code: lines.join('\n') + '\n', pathCount };
}

export {
  arrangeAuto,
  arrangeGrid,
  arrangeOnSheet,
  arrangeOnSheets,
  arrangeOnSheetsTight,
  bounds,
  measureSegment,
  generateGcode,
  groupConnectedPaths,
  joinConnectedPaths,
  parseDxf,
  parseSvg,
  parseVectorFile,
  transformPaths
};
