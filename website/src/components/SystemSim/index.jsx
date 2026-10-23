import React, { useEffect, useRef, useState } from 'react';
import useBaseUrl from '@docusaurus/useBaseUrl';
import './styles.css';

/* A small JetStream system on a loop, drawn on an isometric floor behind the
   hero: services emit, the stream queues, NestJS replicas handle. Some handlers
   throw and some pods restart; every message gets acked in the end.

   The model runs in a flat plane (x along the flow, y across it); the renderer
   lifts it into isometric space and adds height for retries and acks. */

const FAIL_CHANCE = [0.3, 0.2, 0];
const RETRY_WAIT_MS = 2000;
const SLOT = 9;
const MODEL = { w: 600, h: 240 };
const LANE_HEIGHT = 34;
const TRAIL = 9;
const RESTART_MS = 2600;
const DEPLOY_EVERY_MS = 25000;
const SUBJECTS = ['orders.created', 'payments.captured', 'users.updated', 'emails.send', 'stock.reserved'];

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

  return {
    deliver: token('--jt-state-deliver'),
    redeliver: token('--jt-state-redeliver'),
    ack: token('--jt-state-ack'),
    line: token('--jt-line-2'),
    faint: token('--jt-line-1'),
    raised: token('--jt-bg-2'),
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
    replicas: [0.22, 0.5, 0.78].map((f) => ({ x: w * 0.9, y: h * f })),
  };
};

const createSim = () => ({
  time: 0,
  nextId: 1,
  messages: [],
  queue: [],
  replicas: [0, 1, 2].map(() => ({ busy: null, flash: null, flashAt: -1e9, downUntil: 0 })),
  nextSpawn: 300,
  nextBurst: 4000,
  nextRestart: 16000,
  nextDeploy: 6000,
  deploy: null,
  stats: { published: 0, retried: 0, acked: 0 },
});

const toLane = (geo, message) => {
  flight(message, { ...message.pos }, { x: geo.lane.x1, y: geo.lane.y }, 900, 'toLane');
};

