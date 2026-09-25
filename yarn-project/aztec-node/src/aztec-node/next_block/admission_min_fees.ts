import type {
  BlockMinFeesProvider,
  GasFees,
  NextBlockMinFeesProvider,
  TxAdmissionMinFeesProvider,
} from '@aztec-labs/stdlib/gas';

/**
 * The {@link TxAdmissionMinFeesProvider} handed to the p2p layer. Admission is priced against the next-block fee and
 * falls back to the L1-forward fee while the next block cannot be priced, such as at a checkpoint boundary before
 * the fee cache has refreshed or while L1 cannot be read. The fallback is only a floor: it can sit below the fee the
 * next block ends up charging, which the pool's insufficient-fee sweep catches once the exact fee resolves.
 */
export class AdmissionMinFeesProvider implements TxAdmissionMinFeesProvider {
  constructor(
    private readonly nextBlock: NextBlockMinFeesProvider,
    private readonly l1Forward: BlockMinFeesProvider,
  ) {}

  public getNextBlockMinFees(): Promise<GasFees | undefined> {
    return this.nextBlock.getNextBlockMinFees();
  }

  public async getAdmissionMinFees(): Promise<GasFees> {
    return (await this.nextBlock.getNextBlockMinFees()) ?? (await this.l1Forward.getCurrentMinFees());
  }
}
