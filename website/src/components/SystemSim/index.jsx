import React, { useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import './styles.css';

/* A small JetStream system on a loop, drawn on an isometric floor behind the
   hero: services emit, the stream stores, NestJS replicas handle. Some handlers
   throw and pods restart, by themselves or when a visitor clicks one; every
   message gets acked in the end.

   The model runs in a flat plane (x along the flow, y across it); the renderer
   lifts it into isometric space and adds height for retries and acks. */

const FAIL_CHANCE = [0.3, 0.2, 0];
const RETRY_WAIT_MS = 2000;
const SLOT = 9;
const MODEL = { w: 600, h: 240 };
const LANE_HEIGHT = 44;
const TRAIL = 9;
const RESTART_MS = 3400;
const MANUAL_DOWN_MS = 20000;
const DEPLOY_EVERY_MS = 25000;
const POD = { size: 34, height: 30, downHeight: 9 };
const SUBJECTS = ['orders.created', 'payments.captured', 'users.updated', 'emails.send', 'stock.reserved'];
const HINT_KEY = 'jt-scene-clicked';

const easeInOut = (t) => (t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2);

const quad = (a, c, b, t) => {
  const u = 1 - t;

  return {
    x: u * u * a.x + 2 * u * t * c.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * c.y + t * t * b.y,
  };
};

const readPalette = () => {
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();
  const dark = document.documentElement.dataset.theme === 'dark';

  return {
    dark,
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

const layout = () => {
  const { w, h } = MODEL;
  const mid = h * 0.5;

  return {
    producers: [0.22, 0.5, 0.78].map((f) => ({ x: w * 0.04, y: h * f })),
    tube: { x0: w * 0.3, x1: w * 0.62, y: mid },
    lane: { x0: w * 0.3, x1: w * 0.62, y: mid },
    replicas: [0.2, 0.5, 0.8].map((f) => ({ x: w * 0.9, y: h * f })),
  };
};

/* ---- the model ---------------------------------------------------------- */

const createSim = () => ({
  time: 0,
  nextId: 1,
  messages: [],
  queue: [],
  replicas: [0, 1, 2].map(() => ({ busy: null, flash: null, flashAt: -1e9, downUntil: 0, manual: false })),
  nextSpawn: 300,
  nextBurst: 4000,
  nextRestart: 16000,
  nextDeploy: 6000,
  deploy: null,
  stats: { published: 0, retried: 0, acked: 0 },
});

const flight = (message, from, to, duration, state, delay = 0) => {
  message.state = state;
  message.from = from;
  message.to = to;
  message.ctrl = { x: (from.x + to.x) / 2, y: (from.y + to.y) / 2 };
  message.start = null;
  message.delay = delay;
  message.duration = duration;
  message.t = 0;
};

const toLane = (geo, message) => {
  flight(message, { ...message.pos }, { x: geo.lane.x1, y: geo.lane.y }, 900, 'toLane');
};

const isDown = (sim, replica) => sim.time < replica.downUntil;

/* A pod goes away: whatever it was handling is redelivered later, never lost. */
const takeDown = (sim, geo, index, ms, manual) => {
  const replica = sim.replicas[index];

  replica.downUntil = sim.time + ms;
  replica.manual = manual;

  if (replica.busy) {
    const message = replica.busy;

    replica.busy = null;
    sim.stats.retried += 1;
    toLane(geo, message);
  }
};

/* A visitor's click: a running pod goes down until clicked again; a down pod comes back. */
const togglePod = (sim, geo, index) => {
  const replica = sim.replicas[index];

  if (isDown(sim, replica)) {
    replica.downUntil = sim.time;
    replica.manual = false;
  } else {
    takeDown(sim, geo, index, MANUAL_DOWN_MS, true);
  }
};

const step = (sim, geo, dt) => {
  sim.time += dt;
  const now = sim.time;

  const spawn = (delay = 0) => {
    const producer = Math.floor(Math.random() * geo.producers.length);
    const id = sim.nextId++;
    const message = {
      id,
      subject: SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)],
      seq: 4812000 + id,
      attempt: 0,
      pos: { ...geo.producers[producer] },
      trail: [],
    };

    flight(message, geo.producers[producer], { x: geo.tube.x0, y: geo.tube.y }, 1100, 'toStream', delay);
    sim.messages.push(message);
    sim.stats.published += 1;
  };

  if (now >= sim.nextSpawn) {
    spawn();
    sim.nextSpawn = now + 900 + Math.random() * 900;
  }

  if (now >= sim.nextBurst) {
    for (let i = 0; i < 6; i += 1) spawn(i * 140);
    sim.nextBurst = now + 9000 + Math.random() * 6000;
  }

  // A rolling deploy: each running pod restarts in turn while the stream holds the work.
  if (now >= sim.nextDeploy) {
    sim.deploy = { start: now, done: -1 };
    sim.nextDeploy = now + DEPLOY_EVERY_MS;
    sim.nextRestart = Math.max(sim.nextRestart, now + sim.replicas.length * RESTART_MS + 6000);
  }

  if (sim.deploy) {
    const index = Math.floor((now - sim.deploy.start) / RESTART_MS);

    if (index < sim.replicas.length && index > sim.deploy.done) {
      sim.deploy.done = index;
      if (!isDown(sim, sim.replicas[index])) takeDown(sim, geo, index, RESTART_MS, false);
    } else if (now - sim.deploy.start > sim.replicas.length * RESTART_MS + 600) {
      sim.deploy = null;
    }
  }

  if (now >= sim.nextRestart) {
    const up = sim.replicas.map((replica, index) => index).filter((index) => !isDown(sim, sim.replicas[index]));

    if (up.length > 1) takeDown(sim, geo, up[Math.floor(Math.random() * up.length)], RESTART_MS, false);
    sim.nextRestart = now + 11000 + Math.random() * 7000;
  }

  sim.replicas.forEach((replica, index) => {
    if (!isDown(sim, replica)) replica.manual = false;
    if (replica.busy || isDown(sim, replica) || !sim.queue.length) return;

    const head = sim.queue[0];

    if (head.state !== 'queued' || Math.abs(head.pos.x - (geo.tube.x1 - 6)) > 4) return;

    sim.queue.shift();
    replica.busy = head;
    flight(head, { ...head.pos }, geo.replicas[index], 750, 'toReplica');
    head.replica = index;
  });

  const span = geo.tube.x1 - geo.tube.x0 - 12;
  const gap = Math.min(SLOT, span / Math.max(sim.queue.length, 1));

  sim.queue.forEach((message, index) => {
    const tx = geo.tube.x1 - 6 - index * gap;

    message.pos.x += (tx - message.pos.x) * Math.min(1, dt / 120);
    message.pos.y += (geo.tube.y - message.pos.y) * Math.min(1, dt / 120);
  });

  for (const message of sim.messages) {
    if (message.from && message.start === null) message.start = now + message.delay;

    if (message.from) {
      const t = Math.min(1, Math.max(0, (now - message.start) / message.duration));

      message.t = t;
      message.pos = quad(message.from, message.ctrl, message.to, easeInOut(t));

      if (t < 1) continue;

      message.from = null;

      if (message.state === 'toStream') {
        message.state = 'queued';
        message.fromLane = false;
        sim.queue.push(message);
      } else if (message.state === 'toReplica') {
        message.state = 'processing';
        message.since = now;
        message.until = now + 450 + Math.random() * 650;
      } else if (message.state === 'toLane') {
        message.state = 'waiting';
        message.since = now;
        message.until = now + RETRY_WAIT_MS;
        message.laneFrom = message.pos.x;
      } else if (message.state === 'toExit') {
        message.state = 'done';
      }

      continue;
    }

    if (message.state === 'processing' && now >= message.until) {
      const replica = sim.replicas[message.replica];

      replica.busy = null;

      if (Math.random() < FAIL_CHANCE[Math.min(message.attempt, FAIL_CHANCE.length - 1)]) {
        message.attempt += 1;
        sim.stats.retried += 1;
        replica.flash = 'redeliver';
        replica.flashAt = now;
        toLane(geo, message);
      } else {
        sim.stats.acked += 1;
        replica.flash = 'ack';
        replica.flashAt = now;
        flight(message, { ...message.pos }, { ...message.pos }, 1100, 'toExit');
      }
    } else if (message.state === 'waiting') {
      const t = Math.min(1, (now - message.since) / RETRY_WAIT_MS);

      message.pos.x = message.laneFrom + (geo.lane.x0 - message.laneFrom) * easeInOut(t);
      message.pos.y = geo.lane.y;

      if (now >= message.until) {
        message.fromLane = true;
        flight(message, { ...message.pos }, { x: geo.tube.x0, y: geo.tube.y }, 600, 'toStream');
      }
    }
  }

  sim.messages = sim.messages.filter((message) => message.state !== 'done');
};

/* ---- rendering ---------------------------------------------------------- */

const COS = Math.cos(Math.PI / 6);
const SIN = Math.sin(Math.PI / 6);

/* Height above the floor, from where the message is in its life. */
const heightOf = (message) => {
  switch (message.state) {
    case 'toLane':
      return LANE_HEIGHT * Math.sin((message.t * Math.PI) / 2) + 26 * Math.sin(message.t * Math.PI);
    case 'waiting':
      return LANE_HEIGHT;
    case 'toStream':
      return message.fromLane ? 5 + (LANE_HEIGHT - 5) * (1 - easeInOut(message.t)) : 5 + 8 * Math.sin(message.t * Math.PI);
    case 'toExit':
      return POD.height + 4 + 80 * easeInOut(message.t);
    case 'processing':
      return POD.height + 4;
    case 'toReplica':
      return 5 + (POD.height - 1) * easeInOut(message.t);
    default:
      return 5;
  }
};

const makeProjector = (cw, ch, region) => {
  // Unscaled isometric projection, then the model's corners fitted into the region.
  const raw = (x, y, z = 0) => ({
    x: (x - (y - MODEL.h / 2) * 1.2) * COS,
    y: (x + (y - MODEL.h / 2) * 1.2) * SIN - z,
  });
  const corners = [
    raw(-30, -30),
    raw(MODEL.w + 30, -30),
    raw(-30, MODEL.h + 30),
    raw(MODEL.w + 30, MODEL.h + 30),
    raw(MODEL.w, MODEL.h / 2, 140),
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

/* A lit isometric block: a soft contact shadow, three shaded faces, a bright rim. */
const block = (ctx, project, { cx, cy, size, height, base, edge, alpha = 1, dashed = false, lift = 0 }) => {
  const s = size / 2;
  const at = (dx, dy, dz) => project(cx + dx, cy + dy, dz + lift);
  const top = [at(-s, -s, height), at(s, -s, height), at(s, s, height), at(-s, s, height)];
  const right = [at(s, -s, height), at(s, s, height), at(s, s, 0), at(s, -s, 0)];
  const front = [at(-s, s, height), at(s, s, height), at(s, s, 0), at(-s, s, 0)];
  const foot = [project(cx - s, cy - s), project(cx + s + 6, cy - s), project(cx + s + 6, cy + s + 6), project(cx - s, cy + s + 6)];

  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.35)';
  ctx.shadowBlur = 14 * project.k;
  path(ctx, foot);
  ctx.globalAlpha = 0.18 * alpha;
  ctx.fillStyle = '#000000';
  ctx.fill();
  ctx.restore();

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

  // rim light along the two near top edges
  if (!dashed) {
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

/* A small light on a face: the pod's status, like a server's front panel. */
const led = (ctx, face, color, alpha = 1) => {
  const [a, b, c, d] = face;
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

/* A message as a small lit sphere with a halo. */
const sphere = (ctx, x, y, r, color, alpha) => {
  ctx.save();
  ctx.globalAlpha = alpha * 0.18;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
  ctx.fill();

  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.1, x, y, r);

  g.addColorStop(0, '#ffffff');
  g.addColorStop(0.35, color);
  g.addColorStop(1, color);
  ctx.globalAlpha = alpha;
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
};

const label = (ctx, palette, value, x, y, align, color = palette.label, weight = 400) => {
  ctx.font = `${weight} 11px ${palette.mono}`;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.9;
  ctx.textAlign = align;
  ctx.fillText(value, x, y);
  ctx.globalAlpha = 1;
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

const drawFloor = (ctx, project, palette) => {
  // a soft light spot under the system
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

    ctx.globalAlpha = 0.6 * (1 - Math.min(1, Math.abs(x - MODEL.w / 2) / (MODEL.w * 0.75)));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  for (let j = -1; j <= 7; j += 1) {
    const y = j * 40;
    const a = project(-80, y);
    const b = project(MODEL.w + 80, y);

    ctx.globalAlpha = 0.6 * (1 - Math.min(1, Math.abs(y - MODEL.h / 2) / (MODEL.h * 0.85)));
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }

  ctx.globalAlpha = 1;
};

const colorOf = (message, palette) => {
  if (message.state === 'toExit') return palette.ack;
  if (message.attempt > 0 || message.fromLane || message.state === 'toLane' || message.state === 'waiting') {
    return palette.redeliver;
  }

  return palette.deliver;
};

/* The stream as a glass channel: floor, back wall, contents, front wall. */
const drawChannel = (ctx, project, geo, palette, sim, drawContents) => {
  const x0 = geo.tube.x0 - 10;
  const x1 = geo.tube.x1 + 10;
  const y0 = geo.tube.y - 13;
  const y1 = geo.tube.y + 13;
  const wall = 12;
  const p = (x, y, z) => project(x, y, z);
  const fill = Math.min(1, sim.queue.length / 10);

  // pool of light under the channel, brighter as the queue grows
  const pool = project((x0 + x1) / 2, geo.tube.y);
  const glow = ctx.createRadialGradient(pool.x, pool.y, 0, pool.x, pool.y, 160 * project.k);

  glow.addColorStop(0, palette.deliver);
  glow.addColorStop(1, 'transparent');
  ctx.save();
  ctx.globalAlpha = 0.08 + 0.22 * fill;
  ctx.fillStyle = glow;
  ctx.translate(pool.x, pool.y);
  ctx.scale(1, 0.5);
  ctx.beginPath();
  ctx.arc(0, 0, 160 * project.k, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  const floor = [p(x0, y0, 0), p(x1, y0, 0), p(x1, y1, 0), p(x0, y1, 0)];
  const back = [p(x0, y0, 0), p(x1, y0, 0), p(x1, y0, wall), p(x0, y0, wall)];
  const end = [p(x1, y0, 0), p(x1, y1, 0), p(x1, y1, wall), p(x1, y0, wall)];
  const front = [p(x0, y1, 0), p(x1, y1, 0), p(x1, y1, wall), p(x0, y1, wall)];

  shade(ctx, floor, palette.raised, -0.1);
  path(ctx, floor);
  ctx.fillStyle = palette.deliver;
  ctx.globalAlpha = 0.06 + 0.1 * fill;
  ctx.fill();
  ctx.globalAlpha = 1;

  for (const face of [back, end]) {
    path(ctx, face);
    ctx.fillStyle = palette.deliver;
    ctx.globalAlpha = 0.07;
    ctx.fill();
    ctx.strokeStyle = palette.deliver;
    ctx.globalAlpha = 0.35;
    ctx.stroke();
  }
  ctx.globalAlpha = 1;

  drawContents();

  path(ctx, front);
  ctx.fillStyle = palette.deliver;
  ctx.globalAlpha = 0.1;
  ctx.fill();
  ctx.strokeStyle = palette.deliver;
  ctx.globalAlpha = 0.6;
  ctx.stroke();

  // glass rim
  ctx.strokeStyle = '#ffffff';
  ctx.globalAlpha = 0.22;
  ctx.beginPath();
  ctx.moveTo(front[3].x, front[3].y);
  ctx.lineTo(front[2].x, front[2].y);
  ctx.stroke();
  ctx.globalAlpha = 1;
};

const drawMessage = (ctx, project, palette, message, ui) => {
  const color = colorOf(message, palette);
  const alpha = message.state === 'toExit' ? Math.max(0, 1 - message.t) : 1;
  const height = heightOf(message);
  const p = project(message.pos.x, message.pos.y, height);
  const k = project.k;

  message.screen = p;
  message.trail.push(p);
  if (message.trail.length > TRAIL) message.trail.shift();

  if (message.state !== 'queued' && message.trail.length > 1) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineCap = 'round';
    for (let i = 1; i < message.trail.length; i += 1) {
      const share = i / message.trail.length;

      ctx.globalAlpha = alpha * share * 0.5;
      ctx.lineWidth = 2.4 * share;
      ctx.beginPath();
      ctx.moveTo(message.trail[i - 1].x, message.trail[i - 1].y);
      ctx.lineTo(message.trail[i].x, message.trail[i].y);
      ctx.stroke();
    }
    ctx.restore();
  }

  sphere(ctx, p.x, p.y, Math.max(2.6, 4 * k), color, alpha);

  if (ui.hoverMessage === message) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.arc(p.x, p.y, Math.max(7, 9 * k), 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
};

const drawShadow = (ctx, project, palette, message) => {
  const height = heightOf(message);

  if (height < 8) return;

  const floor = project(message.pos.x, message.pos.y);
  const fade = Math.max(0, 1 - height / 130);
  const alpha = message.state === 'toExit' ? Math.max(0, 1 - message.t) : 1;
  const k = project.k;

  ctx.globalAlpha = 0.3 * fade * alpha;
  ctx.fillStyle = colorOf(message, palette);
  ctx.beginPath();
  ctx.ellipse(floor.x, floor.y, (5 + height * 0.06) * k * 1.6, (2.5 + height * 0.03) * k * 1.6, 0, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;
};

const drawPod = (ctx, project, palette, sim, geo, index, logo, view, ui) => {
  const replica = sim.replicas[index];
  const r = geo.replicas[index];
  const down = isDown(sim, replica);
  const flashing = !down && sim.time - replica.flashAt < 600;
  const hovered = ui.hoverReplica === index;
  const height = down ? POD.downHeight : POD.height;
  const tone = flashing ? palette[replica.flash] : null;
  const faces = block(ctx, project, {
    cx: r.x,
    cy: r.y,
    size: POD.size,
    height,
    base: down ? palette.raised : (tone ?? palette.block),
    edge: down ? palette.dlq : (tone ?? (hovered ? palette.deliver : palette.line)),
    alpha: down ? 0.7 : 1,
    dashed: down,
    lift: hovered && !down ? 3 : 0,
  });

  let ledColor = palette.ack;

  if (down) ledColor = palette.dlq;
  else if (replica.busy) ledColor = palette.deliver;
  else if (flashing) ledColor = palette[replica.flash];
  led(ctx, faces.front, ledColor, down ? 0.9 : 1);

  if (logo && !down) {
    // the NestJS mark, laid flat on the top face
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
    const above = project(r.x, r.y, height + 16);

    label(ctx, palette, replica.manual ? 'down · click to start' : 'restarting', above.x, above.y, 'center', palette.dlq, 600);
  }

  const busy = replica.busy;

  if (busy && busy.state === 'processing') {
    const c = project(r.x, r.y, POD.height);
    const progress = Math.min(1, (sim.time - busy.since) / (busy.until - busy.since));
    const k = project.k;

    ctx.save();
    ctx.strokeStyle = palette.deliver;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, 27 * k, 15 * k, 0, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }
};

/* Until the visitor has clicked once, ripples around the middle pod say it can be clicked. */
const drawHint = (ctx, project, palette, sim, geo, ui) => {
  if (ui.clicked) return;

  const r = geo.replicas[1];
  const c = project(r.x, r.y, POD.height / 2);
  const k = project.k;

  for (let i = 0; i < 2; i += 1) {
    const phase = ((sim.time / 1800 + i / 2) % 1 + 1) % 1;

    ctx.save();
    ctx.strokeStyle = palette.deliver;
    ctx.globalAlpha = 0.55 * (1 - phase);
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y + 8 * k, (30 + phase * 26) * k, (17 + phase * 15) * k, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

  const tag = project(r.x + 34, r.y + 60);

  label(ctx, palette, '↖ click a pod to take it down', tag.x, tag.y, 'left', palette.deliver, 600);
};

const draw = (ctx, sim, geo, view, palette, logo, ui) => {
  const { project, cw, ch } = view;

  ctx.clearRect(0, 0, cw, ch);
  drawFloor(ctx, project, palette);

  // connectors on the floor
  ctx.strokeStyle = palette.line;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (const p of geo.producers) {
    const a = project(p.x, p.y);
    const b = project(geo.tube.x0 - 10, geo.tube.y);

    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  for (const r of geo.replicas) {
    const a = project(geo.tube.x1 + 10, geo.tube.y);
    const b = project(r.x, r.y);

    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (const message of sim.messages) drawShadow(ctx, project, palette, message);

  for (const p of geo.producers) {
    const faces = block(ctx, project, { cx: p.x, cy: p.y, size: 26, height: 20, base: palette.block, edge: palette.line });

    led(ctx, faces.front, palette.deliver);
  }

  const inChannel = (message) => message.state === 'queued';

  drawChannel(ctx, project, geo, palette, sim, () => {
    for (const message of sim.messages) if (inChannel(message)) drawMessage(ctx, project, palette, message, ui);
  });

  // the retry rail, hanging over the stream on two posts
  const r0 = project(geo.lane.x0, geo.lane.y, LANE_HEIGHT);
  const r1 = project(geo.lane.x1, geo.lane.y, LANE_HEIGHT);

  ctx.save();
  ctx.strokeStyle = palette.redeliver;
  ctx.globalAlpha = 0.25;
  for (const x of [geo.lane.x0, geo.lane.x1]) {
    const a = project(x, geo.lane.y - 18, 0);
    const b = project(x, geo.lane.y - 18, LANE_HEIGHT);

    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.setLineDash([4, 4]);
  ctx.globalAlpha = 0.7;
  ctx.lineWidth = 1.4;
  ctx.beginPath();
  ctx.moveTo(r0.x, r0.y);
  ctx.lineTo(r1.x, r1.y);
  ctx.stroke();
  ctx.restore();

  // pods back to front, then everything in flight on top
  geo.replicas.forEach((_, index) => drawPod(ctx, project, palette, sim, geo, index, logo, view, ui));
  drawHint(ctx, project, palette, sim, geo, ui);

  for (const message of sim.messages) if (!inChannel(message)) drawMessage(ctx, project, palette, message, ui);

  // labels
  const pl = project(geo.producers[0].x, geo.producers[0].y, 20);
  const sl = project((geo.tube.x0 + geo.tube.x1) / 2, geo.tube.y + 16);
  const ll = project((geo.lane.x0 + geo.lane.x1) / 2, geo.lane.y, LANE_HEIGHT);
  const rl = project(geo.replicas.at(-1).x, geo.replicas.at(-1).y + 24);

  label(ctx, palette, 'services', pl.x, pl.y - 14, 'center');
  label(ctx, palette, sim.queue.length ? `stream · ${sim.queue.length} stored` : 'stream', sl.x + 10, sl.y + 18, 'left');
  label(ctx, palette, 'retry · 2 s, 10 s', ll.x, ll.y - 10, 'center', palette.redeliver);
  label(ctx, palette, 'NestJS replicas', rl.x + 4, rl.y + 20, 'center');

  if (sim.deploy) {
    const done = Math.min(sim.replicas.length, Math.floor((sim.time - sim.deploy.start) / RESTART_MS) + 1);
    const top = project(geo.replicas[0].x, geo.replicas[0].y, 70);

    label(ctx, palette, `rolling deploy · ${done}/${sim.replicas.length}`, top.x, top.y, 'center', palette.deliver, 600);
  }

  const hovered = ui.hoverMessage;

  if (hovered?.screen && sim.messages.includes(hovered)) {
    const status = { toExit: 'acked', waiting: 'waiting to retry', toLane: 'nak', queued: 'stored', processing: 'handling' };

    tooltip(
      ctx,
      palette,
      [
        { text: hovered.subject },
        { text: `seq ${hovered.seq} · attempt ${hovered.attempt + 1}`, color: palette.label },
        { text: status[hovered.state] ?? 'in flight', color: colorOf(hovered, palette) },
      ],
      hovered.screen.x,
      hovered.screen.y,
    );
  } else if (ui.hoverReplica !== null) {
    const r = geo.replicas[ui.hoverReplica];
    const at = project(r.x, r.y, POD.height);
    const down = isDown(sim, sim.replicas[ui.hoverReplica]);

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
    const geo = layout();
    const sim = createSim();
    const ui = { hoverMessage: null, hoverReplica: null, clicked: readClicked() };
    let palette = readPalette();
    let view = null;
    let logo = null;
    let frame = 0;
    let last = 0;
    let visible = true;
    let statsAt = 0;
    let pointer = null;

    const resize = () => {
      const ratio = window.devicePixelRatio || 1;
      const cw = wrap.clientWidth;
      const ch = wrap.clientHeight;

      canvas.width = Math.round(cw * ratio);
      canvas.height = Math.round(ch * ratio);
      canvas.style.width = `${cw}px`;
      canvas.style.height = `${ch}px`;
      view = { cw, ch, ratio, project: makeProjector(cw, ch, cw < 760 ? REGION.narrow : REGION.wide) };
    };

    const render = () => {
      ctx.setTransform(view.ratio, 0, 0, view.ratio, 0, 0);
      draw(ctx, sim, geo, view, palette, logo, ui);
    };

    // What the pointer is over: a pod (clickable) or a message (inspectable).
    const hitTest = () => {
      ui.hoverMessage = null;
      ui.hoverReplica = null;

      if (pointer) {
        const k = view.project.k;
        let best = 12;

        for (const message of sim.messages) {
          if (!message.screen) continue;

          const d = Math.hypot(message.screen.x - pointer.x, message.screen.y - pointer.y);

          if (d < best) {
            best = d;
            ui.hoverMessage = message;
          }
        }

        if (!ui.hoverMessage) {
          geo.replicas.forEach((r, index) => {
            const c = view.project(r.x, r.y, POD.height / 2);

            if (Math.hypot((c.x - pointer.x) / 1.6, c.y - pointer.y) < 26 * k + 6) ui.hoverReplica = index;
          });
        }
      }

      canvas.style.cursor = ui.hoverReplica === null ? 'default' : 'pointer';
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
      step(sim, geo, dt);
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
      for (let t = 0; t < 9000; t += 16) step(sim, geo, 16);
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

      if (ui.hoverReplica === null) return;

      togglePod(sim, geo, ui.hoverReplica);

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
