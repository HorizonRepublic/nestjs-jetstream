import React, { useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import './styles.css';

/* A small JetStream system as a conveyor floor, drawn isometrically behind the
   hero. Services feed belts into the stream, a long buffer belt where messages
   queue; a splitter hands them to NestJS pods. An ack sends a message out, a nak
   lifts it onto the overhead return belt and back to the stream. Pods restart,
   on their own or when clicked; every message gets acked in the end.

   Every message moves only along a belt, so the belts are the routes. */

const MODEL = { w: 600, h: 240 };
const FAIL_CHANCE = [0.3, 0.2, 0];
const GAP = 12;
const BOX = { size: 9, height: 7 };
const BELT_Z = 5;
const RAIL_Z = 52;
const POD = { size: 34, height: 30, downHeight: 9 };
const RESTART_MS = 3400;
const MANUAL_DOWN_MS = 20000;
const DEPLOY_EVERY_MS = 25000;
const EFFECT_MS = { ack: 900, nak: 700, down: 1100 };
const SUBJECTS = ['orders.created', 'payments.captured', 'users.updated', 'emails.send', 'stock.reserved'];
const HINT_KEY = 'jt-scene-clicked';

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

/* ---- belts -------------------------------------------------------------- */

/* A belt is a polyline in model space (x, y, z) that items ride at a fixed speed. */
const belt = (points, speed) => {
  const lengths = points.slice(1).map((p, i) => Math.hypot(p.x - points[i].x, p.y - points[i].y, p.z - points[i].z));

  return { points, lengths, length: lengths.reduce((a, b) => a + b, 0), speed, items: [] };
};

const pointAt = (b, s) => {
  let left = Math.max(0, Math.min(s, b.length));

  for (let i = 0; i < b.lengths.length; i += 1) {
    if (left <= b.lengths[i] || i === b.lengths.length - 1) {
      const t = b.lengths[i] ? Math.min(1, left / b.lengths[i]) : 0;
      const a = b.points[i];
      const c = b.points[i + 1];

      return { x: a.x + (c.x - a.x) * t, y: a.y + (c.y - a.y) * t, z: a.z + (c.z - a.z) * t };
    }

    left -= b.lengths[i];
  }

  return b.points.at(-1);
};

/* Items move forward until they reach the end or close up on the item ahead. */
const advance = (b, dt) => {
  b.items.forEach((item, index) => {
    const limit = index === 0 ? b.length : b.items[index - 1].s - GAP;

    if (item.s < limit) item.s = Math.min(limit, item.s + b.speed * dt);
  });
};

const atEnd = (b) => b.items.length > 0 && b.items[0].s >= b.length - 0.01;
const hasRoom = (b) => !b.items.length || b.items.at(-1).s >= GAP;
const put = (b, item) => {
  item.s = 0;
  item.belt = b;
  b.items.push(item);
};
const take = (b) => b.items.shift();

const p3 = (x, y, z = BELT_Z) => ({ x, y, z });

const buildFloor = () => {
  const ys = [44, 120, 196];
  const docks = ys.map((y) => ({ x: 24, y }));
  const pods = ys.map((y) => ({ x: 520, y }));
  const stream = belt([p3(140, 120), p3(378, 120)], 0.11);
  const splitter = { x: 392, y: 120 };

  return {
    docks,
    pods,
    splitter,
    inputs: [
      belt([p3(38, 44), p3(140, 44), p3(140, 110)], 0.09),
      belt([p3(38, 120), p3(130, 120)], 0.09),
      belt([p3(38, 196), p3(140, 196), p3(140, 130)], 0.09),
    ],
    stream,
    feeds: [
      belt([p3(392, 106), p3(392, 44), p3(498, 44), p3(510, 44, POD.height + 2)], 0.26),
      belt([p3(406, 120), p3(498, 120), p3(510, 120, POD.height + 2)], 0.26),
      belt([p3(392, 134), p3(392, 196), p3(498, 196), p3(510, 196, POD.height + 2)], 0.26),
    ],
    outputs: ys.map((y) => belt([p3(530, y, POD.height + 2), p3(540, y), p3(596, y)], 0.1)),
    // the overhead return: up from each pod, over to the stream's line, back above it, down at its start
    lifts: ys.map((y) => belt([p3(520, y, POD.height + 2), p3(520, y, RAIL_Z), p3(462, y, RAIL_Z), p3(462, 120, RAIL_Z)], 0.1)),
    rail: belt([p3(462, 120, RAIL_Z), p3(150, 120, RAIL_Z), p3(140, 120, BELT_Z)], 0.13),
  };
};

/* ---- the model ---------------------------------------------------------- */

const createSim = () => ({
  time: 0,
  nextId: 1,
  replicas: [0, 1, 2].map(() => ({ busy: null, flash: null, flashAt: -1e9, downUntil: 0, manual: false })),
  nextSpawn: 300,
  nextBurst: 4000,
  nextRestart: 16000,
  nextDeploy: 6000,
  deploy: null,
  effects: [],
  done: [],
  spawnTurn: 0,
  joinTurn: 0,
  stats: { published: 0, retried: 0, acked: 0 },
});

const isDown = (sim, replica) => sim.time < replica.downUntil;

const burst = (sim, kind, at) => {
  sim.effects.push({ kind, x: at.x, y: at.y, born: sim.time, seed: Math.random() * Math.PI * 2 });
};

const toReturn = (sim, floor, item, index) => {
  item.retrying = true;
  sim.stats.retried += 1;
  put(floor.lifts[index], item);
};

/* A pod goes away: what it was handling goes back for redelivery, never lost. */
const takeDown = (sim, floor, index, ms, manual) => {
  const replica = sim.replicas[index];

  replica.downUntil = sim.time + ms;
  replica.manual = manual;
  burst(sim, 'down', floor.pods[index]);

  const item = replica.busy;

  if (item && item.processing) {
    item.processing = false;
    replica.busy = null;
    toReturn(sim, floor, item, index);
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

const step = (sim, floor, dt) => {
  sim.time += dt;
  const now = sim.time;

  // publishing: a new message on a dock's belt, when the belt has room
  const spawn = () => {
    for (let tries = 0; tries < 3; tries += 1) {
      const dock = (sim.spawnTurn + tries) % 3;

      if (hasRoom(floor.inputs[dock])) {
        const id = sim.nextId++;

        put(floor.inputs[dock], {
          id,
          subject: SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)],
          seq: 4812000 + id,
          attempt: 0,
        });
        sim.stats.published += 1;
        sim.spawnTurn = (dock + 1 + Math.floor(Math.random() * 2)) % 3;

        return;
      }
    }
  };

  if (now >= sim.nextSpawn) {
    spawn();
    sim.nextSpawn = now + 1100 + Math.random() * 900;
  }

  if (now >= sim.nextBurst) {
    sim.burstLeft = 5;
    sim.nextBurst = now + 11000 + Math.random() * 6000;
  }

  if (sim.burstLeft && now >= (sim.burstAt ?? 0)) {
    spawn();
    sim.burstLeft -= 1;
    sim.burstAt = now + 160;
  }

  // a rolling deploy: each running pod restarts in turn while the stream holds the work
  if (now >= sim.nextDeploy) {
    sim.deploy = { start: now, done: -1 };
    sim.nextDeploy = now + DEPLOY_EVERY_MS;
    sim.nextRestart = Math.max(sim.nextRestart, now + 3 * RESTART_MS + 6000);
  }

  if (sim.deploy) {
    const index = Math.floor((now - sim.deploy.start) / RESTART_MS);

    if (index < 3 && index > sim.deploy.done) {
      sim.deploy.done = index;
      if (!isDown(sim, sim.replicas[index])) takeDown(sim, floor, index, RESTART_MS, false);
    } else if (now - sim.deploy.start > 3 * RESTART_MS + 600) {
      sim.deploy = null;
    }
  }

  if (now >= sim.nextRestart) {
    const up = [0, 1, 2].filter((index) => !isDown(sim, sim.replicas[index]));

    if (up.length > 1) takeDown(sim, floor, up[Math.floor(Math.random() * up.length)], RESTART_MS, false);
    sim.nextRestart = now + 11000 + Math.random() * 7000;
  }

  for (const b of [floor.stream, floor.rail, ...floor.inputs, ...floor.feeds, ...floor.outputs, ...floor.lifts]) advance(b, dt);

  // onto the stream: inputs and the return rail take turns at its start
  const joiners = [...floor.inputs, floor.rail];

  for (let i = 0; i < joiners.length && hasRoom(floor.stream); i += 1) {
    const b = joiners[(sim.joinTurn + i) % joiners.length];

    if (atEnd(b)) {
      put(floor.stream, take(b));
      sim.joinTurn = (sim.joinTurn + i + 1) % joiners.length;
    }
  }

  // each pod's lift feeds the shared rail
  floor.lifts.forEach((lift) => {
    if (atEnd(lift) && hasRoom(floor.rail)) put(floor.rail, take(lift));
  });

  // the splitter hands the stream's head to a running, idle pod
  sim.replicas.forEach((replica, index) => {
    if (replica.busy || isDown(sim, replica) || !atEnd(floor.stream) || !hasRoom(floor.feeds[index])) return;

    const item = take(floor.stream);

    replica.busy = item;
    put(floor.feeds[index], item);
  });

  sim.replicas.forEach((replica, index) => {
    if (!isDown(sim, replica)) replica.manual = false;

    const feed = floor.feeds[index];

    // arrival: a pod that went down meanwhile hands the message straight back
    if (atEnd(feed)) {
      const item = take(feed);

      if (isDown(sim, replica)) {
        replica.busy = null;
        toReturn(sim, floor, item, index);
      } else {
        item.processing = true;
        item.since = now;
        item.until = now + 300 + Math.random() * 450;
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
        burst(sim, 'nak', floor.pods[index]);
        toReturn(sim, floor, item, index);
      } else {
        sim.stats.acked += 1;
        replica.flash = 'ack';
        replica.flashAt = now;
        burst(sim, 'ack', floor.pods[index]);
        item.acked = true;
        put(floor.outputs[index], item);
      }
    }
  });

  floor.outputs.forEach((output) => {
    if (atEnd(output)) take(output);
  });

  sim.effects = sim.effects.filter((effect) => now - effect.born < EFFECT_MS[effect.kind]);
};

/* Every message currently on the floor, wherever it is. */
const itemsOf = (sim, floor) => {
  const all = [];

  for (const b of [floor.stream, floor.rail, ...floor.inputs, ...floor.feeds, ...floor.outputs, ...floor.lifts]) all.push(...b.items);
  for (const replica of sim.replicas) if (replica.busy?.processing) all.push(replica.busy);

  return all;
};

/* ---- rendering ---------------------------------------------------------- */

const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);

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
    faint: token('--jt-line-1'),
    raised: token('--jt-bg-2'),
    block: token('--jt-bg-3'),
    surface: token('--jt-bg-1'),
    ink: token('--jt-fg-0'),
    label: token('--jt-fg-3'),
    mono: token('--jt-font-mono') || 'monospace',
  };
};

