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
