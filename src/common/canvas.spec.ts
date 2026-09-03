import { BadRequestException } from '@nestjs/common';

import { validateCanvas } from './canvas.js';

describe('validateCanvas', () => {
  const nodes = [
    {
      id: 'foundation',
      position: { x: 0, y: 0 },
      data: { title: 'Foundation' },
    },
    { id: 'advanced', position: { x: 100, y: 0 }, data: { title: 'Advanced' } },
  ];

  it('accepts directed acyclic graph data', () => {
    expect(
      validateCanvas(nodes, [
        { id: 'foundation-advanced', source: 'foundation', target: 'advanced' },
      ]),
    ).toEqual({
      nodes,
      edges: [
        { id: 'foundation-advanced', source: 'foundation', target: 'advanced' },
      ],
    });
  });

  it('rejects cycles and dangling edges', () => {
    expect(() =>
      validateCanvas(nodes, [
        { id: 'cycle', source: 'advanced', target: 'foundation' },
        { id: 'forward', source: 'foundation', target: 'advanced' },
      ]),
    ).toThrow(BadRequestException);
    expect(() =>
      validateCanvas(nodes, [
        { id: 'missing', source: 'foundation', target: 'missing' },
      ]),
    ).toThrow(BadRequestException);
  });
});
