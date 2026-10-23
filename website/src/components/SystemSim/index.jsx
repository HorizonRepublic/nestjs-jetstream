import React, { useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import './styles.css';

/* A small JetStream system as a conveyor floor behind the hero, drawn in 2:1
   dimetric. The stream is a closed loop and a message stays on it until a pod
   acks it. Services feed the loop from the left; NestJS pods along the right
   take messages off as they pass. An ack sends a message out to the right; a
   nak, or a pod going down, sends it back onto the loop, where it rides until
   its retry delay is over. Every message gets acked in the end.

   Every belt starts and ends inside a block or the loop, and every message
   moves only along a belt. */

/* ---- layout ------------------------------------------------------------- */

const MODEL = { w: 600, h: 240 };
const BELT_Z = 6;
const BELT_W = 14;
const LOOP_W = 20;
const GAP = 13;
const BOX = { size: 9, height: 7 };
const POD = { size: 36, height: 32, downHeight: 10 };
const DOCK = { size: 30, height: 24 };
const LANES = [70, 120, 170];
const LOOP = { x0: 160, x1: 420, y0: 20, y1: 220, r: 36 };
const POD_X = 480;
const DOCK_X = 60;
const OUTBOX = { x: 566, y: 120, sx: 24, sy: 150, height: 14 };

const FAIL_CHANCE = [0.3, 0.2, 0];
const RETRY_MS = 2000;
const RESTART_MS = 3400;
const MANUAL_DOWN_MS = 20000;
const DEPLOY_EVERY_MS = 25000;
const DOWN_RING_MS = 1100;
const SUBJECTS = ['orders.created', 'payments.captured', 'users.updated', 'emails.send', 'stock.reserved'];
const HINT_KEY = 'jt-scene-clicked';

/* ---- paths -------------------------------------------------------------- */

const p3 = (x, y, z = BELT_Z) => ({ x, y, z });

const makePath = (points, closed = false) => {
  const pts = closed ? [...points, points[0]] : points;
  const lengths = pts.slice(1).map((p, i) => Math.hypot(p.x - pts[i].x, p.y - pts[i].y, p.z - pts[i].z));

  return { points, pts, lengths, length: lengths.reduce((a, b) => a + b, 0), closed };
};

const pointAt = (path, s) => {
  let left = path.closed ? ((s % path.length) + path.length) % path.length : Math.max(0, Math.min(s, path.length));

  for (let i = 0; i < path.lengths.length; i += 1) {
    if (left <= path.lengths[i] || i === path.lengths.length - 1) {
      const t = path.lengths[i] ? Math.min(1, left / path.lengths[i]) : 0;
      const a = path.pts[i];
      const c = path.pts[i + 1];

      return { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: a.z + (c.z - a.z) * t };
    }

    left -= path.lengths[i];
  }

  return path.pts.at(-1);
};

/* The loop: a rounded rectangle, travelled clockwise from the top-left. */
const loopPoints = ({ x0, x1, y0, y1, r }) => {
  const points = [];
  const arc = (cx, cy, from) => {
    for (let i = 1; i <= 12; i += 1) {
      const a = from + (i / 12) * (Math.PI / 2);

      points.push(p3(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
  };

  points.push(p3(x0 + r, y0));
  points.push(p3(x1 - r, y0));
  arc(x1 - r, y0 + r, -Math.PI / 2);
  points.push(p3(x1, y1 - r));
  arc(x1 - r, y1 - r, 0);
  points.push(p3(x0 + r, y1));
  arc(x0 + r, y1 - r, Math.PI / 2);
  points.push(p3(x0, y0 + r));
  arc(x0 + r, y0 + r, Math.PI);
  points.pop();

  return points;
};

/* Where on the loop a point on its centreline sits, as a distance along it. */
const loopS = (path, x, y) => {
  let best = 0;
  let bestD = Infinity;

  for (let s = 0; s < path.length; s += 0.5) {
    const p = pointAt(path, s);
    const d = Math.hypot(p.x - x, p.y - y);

    if (d < bestD) {
      bestD = d;
      best = s;
    }
  }

  return best;
};

/* ---- belts -------------------------------------------------------------- */

const belt = (path, speed) => ({ path, speed, items: [] });

const advance = (b, dt) => {
  b.items.forEach((item, index) => {
    const limit = index === 0 ? b.path.length : b.items[index - 1].s - GAP;

    if (item.s < limit) item.s = Math.min(limit, item.s + b.speed * dt);
  });
};

const atEnd = (b) => b.items.length > 0 && b.items[0].s >= b.path.length - 0.01;
const hasRoom = (b) => !b.items.length || b.items.at(-1).s >= GAP;
const put = (b, item, s = 0) => {
  item.s = s;
  item.belt = b;
  b.items.push(item);
};
const take = (b) => b.items.shift();

const buildFloor = () => {
  const loop = belt(makePath(loopPoints(LOOP), true), 0.2);

  return {
    loop,
    docks: LANES.map((y) => ({ x: DOCK_X, y })),
    pods: LANES.map((y) => ({ x: POD_X, y })),
    inputs: LANES.map((y) => belt(makePath([p3(DOCK_X, y), p3(LOOP.x0, y)]), 0.1)),
    merges: LANES.map((y) => loopS(loop.path, LOOP.x0, y)),
    ins: LANES.map((y) => belt(makePath([p3(LOOP.x1, y), p3(POD_X, y)]), 0.26)),
    outs: LANES.map((y) => belt(makePath([p3(POD_X, y), p3(LOOP.x1, y)]), 0.2)),
    offtakes: LANES.map((y) => loopS(loop.path, LOOP.x1, y)),
    outputs: LANES.map((y) => belt(makePath([p3(POD_X, y), p3(OUTBOX.x, y)]), 0.12)),
  };
};

/* ---- the model ---------------------------------------------------------- */

const createSim = () => ({
  time: 0,
  nextId: 1,
  replicas: LANES.map(() => ({ busy: null, flash: null, flashAt: -1e9, downUntil: 0, manual: false })),
  nextSpawn: 300,
  nextBurst: 4000,
  burstLeft: 0,
  burstAt: 0,
  nextRestart: 16000,
  nextDeploy: 6000,
  deploy: null,
  rings: [],
  spawnTurn: 0,
  stats: { published: 0, retried: 0, acked: 0 },
});

const isDown = (sim, replica) => sim.time < replica.downUntil;

const circularGap = (a, b, length) => {
  const d = Math.abs(a - b) % length;

  return Math.min(d, length - d);
};

const loopFree = (floor, s) => floor.loop.items.every((item) => circularGap(item.s, s, floor.loop.path.length) >= GAP);

/* No ack: the message goes back onto the loop and may be taken again once its
   retry delay is over. */
const redeliver = (sim, floor, item, index) => {
  sim.stats.retried += 1;
  item.processing = false;
  item.retrying = true;
  item.readyAt = sim.time + RETRY_MS;
  put(floor.outs[index], item);
};

const takeDown = (sim, floor, index, ms, manual) => {
  const replica = sim.replicas[index];

  replica.downUntil = sim.time + ms;
  replica.manual = manual;
  sim.rings.push({ index, born: sim.time });

  const item = replica.busy;

  if (item?.processing) {
    replica.busy = null;
    redeliver(sim, floor, item, index);
  }
};

const togglePod = (sim, floor, index) => {
  const replica = sim.replicas[index];

  if (isDown(sim, replica)) {
    replica.downUntil = sim.time;
    replica.manual = false;
  } else {
    takeDown(sim, floor, index, MANUAL_DOWN_MS, true);
  }
};

const podFree = (sim, floor, index) => {
  const replica = sim.replicas[index];

  return !replica.busy && !isDown(sim, replica) && !floor.ins[index].items.length && !floor.outs[index].items.length;
};

const step = (sim, floor, dt) => {
  sim.time += dt;
  const now = sim.time;

  const spawn = () => {
    for (let tries = 0; tries < LANES.length; tries += 1) {
      const dock = (sim.spawnTurn + tries) % LANES.length;

      if (hasRoom(floor.inputs[dock])) {
        const id = sim.nextId++;

        put(floor.inputs[dock], {
          id,
          subject: SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)],
          seq: 4812000 + id,
          attempt: 0,
        });
        sim.stats.published += 1;
        sim.spawnTurn = (dock + 1 + Math.floor(Math.random() * 2)) % LANES.length;

        return;
      }
    }
  };

  if (now >= sim.nextSpawn) {
    spawn();
    sim.nextSpawn = now + 1000 + Math.random() * 900;
  }

  if (now >= sim.nextBurst) {
    sim.burstLeft = 5;
    sim.nextBurst = now + 11000 + Math.random() * 6000;
  }

  if (sim.burstLeft && now >= sim.burstAt) {
    spawn();
    sim.burstLeft -= 1;
    sim.burstAt = now + 160;
  }

  // a rolling deploy: each running pod restarts in turn while the stream holds the work
  if (now >= sim.nextDeploy) {
    sim.deploy = { start: now, done: -1 };
    sim.nextDeploy = now + DEPLOY_EVERY_MS;
    sim.nextRestart = Math.max(sim.nextRestart, now + LANES.length * RESTART_MS + 6000);
  }

  if (sim.deploy) {
    const index = Math.floor((now - sim.deploy.start) / RESTART_MS);

    if (index < LANES.length && index > sim.deploy.done) {
      sim.deploy.done = index;
      if (!isDown(sim, sim.replicas[index])) takeDown(sim, floor, index, RESTART_MS, false);
    } else if (now - sim.deploy.start > LANES.length * RESTART_MS + 600) {
      sim.deploy = null;
    }
  }

  if (now >= sim.nextRestart) {
    const up = LANES.map((_, index) => index).filter((index) => !isDown(sim, sim.replicas[index]));

    if (up.length > 1) takeDown(sim, floor, up[Math.floor(Math.random() * up.length)], RESTART_MS, false);
    sim.nextRestart = now + 11000 + Math.random() * 7000;
  }

  for (const b of [...floor.inputs, ...floor.ins, ...floor.outs, ...floor.outputs]) advance(b, dt);

  // the loop always moves; a pod takes a ready message as it passes the pod's offtake
  const length = floor.loop.path.length;
  const ds = floor.loop.speed * dt;

  for (const item of [...floor.loop.items]) {
    const before = item.s;

    item.s = (item.s + ds) % length;

    for (let index = 0; index < LANES.length; index += 1) {
      const ahead = (((floor.offtakes[index] - before) % length) + length) % length;

      if (ahead > 0 && ahead <= ds && now >= (item.readyAt ?? 0) && podFree(sim, floor, index)) {
        floor.loop.items.splice(floor.loop.items.indexOf(item), 1);
        sim.replicas[index].busy = item;
        put(floor.ins[index], item);
        break;
      }
    }
  }

  // onto the loop: services at the left, pods handing back at the right
  floor.inputs.forEach((input, index) => {
    if (atEnd(input) && loopFree(floor, floor.merges[index])) put(floor.loop, take(input), floor.merges[index]);
  });
  floor.outs.forEach((out, index) => {
    if (atEnd(out) && loopFree(floor, floor.offtakes[index])) put(floor.loop, take(out), floor.offtakes[index]);
  });

  sim.replicas.forEach((replica, index) => {
    if (!isDown(sim, replica)) replica.manual = false;

    // arrival: a pod that went down meanwhile hands the message straight back
    if (atEnd(floor.ins[index])) {
      const item = take(floor.ins[index]);

      if (isDown(sim, replica)) {
        replica.busy = null;
        redeliver(sim, floor, item, index);
      } else {
        item.processing = true;
        item.since = now;
        item.until = now + 350 + Math.random() * 450;
        item.belt = null;
        item.at = floor.pods[index];
      }
    }

    const item = replica.busy;

    if (item?.processing && now >= item.until) {
      item.processing = false;
      replica.busy = null;

      if (Math.random() < FAIL_CHANCE[Math.min(item.attempt, FAIL_CHANCE.length - 1)]) {
        item.attempt += 1;
        replica.flash = 'redeliver';
        replica.flashAt = now;
        redeliver(sim, floor, item, index);
      } else {
        item.retrying = false;
        item.acked = true;
        sim.stats.acked += 1;
        replica.flash = 'ack';
        replica.flashAt = now;
        put(floor.outputs[index], item);
      }
    }
  });

  floor.outputs.forEach((output) => {
    if (atEnd(output)) take(output);
  });

  sim.rings = sim.rings.filter((ring) => now - ring.born < DOWN_RING_MS);
};

const beltsOf = (floor) => [floor.loop, ...floor.inputs, ...floor.ins, ...floor.outs, ...floor.outputs];

const itemsOf = (sim, floor) => {
  const all = [];

  for (const b of beltsOf(floor)) all.push(...b.items);
  for (const replica of sim.replicas) if (replica.busy?.processing) all.push(replica.busy);

  return all;
};

/* ---- rendering ---------------------------------------------------------- */

const ANGLE = Math.atan(0.5);
const COS = Math.cos(ANGLE);
const SIN = Math.sin(ANGLE);

const readPalette = () => {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();

  return {
    dark: document.documentElement.dataset.theme === 'dark',
    deliver: token('--jt-state-deliver'),
    redeliver: token('--jt-state-redeliver'),
    ack: token('--jt-state-ack'),
    dlq: token('--jt-state-dlq'),
    line: token('--jt-line-2'),
    rail: token('--jt-line-3'),
    faint: token('--jt-line-1'),
    raised: token('--jt-bg-2'),
    block: token('--jt-bg-3'),
    surface: token('--jt-bg-1'),
    ink: token('--jt-fg-0'),
    label: token('--jt-fg-3'),
    mono: token('--jt-font-mono') || 'monospace',
  };
};

/* 2:1 dimetric, fitted into a region of the canvas. */
const makeProjector = (cw, ch, region) => {
  const raw = (x, y, z = 0) => ({ x: (x - y) * COS, y: (x + y) * SIN - z });
  const corners = [raw(-20, -20), raw(MODEL.w + 20, -20), raw(-20, MODEL.h + 20), raw(MODEL.w + 20, MODEL.h + 20), raw(MODEL.w, 0, 90)];
  const minX = Math.min(...corners.map((c) => c.x));
  const maxX = Math.max(...corners.map((c) => c.x));
  const minY = Math.min(...corners.map((c) => c.y));
  const maxY = Math.max(...corners.map((c) => c.y));
  const rw = cw * (region.x1 - region.x0);
  const rh = ch * (region.y1 - region.y0);
  const k = Math.min(rw / (maxX - minX), rh / (maxY - minY));
  const ox = cw * region.x0 + (rw - (maxX - minX) * k) / 2 - minX * k;
  const oy = ch * region.y0 + (rh - (maxY - minY) * k) / 2 - minY * k;

  const project = (x, y, z = 0) => {
    const p = raw(x, y, z);

    return { x: ox + p.x * k, y: oy + p.y * k };
  };

  project.k = k;

  return project;
};

const trace = (ctx, points, close = true) => {
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  if (close) ctx.closePath();
};

const fillShape = (ctx, points, color, alpha = 1) => {
  ctx.beginPath();
  trace(ctx, points);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fill();
  ctx.globalAlpha = 1;
};

const shade = (ctx, points, base, light, alpha = 1) => {
  fillShape(ctx, points, base, alpha);
  fillShape(ctx, points, light > 0 ? '#ffffff' : '#000000', alpha * Math.abs(light));
};

/* A lit dimetric block, sx by sy, `lift` above the floor. */
const block = (ctx, project, { cx, cy, sx, sy = sx, height, base, edge, alpha = 1, dashed = false, lift = 0, shadow = true }) => {
  const hx = sx / 2;
  const hy = sy / 2;
  const at = (dx, dy, dz) => project(cx + dx, cy + dy, dz + lift);
  const top = [at(-hx, -hy, height), at(hx, -hy, height), at(hx, hy, height), at(-hx, hy, height)];
  const right = [at(hx, -hy, height), at(hx, hy, height), at(hx, hy, 0), at(hx, -hy, 0)];
  const front = [at(-hx, hy, height), at(hx, hy, height), at(hx, hy, 0), at(-hx, hy, 0)];

  if (shadow) {
    const foot = [project(cx - hx, cy - hy), project(cx + hx + 5, cy - hy), project(cx + hx + 5, cy + hy + 5), project(cx - hx, cy + hy + 5)];

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.4)';
    ctx.shadowBlur = 12 * project.k;
    fillShape(ctx, foot, '#000000', 0.2 * alpha);
    ctx.restore();
  }

  ctx.save();
  shade(ctx, right, base, -0.3, alpha);
  shade(ctx, front, base, -0.12, alpha);
  shade(ctx, top, base, 0.08, alpha);

  if (dashed) ctx.setLineDash([3, 3]);
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = edge;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  trace(ctx, top);
  ctx.moveTo(top[1].x, top[1].y);
  ctx.lineTo(right[3].x, right[3].y);
  ctx.moveTo(top[2].x, top[2].y);
  ctx.lineTo(right[2].x, right[2].y);
  ctx.lineTo(front[3].x, front[3].y);
  ctx.lineTo(top[3].x, top[3].y);
  ctx.moveTo(right[2].x, right[2].y);
  ctx.lineTo(right[3].x, right[3].y);
  ctx.stroke();

  if (!dashed) {
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.16 * alpha;
    ctx.beginPath();
    trace(ctx, [top[3], top[0], top[1]], false);
    ctx.stroke();
  }
  ctx.restore();

  return { top, front, right };
};

const led = (ctx, face, color, alpha = 1) => {
  const [a, b, , d] = face;
  const x = a.x + (b.x - a.x) * 0.2 + (d.x - a.x) * 0.45;
  const y = a.y + (b.y - a.y) * 0.2 + (d.y - a.y) * 0.45;

  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  return { x, y };
};

/* Offset of a path's centreline: the left and right edges of a belt of `width`. */
const edges = (path, width, z) => {
  const pts = path.points;
  const n = pts.length;
  const left = [];
  const right = [];

  for (let i = 0; i < n; i += 1) {
    const prev = path.closed ? pts[(i - 1 + n) % n] : pts[Math.max(0, i - 1)];
    const next = path.closed ? pts[(i + 1) % n] : pts[Math.min(n - 1, i + 1)];
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (width / 2);
    const ny = (dx / len) * (width / 2);

    left.push({ x: pts[i].x + nx, y: pts[i].y + ny, z });
    right.push({ x: pts[i].x - nx, y: pts[i].y - ny, z });
  }

  return { left, right };
};

/* A belt as one continuous body: a dark side, a top surface, two rails, and
   cross-stripes that drift with the belt so its direction reads at a glance. */
const drawBelt = (ctx, project, b, palette, time, { width = BELT_W, stripe = null } = {}) => {
  const path = b.path;
  const proj = (list) => list.map((p) => project(p.x, p.y, p.z));
  const base = edges(path, width, 0);
  const top = edges(path, width, BELT_Z);
  const outline = (e) => (path.closed ? [proj(e.left), proj(e.right)] : [[...proj(e.left), ...proj(e.right).reverse()]]);

  ctx.save();

  // body: the base ring first, so its visible side reads as thickness
  ctx.beginPath();
  for (const ring of outline(base)) trace(ctx, ring);
  ctx.fillStyle = palette.block;
  ctx.globalAlpha = 1;
  ctx.fill('evenodd');
  ctx.fillStyle = '#000000';
  ctx.globalAlpha = 0.3;
  ctx.fill('evenodd');

  ctx.beginPath();
  for (const ring of outline(top)) trace(ctx, ring);
  ctx.globalAlpha = 1;
  ctx.fillStyle = palette.raised;
  ctx.fill('evenodd');

  // rails along both edges
  ctx.lineWidth = 1;
  ctx.lineJoin = 'round';
  ctx.strokeStyle = palette.rail;
  ctx.globalAlpha = 0.9;
  for (const side of [top.left, top.right]) {
    ctx.beginPath();
    trace(ctx, proj(side), path.closed);
    ctx.stroke();
  }

  // stripes
  const spacing = 9;
  const offset = (time * b.speed) % spacing;

  ctx.strokeStyle = stripe ?? palette.line;
  ctx.globalAlpha = stripe ? 0.45 : 0.55;
  ctx.beginPath();
  for (let d = offset; d < path.length - 2; d += spacing) {
    if (d < 2) continue;

    const p = pointAt(path, d);
    const q = pointAt(path, d + 0.5);
    const dx = q.x - p.x;
    const dy = q.y - p.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = (-dy / len) * (width / 2 - 2.5);
    const ny = (dx / len) * (width / 2 - 2.5);
    const a = project(p.x + nx, p.y + ny, BELT_Z);
    const c = project(p.x - nx, p.y - ny, BELT_Z);

    ctx.moveTo(a.x, a.y);
    ctx.lineTo(c.x, c.y);
  }
  ctx.stroke();
  ctx.restore();
};

/* Text on a soft backing, so it stays readable over geometry. */
const label = (ctx, palette, value, x, y, align, color = palette.label, weight = 400) => {
  ctx.font = `${weight} 11px ${palette.mono}`;
  const width = ctx.measureText(value).width;
  let left = x;

  if (align === 'center') left = x - width / 2;
  else if (align === 'right') left = x - width;

  ctx.save();
  ctx.globalAlpha = 0.8;
  ctx.fillStyle = palette.surface;
  ctx.beginPath();
  ctx.roundRect(left - 6, y - 12, width + 12, 17, 4);
  ctx.fill();
  ctx.globalAlpha = 1;
  ctx.fillStyle = color;
  ctx.textAlign = 'left';
  ctx.fillText(value, left, y);
  ctx.restore();
};

const tooltip = (ctx, palette, lines, x, y) => {
  ctx.font = `11px ${palette.mono}`;
  const width = Math.max(...lines.map((line) => ctx.measureText(line.text).width)) + 18;
  const height = lines.length * 16 + 10;
  const left = x + 14;
  const top = y - height - 10;

  ctx.save();
  ctx.globalAlpha = 0.97;
  ctx.fillStyle = palette.surface;
  ctx.strokeStyle = palette.line;
  ctx.shadowColor = 'rgba(0, 0, 0, 0.25)';
  ctx.shadowBlur = 12;
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, 6);
  ctx.fill();
  ctx.shadowBlur = 0;
  ctx.stroke();
  ctx.textAlign = 'left';
  lines.forEach((line, index) => {
    ctx.fillStyle = line.color ?? palette.ink;
    ctx.fillText(line.text, left + 9, top + 18 + index * 16);
  });
  ctx.restore();
};