const makeProjector = (cw, ch, region) => {
  let cos = 1;
  let sin = 0;

  // The model turns about its centre by a few degrees, so the camera seems to sway.
  const raw = (mx, my, z = 0) => {
    const dx = mx - MODEL.w / 2;
    const dy = my - MODEL.h / 2;
    const x = MODEL.w / 2 + dx * cos - dy * sin;
    const y = dy * cos + dx * sin;

    return { x: (x - y * 1.2) * COS, y: (x + y * 1.2) * SIN - z };
  };
  const corners = [
    raw(-30, -30),
    raw(MODEL.w + 30, -30),
    raw(-30, MODEL.h + 30),
    raw(MODEL.w + 30, MODEL.h + 30),
    raw(MODEL.w / 2, MODEL.h / 2, 120),
  ];
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
  project.turn = (angle) => {
    cos = Math.cos(angle);
    sin = Math.sin(angle);
  };

  return project;
};

const path = (ctx, points) => {
  ctx.beginPath();
  points.forEach((p, i) => (i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y)));
  ctx.closePath();
};

const shade = (ctx, points, base, light, alpha = 1) => {
  path(ctx, points);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = base;
  ctx.fill();
  ctx.fillStyle = light > 0 ? '#ffffff' : '#000000';
  ctx.globalAlpha = alpha * Math.abs(light);
  ctx.fill();
  ctx.globalAlpha = 1;
};

