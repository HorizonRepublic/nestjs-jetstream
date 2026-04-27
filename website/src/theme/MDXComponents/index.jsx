import React from 'react';
import MDXComponents from '@theme-original/MDXComponents';

function ScrollableTable(props) {
  return (
    <div className="markdown-table-wrapper">
      <table {...props} />
    </div>
  );
}

export default {
  ...MDXComponents,
  table: ScrollableTable,
};