/* A pod goes away: whatever it was handling is redelivered later, never lost. */
const restartReplica = (sim, geo, index) => {
  const replica = sim.replicas[index];

  if (sim.time < replica.downUntil) return;

  replica.downUntil = sim.time + RESTART_MS;

  if (replica.busy) {
    const message = replica.busy;

    replica.busy = null;
    sim.stats.retried += 1;
    toLane(geo, message);
  }
};

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

  // A rolling deploy: every replica restarts in turn while the stream holds the work.
  if (now >= sim.nextDeploy) {
    sim.deploy = { start: now };
    sim.nextDeploy = now + DEPLOY_EVERY_MS;
    sim.nextRestart = Math.max(sim.nextRestart, now + sim.replicas.length * RESTART_MS + 6000);
  }

  if (sim.deploy) {
    const done = Math.floor((now - sim.deploy.start) / RESTART_MS);

    if (done < sim.replicas.length) restartReplica(sim, geo, done);
    else if (now - sim.deploy.start > sim.replicas.length * RESTART_MS + 600) sim.deploy = null;
  }

  if (now >= sim.nextRestart) {
    restartReplica(sim, geo, Math.floor(Math.random() * sim.replicas.length));
    sim.nextRestart = now + 11000 + Math.random() * 7000;
  }

  sim.replicas.forEach((replica, index) => {
    if (replica.busy || now < replica.downUntil || !sim.queue.length) return;

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
      return message.fromLane ? LANE_HEIGHT * (1 - easeInOut(message.t)) : 6 * Math.sin(message.t * Math.PI);
    case 'toExit':
      return 18 + 70 * easeInOut(message.t);
    case 'processing':
      return 18;
    case 'toReplica':
      return 18 * easeInOut(message.t);
    default:
      return 0;
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
    raw(MODEL.w, MODEL.h / 2, 120),
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

/* An isometric box: top face plus the two faces turned to the viewer. */
const box = (ctx, project, cx, cy, size, height, fill, stroke, alpha = 1) => {
  const s = size / 2;
  const at = (dx, dy, dz) => project(cx + dx, cy + dy, dz);
  const top = [at(-s, -s, height), at(s, -s, height), at(s, s, height), at(-s, s, height)];
  const right = [at(s, -s, height), at(s, s, height), at(s, s, 0), at(s, -s, 0)];
  const front = [at(-s, s, height), at(s, s, height), at(s, s, 0), at(-s, s, 0)];

  ctx.save();
  ctx.lineWidth = 1;
  ctx.strokeStyle = stroke;

  for (const [face, shade] of [
    [right, 0.55],
    [front, 0.75],
    [top, 1],
  ]) {
    path(ctx, face);
    ctx.fillStyle = fill;
    ctx.globalAlpha = alpha * shade;
    ctx.fill();
    ctx.globalAlpha = alpha;
    ctx.stroke();
  }

  ctx.restore();

  return top;
};

const glowDot = (ctx, x, y, r, color, alpha) => {
  ctx.fillStyle = color;
  ctx.globalAlpha = alpha * 0.16;
  ctx.beginPath();
  ctx.arc(x, y, r * 2.6, 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = alpha;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
};

const label = (ctx, palette, value, x, y, align, color = palette.label) => {
  ctx.font = `11px ${palette.mono}`;
  ctx.fillStyle = color;
  ctx.globalAlpha = 0.85;
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
  ctx.globalAlpha = 0.96;
  ctx.fillStyle = palette.surface;
  ctx.strokeStyle = palette.line;
  ctx.beginPath();
  ctx.roundRect(left, top, width, height, 6);
  ctx.fill();
  ctx.stroke();
  ctx.textAlign = 'left';
  lines.forEach((line, index) => {
    ctx.fillStyle = line.color ?? palette.ink;
    ctx.fillText(line.text, left + 9, top + 18 + index * 16);
  });
  ctx.restore();
};

const drawFloor = (ctx, project, palette) => {
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

const draw = (ctx, sim, geo, view, palette, logo, ui) => {
  const { project, cw, ch } = view;
  const k = project.k;

  ctx.clearRect(0, 0, cw, ch);
  drawFloor(ctx, project, palette);

  // a pool of light under the stream, brighter as the queue grows
  const pool = project((geo.tube.x0 + geo.tube.x1) / 2, geo.tube.y);
  const fill = Math.min(1, sim.queue.length / 8);
  const glow = ctx.createRadialGradient(pool.x, pool.y, 0, pool.x, pool.y, 150 * k);

  glow.addColorStop(0, palette.deliver);
  glow.addColorStop(1, 'transparent');
  ctx.save();
  ctx.globalAlpha = 0.06 + 0.16 * fill;
  ctx.fillStyle = glow;
  ctx.setTransform(view.ratio, 0, 0, view.ratio * 0.5, 0, pool.y * view.ratio * 0.5);
  ctx.beginPath();
  ctx.arc(pool.x, pool.y, 150 * k, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  // shadows of everything in the air, softer the higher it flies
  for (const message of sim.messages) {
    const height = heightOf(message);

    if (height < 3) continue;

    const floor = project(message.pos.x, message.pos.y);
    const fade = Math.max(0, 1 - height / 110);
    const alpha = message.state === 'toExit' ? Math.max(0, 1 - message.t) : 1;

    ctx.globalAlpha = 0.28 * fade * alpha;
    ctx.fillStyle = colorOf(message, palette);
    ctx.beginPath();
    ctx.ellipse(floor.x, floor.y, (4 + height * 0.06) * k * 1.6, (2 + height * 0.03) * k * 1.6, 0, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;

  // connectors on the floor
  ctx.strokeStyle = palette.line;
  ctx.globalAlpha = 0.5;
  ctx.beginPath();
  for (const p of geo.producers) {
    const a = project(p.x, p.y);
    const b = project(geo.tube.x0, geo.tube.y);

    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  for (const r of geo.replicas) {
    const a = project(geo.tube.x1, geo.tube.y);
    const b = project(r.x, r.y);

    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
  }
  ctx.stroke();
  ctx.globalAlpha = 1;

  for (const p of geo.producers) box(ctx, project, p.x, p.y, 22, 12, palette.raised, palette.line);

  // the stream: a long low channel on the floor
  const len = geo.tube.x1 - geo.tube.x0 + 16;
  const at = (dx, dy) => project(geo.tube.x0 - 8 + dx, geo.tube.y + dy);

  path(ctx, [at(0, -10), at(len, -10), at(len, 10), at(0, 10)]);
  ctx.fillStyle = palette.deliver;
  ctx.globalAlpha = 0.08;
  ctx.fill();
  ctx.globalAlpha = 0.7;
  ctx.strokeStyle = palette.deliver;
  ctx.stroke();
  ctx.globalAlpha = 1;

  // the retry rail, hanging over the stream
  const r0 = project(geo.lane.x0, geo.lane.y, LANE_HEIGHT);
  const r1 = project(geo.lane.x1, geo.lane.y, LANE_HEIGHT);

  ctx.save();
  ctx.setLineDash([3, 4]);
  ctx.strokeStyle = palette.redeliver;
  ctx.globalAlpha = 0.6;
  ctx.beginPath();
  ctx.moveTo(r0.x, r0.y);
  ctx.lineTo(r1.x, r1.y);
  ctx.stroke();
  ctx.restore();

  sim.replicas.forEach((replica, index) => {
    const r = geo.replicas[index];
    const down = sim.time < replica.downUntil;
    const flashing = sim.time - replica.flashAt < 600;
    const tone = flashing ? palette[replica.flash] : null;
    const top = box(ctx, project, r.x, r.y, 30, down ? 8 : 18, tone ?? palette.raised, tone ?? palette.line, down ? 0.45 : 1);

    if (logo && !down) {
      // the NestJS mark, laid flat on the top face
      const [p0, p1, , p3] = top;
      const size = 0.5;

      ctx.save();
      ctx.globalAlpha = 0.9;
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

    if (ui.hoverReplica === index) {
      const c = project(r.x, r.y, down ? 8 : 18);

      ctx.save();
      ctx.setLineDash([2, 3]);
      ctx.strokeStyle = palette.ink;
      ctx.globalAlpha = 0.5;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 30 * k, 17 * k, 0, 0, Math.PI * 2);
      ctx.stroke();
      ctx.restore();
    }

    const busy = replica.busy;

    if (busy && busy.state === 'processing') {
      const c = project(r.x, r.y, 18);
      const progress = Math.min(1, (sim.time - busy.since) / (busy.until - busy.since));

      ctx.strokeStyle = palette.deliver;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.ellipse(c.x, c.y, 24 * k, 13 * k, 0, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2);
      ctx.stroke();
      ctx.lineWidth = 1;
    }
  });

  // messages, each with a short trail of light
  for (const message of sim.messages) {
    const color = colorOf(message, palette);
    const alpha = message.state === 'toExit' ? Math.max(0, 1 - message.t) : 1;
    const p = project(message.pos.x, message.pos.y, heightOf(message));

    message.screen = p;
    message.trail.push(p);
    if (message.trail.length > TRAIL) message.trail.shift();

    if (message.state !== 'queued' && message.trail.length > 1) {
      ctx.strokeStyle = color;
      ctx.lineCap = 'round';
      for (let i = 1; i < message.trail.length; i += 1) {
        const share = i / message.trail.length;

        ctx.globalAlpha = alpha * share * 0.5;
        ctx.lineWidth = 2.2 * share;
        ctx.beginPath();
        ctx.moveTo(message.trail[i - 1].x, message.trail[i - 1].y);
        ctx.lineTo(message.trail[i].x, message.trail[i].y);
        ctx.stroke();
      }
      ctx.lineWidth = 1;
    }

    glowDot(ctx, p.x, p.y, Math.max(2.4, 3.6 * k), color, alpha);

    if (ui.hoverMessage === message) {
      ctx.globalAlpha = 1;
      ctx.strokeStyle = color;
      ctx.beginPath();
      ctx.arc(p.x, p.y, Math.max(6, 8 * k), 0, Math.PI * 2);
      ctx.stroke();
    }
  }
  ctx.globalAlpha = 1;

  const pl = project(geo.producers[0].x, geo.producers[0].y, 12);
  const sl = project((geo.tube.x0 + geo.tube.x1) / 2, geo.tube.y + 14);
  const ll = project((geo.lane.x0 + geo.lane.x1) / 2, geo.lane.y, LANE_HEIGHT);
  const rl = project(geo.replicas.at(-1).x, geo.replicas.at(-1).y + 20);

  label(ctx, palette, 'services', pl.x, pl.y - 14, 'center');
  label(ctx, palette, 'stream', sl.x + 10, sl.y + 16, 'left');
  label(ctx, palette, 'retry · 2 s, 10 s', ll.x, ll.y - 10, 'center', palette.redeliver);
  label(ctx, palette, 'NestJS replicas', rl.x + 4, rl.y + 18, 'center');

  if (sim.deploy) {
    const done = Math.min(sim.replicas.length, Math.floor((sim.time - sim.deploy.start) / RESTART_MS) + 1);
    const top = project(geo.replicas[0].x, geo.replicas[0].y, 40);

    label(ctx, palette, `rolling deploy · ${done}/${sim.replicas.length}`, top.x, top.y - 8, 'center', palette.deliver);
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
    const at = project(r.x, r.y, 18);

    tooltip(ctx, palette, [{ text: 'click to restart this pod' }], at.x, at.y);
  }
};

const REGION = {
  wide: { x0: 0.5, x1: 0.98, y0: 0.06, y1: 0.9 },
  narrow: { x0: 0.02, x1: 0.98, y0: 0.04, y1: 0.96 },
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
    let palette = readPalette();
    let view = null;
    let logo = null;
    let frame = 0;
    let last = 0;
    let visible = true;
    let statsAt = 0;
    let pointer = null;
    const ui = { hoverMessage: null, hoverReplica: null };

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

    // What the pointer is over: a replica (clickable) or a message (inspectable).
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
            const c = view.project(r.x, r.y, 9);

            if (Math.hypot((c.x - pointer.x) / 1.7, c.y - pointer.y) < 22 * k + 4) ui.hoverReplica = index;
          });
        }
      }

      canvas.style.cursor = ui.hoverReplica === null ? 'default' : 'pointer';
    };

    const onMove = (event) => {
      const rect = canvas.getBoundingClientRect();

      pointer = { x: event.clientX - rect.left, y: event.clientY - rect.top };
    };
    const onLeave = () => {
      pointer = null;
    };
    const onClick = () => {
      if (ui.hoverReplica !== null) restartReplica(sim, geo, ui.hoverReplica);
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
      render();
      setStats({ ...sim.stats });

      return undefined;
    }

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
        <span className="scene-hint">click a replica to restart it</span>
      </p>
    </div>
  );
};

export default HeroScene;
