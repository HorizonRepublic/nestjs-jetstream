/* Each sidebar section has a tone; pages carry it so the stylesheet can colour
   the active sidebar link, the lede, heading marks and index cards to match. */
export const SECTION_TONES = {
  Start: 'deliver',
  'Delivery patterns': 'deliver',
  'Messages and handlers': 'violet',
  Scheduling: 'amber',
  Reliability: 'green',
  Infrastructure: 'teal',
  Observability: 'rose',
  Troubleshooting: 'red',
};

export const toneOf = (section) => SECTION_TONES[section] ?? 'neutral';
