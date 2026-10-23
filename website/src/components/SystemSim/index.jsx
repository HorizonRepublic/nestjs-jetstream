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
  nextRestart: 9000,
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

const step = (sim, geo, dt) => {
  sim.time += dt;
  const now = sim.time;

  const spawn = (delay = 0) => {
    const producer = Math.floor(Math.random() * geo.producers.length);
    const message = { id: sim.nextId++, attempt: 0, pos: { ...geo.producers[producer] }, trail: [] };

    flight(message, geo.producers[producer], { x: geo.tube.x0, y: geo.tube.y }, 1100, 'toStream', delay);
    sim.messages.push(message);
    sim.stats.published += 1;
  };

  const toLane = (message) => {
    flight(message, { ...message.pos }, { x: geo.lane.x1, y: geo.lane.y }, 900, 'toLane');
  };

  if (now >= sim.nextSpawn) {
    spawn();
    sim.nextSpawn = now + 900 + Math.random() * 900;
  }

  if (now >= sim.nextBurst) {
    for (let i = 0; i < 6; i += 1) spawn(i * 140);
    sim.nextBurst = now + 9000 + Math.random() * 6000;
  }

  if (now >= sim.nextRestart) {
    const replica = sim.replicas[Math.floor(Math.random() * sim.replicas.length)];

    replica.downUntil = now + 2600;

    if (replica.busy) {
      const message = replica.busy;

      replica.busy = null;
      sim.stats.retried += 1;
      toLane(message);
    }

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
        toLane(message);
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

const draw = (ctx, sim, geo, view, palette, logo) => {
  const { project, cw, ch } = view;
  const k = project.k;

  ctx.clearRect(0, 0, cw, ch);
  drawFloor(ctx, project, palette);

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
    let color = palette.deliver;

    if (message.state === 'toExit') color = palette.ack;
    else if (message.attempt > 0 || message.fromLane || message.state === 'toLane' || message.state === 'waiting') {
      color = palette.redeliver;
    }

    const alpha = message.state === 'toExit' ? Math.max(0, 1 - message.t) : 1;
    const p = project(message.pos.x, message.pos.y, heightOf(message));

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
      draw(ctx, sim, geo, view, palette, logo);
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
    start();

    return () => {
      cancelAnimationFrame(frame);
      sizeObserver.disconnect();
      viewObserver.disconnect();
      themeObserver.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [logoUrl]);

  return (
    <div className="scene" aria-hidden="true">
      <div className="scene-stage" ref={wrapRef}>
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
