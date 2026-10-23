/* The model behind the hero scene: a JetStream work queue in miniature.

   Services publish; messages wait in the stream, oldest first; a free pod takes
   the oldest. An ack removes the message. A nak, or the pod going down, sends it
   along the retry arc, the backoff, and back into the stream. Nothing is lost.

   Times are in milliseconds; the scene turns each state and its progress into a
   position on the matching path. */

export const SERVICES = 3;
export const PODS = 3;
export const CAPACITY = 12;
export const IN_MS = 1100;
export const OUT_MS = 520;
export const RETRY_MS = 2400;
export const ACK_MS = 900;
export const RESTART_MS = 3400;
export const MANUAL_DOWN_MS = 20000;

const FAIL_CHANCE = [0.3, 0.2, 0];
const DEPLOY_EVERY_MS = 25000;
const SUBJECTS = ['orders.created', 'payments.captured', 'users.updated', 'emails.send', 'stock.reserved'];

export const createSim = () => ({
  time: 0,
  nextId: 1,
  messages: [],
  queue: [],
  waiting: [],
  pods: Array.from({ length: PODS }, () => ({ message: null, downUntil: 0, manual: false, flash: null, flashAt: -1e9 })),
  nextSpawn: 100,
  nextBurst: 2600,
  burstLeft: 0,
  burstAt: 0,
  nextRestart: 15000,
  nextDeploy: 9000,
  deploy: null,
  stats: { published: 0, retried: 0, acked: 0 },
});

export const isDown = (sim, pod) => sim.time < pod.downUntil;

const begin = (sim, message, state, duration) => {
  message.state = state;
  message.since = sim.time;
  message.until = sim.time + duration;
};

const retry = (sim, message, pod) => {
  message.attempt += 1;
  message.from = pod;
  sim.stats.retried += 1;
  begin(sim, message, 'retry', RETRY_MS);
};

export const takeDown = (sim, index, ms, manual) => {
  const pod = sim.pods[index];

  pod.downUntil = sim.time + ms;
  pod.downAt = sim.time;
  pod.manual = manual;

  if (pod.message && pod.message.state === 'work') {
    retry(sim, pod.message, index);
    pod.message = null;
  }
};

/* A visitor's click: a running pod goes down until clicked again; a down pod comes back. */
export const togglePod = (sim, index) => {
  const pod = sim.pods[index];

  if (isDown(sim, pod)) {
    pod.downUntil = sim.time;
    pod.manual = false;
  } else {
    takeDown(sim, index, MANUAL_DOWN_MS, true);
  }
};

const publish = (sim) => {
  const id = sim.nextId++;
  const message = {
    id,
    seq: 4812000 + id,
    subject: SUBJECTS[Math.floor(Math.random() * SUBJECTS.length)],
    service: Math.floor(Math.random() * SERVICES),
    attempt: 0,
  };

  begin(sim, message, 'in', IN_MS);
  sim.messages.push(message);
  sim.stats.published += 1;
};

export const step = (sim, dt) => {
  sim.time += dt;
  const now = sim.time;

  if (now >= sim.nextSpawn) {
    publish(sim);
    sim.nextSpawn = now + 850 + Math.random() * 600;
  }

  if (now >= sim.nextBurst) {
    sim.burstLeft = 5;
    sim.nextBurst = now + 11000 + Math.random() * 4000;
  }

  if (sim.burstLeft && now >= sim.burstAt) {
    publish(sim);
    sim.burstLeft -= 1;
    sim.burstAt = now + 150;
  }

  // a rolling deploy: each running pod restarts in turn while the stream holds the work
  if (now >= sim.nextDeploy) {
    sim.deploy = { start: now, done: -1 };
    sim.nextDeploy = now + DEPLOY_EVERY_MS;
    sim.nextRestart = Math.max(sim.nextRestart, now + PODS * RESTART_MS + 6000);
  }

  if (sim.deploy) {
    const index = Math.floor((now - sim.deploy.start) / RESTART_MS);

    if (index < PODS && index > sim.deploy.done) {
      sim.deploy.done = index;
      if (!isDown(sim, sim.pods[index])) takeDown(sim, index, RESTART_MS, false);
    } else if (now - sim.deploy.start > PODS * RESTART_MS + 600) {
      sim.deploy = null;
    }
  }

  if (now >= sim.nextRestart) {
    const up = sim.pods.map((_, index) => index).filter((index) => !isDown(sim, sim.pods[index]));

    if (up.length > 1) takeDown(sim, up[Math.floor(Math.random() * up.length)], RESTART_MS, false);
    sim.nextRestart = now + 11000 + Math.random() * 7000;
  }

  // arrivals at the stream's entrance wait their turn when it is full
  for (const message of sim.messages) {
    if ((message.state === 'in' || message.state === 'retry') && now >= message.until && !sim.waiting.includes(message)) {
      sim.waiting.push(message);
    }
  }

  while (sim.waiting.length && sim.queue.length < CAPACITY) {
    const message = sim.waiting.shift();

    message.state = 'queued';
    message.queuedAt = now;
    sim.queue.push(message);
  }

  sim.pods.forEach((pod, index) => {
    if (!isDown(sim, pod)) pod.manual = false;

    const message = pod.message;

    if (message?.state === 'out' && now >= message.until) {
      if (isDown(sim, pod)) {
        pod.message = null;
        retry(sim, message, index);
      } else {
        begin(sim, message, 'work', 600 + Math.random() * 450);
      }
    } else if (message?.state === 'work' && now >= message.until) {
      pod.message = null;
      pod.flashAt = now;

      if (Math.random() < FAIL_CHANCE[Math.min(message.attempt, FAIL_CHANCE.length - 1)]) {
        pod.flash = 'nak';
        retry(sim, message, index);
      } else {
        pod.flash = 'ack';
        sim.stats.acked += 1;
        begin(sim, message, 'ack', ACK_MS);
      }
    }

    // the oldest message goes to the first free pod
    if (!pod.message && !isDown(sim, pod) && sim.queue.length) {
      const next = sim.queue.shift();

      next.pod = index;
      begin(sim, next, 'out', OUT_MS);
      pod.message = next;
    }
  });

  sim.messages = sim.messages.filter((message) => !(message.state === 'ack' && now >= message.until));
};
