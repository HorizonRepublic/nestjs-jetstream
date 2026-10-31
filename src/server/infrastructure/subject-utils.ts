/** True when `broad` matches everything `narrow` matches. Identical entries return false. */
export const subjectCovers = (broad: string, narrow: string): boolean => {
  if (broad === narrow) return false;

  const broadTokens = broad.split('.');
  const narrowTokens = narrow.split('.');

  for (let i = 0; i < broadTokens.length; i += 1) {
    if (broadTokens[i] === '>') return i < narrowTokens.length;
    if (i >= narrowTokens.length || narrowTokens[i] === '>') return false;
    if (broadTokens[i] !== '*' && broadTokens[i] !== narrowTokens[i]) return false;
  }

  return broadTokens.length === narrowTokens.length;
};

/** True when `broad` equals `subject` or wildcard-covers it. */
export const coversOrEquals = (broad: string, subject: string): boolean =>
  broad === subject || subjectCovers(broad, subject);

/** Whether two valid NATS subscription patterns share at least one subject. */
export const subjectsOverlap = (left: string, right: string): boolean => {
  const a = left.split('.');
  const b = right.split('.');

  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    if (a[i] === '>' || b[i] === '>') return true;
    if (a[i] !== '*' && b[i] !== '*' && a[i] !== b[i]) return false;
  }

  return a.length === b.length;
};

/** Remove duplicate filters and filters already covered by a broader subscription. */
export const minimalSubjectFilters = (subjects: string[]): string[] =>
  [...new Set(subjects)].filter(
    (subject) => !subjects.some((other) => subjectCovers(other, subject)),
  );
