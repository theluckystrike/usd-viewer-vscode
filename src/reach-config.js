'use strict';
// REACH1: this listing's Pro tools for the viewer toolbar row and the Explorer entries (src/reach.js).
module.exports = {
  prefix: 'usdViewer',
  triesKey: 'usdViewer.proTrial',
  slot: '#toolbar',
  tools: [
    { id: 'convert', title: 'Convert and export', command: 'usdViewer.convert' },
    { id: 'check', title: 'Stage check', command: 'usdViewer.check' },
    { id: 'compare', title: 'Compare two USD files', command: 'usdViewer.compare' },
  ],
};
