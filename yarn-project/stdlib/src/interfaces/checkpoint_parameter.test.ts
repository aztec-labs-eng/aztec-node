import { CheckpointNumber, SlotNumber } from '@aztec-labs/foundation/branded-types';

import { type CheckpointParameter, CheckpointParameterSchema } from './checkpoint_parameter.js';

describe('CheckpointParameterSchema', () => {
  it.each<[string, CheckpointParameter]>([
    ['a number', CheckpointNumber(7)],
    ['{ number }', { number: CheckpointNumber(7) }],
    ['{ slot }', { slot: SlotNumber(7) }],
    ['a tag', 'proven'],
  ])('roundtrips %s', (_, param) => {
    expect(CheckpointParameterSchema.parse(JSON.parse(JSON.stringify(param)))).toEqual(param);
  });

  it('drops a key it does not know', () => {
    expect(CheckpointParameterSchema.parse({ number: 7, futureOption: true })).toEqual({
      number: CheckpointNumber(7),
    });
  });

  it('rejects an object naming a checkpoint two ways, or none at all', () => {
    expect(CheckpointParameterSchema.safeParse({ number: 7, slot: 7 }).success).toBe(false);
    expect(CheckpointParameterSchema.safeParse({}).success).toBe(false);
    expect(CheckpointParameterSchema.safeParse({ futureOption: true }).success).toBe(false);
  });

  it('drops fields that are not part of this parameter', () => {
    expect(CheckpointParameterSchema.parse({ number: 7, tag: 'proven' })).toEqual({ number: CheckpointNumber(7) });
  });

  it('rejects an invalid value for a key it knows', () => {
    expect(CheckpointParameterSchema.safeParse({ number: -1, futureOption: true }).success).toBe(false);
    expect(CheckpointParameterSchema.safeParse('not-a-tag').success).toBe(false);
  });
});
