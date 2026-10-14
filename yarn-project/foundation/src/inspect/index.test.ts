import { inspect as nodeInspect } from 'node:util';

import { inspect } from './index.js';

class WithCustomRepresentation {
  constructor(private readonly nested: unknown) {}

  [inspect.custom]() {
    return `WithCustomRepresentation<${inspect(this.nested)}>`;
  }
}

describe('inspect', () => {
  it('uses the key Node.js looks up', () => {
    expect(inspect.custom).toBe(nodeInspect.custom);
  });

  it('is used by Node.js to represent a class that defines the custom method', () => {
    const value = new WithCustomRepresentation({ field: new WithCustomRepresentation(5n) });
    expect(nodeInspect(value)).toBe('WithCustomRepresentation<{ field: WithCustomRepresentation<5n> }>');
    expect(inspect(value)).toBe(nodeInspect(value));
  });
});
