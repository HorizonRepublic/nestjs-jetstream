import React from 'react';
import styles from './styles.module.css';

interface SinceProps {
  version: string;
}

export default function Since({ version }: SinceProps): React.ReactElement {
  return (
    <span className={styles.badge}>
      <span className={styles.mark} aria-hidden="true" />
      Since v{version}
    </span>
  );
}