const drawGrid = (ctx, project, palette) => {
  const centre = project(MODEL.w / 2, MODEL.h / 2);
  const spot = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, 460 * project.k);

  spot.addColorStop(0, palette.dark ? 'rgba(255, 255, 255, 0.04)' : 'rgba(37, 87, 194, 0.045)');
  spot.addColorStop(1, 'transparent');
  ctx.fillStyle = spot;
  ctx.fillRect(centre.x - 700 * project.k, centre.y - 450 * project.k, 1400 * project.k, 900 * project.k);

  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.faint;

  for (let x = -40; x <= MODEL.w + 40; x += 40) {
    const a = project(x, -40);
    const b = project(x, MODEL.h + 40);

    ctx.globalAlpha = 0.45 * (1 - Math.min(1, Math.abs(x - MODEL.w / 2) / (MODEL.w * 0.7)));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (let y = -40; y <= MODEL.h + 40; y += 40) {
    const a = project(-40, y);
    const b = project(MODEL.w + 40, y);

    ctx.globalAlpha = 0.45 * (1 - Math.min(1, Math.abs(y - MODEL.h / 2) / (MODEL.h * 0.9)));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
};

const colorOf = (item, palette) => {
  if (item.acked) return palette.ack;
  if (item.retrying || item.attempt > 0) return palette.redeliver;

  return palette.deliver;
};

const positionOf = (item) => (item.processing ? { ...item.at, z: POD.height } : pointAt(item.belt.path, item.s));

const drawItem = (ctx, project, palette, item, ui) => {
  const at = positionOf(item);
  const color = colorOf(item, palette);

  block(ctx, project, { cx: at.x, cy: at.y, sx: BOX.size, height: BOX.height, base: color, edge: color, lift: at.z, shadow: false });

  item.screen = project(at.x, at.y, at.z + BOX.height / 2);

  if (ui.hoverItem === item) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(item.screen.x, item.screen.y, Math.max(8, 11 * project.k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
};

const podLight = (sim, replica, palette) => {
  if (isDown(sim, replica)) return palette.dlq;
  if (sim.time - replica.flashAt < 600) return palette[replica.flash];
  if (replica.busy) return palette.deliver;

  return palette.ack;
};

/* Light from the pod's status lamp, pooled on the floor in front of it. */
const drawPodPool = (ctx, project, color, r) => {
  const pool = project(r.x - 6, r.y + POD.size / 2 + 12);
  const radius = 44 * project.k;
  const g = ctx.createRadialGradient(pool.x, pool.y, 0, pool.x, pool.y, radius);

  g.addColorStop(0, color);
  g.addColorStop(1, 'transparent');
  ctx.save();
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = g;
  ctx.translate(pool.x, pool.y);
  ctx.scale(1, 0.5);
  ctx.beginPath();
  ctx.arc(0, 0, radius, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

const drawPod = (ctx, project, palette, sim, floor, index, logo, view, ui) => {
  const replica = sim.replicas[index];
  const r = floor.pods[index];
  const down = isDown(sim, replica);
  const flashAge = sim.time - replica.flashAt;
  const tone = !down && flashAge < 600 ? palette[replica.flash] : null;
  const hovered = ui.hoverPod === index;
  const height = down ? POD.downHeight : POD.height;
  const faces = block(ctx, project, {
    cx: r.x,
    cy: r.y,
    sx: POD.size,
    height,
    base: down ? palette.raised : palette.block,
    edge: down ? palette.dlq : (tone ?? (hovered ? palette.deliver : palette.rail)),
    alpha: down ? 0.75 : 1,
    dashed: down,
    lift: hovered && !down ? 3 : 0,
  });

  if (tone) fillShape(ctx, faces.top, tone, 0.22 * (1 - flashAge / 600));

  led(ctx, faces.front, podLight(sim, replica, palette), 1);

  if (logo && !down) {
    const [p0, p1, , p3] = faces.top;
    const size = 0.5;

    ctx.save();
    ctx.globalAlpha = 0.95;
    ctx.setTransform(
      (p1.x - p0.x) * view.ratio,
      (p1.y - p0.y) * view.ratio,
      (p3.x - p0.x) * view.ratio,
      (p3.y - p0.y) * view.ratio,
      p0.x * view.ratio,
      p0.y * view.ratio,
    );
    ctx.drawImage(logo, 0.5 - size / 2, 0.5 - size / 2, size, size);
    ctx.restore();
  }

  if (down) {
    const above = project(r.x, r.y, height + 20);

    label(ctx, palette, replica.manual ? 'down' : 'restarting', above.x, above.y, 'center', palette.dlq, 600);
  }
};

const drawRings = (ctx, project, palette, sim, floor) => {
  for (const ring of sim.rings) {
    const t = (sim.time - ring.born) / DOWN_RING_MS;
    const r = floor.pods[ring.index];
    const c = project(r.x, r.y);
    const k = project.k;

    ctx.save();
    ctx.strokeStyle = palette.dlq;
    ctx.lineWidth = 1.2;
    ctx.globalAlpha = 0.5 * (1 - t);
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, (30 + 18 * t) * k * COS * 1.6, (30 + 18 * t) * k * SIN * 1.6, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
};

const drawHint = (ctx, project, palette, sim, floor, ui) => {
  if (ui.clicked) return;

  const r = floor.pods[1];
  const c = project(r.x, r.y, POD.height / 2);
  const k = project.k;

  for (let i = 0; i < 2; i += 1) {
    const phase = ((sim.time / 1800 + i / 2) % 1 + 1) % 1;
    const radius = (34 + phase * 22) * k;

    ctx.save();
    ctx.strokeStyle = palette.deliver;
    ctx.globalAlpha = 0.5 * (1 - phase);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + 6 * k, radius * 1.15, radius * 0.6, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const tag = project(floor.pods[2].x + 10, floor.pods[2].y + 46);

  label(ctx, palette, 'click a pod to take it down', tag.x, tag.y, 'center', palette.deliver, 600);
};

/* Everything that gives off light, drawn sharp into the glow layer that gets blurred. */
const drawEmissive = (ctx, palette, sim, floor) => {
  for (const item of itemsOf(sim, floor)) {
    if (!item.screen) continue;

    ctx.globalAlpha = 0.75;
    ctx.fillStyle = colorOf(item, palette);
    ctx.beginPath();
    ctx.arc(item.screen.x, item.screen.y, 5, 0, Math.PI * 2);
    ctx.fill();
  }

  for (const replica of sim.replicas) {
    if (!replica.lamp) continue;

    ctx.globalAlpha = 0.8;
    ctx.fillStyle = podLight(sim, replica, palette);
    ctx.beginPath();
    ctx.arc(replica.lamp.x, replica.lamp.y, 3, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.globalAlpha = 1;
};

const fadeEdges = (ctx, cw, ch) => {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';

  const edge = Math.min(cw, ch) * 0.12;
  const sides = [
    [0, 0, 0, edge, 0, 0, cw, edge],
    [0, ch, 0, ch - edge, 0, ch - edge, cw, edge],
    [cw, 0, cw - edge, 0, cw - edge, 0, edge, ch],
  ];

  for (const [x0, y0, x1, y1, rx, ry, rw, rh] of sides) {
    const g = ctx.createLinearGradient(x0, y0, x1, y1);

    g.addColorStop(0, 'rgba(0, 0, 0, 1)');
    g.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = g;
    ctx.fillRect(rx, ry, rw, rh);
  }
  ctx.restore();
};

const depth = (item) => {
  const at = positionOf(item);

  return at.x + at.y;
};

const draw = (ctx, sim, floor, view, palette, logo, ui) => {
  const { project, cw, ch } = view;
  const t = sim.time;

  ctx.clearRect(0, 0, cw, ch);
  drawGrid(ctx, project, palette);
  sim.replicas.forEach((replica, index) => drawPodPool(ctx, project, podLight(sim, replica, palette), floor.pods[index]));

  // belts: the straight ones run under the loop and the blocks at both ends
  for (const b of floor.inputs) drawBelt(ctx, project, b, palette, t);
  for (const b of floor.ins) drawBelt(ctx, project, b, palette, t);
  for (const b of floor.outputs) drawBelt(ctx, project, b, palette, t, { stripe: palette.ack });
  drawBelt(ctx, project, floor.loop, palette, t, { width: LOOP_W, stripe: palette.deliver });

  // what rides the belts, back to front
  const riding = [];

  for (const b of beltsOf(floor)) riding.push(...b.items);
  riding.sort((a, b) => depth(a) - depth(b));
  for (const item of riding) drawItem(ctx, project, palette, item, ui);

  for (const d of floor.docks) {
    const faces = block(ctx, project, { cx: d.x, cy: d.y, sx: DOCK.size, height: DOCK.height, base: palette.block, edge: palette.rail });

    led(ctx, faces.front, palette.deliver, 0.9);
  }

  block(ctx, project, { cx: OUTBOX.x, cy: OUTBOX.y, sx: OUTBOX.sx, sy: OUTBOX.sy, height: OUTBOX.height, base: palette.block, edge: palette.rail });

  floor.pods.forEach((_, index) => drawPod(ctx, project, palette, sim, floor, index, logo, view, ui));
  sim.replicas.forEach((replica, index) => {
    const r = floor.pods[index];
    const down = isDown(sim, replica);

    replica.lamp = project(r.x - POD.size * 0.3, r.y + POD.size / 2, (down ? POD.downHeight : POD.height) * 0.55);
  });
  for (const replica of sim.replicas) if (replica.busy?.processing) drawItem(ctx, project, palette, replica.busy, ui);

  drawRings(ctx, project, palette, sim, floor);
  drawHint(ctx, project, palette, sim, floor, ui);

  // the stream's count sits inside the loop
  const stored = floor.loop.items.length;
  const centre = project((LOOP.x0 + LOOP.x1) / 2, (LOOP.y0 + LOOP.y1) / 2, BELT_Z);

  label(ctx, palette, stored ? `stream · ${stored} stored` : 'stream', centre.x, centre.y + 4, 'center', palette.deliver);

  if (sim.deploy) {
    const done = Math.min(LANES.length, Math.floor((sim.time - sim.deploy.start) / RESTART_MS) + 1);
    const top = project(POD_X, LANES[0] - 34, 64);

    label(ctx, palette, `rolling deploy · ${done}/${LANES.length}`, top.x, top.y, 'center', palette.deliver, 600);
  }

  const hovered = ui.hoverItem;

  if (hovered?.screen) {
    let status = 'on its way';

    if (hovered.acked) status = 'acked';
    else if (hovered.processing) status = 'handling';
    else if (hovered.belt === floor.loop) status = hovered.retrying ? 'stored · redelivery after backoff' : 'stored';
    else if (hovered.belt && floor.ins.includes(hovered.belt)) status = 'delivered';
    else if (hovered.belt && floor.outs.includes(hovered.belt)) status = 'nak · back to the stream';

    tooltip(
      ctx,
      palette,
      [
        { text: hovered.subject },
        { text: `seq ${hovered.seq} · attempt ${hovered.attempt + 1}`, color: palette.label },
        { text: status, color: colorOf(hovered, palette) },
      ],
      hovered.screen.x,
      hovered.screen.y,
    );
  } else if (ui.hoverPod !== null) {
    const r = floor.pods[ui.hoverPod];
    const at = project(r.x, r.y, POD.height);
    const down = isDown(sim, sim.replicas[ui.hoverPod]);

    tooltip(ctx, palette, [{ text: down ? 'click to start this pod' : 'click to take this pod down' }], at.x, at.y);
  }
};

const REGION = {
  wide: { x0: 0.47, x1: 0.99, y0: 0.08, y1: 0.9 },
  narrow: { x0: 0.02, x1: 0.98, y0: 0.04, y1: 0.96 },
};

const readClicked = () => {
  try {
    return window.localStorage.getItem(HINT_KEY) === '1';
  } catch {
    return false;
  }
};

const rememberClicked = () => {
  try {
    window.localStorage.setItem(HINT_KEY, '1');
  } catch {
    /* storage blocked; the hint just shows again next time */
  }
};

const HeroScene = () => {
  const wrapRef = useRef(null);
  const canvasRef = useRef(null);
  const logoUrl = useBaseUrl('/img/brands/nestjs.svg');
  const [stats, setStats] = useState({ published: 0, retried: 0, acked: 0 });

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas.getContext('2d');
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const floor = buildFloor();
    const sim = createSim();
    const ui = { hoverItem: null, hoverPod: null, clicked: readClicked() };
    let palette = readPalette();
    let view = null;
    let logo = null;
    let frame = 0;
    let last = 0;
    let visible = true;
    let statsAt = 0;
    let pointer = null;

    // The glow layer: half resolution, blurred, laid over the scene with additive light.
    const glow = document.createElement('canvas');
    const gctx = glow.getContext('2d');
    const canBlur = typeof gctx.filter === 'string';
    const GLOW_SCALE = 0.5;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;

      canvas.width = Math.round(cw * ratio);
      canvas.height = Math.round(ch * ratio);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
      view = { cw, ch, ratio, project: makeProjector(cw, ch, cw < 760 ? REGION.narrow : REGION.wide) };
      glow.width = Math.max(1, Math.round(cw * GLOW_SCALE));
      glow.height = Math.max(1, Math.round(ch * GLOW_SCALE));
    };

    const addGlow = () => {
      gctx.setTransform(GLOW_SCALE, 0, 0, GLOW_SCALE, 0, 0);
      gctx.clearRect(0, 0, view.cw, view.ch);
      drawEmissive(gctx, palette, sim, floor);

      ctx.save();
      ctx.setTransform(view.ratio, 0, 0, view.ratio, 0, 0);
      ctx.globalCompositeOperation = palette.dark ? 'lighter' : 'source-over';
      ctx.globalAlpha = palette.dark ? 0.45 : 0.2;
      ctx.filter = 'blur(8px)';
      ctx.drawImage(glow, 0, 0, view.cw, view.ch);
      ctx.restore();
    };

    const render = () => {
      ctx.setTransform(view.ratio, 0, 0, view.ratio, 0, 0);
      draw(ctx, sim, floor, view, palette, logo, ui);

      if (canBlur) addGlow();
      fadeEdges(ctx, view.cw, view.ch);
    };

    // What the pointer is over: a message (inspectable) or a pod (clickable).
    const hitTest = () => {
      ui.hoverItem = null;
      ui.hoverPod = null;

      if (pointer) {
        const k = view.project.k;
        let best = 12;

        for (const item of itemsOf(sim, floor)) {
          if (!item.screen) continue;

          const d = Math.hypot(item.screen.x - pointer.x, item.screen.y - pointer.y);

          if (d < best) {
            best = d;
            ui.hoverItem = item;
          }
        }

        if (!ui.hoverItem) {
          floor.pods.forEach((r, index) => {
            const c = view.project(r.x, r.y, POD.height / 2);

            if (Math.hypot((c.x - pointer.x) / 1.8, c.y - pointer.y) < 24 * k + 6) ui.hoverPod = index;
          });
        }
      }

      canvas.style.cursor = ui.hoverPod === null ? 'default' : 'pointer';
    };

    const image = new Image();

    image.onload = () => {
      logo = image;
      if (reduce) render();
    };
    image.src = logoUrl;

    const tick = (ts) => {
      const dt = last ? Math.min(50, ts - last) : 16;

      last = ts;
      step(sim, floor, dt);
      hitTest();
      render();

      if (ts - statsAt > 400) {
        statsAt = ts;
        setStats({ ...sim.stats });
      }

      if (visible && !document.hidden) frame = requestAnimationFrame(tick);
    };

    const start = () => {
      cancelAnimationFrame(frame);
      last = 0;
      frame = requestAnimationFrame(tick);
    };

    resize();

    if (reduce) {
      for (let t = 0; t < 9000; t += 16) step(sim, floor, 16);
      ui.clicked = true;
      render();
      setStats({ ...sim.stats });

      return undefined;
    }

    const onMove = (event) => {
      const rect = canvas.getBoundingClientRect();

      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onLeave = () => {
      pointer = null;
    };
    const onClick = (event) => {
      onMove(event);
      hitTest();

      if (ui.hoverPod === null) return;

      togglePod(sim, floor, ui.hoverPod);

      if (!ui.clicked) {
        ui.clicked = true;
        rememberClicked();
      }
    };

    const sizeObserver = new ResizeObserver(() => {
      resize();
      render();
    });
    const viewObserver = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
      else cancelAnimationFrame(frame);
    });
    const themeObserver = new MutationObserver(() => {
      palette = readPalette();
    });
    const onVisibility = () => {
      if (!document.hidden && visible) start();
    };

    sizeObserver.observe(wrap);
    viewObserver.observe(wrap);
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    document.addEventListener('visibilitychange', onVisibility);
    canvas.addEventListener('pointermove', onMove);
    canvas.addEventListener('pointerleave', onLeave);
    canvas.addEventListener('click', onClick);
    start();

    return () => {
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      viewObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      canvas.removeEventListener('pointermove', onMove);
      canvas.removeEventListener('pointerleave', onLeave);
      canvas.removeEventListener('click', onClick);
    };
  }, [logoUrl]);

  return (
    <div className="scene">
      <div className="scene-stage" ref={wrapRef} aria-hidden="true">
        <canvas ref={canvasRef} />
      </div>
      <p className="scene-stats">
        published <b data-tone="deliver">{stats.published}</b> · retried{' '}
        <b data-tone="redeliver">{stats.retried}</b> · acked <b data-tone="ack">{stats.acked}</b> · lost{' '}
        <b>0</b>
      </p>
    </div>
  );
};

export default HeroScene;
