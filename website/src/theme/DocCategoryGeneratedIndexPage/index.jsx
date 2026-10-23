import React from 'react';
import Page from '@theme-original/DocCategoryGeneratedIndexPage';
import { toneOf } from '@site/src/theme/sectionTones';

export default function PageWrapper(props) {
  return (
    <div className="jt-doc" data-tone={toneOf(props.categoryGeneratedIndex.title)}>
      <Page {...props} />
    </div>
  );
}