/* A lit isometric block. `lift` raises it off the floor; `shadow` adds a soft contact shadow. */
const block = (ctx, project, { cx, cy, size, height, base, edge, alpha = 1, dashed = false, lift = 0, shadow = true, rim = true }) => {
  const s = size / 2;
  const at = (dx, dy, dz) => project(cx + dx, cy + dy, dz + lift);
  const top = [at(-s, -s, height), at(s, -s, height), at(s, s, height), at(-s, s, height)];
  const right = [at(s, -s, height), at(s, s, height), at(s, s, 0), at(s, -s, 0)];
  const front = [at(-s, s, height), at(s, s, height), at(s, s, 0), at(-s, s, 0)];

  if (shadow) {
    const foot = [project(cx - s, cy - s), project(cx + s + 6, cy - s), project(cx + s + 6, cy + s + 6), project(cx - s, cy + s + 6)];

    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
    ctx.shadowBlur = 14 * project.k;
    path(ctx, foot);
    ctx.globalAlpha = 0.18 * alpha;
    ctx.fillStyle = '#000000';
    ctx.fill();
    ctx.restore();
  }

  ctx.save();
  if (dashed) ctx.setLineDash([3, 3]);
  shade(ctx, right, base, -0.32, alpha);
  shade(ctx, front, base, -0.14, alpha);
  shade(ctx, top, base, 0.1, alpha);

  ctx.lineWidth = 1;
  ctx.strokeStyle = edge;
  ctx.globalAlpha = alpha;
  for (const face of [right, front, top]) {
    path(ctx, face);
    ctx.stroke();
  }

  if (rim && !dashed) {
    ctx.strokeStyle = '#ffffff';
    ctx.globalAlpha = 0.18 * alpha;
    ctx.beginPath();
    ctx.moveTo(top[3].x, top[3].y);
    ctx.lineTo(top[0].x, top[0].y);
    ctx.lineTo(top[1].x, top[1].y);
    ctx.stroke();
  }
  ctx.restore();

  return { top, front, right };
};

