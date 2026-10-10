import { custom, inspectWithoutNode } from './inspect_without_node.js';

class WithCustomRepresentation {
  [custom]() {
    return 'WithCustomRepresentation<42>';
  }
}

describe('inspectWithoutNode', () => {
  it.each([
    ['a string', 'text', `'text'`],
    ['an empty string', '', `''`],
    ['a number', 42, '42'],
    ['a bigint', 42n, '42n'],
    ['a boolean', false, 'false'],
    ['undefined', undefined, 'undefined'],
    ['null', null, 'null'],
  ])('represents %s', (_name, value, expected) => {
    expect(inspectWithoutNode(value)).toBe(expected);
  });

  it('uses the custom method of a class', () => {
    expect(inspectWithoutNode(new WithCustomRepresentation())).toBe('WithCustomRepresentation<42>');
  });

  it('ignores a custom key that is not a method', () => {
    expect(inspectWithoutNode({ [custom]: 'not a method', a: 1 })).toBe('{"a":1}');
  });

  it('represents plain objects and arrays as JSON', () => {
    expect(inspectWithoutNode({ a: 1, b: ['x', { c: true }] })).toBe('{"a":1,"b":["x",{"c":true}]}');
    expect(inspectWithoutNode([])).toBe('[]');
  });

  it('represents bigints nested in an object', () => {
    expect(inspectWithoutNode({ value: 5n })).toBe('{"value":"5n"}');
  });

  it('represents an error by its name and message', () => {
    expect(inspectWithoutNode(new TypeError('boom'))).toBe('TypeError: boom');
  });

  it('includes the cause of an error', () => {
    const error = new Error('outer', { cause: new RangeError('inner', { cause: 'root' }) });
    expect(inspectWithoutNode(error)).toBe(`Error: outer [cause]: RangeError: inner [cause]: 'root'`);
  });

  it('does not throw on a value with circular references', () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;
    expect(inspectWithoutNode(circular)).toBe('[object Object]');
  });

  it('does not throw on an object that JSON omits', () => {
    expect(inspectWithoutNode({ toJSON: () => undefined })).toBe('[object Object]');
  });
});
