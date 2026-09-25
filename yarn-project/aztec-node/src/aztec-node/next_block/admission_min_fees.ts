import type { BlockMinFeesProvider, GasFees, NextBlockMinFeesProvider } from '@aztec-labs/stdlib/gas';

/**
 * The {@link NextBlockMinFeesProvider} handed to the p2p layer. Admission is priced against the next-block fee and
 * falls back to the L1-forward fee while the next block cannot be priced, such as at a checkpoint boundary before
 * the fee cache has refreshed or while L1 cannot be read. The L1-forward fee can undershoot a fee an in-progress
 * checkpoint froze, but only mid-checkpoint, where the next-block fee is read from the proposed tip's header and
 * always resolves.
 */
export class AdmissionMinFeesProvider implements NextBlockMinFeesProvider {
  constructor(
    private readonly nextBlock: Pick<NextBlockMinFeesProvider, 'getNextBlockMinFees'>,
    private readonly l1Forward: BlockMinFeesProvider,
  ) {}

  public getNextBlockMinFees(): Promise<GasFees | undefined> {
    return this.nextBlock.getNextBlockMinFees();
  }

  public async getAdmissionMinFees(): Promise<GasFees> {
    return (await this.nextBlock.getNextBlockMinFees()) ?? (await this.l1Forward.getCurrentMinFees());
  }
}