const led = (ctx, face, color, alpha = 1) => {
  const [a, b, , d] = face;
  const x = a.x + (b.x - a.x) * 0.22 + (d.x - a.x) * 0.5;
  const y = a.y + (b.y - a.y) * 0.22 + (d.y - a.y) * 0.5;

  ctx.save();
  ctx.fillStyle = color;
  ctx.shadowColor = color;
  ctx.shadowBlur = 8;
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, 2.2, 0, Math.PI * 2);
  ctx.fill();
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
  ctx.globalAlpha = 0.78;
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
  const spot = ctx.createRadialGradient(centre.x, centre.y, 0, centre.x, centre.y, 420 * project.k);

  spot.addColorStop(0, palette.dark ? 'rgba(255, 255, 255, 0.045)' : 'rgba(37, 87, 194, 0.05)');
  spot.addColorStop(1, 'transparent');
  ctx.fillStyle = spot;
  ctx.fillRect(centre.x - 600 * project.k, centre.y - 400 * project.k, 1200 * project.k, 800 * project.k);

  ctx.lineWidth = 1;
  ctx.strokeStyle = palette.faint;

  for (let i = -2; i <= 17; i += 1) {
    const x = i * 40;
    const a = project(x, -60);
    const b = project(x, MODEL.h + 60);

    ctx.globalAlpha = 0.5 * (1 - Math.min(1, Math.abs(x - MODEL.w / 2) / (MODEL.w * 0.75)));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (let j = -1; j <= 7; j += 1) {
    const y = j * 40;
    const a = project(-80, y);
    const b = project(MODEL.w + 80, y);

    ctx.globalAlpha = 0.5 * (1 - Math.min(1, Math.abs(y - MODEL.h / 2) / (MODEL.h * 0.85)));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
};

/* A belt as a flat ribbon with moving cross-stripes; overhead belts get posts. */
const drawBelt = (ctx, project, b, palette, time, { width = 12, tone = null, posts = false, rails = false } = {}) => {
  ctx.save();

  if (posts) {
    ctx.strokeStyle = tone;
    ctx.globalAlpha = 0.25;
    for (const p of b.points) {
      if (p.z <= BELT_Z + 1) continue;

      const a = project(p.x, p.y, 0);
      const c = project(p.x, p.y, p.z);

      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(c.x, c.y);
      ctx.stroke();
    }
  }

  for (let i = 0; i < b.lengths.length; i += 1) {
    const a = b.points[i];
    const c = b.points[i + 1];
    const len = b.lengths[i];
    const flat = Math.hypot(c.x - a.x, c.y - a.y);

    if (flat < 0.5) continue;

    const nx = (-(c.y - a.y) / flat) * (width / 2);
    const ny = ((c.x - a.x) / flat) * (width / 2);
    const quad = [project(a.x + nx, a.y + ny, a.z), project(c.x + nx, c.y + ny, c.z), project(c.x - nx, c.y - ny, c.z), project(a.x - nx, a.y - ny, a.z)];

    if (rails) {
      // an overhead track: two thin rails, nothing filled in between
      ctx.globalAlpha = 0.55;
      ctx.strokeStyle = tone;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(quad[0].x, quad[0].y);
      ctx.lineTo(quad[1].x, quad[1].y);
      ctx.moveTo(quad[3].x, quad[3].y);
      ctx.lineTo(quad[2].x, quad[2].y);
      ctx.stroke();
    } else {
      path(ctx, quad);
      ctx.globalAlpha = 1;
      ctx.fillStyle = palette.raised;
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.strokeStyle = palette.line;
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // stripes drift with the belt, so its direction reads at a glance
    const offset = ((time * b.speed) % 10) - 10;

    ctx.globalAlpha = rails ? 0.4 : 0.35;
    ctx.strokeStyle = tone ?? palette.line;
    ctx.beginPath();
    for (let d = offset; d < len; d += rails ? 16 : 10) {
      if (d < 0) continue;

      const t = d / len;
      const x = a.x + (c.x - a.x) * t;
      const y = a.y + (c.y - a.y) * t;
      const z = a.z + (c.z - a.z) * t;
      const p = project(x + nx * 0.7, y + ny * 0.7, z);
      const q = project(x - nx * 0.7, y - ny * 0.7, z);

      ctx.moveTo(p.x, p.y);
      ctx.lineTo(q.x, q.y);
    }
    ctx.stroke();
  }

  ctx.restore();
};

const colorOf = (item, palette) => {
  if (item.acked) return palette.ack;
  if (item.retrying || item.attempt > 0) return palette.redeliver;

  return palette.deliver;
};

const positionOf = (item) => {
  if (item.processing) return { ...item.at, z: POD.height + 1 };

  return pointAt(item.belt, item.s);
};

const drawItem = (ctx, project, palette, item, ui) => {
  const at = positionOf(item);
  const color = colorOf(item, palette);
  const fading = item.acked ? Math.max(0, Math.min(1, (item.belt.length - item.s) / 30)) : 1;

  if (at.z > BELT_Z + 4) {
    const floor = project(at.x, at.y);

    ctx.save();
    ctx.globalAlpha = 0.22 * fading * Math.max(0, 1 - at.z / 120);
    ctx.fillStyle = '#000000';
    ctx.beginPath();
    ctx.ellipse(floor.x, floor.y, 7 * project.k, 4 * project.k, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  block(ctx, project, {
    cx: at.x,
    cy: at.y,
    size: BOX.size,
    height: BOX.height,
    base: color,
    edge: color,
    lift: at.z,
    alpha: fading,
    shadow: false,
    rim: true,
  });

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

const effectColor = (effect, palette) => ({ ack: palette.ack, nak: palette.redeliver, down: palette.dlq })[effect.kind];

const drawEffects = (ctx, project, palette, sim) => {
  const k = project.k;

  for (const effect of sim.effects) {
    if (effect.kind !== 'down') continue;

    const t = (sim.time - effect.born) / EFFECT_MS[effect.kind];
    const color = effectColor(effect, palette);
    const base = project(effect.x, effect.y);
    const reach = 22;

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.2 * (1 - t) + 0.4;
    ctx.globalAlpha = 0.5 * (1 - t);
    ctx.beginPath();
    ctx.ellipse(base.x, base.y, (20 + reach * easeInOut(t)) * k * 1.2, (11 + reach * 0.55 * easeInOut(t)) * k * 1.2, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
};

const reflectBlock = (ctx, project, cx, cy, size, height, color, light) => {
  const s = size / 2;
  const at = (dx, dy, dz) => project(cx + dx, cy + dy, -dz);
  const depth = height * 0.7;
  const right = [at(s, -s, 0), at(s, s, 0), at(s, s, depth), at(s, -s, depth)];
  const front = [at(-s, s, 0), at(s, s, 0), at(s, s, depth), at(-s, s, depth)];
  const top = project(cx, cy, 0);
  const bottom = project(cx, cy, -depth);
  const fade = ctx.createLinearGradient(0, top.y, 0, bottom.y + size * project.k);

  fade.addColorStop(0, color);
  fade.addColorStop(1, 'transparent');

  ctx.save();
  ctx.globalAlpha = 0.09;
  ctx.fillStyle = fade;
  path(ctx, right);
  ctx.fill();
  path(ctx, front);
  ctx.fill();

  if (light) {
    const pool = project(cx + s + 10, cy + s * 0.4);
    const g = ctx.createRadialGradient(pool.x, pool.y, 0, pool.x, pool.y, 46 * project.k);

    g.addColorStop(0, light);
    g.addColorStop(1, 'transparent');
    ctx.globalAlpha = 0.1;
    ctx.fillStyle = g;
    ctx.translate(pool.x, pool.y);
    ctx.scale(1, 0.55);
    ctx.beginPath();
    ctx.arc(0, 0, 46 * project.k, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.restore();
};

const podLight = (sim, replica, palette) => {
  if (isDown(sim, replica)) return palette.dlq;
  if (sim.time - replica.flashAt < 600) return palette[replica.flash];
  if (replica.busy) return palette.deliver;

  return palette.ack;
};

const drawPod = (ctx, project, palette, sim, floor, index, logo, view, ui) => {
  const replica = sim.replicas[index];
  const r = floor.pods[index];
  const down = isDown(sim, replica);
  const flashing = !down && sim.time - replica.flashAt < 600;
  const hovered = ui.hoverPod === index;
  const height = down ? POD.downHeight : POD.height;
  const tone = flashing ? palette[replica.flash] : null;
  const faces = block(ctx, project, {
    cx: r.x,
    cy: r.y,
    size: POD.size,
    height,
    base: down ? palette.raised : palette.block,
    edge: down ? palette.dlq : (tone ?? (hovered ? palette.deliver : palette.line)),
    alpha: down ? 0.7 : 1,
    dashed: down,
    lift: hovered && !down ? 3 : 0,
  });

  led(ctx, faces.front, podLight(sim, replica, palette), down ? 0.9 : 1);

  if (tone) {
    path(ctx, faces.top);
    ctx.fillStyle = tone;
    ctx.globalAlpha = 0.22 * (1 - (sim.time - replica.flashAt) / 600);
    ctx.fill();
    ctx.globalAlpha = 1;
  }

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
    const above = project(r.x, r.y, height + 18);

    label(ctx, palette, replica.manual ? 'down' : 'restarting', above.x, above.y, 'center', palette.dlq, 600);
  }
};

const drawHint = (ctx, project, palette, sim, floor, ui) => {
  if (ui.clicked) return;

  const r = floor.pods[1];
  const c = project(r.x, r.y, POD.height / 2);
  const k = project.k;

  for (let i = 0; i < 2; i += 1) {
    const phase = ((sim.time / 1800 + i / 2) % 1 + 1) % 1;

    ctx.save();
    ctx.strokeStyle = palette.deliver;
    ctx.globalAlpha = 0.5 * (1 - phase);
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + 8 * k, (30 + phase * 24) * k, (17 + phase * 14) * k, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const tag = project(r.x + 36, r.y + 62);

  label(ctx, palette, '↖ click a pod to take it down', tag.x, tag.y, 'left', palette.deliver, 600);
};

/* Everything that gives off light, drawn sharp into the glow layer that gets blurred. */
const drawEmissive = (ctx, project, palette, sim, floor) => {
  for (const item of itemsOf(sim, floor)) {
    if (!item.screen) continue;

    const fading = item.acked && item.belt ? Math.max(0, Math.min(1, (item.belt.length - item.s) / 30)) : 1;

    ctx.globalAlpha = 0.85 * fading;
    ctx.fillStyle = colorOf(item, palette);
    ctx.beginPath();
    ctx.arc(item.screen.x, item.screen.y, Math.max(3, 4.6 * project.k), 0, Math.PI * 2);
    ctx.fill();
  }

  sim.replicas.forEach((replica, index) => {
    const r = floor.pods[index];
    const down = isDown(sim, replica);
    const front = project(r.x - POD.size * 0.28, r.y + POD.size / 2, (down ? POD.downHeight : POD.height) / 2);

    ctx.globalAlpha = 0.8;
    ctx.fillStyle = podLight(sim, replica, palette);
    ctx.beginPath();
    ctx.arc(front.x, front.y, 3, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.globalAlpha = 1;
};

const fadeEdges = (ctx, cw, ch) => {
  ctx.save();
  ctx.globalCompositeOperation = 'destination-out';

  const edge = Math.min(cw, ch) * 0.14;
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

const draw = (ctx, sim, floor, view, palette, logo, ui) => {
  const { project, cw, ch } = view;

  ctx.clearRect(0, 0, cw, ch);
  drawGrid(ctx, project, palette);

  for (const d of floor.docks) reflectBlock(ctx, project, d.x, d.y, 26, 20, palette.block, null);
  sim.replicas.forEach((replica, index) => {
    const r = floor.pods[index];

    reflectBlock(ctx, project, r.x, r.y, POD.size, isDown(sim, replica) ? POD.downHeight : POD.height, palette.block, podLight(sim, replica, palette));
  });

  // floor belts, then what rides on them
  const t = sim.time;

  for (const b of floor.inputs) drawBelt(ctx, project, b, palette, t);
  drawBelt(ctx, project, floor.stream, palette, t, { width: 18 });
  for (const b of floor.feeds) drawBelt(ctx, project, b, palette, t);
  for (const b of floor.outputs) drawBelt(ctx, project, b, palette, t, { tone: palette.ack });

  // the stream glows as it fills
  const fill = Math.min(1, floor.stream.items.length / 14);

  if (fill > 0) {
    const a = project(floor.stream.points[0].x, 120, BELT_Z);
    const b = project(floor.stream.points[1].x, 120, BELT_Z);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const g = ctx.createRadialGradient(mid.x, mid.y, 0, mid.x, mid.y, 170 * project.k);

    g.addColorStop(0, palette.deliver);
    g.addColorStop(1, 'transparent');
    ctx.save();
    ctx.globalAlpha = 0.1 + 0.18 * fill;
    ctx.fillStyle = g;
    ctx.translate(mid.x, mid.y);
    ctx.scale(1, 0.5);
    ctx.beginPath();
    ctx.arc(0, 0, 170 * project.k, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  for (const b of [...floor.inputs, floor.stream, ...floor.feeds]) for (const item of b.items) drawItem(ctx, project, palette, item, ui);

  for (const d of floor.docks) {
    const faces = block(ctx, project, { cx: d.x, cy: d.y, size: 26, height: 20, base: palette.block, edge: palette.line, alpha: 0.9 });

    led(ctx, faces.front, palette.deliver, 0.85);
  }

  block(ctx, project, { cx: floor.splitter.x, cy: floor.splitter.y, size: 26, height: 14, base: palette.block, edge: palette.line });

  floor.pods.forEach((_, index) => drawPod(ctx, project, palette, sim, floor, index, logo, view, ui));
  for (const replica of sim.replicas) if (replica.busy?.processing) drawItem(ctx, project, palette, replica.busy, ui);
  for (const b of floor.outputs) for (const item of b.items) drawItem(ctx, project, palette, item, ui);

  // overhead return, above everything on the floor
  for (const b of floor.lifts) drawBelt(ctx, project, b, palette, t, { width: 8, tone: palette.redeliver, rails: true });
  drawBelt(ctx, project, floor.rail, palette, t, { width: 8, tone: palette.redeliver, rails: true, posts: true });
  for (const b of [...floor.lifts, floor.rail]) for (const item of b.items) drawItem(ctx, project, palette, item, ui);

  drawHint(ctx, project, palette, sim, floor, ui);
  drawEffects(ctx, project, palette, sim);

  // only labels that say something is happening right now
  const stored = floor.stream.items.length;

  if (stored > 2) {
    const sl = project(floor.stream.points[1].x - 30, 120 + 30);

    label(ctx, palette, `${stored} stored`, sl.x, sl.y, 'right', palette.deliver);
  }

  if (sim.deploy) {
    const done = Math.min(3, Math.floor((sim.time - sim.deploy.start) / RESTART_MS) + 1);
    const top = project(floor.pods[0].x, floor.pods[0].y, 76);

    label(ctx, palette, `rolling deploy · ${done}/3`, top.x, top.y, 'center', palette.deliver, 600);
  }

  const hovered = ui.hoverItem;

  if (hovered?.screen) {
    let status = 'on its way';

    if (hovered.acked) status = 'acked';
    else if (hovered.processing) status = 'handling';
    else if (hovered.belt === floor.stream) status = 'stored';
    else if (hovered.retrying) status = 'going back to retry';

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
  wide: { x0: 0.5, x1: 0.98, y0: 0.04, y1: 0.9 },
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
      drawEmissive(gctx, view.project, palette, sim, floor);

      ctx.save();
      ctx.setTransform(view.ratio, 0, 0, view.ratio, 0, 0);
      ctx.globalCompositeOperation = palette.dark ? 'lighter' : 'source-over';
      ctx.globalAlpha = palette.dark ? 0.5 : 0.22;
      ctx.filter = 'blur(8px)';
      ctx.drawImage(glow, 0, 0, view.cw, view.ch);
      ctx.restore();
    };

    const render = () => {
      view.project.turn(0.052 * Math.sin((sim.time / 30000) * Math.PI * 2));
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

            if (Math.hypot((c.x - pointer.x) / 1.6, c.y - pointer.y) < 26 * k + 6) ui.hoverPod = index;
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
