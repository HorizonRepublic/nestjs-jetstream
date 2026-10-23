import React from 'react';
import LastUpdated from '@theme-original/LastUpdated';

/* Git records authors by name; the docs show their GitHub handle instead.
   Anyone not listed keeps the name from git. */
const GITHUB_HANDLES = {
  'Kyrylo Lytvynov': 'themaiby',
};

export default function LastUpdatedWrapper({ lastUpdatedBy, ...props }) {
  const handle = lastUpdatedBy && GITHUB_HANDLES[lastUpdatedBy];
  const author = handle ? (
    <a href={`https://github.com/${handle}`} target="_blank" rel="noopener noreferrer">
      @{handle}
    </a>
  ) : (
    lastUpdatedBy
  );

  return <LastUpdated {...props} lastUpdatedBy={author} />;
}
